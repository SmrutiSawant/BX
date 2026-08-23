# MiniBrowser

A minimal Chromium-based web browser, built with Electron. ~550 lines total.

Chromium renders the pages; everything around them is ours. Blocks ads and
trackers by default, searches DuckDuckGo, strips tracking parameters from URLs,
and is styled in light monochrome so it looks nothing like Chrome.

See [ROADMAP.md](ROADMAP.md) for what's planned and why.

## Run it

> **Run this from Windows, not WSL.** If your prompt looks like
> `smruti@Smruti:/mnt/c/Browser$`, you're in WSL — see the section below.

Open **PowerShell** (or Command Prompt) in this folder:

```
cd C:\Browser
npm install
npm start
```

The first `npm install` downloads Chromium (~200 MB) and takes a few minutes.
After that, `npm start` launches instantly.

## Why not WSL

Electron installed from WSL is a **Linux** app. It draws through WSLg, a
compatibility layer, which breaks things in ways that look like bugs in this
code but aren't:

| Symptom | Cause under WSL |
|---|---|
| Window won't fill the screen | WSLg reports its own virtual display, not your real monitor |
| Choppy dragging, steppy scrolling | `GPU process exited unexpectedly` — no hardware acceleration |
| Window buttons missing or dead | `titleBarOverlay` is a Windows-only API; it does nothing on Linux |

The code now detects this and keeps the normal title bar on non-Windows, so it
stays usable either way — but for the real thing, run it from Windows.

**Switching from WSL to Windows:** `node_modules` holds Linux binaries and
can't be reused. Delete it first, then reinstall from PowerShell:

```
rmdir /s /q node_modules
npm install
npm start
```

This needs Node.js installed on Windows itself (<https://nodejs.org>) — having
it inside WSL isn't enough.

## What works

**Privacy defaults**

- **Ad and tracker blocking, on by default.** Real EasyList + EasyPrivacy rules
  via `@ghostery/adblocker-electron` — the same lists uBlock Origin uses. The
  toolbar shows a live count of what was blocked on the current page.
- **DuckDuckGo, not Google**, in both the address bar and the new tab page.
- **Tracking parameters stripped** from URLs you navigate to — `utm_*`,
  `fbclid`, `gclid`, `msclkid`, `igshid`, `mc_eid` and ~25 more. They tell the
  sender who clicked and change nothing about the page you get.

**Browsing**

- Custom new tab page — clock, greeting, search box, quick links. Local, so launch is instant and offline.
- Multiple tabs — new, close, switch, middle-click to close
- Address bar that tells URLs from search queries (`github.com` navigates, `how do browsers work` searches)
- Back / forward / reload / stop / home
- Live page titles and favicons in the tab strip, loading spinner
- `target="_blank"` links open in a new tab instead of a popup window
- Shortcuts: `Ctrl+T` new tab, `Ctrl+W` close, `Ctrl+L` address bar, `Ctrl+R` reload, `Ctrl+Tab` next tab, `Alt+←/→` history
- `F12` opens devtools for whatever has focus — the browser UI or the page inside a tab
- No OS title bar — window buttons sit in the tab strip, and the strip's empty space drags the window
- Light monochrome UI, rounded pill tabs, and the page floating inside an 8px gutter

## How it fits together

| File | Role |
|---|---|
| `main.js` | Electron main process. Owns the OS window; intercepts popups. |
| `preload.js` | The one safe bridge from main → UI. Exposes a single function. |
| `index.html` | The browser "chrome" — tab strip, toolbar, styling. |
| `renderer.js` | Tab management, URL parsing, navigation, shortcuts. |
| `newtab.html` | The new tab page. Self-contained; edit `LINKS` to change the tiles. |
| `ROADMAP.md` | Where this goes next, and what each step costs. |

The key idea: **you are not writing a rendering engine.** Each tab is a
`<webview>` element, which Electron backs with a full, sandboxed Chromium
renderer process. Your code is the frame around it — which is exactly the
relationship Brave, Arc, and Edge have with Chromium.

## Not implemented yet

Deliberately left out to keep this readable:

- Bookmarks and history (needs persistent storage — `electron-store` is the easy path)
- Downloads UI (hook `session.on('will-download')` in `main.js`)
- Find-in-page, zoom, devtools for the guest page
- Tab drag-to-reorder
- Incognito (give the `<webview>` a `partition="in-memory"` attribute)
- Shortcuts while focus is inside a page — a known `<webview>` limitation.
  Fixing it properly means registering accelerators via a `Menu` in `main.js`.

## Two numbers that must stay in sync

`titleBarOverlay` in `main.js` sets the colour and height of the native window
buttons. Both have to match `#tabstrip` in `index.html` — `#e6e6e6` and `40px`
— or the buttons sit on a mismatched strip. Its `symbolColor` (`#111111`) has
to match `--text`. Change one, change the other.

`backgroundColor` on the window should match `body` (`--toolbar-bg`, `#f7f7f7`),
which is what shows in the gutter around the floating page. And `nativeTheme
.themeSource` is pinned to `'light'` so sites that honour `prefers-color-scheme`
match the frame — set it to `'system'` if you'd rather follow the OS.

The strip's `padding-right: 148px` reserves space for those buttons. Shrink it
and your tabs slide underneath them.

## Only one webRequest listener per session

Electron allows exactly **one** listener per `webRequest` event per session.
The ad blocker owns `session.defaultSession.webRequest.onBeforeRequest`, so
registering your own silently replaces it and blocking stops working — with no
error to tell you.

That's why tracking-parameter stripping lives in `renderer.js` rather than in a
`onBeforeRequest` redirect, where it would otherwise belong. If you need to
inspect requests, either use a different session partition or hook the
blocker's own events (`request-blocked`, `request-allowed`, …).

## Gotcha worth knowing

Do **not** set `display: none` on a `<webview>` to hide it. Electron relies on
`display: flex` internally to size the guest page, and overriding it causes
layout to misbehave. That's why each tab is wrapped in a `.view-wrap` div and
the wrapper is what gets toggled. It's the first thing to check if the UI ever
looks wrong.

## Known trade-off: `<webview>` vs `WebContentsView`

This uses `<webview>`, which keeps tab management to a handful of DOM calls.
Electron's team recommends `WebContentsView` instead — it's faster and better
supported, but tabs then live in the main process and you have to position and
resize each one by hand. Worth migrating to if this grows past a prototype.
