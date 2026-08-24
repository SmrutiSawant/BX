// privacy.js — every data-protection measure in one place.
//
// Why a separate file: main.js owns the window and the app lifecycle. This
// owns *sessions* — the thing that actually touches user data. Keeping them
// apart means you can read the entire privacy posture of the browser in one
// sitting, and it makes the rule below enforceable by inspection rather than
// by memory.
//
// ===========================================================================
// THE ONE RULE THAT BREAKS EVERYTHING IF YOU GET IT WRONG
// ===========================================================================
// Electron allows exactly ONE listener per webRequest event per session.
// Registering a second silently replaces the first, with no error.
//
// The ad blocker claims TWO of them: onBeforeRequest (blocking) and
// onHeadersReceived (injecting $csp filters). So:
//
//   onBeforeRequest    — belongs to the blocker. Never touch it.
//   onHeadersReceived  — we re-register it, but we CHAIN: our listener calls
//                        the blocker's own handler first and edits whatever it
//                        hands back. See installHeaderPipeline().
//   onBeforeSendHeaders— unclaimed. Ours.
//
// If blocking ever silently stops working, this file is the first suspect.

const { webContents, dialog, app } = require('electron');
const path = require('path');

// ---------------------------------------------------------------------------
// eTLD+1 ("site")
// ---------------------------------------------------------------------------
// "Is this request third-party?" is a question about registrable domains, not
// hostnames. `a.example.co.uk` and `b.example.co.uk` are the same site;
// `example.co.uk` and `example.com` are not. Getting this right needs the
// Public Suffix List — a naive "last two labels" split says `co.uk` is a site
// and would treat every British domain as first-party to every other one.
//
// tldts ships the list and arrives with the ad blocker anyway. It's declared
// as a direct dependency in package.json because we rely on it directly; the
// fallback below only exists so a pruned node_modules degrades instead of
// crashing at startup.
let tldts = null;
try {
  tldts = require('tldts-experimental');
} catch {
  console.warn('[privacy] tldts unavailable — third-party detection is approximate');
}

function siteOf(url) {
  try {
    const { hostname } = new URL(url);
    if (!hostname) return null;
    if (tldts) return tldts.getDomain(hostname) || hostname;
    const parts = hostname.split('.');
    return parts.length <= 2 ? hostname : parts.slice(-2).join('.');
  } catch {
    return null;
  }
}

function hostOf(url) {
  try { return new URL(url).hostname || null; } catch { return null; }
}

// Names that never leave this machine, and so must never be forced to HTTPS
// or resolved over public DNS.
function isLocal(hostname) {
  if (!hostname) return false;
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h === '127.0.0.1' || h === '::1' || h.startsWith('127.')) return true;
  if (h.endsWith('.onion')) return true;              // Tor resolves these itself
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;             // link-local
  if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true;     // IPv6 unique-local
  return false;
}

// ===========================================================================
// Permissions
// ===========================================================================
// Chrome's model is to prompt, which trained everyone to click "Block" without
// reading. Ours is to deny silently and tell the *toolbar* it happened, so the
// answer is there when you want it and invisible when you don't. Nothing
// interrupts the page.

// Granted unconditionally. These are user-gesture-driven, reveal nothing about
// you, and denying them just breaks video players for no benefit.
const ALWAYS_ALLOW = new Set([
  'fullscreen',
  'pointerLock',
  'clipboard-sanitized-write',  // writing TO the clipboard; reading is separate
]);

// Everything below is denied by default and can be granted per site.
// Grouped by what it costs you if a hostile page gets it.
const PERMISSION_LABELS = {
  geolocation:                'Location',
  notifications:              'Notifications',
  media:                      'Camera and microphone',
  'display-capture':          'Screen sharing',
  midi:                       'MIDI devices',
  midiSysex:                  'MIDI (full device access)',
  'idle-detection':           'Idle detection',       // watches when you step away
  'clipboard-read':           'Clipboard reading',
  'window-management':        'Window and screen layout',
  'speaker-selection':        'Audio output devices',
  'storage-access':           'Third-party storage',
  'top-level-storage-access': 'Third-party storage',
  mediaKeySystem:             'DRM playback',         // Widevine ships a device ID
  hid:                        'HID devices',
  serial:                     'Serial ports',
  usb:                        'USB devices',
  bluetooth:                  'Bluetooth',
  fileSystem:                 'Local file access',
  openExternal:               'Opening other apps',
  keyboardLock:               'Keyboard capture',
};

