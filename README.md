# MiniBrowser

A minimal Chromium-based web browser, built with Electron. ~400 lines total.

## Run it

Open a terminal in this folder:

```
npm install
npm start
```

The first `npm install` downloads Chromium (~200 MB) and takes a few minutes.
After that, `npm start` launches instantly.

## What works

- Custom new tab page — clock, greeting, search box, quick links. Local, so launch is instant and offline.
- Multiple tabs — new, close, switch, middle-click to close
- Address bar that tells URLs from search queries (`github.com` navigates, `how do browsers work` searches)
- Back / forward / reload / stop / home
- Live page titles and favicons in the tab strip, loading spinner
- `target="_blank"` links open in a new tab instead of a popup window
- Shortcuts: `Ctrl+T` new tab, `Ctrl+W` close, `Ctrl+L` address bar, `Ctrl+R` reload, `Ctrl+Tab` next tab, `Alt+←/→` history
- `F12` opens devtools for whatever has focus — the browser UI or the page inside a tab
- No OS title bar — window buttons sit in the tab strip, and the strip's empty space drags the window

## How it fits together

| File | Role |
|---|---|
| `main.js` | Electron main process. Owns the OS window; intercepts popups. |
| `preload.js` | The one safe bridge from main → UI. Exposes a single function. |
| `index.html` | The browser "chrome" — tab strip, toolbar, styling. |
| `renderer.js` | Tab management, URL parsing, navigation, shortcuts. |
| `newtab.html` | The new tab page. Self-contained; edit `LINKS` to change the tiles. |

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
buttons. Both have to match `#tabstrip` in `index.html` — `#202124` and `40px`
— or the buttons sit on a mismatched strip. Change one, change the other.

The strip's `padding-right: 148px` reserves space for those buttons. Shrink it
and your tabs slide underneath them.

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
