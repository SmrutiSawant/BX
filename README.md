# MiniBrowser

A minimal Chromium-based web browser, built with Electron.

Chromium renders the pages; everything around them is ours. Blocks ads and
trackers by default, encrypts DNS, upgrades every site to HTTPS, refuses
third-party cookies, denies device permissions until you say otherwise, and is
styled in light monochrome so it looks nothing like Chrome.

Every one of those defaults is strict, and every one is switchable from the
shield in the toolbar. That combination is the whole design: a default you
can't see or undo isn't a protection, it's an opinion.

See [ROADMAP.md](ROADMAP.md) for what's planned and why.

## Run it
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
- **Open source search by default.** The picker beside the address bar switches
  between three engines, and the choice persists:

  | Engine | Licence | Good for |
  |---|---|---|
  | **SearXNG** (default) | AGPL | General search. A metasearch engine — it fans your query out to ~270 upstreams and merges the results, so no single one builds a profile of you. |
  | **Marginalia** | AGPL | Finding actual writing. Its own crawler and index, tuned for text-heavy non-commercial pages. Superb for essays and old web; useless for weather or opening hours. |
  | **DuckDuckGo** | Proprietary | The reliable fallback. 
  
  Both open-source options can be self-hosted. Google isn't in the list.
- **Tracking parameters stripped** from URLs you navigate to — `utm_*`,
  `fbclid`, `gclid`, `msclkid`, `igshid`, `mc_eid` and ~25 more. They tell the
  sender who clicked and change nothing about the page you get.

**Protecting your data**

All of this lives in `privacy.js`, and all of it is reversible from the shield
button in the toolbar.

*On the wire*

| Measure | What it stops |
|---|---|
| **HTTPS-only**, with a per-site fallback you have to choose | Anyone between you and the site reading or rewriting the page. If a site genuinely has no HTTPS you get a bar offering the choice, not a dead end |
| **Encrypted DNS** (DoH, Quad9 by default, `secure` mode) | Your ISP and the local network seeing every hostname you visit — which plain DNS leaks even when the page itself is encrypted |
| **Third-party cookies blocked**, request and response | The mechanism behind cross-site tracking: one embedded network reading the same cookie on a thousand sites |
| **Cross-site referrers trimmed to the origin** | Other sites learning *which page* you came from — often the search you ran. Same-site referrers are untouched, so anti-CSRF checks still work |
| **`Sec-GPC: 1` sent** | Legally binding opt-out of data sale under California and Colorado law |
| **`X-Client-Data` stripped** | A stable, high-entropy identifier Chromium attaches to every request to a Google domain |
| **High-entropy Client Hints stripped** | Your exact CPU architecture, device model and OS build. The low-entropy three are kept deliberately — see below |
| **`NEL` / `Report-To` stripped** | Sites collecting telemetry about your own network conditions and failures |
| **WebRTC restricted to the public interface** | The classic leak where a page reads your LAN address straight through a VPN |
| **`<a ping>` disabled, background networking off** | Click-reporting beacons, variations fetches, domain-reliability reports, component updates |
| **Privacy Sandbox off** | Topics, FLEDGE, Attribution Reporting and Shared Storage — Google's replacement for third-party cookies, which relocates the profiling into the browser rather than removing it |

*On the machine*

- **Device permissions default-deny.** Location, camera, microphone, screen
  share, clipboard reading, MIDI, USB, HID, serial, Bluetooth, idle detection.
  Denied *silently* — no modal — with a dot on the shield when a site asked, so
  the answer is there when you want it and invisible when you don't. Grant
  per-site from the panel.
- **Private tabs** (`Ctrl+Shift+N`) on their own partition: separate cookie
  jar, separate storage, never in the reopen list, wiped when the app closes.
- **Executable downloads warn before writing to disk**, and downloads always
  ask where to save.
- **Clear-on-exit** and an immediate **Clear browsing data** (`Ctrl+Shift+Del`).
- **Certificates are never silently accepted** — a bad cert on a page you typed
  is the exact shape of an interception attempt.

*Against the browser itself*

Every tab is a hostile document until proven otherwise.

- All renderers sandboxed (`app.enableSandbox()`); guest pages get **no
  preload**, no Node, and context isolation.
- `will-attach-webview` **overwrites** the webPreferences a `<webview>` tag
  asks for, so markup can never request Node integration.
- Navigation is scheme-allowlisted: `javascript:` and top-level `data:` URLs —
  the classic phishing vectors — are refused, and `file:` is limited to the new
  tab page.
- Our own UI can't navigate anywhere, can't open windows, and runs under a CSP
  with no `script-src 'unsafe-inline'`.
