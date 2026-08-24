// main.js — Electron main process.
// This owns the OS window. The actual web pages are rendered by Chromium
// inside <webview> elements that live in index.html.
//
// Everything that touches user data lives in privacy.js. This file wires it
// up, owns the window, and enforces the boundaries around the <webview>s.

const { app, BrowserWindow, shell, screen, session, ipcMain, nativeTheme, dialog } = require('electron');
const path = require('path');
const { fileURLToPath } = require('url');

const {
  createPrivacy,
  applyCommandLineSwitches,
  configureDns,
  neutralUserAgent,
} = require('./privacy');

// --- Chromium switches. Must be set before the app is ready. ---

// True only for a native Windows build. Under WSL, Electron is a LINUX app
// drawn through WSLg, so process.platform is 'linux' and every Windows-only
// window feature below is correctly skipped.
const isWindows = process.platform === 'win32';

// Animated, per-pixel scrolling instead of jumping a chunk per wheel notch.
app.commandLine.appendSwitch('enable-smooth-scrolling');

// Privacy Sandbox off, phone-home off, WebRTC leak closed, third-party cookies
// off at the Chromium layer. This is also the ONLY place --disable-features may
// be set — appending it twice replaces the list rather than merging it, so the
// Windows occlusion workaround is folded in there too. See privacy.js.
applyCommandLineSwitches(app, { isWindows });

// Run every renderer in the OS sandbox, not just the guest pages. A bug in our
// own UI code then can't reach the filesystem either.
app.enableSandbox();

// Present as the plain Chromium we are, rather than announcing
// "MiniBrowser/0.1.0 Electron/32". See the note in privacy.js on why this is
// the opposite of user-agent spoofing.
app.userAgentFallback = neutralUserAgent(app);

let mainWindow = null;

// The new tab page is the only file:// document a tab is allowed to load.
const NEWTAB_FILE = path.resolve(__dirname, 'newtab.html');

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
// A single JSON file in userData. Deliberately dependency-free: `electron-store`
// — the obvious library — is ESM-only from v11, which this CommonJS project
// can't require. See ROADMAP.md 2.5.
//
// Every strict default below is reversible from the privacy panel in the
// toolbar. That is the whole design: lock it down, but never make the user
// edit a file to get their work done.

const DEFAULT_SETTINGS = {
  searchEngine: 'searxng',
  searxngInstance: 'https://searx.be',

  // --- Protection defaults ---
  httpsOnly: true,               // upgrade http:// and only fall back on ask
  blockThirdPartyCookies: true,  // the mechanism behind cross-site tracking
  trimReferrer: true,            // cross-site referrer reduced to the origin
  sendGpc: true,                 // Sec-GPC + DNT
  stripClientHints: true,        // the high-entropy Client Hints only
  spellcheck: false,             // Chromium fetches dictionaries from Google
  clearOnExit: false,            // wipe cookies/cache/storage when quitting
  askWhereToSaveDownloads: true,
  blockDangerousDownloads: true, // warn before writing an executable to disk

  dnsMode: 'secure',             // 'secure' | 'automatic' | 'off'
  dnsServers: ['https://dns.quad9.net/dns-query'],

  // Per-host permission grants: { "maps.example.com": { geolocation: true } }
  sitePermissions: {},
};

// A hand-edited or corrupt settings file must not be able to inject state the
// rest of the app then trusts. Every key is validated on the way in — both at
// load and on every write — and anything that fails falls back to the default.
const isBool = (v) => typeof v === 'boolean';
const isString = (v) => typeof v === 'string';

const VALIDATORS = {
  searchEngine: (v) => isString(v) && ['searxng', 'marginalia', 'duckduckgo'].includes(v),
  searxngInstance: (v) => isString(v) && /^https?:\/\/[^\s/]+$/i.test(v),

  httpsOnly: isBool,
  blockThirdPartyCookies: isBool,
  trimReferrer: isBool,
  sendGpc: isBool,
  stripClientHints: isBool,
  spellcheck: isBool,
  clearOnExit: isBool,
  askWhereToSaveDownloads: isBool,
  blockDangerousDownloads: isBool,

  dnsMode: (v) => ['secure', 'automatic', 'off'].includes(v),
  dnsServers: (v) =>
    Array.isArray(v) && v.length <= 4 && v.every((s) => isString(s) && /^https:\/\//i.test(s)),

  // Shape: { host: { permission: true } }. Bounded so a runaway writer can't
  // grow the file without limit.
  sitePermissions: (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const hosts = Object.keys(v);
    if (hosts.length > 500) return false;
    return hosts.every((host) => {
      if (host.length > 253) return false;
      const grants = v[host];
      if (!grants || typeof grants !== 'object' || Array.isArray(grants)) return false;
      return Object.values(grants).every((x) => x === true);
    });
  },
};

let settings = { ...DEFAULT_SETTINGS };

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function sanitize(raw) {
  const out = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return out;
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const check = VALIDATORS[key];
    if (check && check(raw[key])) out[key] = raw[key];
  }
  return out;
}

