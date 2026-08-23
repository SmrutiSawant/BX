# Making MiniBrowser different from Chrome

## The honest starting point

MiniBrowser doesn't feel like Chrome because it uses Chromium. It feels like
Chrome because it was **styled as a Chrome replica**. Look at `index.html`:

```css
--chrome-bg:  #202124;   /* Chrome's dark toolbar */
--toolbar-bg: #35363a;   /* Chrome's dark omnibox row */
--accent:     #8ab4f8;   /* Chrome's accent blue, exactly */
```

Those are Chrome's actual hex values. The tab shape (`border-radius: 8px 8px 0 0`),
the pill omnibox, the layout order — all copied. Even the default search engine is
Google (`renderer.js`, `SEARCH`).

Keep Chromium. Brave, Edge, Arc, Opera and Vivaldi all ship it; nobody calls them
Chrome clones. Everything that makes a browser *yours* lives in the frame you
already control. This document maps that space.

**One thing you can't change:** Chromium's network stack and JS engine make you
detectable as Chromium-family regardless of skin. That's fine — it's not what
differentiation means here.

---

## Axis 1 — Privacy defaults

Your biggest structural advantage. Google earns roughly 75% of its revenue from
advertising, so Chrome **cannot** ship default tracker blocking without cannibalising
its parent. You have no such constraint. This axis is cheap to build and impossible
for Chrome to copy.

### 1.1 Change the default search engine — ✅ *done*

Google is gone. `SEARCH_ENGINES` in `renderer.js` holds three options — SearXNG
(default), Marginalia, DuckDuckGo — with a picker in the toolbar and the choice
persisted to `settings.json`. Both open-source engines can be self-hosted.

Worth knowing: engines disagree on the query parameter (`q` vs Marginalia's
`query`), and public SearXNG instances routinely go dead — not offline, but
returning zero results because their upstreams have blocked them. The instance
is therefore editable from the toolbar and saved to `settings.json`. See the
README for why this happens.

**Next step here — self-host SearXNG (*1 hour*).** It's the only way to make
metasearch reliable: your own IP, your own upstream quota, nobody else's bot
traffic burning it. `docker run -d -p 8888:8080 searxng/searxng`, then point the
instance field at `http://localhost:8888`. Worth doing before building anything
else on this list if search is your daily friction.

Also still open: per-site search shortcuts (`w foo` → Wikipedia, `gh foo` →
GitHub), which is cheap now that the engine table exists.

### 1.2 Built-in ad and tracker blocking — *half a day, highest impact*

The single feature that will make this feel like a different browser. Use
`@ghostery/adblocker-electron` (the maintained successor to `@cliqz/adblocker-electron`),
which parses real EasyList/EasyPrivacy filter lists:

```js
// main.js, inside app.whenReady()
const { ElectronBlocker } = require('@ghostery/adblocker-electron');
ElectronBlocker.fromPrebuiltAdsAndTracking(fetch).then((blocker) => {
  blocker.enableBlockingInSession(session.defaultSession);
});
```

Roughly 5 lines plus a dependency. The package ships both CommonJS and ESM builds,
so `require()` works in this project as-is. Its README imports `fetch` from
`cross-fetch`; Electron 32 runs Node 20, which has `fetch` globally, so you can pass
the global directly and skip that dependency. Add a per-site toggle later, and a counter in the
toolbar showing blocks on this page — visible proof the browser is doing something
Chrome doesn't.

The from-scratch alternative is `session.defaultSession.webRequest.onBeforeRequest`
with your own hostname blocklist. Educational, ~40 lines, but you'll spend forever
chasing false positives. Use the library.

### 1.3 Strip tracking parameters from URLs — *1 hour*

Nothing in `utm_source`, `utm_medium`, `fbclid`, `gclid`, `msclkid`, `igshid`, or
`mc_eid` benefits you. Strip them in `normalizeUrl()` in `renderer.js`, and again on
the `did-navigate` handler so redirect-added params get cleaned too. Pure win, no
site breakage in practice. Firefox ships this; Chrome does not.

### 1.4 Default-deny notification permission — *1–2 hours*

`session.setPermissionRequestHandler` in `main.js`. Chrome prompts for notifications
and everyone clicks "block" anyway. Default-deny silently, with a small toolbar
affordance to grant per-site. Do the same for geolocation, camera, mic, and
`midi-sysex`. This is the kind of default that quietly changes daily browsing.

### 1.5 Per-site containers — *half a day*

