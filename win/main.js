'use strict';

const fs = require('fs');
const path = require('path');
const {
    app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme, clipboard,
    Notification, powerSaveBlocker, screen, systemPreferences,
} = require('electron');

const { Settings } = require('./lib/settings');
const { Queue } = require('./lib/queue');
const { History } = require('./lib/history');
const { sweepTempDirs, releaseTempDir } = require('./lib/job');
const updates = require('./lib/updater');
const svgo = require('./lib/svgo');

// Long enough that the first check does not compete with startup.
const UPDATE_CHECK_DELAY_MS = 3000;

// Where the optimizer executables live. Packaged builds get them from
// resources\bin; a checkout uses win\resources\bin. IMAGEOPTIM_BIN overrides
// both, which is how the app can be driven against a non-default tool set.
function resolveBinDir() {
    if (process.env.IMAGEOPTIM_BIN) {
        return path.resolve(process.env.IMAGEOPTIM_BIN);
    }
    if (app.isPackaged) {
        return path.join(process.resourcesPath, 'bin');
    }
    return path.join(__dirname, 'resources', 'bin');
}

// The window and taskbar icon. Electron only picks up an icon compiled into
// the .exe for the file itself; this is what the running window shows.
function resolveIcon() {
    const dir = app.isPackaged ? process.resourcesPath : path.join(__dirname, 'resources');
    const icon = path.join(dir, 'icon.png');
    return fs.existsSync(icon) ? icon : undefined;
}

// NTFS paths are case-insensitive.
function samePath(a, b) {
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// Paths passed on the command line, which is how Windows hands over files when
// you open an image with the app or drop one on its icon.
//
// A relative path means relative to the folder it was typed in. For a second
// launch that is not this process's working directory, and resolving against
// ours could match a different file of the same name - which would then be
// optimized and overwritten. 'second-instance' passes the caller's directory.
function filePathsFromArgv(argv, cwd = process.cwd()) {
    // Run as `electron <app>` - `npm start`, or electron.exe pointed at a
    // checkout - the app's own directory is one of the arguments. Skipping only
    // the literal "." let `electron C:\...\win` treat the checkout as a dropped
    // folder and rewrite every image inside it. It is matched by value: it is
    // argv[1] at startup, but in the argv a second instance forwards, Chromium
    // has moved its switches in front of it.
    const appDir = process.defaultApp ? path.resolve(app.getAppPath()) : null;
    return argv
        .slice(1)
        .filter((arg) => !arg.startsWith('-') && arg !== '.')
        .map((arg) => path.resolve(cwd, arg))
        .filter((file) => !(appDir && samePath(file, appDir)))
        .filter((file) => {
            try {
                const stat = fs.statSync(file);
                return stat.isFile() || stat.isDirectory();
            } catch (err) {
                return false;
            }
        });
}

let mainWindow = null;
let settings = null;
let queue = null;
let history = null;
let updateController = null;

// --bg in renderer/style.css, so the window does not flash a different colour
// before the page paints
const windowBackground = () => (nativeTheme.shouldUseDarkColors ? '#202020' : '#f3f3f3');

// Settings → Appearance → Theme. themeSource also drives prefers-color-scheme
// in the page and the colour of native controls, so CSS needs nothing more.
function applyTheme() {
    const theme = settings.get('Theme');
    nativeTheme.themeSource = theme === 'light' || theme === 'dark' ? theme : 'system';
    if (mainWindow) mainWindow.setBackgroundColor(windowBackground());
}

// Where the window was, so it opens there again. Kept only if it still lands
// on a display: a monitor unplugged since would leave it off screen.
const WINDOW_STATE = () => path.join(app.getPath('userData'), 'window.json');

function savedBounds() {
    try {
        const saved = JSON.parse(fs.readFileSync(WINDOW_STATE(), 'utf8'));
        const { x, y, width, height } = saved;
        if (![x, y, width, height].every(Number.isFinite)) return null;
        const area = screen.getDisplayMatching({ x, y, width, height }).workArea;
        const visible = x < area.x + area.width - 80 && x + width > area.x + 80
            && y >= area.y - 10 && y < area.y + area.height - 60;
        return visible ? { x, y, width, height, maximized: Boolean(saved.maximized) } : null;
    } catch (err) {
        return null;
    }
}

function saveBounds() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
        const bounds = mainWindow.getNormalBounds();
        fs.writeFileSync(WINDOW_STATE(), JSON.stringify({ ...bounds, maximized: mainWindow.isMaximized() }));
    } catch (err) {
        /* next time it opens where Windows puts it */
    }
}

