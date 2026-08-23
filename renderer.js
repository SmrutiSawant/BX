// renderer.js — all the browser logic.
//
// Mental model: each tab is a plain object holding two DOM nodes —
//   .view  a <webview>, which is a full Chromium renderer showing a real page
//   .el    the little tab button up in the tab strip
// Everything else is bookkeeping to keep those two in sync with the toolbar.

// The new tab page ships with the app. Resolved relative to index.html so it
// works no matter where the folder lives on disk.
const NEWTAB = new URL('newtab.html', location.href).href;

// The preload bridge. Guarded so the UI still runs if it's ever missing.
const API = window.browserAPI || {};

// ---------------------------------------------------------------------------
// Search engines
// ---------------------------------------------------------------------------
// Two of the three are open source, which is a stronger guarantee than a
// privacy policy: you can read what the thing does, and run it yourself.
//
// SearXNG is a metasearch engine (AGPL) — it forwards your query to other
// engines and merges the results, so no single upstream sees a profile of you.
//
// The catch is instances. SearXNG has no index of its own; it scrapes Google,
// Bing and friends, who aggressively block datacenter IPs. A popular public
// instance gets hammered by bots until every upstream blocks it, and then it
// answers every query with "No results were found" — the instance is up, it
// just has nothing to relay. That is a property of public instances, not a bug
// here, and it is why this is editable from the toolbar rather than hardcoded.
//
// Counter-intuitively, an instance that makes you pass a browser check is
// usually the better bet: the check is what keeps its upstream quota alive,
// and a real browser clears it in a second or two. An instance that lets
// anything straight through is often one whose upstreams have already given up
// on it.
//
// The real fix is self-hosting — your own IP, your own quota. See ROADMAP.md.
const SEARXNG_INSTANCES = [
  'https://searx.be',            // longest-running; browser check
  'https://baresearch.org',      // browser check (Anubis)
  'https://priv.au',
  'https://opnxng.com',
  'https://search.inetol.net',
];

let searxngInstance = SEARXNG_INSTANCES[0];

const SEARCH_ENGINES = [
  {
    id: 'searxng',
    name: 'SearXNG',
    note: 'Open source · merges ~270 engines',
    search: (q) => searxngInstance + '/search?q=' + encodeURIComponent(q),
  },
  {
    id: 'marginalia',
    name: 'Marginalia',
    // Its own crawler and index — not a front end for anyone else's. Tuned
    // for text-heavy non-commercial pages, so it's superb for finding real
    // writing and useless for weather or opening hours. URL format is from
    // its OpenSearch descriptor; note the param is `query`, not `q`.
    note: 'Open source · indie, text-heavy web',
    search: (q) => 'https://marginalia-search.com/search?query=' + encodeURIComponent(q),
  },
  {
    id: 'duckduckgo',
    name: 'DuckDuckGo',
    // Not open source, but reliable and doesn't profile you — the fallback
    // when an instance is having a bad day.
    note: 'Proprietary · general purpose',
    search: (q) => 'https://duckduckgo.com/?q=' + encodeURIComponent(q),
  },
];

let engineId = SEARCH_ENGINES[0].id;

const engineOf = (id) => SEARCH_ENGINES.find((e) => e.id === id) || SEARCH_ENGINES[0];
const SEARCH = (q) => engineOf(engineId).search(q);

// The new tab page is a separate document with no preload of its own, so the
// chosen engine — and the instance, which it can't otherwise know — ride along
// in the query string. Keep the table in newtab.html in sync with
// SEARCH_ENGINES above.
const homeUrl = () =>
  NEWTAB + '?engine=' + encodeURIComponent(engineId)
         + '&instance=' + encodeURIComponent(searxngInstance);

// Accepts what someone would actually paste: "searx.be", "https://searx.be/",
// "https://searx.be/search", or "http://localhost:8888" for a self-hosted one
// — that last case is the whole point, so it must not be rejected.
// Returns null if it can't be made into an origin.
function normalizeInstance(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;

    // A hostname with no dot is only meaningful on the local machine.
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') return null;

    return u.origin;   // drops any path, query and trailing slash
  } catch {
    return null;
  }
}

const tabsEl   = document.getElementById('tabs');
const viewsEl  = document.getElementById('views');
const urlInput = document.getElementById('url');
const lockIcon = document.getElementById('lock');
const shieldEl = document.getElementById('shield');
const blockEl  = document.getElementById('blockcount');

const engineBtn  = document.getElementById('engine');
const engineName = document.getElementById('enginename');
const engineMenu = document.getElementById('enginemenu');

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
// Tracking-parameter stripping
// ---------------------------------------------------------------------------
// None of these change what page you get — they exist only to tell the sender
// who clicked. Firefox strips them; Chrome does not.
//
// Why here and not in main.js: the obvious place would be a webRequest
// .onBeforeRequest redirect, but Electron allows only ONE listener per
// webRequest event per session, and the ad blocker already owns it.
// Registering a second listener would silently disable blocking. So we clean
// URLs at the points where WE start a navigation instead.