Your `<webview>` elements currently share one session (`renderer.js`, `createTab`,
noted in a comment). Give a tab `partition="persist:container-<name>"` and its cookies
live in a separate jar — so a Facebook tab can't see your other tabs' cookies at all.
Firefox's Multi-Account Containers is a beloved feature Chrome has never matched.

Cheaper first step, already noted in your README: `partition="in-memory"` for a proper
incognito tab.

### 1.6 Disable Chromium's phone-home behaviour — *1 hour*

Chromium contacts Google for variations/field trials, safe-browsing lists, and
navigation error suggestions. Audit and disable what you don't want via
`app.commandLine.appendSwitch(...)` in `main.js`, where you already set switches.
Note the trade-off honestly: turning off Safe Browsing removes real phishing
protection. Consider keeping it but documenting it.

### 1.7 Fingerprinting resistance — *skip for now*

Worth understanding rather than building. Naive defenses (a spoofed user agent,
randomised canvas) often make you **more** identifiable, because the inconsistency
itself is a signal. Tor Browser solves this by making all users identical, which is
years of work. Don't half-do it.

---

## Axis 2 — Features Chrome lacks

### 2.1 Fix keyboard shortcuts first — *2 hours, unblocks everything*

Your README lists this as a known limitation: shortcuts don't fire while focus is
inside a page. But you've **already solved it** for F12 and F11 — in `main.js`,
`contents.on('before-input-event', ...)` catches keys regardless of focus. Route
`Ctrl+T/W/L/R/Tab` through the same handler and forward them over IPC to the
renderer.

Do this before any feature below that needs a shortcut.

### 2.2 Split view — *half a day*

Two pages side by side in one tab. Chrome still has no native equivalent; Edge and
Arc both do, and users love it.

Your architecture makes this unusually easy. `#views` already holds absolutely
positioned `.view-wrap` divs toggled by an `.active` class. Allow two wraps active at
once and switch the container to `display: flex`. The webviews resize themselves.
Add a draggable divider afterwards.

### 2.3 Tab hibernation — *half a day*

Unload a `<webview>` that hasn't been touched in N minutes, keep its tab button and
URL, reload on click. Each webview is a full Chromium renderer process — this is a
large, measurable memory win, and unlike Chrome's Memory Saver you can show the user
exactly what's asleep. Pairs well with heavy tab users.

### 2.4 Command palette (Ctrl+K) — *1 day*

Fuzzy-search across open tabs, history, bookmarks, and actions in one overlay. Arc's
best idea. Genuinely faster than Chrome's omnibox because it searches *open tabs*,
which Chrome buries. Needs 2.1 and 2.5.

### 2.5 Persistence: history, bookmarks, sessions — *1 day, foundational* — 🟡 *started*

A minimal settings store already exists: `settings.json` in `userData`, read at
startup and written on change, wired through `main.js` and `preload.js`. It
holds one key today. History and bookmarks need real storage on top.

`electron-store` is the easy path; SQLite via `better-sqlite3` if history grows
large.

**Gotcha:** current `electron-store` (v11) is ESM-only — no CommonJS build at all.
This project is CommonJS (`require` throughout `main.js`, no `"type": "module"` in
`package.json`), so `require('electron-store')` will throw. Three ways out: pin to
`electron-store@8.2.0`, the last CJS release; convert the project to ESM; or use
dynamic `await import()`. Pinning to v8 is the least disruptive.

This unlocks the command palette,
workspaces, session restore, and per-site settings — most of the interesting features
depend on it. **Build this early.**

### 2.6 Workspaces — *1 day, after 2.5*

Named, persistent sets of tabs you switch between wholesale — "work", "research",
"personal". Chrome's tab groups are per-window and evaporate; workspaces are the
version people actually want.

### 2.7 Reader mode — *2–3 hours*

Inject Mozilla's `@mozilla/readability` into the guest page via
`view.executeJavaScript()`, render the extracted article in your own clean template.
Chrome's reader mode is still hidden behind a flag on most platforms. Safari's is a
headline feature. Cheap to build, disproportionately loved.

### 2.8 Smaller ideas worth considering

| Feature | Effort | Note |
|---|---|---|
| Link peek on hover | ~half a day | Preview overlay without leaving the page |
| Per-site zoom, persisted | ~2 hours | Needs 2.5 |
| Per-site notes | ~half a day | Annotations keyed by hostname |
| Tab drag-to-reorder | ~3 hours | Table stakes, currently missing |
| Find-in-page | ~2 hours | `view.findInPage()`; currently missing |
| Downloads UI | ~half a day | `session.on('will-download')` |