// ===========================================================================
// Request-header scrubbing
// ===========================================================================

// Chromium attaches this to every request to a Google-owned domain. It encodes
// which field trials you're in — a stable, high-entropy identifier that exists
// purely for Google's benefit. There is no argument for keeping it.
const HEADER_ALWAYS_STRIP = ['x-client-data'];

// High-entropy Client Hints. The low-entropy three (sec-ch-ua, -mobile,
// -platform) are sent to everyone by default, so removing them makes you
// *more* distinctive, not less — the same trap as spoofing a user agent.
// These four are only sent when a site asks, and each one narrows you down.
const HIGH_ENTROPY_HINTS = [
  'sec-ch-ua-full-version',
  'sec-ch-ua-full-version-list',
  'sec-ch-ua-platform-version',
  'sec-ch-ua-arch',
  'sec-ch-ua-bitness',
  'sec-ch-ua-model',
  'sec-ch-ua-wow64',
  'sec-ch-ua-form-factors',
];

// Passive telemetry the site asks your browser to send about your own network
// conditions and failures, to a collector of its choosing. Not required for
// any page to render.
const RESPONSE_TELEMETRY = ['nel', 'report-to', 'reporting-endpoints'];

function findHeader(headers, name) {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return key;
  }
  return null;
}

function deleteHeader(headers, name) {
  const key = findHeader(headers, name);
  if (key === null) return false;
  delete headers[key];
  return true;
}

// ===========================================================================
// The hardening itself
// ===========================================================================

/**
 * @param {object} deps
 * @param {() => object} deps.getSettings   current settings object
 * @param {(patch: object) => void} deps.updateSettings  persist a partial update
 * @param {(channel: string, payload: any) => void} deps.notify  send to the browser UI
 */
