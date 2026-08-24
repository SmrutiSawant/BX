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

**Status:** largely built. `privacy.js` now holds the session hardening, header
scrubbing, permissions, HTTPS-only, DNS-over-HTTPS, download safety and the
Chromium switches; every default is reversible from the shield in the toolbar.
What's left on this axis is 1.5's named containers and the self-hosted SearXNG
instance in 1.1. See the README for the measure-by-measure table.

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

### 1.4 Default-deny permissions — ✅ *done*

`setPermissionRequestHandler` and its synchronous twin `setPermissionCheckHandler`
now deny twenty permissions by default — location, camera, mic, screen share,
clipboard reading, MIDI, USB, HID, serial, Bluetooth, idle detection and the rest —
and `setDevicePermissionHandler` refuses hardware outright. Only `fullscreen`,
`pointerLock` and sanitised clipboard *writes* are automatic.

The interesting design choice was **denying silently**. Chrome prompts, which
trained everyone to dismiss the prompt without reading it. Here the page is never
interrupted; a dot appears on the shield, and the panel offers to grant per-site.
The decision is available the moment you want it and invisible when you don't.

Both handlers are needed. With only the async one, some APIs report themselves
available and then fail at the point of use, which sites handle badly.

### 1.5 Per-site containers — 🟡 *private tabs done, named containers open*

`Ctrl+Shift+N` opens a tab on its own partition: separate cookie jar, separate
storage, never added to the reopen list, wiped on exit. The partition is hardened
at startup, before any tab can attach to it, and the ad blocker runs on it too.

Named containers ("work", "personal") are the remaining half and are now cheap —
the plumbing for a second partition already exists in `main.js`, and
`will-attach-webview` is where the allowlist of acceptable partition names lives.

### 1.6 Disable Chromium's phone-home behaviour — ✅ *done*

`applyCommandLineSwitches()` in `privacy.js` turns off variations fetching,
domain-reliability beacons, component updates, crash uploads, `<a ping>` hyperlink
auditing, the LAN cast-device scan, Translate, and Optimization Hints. The
Privacy Sandbox APIs — Topics, FLEDGE, Attribution Reporting, Shared Storage —
are disabled in the same call.

**The trap here:** `appendSwitch('disable-features', …)` **replaces** the list
rather than merging it. Calling it twice means the first call silently does
nothing. That's why the Windows occlusion workaround had to move into the same
array, and why `privacy.js` is now the only file allowed to set that switch.

Safe Browsing never applied: it's a Chrome feature, not something Electron ships,
so there was no phishing protection to trade away.

### 1.7 Fingerprinting resistance — *still skipped, and here's the sharper reason*

Unchanged as a decision, but the work above clarified *why* — and the same logic
now shows up in two places in the shipped code, which is worth knowing before
someone "improves" either one:

- **Client Hints.** The high-entropy hints (CPU architecture, device model, OS
  build) are stripped. The low-entropy three (`sec-ch-ua`, `-mobile`,
  `-platform`) are deliberately **kept**, because everyone sends them — removing
  them is itself a rare signal.
- **User agent.** The `MiniBrowser/0.1.0 Electron/32` tokens are *removed*, which
  looks like spoofing and is the opposite. Spoofing invents a UA that contradicts
  how the engine behaves, and the contradiction narrows you down. Removing those
  tokens makes us present as the plain Chromium we actually are, which is the
  largest crowd on the web.

The rule: only change what moves you **toward** the majority. Tor Browser makes
every user identical, which is years of work. Don't half-do it.

---

## Axis 2 — Features Chrome lacks

### 2.1 Fix keyboard shortcuts first — ✅ *done*

`before-input-event` in `main.js` now catches every shortcut regardless of
focus and forwards the action over IPC; `runAction` in `renderer.js` is the
single table both the window listener and the IPC path go through. Picked up
`Ctrl+Shift+T` (reopen closed tab) and `Ctrl+Shift+R` (hard reload) on the way.

This was the blocker for the command palette (2.4) and anything else needing a
key that works inside a page. See the README for the two rules to follow when
adding a shortcut.

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