Find-in-page and tab reordering aren't differentiators — they're gaps. Users will
notice their absence more than they notice any clever feature.

---

## Axis 3 — A different look

### 3.1 Replace the palette — *30 minutes, biggest visual return*

Change the eight variables in `:root` in `index.html` and the browser stops reading
as Chrome instantly. Directions that don't look like anyone else: warm off-white and
ink, high-contrast near-black with a single saturated accent, or muted sage/clay.
Avoid Chrome's blue-grey neutrals entirely.

**Two values must change together.** Your README documents this: `titleBarOverlay` in
`main.js` sets the native caption-button colour and height, and both must match
`#tabstrip` in `index.html`. Change one, change the other, or the window buttons sit
on a mismatched strip.

### 3.2 Vertical tab sidebar — *1 day, biggest structural difference*

The change that most makes a browser recognisably not-Chrome. Screens are wide and
short; horizontal tabs waste the scarce dimension and truncate titles to nothing past
about eight tabs. A sidebar shows 20+ tabs with full titles.

Rework `#app` from `flex-direction: column` to a row with a sidebar and a content
column. The tab strip markup mostly survives; the CSS changes substantially. Add
collapse-to-icons and you have the Arc/Zen layout.

**Watch out:** the tab strip is currently your window drag handle
(`-webkit-app-region: drag`) and reserves 148px for the caption buttons. Moving tabs
to a sidebar means you need a new drag region and a new home for that reserved space.
Plan this properly — it's the one item here that touches window management.

### 3.3 Merge the omnibox into the sidebar — *half a day, after 3.2*

Arc's move: with tabs vertical, the 44px toolbar row becomes redundant. Put the
address bar in the sidebar or make it appear only on `Ctrl+L`. Reclaims real vertical
space and looks nothing like any mainstream browser.

### 3.4 Float the page area — *1 hour*

Give `#views` a few pixels of margin, `border-radius: 8px`, and a soft shadow, so the
page sits *inside* the browser rather than filling it edge to edge. Small change,
strong signal, very cheap.

### 3.5 Rethink the tab shape — *1 hour*

`border-radius: 8px 8px 0 0` with `align-items: flex-end` is Chrome's fused-to-the-
toolbar tab. Detached rounded pills, or plain rows with a left accent bar in a
sidebar, both read as deliberately different.

### 3.6 Theming as data — *half a day*

Move the palette into a JSON file loaded at startup instead of hardcoded CSS. Themes
become shareable files. Nice once the design has settled — premature before then.

---

## Suggested order

**Weekend one — proof it's a different browser**

1. Default search engine (1.1) — 5 min
2. New palette (3.1) — 30 min, remember `titleBarOverlay`
3. Floating page area (3.4) — 1 hr
4. Ad/tracker blocking (1.2) — half a day
5. Tracking-param stripping (1.3) — 1 hr

By Sunday it looks different, blocks ads Chrome won't, and doesn't send searches to
Google. That's a real browser identity for about one day of work.

**Weekend two — foundations**

6. Fix shortcuts via `before-input-event` (2.1)
7. Persistence layer (2.5)
8. Find-in-page and tab reordering (2.8) — close the obvious gaps

**Then — the ambitious ones**

9. Vertical tabs (3.2), the big structural bet
10. Split view (2.2)
11. Command palette (2.4)
12. Containers (1.5), workspaces (2.6), reader mode (2.7)

---

## Housekeeping before you start

Your README says to delete the diagnostics once the UI is confirmed working, and
`browser-log.txt` and `window-debug.txt` both exist, so it has been. Remove:

- the logging block, `attachLogging()` and `writeDiagnostics()` in `main.js`
- the probe block at the bottom of `renderer.js` (error handler, `pointerdown`
  logger, `HANDLER FIRED` listeners)
- both `.txt` files

The `pointerdown` logger in particular fires on every click in capture phase. Clean
this out first so you're building on a tidy base.

## One structural decision to make early

Your README notes the `<webview>` vs `WebContentsView` trade-off. It matters more now
than it did: split view (2.2), hibernation (2.3), and link peek all involve
positioning and lifecycle-managing multiple views at once, which is precisely what
`<webview>` makes awkward and `WebContentsView` makes explicit. Electron's team
recommends `WebContentsView`.

If you intend to build several of those, migrate before you build them, not after.
If you're mainly after privacy defaults and a restyle, `<webview>` is fine
indefinitely.