function loadSettings() {
  try {
    settings = sanitize(JSON.parse(require('fs').readFileSync(settingsPath(), 'utf8')));
  } catch {
    // No file yet, or it's corrupt. Defaults are already in place.
  }
}

function saveSettings() {
  try {
    require('fs').writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('Could not save settings:', err.message);
  }
}

const getSettings = () => settings;

function updateSettings(patch) {
  let changed = false;
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)) continue;
    const check = VALIDATORS[key];
    if (check && !check(value)) continue;
    settings[key] = value;
    changed = true;
  }
  if (!changed) return;
  saveSettings();
  applyLiveSettings();
  send('settings-changed', settings);
}

// A few settings have to reach Chromium the moment they change, rather than
// only being read on the next request.
function applyLiveSettings() {
  for (const ses of hardenedSessions) {
    if (typeof ses.setSpellCheckerEnabled === 'function') {
      ses.setSpellCheckerEnabled(Boolean(settings.spellcheck));
    }
  }
}

// ---------------------------------------------------------------------------
// The privacy layer
// ---------------------------------------------------------------------------

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

const privacy = createPrivacy({ getSettings, updateSettings, notify: send });

const hardenedSessions = new Set();

function hardened(ses, opts) {
  if (hardenedSessions.has(ses)) return ses;
  privacy.hardenSession(ses, opts);
  hardenedSessions.add(ses);
  return ses;
}

// Private tabs get their own in-memory partition: separate cookie jar,
// separate storage, and nothing written to disk. Created eagerly so it is
// hardened before the first private tab can possibly attach to it.
const PRIVATE_PARTITION = 'in-memory-private';

// ---------------------------------------------------------------------------
// Ad and tracker blocking
// ---------------------------------------------------------------------------
// The one feature Chrome structurally cannot ship: Google earns roughly
// three-quarters of its revenue from advertising. We have no such conflict.

const blockCounts = new Map();
let flushTimer = null;

// Blocked requests arrive in bursts — dozens per page. Batch the IPC so a
// heavy ad page doesn't spam the renderer hundreds of times a second.
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    send('block-counts', [...blockCounts]);
  }, 250);
}

async function setupAdBlocker(sessions) {
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

    for (const ses of sessions) {
      blocker.enableBlockingInSession(ses);
      // enableBlockingInSession just replaced our onHeadersReceived listener
      // — Electron allows only one per event. Register ours again, chained
      // onto the blocker's, so both survive. See the header of privacy.js.
      privacy.installHeaderPipeline(ses, blocker);
    }

    blocker.on('request-blocked', (request) => {
      const id = request.tabId;
      if (typeof id !== 'number' || id < 0) return;
      blockCounts.set(id, (blockCounts.get(id) || 0) + 1);
      scheduleFlush();
    });

    return true;
  } catch (err) {
    // A missing dependency or a failed list download must not stop the
    // browser from starting — it just starts without blocking. The rest of
    // the protections are already installed and unaffected.
    console.error('Ad blocker failed to start:', err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
// Every handler checks the sender. Guest pages have no preload and so cannot
// reach these channels at all, but a bug that changed that should not also
// hand a web page the ability to rewrite settings or grant itself the camera.

function fromUI(event) {
  return Boolean(mainWindow) && !mainWindow.isDestroyed()
    && event.sender === mainWindow.webContents;
}

ipcMain.on('reset-block-count', (event, tabId) => {
  if (!fromUI(event) || typeof tabId !== 'number') return;
  blockCounts.delete(tabId);
});

ipcMain.handle('get-settings', (event) => (fromUI(event) ? settings : null));

ipcMain.on('set-setting', (event, key, value) => {
  if (!fromUI(event) || typeof key !== 'string') return;
  updateSettings({ [key]: value });
});

// Grant or revoke one permission for one host. The renderer can only ever ask
// for a change; the validation of what a permission *is* stays in privacy.js.
ipcMain.on('set-permission', (event, host, permission, allowed) => {
  if (!fromUI(event)) return;
  if (typeof host !== 'string' || typeof permission !== 'string') return;
  privacy.setGrant(host, permission, allowed === true);
});

// "Continue to the insecure version of this site." Session-scoped on purpose:
// see privacy.js.
ipcMain.on('allow-insecure', (event, host) => {
  if (!fromUI(event) || typeof host !== 'string') return;
  privacy.allowInsecure(host);
});

ipcMain.handle('clear-browsing-data', async (event) => {
  if (!fromUI(event)) return false;
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Cancel', 'Clear everything'],
    defaultId: 0,
    cancelId: 0,
    title: 'Clear browsing data',
    message: 'Clear all cookies, cache and site storage?',
    detail: 'You will be signed out of every site. This cannot be undone.',
  });
  if (response !== 1) return false;

  const results = await Promise.all(
    [...hardenedSessions].map((ses) => privacy.clearBrowsingData(ses)),
  );
  return results.every(Boolean);
});

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

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
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false,
      // Keep rendering at full rate even when the window isn't focused.
      backgroundThrottling: false,
    },
  });

  // Our own UI is a local document and must never navigate anywhere. If a bug
  // ever let a URL through to it, the browser chrome would be replaced by a
  // remote page that has our preload bridge attached.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

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
  const sendFullScreen = (on) => send('fullscreen', on);
  mainWindow.on('enter-full-screen', () => sendFullScreen(true));
  mainWindow.on('leave-full-screen', () => sendFullScreen(false));

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------
// A <webview> is a separate renderer process. Its key events never reach the
// window listener in renderer.js, which is why shortcuts used to die the
// moment you clicked into a page. `before-input-event` fires in the main
// process for whichever webContents has focus, so it sees them all.
//
// Actions that need to type into our UI are listed in FOCUS_UI: for those the
// main window has to be given focus first, or the keystroke lands in a page
// that is no longer in front.

