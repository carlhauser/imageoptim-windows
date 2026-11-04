'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const { scratch, cleanupScratch } = require('./helpers');
const updates = require('../lib/updater');
const { Queue } = require('../lib/queue');
const { Settings } = require('../lib/settings');
const pkg = require('../package.json');

const { UpdateController, installKind, releasePageUrl, describeError, bannerFor, makeFileLogger } = updates;

test.after(cleanupScratch);

// Stands in for electron-updater's autoUpdater: records what the controller
// asks of it, and lets a test play the events the real one would emit.
class FakeUpdater extends EventEmitter {
    constructor({ checkResult = { isUpdateAvailable: false }, checkError = null } = {}) {
        super();
        this.calls = { check: 0, download: 0, install: [] };
        this.checkResult = checkResult;
        this.checkError = checkError;
    }

    checkForUpdates() {
        this.calls.check += 1;
        return this.checkError ? Promise.reject(this.checkError) : Promise.resolve(this.checkResult);
    }

    downloadUpdate() {
        this.calls.download += 1;
        return Promise.resolve([]);
    }

    quitAndInstall(isSilent, isForceRunAfter) {
        this.calls.install.push({ isSilent, isForceRunAfter });
    }
}

function controller({ kind = 'installed', busy = () => false, updater = new FakeUpdater() } = {}) {
    const c = new UpdateController({ updater, kind, isBusy: busy, currentVersion: '1.4.0' });
    const results = [];
    const urls = [];
    c.on('manual-result', (r) => results.push(r));
    c.on('open-url', (u) => urls.push(u));
    return { c, updater, results, urls };
}