function createWindow() {
    const bounds = savedBounds();
    mainWindow = new BrowserWindow({
        width: 820,
        height: 580,
        ...(bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : {}),
        // The layout adapts down to this (see the width queries in style.css)
        minWidth: 420,
        minHeight: 360,
        backgroundColor: windowBackground(),
        title: 'ImageOptim',
        icon: resolveIcon(),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false, // the preload needs webUtils for dropped-file paths
        },
    });

    if (bounds && bounds.maximized) mainWindow.maximize();
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    // A finished batch flashes the taskbar button until the window is looked at
    mainWindow.on('focus', () => mainWindow.flashFrame(false));
    mainWindow.on('close', (event) => {
        if (closeConfirmed || !whatClosingLoses()) {
            saveBounds();
            return;
        }
        // Asked first. Quitting from the menu ends up here too, since closing
        // the window is part of quitting, and cancelling it cancels the quit.
        event.preventDefault();
        confirmDiscard('quit').then((ok) => {
            if (!ok) return;
            closeConfirmed = true;
            app.quit();
        });
    });
    mainWindow.on('closed', () => { mainWindow = null; });
}

// Set once the user has agreed to what closing loses, or when an update
// restarts the app (it only does that with the queue idle).
let closeConfirmed = false;

// What closing the window or clearing the list would throw away: files still
// being optimized, and the session's backups, which are what Revert restores.
// Copies in "ImageOptim originals" are the user's and are never deleted.
function whatClosingLoses() {
    if (!queue) return null;
    if (updateController && updateController.state.installing) return null;
    const busy = queue.isBusy();
    const revertable = settings.get('ConfirmDiscardBackups') ? queue.revertableCount() : 0;
    return busy || revertable ? { busy, revertable } : null;
}

async function confirmDiscard(action) {
    const loses = whatClosingLoses();
    if (!loses) return true;
    const quitting = action === 'quit';
    const lines = [];
    if (loses.busy) lines.push('Files are still being optimized. They will be stopped and left as they are.');
    if (loses.revertable) {
        const files = loses.revertable === 1 ? '1 optimized file' : `${loses.revertable} optimized files`;
        lines.push(`${files} can still be restored to the original with Revert. `
            + `After ${quitting ? 'quitting' : 'clearing the list'} they can’t. `
            + 'To keep originals for good, turn on Keep originals in Settings → Options.');
    }
    const { response, checkboxChecked } = await messageBox({
        type: 'question',
        message: quitting ? 'Quit ImageOptim?' : 'Clear the list?',
        detail: lines.join('\n\n'),
        buttons: [quitting ? 'Quit' : 'Clear', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
        // Only the Revert part can be silenced; stopping work is always asked
        ...(loses.busy ? {} : { checkboxLabel: 'Don’t ask again about Revert', checkboxChecked: false }),
    });
    if (response !== 0) return false;
    if (checkboxChecked) settings.update({ ConfirmDiscardBackups: false });
    return true;
}

async function clearList() {
    if (!(await confirmDiscard('clear'))) return false;
    queue.clear();
    changedJobs.clear();
    send('jobs:reset', []);
    progressMoved();
    return true;
}

function send(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, payload);
    }
}

// The taskbar button fills up with the same fraction as the bar along the
// bottom of the window. It pulses until there is anything to show.
// Red while any file in the list has failed, as Explorer's copy dialog does
function showTaskbarProgress(batch, failed = false) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!batch) mainWindow.setProgressBar(-1);
    else if (batch.estimating && !batch.done) mainWindow.setProgressBar(0, { mode: 'indeterminate' });
    else mainWindow.setProgressBar(Math.max(0.01, batch.fraction), { mode: failed ? 'error' : 'normal' });
}

function sendProgress(stats) {
    send('queue:progress', stats);
    showTaskbarProgress(stats.batch, stats.failed > 0);
    if (stats.batch) batchBegan();
}

