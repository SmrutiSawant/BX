// renderer.js — all the browser logic.
//
// Mental model: each tab is a plain object holding two DOM nodes —
//   .view  a <webview>, which is a full Chromium renderer showing a real page
//   .el    the little tab button up in the tab strip
// Everything else is bookkeeping to keep those two in sync with the toolbar.

// The new tab page ships with the app. Resolved relative to index.html so it
// works no matter where the folder lives on disk.
const NEWTAB = new URL('newtab.html', location.href).href;
const HOME = NEWTAB;
const SEARCH = (q) => 'https://www.google.com/search?q=' + encodeURIComponent(q);

const tabsEl   = document.getElementById('tabs');
const viewsEl  = document.getElementById('views');
const urlInput = document.getElementById('url');
const lockIcon = document.getElementById('lock');

const backBtn    = document.getElementById('back');
const forwardBtn = document.getElementById('forward');
const reloadBtn  = document.getElementById('reload');
const homeBtn    = document.getElementById('home');
const newTabBtn  = document.getElementById('newtab');

/** @type {Array<{id:number, view:Element, wrap:Element, el:Element, titleEl:Element, iconEl:Element, url:string, title:string}>} */
let tabs = [];
let activeId = null;
let nextId = 1;
let urlEdited = false; // don't stomp on what the user is typing

// ---------------------------------------------------------------------------
// Omnibox: decide whether input is a URL or a search query
// ---------------------------------------------------------------------------

function normalizeUrl(raw) {
  const s = raw.trim();
  if (!s) return null;

  // localhost / bare IP, with optional port. Checked BEFORE the scheme rule,
  // because "localhost:3000" otherwise reads as the scheme "localhost:".
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#]|$)/i.test(s)) {
    return 'http://' + s;
  }

  // Already has a scheme: about:blank, file:///, https://...
  // The (?!\d) stops "foo:1234" from being mistaken for one.
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s)) return s;

  // Looks like a bare domain: example.com, www.foo.co.uk/bar
  // (a space anywhere before the first slash means it's a search)
  if (/^[^\s/?#]+\.[a-z]{2,}([/?#]|$)/i.test(s)) return 'https://' + s;

  return SEARCH(s);
}

// The address bar stays empty on the new tab page, the way Chrome's does.
function prettyUrl(url) {
  if (!url || url === 'about:blank' || url.startsWith(NEWTAB)) return '';
  return url;
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function getTab(id) {
  return tabs.find((t) => t.id === id) || null;
}

function activeTab() {
  return getTab(activeId);
}

function createTab(url = HOME, { activate = true } = {}) {
  const id = nextId++;

  // --- the page itself ---
  const view = document.createElement('webview');
  view.setAttribute('src', url);
  view.setAttribute('allowpopups', '');
  // All tabs share one session partition, so logins carry across tabs —
  // which is what people expect from a browser.

  // The wrapper is what gets shown/hidden. Toggling display on the <webview>
  // itself breaks Electron's internal sizing — see the CSS note in index.html.
  const wrap = document.createElement('div');
  wrap.className = 'view-wrap';
  wrap.appendChild(view);
  viewsEl.appendChild(wrap);

  // --- the tab button ---
  const el = document.createElement('div');
  el.className = 'tab';

  const spinner = document.createElement('div');
  spinner.className = 'spinner';

  const iconEl = document.createElement('img');
  iconEl.className = 'favicon blank';
  iconEl.addEventListener('error', () => iconEl.classList.add('blank'));

  const titleEl = document.createElement('span');
  titleEl.className = 'tab-title';
  titleEl.textContent = 'New tab';

  const closeEl = document.createElement('button');
  closeEl.className = 'tab-close';
  closeEl.textContent = '×';
  closeEl.title = 'Close tab (Ctrl+W)';

  el.append(spinner, iconEl, titleEl, closeEl);
  tabsEl.appendChild(el);

  const tab = { id, view, wrap, el, titleEl, iconEl, url, title: 'New tab' };
  tabs.push(tab);

  // --- wiring ---
  el.addEventListener('mousedown', (e) => {
    if (e.button === 1) { e.preventDefault(); closeTab(id); }  // middle-click closes
    else if (e.button === 0) activateTab(id);
  });
  closeEl.addEventListener('click', (e) => { e.stopPropagation(); closeTab(id); });

  view.addEventListener('page-title-updated', (e) => {
    tab.title = e.title;
    titleEl.textContent = e.title;
    el.title = e.title;
  });

  view.addEventListener('page-favicon-updated', (e) => {
    const icon = e.favicons && e.favicons[0];
    if (icon) { iconEl.src = icon; iconEl.classList.remove('blank'); }
  });

  view.addEventListener('did-start-loading', () => {
    el.classList.add('loading');
    if (id === activeId) syncToolbar();
  });

  view.addEventListener('did-stop-loading', () => {
    el.classList.remove('loading');
    if (id === activeId) syncToolbar();
  });

  const onNavigate = (e) => {
    if (e.url) tab.url = e.url;
    if (id === activeId) { urlEdited = false; syncToolbar(); }
  };
  view.addEventListener('did-navigate', onNavigate);
  view.addEventListener('did-navigate-in-page', (e) => { if (e.isMainFrame) onNavigate(e); });

  view.addEventListener('did-fail-load', (e) => {
    // -3 is ERR_ABORTED, which fires on ordinary redirects/cancels. Ignore it.
    if (e.errorCode === -3 || !e.isMainFrame) return;
    tab.title = 'Failed to load';
    titleEl.textContent = tab.title;
  });

  if (activate) activateTab(id);
  return tab;
}

function activateTab(id) {
  const tab = getTab(id);
  if (!tab) return;

  activeId = id;
  urlEdited = false;

  for (const t of tabs) {
    const on = t.id === id;
    t.el.classList.toggle('active', on);
    t.wrap.classList.toggle('active', on);
  }
  syncToolbar();
}

function closeTab(id) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;

  const [tab] = tabs.splice(idx, 1);
  tab.el.remove();
  tab.wrap.remove();

  if (tabs.length === 0) {
    createTab(HOME);            // never leave the window empty
    return;
  }
  if (activeId === id) {
    activateTab(tabs[Math.min(idx, tabs.length - 1)].id);
  }
}

// ---------------------------------------------------------------------------
// Toolbar state
// ---------------------------------------------------------------------------

function syncToolbar() {
  const tab = activeTab();
  if (!tab) return;

  const view = tab.view;
  let loading = false, canBack = false, canFwd = false;

  // These throw if the webview's guest page hasn't attached yet.
  try {
    loading = view.isLoading();
    canBack = view.canGoBack();
    canFwd  = view.canGoForward();
  } catch { /* guest not ready yet — defaults are fine */ }

  backBtn.disabled = !canBack;
  forwardBtn.disabled = !canFwd;
  reloadBtn.title = loading ? 'Stop (Esc)' : 'Reload (Ctrl+R)';

  if (!urlEdited && document.activeElement !== urlInput) {
    urlInput.value = prettyUrl(tab.url);
  }
  lockIcon.classList.toggle('insecure', !/^https:/i.test(tab.url));
}

function navigate(input) {
  const url = normalizeUrl(input);
  if (!url) return;
  const tab = activeTab();
  if (!tab) return;

  tab.url = url;
  try { tab.view.loadURL(url); } catch { tab.view.setAttribute('src', url); }
  urlEdited = false;
  tab.view.focus();
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

backBtn.addEventListener('click', () => { try { activeTab().view.goBack(); } catch {} });
forwardBtn.addEventListener('click', () => { try { activeTab().view.goForward(); } catch {} });
homeBtn.addEventListener('click', () => navigate(HOME));
newTabBtn.addEventListener('click', () => { createTab(HOME); urlInput.focus(); });

reloadBtn.addEventListener('click', () => {
  const view = activeTab().view;
  try { view.isLoading() ? view.stop() : view.reload(); } catch {}
});

urlInput.addEventListener('input', () => { urlEdited = true; });
urlInput.addEventListener('focus', () => urlInput.select());

urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); navigate(urlInput.value); }
  if (e.key === 'Escape') { urlEdited = false; syncToolbar(); urlInput.blur(); }
});