- Every IPC handler validates its sender; every setting is re-validated in the
  main process, so a hand-edited `settings.json` can't inject state.

**What is deliberately *not* done: fingerprinting resistance.** No spoofed user
agent, no randomised canvas. Naive defences make you *more* identifiable,
because the inconsistency is itself a signal — a UA claiming Firefox from an
engine that behaves like Chromium is rarer than either. This is also why the
low-entropy Client Hints are left alone while the high-entropy ones are
stripped: the first three are sent by everyone, so removing them would single
you out. The one related change made is *removing* the `MiniBrowser/0.1.0
Electron/32` tokens from the user agent — that's joining the largest crowd on
the web rather than standing outside it, which is the opposite of spoofing.
Tor Browser solves fingerprinting properly by making every user identical.
That's years of work; don't half-do it.

**Browsing**

- Custom new tab page — clock, greeting, search box, quick links. Local, so launch is instant and offline.
- Multiple tabs — new, close, switch, middle-click to close
- Address bar that tells URLs from search queries (`github.com` navigates, `how do browsers work` searches)
- Back / forward / reload / stop / home
- Live page titles and favicons in the tab strip, loading spinner
- `target="_blank"` links open in a new tab instead of a popup window
- Shortcuts, working everywhere — including with focus inside a page:
  `Ctrl+T` new tab, `Ctrl+Shift+N` new **private** tab,
  `Ctrl+Shift+T` reopen closed tab, `Ctrl+W` close,
  `Ctrl+L` address bar, `Ctrl+R` reload, `Ctrl+Shift+R` hard reload,
  `Ctrl+Tab` / `Ctrl+Shift+Tab` cycle tabs, `Alt+←/→` history,
  `Ctrl+Shift+Del` clear browsing data, `F11` fullscreen, `F12` devtools
- `F12` opens devtools for whatever has focus — the browser UI or the page inside a tab
- No OS title bar — window buttons sit in the tab strip, and the strip's empty space drags the window
- Light monochrome UI, rounded pill tabs, and the page floating inside an 8px gutter

## How it fits together

| File | Role |
|---|---|
| `main.js` | Electron main process. Owns the OS window; blocks ads; intercepts popups; enforces the `<webview>` boundary; rescues keyboard shortcuts from pages. |
| `privacy.js` | Everything that touches user data: session hardening, header scrubbing, permissions, HTTPS-only, downloads, DNS, Chromium switches. |
| `preload.js` | The one safe bridge from main → UI. Nothing else crosses. |
| `index.html` | The browser "chrome" — tab strip, toolbar, privacy panel, styling. |
| `renderer.js` | Tab management, URL parsing, navigation, shortcuts, the privacy panel. |
| `newtab.html` | The new tab page. |
| `newtab.js` | Its behaviour — separate so the page can forbid inline script. Edit `LINKS` to change the tiles. |
| `ROADMAP.md` | Where this goes next, and what each step costs. |

`main.js` owns the *window*; `privacy.js` owns the *sessions*. Splitting them
that way means the entire privacy posture of the browser is readable in one
sitting instead of scattered through window management.

The key idea: **you are not writing a rendering engine.** Each tab is a
`<webview>` element, which Electron backs with a full, sandboxed Chromium
renderer process. Your code is the frame around it — which is exactly the
relationship Brave, Arc, and Edge have with Chromium.

## Not implemented yet

Deliberately left out to keep this readable:

- Bookmarks and history (needs persistent storage — `electron-store` is the easy path)
- Downloads *UI* — the safety guard exists in `privacy.js`, but there's no
  panel listing what you've downloaded
- Find-in-page, zoom
- Tab drag-to-reorder
- Per-site containers beyond the single private partition

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

## Why SearXNG sometimes returns nothing

SearXNG has no index of its own. It relays your query to Google, Bing and
others and merges what comes back — which is exactly what makes it private, and
also its weak point. Those upstreams block datacenter IPs hard. A popular public
instance gets scraped by bots until every upstream has blocked it, and from then
on it answers every query with **"No results were found."** The instance is up.
It simply has nothing left to relay.

This is a property of public instances, not a bug here, and it is why the
instance is editable from the toolbar: open the engine picker, and under SearXNG
there's a field and a row of quick picks. The choice is saved.

Counter-intuitively, **an instance that makes you pass a browser check is
usually the better bet.** That check is what protects its upstream quota, and a
real browser clears it in a second or two. An instance that lets anything
straight through is often one whose upstreams have already given up on it.

The real fix is self-hosting — your own IP, your own quota, no one else's bot
traffic. `docker run -d -p 8888:8080 searxng/searxng`, then paste
`http://localhost:8888` into the instance field. That address is explicitly
allowed; the field accepts `localhost` and bare IPs as well as public hostnames.

