import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  nativeTheme,
  session,
  protocol,
  net,
  globalShortcut,
  dialog,
  Notification,
  nativeImage
} from 'electron'
import { join, isAbsolute, resolve as resolvePath, sep } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { dirname, basename } from 'path'
import { readdir } from 'fs/promises'
import { registerPtyHandlers, killAllPtys } from './pty'
import { registerVoiceHandlers } from './voice'
import { registerAiHandlers } from './ai'
import { log, logPath } from './logger'
import {
  registerDoctorHandlers,
  shutdownDoctor,
  isDoctorBusy,
  isDoctorSelfQuitting
} from './doctor'
import { registerUpdater, shutdownUpdater } from './updater'
import { registerCanvasHandlers } from './canvases'
import { registerFsHandlers, closeAllFsWatchers } from './fs'
import { registerWebHandlers } from './web'
import { registerYtdlpHandlers } from './ytdlp'
import { ensureUserPath } from './userPath'
import {
  porcelainStatus,
  fileDiff,
  createCheckpoint,
  listCheckpoints,
  checkpointDiff,
  restoreCheckpoint,
  isValidCheckpointSha
} from './git'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Register the custom scheme used to serve user-staged video backgrounds. This
// MUST run at the top level, BEFORE app.whenReady(). file:// is blocked by the
// renderer CSP / web-security in dev, so background videos are served over this
// privileged, fetch-able, streamable scheme instead.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'canvasio-bg',
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true }
  },
  // Scheme that serves a tiny YouTube IFrame-API player page (see the
  // `canvasio-yt` protocol.handle below). It MUST be `standard` + `secure` so the
  // page runs at a REAL secure origin (`canvasio-yt://player`) rather than the
  // opaque `null` origin of a file:// host. YouTube's IFrame API postMessage
  // handshake is keyed on window.location.origin; with an opaque origin the
  // handshake never completes and the embed returns error 150 / stays "Cargando…".
  // A real secure origin makes onReady fire and playback work.
  {
    scheme: 'canvasio-yt',
    privileges: { standard: true, secure: true, supportFetchAPI: true }
  }
])

// Allow media (the YouTube music-node <webview>) to start playing WITHOUT a prior
// user gesture. Chromium's default autoplay policy blocks programmatic play() on a
// freshly-loaded embed, so the music player would render but never actually play
// audio or advance its time. Must run at the top level, before app.whenReady().
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

// Only these URL schemes may ever be handed to the OS via shell.openExternal or
// be navigated to by guest webview content. Anything else (file:, javascript:,
// data:, custom app schemes, etc.) is a potential RCE / exfiltration vector and
// is denied. Webview popups bubble up to the main window's open handler when
// allowpopups is set, so this guard protects untrusted guest content too.
function isAllowedExternalUrl(rawUrl: string): boolean {
  try {
    const { protocol } = new URL(rawUrl)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    // Malformed URL — treat as not allowed.
    return false
  }
}

// True only when `url` belongs to the MAIN window's OWN app bundle: same http(s)
// origin in dev (localhost), or a file:// path inside the renderer dir in prod.
// Used to DENY any top-level navigation away from the app — otherwise a remote
// page loaded into the main window would inherit the preload's window.canvasio bridge.
function isSameAppOrigin(url: string): boolean {
  try {
    const current = mainWindow?.webContents.getURL()
    if (!current) return false
    const t = new URL(url)
    const c = new URL(current)
    if (c.protocol === 'file:' && t.protocol === 'file:') {
      // Restrict to the app's own renderer directory (blocks file:///etc/passwd etc.).
      const dir = c.pathname.slice(0, c.pathname.lastIndexOf('/') + 1)
      return dir.length > 1 && t.pathname.startsWith(dir)
    }
    return t.origin === c.origin
  } catch {
    return false
  }
}

// Surface fatal process-level faults into the structured runtime log so the
// Doctor can diagnose them. These handlers never re-throw.
process.on('uncaughtException', (err) => {
  log('error', 'main', 'uncaughtException', {
    message: (err as Error)?.message,
    stack: (err as Error)?.stack
  })
})
process.on('unhandledRejection', (reason) => {
  log('error', 'main', 'unhandledRejection', {
    reason: reason instanceof Error ? reason.stack : String(reason)
  })
})

