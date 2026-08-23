// main.js — Electron main process.
// This owns the OS window. The actual web pages are rendered by Chromium
// inside <webview> elements that live in index.html.

const { app, BrowserWindow, shell, screen, session, ipcMain, nativeTheme } = require('electron');
const path = require('path');

// --- Chromium switches. Must be set before the app is ready. ---

// True only for a native Windows build. Under WSL, Electron is a LINUX app
// drawn through WSLg, so process.platform is 'linux' and every Windows-only
// window feature below is correctly skipped.
const isWindows = process.platform === 'win32';

// Animated, per-pixel scrolling instead of jumping a chunk per wheel notch.
app.commandLine.appendSwitch('enable-smooth-scrolling');

if (isWindows) {
  // Windows periodically checks whether the window is covered by another
  // window so it can throttle painting. That check stutters badly while a
  // frameless window is dragged. Disabling it is the standard fix.
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}

let mainWindow = null;

// ---------------------------------------------------------------------------
// Ad and tracker blocking
// ---------------------------------------------------------------------------
// The one feature Chrome structurally cannot ship: Google earns roughly
// three-quarters of its revenue from advertising. We have no such conflict.
//
// @ghostery/adblocker-electron parses real EasyList + EasyPrivacy filter
// lists, the same rules uBlock Origin uses, and installs itself onto the
// session's request pipeline.

// tabId (a webContents id) -> number of requests blocked since that tab last
// navigated. Displayed in the toolbar as visible proof the blocker is working.
const blockCounts = new Map();
let flushTimer = null;

// Blocked requests arrive in bursts — dozens per page. Batch the IPC so a
// heavy ad page doesn't spam the renderer hundreds of times a second.
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('block-counts', [...blockCounts]);
    }
  }, 250);
}

async function setupAdBlocker() {
  try {
    const { ElectronBlocker } = require('@ghostery/adblocker-electron');
    const fs = require('fs/promises');

    // Cache the compiled engine in userData. Without this, ~2 MB of filter
    // lists is re-downloaded on every launch; with it, startup is instant
    // after the first run and the browser works offline.
    const cachePath = path.join(app.getPath('userData'), 'adblocker-engine.bin');

    // Electron 32 runs Node 20, which has fetch globally — the package README
    // imports 'cross-fetch' only for older runtimes.
    const blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
      path: cachePath,
      read: fs.readFile,
      write: fs.writeFile,
    });
    blocker.enableBlockingInSession(session.defaultSession);

    blocker.on('request-blocked', (request) => {
      const id = request.tabId;
      if (typeof id !== 'number' || id < 0) return;
      blockCounts.set(id, (blockCounts.get(id) || 0) + 1);
      scheduleFlush();
    });

    return true;
  } catch (err) {
    // A missing dependency or a failed list download must not stop the
    // browser from starting — it just starts without blocking.
    console.error('Ad blocker failed to start:', err.message);
    return false;
  }
}

// The renderer resets a tab's counter when that tab navigates.
ipcMain.on('reset-block-count', (_event, tabId) => {
  blockCounts.delete(tabId);
});

// IMPORTANT: do not add your own session.defaultSession.webRequest
// .onBeforeRequest listener. Electron allows exactly ONE listener per
// webRequest event per session, and registering a second one silently
// replaces the blocker's. That is why tracking-parameter stripping lives in
// renderer.js instead of here.

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
    backgroundColor: '#f7f7f7',  // matches body — prevents a flash on open
    autoHideMenuBar: true,

    // Hiding the title bar is only safe on Windows, where titleBarOverlay
    // repaints the real minimize/maximize/close buttons over our own UI.
    // Elsewhere (Linux, WSL) that API does nothing, and hiding the bar would
    // leave a window with no way to close it — so keep the native frame.
    ...(isWindows ? {
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#e6e6e6',        // must match #tabstrip's background
        symbolColor: '#111111',  // must match --text
        height: 40,              // must match #tabstrip's height
      },
    } : {}),

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

  // A closed tab's block count would otherwise leak for the life of the app.
  contents.on('destroyed', () => blockCounts.delete(contents.id));

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
  // The browser chrome is light, so pages should be too. This is what sites
  // see through `prefers-color-scheme`, so one offering both variants picks
  // its light one instead of clashing with the frame around it. Set this to
  // 'system' to follow the OS instead. (nativeTheme is unusable before ready.)
  nativeTheme.themeSource = 'light';

  // Start the blocker before the window loads, so the very first page is
  // already covered. Failure here is logged, not fatal.
  setupAdBlocker();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