// Keyboard shortcuts. Note: these only fire while our UI has focus, not while
// focus is inside a page — a known limitation of the <webview> approach.
window.addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey;

  if (ctrl && e.key.toLowerCase() === 't') { e.preventDefault(); createTab(HOME); urlInput.focus(); }
  else if (ctrl && e.key.toLowerCase() === 'w') { e.preventDefault(); if (activeId !== null) closeTab(activeId); }
  else if (ctrl && e.key.toLowerCase() === 'l') { e.preventDefault(); urlInput.focus(); }
  else if (ctrl && e.key.toLowerCase() === 'r') { e.preventDefault(); try { activeTab().view.reload(); } catch {} }
  else if (ctrl && e.key === 'Tab') {
    e.preventDefault();
    const i = tabs.findIndex((t) => t.id === activeId);
    const step = e.shiftKey ? -1 : 1;
    activateTab(tabs[(i + step + tabs.length) % tabs.length].id);
  }
  else if (e.altKey && e.key === 'ArrowLeft')  { e.preventDefault(); try { activeTab().view.goBack(); } catch {} }
  else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); try { activeTab().view.goForward(); } catch {} }
});

// target="_blank" links, handed over from the main process.
if (window.browserAPI) {
  window.browserAPI.onOpenNewTab((url) => createTab(url));
  window.browserAPI.onFullScreen((on) => {
    document.body.classList.toggle('fullscreen', on);
  });
}

// canGoBack()/canGoForward() have no change event, so poll them. Cheap.
setInterval(syncToolbar, 400);

createTab(HOME);
urlInput.focus();

// --- Temporary diagnostics. Delete this block once the UI is confirmed
// --- working, along with the logging block in main.js.
window.addEventListener('error', (e) => {
  console.log('ERROR ' + e.message + ' @ ' + e.filename + ':' + e.lineno);
});

// Capture phase, so this fires even if something is swallowing the event
// before it reaches the button's own handler.
window.addEventListener('pointerdown', (e) => {
  const t = e.target;
  const name = t.id ? '#' + t.id
    : t.className ? '.' + String(t.className).split(' ')[0]
    : t.tagName;
  console.log('pointerdown -> ' + name + ' @ ' + e.clientX + ',' + e.clientY);
}, true);

// Confirm each toolbar handler actually runs.
for (const [name, el] of Object.entries({ back: backBtn, forward: forwardBtn,
                                          reload: reloadBtn, home: homeBtn,
                                          newtab: newTabBtn })) {
  el.addEventListener('click', () => console.log('HANDLER FIRED: ' + name));
}

console.log('ui ready | window ' + window.innerWidth + 'x' + window.innerHeight
  + ' | toolbar visible: ' + (document.getElementById('toolbar').offsetHeight > 0)
  + ' | tabstrip visible: ' + (document.getElementById('tabstrip').offsetHeight > 0));