// Plays a whole successful check-and-download through the fake.
function downloaded(updater, version = '1.5.0') {
    updater.emit('checking-for-update');
    updater.emit('update-available', { version });
    updater.emit('download-progress', { percent: 50 });
    updater.emit('update-downloaded', { version });
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

// ----------------------------------------------------------- install detection

function fakeInstall(name, { uninstaller }) {
    const dir = path.join(scratch(), name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ImageOptim.exe'), '');
    if (uninstaller) fs.writeFileSync(path.join(dir, updates.UNINSTALLER), '');
    return path.join(dir, 'ImageOptim.exe');
}

test('installKind — a checkout is dev, whatever is beside the exe', () => {
    const execPath = fakeInstall('dev', { uninstaller: true });
    assert.strictEqual(installKind({ isPackaged: false, execPath, env: {} }), 'dev');
});

test('installKind — the NSIS install has its uninstaller beside the exe', () => {
    const execPath = fakeInstall('nsis', { uninstaller: true });
    assert.strictEqual(installKind({ isPackaged: true, execPath, env: {} }), 'installed');
});

test('installKind — the unzipped zip has no uninstaller, so it is portable', () => {
    const execPath = fakeInstall('zip', { uninstaller: false });
    assert.strictEqual(installKind({ isPackaged: true, execPath, env: {} }), 'portable');
});

test('installKind — electron-builder\'s portable target is portable even beside an uninstaller', () => {
    const execPath = fakeInstall('portable-target', { uninstaller: true });
    const env = { PORTABLE_EXECUTABLE_DIR: path.dirname(execPath) };
    assert.strictEqual(installKind({ isPackaged: true, execPath, env }), 'portable');
});

test('the uninstaller name matches what electron-builder\'s NSIS template writes', () => {
    // templates/nsis/common.nsh: !define UNINSTALL_FILENAME "Uninstall ${PRODUCT_FILENAME}.exe"
    assert.strictEqual(updates.UNINSTALLER, `Uninstall ${pkg.build.productName}.exe`);
});

// ---------------------------------------------------------------- release URLs

test('releasePageUrl — a version links to its tag', () => {
    assert.strictEqual(releasePageUrl('1.5.0'), `${updates.RELEASES_URL}/tag/v1.5.0`);
    assert.strictEqual(releasePageUrl('2.0.0-beta.1'), `${updates.RELEASES_URL}/tag/v2.0.0-beta.1`);
});

test('releasePageUrl — anything that is not a version falls back to /latest', () => {
    // The version is read from latest.yml on GitHub and ends up in shell.openExternal.
    for (const bad of [null, undefined, '', '1.5', '../../../evil', '1.5.0/../../x', 'javascript:alert(1)', '1.5.0 ']) {
        assert.strictEqual(releasePageUrl(bad), `${updates.RELEASES_URL}/latest`, String(bad));
    }
});

// -------------------------------------------------------------- configuration

test('package.json — publishes to the repository the app checks', () => {
    const [publish] = pkg.build.publish;
    assert.strictEqual(publish.provider, 'github');
    assert.strictEqual(publish.owner, updates.OWNER);
    assert.strictEqual(publish.repo, updates.REPO);
    // A draft release is invisible to electron-updater
    assert.strictEqual(publish.releaseType, 'release');
});

test('package.json — the installer name has no spaces', () => {
    // GitHub turns spaces in asset names into dots, while latest.yml names a
    // dashed copy; an uploaded "ImageOptim Setup 1.5.0.exe" would then 404.
    const name = pkg.build.nsis.artifactName.replace('${productName}', pkg.build.productName);
    assert.doesNotMatch(name, /\s/);
});

test('package.json — unsigned updates are accepted, and building never publishes', () => {
    // electron-updater only verifies a signature when app-update.yml names a
    // publisherName, which electron-builder writes only for a signed build.
    assert.strictEqual(pkg.build.win.verifyUpdateCodeSignature, false);
    assert.strictEqual(pkg.build.win.publisherName, undefined);
    assert.match(pkg.scripts['dist:win'], /--publish never/);
});

test('package.json — electron-updater is a runtime dependency, so it is packaged', () => {
    assert.ok(pkg.dependencies && pkg.dependencies['electron-updater']);
    assert.ok(!(pkg.devDependencies || {})['electron-updater']);
});

// ---------------------------------------------------------- updater settings

test('the installed copy installs on quit; neither copy downloads by itself', () => {
    const installed = controller({ kind: 'installed' }).updater;
    assert.strictEqual(installed.autoDownload, false);
    assert.strictEqual(installed.autoInstallOnAppQuit, true);
    assert.strictEqual(installed.disableWebInstaller, true);
    assert.strictEqual(installed.allowPrerelease, false);

    const portable = controller({ kind: 'portable' }).updater;
    assert.strictEqual(portable.autoDownload, false);
    assert.strictEqual(portable.autoInstallOnAppQuit, false);
});

// --------------------------------------------------------------- installed copy

test('installed — an available update is downloaded, then offered', async () => {
    const { c, updater, results } = controller();
    const states = [];
    c.on('state', (s) => states.push(s));

    await c.check();
    downloaded(updater);

    assert.strictEqual(updater.calls.check, 1);
    assert.strictEqual(updater.calls.download, 1);
    assert.strictEqual(c.state.phase, 'ready');
    assert.strictEqual(c.state.version, '1.5.0');
    assert.deepStrictEqual(c.snapshot().banner.actions.map((a) => a.id), ['restart', 'dismiss']);
    assert.deepStrictEqual(results, [], 'a background check raises no dialog');

    // Nothing is shown until there is something to act on
    const shownBeforeReady = states.filter((s) => s.phase !== 'ready' && s.banner);
    assert.deepStrictEqual(shownBeforeReady, []);
});

test('installed — Restart to Update while idle installs silently and relaunches', () => {
    const { c, updater } = controller();
    downloaded(updater);

    assert.deepStrictEqual(c.action('restart'), { ok: true });
    assert.deepStrictEqual(updater.calls.install, [{ isSilent: true, isForceRunAfter: true }]);
    assert.strictEqual(c.state.installing, true);
    assert.strictEqual(c.snapshot().banner.actions.length, 0);

    // A second click does not start a second installer
    c.action('restart');
    assert.strictEqual(updater.calls.install.length, 1);
});

test('installed — never restarts while files are being optimized', () => {
    let busy = true;
    const { c, updater } = controller({ busy: () => busy });
    downloaded(updater);

    assert.deepStrictEqual(c.restart(), { ok: false, reason: 'busy' });
    assert.strictEqual(c.state.waiting, true);
    assert.deepStrictEqual(c.snapshot().banner.actions.map((a) => a.id), ['cancel-restart']);
    assert.strictEqual(updater.calls.install.length, 0);

    // An idle event that races new work does not restart either
    c.queueIdle();
    assert.strictEqual(updater.calls.install.length, 0);

    busy = false;
    c.queueIdle();
    assert.deepStrictEqual(updater.calls.install, [{ isSilent: true, isForceRunAfter: true }]);
});

test('installed — a waiting restart can be cancelled', () => {
    let busy = true;
    const { c, updater } = controller({ busy: () => busy });
    downloaded(updater);

    c.action('restart');
    c.action('cancel-restart');
    busy = false;
    c.queueIdle();

    assert.strictEqual(updater.calls.install.length, 0);
    assert.strictEqual(c.state.waiting, false);
    assert.deepStrictEqual(c.snapshot().banner.actions.map((a) => a.id), ['restart', 'dismiss']);
});

test('installed — the queue going idle does nothing unless a restart was asked for', () => {
    const { c, updater } = controller();
    downloaded(updater);
    c.queueIdle();
    assert.strictEqual(updater.calls.install.length, 0);
});

test('installed — an installer that will not start leaves the update ready', () => {
    const { c, updater, results } = controller();
    downloaded(updater);
    c.restart();

    updater.emit('error', new Error('No update filepath provided, can\'t quit and install'));

    assert.strictEqual(c.state.phase, 'ready');
    assert.strictEqual(c.state.installing, false);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].kind, 'error');
    assert.strictEqual(results[0].stage, 'install');
});

