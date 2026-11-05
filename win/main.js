'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme } = require('electron');

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

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 820,
        height: 580,
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

    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    mainWindow.on('close', (event) => {
        if (closeConfirmed || !whatClosingLoses()) return;
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
    send('jobs:reset', queue.snapshot());
    return true;
}

function send(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, payload);
    }
}

// The taskbar button fills up with the same fraction as the bar along the
// bottom of the window. It pulses until there is anything to show.
function showTaskbarProgress(batch) {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!batch) mainWindow.setProgressBar(-1);
    else if (batch.estimating && !batch.done) mainWindow.setProgressBar(0, { mode: 'indeterminate' });
    else mainWindow.setProgressBar(Math.max(0.01, batch.fraction));
}

function sendProgress(stats) {
    send('queue:progress', stats);
    showTaskbarProgress(stats.batch);
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
    for (const job of queue.runningJobs()) send('job:change', job.toJSON());
    sendProgress(queue.stats());
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

function registerIpc() {
    ipcMain.handle('files:add', (event, paths) => queue.add(paths || []));
    ipcMain.handle('files:choose', () => openFileDialog());
    ipcMain.handle('folders:choose', () => openFolderDialog());

    ipcMain.handle('queue:stop', () => { queue.stop(); return queue.stats(); });
    ipcMain.handle('queue:again', () => { queue.again(); return queue.stats(); });
    ipcMain.handle('queue:clear', async () => { await clearList(); return queue.snapshot(); });
    ipcMain.handle('queue:snapshot', () => ({ jobs: queue.snapshot(), stats: queue.stats() }));

    ipcMain.handle('jobs:remove', (event, ids) => { queue.remove(ids || []); return queue.snapshot(); });
    // Ids are the queue's keys, not paths to act on: only a file in the list
    // is ever shown or restored
    ipcMain.handle('job:reveal', (event, id) => {
        const job = queue.jobs.get(id);
        if (job && fs.existsSync(job.filePath)) shell.showItemInFolder(job.filePath);
    });
    ipcMain.handle('job:revert', (event, id) => {
        const job = queue.jobs.get(id);
        const result = queue.revert(id);
        if (!result.ok && mainWindow) {
            dialog.showMessageBox(mainWindow, {
                type: 'warning',
                message: 'That file was not restored',
                detail: `${job ? job.name : 'The file'} could not be put back because ${result.reason}.`,
                buttons: ['OK'],
            });
        }
        return result;
    });

    ipcMain.handle('settings:get', () => settings.all());
    ipcMain.handle('settings:set', (event, patch) => {
        const values = settings.update(patch || {});
        if (patch && 'Theme' in patch) applyTheme();
        return values;
    });
    ipcMain.handle('settings:reset', () => {
        const values = settings.reset();
        applyTheme();
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
    history = new History(path.join(app.getPath('userData'), 'optimized.jsonl')).load();
    queue = new Queue({ settings, binDir: resolveBinDir(), history });

    queue.on('job', (snapshot) => send('job:change', snapshot));
    queue.on('progress', (stats) => {
        sendProgress(stats);
        if (queue.isBusy() && !heartbeat) heartbeat = setInterval(beat, 1000);
    });
    queue.on('idle', (stats) => send('queue:idle', stats));

    registerIpc();
    buildMenu();
    createWindow();
    setupUpdates();

    // Reclaim scratch directories left by a previous run that was killed.
    sweepTempDirs();

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
});

app.on('window-all-closed', () => {
    if (queue) queue.clear();
    app.quit();
});

// Files dragged onto the taskbar icon or passed on the command line
app.on('second-instance', (event, argv, workingDirectory) => {
    const paths = filePathsFromArgv(argv, workingDirectory);
    if (paths.length && queue) queue.add(paths);
    if (mainWindow) mainWindow.focus();
});