// canvasio-yt:// must be served on EVERY session that can load it, not just the
// default one. The music-node <webview> uses a `persist:music-*` partition — a
// SEPARATE session — so registering the handler only on session.defaultSession
// left that partition with no handler, and canvasio-yt://player fell through to
// the OS ("No hay ninguna aplicación para abrir la URL canvasio-yt://…"). We
// therefore register lazily on the default session AND on each guest webview's
// session (in did-attach-webview), guarded so a session is only handled once.
const ytHandledSessions = new WeakSet<object>()
function ensureYtHandler(ses: typeof session.defaultSession): void {
  if (ytHandledSessions.has(ses)) return
  ytHandledSessions.add(ses)
  try {
    ses.protocol.handle('canvasio-yt', (req) => {
      try {
        const url = new URL(req.url)
        // canvasio-yt is a STANDARD scheme, so `canvasio-yt://player?v=ID` parses
        // with host="player" and pathname="/". Match the HOST (or a /player path)
        // — NOT pathname==='/player', which never matched and 404'd every load.
        if (url.hostname !== 'player' && url.pathname !== '/player') {
          return new Response('not found', { status: 404 })
        }
        // videoId arrives as ?v= and is read inside the page from
        // window.location.search — never interpolated into the HTML (no injection).
        const videoId = url.searchParams.get('v')
        if (!videoId) return new Response('bad', { status: 400 })
        return new Response(YT_PLAYER_HTML, {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Security-Policy':
              "default-src 'self'; " +
              "frame-src https://www.youtube.com https://www.youtube-nocookie.com; " +
              "script-src 'self' 'unsafe-inline' https://www.youtube.com https://s.ytimg.com; " +
              "style-src 'self' 'unsafe-inline'; " +
              "img-src https: data:; " +
              "connect-src https:;"
          }
        })
      } catch (err) {
        log('warn', 'main', 'yt:protocol-error', { error: (err as Error)?.message })
        return new Response('error', { status: 500 })
      }
    })
  } catch (err) {
    // Already handled on this session, or a registration race — safe to ignore.
    log('debug', 'main', 'yt:handler-already-registered', { error: (err as Error)?.message })
  }
}

let mainWindow: BrowserWindow | null = null
/**
 * Set true once the user confirms "Cerrar igualmente" in the Doctor-busy guard,
 * so the re-issued close bypasses the guard (prevents a re-prompt loop). Also
 * used as the fail-open path if the dialog itself errors. Reset in the window
 * 'closed' handler so a window recreated via app.on('activate') (macOS, where the
 * process survives window close) restores the guard.
 */