function createPrivacy({ getSettings, updateSettings, notify }) {
  // Hostnames whose HTTPS upgrade failed and that the user chose to load over
  // plain http anyway. Kept in memory only — an exception you granted once
  // should not silently outlive the session that needed it.
  const httpsExceptions = new Set();

  // webContentsId -> the URL that failed to upgrade, so did-fail-load can tell
  // "the site has no HTTPS" apart from "the site is down".
  const pendingUpgrades = new Map();

  // ------------------------------------------------------------------
  // Permission state
  // ------------------------------------------------------------------

  function grantsFor(host) {
    const all = getSettings().sitePermissions || {};
    return all[host] || {};
  }

  function isGranted(host, permission) {
    if (ALWAYS_ALLOW.has(permission)) return true;
    if (!host) return false;
    return grantsFor(host)[permission] === true;
  }

  function setGrant(host, permission, allowed) {
    if (!host || !PERMISSION_LABELS[permission]) return;
    const all = { ...(getSettings().sitePermissions || {}) };
    const site = { ...(all[host] || {}) };
    if (allowed) site[permission] = true;
    else delete site[permission];

    if (Object.keys(site).length) all[host] = site;
    else delete all[host];

    updateSettings({ sitePermissions: all });
  }

  // ------------------------------------------------------------------
  // Header pipeline
  // ------------------------------------------------------------------

  // The top-level document a subresource request belongs to. Third-party is
  // defined relative to what's in the address bar, not to the request's own
  // referrer, which a page controls and can lie about.
  function topLevelUrlFor(details) {
    if (typeof details.webContentsId !== 'number') return null;
    try {
      const wc = webContents.fromId(details.webContentsId);
      return wc && !wc.isDestroyed() ? wc.getURL() : null;
    } catch {
      return null;
    }
  }

  function isThirdParty(details) {
    if (details.resourceType === 'mainFrame') return false;
    const top = topLevelUrlFor(details);
    if (!top) return false;                 // unknown: treat as first-party
    const a = siteOf(top);
    const b = siteOf(details.url);
    if (!a || !b) return false;
    return a !== b;
  }

  function onBeforeSendHeaders(details, callback) {
    const s = getSettings();
    const headers = { ...details.requestHeaders };

    for (const name of HEADER_ALWAYS_STRIP) deleteHeader(headers, name);

    if (s.stripClientHints) {
      for (const name of HIGH_ENTROPY_HINTS) deleteHeader(headers, name);
    }

    // Global Privacy Control is the one "please don't" signal with actual
    // legal force — California's CCPA regulations and Colorado's CPA treat it
    // as a binding opt-out of sale/sharing. DNT rides along; it's ignored
    // almost everywhere but costs a single header.
    if (s.sendGpc) {
      headers['Sec-GPC'] = '1';
      headers['DNT'] = '1';
    }

    const thirdParty = isThirdParty(details);

    // Referrer. Cross-site, the full URL tells the recipient which *page* you
    // were on — often the search you ran or the article you were reading.
    // Reducing it to the bare origin keeps the anti-CSRF and anti-hotlinking
    // checks that sites genuinely rely on, and drops the part that profiles
    // you. This is what Safari and Brave do.
    if (s.trimReferrer) {
      const key = findHeader(headers, 'referer');
      if (key !== null) {
        const referrer = headers[key];
        const from = siteOf(referrer);
        const to = siteOf(details.url);
        if (from && to && from !== to) {
          try {
            headers[key] = new URL(referrer).origin + '/';
          } catch {
            delete headers[key];
          }
        }
      }
    }

    // Third-party cookies are the mechanism behind cross-site tracking: one
    // ad network embedded on a thousand sites reads the same cookie on all of
    // them and reconstructs your browsing. Stripping the request half here;
    // the Set-Cookie half is handled in the response pipeline below.
    if (s.blockThirdPartyCookies && thirdParty) {
      deleteHeader(headers, 'cookie');
    }

    callback({ requestHeaders: headers });
  }

  function scrubResponseHeaders(details, headers) {
    const s = getSettings();
    let changed = false;

    for (const name of RESPONSE_TELEMETRY) {
      if (deleteHeader(headers, name)) changed = true;
    }

    if (s.blockThirdPartyCookies && isThirdParty(details)) {
      if (deleteHeader(headers, 'set-cookie')) changed = true;
    }

    return changed;
  }

  // The chaining described at the top of this file. Getting the shapes right
  // matters: the blocker may answer with {cancel:true}, with modified
  // responseHeaders, or with an empty object meaning "unchanged".
  function installHeaderPipeline(ses, blocker) {
    ses.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, onBeforeSendHeaders);

    const blockerHandler = blocker ? blocker.onHeadersReceived : null;

    ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
      const finish = (response) => {
        const res = response || {};
        if (res.cancel) return callback(res);

        // Start from whatever the blocker produced, falling back to what the
        // server actually sent.
        const headers = res.responseHeaders || details.responseHeaders;
        if (!headers) return callback(res);

        const copy = { ...headers };
        const changed = scrubResponseHeaders(details, copy);
        if (!changed && !res.responseHeaders) return callback(res);
        callback({ ...res, responseHeaders: copy });
      };

      if (blockerHandler) {
        try {
          blockerHandler(details, finish);
        } catch (err) {
          console.error('[privacy] blocker header handler threw:', err.message);
          finish({});
        }
      } else {
        finish({});
      }
    });
  }

  // ------------------------------------------------------------------
  // Session hardening
  // ------------------------------------------------------------------

  function hardenSession(ses, { blocker = null, isPrivate = false } = {}) {
    installHeaderPipeline(ses, blocker);

    // --- Permissions: deny, then tell the UI so it can offer to allow. ---
    ses.setPermissionRequestHandler((contents, permission, callback, details) => {
      const origin = (details && details.requestingUrl) || (contents && contents.getURL()) || '';
      const host = hostOf(origin);

      if (isGranted(host, permission)) return callback(true);

      // A private tab has no persistent identity, so a persistent grant would
      // be a contradiction. Deny outright and don't offer.
      if (!isPrivate && PERMISSION_LABELS[permission] && host) {
        notify('permission-blocked', {
          host,
          permission,
          label: PERMISSION_LABELS[permission],
          tabId: contents && !contents.isDestroyed() ? contents.id : null,
        });
      }
      callback(false);
    });

    // The synchronous twin. Without it, some APIs report themselves as
    // available and then fail at the point of use, which sites handle badly.
    ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
      if (isGranted(hostOf(requestingOrigin), permission)) return true;
      return ALWAYS_ALLOW.has(permission);
    });

    // WebUSB / WebHID / Web Serial hand a page a hardware device. Nothing a
    // web page legitimately does in this browser needs one.
    ses.setDevicePermissionHandler(() => false);
    if (typeof ses.setUSBProtectedClassesHandler === 'function') {
      ses.setUSBProtectedClassesHandler(() => []);
    }
    if (typeof ses.setBluetoothPairingHandler === 'function') {
      ses.setBluetoothPairingHandler((_details, callback) => callback({ cancel: true }));
    }

    // Screen sharing. Electron's default is to hand over a source with no
    // prompt at all if a handler isn't set — one of the few places where
    // writing no code is the insecure option.
    if (typeof ses.setDisplayMediaRequestHandler === 'function') {
      ses.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    }

    // Chromium downloads its spellcheck dictionaries from a Google host and
    // re-checks periodically. That's a phone-home tied to your language and
    // install. Off by default; the setting turns it back on.
    if (typeof ses.setSpellCheckerEnabled === 'function') {
      ses.setSpellCheckerEnabled(Boolean(getSettings().spellcheck));
    }

    // Never silently accept a bad certificate. Electron's default is already
    // to reject, but an explicit handler means a future edit has to be a
    // deliberate act rather than an accident.
    //
    // The magic numbers matter and are easy to get backwards: -3 means "use
    // Chromium's own verification result", -2 means "reject". Passing 0 would
    // mean "this certificate is FINE" — forcing every cert to validate,
    // including a forged one. Never pass 0 here.
    ses.setCertificateVerifyProc((request, callback) => {
      callback(request.errorCode === 0 ? -3 : -2);
    });

    installDownloadGuard(ses);
    return ses;
  }

  // ------------------------------------------------------------------
  // Downloads
  // ------------------------------------------------------------------
  // A download is the one moment a web page gets to write to your disk.

  const EXECUTABLE = new Set([
    '.exe', '.msi', '.msix', '.bat', '.cmd', '.com', '.scr', '.pif', '.cpl',
    '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.hta',
    '.jar', '.reg', '.lnk', '.dll', '.sys', '.app', '.dmg', '.pkg', '.deb',
    '.rpm', '.sh', '.run', '.apk', '.iso', '.img',
  ]);

  // URLs the user has explicitly confirmed once. Consulted and consumed on
  // the retry, so confirming a download doesn't loop the warning forever and
  // doesn't grant a standing exemption either.
  const allowOnce = new Set();

  function installDownloadGuard(ses) {
    ses.on('will-download', (event, item, contents) => {
      const s = getSettings();
      const name = item.getFilename() || 'download';
      const ext = path.extname(name).toLowerCase();
      const url = item.getURL();

      if (allowOnce.has(url)) {
        allowOnce.delete(url);
        return;   // already confirmed; let it through untouched
      }

      if (s.blockDangerousDownloads && EXECUTABLE.has(ext)) {
        event.preventDefault();
        const from = hostOf(url) || 'this site';
        dialog.showMessageBox({
          type: 'warning',
          buttons: ['Discard', 'Download anyway'],
          defaultId: 0,
          cancelId: 0,
          title: 'Executable download blocked',
          message: `${name}`,
          detail:
            `${from} is trying to download a program (${ext}).\n\n` +
            'Files of this type can take control of your computer when opened. ' +
            'Only continue if you went looking for this file.',
        }).then(({ response }) => {
          if (response === 1 && contents && !contents.isDestroyed()) {
            // The item is gone once prevented, so re-request it. The guard
            // above skips exactly this one URL, exactly once.
            allowOnce.add(url);
            contents.downloadURL(url);
          }
        }).catch(() => {});
        return;
      }

      // Otherwise let Electron show its native save dialog, which is what
      // askWhereToSaveDownloads means — we simply never call setSavePath().
      if (!s.askWhereToSaveDownloads) {
        item.setSavePath(path.join(app.getPath('downloads'), name));
      }
    });
  }

  // ------------------------------------------------------------------
  // HTTPS-only
  // ------------------------------------------------------------------
  // Plain http means anyone between you and the site — the café's router, the
  // ISP, whoever runs the exit hop — reads and can rewrite the page. The
  // upgrade is attempted silently; only if HTTPS genuinely isn't there does
  // the user see anything, and then it's a choice rather than a wall.

  function upgradeUrl(url) {
    const s = getSettings();
    if (!s.httpsOnly) return null;
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:') return null;
      if (isLocal(u.hostname)) return null;
      if (httpsExceptions.has(u.hostname)) return null;
      u.protocol = 'https:';
      return u.href;
    } catch {
      return null;
    }
  }

  function allowInsecure(host) {
    if (host) httpsExceptions.add(host);
  }

  function noteUpgrade(contentsId, originalUrl) {
    pendingUpgrades.set(contentsId, originalUrl);
  }

  function takeUpgrade(contentsId) {
    const url = pendingUpgrades.get(contentsId);
    pendingUpgrades.delete(contentsId);
    return url || null;
  }

  // ------------------------------------------------------------------
  // Clearing data
  // ------------------------------------------------------------------

  async function clearBrowsingData(ses) {
    try {
      await ses.clearStorageData();     // cookies, localStorage, IndexedDB, ...
      await ses.clearCache();
      await ses.clearAuthCache();
      if (typeof ses.clearHostResolverCache === 'function') {
        await ses.clearHostResolverCache();
      }
      if (typeof ses.clearCodeCaches === 'function') {
        await ses.clearCodeCaches({ urls: [] });
      }
      return true;
    } catch (err) {
      console.error('[privacy] could not clear browsing data:', err.message);
      return false;
    }
  }

  return {
    hardenSession,

    // Exposed because the ad blocker loads asynchronously. The session is
    // hardened at startup with no blocker attached, and when the blocker
    // finally arrives its enableBlockingInSession() replaces our
    // onHeadersReceived listener — so we register ours again, this time
    // chained onto the blocker's. Calling this twice is safe and intended.
    installHeaderPipeline,

    upgradeUrl,
    allowInsecure,
    noteUpgrade,
    takeUpgrade,
    clearBrowsingData,
    setGrant,
    grantsFor,
    isLocal,
    hostOf,
    siteOf,
    PERMISSION_LABELS,
  };
}