const TRACKING_PARAMS = [
  /^utm_/i,            // Google Analytics, near-universal
  /^ga_/i,
  /^fbclid$/i, /^igshid$/i,                 // Meta
  /^gclid$/i, /^dclid$/i, /^gbraid$/i, /^wbraid$/i, /^gclsrc$/i,  // Google Ads
  /^msclkid$/i,                             // Microsoft
  /^twclid$/i, /^ref_src$/i, /^ref_url$/i,  // X/Twitter
  /^ttclid$/i,                              // TikTok
  /^li_fat_id$/i,                           // LinkedIn
  /^yclid$/i,                               // Yandex
  /^epik$/i,                                // Pinterest
  /^mc_eid$/i, /^mc_cid$/i,                 // Mailchimp
  /^_hsenc$/i, /^_hsmi$/i, /^hsCtaTracking$/i,  // HubSpot
  /^mkt_tok$/i,                             // Marketo
  /^vero_id$/i, /^vero_conv$/i,             // Vero
  /^oly_enc_id$/i, /^oly_anon_id$/i,        // Omeda
  /^s_kwcid$/i, /^ef_id$/i,                 // Adobe
  /^icid$/i, /^ncid$/i,
];

function stripTracking(url) {
  try {
    const u = new URL(url);
    // Only touch web URLs — never file:// (the new tab page) or about:.
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return url;

    let changed = false;
    // Snapshot the keys first; deleting while iterating skips entries.
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.some((re) => re.test(key))) {
        u.searchParams.delete(key);
        changed = true;
      }
    }
    if (!changed) return url;

    // Drop a now-empty '?' so the address bar stays clean.
    return u.searchParams.toString() ? u.href : u.href.replace(/\?$/, '');
  } catch {
    return url;  // not parseable — leave it alone
  }
}

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
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s)) return stripTracking(s);

  // Looks like a bare domain: example.com, www.foo.co.uk/bar
  // (a space anywhere before the first slash means it's a search)
  if (/^[^\s/?#]+\.[a-z]{2,}([/?#]|$)/i.test(s)) return stripTracking('https://' + s);

  return SEARCH(s);
}

// The address bar stays empty on the new tab page, the way Chrome's does.
function prettyUrl(url) {
  if (!url || url === 'about:blank' || url.startsWith(NEWTAB)) return '';
  return url;
}

// ---------------------------------------------------------------------------
// Ad blocker counter
// ---------------------------------------------------------------------------
// Main sends counts keyed by webContents id; each <webview> reports its own
// via getWebContentsId(), which is how we line them up.

let blockCounts = new Map();

function webContentsIdOf(tab) {
  try { return tab.view.getWebContentsId(); } catch { return null; }
}

function syncShield() {
  const tab = activeTab();
  const wcId = tab ? webContentsIdOf(tab) : null;
  const n = wcId === null ? 0 : (blockCounts.get(wcId) || 0);
  blockEl.textContent = String(n);
  shieldEl.classList.toggle('on', n > 0);
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

function createTab(url = homeUrl(), { activate = true } = {}) {
  const id = nextId++;
  url = stripTracking(url);

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

  view.addEventListener('did-navigate', (e) => {
    // New page, fresh count. Clear both sides so the toolbar doesn't briefly
    // show the previous page's total.
    const wcId = webContentsIdOf(tab);
    if (wcId !== null) {
      blockCounts.delete(wcId);
      if (API.resetBlockCount) API.resetBlockCount(wcId);
    }
    onNavigate(e);
  });

  // In-page navigation (SPA route changes) keeps the same document, so the
  // block count stays.
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
    createTab(homeUrl());            // never leave the window empty
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

  // The padlock becomes a warning triangle on plain http. Shape, not colour —
  // the palette is monochrome and shape is colourblind-safe anyway.
  const insecure = !/^https:/i.test(tab.url) && !tab.url.startsWith(NEWTAB);
  lockIcon.classList.toggle('insecure', insecure);
  lockIcon.setAttribute('title', insecure ? 'Not secure — this connection is unencrypted' : 'Secure connection');

  syncShield();
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
homeBtn.addEventListener('click', () => navigate(homeUrl()));
newTabBtn.addEventListener('click', () => { createTab(homeUrl()); urlInput.focus(); });

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

  if (ctrl && e.key.toLowerCase() === 't') { e.preventDefault(); createTab(homeUrl()); urlInput.focus(); }
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

// ---------------------------------------------------------------------------
// Search engine picker
// ---------------------------------------------------------------------------

function renderEngineMenu() {
  engineMenu.textContent = '';

  for (const e of SEARCH_ENGINES) {
    const opt = document.createElement('button');
    opt.className = 'engine-opt' + (e.id === engineId ? ' active' : '');

    // SVG elements need createElementNS and setAttribute — their className is
    // an SVGAnimatedString, not a plain string.
    const tick = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    tick.setAttribute('viewBox', '0 0 24 24');
    tick.setAttribute('class', 'tick');
    const tickPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    tickPath.setAttribute('d', 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z');
    tick.appendChild(tickPath);

    const label = document.createElement('span');
    label.className = 'label';
    const name = document.createElement('b');
    name.textContent = e.name;
    const note = document.createElement('small');
    note.textContent = e.note;
    label.append(name, note);

    opt.append(tick, label);
    opt.addEventListener('click', () => { setEngine(e.id); closeEngineMenu(); });
    engineMenu.appendChild(opt);

    // The instance editor belongs to SearXNG and only makes sense when it's
    // the engine in use, so it hangs off that row rather than sitting in a
    // separate settings screen.
    if (e.id === 'searxng' && engineId === 'searxng') {
      engineMenu.appendChild(buildInstanceEditor());
    }
  }
}

function buildInstanceEditor() {
  const box = document.createElement('div');
  box.className = 'instance';

  const field = document.createElement('input');
  field.type = 'text';
  field.spellcheck = false;
  field.value = searxngInstance;
  field.setAttribute('aria-label', 'SearXNG instance');

  const commit = () => {
    if (setInstance(field.value)) field.value = searxngInstance;
    else field.value = searxngInstance;   // rejected — show what's still in use
  };
  field.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); commit(); field.blur(); }
    if (ev.key === 'Escape') { field.value = searxngInstance; field.blur(); }
  });
  field.addEventListener('blur', commit);

  const chips = document.createElement('div');
  chips.className = 'chips';
  for (const url of SEARXNG_INSTANCES) {
    const chip = document.createElement('button');
    chip.className = 'chip' + (url === searxngInstance ? ' active' : '');
    chip.textContent = url.replace(/^https?:\/\//, '');
    chip.addEventListener('click', () => {
      setInstance(url);
      renderEngineMenu();
    });
    chips.appendChild(chip);
  }

  const hint = document.createElement('small');
  hint.textContent = 'No results on every query? The instance is up but its '
    + 'upstreams have blocked it. Try another.';

  box.append(field, chips, hint);
  return box;
}

// Re-point any open new tab page, whose search form was built from the old
// engine or instance and is now stale.
function refreshNewTabPages() {
  const url = homeUrl();
  for (const t of tabs) {
    if (!t.url.startsWith(NEWTAB)) continue;
    t.url = url;
    try { t.view.loadURL(url); } catch { /* guest not ready; it'll be right next time */ }
  }
}

function setEngine(id) {
  engineId = engineOf(id).id;
  const engine = engineOf(engineId);

  engineName.textContent = engine.name;
  urlInput.placeholder = 'Search ' + engine.name + ' or type a URL';
  if (API.setSetting) API.setSetting('searchEngine', engineId);

  renderEngineMenu();
  refreshNewTabPages();
}

function setInstance(raw) {
  const origin = normalizeInstance(raw);
  if (!origin || origin === searxngInstance) return Boolean(origin);

  searxngInstance = origin;
  if (API.setSetting) API.setSetting('searxngInstance', origin);
  refreshNewTabPages();
  return true;
}

function closeEngineMenu() { engineMenu.classList.remove('open'); }

engineBtn.addEventListener('click', (e) => {
  e.stopPropagation();          // don't let the window handler close it again
  engineMenu.classList.toggle('open');
});

// Clicks inside the menu keep it open — otherwise typing in the instance field
// would dismiss it on the first keystroke. Choosing an engine closes it
// explicitly, in that option's own handler.
engineMenu.addEventListener('click', (e) => e.stopPropagation());

// Any click elsewhere, or Escape, dismisses it.
window.addEventListener('click', closeEngineMenu);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeEngineMenu(); });

// --- Bridges from the main process ---
if (API.hasTitleBarOverlay) {
  document.body.classList.add('has-overlay');
}
if (API.onOpenNewTab) {
  // target="_blank" links, handed over from the main process.
  API.onOpenNewTab((url) => createTab(url));
}
if (API.onFullScreen) {
  API.onFullScreen((on) => document.body.classList.toggle('fullscreen', on));
}
if (API.onBlockCounts) {
  API.onBlockCounts((counts) => { blockCounts = counts; syncShield(); });
}

// canGoBack()/canGoForward() have no change event, so poll them. Cheap.
setInterval(syncToolbar, 400);

// Settings arrive over IPC, so the first tab waits for them. Opening it
// earlier would bake the default engine into its URL, and the new tab page
// would then disagree with the picker.
(async function init() {
  if (API.getSettings) {
    try {
      const saved = await API.getSettings();
      if (saved && saved.searchEngine) engineId = engineOf(saved.searchEngine).id;
      if (saved && saved.searxngInstance) {
        searxngInstance = normalizeInstance(saved.searxngInstance) || searxngInstance;
      }
    } catch { /* fall back to the defaults */ }
  }
  setEngine(engineId);
  createTab(homeUrl());
  urlInput.focus();
})();
