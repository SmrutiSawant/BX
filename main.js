// main.js — Electron main process.
// This owns the OS window. The actual web pages are rendered by Chromium
// inside <webview> elements that live in index.html.

const { app, BrowserWindow, shell, screen } = require('electron');
const path = require('path');

// --- Chromium switches. Must be set before the app is ready. ---

// Animated, per-pixel scrolling instead of jumping a chunk per wheel notch.
app.commandLine.appendSwitch('enable-smooth-scrolling');

// Windows periodically checks whether the window is covered by another window
// so it can throttle painting. That check stutters badly while a frameless
// window is being dragged. Turning it off costs a little idle CPU and is the
// standard fix for choppy drag in Electron on Windows.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

let mainWindow = null;

// --- Temporary diagnostics. Delete this block, writeDiagnostics(), and the
// --- probe at the bottom of renderer.js once the UI is confirmed working.
const LOG = path.join(__dirname, 'browser-log.txt');

function logLine(line) {
  try {
    require('fs').appendFileSync(LOG, new Date().toISOString().slice(11, 23) + '  ' + line + '\n');
  } catch { /* logging must never break the app */ }
}

function attachLogging(win) {
  try { require('fs').writeFileSync(LOG, ''); } catch {}

  // Electron changed this signature across versions: older passes
  // (event, level, message, ...), newer passes a single event object.
  win.webContents.on('console-message', (...args) => {
    const first = args[0];
    const message = first && typeof first === 'object' && 'message' in first
      ? first.message
      : args[2];
    logLine('[ui] ' + message);
  });

  win.on('resize', () => logLine('[win] resize -> ' + JSON.stringify(win.getBounds())));
  win.on('maximize', () => logLine('[win] maximize -> ' + JSON.stringify(win.getBounds())));
  win.on('unmaximize', () => logLine('[win] unmaximize'));
  win.on('enter-full-screen', () => logLine('[win] enter-full-screen'));
  win.on('leave-full-screen', () => logLine('[win] leave-full-screen'));
}

// Dumps real display + window measurements to window-debug.txt next to this
// file. Purely diagnostic — safe to delete this function and its call.
function writeDiagnostics() {
  try {
    const out = {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      platform: process.platform,
      displays: screen.getAllDisplays().map((d, i) => ({
        index: i,
        primary: d.id === screen.getPrimaryDisplay().id,
        scaleFactor: d.scaleFactor,
        bounds: d.bounds,
        workArea: d.workArea,
      })),
      window: {
        bounds: mainWindow.getBounds(),
        contentBounds: mainWindow.getContentBounds(),
        isMaximized: mainWindow.isMaximized(),
        isFullScreen: mainWindow.isFullScreen(),
        isResizable: mainWindow.isResizable(),
      },
    };
    require('fs').writeFileSync(
      path.join(__dirname, 'window-debug.txt'),
      JSON.stringify(out, null, 2),
      'utf8'
    );
  } catch (err) {
    console.error('diagnostics failed:', err);
  }
}

function createWindow() {
  // Size against the display's work area (screen minus taskbar), not fixed
  // numbers. A hardcoded 1280x820 overflows on scaled displays, because
  // Windows multiplies it by the scaling factor.
  const { workArea } = screen.getPrimaryDisplay();

  mainWindow = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
    minWidth: 640,
    minHeight: 400,
    title: 'MiniBrowser',
    backgroundColor: '#202124',
    autoHideMenuBar: true,

    // No OS title bar. On Windows, titleBarOverlay still paints the real
    // minimize/maximize/close buttons over the top-right of our own UI, so
    // snapping and double-click-to-maximize keep working.
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#202124',        // must match #tabstrip's background
      symbolColor: '#e8eaed',
      height: 40,              // must match #tabstrip's height
    },

    // Don't paint until the first frame is ready — avoids a white flash.
    show: false,

    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Lets index.html use <webview> tags to host real web pages.
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Keep rendering at full rate even when the window isn't focused.
      backgroundThrottling: false,
    },
  });

  attachLogging(mainWindow);

  mainWindow.once('ready-to-show', () => {
    // show() BEFORE maximize(). Maximizing a window that is still hidden is
    // unreliable on Windows — the request is often dropped.
    mainWindow.show();
    mainWindow.maximize();

    // Belt and braces: if maximize didn't actually cover the work area,
    // force the bounds. Runs after a beat so Windows has finished animating.
    setTimeout(() => {
      const wa = screen.getDisplayMatching(mainWindow.getBounds()).workArea;
      const b = mainWindow.getBounds();
      if (b.width < wa.width || b.height < wa.height || b.x !== wa.x || b.y !== wa.y) {
        mainWindow.setBounds(wa);
      }
      writeDiagnostics();
    }, 600);
  });

  // In fullscreen the native caption buttons disappear, so the tab strip
  // shouldn't keep reserving 148px for them. Tell the UI to reclaim it.
  const sendFullScreen = (on) => mainWindow.webContents.send('fullscreen', on);
  mainWindow.on('enter-full-screen', () => sendFullScreen(true));
  mainWindow.on('leave-full-screen', () => sendFullScreen(false));

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

// When a page inside a <webview> tries to open a popup / target="_blank" link,
// intercept it and hand the URL back to our UI so it opens as a new tab.
app.on('web-contents-created', (_event, contents) => {
  // F12 toggles devtools for whichever process has focus — the browser UI
  // itself, or the page inside a tab. Handy for diagnosing layout issues.
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;

    if (input.key === 'F12') {
      event.preventDefault();
      if (contents.isDevToolsOpened()) contents.closeDevTools();
      else contents.openDevTools();
    }

    // F11 works from anywhere, including with focus inside a page.
    if (input.key === 'F11' && mainWindow && !mainWindow.isDestroyed()) {
      event.preventDefault();
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
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