const FOCUS_UI = new Set(['new-tab', 'new-private-tab', 'focus-omnibox']);

function matchShortcut(input) {
  const ctrl = input.control || input.meta;
  const key = (input.key || '').toLowerCase();

  if (ctrl && !input.alt) {
    if (key === 't') return { action: input.shift ? 'reopen-tab' : 'new-tab' };
    if (key === 'n' && input.shift) return { action: 'new-private-tab' };
    if (key === 'w') return { action: 'close-tab' };
    if (key === 'l') return { action: 'focus-omnibox' };
    if (key === 'r') return { action: input.shift ? 'hard-reload' : 'reload' };
    if (key === 'tab') return { action: 'cycle-tab', step: input.shift ? -1 : 1 };
    if (key === 'delete' && input.shift) return { action: 'clear-data' };
  }

  if (input.alt && !ctrl) {
    if (key === 'arrowleft') return { action: 'back' };
    if (key === 'arrowright') return { action: 'forward' };
  }

  return null;
}

// ---------------------------------------------------------------------------
// The <webview> boundary
// ---------------------------------------------------------------------------
// Everything below is about the line between our code and a web page. A page
// is hostile until proven otherwise.

// Schemes a tab may navigate to. Everything else is either handed to the OS
// (mailto:, tel:) or refused outright — `javascript:` and top-level `data:`
// URLs are classic phishing vectors, and `file:` would let a page walk the
// disk.
const ALLOWED_SCHEMES = new Set(['https:', 'http:', 'about:', 'blob:']);

function isNewTabPage(url) {
  if (!url.startsWith('file://')) return false;
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    return path.resolve(fileURLToPath(u)).toLowerCase() === NEWTAB_FILE.toLowerCase();
  } catch {
    return false;
  }
}