let forceClose = false

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1680,
    height: 1040,
    minWidth: 900,
    minHeight: 600,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 22 },
    vibrancy: 'under-window',
    visualEffectState: 'active',
    backgroundColor: '#070d1c',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      // sandbox stays OFF: electron-vite emits the preload as an ESM bundle
      // (index.mjs), and a sandboxed preload must be CommonJS — turning the
      // sandbox on makes Electron fail to load the preload ("Cannot use import
      // statement outside a module"), which leaves window.canvasio undefined and
      // white-screens the renderer. Defense-in-depth is preserved via
      // contextIsolation + nodeIntegration:false. (Enabling the sandbox would
      // require building the preload as CommonJS first — tracked as future work.)
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      backgroundThrottling: false
    }
  })

  log('info', 'main', 'window:create', { width: 1680, height: 1040 })

  mainWindow.on('ready-to-show', () => {
    log('info', 'main', 'window:ready-to-show', {})
    mainWindow?.show()
  })

  mainWindow.on('focus', () => log('debug', 'main', 'window:focus', {}))
  mainWindow.on('blur', () => log('debug', 'main', 'window:blur', {}))

  // Renderer-process faults for the MAIN window (the canvas UI itself).
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    log('error', 'renderer', 'render-process-gone', {
      reason: details.reason,
      exitCode: details.exitCode
    })
  })
  mainWindow.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
    log('error', 'renderer', 'did-fail-load', { errorCode, errorDescription, validatedURL })
  })
  mainWindow.webContents.on('unresponsive', () => log('warn', 'renderer', 'unresponsive', {}))
  mainWindow.webContents.on('responsive', () => log('info', 'renderer', 'responsive', {}))

  mainWindow.webContents.setWindowOpenHandler((details) => {
    try {
      if (isAllowedExternalUrl(details.url)) {
        shell.openExternal(details.url)
      } else {
        log('warn', 'main', 'window-open:blocked-scheme', { url: details.url })
      }
    } catch (err) {
      log('warn', 'main', 'window-open:blocked-scheme', {
        url: details.url,
        error: (err as Error)?.message
      })
    }
    return { action: 'deny' }
  })

  // Guard top-level navigation in the MAIN window: NEVER let it navigate away
  // from the app's own bundle. A remote page loaded here would inherit the
  // preload's window.canvasio bridge, so anything that is not same-app-origin is
  // blocked; http(s) targets are opened in the OS browser instead.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isSameAppOrigin(url)) return
    event.preventDefault()
    log('warn', 'main', 'will-navigate:blocked', { url })
    if (isAllowedExternalUrl(url)) shell.openExternal(url)
  })

  // will-navigate does NOT fire for HTTP 30x redirects or meta-refresh; those
  // surface as will-redirect. Apply the identical same-origin guard so a redirect
  // cannot smuggle the main window onto remote content.
  mainWindow.webContents.on('will-redirect', (event, url) => {
    if (isSameAppOrigin(url)) return
    event.preventDefault()
    log('warn', 'main', 'will-redirect:blocked', { url })
    if (isAllowedExternalUrl(url)) shell.openExternal(url)
  })

  // harden attached <webview> elements: never allow node integration and strip
  // any preload script a webview might try to load.
  // IMPORTANT: this handler must NOT touch params.partition — WebPreview nodes
  // may rely on a persistent partition so their cookies/state survive across
  // sessions. Do not delete or blank params.partition.
  mainWindow.webContents.on('will-attach-webview', (_event, webPreferences, params) => {
    log('info', 'webview', 'will-attach-webview', {
      src: (params as Record<string, unknown>).src,
      partition: (params as Record<string, unknown>).partition
    })
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    delete webPreferences.preload
    delete (params as Record<string, unknown>).preload
    // (params.partition is intentionally preserved)
  })

  // Once a guest <webview> is attached, harden ITS webContents so the untrusted
  // guest cannot navigate to or popup a non-http(s) scheme (file:, javascript:,
  // data:, custom app schemes). Popups that pass the http(s) check are opened in
  // the OS browser and denied as in-app windows.
  mainWindow.webContents.on('did-attach-webview', (_event, guestWebContents) => {
    // The music webview loads canvasio-yt://player from its OWN partition session;
    // register the scheme handler on that session too (no-op if already done).
    ensureYtHandler(guestWebContents.session)
    // Diagnostics: surface guest load failures + console output into the runtime
    // log so we can see WHY the YouTube player gets stuck (CSP, API load, etc.).
    guestWebContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
      log('warn', 'webview', 'guest:did-fail-load', { errorCode, errorDescription, validatedURL })
    })
    // Electron 37+: 'console-message' delivers a single event-details object
    // (level is now a string: 'debug'|'info'|'warning'|'error'; line is lineNumber).
    guestWebContents.on('console-message', (e) => {
      log('info', 'webview', 'guest:console', {
        level: e.level,
        message: e.message,
        line: e.lineNumber,
        sourceId: e.sourceId
      })
    })
    guestWebContents.on('will-navigate', (event, url) => {
      // Allow our OWN trusted player page (canvasio-yt://player) — the music node
      // loads it as the webview src and may re-navigate to it on a video change.
      // It is served by us and only loads the official YouTube IFrame API.
      if (!isAllowedExternalUrl(url) && !url.startsWith('canvasio-yt://')) {
        log('warn', 'webview', 'will-navigate:blocked-scheme', { url })
        event.preventDefault()
      }
    })
    // Guard server-side redirects / meta-refresh for the guest too; will-navigate
    // does not fire for those, so without this a guest could be redirected to a
    // non-http(s) scheme (file:// local file disclosure, etc.).
    guestWebContents.on('will-redirect', (event, url) => {
      if (!isAllowedExternalUrl(url) && !url.startsWith('canvasio-yt://')) {
        log('warn', 'webview', 'will-redirect:blocked-scheme', { url })
        event.preventDefault()
      }
    })
    guestWebContents.setWindowOpenHandler((details) => {
      try {
        if (isAllowedExternalUrl(details.url)) {
          shell.openExternal(details.url)
        } else {
          log('warn', 'webview', 'window-open:blocked-scheme', { url: details.url })
        }
      } catch (err) {
        log('warn', 'webview', 'window-open:blocked-scheme', {
          url: details.url,
          error: (err as Error)?.message
        })
      }
      return { action: 'deny' }
    })
  })

  // forward window resize so renderer can re-fit terminals
  mainWindow.on('resize', () => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('window:resized')
    }
  })

  // kill child PTYs before the window tears down (avoids "Object has been
  // destroyed" when node-pty emits onData/onExit after teardown).
  // If the Doctor is actively repairing/rebuilding, intercept the close and ask
  // for confirmation first so a checkpoint/edit/build is not left half-done.
  mainWindow.on('close', (event) => {
    // applyUpdate's intentional self-quit (swap + relaunch) and a user-confirmed
    // force-close both proceed untouched.
    if (forceClose || isDoctorSelfQuitting()) {
      log('info', 'main', 'window:close', {
        forced: forceClose,
        selfQuit: isDoctorSelfQuitting()
      })
      killAllPtys()
      return
    }
    if (isDoctorBusy()) {
      event.preventDefault()
      log('info', 'main', 'window:close-blocked-doctor-busy', {})
      const win = mainWindow
      if (!win || win.isDestroyed()) return
      // Modal-to-window confirm. We already preventDefault'd synchronously, so
      // resolving the async dialog afterward is safe.
      dialog
        .showMessageBox(win, {
          type: 'warning',
          buttons: ['Esperar', 'Cerrar igualmente'],
          defaultId: 0, // Esperar
          cancelId: 0, // Esc / window-close maps to Esperar
          noLink: true,
          title: 'El Doctor está trabajando',
          message: 'El Doctor está reparando/reconstruyendo.',
          detail: 'Cerrar ahora puede dejar la reparación a medias. ¿Cerrar de todas formas?'
        })
        .then(({ response }) => {
          if (response === 1) {
            // Cerrar igualmente: bypass the guard on the re-issued close.
            forceClose = true
            const w = mainWindow
            if (w && !w.isDestroyed()) w.close()
          }
          // response 0 (Esperar): do nothing — close already prevented.
        })
        .catch(() => {
          // A dialog failure must never trap the user: fail open.
          forceClose = true
          const w = mainWindow
          if (w && !w.isDestroyed()) w.close()
        })
      return
    }
    // Not busy: behave exactly as before.
    log('info', 'main', 'window:close', {})
    killAllPtys()
  })
  mainWindow.on('closed', () => {
    log('info', 'main', 'window:closed', {})
    mainWindow = null
    // Re-arm the Doctor-busy guard for any window recreated via app.on('activate')
    // (on macOS the process survives window close, so this latch must not persist).
    forceClose = false
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ---------------------------------------------------------------------------
// YouTube music-node player page.
//
// Served to the music-node <webview> over the privileged, secure `canvasio-yt`
// scheme as `canvasio-yt://player?v=<videoId>`. The page is a thin wrapper that
// loads ONLY the official YouTube IFrame API and creates a single YT.Player.
//
// Why a wrapper page instead of loading https://www.youtube.com/embed/<id>
// directly: the host renderer is a file:// document whose origin is the opaque
// `null` origin. YouTube's IFrame API completes its postMessage handshake keyed
// on window.location.origin, and an embed loaded from an opaque origin is
// rejected with error 150 (or sits forever on "Cargando…"). Because this page is
// served from `canvasio-yt://player` — a real, registered secure origin — the
// `origin` playerVar is valid, the handshake completes, onReady fires, and
// playback works.
//
// The host drives/reads the player by calling the globals this page installs
// (window.ytPlay / ytPause / ytSeek / ytSetVolume / ytGetState) via
// webview.executeJavaScript. Error 150/101 (non-embeddable video) is captured in
// onError and surfaced through ytGetState().error plus an in-page fallback.
//
// Security: the page's CSP permits only the YouTube iframe + its API/asset hosts;
// no other remote script, frame, or content can load.
const YT_PLAYER_HTML = `<!DOCTYPE html>
<html style="width:100%;height:100%;margin:0;padding:0">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    html, body { width: 100%; height: 100%; margin: 0; padding: 0; background: #0a0c14; overflow: hidden; }
    #player { width: 100%; height: 100%; border: 0; }
    #error {
      position: absolute; inset: 0; display: none;
      align-items: center; justify-content: center; text-align: center;
      padding: 12px; box-sizing: border-box;
      font-family: -apple-system, system-ui, sans-serif; font-size: 12px; color: #9aa3b2;
    }
  </style>
</head>
<body>
  <div id="player"></div>
  <div id="error"></div>
  <script>
    (function () {
      var player = null;
      var ready = false;
      var lastError = null;

      function showError(msg) {
        var e = document.getElementById('error');
        if (e) { e.textContent = msg; e.style.display = 'flex'; }
        var p = document.getElementById('player');
        if (p) { p.style.display = 'none'; }
      }
      // Error UI with a clickable "Abrir en YouTube" link (opens the watch page in
      // the OS browser via the host's window-open handler). Built with DOM nodes so
      // the videoId is never injected as raw HTML.
      function showErrorWithLink(msg, vid) {
        var e = document.getElementById('error');
        if (e) {
          e.textContent = '';
          var span = document.createElement('div');
          span.textContent = msg;
          e.appendChild(span);
          if (vid) {
            var a = document.createElement('a');
            a.href = 'https://www.youtube.com/watch?v=' + encodeURIComponent(vid);
            a.target = '_blank';
            a.rel = 'noopener';
            a.textContent = 'Abrir en YouTube';
            a.style.cssText = 'display:inline-block;margin-top:8px;color:#ff7a3d;text-decoration:underline;cursor:pointer';
            e.appendChild(a);
          }
          e.style.display = 'flex';
          e.style.flexDirection = 'column';
        }
        var p = document.getElementById('player');
        if (p) { p.style.display = 'none'; }
      }
      function clearError() {
        var e = document.getElementById('error');
        if (e) { e.style.display = 'none'; }
        var p = document.getElementById('player');
        if (p) { p.style.display = 'block'; }
      }

      // The videoId arrives as the ?v= query param of canvasio-yt://player.
      function videoIdFromUrl() {
        try { return new URLSearchParams(window.location.search).get('v') || ''; }
        catch (_) { return ''; }
      }

      window.onYouTubeIframeAPIReady = function () {
        var videoId = videoIdFromUrl();
        if (!videoId) { showError('No video ID provided'); return; }
        player = new YT.Player('player', {
          videoId: videoId,
          width: '100%',
          height: '100%',
          playerVars: {
            autoplay: 1,
            playsinline: 1,
            controls: 1,
            rel: 0,
            fs: 0,
            modestbranding: 1,
            // Must match this page's real secure origin for the API handshake.
            origin: window.location.origin,
            // A real referring page helps YouTube allow the embed for more videos
            // (reduces the spurious 150/153 embedding rejections).
            widget_referrer: 'https://www.youtube.com'
          },
          events: {
            onReady: function (ev) {
              ready = true;
              try { ev.target.setVolume(70); } catch (_) {}
            },
            onError: function (ev) {
              lastError = ev && typeof ev.data === 'number' ? ev.data : -1;
              // 101/150/151/152/153 all mean "the owner disabled embedding for this
              // video" — there is no legitimate bypass; offer to open it on YouTube.
              var restricted = (lastError === 101 || lastError === 150 ||
                lastError === 151 || lastError === 152 || lastError === 153);
              var msg = restricted
                ? 'Este vídeo no permite reproducirse aquí (lo restringe su autor).'
                : 'No se pudo cargar el vídeo (error ' + lastError + ').';
              showErrorWithLink(msg, videoIdFromUrl());
            }
          }
        });
      };

      // ---- Public control surface (called via webview.executeJavaScript) ----
      window.ytPlay = function () { try { player && player.playVideo && player.playVideo(); } catch (_) {} };
      window.ytPause = function () { try { player && player.pauseVideo && player.pauseVideo(); } catch (_) {} };
      window.ytSeek = function (t) { try { player && player.seekTo && player.seekTo(Number(t) || 0, true); } catch (_) {} };
      window.ytSetVolume = function (vol) {
        try {
          if (!player) return;
          if (player.unMute) player.unMute();
          if (player.setVolume) player.setVolume(Math.max(0, Math.min(100, Math.round(Number(vol) || 0))));
        } catch (_) {}
      };
      window.ytLoad = function (id) {
        try {
          if (player && player.loadVideoById) { lastError = null; clearError(); player.loadVideoById(String(id)); }
        } catch (_) {}
      };
      // Single read used by the host's poll loop.
      window.ytGetState = function () {
        try {
          if (!player || !ready) return null;
          var st = player.getPlayerState ? player.getPlayerState() : -1;
          var data = player.getVideoData ? player.getVideoData() : null;
          return {
            currentTime: player.getCurrentTime ? player.getCurrentTime() : 0,
            duration: player.getDuration ? player.getDuration() : 0,
            // YT states: 1 PLAYING, 3 BUFFERING => not paused; 0 ENDED, 2 PAUSED, etc.
            paused: !(st === 1 || st === 3),
            playerState: st,
            ended: st === 0,
            error: lastError,
            title: (data && data.title) || ''
          };
        } catch (_) { return null; }
      };

      // Load ONLY the official IFrame API.
      var tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(tag);
    })();
  </script>
</body>
</html>`

app.whenReady().then(async () => {
  log('info', 'main', 'app:ready', { logPath: logPath(), platform: process.platform })
  nativeTheme.themeSource = 'dark'

  // Dev-only: in production the .app bundle carries icon.icns, so the Dock shows
  // the orb. Running `electron-vite dev` launches the generic Electron binary
  // (no bundle), so macOS would otherwise show Electron's default icon. The
  // BrowserWindow `icon` option does NOT affect the macOS Dock — app.dock.setIcon
  // is the only way. We use build/icon-dev.png: the square master (icon.png) with
  // the macOS squircle mask + 10% margin baked in, since macOS does NOT auto-round
  // dock icons set this way. (Production keeps using the committed icon.icns.)
  if (process.platform === 'darwin' && !app.isPackaged) {
    const dockIcon = nativeImage.createFromPath(join(__dirname, '../../build/icon-dev.png'))
    if (!dockIcon.isEmpty()) app.dock?.setIcon(dockIcon)
  }

  // CRITICAL (packaged app): merge the user's interactive-login PATH into
  // process.env BEFORE any spawn-based handler is registered. A Finder-launched
  // .app inherits a minimal PATH (no ~/.zshrc), so claude/node/npm/codex would
  // otherwise be unresolvable for ai/doctor/repair-loop. Short timeout +
  // fallback inside; awaited so all later spawns see the merged PATH.
  await ensureUserPath()

  // Electron denies getUserMedia (microphone / media capture) by default, which
  // breaks the in-app speech-to-text. Grant media/microphone permissions here so
  // the renderer can record from the mic.
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    // Deny media/mic to untrusted <webview> guests (e.g. WebPreview pages);
    // only the trusted host renderer needs the mic for in-app STT.
    if (wc?.getType?.() === 'webview') return callback(false)
    const p = permission as string
    callback(p === 'media' || p === 'microphone')
  })
  session.defaultSession.setPermissionCheckHandler((wc, permission) => {
    if (wc?.getType?.() === 'webview') return false
    const p = permission as string
    if (p === 'media' || p === 'microphone') return true
    return false
  })

  // ---------------------------------------------------------------------------
  // Selectable video backgrounds.
  //
  // The user stages videos in a managed folder under userData/backgrounds:
  //   <id>.mp4        normal loop (audio stripped)
  //   <id>.boom.mp4   optional forward+reverse boomerang variant
  // These are served to the renderer over the privileged `canvasio-bg` scheme
  // (registered above) and enumerated via the `bg:list` IPC.
  // ---------------------------------------------------------------------------
  const bgDir = join(app.getPath('userData'), 'backgrounds')

  // Serve canvasio-bg://local/<file> from inside bgDir. Only bare basenames are
  // accepted (no traversal, no separators) so the renderer can never escape the
  // backgrounds folder. The handler never throws; on bad input it returns a
  // non-200 Response so the renderer's <video> onError fallback fires.
  protocol.handle('canvasio-bg', (req) => {
    try {
      const { pathname } = new URL(req.url)
      const file = decodeURIComponent(pathname.replace(/^\/+/, ''))
      if (
        !file ||
        file.includes('/') ||
        file.includes('\\') ||
        file.includes('..') ||
        basename(file) !== file
      ) {
        return new Response('bad', { status: 400 })
      }
      const full = join(bgDir, file)
      return net.fetch(pathToFileURL(full).toString())
    } catch (err) {
      log('warn', 'main', 'bg:protocol-error', { error: (err as Error)?.message })
      return new Response('error', { status: 500 })
    }
  })

  // Serve canvasio-yt://player?v=<videoId> on the DEFAULT session (the music-node
  // webview partitions get it registered in did-attach-webview). See
  // ensureYtHandler above for why per-session registration is required.
  ensureYtHandler(session.defaultSession)

  // Enumerate available backgrounds. Returns one entry per <id>.mp4 (excluding
  // *.boom.mp4), with hasBoom true iff the matching <id>.boom.mp4 also exists
  // and hasThumb true iff a matching <id>.jpg poster thumbnail also exists.
  // Sorted by id ascending. Never throws — returns [] on any error.
  ipcMain.handle(
    'bg:list',
    async (): Promise<
      Array<{ id: string; name: string; hasBoom: boolean; hasThumb: boolean }>
    > => {
      try {
        const entries = await readdir(bgDir)
        const boomBases = new Set<string>()
        const thumbBases = new Set<string>()
        const baseIds: string[] = []
        for (const f of entries) {
          if (f.endsWith('.boom.mp4')) {
            boomBases.add(f.slice(0, -'.boom.mp4'.length))
          } else if (f.endsWith('.jpg')) {
            thumbBases.add(f.slice(0, -'.jpg'.length))
          }
        }
        for (const f of entries) {
          if (f.endsWith('.mp4') && !f.endsWith('.boom.mp4')) {
            baseIds.push(f.slice(0, -'.mp4'.length))
          }
        }
        return baseIds
          .sort((a, b) => a.localeCompare(b))
          .map((id) => ({
            id,
            name: id
              .split(/[-_]+/)
              .filter(Boolean)
              .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
              .join(' ') || id,
            hasBoom: boomBases.has(id),
            hasThumb: thumbBases.has(id)
          }))
      } catch (err) {
        log('warn', 'main', 'bg:list:error', { error: (err as Error)?.message ?? String(err) })
        return []
      }
    }
  )

  registerPtyHandlers(() => mainWindow)
  registerVoiceHandlers(() => mainWindow)
  registerAiHandlers(() => mainWindow)
  registerDoctorHandlers(() => mainWindow)

  // yt-dlp resolver for the YouTube Music node. Adds ytdlp:resolve — resolves a
  // validated 11-char video id to a playable progressive stream URL + title +
  // duration (or a structured failure). ensureUserPath() ran above, so a yt-dlp
  // install on the login PATH resolves. Handler never throws across IPC.
  void registerYtdlpHandlers()

  // Multi-Canvas Workspace: fs-backed canvas document store under
  // <userData>/canvases. Adds canvases:list/read/write/delete/rename. Each
  // handler is fully guarded (never throws across IPC). No window ref needed.
  registerCanvasHandlers()

  // File-system bridge for Markdown note + Folder browser nodes. Adds
  // fs:read/write/list/exists + fs:watch:start/stop (live-reload via
  // fs:changed:<token>). Every handler is fully guarded (never throws across
  // IPC) and all caller paths are validated against their base folder.
  registerFsHandlers(() => mainWindow)

  // Voice web lookup bridge: web:answer(query) → weather (wttr.in) + internet
  // facts (DuckDuckGo) so the voice agent can SPEAK an answer without opening a
  // web node. Native net.fetch, hard timeout, never throws across IPC.
  registerWebHandlers()

  // Auto-update bridge for the INSTALLED app. Graceful no-op in dev / when
  // CANVASIO_DISABLE_UPDATER is set. Never throws.
  registerUpdater(() => mainWindow)

  // Renderer-origin structured log sink. Main stamps the ts and FORCES the
  // category to 'renderer' (or 'action') so the renderer can't spoof a main
  // category. Never throws.
  ipcMain.handle(
    'log:write',
    (_e, entry: { level?: string; cat?: string; msg?: string; data?: unknown }) => {
      try {
        const level = (
          ['debug', 'info', 'warn', 'error'].includes(entry?.level as string)
            ? entry.level
            : 'info'
        ) as 'debug' | 'info' | 'warn' | 'error'
        const cat = entry?.cat === 'action' ? 'action' : 'renderer'
        const msg = typeof entry?.msg === 'string' ? entry.msg : ''
        log(level, cat, msg, entry?.data)
      } catch {
        /* never throw */
      }
    }
  )

  ipcMain.handle('app:platform', () => process.platform)
  ipcMain.handle('app:home', () => app.getPath('home'))

  // Native folder picker for a canvas working folder (cwd). Opens the OS
  // directory chooser (allowing creation of a new folder) and resolves to the
  // chosen absolute path, or null on cancel/error. Mirrors the never-throw
  // discipline of the other handlers: any failure falls open to null.
  ipcMain.handle('app:chooseFolder', async (): Promise<string | null> => {
    try {
      const opts = {
        properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
        title: 'Carpeta del lienzo'
      }
      const res = mainWindow
        ? await dialog.showOpenDialog(mainWindow, opts)
        : await dialog.showOpenDialog(opts)
      if (res.canceled || !res.filePaths?.[0]) return null
      return res.filePaths[0]
    } catch {
      return null
    }
  })

  // Away Alerts — native OS notification + dock-badge bridge. The renderer (its
  // away-gated, debounced watcher in App.tsx) is the ONLY caller; everything here
  // is fire-and-forget (ipcMain.on, not handle) and wrapped so it can NEVER throw
  // across IPC or crash the main process. On unsupported platforms / contexts the
  // guards (Notification.isSupported / app.dock) make every call a graceful no-op.
  //
  // Clicking the notification shows + focuses the window, clears the dock badge,
  // and asks the renderer to fly the camera to the agent (notify:focus-node) via
  // the existing centerOnNode flow — so an alert is actionable, not just informative.
  ipcMain.on(
    'notify:agent',
    (_e, payload: { title?: unknown; body?: unknown; nodeId?: unknown; count?: unknown }) => {
      try {
        if (!Notification.isSupported()) return
        const title = typeof payload?.title === 'string' ? payload.title.slice(0, 120) : ''
        const body = typeof payload?.body === 'string' ? payload.body.slice(0, 200) : ''
        if (!title) return
        const nodeId = typeof payload?.nodeId === 'string' ? payload.nodeId : ''
        const count =
          typeof payload?.count === 'number' && Number.isFinite(payload.count) && payload.count > 0
            ? Math.floor(payload.count)
            : 0
        // Reflect the pending-agent count on the dock (macOS only; no-op elsewhere).
        try {
          app.dock?.setBadge(count > 0 ? String(count) : '')
        } catch {
          /* dock badge is best-effort */
        }
        const n = new Notification({ title, body, silent: false })
        n.on('click', () => {
          try {
            const w = mainWindow
            if (w && !w.isDestroyed()) {
              if (w.isMinimized()) w.restore()
              w.show()
              w.focus()
            }
            try {
              app.dock?.setBadge('')
            } catch {
              /* best-effort */
            }
            if (nodeId && w && !w.isDestroyed() && !w.webContents.isDestroyed()) {
              w.webContents.send('notify:focus-node', nodeId)
            }
          } catch {
            /* never throw inside a notification callback */
          }
        })
        n.show()
        log('debug', 'main', 'notify:agent', { count })
      } catch (err) {
        log('warn', 'main', 'notify:agent.error', {
          message: String((err as Error)?.message || err)
        })
      }
    }
  )

  ipcMain.on('notify:clearBadge', () => {
    try {
      app.dock?.setBadge('')
    } catch {
      /* best-effort; no-op on non-macOS */
    }
  })

  // Changeset Lens — read-only git bridge. Each handler is wrapped so it can
  // NEVER throw across IPC: on any failure it resolves to null and the renderer
  // simply shows nothing (no badge / no diff). The helpers themselves never
  // write to the repo. See src/main/git.ts for the full safety contract.
  ipcMain.handle('git:status', async (_e, cwd: unknown) => {
    try {
      return await porcelainStatus(cwd)
    } catch {
      return null
    }
  })
  ipcMain.handle('git:diff', async (_e, payload: { cwd?: unknown; path?: unknown }) => {
    try {
      return await fileDiff(payload?.cwd, payload?.path)
    } catch {
      return null
    }
  })
  // Read-only "reveal/open file": shows the file in the OS file manager. Uses
  // shell.showItemInFolder on an ABSOLUTE path joined from a validated cwd +
  // repo-relative path. Never writes; returns false on any failure.
  ipcMain.handle(
    'git:revealFile',
    (_e, payload: { cwd?: unknown; path?: unknown }): boolean => {
      try {
        const cwd = payload?.cwd
        const rel = payload?.path
        if (typeof cwd !== 'string' || !cwd.trim()) return false
        if (typeof rel !== 'string' || !rel.trim()) return false
        // Containment guard (mirrors git.ts fileDiff): the path is a repo-relative
        // changeset entry, so reject absolute paths or `../` traversal that would
        // resolve OUTSIDE cwd. Without this a renderer-supplied path could reveal
        // an arbitrary filesystem location in Finder (e.g. '../../../../etc').
        if (isAbsolute(rel)) return false
        const root = resolvePath(cwd)
        const abs = resolvePath(root, rel)
        if (abs !== root && !abs.startsWith(root + sep)) return false
        shell.showItemInFolder(abs)
        return true
      } catch {
        return false
      }
    }
  )

  // Checkpoints — one-key restorable savepoints per agent. Capture/list/diff are
  // non-mutating reads over the read-only-by-construction git helpers; each
  // resolves to null/[] on any failure so the renderer simply shows nothing. The
  // ONLY mutating call (restore -> `git stash apply`) is routed through the SAME
  // confirm-to-act modal pattern the Doctor uses for risky operations, so it is
  // never silent. See src/main/git.ts for the full safety contract.
  ipcMain.handle('git:checkpoint:create', async (_e, payload: { cwd?: unknown; label?: unknown }) => {
    try {
      return await createCheckpoint(payload?.cwd, payload?.label)
    } catch {
      return null
    }
  })
  ipcMain.handle('git:checkpoint:list', async (_e, cwd: unknown) => {
    try {
      return await listCheckpoints(cwd)
    } catch {
      return null
    }
  })
  ipcMain.handle('git:checkpoint:diff', async (_e, payload: { cwd?: unknown; sha?: unknown }) => {
    try {
      return await checkpointDiff(payload?.cwd, payload?.sha)
    } catch {
      return null
    }
  })
  ipcMain.handle(
    'git:checkpoint:restore',
    async (
      _e,
      payload: { cwd?: unknown; sha?: unknown; label?: unknown }
    ): Promise<{ ok: boolean; conflicted: boolean }> => {
      try {
        const cwd = payload?.cwd
        const sha = payload?.sha
        if (typeof cwd !== 'string' || !cwd.trim()) return { ok: false, conflicted: false }
        if (!isValidCheckpointSha(sha)) return { ok: false, conflicted: false }
        // Confirm-to-act gate (mirrors the Doctor close/rebuild confirmation):
        // restoring overwrites the agent's CURRENT working tree with the saved
        // state, so never do it silently. A dialog failure fails CLOSED (no
        // mutation) — the opposite of the close guard, because the unsafe outcome
        // here is acting, not waiting.
        const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
        const shortLabel =
          typeof payload?.label === 'string' && payload.label.trim()
            ? payload.label.trim()
            : sha.slice(0, 12)
        const opts = {
          type: 'warning' as const,
          buttons: ['Cancelar', 'Restaurar'],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          title: 'Restaurar checkpoint',
          message: `¿Restaurar el checkpoint "${shortLabel}"?`,
          detail:
            'Esto aplicará el estado guardado sobre el árbol de trabajo ACTUAL del agente (git stash apply). El checkpoint se conserva. Puede generar conflictos si el agente ya cambió esos archivos.'
        }
        let response = 0
        try {
          const res = win
            ? await dialog.showMessageBox(win, opts)
            : await dialog.showMessageBox(opts)
          response = res.response
        } catch {
          return { ok: false, conflicted: false }
        }
        if (response !== 1) return { ok: false, conflicted: false }
        log('info', 'main', 'checkpoint:restore', { sha })
        return await restoreCheckpoint(cwd, sha)
      } catch {
        return { ok: false, conflicted: false }
      }
    }
  )

  createWindow()

  // Optional global quick-voice toggle (works even when the app is unfocused).
  // ⌘/Ctrl+⇧+V is uncommon system-wide, so it should not clash with copy/paste/
  // save/Spotlight. Routed to the renderer's single toggle path via IPC.
  try {
    const ok = globalShortcut.register('CommandOrControl+Shift+V', () => {
      const w = mainWindow
      if (w && !w.isDestroyed() && !w.webContents.isDestroyed()) {
        try {
          w.webContents.send('voice:toggle')
        } catch {
          /* never throw inside shortcut callback */
        }
      }
    })
    log('info', 'main', 'voice:globalShortcut', { accelerator: 'CmdOrCtrl+Shift+V', registered: ok })
  } catch (err) {
    log('warn', 'main', 'voice:globalShortcut.error', { message: String((err as Error)?.message || err) })
  }

  app.on('activate', () => {
    log('info', 'main', 'app:activate', { windows: BrowserWindow.getAllWindows().length })
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  log('info', 'main', 'app:window-all-closed', {})
  killAllPtys()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  // Guard non-window quit triggers while the Doctor is busy. applyUpdate's own
  // relaunch (isDoctorSelfQuitting) and a user-confirmed force-quit pass through.
  if (!forceClose && !isDoctorSelfQuitting() && isDoctorBusy()) {
    event.preventDefault()
    log('info', 'main', 'app:before-quit-blocked-doctor-busy', {})
    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
    const opts = {
      type: 'warning' as const,
      buttons: ['Esperar', 'Cerrar igualmente'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'El Doctor está trabajando',
      message: 'El Doctor está reparando/reconstruyendo.',
      detail: 'Cerrar ahora puede dejar la reparación a medias. ¿Cerrar de todas formas?'
    }
    const handle = (response: number): void => {
      if (response === 1) {
        forceClose = true
        app.quit()
      }
    }
    const promise = parent
      ? dialog.showMessageBox(parent, opts)
      : dialog.showMessageBox(opts)
    promise
      .then(({ response }) => handle(response))
      .catch(() => {
        // Fail open so a dialog error can never trap the user.
        forceClose = true
        app.quit()
      })
    return
  }
  log('info', 'main', 'app:before-quit', {})
  globalShortcut.unregisterAll()
  killAllPtys()
  closeAllFsWatchers()
  shutdownDoctor()
  shutdownUpdater()
})