// ------------------------------------------------------- a batch from start to end
//
// While files are being optimized the PC is kept from going to sleep under
// them. When the queue runs dry with the window in the background, its
// taskbar button flashes; a batch that took a while also ends with a Windows
// notification saying how it went.
const NOTIFY_AFTER_MS = 10000;
let batchStartedAt = 0;
let sleepBlocker = null;

function batchBegan() {
    if (batchStartedAt) return;
    batchStartedAt = Date.now();
    if (sleepBlocker === null) sleepBlocker = powerSaveBlocker.start('prevent-app-suspension');
}

function batchEnded(stats) {
    const took = batchStartedAt ? Date.now() - batchStartedAt : 0;
    batchStartedAt = 0;
    if (sleepBlocker !== null) {
        powerSaveBlocker.stop(sleepBlocker);
        sleepBlocker = null;
    }
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isFocused()) return;
    mainWindow.flashFrame(true);
    if (took < NOTIFY_AFTER_MS || !Notification.isSupported()) return;

    const parts = [`${stats.files.toLocaleString()} file${stats.files === 1 ? '' : 's'}`];
    parts.push(stats.savedBytes
        ? `saved ${formatBytes(stats.savedBytes)} (${stats.savedPercent.toFixed(1)}%)`
        : 'nothing to save');
    if (stats.failed) parts.push(`${stats.failed.toLocaleString()} failed`);
    const notification = new Notification({
        title: stats.failed ? 'ImageOptim finished, with failures' : 'ImageOptim finished',
        body: parts.join(' · '),
        silent: true,
    });
    notification.on('click', () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    });
    notification.show();
}