test('installed — a failed download the user is watching is reported as one', async () => {
    const { c, updater, results } = controller();
    await c.check({ manual: true });
    updater.emit('update-available', { version: '1.5.0' });
    updater.emit('error', new Error('sha512 checksum mismatch'));

    assert.strictEqual(c.state.phase, 'error');
    assert.deepStrictEqual(results.map((r) => r.stage), ['download']);
});

test('Restart to Update before anything has downloaded does nothing', () => {
    const { c, updater } = controller();
    assert.deepStrictEqual(c.restart(), { ok: false, reason: 'not-ready' });
    assert.strictEqual(updater.calls.install.length, 0);
});

// ---------------------------------------------------------------- portable copy

test('portable — an update is announced, never downloaded or installed', async () => {
    const { c, updater, urls } = controller({ kind: 'portable' });

    await c.check();
    updater.emit('checking-for-update');
    updater.emit('update-available', { version: '1.5.0' });

    assert.strictEqual(updater.calls.download, 0);
    assert.strictEqual(c.state.phase, 'available');
    assert.deepStrictEqual(c.snapshot().banner.actions.map((a) => a.id), ['release-page', 'dismiss']);

    assert.deepStrictEqual(c.action('restart'), { ok: false, reason: 'not-ready' });
    assert.strictEqual(updater.calls.install.length, 0);

    c.action('release-page');
    assert.deepStrictEqual(urls, [`${updates.RELEASES_URL}/tag/v1.5.0`]);
});

// ------------------------------------------------------------ checks and errors

test('a background check that fails stays silent and does not throw', async () => {
    const err = Object.assign(new Error('net::ERR_INTERNET_DISCONNECTED'), {});
    const updater = new FakeUpdater({ checkError: err });
    const { c, results } = controller({ updater });

    // electron-updater both emits 'error' and rejects the promise
    const pending = c.check();
    updater.emit('error', err);
    assert.strictEqual(await pending, null);

    assert.strictEqual(c.state.phase, 'error');
    assert.strictEqual(c.snapshot().banner, null);
    assert.deepStrictEqual(results, []);
});

test('a manual check reports "up to date"', async () => {
    const { c, updater, results } = controller();
    await c.check({ manual: true });
    assert.strictEqual(c.snapshot().banner.text, 'Checking for updates…');

    updater.emit('update-not-available', { version: '1.4.0' });
    assert.deepStrictEqual(results, [{ kind: 'up-to-date', version: '1.4.0' }]);
    assert.strictEqual(c.snapshot().banner, null);
});

test('a background "up to date" raises no dialog', async () => {
    const { c, updater, results } = controller();
    await c.check();
    updater.emit('update-not-available', { version: '1.4.0' });
    assert.deepStrictEqual(results, []);
});