More instances at <https://searx.space>.

Marginalia is unaffected by all of this — it runs its own crawler and index.
Note that it takes its query in `query=`, not `q=`, which is why the new tab
page rewrites the form's field name and not just its action.

## Settings

One JSON file at `settings.json` in Electron's `userData` directory, read at
startup and written on change. No dependency: `electron-store` is ESM-only from
v11 and this project is CommonJS.

Every key has an entry in `VALIDATORS` in `main.js` and is checked on the way
in — both when the file is loaded and on every write from the UI. A key that
fails validation falls back to its default rather than being stored. So a
hand-edited or corrupted file can't inject state the rest of the app then
trusts, and the renderer can't talk main into storing something malformed.

If you add a setting, add it to **both** `DEFAULT_SETTINGS` and `VALIDATORS`.
A key with no validator is silently ignored on every write, which looks exactly
like a broken toggle.

## Two invariants across files

Alongside the colour values below, two names have to match in two places:

- `PRIVATE_PARTITION` — `main.js` accepts exactly one partition string in
  `will-attach-webview`, and `renderer.js` sets it on private tabs. If they
  drift, private tabs silently land in the ordinary, persistent cookie jar and
  look identical.
- `NO_HTTPS_ERRORS` — the Chromium error codes that mean "this site has no
  HTTPS" rather than "you're offline". Both processes decide whether to offer
  the insecure fallback, so both need the same list.

## Shortcuts live in two places on purpose

A `<webview>` is a separate renderer process, so keys pressed inside a page
never reach the `window` listener in `renderer.js`. That's why shortcuts used
to stop working the moment you clicked into a page.

`before-input-event` in `main.js` fires for whichever webContents has focus, so
it catches them all. It forwards the *intent* — `{ action: 'new-tab' }` — over
IPC, and `runAction` in `renderer.js` executes it. Both the window listener and
the IPC path go through that one table, so they can't drift apart.

Two things to keep right if you add a shortcut:

- **Add it to both `matchShortcut` in `main.js` and `shortcutFor` in
  `renderer.js`.** They must agree, or a shortcut works in one focus context
  and not the other.
- **Main only forwards for `contents.getType() === 'webview'`.** When our own
  UI has focus, the window listener already handles it; forwarding from both
  would run every shortcut twice — two tabs opened, two closed.

If an action needs to type into our UI, add it to `FOCUS_UI` in `main.js` so
the window is focused before the message is sent.

## Only one webRequest listener per session

Electron allows exactly **one** listener per `webRequest` event per session.
Registering a second silently replaces the first — no error, no warning, the
first one just stops running.

The ad blocker claims **two** of them:

| Event | Owner | Rule |
|---|---|---|
| `onBeforeRequest` | the blocker | Never touch it. |
| `onHeadersReceived` | the blocker, then us | We re-register, but we **chain**. |
| `onBeforeSendHeaders` | us | Unclaimed by the blocker. |

The chaining is the interesting part. `blocker.onHeadersReceived` is a public
method on `ElectronBlocker`, so `installHeaderPipeline()` in `privacy.js`
registers a listener that calls the blocker's handler first and then edits
whatever it hands back. Both survive: the blocker's `$csp` filter injection
*and* our `Set-Cookie` stripping. Replace it without chaining and you lose the
blocker's half with nothing to tell you.

Because the blocker loads asynchronously, the order matters:

1. The session is hardened at startup with no blocker attached.
2. The blocker finishes downloading and calls `enableBlockingInSession()`,
   which replaces our `onHeadersReceived`.
3. `main.js` immediately calls `installHeaderPipeline()` again, this time
   passing the blocker, so ours is reinstated *on top of* it.

Skip step 3 and third-party `Set-Cookie` stripping silently stops. It's the
first thing to check if a protection seems to have evaporated.

Tracking-parameter stripping stays in `renderer.js` for the same reason it
always did: the `onBeforeRequest` redirect where it would otherwise belong is
the blocker's.

## HTTPS-only lives in two processes, and it has to

`will-navigate` — where `main.js` guards navigation — **does not fire for
navigations started programmatically**. Every navigation *we* start is
programmatic: `view.loadURL()` from the omnibox, and setting a webview's `src`
when a tab is created.

So the upgrade is implemented twice, on purpose:

- **`main.js`** handles what *pages* do — link clicks, redirects,
  `window.location`.
- **`renderer.js`** handles what the *user* does — the omnibox, new tabs.

Miss either half and the upgrade quietly applies to only some navigations,
which is worse than not having it, because the padlock still looks right.

The same split applies to the exceptions list: clicking "Continue anyway" adds
the host to a session-scoped set in *both* processes, from the one click, so
they can't drift.

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