function formatBytes(bytes) {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

// Changes reach the window in batches. A file sends several changes as its
// optimizers finish, and adding, stopping or clearing thousands of files
// sends one per file; one message each, every one serialized at once and
// every one followed by the totals worked out afresh, kept both processes
// busy for minutes. Changed files are collected here and go out together, at
// most ten times a second, with the totals.
const FLUSH_MS = 100;
const changedJobs = new Map(); // id -> Job
let progressChanged = false;
let flushTimer = null;

function scheduleFlush() {
    if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
}

function flush() {
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    if (changedJobs.size) {
        // A file taken out of the list since it changed must not come back
        const jobs = [...changedJobs.values()]
            .filter((job) => queue.jobs.get(job.id) === job)
            .map((job) => job.toJSON());
        changedJobs.clear();
        if (jobs.length) send('jobs:changed', jobs);
    }
    if (progressChanged) {
        progressChanged = false;
        sendProgress(queue.stats());
    }
}

function jobChanged(job) {
    changedJobs.set(job.id, job);
    scheduleFlush();
}

function progressMoved() {
    progressChanged = true;
    scheduleFlush();
}

// A big folder takes a while to look through before any file shows: the
// window says how many images it has found so far, five times a second.
let scanTimer = null;
let latestScan = null;

function reportScan(scan) {
    latestScan = scan;
    if (scan.done) {
        if (scanTimer) clearTimeout(scanTimer);
        scanTimer = null;
        send('scan:progress', scan);
        if (scan.truncated) {
            messageBox({
                type: 'info',
                message: `Only the first ${scan.found.toLocaleString()} images were added`,
                detail: 'That is as many as one drop can add. Add the rest once these are done, or a folder at a time.',
                buttons: ['OK'],
            });
        }
        return;
    }
    if (!scanTimer) {
        scanTimer = setTimeout(() => {
            scanTimer = null;
            if (latestScan && !latestScan.done) send('scan:progress', latestScan);
        }, 200);
    }
}

// Once a second while files are being optimized, so the time left counts down
// and each running row's line moves even while no file finishes.
let heartbeat = null;

function beat() {
    if (!queue.isBusy()) {
        clearInterval(heartbeat);
        heartbeat = null;
        return;
    }
    for (const job of queue.runningJobs()) jobChanged(job);
    progressMoved();
}

function buildMenu() {
    const template = [
        {
            label: '&File',
            submenu: [
                {
                    label: 'Add Files…',
                    accelerator: 'CmdOrCtrl+O',
                    click: () => openFileDialog(),
                },
                {
                    label: 'Add Folder…',
                    accelerator: 'CmdOrCtrl+Shift+O',
                    click: () => openFolderDialog(),
                },
                { type: 'separator' },
                {
                    label: 'Stop',
                    accelerator: 'CmdOrCtrl+.',
                    click: () => queue.stop(),
                },
                {
                    label: 'Optimize Again',
                    accelerator: 'CmdOrCtrl+R',
                    click: () => queue.again(),
                },
                {
                    label: 'Clear List',
                    accelerator: 'CmdOrCtrl+K',
                    click: () => { clearList(); },
                },
                { type: 'separator' },
                { role: 'quit' },
            ],
        },
        {
            label: '&Edit',
            // These act on the files selected in the list, which only the
            // window knows: it is asked to run them (menu:command). The keys
            // the list handles itself are shown, not registered here, or they
            // would be taken from the settings' own controls.
            submenu: [
                { label: 'Open', click: () => send('menu:command', 'open') },
                { label: 'Show in Explorer', click: () => send('menu:command', 'reveal') },
                { label: 'Copy Path', accelerator: 'CmdOrCtrl+Shift+C', click: () => send('menu:command', 'copy') },
                { type: 'separator' },
                { label: 'Optimize Selected Again', click: () => send('menu:command', 'again') },
                { label: 'Stop Selected', click: () => send('menu:command', 'stop') },
                {
                    label: 'Restore Original',
                    accelerator: 'CmdOrCtrl+Z',
                    registerAccelerator: false,
                    click: () => send('menu:command', 'revert'),
                },
                {
                    label: 'Remove from List',
                    accelerator: 'Delete',
                    registerAccelerator: false,
                    click: () => send('menu:command', 'remove'),
                },
                { type: 'separator' },
                {
                    label: 'Select All',
                    accelerator: 'CmdOrCtrl+A',
                    registerAccelerator: false,
                    click: () => send('menu:command', 'select-all'),
                },
                {
                    label: 'Filter…',
                    accelerator: 'CmdOrCtrl+F',
                    registerAccelerator: false,
                    click: () => send('menu:command', 'find'),
                },
                { type: 'separator' },
                {
                    id: 'lossy',
                    label: 'Lossy Minification',
                    type: 'checkbox',
                    checked: Boolean(settings.get('LossyEnabled')),
                    accelerator: 'CmdOrCtrl+L',
                    click: (item) => changeSettings({ LossyEnabled: item.checked }),
                },
                { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => send('menu:command', 'settings') },
            ],
        },
        {
            label: '&View',
            submenu: [
                // For working on the app only. Reload also took Ctrl+R from
                // Optimize Again, and reloading mid-run blanked the list.
                ...(app.isPackaged ? [] : [
                    { role: 'reload' },
                    { role: 'toggleDevTools' },
                    { type: 'separator' },
                ]),
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
            ],
        },
        {
            label: '&Help',
            submenu: [
                // Hidden if updates.ENABLED is ever turned off (lib/updater.js)
                ...(updates.ENABLED ? [{
                    label: 'Check for Updates…',
                    click: () => { if (updateController) updateController.check({ manual: true }); },
                }] : []),
                {
                    label: 'Releases on GitHub',
                    click: () => shell.openExternal(updates.RELEASES_URL),
                },
                { type: 'separator' },
                { label: `ImageOptim ${app.getVersion()}`, enabled: false },
            ],
        },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function openFileDialog() {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif'] }],
    });
    if (!result.canceled && result.filePaths.length) {
        queue.add(result.filePaths);
    }
}

async function openFolderDialog() {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory', 'multiSelections'],
    });
    if (!result.canceled && result.filePaths.length) {
        queue.add(result.filePaths);
    }
}

// Settings changed from the main process's side - the Edit menu - or from the
// window's: either way the other one hears, and the menu's tick follows.
function changeSettings(patch) {
    const values = settings.update(patch);
    if ('Theme' in patch) applyTheme();
    send('settings:changed', values);
    syncMenu();
    return values;
}

function syncMenu() {
    const menu = Menu.getApplicationMenu();
    const lossy = menu && menu.getMenuItemById('lossy');
    if (lossy) lossy.checked = Boolean(settings.get('LossyEnabled'));
}

// The files in the list an id names, of those the window sent: a list of
// strings that are the queue's own keys. Anything else is ignored.
function jobsFor(ids) {
    if (!Array.isArray(ids)) return [];
    const jobs = [];
    for (const id of ids) {
        if (typeof id !== 'string') continue;
        const job = queue.jobs.get(id);
        if (job) jobs.push(job);
    }
    return jobs;
}

