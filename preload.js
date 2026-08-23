// preload.js — the only bridge between the main process and our browser UI.
// Deliberately tiny: the UI needs exactly one thing from main, so that's all
// it gets. No Node APIs are exposed to the page.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('browserAPI', {
  onOpenNewTab: (callback) => {
    ipcRenderer.on('open-new-tab', (_event, url) => callback(url));
  },
  onFullScreen: (callback) => {
    ipcRenderer.on('fullscreen', (_event, isFullScreen) => callback(isFullScreen));
  },
});
