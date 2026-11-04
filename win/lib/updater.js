'use strict';

// Self-updating, on top of electron-updater's GitHub provider.
//
// This module deliberately requires neither electron nor electron-updater:
// main.js hands it the real autoUpdater, and the tests hand it a fake, so the
// suite runs under plain node with no dependencies installed.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

// Off while carlhauser/imageoptim-windows is private. The GitHub provider reads
// releases.atom, latest.yml and the installer without credentials, and a private
// repository answers all three with 404, so a check could never find anything.
// main.js neither checks nor shows Check for Updates while this is false.
// Turning it on needs the releases somewhere public: see "Updates" in
// win/README.md.
const ENABLED = false;

const OWNER = 'carlhauser';
const REPO = 'imageoptim-windows';
const RELEASES_URL = `https://github.com/${OWNER}/${REPO}/releases`;

// electron-builder's NSIS installer writes "Uninstall ${productFilename}.exe"
// into the install directory (templates/nsis/common.nsh). The portable zip is
// the same win-unpacked folder without it.
const UNINSTALLER = 'Uninstall ImageOptim.exe';

// Versions come from latest.yml on GitHub, so they are checked before being
// put into a URL that is handed to the shell.
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function releasePageUrl(version) {
    return typeof version === 'string' && VERSION_PATTERN.test(version)
        ? `${RELEASES_URL}/tag/v${version}`
        : `${RELEASES_URL}/latest`;
}

// 'dev'       run from a checkout: never checks
// 'installed' the NSIS install: downloads and replaces itself
// 'portable'  the unzipped zip, which cannot replace its own files: only tells
//
// PORTABLE_EXECUTABLE_DIR alone is not enough. electron-builder sets it only for
// its 'portable' target, a self-extracting exe, and this app ships a 'zip'
// instead. The uninstaller is the signal both cases share.
function installKind({ isPackaged, execPath, env = process.env, exists = fs.existsSync }) {
    if (!isPackaged) return 'dev';
    if (env.PORTABLE_EXECUTABLE_DIR) return 'portable';
    return exists(path.join(path.dirname(execPath), UNINSTALLER)) ? 'installed' : 'portable';
}

// electron-updater's messages carry the request, the response headers and a
// stack; a dialog wants one sentence.
function describeError(err) {
    const code = err && err.code;
    const message = String((err && err.message) || err || 'Unknown error');

    if (code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' || code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND') {
        return `No published release was found at github.com/${OWNER}/${REPO}.`;
    }
    if (code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') {
        return 'The newest release on GitHub has no latest.yml, so it cannot be installed from inside the app.';
    }
    if (/\b404\b/.test(message.split('\n')[0])) {
        return `github.com/${OWNER}/${REPO} has no public releases.`;
    }
    if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_CHANGED|ERR_CONNECTION/.test(message)) {
        return 'GitHub could not be reached. Check the internet connection and try again.';
    }

    const firstLine = message.split('\n')[0].trim();
    return firstLine.length > 200 ? `${firstLine.slice(0, 199)}…` : firstLine;
}

// What the renderer shows, worked out here so the renderer stays a dumb view
// and the wording is covered by the tests. Background checks are silent until
// there is something to act on; a check the user asked for shows its progress.
function bannerFor(state) {
    if (!state || state.dismissed) return null;
    const name = `ImageOptim ${state.version}`;

    switch (state.phase) {
    case 'checking':
        return state.manual ? { text: 'Checking for updates…', actions: [] } : null;

    case 'downloading':
        return state.manual
            ? { text: `Downloading ${name}… ${Math.floor(state.percent || 0)}%`, actions: [] }
            : null;

    case 'ready':
        if (state.installing) {
            return { text: `Restarting to install ${name}…`, actions: [] };
        }
        if (state.waiting) {
            return {
                text: `${name} will install as soon as the files being optimized are finished.`,
                actions: [{ id: 'cancel-restart', label: 'Cancel' }],
            };
        }
        return {
            text: `${name} is ready, and installs when you quit.`,
            actions: [
                { id: 'restart', label: 'Restart to Update', primary: true },
                { id: 'dismiss', label: 'Later' },
            ],
        };

    case 'available':
        return {
            text: `${name} is available. This unzipped copy can’t update itself.`,
            actions: [
                { id: 'release-page', label: 'Download…', primary: true },
                { id: 'dismiss', label: 'Later' },
            ],
        };

    default:
        return null;
    }
}

