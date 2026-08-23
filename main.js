// main.js — Electron main process.
// This owns the OS window. The actual web pages are rendered by Chromium
// inside <webview> elements that live in index.html.

const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 640,
    minHeight: 400,
    title: 'MiniBrowser',
    backgroundColor: '#202124',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Lets index.html use <webview> tags to host real web pages.
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

// When a page inside a <webview> tries to open a popup / target="_blank" link,
// intercept it and hand the URL back to our UI so it opens as a new tab.
app.on('web-contents-created', (_event, contents) => {
  // F12 toggles devtools for whichever process has focus — the browser UI
  // itself, or the page inside a tab. Handy for diagnosing layout issues.
  contents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      event.preventDefault();
      if (contents.isDevToolsOpened()) contents.closeDevTools();
      else contents.openDevTools();
    }
  });

  if (contents.getType() !== 'webview') return;

  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('open-new-tab', url);
      }
    } else {
      // Non-web schemes (mailto:, tel:, ...) go to the OS default handler.
      shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
