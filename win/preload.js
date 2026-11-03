'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// The renderer never touches Node. It gets this narrow surface instead, plus
// pathForFile, which is the only supported way to learn a dropped file's path
// now that File.path is gone from Electron.
contextBridge.exposeInMainWorld('imageoptim', {
    pathForFile: (file) => {
        try {
            return webUtils.getPathForFile(file);
        } catch (err) {
            return file.path || null;
        }
    },

    addPaths: (paths) => ipcRenderer.invoke('files:add', paths),
    chooseFiles: () => ipcRenderer.invoke('files:choose'),
    chooseFolders: () => ipcRenderer.invoke('folders:choose'),

    stop: () => ipcRenderer.invoke('queue:stop'),
    again: () => ipcRenderer.invoke('queue:again'),
    clear: () => ipcRenderer.invoke('queue:clear'),
    snapshot: () => ipcRenderer.invoke('queue:snapshot'),

    removeJobs: (ids) => ipcRenderer.invoke('jobs:remove', ids),
    reveal: (id) => ipcRenderer.invoke('job:reveal', id),
    revert: (id) => ipcRenderer.invoke('job:revert', id),

    getSettings: () => ipcRenderer.invoke('settings:get'),
    setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
    resetSettings: () => ipcRenderer.invoke('settings:reset'),
    listTools: () => ipcRenderer.invoke('tools:list'),

    onJobChange: (handler) => ipcRenderer.on('job:change', (event, job) => handler(job)),
    onProgress: (handler) => ipcRenderer.on('queue:progress', (event, stats) => handler(stats)),
    onIdle: (handler) => ipcRenderer.on('queue:idle', (event, stats) => handler(stats)),
    onReset: (handler) => ipcRenderer.on('jobs:reset', (event, jobs) => handler(jobs)),
});