// Puts back the originals of several files, and reports the ones that could
// not be in one message rather than one each.
function revertJobs(jobs) {
    const failed = [];
    let restored = 0;
    for (const job of jobs) {
        if (!job.canRevert) continue;
        const result = queue.revert(job.id);
        if (result.ok) restored += 1;
        else failed.push(`${job.name}: ${result.reason}`);
    }
    if (failed.length) {
        const shown = failed.slice(0, 8);
        if (failed.length > shown.length) shown.push(`and ${failed.length - shown.length} more`);
        messageBox({
            type: 'warning',
            message: restored
                ? `Restored ${restored} file${restored === 1 ? '' : 's'}; ${failed.length} could not be`
                : `${failed.length === 1 ? 'That file was' : 'Those files were'} not restored`,
            detail: shown.join('\n'),
            buttons: ['OK'],
        });
    }
}

// What can be done to files in the list, from the right-click menu, the Edit
// menu and the keyboard alike.
function runJobCommand(command, ids) {
    const jobs = jobsFor(ids);
    if (!jobs.length) return false;
    const existing = jobs.filter((job) => fs.existsSync(job.filePath));
    switch (command) {
        case 'open':
            // One file, or a handful: each opens in the app Windows has for it
            for (const job of existing.slice(0, 10)) shell.openPath(job.filePath);
            return true;
        case 'reveal':
            if (existing.length) shell.showItemInFolder(existing[0].filePath);
            return true;
        case 'copy':
            clipboard.writeText(jobs.map((job) => job.filePath).join('\r\n'));
            return true;
        case 'again':
            queue.againIds(jobs.map((job) => job.id));
            return true;
        case 'stop':
            queue.stopIds(jobs.map((job) => job.id));
            return true;
        case 'revert':
            revertJobs(jobs);
            return true;
        case 'remove': {
            const removed = jobs.map((job) => job.id);
            queue.remove(removed);
            send('jobs:removed', removed);
            return true;
        }
        default:
            return false;
    }
}

function showJobMenu(ids) {
    const jobs = jobsFor(ids);
    if (!jobs.length || !mainWindow) return;
    const many = jobs.length > 1;
    const busy = (job) => job.isRunning || job.waiting;
    const run = (command) => () => runJobCommand(command, jobs.map((job) => job.id));
    Menu.buildFromTemplate([
        { label: many ? 'Open' : 'Open', enabled: jobs.length <= 10, click: run('open') },
        { label: 'Show in Explorer', click: run('reveal') },
        { label: many ? 'Copy Paths' : 'Copy Path', accelerator: 'CmdOrCtrl+Shift+C', click: run('copy') },
        { type: 'separator' },
        { label: 'Optimize Again', enabled: jobs.some((job) => !busy(job) && !job.blocked), click: run('again') },
        { label: 'Stop', enabled: jobs.some(busy), click: run('stop') },
        {
            label: 'Restore Original',
            accelerator: 'CmdOrCtrl+Z',
            enabled: jobs.some((job) => job.canRevert && !busy(job)),
            click: run('revert'),
        },
        { type: 'separator' },
        { label: 'Remove from List', accelerator: 'Delete', click: run('remove') },
    ]).popup({ window: mainWindow });
}

const CONFIRM = {
    'reset-settings': {
        message: 'Restore every setting to its default?',
        detail: 'All three tabs: formats, options and appearance.',
        button: 'Restore Defaults',
    },
    'forget-history': {
        message: 'Forget every optimized file?',
        detail: 'Files optimized before will be optimized again the next time they are added.',
        button: 'Forget',
    },
};

function windowsAccent() {
    try {
        const color = systemPreferences.getAccentColor();
        return /^[0-9a-f]{6}/i.test(color) ? color.slice(0, 6) : null;
    } catch (err) {
        return null;
    }
}

