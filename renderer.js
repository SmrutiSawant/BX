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
// Settings
// ---------------------------------------------------------------------------
// A local mirror of what main.js holds. Main is the authority — it validates
// every write and it is what Chromium actually reads — but the UI needs a
// synchronous copy to render the privacy panel and to decide whether to
// upgrade a typed URL.

let settings = {
  searchEngine: 'searxng',
  searxngInstance: 'https://searx.be',
  httpsOnly: true,
  blockThirdPartyCookies: true,
  trimReferrer: true,
  sendGpc: true,
  stripClientHints: true,
  spellcheck: false,
  clearOnExit: false,
  askWhereToSaveDownloads: true,
  blockDangerousDownloads: true,
  dnsMode: 'secure',
  sitePermissions: {},
};

function setSetting(key, value) {
  settings = { ...settings, [key]: value };
  if (API.setSetting) API.setSetting(key, value);
  renderPrivacyPanel();
}

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

const panelEl        = document.getElementById('privacypanel');
const insecureBar    = document.getElementById('insecurebar');
const insecureDetail = document.getElementById('insecuredetail');
const insecureBack   = document.getElementById('insecureback');
const insecureGo     = document.getElementById('insecurego');

/** @type {Array<{id:number, view:Element, wrap:Element, el:Element, titleEl:Element, iconEl:Element, url:string, title:string}>} */
let tabs = [];
let activeId = null;
let nextId = 1;
let urlEdited = false; // don't stomp on what the user is typing

// URLs of recently closed tabs, most recent last. Ctrl+Shift+T pops one.
const closedTabs = [];

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
// HTTPS-only
// ---------------------------------------------------------------------------
// This lives in BOTH processes, and the reason is a genuine Electron gotcha:
// `will-navigate` — where main.js guards navigation — does not fire for
// navigations started programmatically. Every navigation WE start, from the
// omnibox or by setting a webview's src, is programmatic. So main covers what
// pages do, and this covers what the user does. Miss either half and the
// upgrade silently applies to only some navigations.
//
// Hosts the user chose to load over plain http after an upgrade failed.
// Session-scoped in both processes, populated by the same click, so the two
// copies cannot drift.
const httpsExceptions = new Set();

// Names that never leave this machine. Forcing HTTPS on them would break
// local development for no gain — there is no network in between to listen.
function isLocalHost(hostname) {
  const h = (hostname || '').toLowerCase();
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h === '::1' || h.startsWith('127.')) return true;
  if (h.endsWith('.onion')) return true;
  if (/^10\./.test(h) || /^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
}

// https URL -> the http URL it replaced. Remembered so that if the upgraded
// load fails, we can tell "this site has no HTTPS" apart from "you're
// offline", and offer the original rather than a dead end. Bounded, because
// this would otherwise grow for the life of the session.
const upgradedFrom = new Map();

function upgradeToHttps(url) {
  if (!settings.httpsOnly) return url;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:') return url;
    if (isLocalHost(u.hostname) || httpsExceptions.has(u.hostname)) return url;
    u.protocol = 'https:';

    upgradedFrom.set(u.href, url);
    if (upgradedFrom.size > 50) upgradedFrom.delete(upgradedFrom.keys().next().value);
    return u.href;
  } catch {
    return url;
  }
}

const originalHttpFor = (url) => upgradedFrom.get(url) || null;

// Schemes a tab may be pointed at. Mirrors ALLOWED_SCHEMES in main.js — main
// is the enforcement, this is so the omnibox refuses rather than silently
// doing nothing when you paste `javascript:` or a `data:` URL.
const OMNIBOX_SCHEMES = new Set(['https:', 'http:', 'about:', 'blob:', 'file:']);