// ===========================================================================
// Command-line switches
// ===========================================================================
// These have to be set before the app is ready, which is why they live here as
// a plain function rather than inside createPrivacy().
//
// A note on --disable-features: appending the switch twice does not merge the
// lists, it REPLACES them. Every feature we want off has to go in one call, so
// this function is the only place in the codebase allowed to set it.

function applyCommandLineSwitches(app, { isWindows }) {
  const disableFeatures = [
    // Privacy Sandbox. Google's replacement for third-party cookies, which
    // relocates the profiling into the browser rather than removing it. Topics
    // labels you by interest from your browsing; Attribution Reporting and
    // Shared Storage let advertisers correlate across sites without cookies.
    'PrivacySandboxAdsAPIs',
    'BrowsingTopics',
    'InterestGroupStorage',
    'Fledge',
    'FledgeBiddingAndAuctionServer',
    'AttributionReporting',
    'AttributionReportingCrossAppWeb',
    'SharedStorageAPI',
    'FencedFrames',
    'PrivateAggregationApi',

    // Phone-home. Each of these opens a connection to Google on a schedule
    // whether or not you browse anywhere.
    'OptimizationHints',
    'OptimizationHintsFetching',
    'AutofillServerCommunication',
    'Translate',
    'MediaRouter',                  // scans your LAN for cast devices
    'InterestFeedContentSuggestions',

    // Cuts the network surface further; none of it is used by this browser.
    'AutofillEnableAccountWalletStorage',
  ];

  if (isWindows) {
    // Not privacy — Windows' occlusion check stutters a frameless window
    // while it's dragged. It has to live in this list because of the
    // replace-not-merge behaviour noted above.
    disableFeatures.push('CalculateNativeWinOcclusion');
  }

  app.commandLine.appendSwitch('disable-features', disableFeatures.join(','));

  // Third-party cookies off at the Chromium layer as well as the header layer.
  // Belt and braces: the header strip in this file handles what Chromium sends,
  // this handles what its own subsystems (storage partitioning, the cookie
  // store) consider allowed.
  app.commandLine.appendSwitch('test-third-party-cookie-phaseout');

  // <a ping="..."> fires a background POST to an arbitrary URL when you click
  // a link. It exists solely to report the click. Nothing renders differently.
  app.commandLine.appendSwitch('no-pings');

  // Variations/field-trial fetches, crash uploads, and the "domain reliability"
  // beacons Chromium sends to Google about connection failures.
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('disable-domain-reliability');
  app.commandLine.appendSwitch('disable-breakpad');
  app.commandLine.appendSwitch('disable-crash-reporter');
  app.commandLine.appendSwitch('disable-component-update');

  // WebRTC discloses your LAN address to any page that opens a peer
  // connection — the classic "VPN doesn't help you" leak, because the local
  // interface enumeration happens below the VPN. This restricts candidate
  // gathering to the single public interface.
  app.commandLine.appendSwitch('force-webrtc-ip-handling-policy',
    'default_public_interface_only');
}