function registerIpc() {
    ipcMain.handle('files:add', (event, paths) => queue.add(paths || []));
    ipcMain.handle('files:choose', () => openFileDialog());
    ipcMain.handle('folders:choose', () => openFolderDialog());

    // These answer with counts at most: the files' own changes follow as
    // jobs:changed, in batches
    ipcMain.handle('queue:stop', () => { queue.stop(); return true; });
    ipcMain.handle('queue:again', () => { queue.again(); return true; });
    ipcMain.handle('queue:clear', () => clearList());
    ipcMain.handle('queue:snapshot', () => ({ jobs: queue.snapshot(), stats: queue.stats() }));

    // Ids are the queue's keys, not paths to act on: only a file in the list
    // is ever opened, shown, restored or removed
    ipcMain.handle('jobs:command', (event, command, ids) => runJobCommand(String(command), ids));
    ipcMain.handle('jobs:menu', (event, ids) => { showJobMenu(ids); });

    // Windows' accent colour, as RRGGBB, for Appearance's "Use the Windows
    // accent colour"; the window hears when it changes
    ipcMain.handle('accent:get', () => windowsAccent());

    // Questions the window asks before something it cannot undo. It names
    // which; the words are the main process's own.
    ipcMain.handle('confirm', async (event, kind) => {
        const question = CONFIRM[kind];
        if (!question) return false;
        const { response } = await messageBox({
            type: 'question',
            message: question.message,
            detail: question.detail,
            buttons: [question.button, 'Cancel'],
            defaultId: 0,
            cancelId: 1,
        });
        return response === 0;
    });

    ipcMain.handle('settings:get', () => settings.all());
    ipcMain.handle('settings:set', (event, patch) => {
        const values = settings.update(patch && typeof patch === 'object' ? patch : {});
        if (patch && 'Theme' in patch) applyTheme();
        syncMenu();
        return values;
    });
    ipcMain.handle('settings:reset', () => {
        const values = settings.reset();
        applyTheme();
        syncMenu();
        return values;
    });

    // Settings → Options → Files: how many files are remembered as optimized,
    // and forgetting them all
    ipcMain.handle('history:stats', () => ({ count: history.count() }));
    ipcMain.handle('history:forget', () => {
        history.forget();
        return { count: 0 };
    });

    ipcMain.handle('tools:list', () => ({
        binDir: queue.binDir,
        tools: queue.installedTools(),
    }));

    ipcMain.handle('update:state', () => (updateController ? updateController.snapshot() : null));
    ipcMain.handle('update:action', (event, id) => (
        updateController ? updateController.action(String(id)) : { ok: false, reason: 'not-ready' }
    ));
}

function messageBox(options) {
    return mainWindow && !mainWindow.isDestroyed()
        ? dialog.showMessageBox(mainWindow, options)
        : dialog.showMessageBox(options);
}

// The answer to Help > Check for Updates. Background checks never get here:
// they stay silent unless there is an update to offer.
async function showUpdateResult(result) {
    if (result.kind === 'up-to-date') {
        await messageBox({
            type: 'info',
            message: 'ImageOptim is up to date',
            detail: `Version ${app.getVersion()} is the newest release.`,
            buttons: ['OK'],
        });
    } else if (result.kind === 'ready') {
        const { response } = await messageBox({
            type: 'info',
            message: `ImageOptim ${result.version} is ready to install`,
            detail: 'It installs when you quit, or you can restart now. '
                + 'If files are being optimized, the restart waits until they are finished.',
            buttons: ['Restart to Update', 'Later'],
            defaultId: 0,
            cancelId: 1,
        });
        if (response === 0) updateController.restart();
    } else if (result.kind === 'error') {
        const headline = {
            check: 'Couldn’t check for updates',
            download: 'The update could not be downloaded',
            install: 'The update could not be started',
        }[result.stage] || 'Couldn’t check for updates';
        const { response } = await messageBox({
            type: 'warning',
            message: headline,
            detail: `${result.message}\n\nNew versions are also published on the releases page.`,
            buttons: ['OK', 'Open Releases Page'],
            defaultId: 0,
            cancelId: 0,
        });
        if (response === 1) shell.openExternal(updates.RELEASES_URL);
    } else if (result.kind === 'dev') {
        await messageBox({
            type: 'info',
            message: 'Updates are checked only in the packaged app',
            detail: 'This copy runs from a source checkout, so it is updated with git rather than from GitHub releases.',
            buttons: ['OK'],
        });
    }
}

