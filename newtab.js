// newtab.js — the new tab page's behaviour.
//
// Lives in its own file rather than inline so newtab.html can set
// `script-src 'self'` with no 'unsafe-inline'. That single change is what
// makes injected markup on this page unable to execute, and it costs nothing
// here because the script never needed to be inline in the first place.

// ---- search engine ----
// This page has no preload bridge, so renderer.js passes the chosen engine
// in the query string (`newtab.html?engine=…`). Engines disagree on the
// field name — Marginalia wants `query`, the others want `q` — so the form
// has to be rewritten, not just re-pointed.
// Keep this table in sync with SEARCH_ENGINES in renderer.js.
const params = new URLSearchParams(location.search);

// SearXNG has no fixed home — the instance is chosen in the toolbar and
// arrives here as a parameter. It is re-validated here rather than trusted:
// this page is a file:// document, so a crafted newtab URL would otherwise be
// able to point the search form at any host it liked.
function safeInstance(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

const instance = safeInstance(params.get('instance')) || 'https://searx.be';

const ENGINES = {
  searxng:    { name: 'SearXNG',    action: instance + '/search',                   param: 'q' },
  marginalia: { name: 'Marginalia', action: 'https://marginalia-search.com/search', param: 'query' },
  duckduckgo: { name: 'DuckDuckGo', action: 'https://duckduckgo.com/',              param: 'q' },
};

const engine = ENGINES[params.get('engine')] || ENGINES.searxng;
const form = document.querySelector('form');
const searchInput = form.querySelector('input');

form.action = engine.action;
searchInput.name = engine.param;
searchInput.placeholder = 'Search ' + engine.name;

// ---- clock + greeting ----
function tick() {
  const now = new Date();
  document.getElementById('clock').textContent =
    now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  document.getElementById('date').textContent =
    now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });

  const h = now.getHours();
  const part = h < 5 ? 'night' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
  document.getElementById('greeting').textContent = 'Good ' + part + ', Smruti';
}
tick();
setInterval(tick, 10000);

// ---- quick links ----
// Edit this array to change your tiles.
const LINKS = [
  { name: 'YouTube',   url: 'https://youtube.com' },
  { name: 'GitHub',    url: 'https://github.com' },
  { name: 'Gmail',     url: 'https://mail.google.com' },
  { name: 'Wikipedia', url: 'https://wikipedia.org' },
  { name: 'Reddit',    url: 'https://reddit.com' },
  { name: 'Maps',      url: 'https://maps.google.com' },
];

const wrap = document.getElementById('links');
for (const link of LINKS) {
  const a = document.createElement('a');
  a.href = link.url;
  // Nothing here opens in a new context, but if a tile is ever changed to,
  // the opened page must not get a handle back to this one.
  a.rel = 'noopener noreferrer';

  const tile = document.createElement('span');
  tile.className = 'tile';
  tile.textContent = link.name[0].toUpperCase();

  const label = document.createElement('span');
  label.textContent = link.name;

  a.append(tile, label);
  wrap.appendChild(a);
}
