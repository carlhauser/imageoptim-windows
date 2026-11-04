'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme } = require('electron');

const { Settings } = require('./lib/settings');
const { Queue } = require('./lib/queue');
const { sweepTempDirs, releaseTempDir } = require('./lib/job');

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

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 780,
        height: 560,
        minWidth: 520,
        minHeight: 320,
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#f4f4f4',
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
    mainWindow.on('closed', () => { mainWindow = null; });
}

function send(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, payload);
    }
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
                    click: () => { queue.clear(); send('jobs:reset', queue.snapshot()); },
                },
                { type: 'separator' },
                { role: 'quit' },
            ],
        },
        {
            label: '&View',
            submenu: [
                { role: 'reload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
            ],
        },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function openFileDialog() {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'svg'] }],
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
    ipcMain.handle('queue:clear', () => { queue.clear(); return queue.snapshot(); });
    ipcMain.handle('queue:snapshot', () => ({ jobs: queue.snapshot(), stats: queue.stats() }));

    ipcMain.handle('jobs:remove', (event, ids) => { queue.remove(ids || []); return queue.snapshot(); });
    ipcMain.handle('job:reveal', (event, id) => {
        if (fs.existsSync(id)) shell.showItemInFolder(id);
    });
    ipcMain.handle('job:revert', (event, id) => {
        const result = queue.revert(id);
        if (!result.ok && mainWindow) {
            dialog.showMessageBox(mainWindow, {
                type: 'warning',
                message: 'That file was not restored',
                detail: `${path.basename(id)} could not be put back because ${result.reason}.`,
                buttons: ['OK'],
            });
        }
        return result;
    });

    ipcMain.handle('settings:get', () => settings.all());
    ipcMain.handle('settings:set', (event, patch) => settings.update(patch || {}));
    ipcMain.handle('settings:reset', () => settings.reset());

    ipcMain.handle('tools:list', () => ({
        binDir: queue.binDir,
        tools: queue.installedTools(),
    }));
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
    queue = new Queue({ settings, binDir: resolveBinDir() });

    queue.on('job', (snapshot) => send('job:change', snapshot));
    queue.on('progress', (stats) => send('queue:progress', stats));
    queue.on('idle', (stats) => send('queue:idle', stats));

    registerIpc();
    buildMenu();
    createWindow();

    // Reclaim scratch directories left by a previous run that was killed.
    sweepTempDirs();

    // Files opened through Explorer arrive in argv. This used to be read only in
    // the second-instance handler, so the file associations declared in
    // package.json did nothing unless the app already happened to be running.
    const opened = filePathsFromArgv(process.argv);
    if (opened.length) queue.add(opened);
});

app.on('before-quit', () => {
    if (queue) queue.stop();
    releaseTempDir();
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
