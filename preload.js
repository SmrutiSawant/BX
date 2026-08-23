// preload.js — the only bridge between the main process and our browser UI.
// Deliberately tiny: the UI gets exactly the handful of things it needs from
// main, and nothing more. No Node APIs are exposed to the page.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('browserAPI', {
  // Only Windows paints native caption buttons over our tab strip, so only
  // Windows needs the strip to reserve space for them.
  hasTitleBarOverlay: process.platform === 'win32',

  onOpenNewTab: (callback) => {
    ipcRenderer.on('open-new-tab', (_event, url) => callback(url));
  },

  onFullScreen: (callback) => {
    ipcRenderer.on('fullscreen', (_event, isFullScreen) => callback(isFullScreen));
  },

  // Ad blocker. Counts arrive batched as [[tabId, count], ...] where tabId is
  // a webContents id, matched in the renderer via view.getWebContentsId().
  onBlockCounts: (callback) => {
    ipcRenderer.on('block-counts', (_event, entries) => callback(new Map(entries)));
  },

  // Called when a tab navigates, so its counter starts fresh on the new page.
  resetBlockCount: (tabId) => ipcRenderer.send('reset-block-count', tabId),

  // Shortcuts pressed while a page had focus, rescued by the main process.
  onShortcut: (callback) => {
    ipcRenderer.on('shortcut', (_event, payload) => callback(payload));
  },

  // Settings, persisted to a JSON file in userData by the main process.
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSetting: (key, value) => ipcRenderer.send('set-setting', key, value),
});