function schemeAllowed(url) {
  if (url.startsWith(NEWTAB)) return true;
  try {
    return OMNIBOX_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

// Connection-level failures that mean "there is no HTTPS here", as opposed to
// "you are offline". Kept in step with NO_HTTPS_ERRORS in main.js.
const NO_HTTPS_ERRORS = new Set([-100, -101, -102, -107, -118, -200, -201, -202]);

function hostOf(url) {
  try { return new URL(url).hostname || null; } catch { return null; }
}

// ---------------------------------------------------------------------------
// Omnibox: decide whether input is a URL or a search query
// ---------------------------------------------------------------------------

function normalizeUrl(raw) {
  const s = raw.trim();
  if (!s) return null;

  // localhost / bare IP, with optional port. Checked BEFORE the scheme rule,
  // because "localhost:3000" otherwise reads as the scheme "localhost:".
  // upgradeToHttps leaves loopback and private ranges alone but will still
  // upgrade a bare PUBLIC address, which is what you want.
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#]|$)/i.test(s)) {
    return upgradeToHttps('http://' + s);
  }

  // Already has a scheme: about:blank, file:///, https://...
  // The (?!\d) stops "foo:1234" from being mistaken for one.
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s)) {
    const url = upgradeToHttps(stripTracking(s));
    // `javascript:` and `data:` in an address bar are how phishing gets a
    // victim to run something on a page they trust. Refuse rather than
    // navigate; main.js blocks them too, but silently.
    return schemeAllowed(url) ? url : null;
  }

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

// Permissions a page asked for and was denied, per host, so the privacy panel
// can offer to grant what a site actually wanted rather than listing all
// twenty. Declared up here, beside the other toolbar state, because
// syncShield() reads it and syncShield runs before the panel code below.
const blockedPermissions = new Map();   // host -> Set<permission>

function webContentsIdOf(tab) {
  try { return tab.view.getWebContentsId(); } catch { return null; }
}