function schemeAllowed(url) {
  if (isNewTabPage(url)) return true;
  try {
    return ALLOWED_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

// Errors that mean "there is nothing listening on HTTPS here", as opposed to
// "the network is down" or "that domain doesn't exist". Only these should
// offer the user a fallback to plain http.
const NO_HTTPS_ERRORS = new Set([
  -100, // ERR_CONNECTION_CLOSED
  -101, // ERR_CONNECTION_RESET
  -102, // ERR_CONNECTION_REFUSED
  -107, // ERR_SSL_PROTOCOL_ERROR
  -118, // ERR_CONNECTION_TIMED_OUT
  -200, // ERR_CERT_COMMON_NAME_INVALID
  -201, // ERR_CERT_DATE_INVALID
  -202, // ERR_CERT_AUTHORITY_INVALID
]);

// Never silently accept a bad certificate — an invalid cert on a page you
// typed is the exact shape of an interception attempt.
app.on('certificate-error', (event, _contents, url, error, _cert, callback) => {
  event.preventDefault();
  console.warn('[privacy] rejected certificate for', url, '-', error);
  callback(false);
});

// A guest page may not choose its own webPreferences. Electron takes these
// from the <webview> tag's attributes, which means a bug that let a page
// write into our DOM could otherwise ask for Node integration and own the
// machine. Overwrite them here, where the page cannot reach.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInWorker = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
    webPreferences.experimentalFeatures = false;
    webPreferences.enableBlinkFeatures = '';

    // A partition attribute decides which cookie jar the tab gets. Only the
    // two we create are acceptable; anything else would be a jar nothing has
    // hardened.
    if (params.partition && params.partition !== `persist:${PRIVATE_PARTITION}`) {
      delete params.partition;
    }
    if (params.src && !schemeAllowed(params.src)) {
      event.preventDefault();
    }
  });

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

    // Only rescue shortcuts for pages. When our own UI has focus its window
    // listener already handles them, and forwarding from both would run every
    // shortcut twice — opening two tabs, closing two tabs.
    if (contents.getType() !== 'webview') return;
    if (!mainWindow || mainWindow.isDestroyed()) return;

    const hit = matchShortcut(input);
    if (!hit) return;

    // Stop the page from also acting on it — otherwise Ctrl+R would reload
    // the guest underneath us and Ctrl+W could be swallowed by a web app.
    event.preventDefault();

    if (FOCUS_UI.has(hit.action)) mainWindow.webContents.focus();
    send('shortcut', hit);
  });

  if (contents.getType() !== 'webview') return;

  // Close the WebRTC local-address leak for this guest. The command-line
  // switch covers the process; this covers the individual renderer, which is
  // what actually gathers ICE candidates.
  try {
    contents.setWebRTCIPHandlingPolicy('default_public_interface_only');
  } catch { /* older Electron — the switch above still applies */ }

  // A closed tab's block count would otherwise leak for the life of the app.
  contents.on('destroyed', () => blockCounts.delete(contents.id));

  // --- Navigation guard: scheme allowlist plus the HTTPS upgrade. ---
  const guard = (event, url) => {
    if (!schemeAllowed(url)) {
      event.preventDefault();
      console.warn('[privacy] blocked navigation to', url.slice(0, 120));
      return;
    }

    const upgraded = privacy.upgradeUrl(url);
    if (!upgraded) return;

    event.preventDefault();
    privacy.noteUpgrade(contents.id, url);
    contents.loadURL(upgraded).catch(() => {});
  };

  contents.on('will-navigate', guard);
  contents.on('will-redirect', guard);

  // If the upgrade was the thing that failed, offer the choice rather than
  // leaving the user staring at an error page with no explanation.
  contents.on('did-fail-load', (_e, errorCode, _desc, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    const original = privacy.takeUpgrade(contents.id);
    if (!original) return;
    if (!NO_HTTPS_ERRORS.has(errorCode)) return;

    send('https-upgrade-failed', {
      tabId: contents.id,
      url: original,
      host: privacy.hostOf(original),
      attempted: validatedURL,
    });
  });

  contents.on('did-navigate', () => privacy.takeUpgrade(contents.id));

  // When a page inside a <webview> tries to open a popup / target="_blank"
  // link, intercept it and hand the URL back to our UI so it opens as a tab.
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      send('open-new-tab', url);
    } else if (/^(mailto|tel|sms):/i.test(url)) {
      // Non-web schemes go to the OS default handler. The allowlist matters:
      // handing an arbitrary scheme to the shell is how a page gets to launch
      // a local program.
      shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  // The browser chrome is light, so pages should be too. This is what sites
  // see through `prefers-color-scheme`, so one offering both variants picks
  // its light one instead of clashing with the frame around it. Set this to
  // 'system' to follow the OS instead. (nativeTheme is unusable before ready.)
  nativeTheme.themeSource = 'light';

  loadSettings();

  // Encrypted DNS, so the list of every site you visit isn't legible to the
  // network even when the pages themselves are HTTPS.
  configureDns(app, settings);

  // Harden both sessions BEFORE any window exists, so there is no window in
  // which a page could load against an unprotected session. The blocker
  // attaches afterwards and re-chains the header pipeline itself.
  const defaultSession = hardened(session.defaultSession, { isPrivate: false });
  const privateSession = hardened(
    session.fromPartition(`persist:${PRIVATE_PARTITION}`),
    { isPrivate: true },
  );

  // Not fatal, and not awaited — the window should not wait on a 2 MB filter
  // list download the first time the app runs.
  setupAdBlocker([defaultSession, privateSession]);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// The private partition is `persist:` so that a private tab survives a reload,
// but it must not survive the app. Wipe it on the way out, along with
// everything else if clear-on-exit is on.
let cleanupDone = false;
app.on('before-quit', (event) => {
  if (cleanupDone) return;
  event.preventDefault();

  const targets = [session.fromPartition(`persist:${PRIVATE_PARTITION}`)];
  if (settings.clearOnExit) targets.push(session.defaultSession);

  Promise.all(targets.map((ses) => privacy.clearBrowsingData(ses)))
    .catch(() => {})
    .finally(() => {
      cleanupDone = true;
      app.quit();
    });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
