'use strict';

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme } = require('electron');

const { Settings } = require('./lib/settings');
const { Queue } = require('./lib/queue');

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
    ipcMain.handle('job:revert', (event, id) => queue.revert(id));

    ipcMain.handle('settings:get', () => settings.all());
    ipcMain.handle('settings:set', (event, patch) => settings.update(patch || {}));
    ipcMain.handle('settings:reset', () => settings.reset());

    ipcMain.handle('tools:list', () => ({
        binDir: queue.binDir,
        tools: queue.installedTools(),
    }));
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
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
});

app.on('window-all-closed', () => {
    if (queue) queue.clear();
    app.quit();
});

// Files dragged onto the taskbar icon or passed on the command line
app.on('second-instance', (event, argv) => {
    const paths = argv.slice(1).filter((arg) => !arg.startsWith('-'));
    if (paths.length && queue) queue.add(paths);
    if (mainWindow) mainWindow.focus();
});