function syncShield() {
  const tab = activeTab();
  const wcId = tab ? webContentsIdOf(tab) : null;
  const n = wcId === null ? 0 : (blockCounts.get(wcId) || 0);
  blockEl.textContent = String(n);
  shieldEl.classList.toggle('on', n > 0);

  // A dot, not a dialog. Something was denied and there's a decision waiting
  // in the panel, but the page is never interrupted to say so.
  shieldEl.classList.toggle('attention', hasPendingDecision());
  shieldEl.title = hasPendingDecision()
    ? 'This site asked for a permission and was denied'
    : 'Privacy for this site';
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

// The partition name is a contract with main.js: it is the only value
// 'will-attach-webview' will accept, and it is the session main hardens and
// wipes on exit. Change it in one place and private tabs silently fall back
// to the normal jar.
const PRIVATE_PARTITION = 'persist:in-memory-private';

function createTab(url = homeUrl(), { activate = true, isPrivate = false } = {}) {
  const id = nextId++;
  url = upgradeToHttps(stripTracking(url));

  // --- the page itself ---
  const view = document.createElement('webview');
  view.setAttribute('src', url);
  view.setAttribute('allowpopups', '');

  // Normal tabs share one session partition, so logins carry across tabs —
  // which is what people expect from a browser. A private tab gets its own
  // jar instead: separate cookies, separate storage, nothing written to disk,
  // and wiped when the app closes. It cannot see the normal session's logins
  // and the normal session cannot see its.
  if (isPrivate) view.setAttribute('partition', PRIVATE_PARTITION);

  // The wrapper is what gets shown/hidden. Toggling display on the <webview>
  // itself breaks Electron's internal sizing — see the CSS note in index.html.
  const wrap = document.createElement('div');
  wrap.className = 'view-wrap';
  wrap.appendChild(view);
  viewsEl.appendChild(wrap);

  // --- the tab button ---
  const el = document.createElement('div');
  el.className = 'tab' + (isPrivate ? ' private' : '');

  // A private tab is marked twice over — inverted fill AND a mask glyph.
  // Getting this wrong means typing a password into the wrong kind of tab,
  // so one signal isn't enough.
  const mask = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  mask.setAttribute('viewBox', '0 0 24 24');
  mask.setAttribute('class', 'mask');
  const maskPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  maskPath.setAttribute('d', 'M12 4C7 4 3 7.6 1 12c2 4.4 6 8 11 8s9-3.6 11-8c-2-4.4-6-8-11-8zm0 13a5 5 0 1 1 0-10 5 5 0 0 1 0 10zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z');
  mask.appendChild(maskPath);

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

  el.append(mask, spinner, iconEl, titleEl, closeEl);
  tabsEl.appendChild(el);

  const tab = {
    id, view, wrap, el, titleEl, iconEl, url,
    title: isPrivate ? 'Private tab' : 'New tab',
    isPrivate,
    // The http URL this tab's current load replaced, if the HTTPS upgrade is
    // what's being tried. Cleared the moment anything succeeds.
    pendingUpgrade: originalHttpFor(url),
  };
  titleEl.textContent = tab.title;
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

    // A load that succeeded is not a failed upgrade, and permission decisions
    // belong to the page that asked for them.
    tab.pendingUpgrade = originalHttpFor(e.url || '');
    tab.blockedPermissions = new Set();
    if (tab.id === activeId) hideInsecureBar();
    onNavigate(e);
  });

  // In-page navigation (SPA route changes) keeps the same document, so the
  // block count stays.
  view.addEventListener('did-navigate-in-page', (e) => { if (e.isMainFrame) onNavigate(e); });

  view.addEventListener('did-fail-load', (e) => {
    // -3 is ERR_ABORTED, which fires on ordinary redirects/cancels. Ignore it.
    if (e.errorCode === -3 || !e.isMainFrame) return;

    // If the thing that failed was our own silent HTTPS upgrade, say so and
    // offer the choice. Leaving the user on an error page with no explanation
    // is how a good default gets blamed for a broken browser.
    if (tab.pendingUpgrade && NO_HTTPS_ERRORS.has(e.errorCode)) {
      if (tab.id === activeId) showInsecureBar(tab.pendingUpgrade);
      return;
    }

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

  // Remember where it was so Ctrl+Shift+T can bring it back. An empty new tab
  // page isn't worth restoring, and the list is capped so it can't grow
  // without bound over a long session.
  //
  // A private tab is never remembered. The entire point is that closing it
  // ends the trail; a reopen list that survives it would quietly undo that.
  if (tab.url && !tab.isPrivate && !tab.url.startsWith(NEWTAB)) {
    closedTabs.push(tab.url);
    if (closedTabs.length > 10) closedTabs.shift();
  }

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
  if (!url) return;              // refused: a scheme we won't navigate to
  const tab = activeTab();
  if (!tab) return;

  tab.url = url;
  tab.pendingUpgrade = originalHttpFor(url);
  hideInsecureBar();
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

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------
// One table, two callers. The window listener below catches keys pressed while
// our own UI has focus; main.js catches the ones pressed inside a page — a
// <webview> is a separate process, so its key events never reach us — and
// forwards the action here. Both end up in runAction, so the two paths can't
// drift apart.

const ACTIONS = {
  'new-tab': () => { createTab(homeUrl()); urlInput.focus(); },

  'new-private-tab': () => { createTab(homeUrl(), { isPrivate: true }); urlInput.focus(); },

  'clear-data': () => { if (API.clearBrowsingData) API.clearBrowsingData(); },

  'close-tab': () => {
    if (activeId === null) return;
    closeTab(activeId);
    focusActiveView();   // don't strand focus on the tab that just went away
  },

  'reopen-tab': () => {
    const url = closedTabs.pop();
    if (!url) return;
    createTab(url);
    focusActiveView();
  },

  'focus-omnibox': () => urlInput.focus(),

  'reload': () => { try { activeTab().view.reload(); } catch {} },

  // Ctrl+Shift+R — bypass the cache, the way every other browser does.
  'hard-reload': () => { try { activeTab().view.reloadIgnoringCache(); } catch {} },

  'back':   () => { try { activeTab().view.goBack(); } catch {} },
  'forward':() => { try { activeTab().view.goForward(); } catch {} },

  'cycle-tab': (payload) => {
    if (tabs.length < 2) return;
    const i = tabs.findIndex((t) => t.id === activeId);
    const step = (payload && payload.step) || 1;
    activateTab(tabs[(i + step + tabs.length) % tabs.length].id);
    focusActiveView();   // follow the page you just switched to
  },
};

// Moving to a different tab should put the caret in that page, so the next
// shortcut arrives through the same route as the last one.
function focusActiveView() {
  const tab = activeTab();
  if (!tab) return;
  try { tab.view.focus(); } catch { /* guest not attached yet */ }
}

function runAction(name, payload) {
  const fn = ACTIONS[name];
  if (fn) fn(payload);
}

// Key combination -> action name, for the UI-has-focus case.
function shortcutFor(e) {
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();

  if (ctrl && !e.altKey) {
    if (key === 't') return [e.shiftKey ? 'reopen-tab' : 'new-tab'];
    if (key === 'n' && e.shiftKey) return ['new-private-tab'];
    if (key === 'w') return ['close-tab'];
    if (key === 'l') return ['focus-omnibox'];
    if (key === 'r') return [e.shiftKey ? 'hard-reload' : 'reload'];
    if (key === 'tab') return ['cycle-tab', { step: e.shiftKey ? -1 : 1 }];
    if (key === 'delete' && e.shiftKey) return ['clear-data'];
  }

  if (e.altKey && !ctrl) {
    if (key === 'arrowleft') return ['back'];
    if (key === 'arrowright') return ['forward'];
  }

  return null;
}

window.addEventListener('keydown', (e) => {
  const hit = shortcutFor(e);
  if (!hit) return;
  e.preventDefault();
  runAction(hit[0], hit[1]);
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

// ---------------------------------------------------------------------------
// Insecure-connection bar
// ---------------------------------------------------------------------------
// Shown only when the silent HTTPS upgrade failed because the site genuinely
// has none. A bar over the top of the page area rather than a full-page
// interstitial: interstitials that block everything train people to click
// through them without reading, which is the opposite of what a warning is
// for.

let insecureUrl = null;

function showInsecureBar(url) {
  insecureUrl = url;
  const host = hostOf(url) || 'This site';
  insecureDetail.textContent =
    host + ' offers no encrypted connection. Anyone on the network between you '
    + 'and it can read and change what you send.';
  insecureBar.classList.add('show');
}

function hideInsecureBar() {
  insecureUrl = null;
  insecureBar.classList.remove('show');
}

insecureBack.addEventListener('click', () => {
  hideInsecureBar();
  const tab = activeTab();
  try {
    if (tab.view.canGoBack()) tab.view.goBack();
    else navigate(homeUrl());
  } catch { navigate(homeUrl()); }
});

insecureGo.addEventListener('click', () => {
  if (!insecureUrl) return;
  const url = insecureUrl;
  const host = hostOf(url);

  // Both processes need the exception: this one so the omnibox stops
  // upgrading, main so page-initiated navigations stop too. One click, two
  // updates, so they cannot disagree.
  if (host) {
    httpsExceptions.add(host);
    if (API.allowInsecure) API.allowInsecure(host);
  }
  hideInsecureBar();

  const tab = activeTab();
  if (!tab) return;
  tab.pendingUpgrade = null;
  tab.url = url;
  try { tab.view.loadURL(url); } catch { tab.view.setAttribute('src', url); }
});

// ---------------------------------------------------------------------------
// Privacy panel
// ---------------------------------------------------------------------------
// Every strict default the browser ships with is switchable here. That is what
// separates a defensible default from a merely opinionated one: the user can
// always see what is being done on their behalf, and always undo it.

// Keep in step with PERMISSION_LABELS in privacy.js. Blocked permissions
// arrive over IPC carrying their own label; this table is for the ones already
// granted, which are read back from settings and have no message attached.
const PERMISSION_LABELS = {
  geolocation: 'Location',
  notifications: 'Notifications',
  media: 'Camera and microphone',
  'display-capture': 'Screen sharing',
  midi: 'MIDI devices',
  midiSysex: 'MIDI (full device access)',
  'idle-detection': 'Idle detection',
  'clipboard-read': 'Clipboard reading',
  'window-management': 'Window and screen layout',
  'speaker-selection': 'Audio output devices',
  'storage-access': 'Third-party storage',
  'top-level-storage-access': 'Third-party storage',
  mediaKeySystem: 'DRM playback',
  hid: 'HID devices',
  serial: 'Serial ports',
  usb: 'USB devices',
  bluetooth: 'Bluetooth',
  fileSystem: 'Local file access',
  openExternal: 'Opening other apps',
  keyboardLock: 'Keyboard capture',
};

const PROTECTIONS = [
  {
    key: 'httpsOnly',
    name: 'HTTPS-only',
    note: 'Upgrade every site to an encrypted connection, and ask before ever falling back.',
  },
  {
    key: 'blockThirdPartyCookies',
    name: 'Block third-party cookies',
    note: 'The mechanism behind cross-site tracking: one embedded network reading the same cookie everywhere.',
  },
  {
    key: 'trimReferrer',
    name: 'Trim cross-site referrers',
    note: 'Other sites learn you came from here, not which page you were reading.',
  },
  {
    key: 'sendGpc',
    name: 'Send Global Privacy Control',
    note: 'A legally binding opt-out of data sale under California and Colorado law.',
  },
  {
    key: 'stripClientHints',
    name: 'Strip high-entropy Client Hints',
    note: 'Hides your exact CPU, device model and OS build. The low-entropy ones stay — removing those makes you more distinctive, not less.',
  },
  {
    key: 'blockDangerousDownloads',
    name: 'Warn on executable downloads',
    note: 'Ask before a site writes a program to your disk.',
  },
  {
    key: 'askWhereToSaveDownloads',
    name: 'Ask where to save downloads',
    note: 'Nothing lands on disk without you choosing where.',
  },
  {
    key: 'spellcheck',
    name: 'Spellcheck',
    note: 'Off by default: Chromium fetches its dictionaries from a Google server and re-checks periodically.',
  },
  {
    key: 'clearOnExit',
    name: 'Clear everything on exit',
    note: 'Wipe cookies, cache and site storage when the browser closes.',
  },
];

const DNS_MODES = [
  { id: 'secure', label: 'Encrypted only' },
  { id: 'automatic', label: 'Encrypted if possible' },
  { id: 'off', label: 'System DNS' },
];

function activeHost() {
  const tab = activeTab();
  if (!tab || !tab.url || tab.url.startsWith(NEWTAB)) return null;
  return hostOf(tab.url);
}

function hasPendingDecision() {
  const host = activeHost();
  if (!host) return false;
  const blocked = blockedPermissions.get(host);
  return Boolean(blocked && blocked.size);
}

function row({ name, note, on, onClick, className = '' }) {
  const el = document.createElement('button');
  el.className = 'pp-row' + (on ? ' on' : '') + (className ? ' ' + className : '');

  const label = document.createElement('span');
  label.className = 'label';
  const title = document.createElement('span');
  title.textContent = name;
  label.appendChild(title);
  if (note) {
    const small = document.createElement('small');
    small.textContent = note;
    label.appendChild(small);
  }

  const sw = document.createElement('span');
  sw.className = 'sw';

  el.append(label, sw);
  el.addEventListener('click', onClick);
  return el;
}

function section(heading) {
  const el = document.createElement('div');
  el.className = 'pp-section';
  const h = document.createElement('h4');
  h.textContent = heading;
  el.appendChild(h);
  return el;
}

function renderPrivacyPanel() {
  if (!panelEl.classList.contains('open')) return;
  panelEl.textContent = '';

  const tab = activeTab();
  const host = activeHost();
  const wcId = tab ? webContentsIdOf(tab) : null;
  const blocked = wcId === null ? 0 : (blockCounts.get(wcId) || 0);

  // --- header ---
  const head = document.createElement('div');
  head.className = 'pp-head';
  const hostEl = document.createElement('div');
  hostEl.className = 'pp-host';
  hostEl.textContent = host || 'New tab';
  const sub = document.createElement('div');
  sub.className = 'pp-sub';
  sub.textContent = tab && tab.isPrivate
    ? 'Private tab — separate cookies, nothing saved to disk'
    : blocked + (blocked === 1 ? ' request blocked on this page' : ' requests blocked on this page');
  head.append(hostEl, sub);
  panelEl.appendChild(head);

  // --- this site ---
  if (host) {
    const siteSection = section('This site');
    const granted = (settings.sitePermissions || {})[host] || {};
    const asked = blockedPermissions.get(host) || new Set();
    const names = new Set([...Object.keys(granted), ...asked]);

    if (names.size === 0) {
      const empty = document.createElement('div');
      empty.className = 'pp-empty';
      empty.textContent = 'This site has not asked for any device permissions.';
      siteSection.appendChild(empty);
    } else {
      for (const permission of names) {
        const on = granted[permission] === true;
        siteSection.appendChild(row({
          name: PERMISSION_LABELS[permission] || permission,
          note: on ? 'Allowed on this site' : 'Blocked — this site asked for it',
          on,
          onClick: () => {
            const next = { ...(settings.sitePermissions || {}) };
            const site = { ...(next[host] || {}) };
            if (on) delete site[permission];
            else site[permission] = true;
            if (Object.keys(site).length) next[host] = site;
            else delete next[host];

            settings = { ...settings, sitePermissions: next };
            if (API.setPermission) API.setPermission(host, permission, !on);
            renderPrivacyPanel();
          },
        }));
      }
    }

    if (httpsExceptions.has(host)) {
      siteSection.appendChild(row({
        name: 'Allowed over plain HTTP',
        note: 'This exception lasts until you close the browser.',
        on: true,
        onClick: () => {
          httpsExceptions.delete(host);
          renderPrivacyPanel();
        },
      }));
    }

    panelEl.appendChild(siteSection);
  }

  // --- global protections ---
  const protections = section('Protections');
  for (const p of PROTECTIONS) {
    protections.appendChild(row({
      name: p.name,
      note: p.note,
      on: settings[p.key] === true,
      onClick: () => setSetting(p.key, !settings[p.key]),
    }));
  }
  panelEl.appendChild(protections);

  // --- DNS ---
  const dns = section('Encrypted DNS');
  const dnsNote = document.createElement('div');
  dnsNote.className = 'pp-empty';
  dnsNote.textContent =
    'Plain DNS leaks every hostname you visit to the network even when the '
    + 'page itself is encrypted. "Encrypted only" never falls back — which is '
    + 'the point, but it also means hotel wifi sign-in pages will not load.';
  dns.appendChild(dnsNote);

  const chips = document.createElement('div');
  chips.className = 'pp-select';
  for (const mode of DNS_MODES) {
    const chip = document.createElement('button');
    chip.className = 'chip' + (settings.dnsMode === mode.id ? ' active' : '');
    chip.textContent = mode.label;
    chip.addEventListener('click', () => setSetting('dnsMode', mode.id));
    chips.appendChild(chip);
  }
  dns.appendChild(chips);
  panelEl.appendChild(dns);

  // --- actions ---
  const actions = section('Data');
  actions.appendChild(row({
    name: 'New private tab',
    note: 'Separate cookie jar, nothing written to disk. Ctrl+Shift+N',
    on: false,
    onClick: () => { closePrivacyPanel(); runAction('new-private-tab'); },
  }));
  actions.appendChild(row({
    name: 'Clear browsing data…',
    note: 'Cookies, cache and site storage, everywhere. Ctrl+Shift+Delete',
    on: false,
    onClick: () => { closePrivacyPanel(); runAction('clear-data'); },
  }));
  panelEl.appendChild(actions);
}

function closePrivacyPanel() {
  panelEl.classList.remove('open');
}

shieldEl.addEventListener('click', (e) => {
  e.stopPropagation();
  closeEngineMenu();
  const opening = !panelEl.classList.contains('open');
  panelEl.classList.toggle('open', opening);
  if (opening) {
    // Opening the panel is the acknowledgement — the dot has done its job.
    const host = activeHost();
    if (host) blockedPermissions.delete(host);
    renderPrivacyPanel();
    syncShield();
  }
});

panelEl.addEventListener('click', (e) => e.stopPropagation());
window.addEventListener('click', closePrivacyPanel);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePrivacyPanel(); });

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
if (API.onShortcut) {
  // Pressed while a page had focus. main.js already called preventDefault on
  // the guest's behalf, so there's nothing left to suppress here.
  API.onShortcut((hit) => runAction(hit.action, hit));
}

if (API.onPermissionBlocked) {
  // The page has ALREADY been denied by the time this arrives — main.js does
  // not wait for us. This is only so the toolbar can offer to change it.
  API.onPermissionBlocked(({ host, permission }) => {
    if (!host || !permission) return;
    if (!blockedPermissions.has(host)) blockedPermissions.set(host, new Set());
    blockedPermissions.get(host).add(permission);
    syncShield();
    renderPrivacyPanel();
  });
}

if (API.onHttpsUpgradeFailed) {
  // The page-initiated half of the HTTPS upgrade. The omnibox half is handled
  // by the tab's own did-fail-load, above.
  API.onHttpsUpgradeFailed(({ tabId, url }) => {
    const tab = tabs.find((t) => webContentsIdOf(t) === tabId);
    if (!tab) return;
    tab.pendingUpgrade = url;
    if (tab.id === activeId) showInsecureBar(url);
  });
}

if (API.onSettingsChanged) {
  // Main is the authority: it validates every write and may reject one. Take
  // what it actually stored rather than assuming our optimistic copy won.
  API.onSettingsChanged((saved) => {
    if (saved) settings = { ...settings, ...saved };
    renderPrivacyPanel();
  });
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
      if (saved) settings = { ...settings, ...saved };
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