// ===========================================================================
// DNS
// ===========================================================================
// Plain DNS is unencrypted, so every hostname you visit is legible to the
// network and to your ISP even when the page itself is HTTPS. DNS-over-HTTPS
// closes that.
//
// 'secure' means DoH only, with no fallback to the system resolver. That is
// the honest setting — 'automatic' silently falls back to plain DNS the moment
// anything goes wrong, which is exactly when you'd want it not to. The cost is
// that captive portals (hotel and airport wifi) can't be signed into until you
// switch this to 'automatic', which is why it's a setting and not a constant.

function configureDns(app, settings) {
  const mode = settings.dnsMode || 'secure';
  if (mode === 'off') return;

  const servers = Array.isArray(settings.dnsServers) && settings.dnsServers.length
    ? settings.dnsServers
    : ['https://dns.quad9.net/dns-query'];

  try {
    app.configureHostResolver({
      secureDnsMode: mode === 'automatic' ? 'automatic' : 'secure',
      secureDnsServers: servers,
    });
  } catch (err) {
    console.error('[privacy] DNS-over-HTTPS could not be configured:', err.message);
  }
}

// ===========================================================================
// User agent
// ===========================================================================
// Electron's default UA announces "MiniBrowser/0.1.0 Electron/32.0.0", which
// is a near-unique fingerprint — almost nobody else on the web sends it — and
// also trips server-side sniffing that has never heard of us.
//
// This is NOT user-agent spoofing in the fingerprinting sense, and the
// distinction matters. Spoofing invents a UA that contradicts the rest of what
// the browser exposes, and the contradiction is itself a signal that makes you
// *more* identifiable. This does the opposite: it removes two tokens so we
// present as the plain Chromium we actually are, joining the largest crowd on
// the web rather than standing outside it.
function neutralUserAgent(app) {
  return app.userAgentFallback
    .replace(/\s?MiniBrowser\/\S+/i, '')
    .replace(/\s?Electron\/\S+/i, '')
    .trim();
}

module.exports = {
  createPrivacy,
  applyCommandLineSwitches,
  configureDns,
  neutralUserAgent,
  PERMISSION_LABELS,
  ALWAYS_ALLOW,
  siteOf,
  isLocal,
};