const ACTIONS = ['restart', 'cancel-restart', 'release-page', 'dismiss'];

// Drives one electron-updater instance.
//
// Events:
//   'state'         { phase, version, percent, manual, waiting, installing,
//                     dismissed, kind, releaseUrl, banner }
//   'manual-result' { kind: 'up-to-date' | 'error' | 'ready' | 'dev', ... }
//                   errors carry stage: 'check' | 'download' | 'install'
//                   the answer to a check the user asked for, for a dialog
//   'open-url'      url, for the release page
//
// Phases: idle, checking, downloading, ready (installed), available (portable),
// up-to-date, error.
class UpdateController extends EventEmitter {
    constructor({ updater, kind, isBusy, currentVersion }) {
        super();
        this.updater = updater || null;
        this.kind = kind;
        this.isBusy = isBusy || (() => false);
        this.currentVersion = currentVersion || null;
        this.state = {
            phase: 'idle',
            version: null,
            percent: 0,
            manual: false,
            waiting: false,
            installing: false,
            dismissed: false,
        };

        if (this.updater && kind !== 'dev') this.attach();
    }

    attach() {
        const updater = this.updater;

        // Downloading is started by hand so the portable copy never fetches an
        // installer it could not run.
        updater.autoDownload = false;
        // A downloaded update also installs on an ordinary quit, which goes
        // through before-quit like any other. Not restarting afterwards is
        // electron-updater's behaviour for this path.
        updater.autoInstallOnAppQuit = this.kind === 'installed';
        updater.allowPrerelease = false;
        updater.allowDowngrade = false;
        // The installer is a full NSIS exe, not a web installer; without this
        // electron-updater warns on every download.
        updater.disableWebInstaller = true;

        updater.on('checking-for-update', () => {
            if (this.state.phase !== 'ready') this.set({ phase: 'checking' });
        });

        updater.on('update-available', (info) => {
            const version = info && info.version;
            if (this.kind === 'installed') {
                this.set({ phase: 'downloading', version, percent: 0 });
                this.download();
            } else {
                this.set({ phase: 'available', version, manual: false });
            }
        });

        updater.on('download-progress', (progress) => {
            if (this.state.phase === 'downloading') {
                this.set({ percent: (progress && progress.percent) || 0 });
            }
        });

        updater.on('update-downloaded', (info) => {
            this.set({
                phase: 'ready',
                version: (info && info.version) || this.state.version,
                percent: 100,
                manual: false,
            });
        });

        updater.on('update-not-available', () => {
            const manual = this.state.manual;
            this.set({ phase: 'up-to-date', manual: false });
            if (manual) this.emit('manual-result', { kind: 'up-to-date', version: this.currentVersion });
        });

        // An EventEmitter with no 'error' listener throws, and electron-updater
        // emits on every failed request; this listener is what keeps an offline
        // start from crashing the main process.
        updater.on('error', (err) => {
            const message = describeError(err);

            if (this.state.phase === 'ready') {
                // Downloaded but the installer would not start. Stay ready, so
                // it can be tried again or left to install on quit.
                if (this.state.installing) {
                    this.set({ installing: false, waiting: false });
                    this.emit('manual-result', { kind: 'error', stage: 'install', message });
                }
                return;
            }

            const manual = this.state.manual;
            const stage = this.state.phase === 'downloading' ? 'download' : 'check';
            this.set({ phase: 'error', manual: false, percent: 0 });
            if (manual) this.emit('manual-result', { kind: 'error', stage, message });
        });
    }

    snapshot() {
        const state = { ...this.state, kind: this.kind, releaseUrl: releasePageUrl(this.state.version) };
        state.banner = bannerFor(state);
        return state;
    }

    set(patch) {
        // Anything new to say brings a dismissed banner back.
        if ('phase' in patch && patch.phase !== this.state.phase) patch = { dismissed: false, ...patch };
        Object.assign(this.state, patch);
        this.emit('state', this.snapshot());
    }