test('a manual check reports a failure in one sentence', async () => {
    const { c, updater, results } = controller();
    await c.check({ manual: true });
    updater.emit('error', Object.assign(new Error('No published versions on GitHub'), { code: 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' }));

    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].kind, 'error');
    assert.strictEqual(results[0].stage, 'check');
    assert.match(results[0].message, /No published release/);
    assert.doesNotMatch(results[0].message, /\n/);
});

test('a manual check in a checkout explains there is nothing to check', async () => {
    const updater = new FakeUpdater();
    const { c, results } = controller({ kind: 'dev', updater });
    await c.check({ manual: true });
    assert.deepStrictEqual(results, [{ kind: 'dev' }]);
    assert.strictEqual(updater.calls.check, 0);
});

test('a manual check once an update is ready offers it again instead of re-checking', async () => {
    const { c, updater, results } = controller();
    downloaded(updater);
    c.action('dismiss');
    assert.strictEqual(c.snapshot().banner, null);

    await c.check({ manual: true });
    assert.deepStrictEqual(results, [{ kind: 'ready', version: '1.5.0' }]);
    assert.strictEqual(updater.calls.check, 0);
    assert.ok(c.snapshot().banner, 'the banner is back');
});

test('a manual check during a background download shows its progress', async () => {
    const { c, updater } = controller();
    await c.check();
    updater.emit('update-available', { version: '1.5.0' });
    updater.emit('download-progress', { percent: 41.7 });
    assert.strictEqual(c.snapshot().banner, null);

    await c.check({ manual: true });
    assert.strictEqual(updater.calls.check, 1, 'no second check');
    assert.strictEqual(c.snapshot().banner.text, 'Downloading ImageOptim 1.5.0… 41%');
});

test('dismissing hides the banner until there is news', () => {
    const { c, updater } = controller({ kind: 'portable' });
    updater.emit('update-available', { version: '1.5.0' });
    c.action('dismiss');
    assert.strictEqual(c.snapshot().banner, null);

    updater.emit('checking-for-update');
    updater.emit('update-available', { version: '1.6.0' });
    assert.match(c.snapshot().banner.text, /1\.6\.0/);
});

test('a waiting restart cannot be dismissed out of sight', () => {
    const { c, updater } = controller({ busy: () => true });
    downloaded(updater);
    c.action('restart');
    c.action('dismiss');
    assert.ok(c.snapshot().banner);
});

test('unknown actions from the renderer are ignored', () => {
    const { c, updater, urls } = controller();
    downloaded(updater);
    assert.deepStrictEqual(c.action('quit'), { ok: false, reason: 'unknown-action' });
    assert.deepStrictEqual(c.action('__proto__'), { ok: false, reason: 'unknown-action' });
    assert.strictEqual(updater.calls.install.length, 0);
    assert.deepStrictEqual(urls, []);
});

test('checkForUpdates rejecting without an error event leaves no unhandled rejection', async () => {
    const updater = new FakeUpdater({ checkError: new Error('boom') });
    const { c } = controller({ updater });
    assert.strictEqual(await c.check(), null);
    await tick();
});

// ------------------------------------------------------------------ messages

test('describeError — the GitHub provider\'s failures read as sentences', () => {
    assert.match(describeError({ code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND', message: 'Cannot find latest.yml…' }), /latest\.yml/);
    assert.match(describeError({ code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND', message: 'x' }), /No published release/);
    assert.match(describeError(new Error('404 "method: GET url: https://github.com/x/y/releases.atom"\nHeaders: {}')), /no public releases/);
    assert.match(describeError(new Error('getaddrinfo ENOTFOUND github.com')), /could not be reached/);
    assert.match(describeError(new Error('net::ERR_INTERNET_DISCONNECTED')), /could not be reached/);
});

test('describeError — anything else is cut to its first line', () => {
    const long = `${'x'.repeat(500)}\nstack line`;
    const message = describeError(new Error(long));
    assert.ok(message.length <= 200);
    assert.doesNotMatch(message, /\n|stack line/);
    assert.strictEqual(describeError(null), 'Unknown error');
});

test('bannerFor — nothing to say, nothing shown', () => {
    for (const phase of ['idle', 'up-to-date', 'error']) {
        assert.strictEqual(bannerFor({ phase, version: '1.5.0' }), null, phase);
    }
    assert.strictEqual(bannerFor({ phase: 'checking' }), null, 'a background check is silent');
});

// --------------------------------------------------------- the queue's busy flag

test('Queue.isBusy — true from the moment files are queued until they settle', async () => {
    const root = path.join(scratch(), 'busy');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'a.png'), 'x'.repeat(100));

    const settings = new Settings(path.join(scratch(), 'busy.json'));
    settings.reset();
    const queue = new Queue({ settings, binDir: path.join(scratch(), 'nobin') });
    queue.start = () => {}; // queue it, but run nothing

    assert.strictEqual(queue.isBusy(), false);
    await queue.add([root]);
    assert.strictEqual(queue.isBusy(), true, 'queued');

    queue.pending.length = 0;
    queue.running = 1; // what pump() holds until run(), save included, settles
    assert.strictEqual(queue.isBusy(), true, 'running or saving');

    queue.running = 0;
    assert.strictEqual(queue.isBusy(), false);
});

// --------------------------------------------------------------------- logging

test('makeFileLogger — appends levelled lines, and rotates a large log once', () => {
    const file = path.join(scratch(), 'updater.log');
    fs.writeFileSync(file, 'x'.repeat(2048));

    const log = makeFileLogger(file, { maxBytes: 1024, now: () => new Date('2026-11-04T10:00:00Z') });
    log.info('Checking for update');
    log.error(new Error('boom'));
    log.warn({ code: 'X' });

    assert.strictEqual(fs.readFileSync(`${file}.old`, 'utf8').length, 2048);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.strictEqual(lines[0], '2026-11-04T10:00:00.000Z info Checking for update');
    assert.match(lines[1], /^2026-11-04T10:00:00\.000Z error Error: boom/);
    assert.ok(lines.some((line) => line.endsWith('warn {"code":"X"}')));
});

test('makeFileLogger — an unwritable log never throws', () => {
    const log = makeFileLogger(path.join(scratch(), 'no', 'such', 'dir', 'updater.log'));
    assert.doesNotThrow(() => log.info('hello'));
});