// Installed copies download in the background and offer a restart; the
// unzipped portable copy cannot replace its own files, so it only says that a
// release exists. A checkout never checks at all.
//
// With updates.ENABLED off there is no controller: update:state answers null,
// so the banner never appears and electron-updater is never loaded.
function setupUpdates() {
    if (!updates.ENABLED) return;

    const kind = updates.installKind({ isPackaged: app.isPackaged, execPath: process.execPath });

    let updater = null;
    if (kind !== 'dev') {
        // Required here rather than at the top: a checkout has no use for it.
        ({ autoUpdater: updater } = require('electron-updater'));
        updater.logger = updates.makeFileLogger(path.join(app.getPath('userData'), 'updater.log'));
    }

    updateController = new updates.UpdateController({
        updater,
        kind,
        isBusy: () => queue.isBusy(),
        currentVersion: app.getVersion(),
    });
    updateController.on('state', (state) => send('update:state', state));
    updateController.on('manual-result', (result) => { showUpdateResult(result); });
    updateController.on('open-url', (url) => shell.openExternal(url));

    // A restart asked for mid-run happens here, once nothing is being written.
    queue.on('idle', () => updateController.queueIdle());

    if (kind !== 'dev') setTimeout(() => updateController.check(), UPDATE_CHECK_DELAY_MS);
}

if (!app.requestSingleInstanceLock()) {
    // Without the return the rest of this file still runs in the losing
    // instance, which goes on to build its own Settings and Queue.
    app.quit();
    return;
}

app.whenReady().then(() => {
    app.setAppUserModelId('com.imageoptim.windows');

    settings = new Settings(path.join(app.getPath('userData'), 'settings.json'));
    applyTheme();
    registerIpc();
    buildMenu();
    systemPreferences.on('accent-color-changed', () => send('accent:changed', windowsAccent()));
    // The window first: its renderer starts while the list of optimized files
    // is read below, which can be tens of thousands of lines. Nothing it asks
    // is answered before this function has returned, by which time the queue
    // exists.
    createWindow();

    history = new History(path.join(app.getPath('userData'), 'optimized.jsonl'), { batchMs: 1000 }).load();
    queue = new Queue({ settings, binDir: resolveBinDir(), history });

    queue.on('job', jobChanged);
    queue.on('progress', () => {
        progressMoved();
        if (queue.isBusy() && !heartbeat) heartbeat = setInterval(beat, 1000);
    });
    queue.on('idle', (stats) => {
        flush(); // the last files' rows before the summary
        send('queue:idle', stats);
        batchEnded(stats);
    });
    queue.on('scan', reportScan);

    setupUpdates();

    // Reclaim scratch directories left by a previous run that was killed,
    // once the window is up
    setTimeout(() => { sweepTempDirs(); }, 3000);

    // Files opened through Explorer arrive in argv. This used to be read only in
    // the second-instance handler, so the file associations declared in
    // package.json did nothing unless the app already happened to be running.
    const opened = filePathsFromArgv(process.argv);
    if (opened.length) queue.add(opened);
});

// Restart to Update arrives here too: electron-updater starts the installer and
// then calls app.quit(), and the controller only lets it once the queue is idle.
//
// will-quit, not before-quit: before-quit comes before the window's close
// event, where the user can still cancel, and by then the queue would already
// have been stopped and every backup deleted.
app.on('will-quit', () => {
    if (queue) queue.stop();
    svgo.stopAll();
    releaseTempDir();
    // Writes are put off while a slider is being dragged; the last one must
    // not be lost on the way out
    if (settings) settings.flush();
    if (history) history.flush();
});

app.on('window-all-closed', () => {
    if (queue) queue.clear();
    app.quit();
});

// Files dragged onto the taskbar icon or passed on the command line
// Explorer starts one process per selected file, and each hands its file to
// this one: those arriving within a moment of each other are added together,
// as one batch.
let arriving = [];
let arrivingTimer = null;

app.on('second-instance', (event, argv, workingDirectory) => {
    const paths = filePathsFromArgv(argv, workingDirectory);
    if (paths.length && queue) {
        arriving.push(...paths);
        if (!arrivingTimer) {
            arrivingTimer = setTimeout(() => {
                const batch = arriving;
                arriving = [];
                arrivingTimer = null;
                queue.add(batch);
            }, 200);
        }
    }
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    }
});