    check({ manual = false } = {}) {
        if (this.kind === 'dev' || !this.updater) {
            if (manual) this.emit('manual-result', { kind: 'dev' });
            return Promise.resolve(null);
        }

        const { phase } = this.state;

        if (phase === 'ready') {
            if (manual) {
                this.set({ dismissed: false });
                this.emit('manual-result', { kind: 'ready', version: this.state.version });
            }
            return Promise.resolve(null);
        }

        // Already under way: a manual check just makes it visible, and gets the
        // answer as a dialog when it lands.
        if (phase === 'checking' || phase === 'downloading') {
            if (manual) this.set({ manual: true, dismissed: false });
            return Promise.resolve(null);
        }

        this.set({ phase: 'checking', manual, dismissed: false });
        return Promise.resolve()
            .then(() => this.updater.checkForUpdates())
            .then((result) => {
                // null means electron-updater considers itself inactive
                if (result == null && this.state.phase === 'checking') this.set({ phase: 'idle', manual: false });
                return result;
            })
            // Failures arrive through the 'error' event as well, which is where
            // they are reported; this only stops an unhandled rejection.
            .catch(() => null);
    }

    // Called from the 'update-available' handler. electron-updater records what
    // it found before emitting that event, so downloading straight away works.
    download() {
        try {
            Promise.resolve(this.updater.downloadUpdate()).catch(() => null); // reported through 'error'
        } catch (err) {
            this.updater.emit('error', err);
        }
    }

    // Files are rewritten in place, so the app never restarts under a running
    // optimization: the request waits for the queue to go idle instead.
    restart() {
        if (this.state.phase !== 'ready') return { ok: false, reason: 'not-ready' };
        if (this.state.installing) return { ok: true };
        if (this.isBusy()) {
            this.set({ waiting: true, dismissed: false });
            return { ok: false, reason: 'busy' };
        }
        return this.install();
    }

    cancelRestart() {
        if (this.state.waiting) this.set({ waiting: false });
    }

    // Wired to the queue's 'idle' event.
    queueIdle() {
        if (this.state.phase === 'ready' && this.state.waiting && !this.isBusy()) this.install();
    }

    install() {
        this.set({ waiting: false, installing: true });
        // Silent, then relaunch. electron-updater starts the installer and then
        // calls app.quit(), so before-quit runs exactly as on any other quit.
        this.updater.quitAndInstall(true, true);
        return { ok: true };
    }

    dismiss() {
        if (!this.state.waiting && !this.state.installing) this.set({ dismissed: true });
    }

    // The single entry point for the renderer's buttons. Unknown ids are
    // ignored, since they come from the less trusted side of the bridge.
    action(id) {
        if (!ACTIONS.includes(id)) return { ok: false, reason: 'unknown-action' };
        if (id === 'restart') return this.restart();
        if (id === 'cancel-restart') this.cancelRestart();
        if (id === 'dismiss') this.dismiss();
        if (id === 'release-page') this.emit('open-url', releasePageUrl(this.state.version));
        return { ok: true };
    }
}

// electron-updater logs every request it makes; a packaged app has no console
// to read them on, so they go to userData\updater.log, rotated once per launch
// when it has grown past maxBytes.
function makeFileLogger(file, { maxBytes = 256 * 1024, now = () => new Date() } = {}) {
    let rotated = false;

    function format(value) {
        if (value instanceof Error) return value.stack || value.message;
        if (typeof value === 'string') return value;
        try {
            return JSON.stringify(value);
        } catch (err) {
            return String(value);
        }
    }

    function write(level, args) {
        if (!rotated) {
            rotated = true;
            try {
                if (fs.statSync(file).size > maxBytes) fs.renameSync(file, `${file}.old`);
            } catch (err) {
                /* no log yet */
            }
        }
        try {
            fs.appendFileSync(file, `${now().toISOString()} ${level} ${args.map(format).join(' ')}\n`);
        } catch (err) {
            /* logging must never take the updater down */
        }
    }

    return {
        info: (...args) => write('info', args),
        warn: (...args) => write('warn', args),
        error: (...args) => write('error', args),
        debug: (...args) => write('debug', args),
    };
}

module.exports = {
    ENABLED,
    OWNER,
    REPO,
    RELEASES_URL,
    UNINSTALLER,
    ACTIONS,
    releasePageUrl,
    installKind,
    describeError,
    bannerFor,
    UpdateController,
    makeFileLogger,
};
