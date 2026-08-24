// preload.js — the only bridge between the main process and our browser UI.
//
// Deliberately tiny: the UI gets exactly the handful of things it needs from
// main, and nothing more. No Node APIs are exposed, and nothing here accepts a
// channel name from the caller — every channel is a literal in this file, so
// the renderer cannot be talked into sending on one it wasn't given.
//
// Guest pages get NO preload at all (main.js strips it in
// 'will-attach-webview'), so none of this is reachable from a web page.

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
  // Every value is re-validated there; nothing sent from here is trusted.
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSetting: (key, value) => ipcRenderer.send('set-setting', key, value),
  onSettingsChanged: (callback) => {
    ipcRenderer.on('settings-changed', (_event, settings) => callback(settings));
  },

  // --- Permissions ---
  // A page asking for the camera is denied before this fires; this is only
  // how the toolbar learns it happened, so it can offer to allow it.
  onPermissionBlocked: (callback) => {
    ipcRenderer.on('permission-blocked', (_event, info) => callback(info));
  },
  // No getter: the renderer already has a validated copy of sitePermissions
  // from get-settings, and every extra channel is extra surface.
  setPermission: (host, permission, allowed) =>
    ipcRenderer.send('set-permission', host, permission, allowed),

  // --- HTTPS-only ---
  // Fires when the silent upgrade to HTTPS failed because the site genuinely
  // has none, so the UI can offer the choice.
  onHttpsUpgradeFailed: (callback) => {
    ipcRenderer.on('https-upgrade-failed', (_event, info) => callback(info));
  },
  allowInsecure: (host) => ipcRenderer.send('allow-insecure', host),

  // --- Data ---
  // Main shows the confirmation dialog; this resolves false if declined.
  clearBrowsingData: () => ipcRenderer.invoke('clear-browsing-data'),
});
