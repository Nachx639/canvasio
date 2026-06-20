import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { log } from './logger'

/**
 * electron-updater wiring for CanvasIO.
 *
 * The INSTALLED .app receives CI-gated Doctor repairs as real auto-updates from
 * the GitHub releases of Nachx639/canvasio (configured via electron-builder.yml
 * publish + the github provider that electron-updater auto-reads from
 * app-update.yml baked into the packaged app).
 *
 * Contract (authoritative across agents):
 *
 *   IPC (renderer -> main, invoke):
 *     'updater:check'   () => Promise<void>   autoUpdater.checkForUpdates (guarded)
 *     'updater:install' () => Promise<void>   autoUpdater.quitAndInstall  (guarded)
 *
 *   Events (main -> renderer, send to the focused window ?? the provided window):
 *     'updater:available'  payload version:string
 *     'updater:progress'   payload percent:number (0-100, rounded)
 *     'updater:downloaded' payload version:string
 *     'updater:error'      payload message:string
 *
 * Guards:
 *   - Graceful NO-OP when !app.isPackaged (dev) or when CANVASIO_DISABLE_UPDATER set:
 *     IPC handlers still register (so the renderer can call them harmlessly) but
 *     do nothing, and no autoUpdater listeners / checks are wired.
 *   - autoDownload = true. Check on launch + every ~30 min.
 *   - Every send is guarded against a destroyed window / webContents.
 *   - NOTHING in this module ever throws out to the caller.
 *
 * PRIVATE-REPO CAVEAT: reading releases from the private canvasio repo at runtime
 * needs a GH_TOKEN in the app's environment (electron-updater honors GH_TOKEN);
 * otherwise publish to a public repo. This is a deployment concern, not a code one.
 */

// ~30 minutes between background update checks.
const CHECK_INTERVAL_MS = 30 * 60 * 1000

let pollTimer: ReturnType<typeof setInterval> | null = null
let wired = false

// Minimal structural type for the bits of electron-updater's autoUpdater we touch.
// Avoids a hard type-only coupling to the package's exported types while keeping
// the access sites type-checked.
type AutoUpdaterLike = {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  logger: unknown
  checkForUpdates: () => Promise<unknown>
  quitAndInstall: () => void
  on: (event: string, listener: (...args: unknown[]) => void) => unknown
}

/**
 * Obtain electron-updater's `autoUpdater` instance, NON-NULL, or `null`.
 *
 * electron-updater is a CommonJS package that exposes `autoUpdater` via a
 * `Object.defineProperty(exports, 'autoUpdater', { get })` getter. Under this
 * project's ESM runtime ("type":"module" + dynamic `import()`), Node's
 * CJS named-export detection (cjs-module-lexer) does NOT statically see that
 * getter, so the ESM namespace's `autoUpdater` binding can be `undefined` while
 * the real value lives on `namespace.default.autoUpdater`. Destructuring
 * `const { autoUpdater } = await import(...)` therefore yields `undefined`, and
 * the first config write (`autoUpdater.autoDownload = true`) throws
 * "Cannot set properties of undefined (setting 'autoDownload')".
 *
 * Resolve from the named export, falling back to `.default`, and only return a
 * value that is actually present. Never throws.
 */
async function loadAutoUpdater(): Promise<AutoUpdaterLike | null> {
  try {
    const mod = (await import('electron-updater')) as unknown as {
      autoUpdater?: AutoUpdaterLike
      default?: { autoUpdater?: AutoUpdaterLike }
    }
    const au = mod?.autoUpdater ?? mod?.default?.autoUpdater ?? null
    return au && typeof au === 'object' ? au : null
  } catch (err) {
    log('warn', 'main', 'updater:import-failed', {
      message: (err as Error)?.message
    })
    return null
  }
}

/**
 * Resolve a GitHub token for fetching releases from the PRIVATE canvasio repo and
 * expose it to electron-updater via process.env.GH_TOKEN (the github provider reads
 * GH_TOKEN at request time). Resolution order:
 *   1. process.env.GH_TOKEN || process.env.GITHUB_TOKEN (already in env -> nothing to do).
 *   2. macOS keychain generic password (service 'canvasio-gh-token'), read at runtime
 *      so no token is ever embedded in the bundle.
 *
 * Best-effort: wrapped in try/catch, NEVER throws, and NEVER logs the token value.
 */
function resolvePrivateRepoToken(): void {
  try {
    // 1. Already provided via environment.
    const fromEnv = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
    if (fromEnv && fromEnv.trim()) {
      // Ensure electron-updater's expected var is populated even if only
      // GITHUB_TOKEN was set.
      if (!process.env.GH_TOKEN) process.env.GH_TOKEN = fromEnv.trim()
      log('info', 'main', 'updater:token:source', { source: 'env' })
      return
    }

    // 2. macOS keychain (read at runtime; never embedded in the bundle).
    if (process.platform !== 'darwin') {
      log('info', 'main', 'updater:token:absent', { reason: 'non-darwin-no-env' })
      return
    }

    const res = spawnSync(
      'security',
      ['find-generic-password', '-s', 'canvasio-gh-token', '-w'],
      { encoding: 'utf8' }
    )

    const token = typeof res.stdout === 'string' ? res.stdout.trim() : ''
    if (res.status === 0 && token) {
      process.env.GH_TOKEN = token
      log('info', 'main', 'updater:token:source', { source: 'keychain' })
    } else {
      log('warn', 'main', 'updater:token:absent', {
        reason: 'keychain-miss',
        status: res.status ?? null
      })
    }
  } catch (err) {
    // Never throw out of token resolution; never log the token value.
    log('warn', 'main', 'updater:token:error', {
      message: (err as Error)?.message
    })
  }
}

/** Is the updater active for this process (packaged + not explicitly disabled)? */
function updaterActive(): boolean {
  if (process.env.CANVASIO_DISABLE_UPDATER) return false
  try {
    return app.isPackaged
  } catch {
    return false
  }
}

/**
 * True when this bundle has the electron-builder `app-update.yml` baked in (the
 * file electron-updater itself reads to learn its publish provider). It is
 * ABSENT in local `electron-builder --dir` / unpublished builds — checking for
 * it before calling checkForUpdates() lets us skip gracefully instead of letting
 * electron-updater throw a noisy ENOENT. Never throws; returns false on error.
 */
function hasUpdateConfig(): boolean {
  try {
    return existsSync(join(process.resourcesPath, 'app-update.yml'))
  } catch {
    return false
  }
}

/**
 * Send an event to the focused window, falling back to the provided window.
 * Guarded against destroyed windows / webContents. Never throws.
 */
function sendToRenderer(
  getWindow: () => BrowserWindow | null,
  channel: string,
  payload: unknown
): void {
  try {
    const target = BrowserWindow.getFocusedWindow() ?? getWindow()
    if (!target || target.isDestroyed()) return
    const wc = target.webContents
    if (!wc || wc.isDestroyed()) return
    wc.send(channel, payload)
  } catch (err) {
    // Best-effort: log but never throw.
    try {
      log('warn', 'main', 'updater:send-failed', {
        channel,
        message: (err as Error)?.message
      })
    } catch {
      /* ignore */
    }
  }
}

/**
 * Register updater IPC + autoUpdater listeners.
 *
 * `getWindow` returns the current main window (or null). Events are delivered to
 * BrowserWindow.getFocusedWindow() ?? getWindow().
 *
 * In DEV / disabled mode this only registers no-op IPC handlers so the renderer
 * bridge stays callable; it wires no autoUpdater behavior. Never throws.
 */
export function registerUpdater(getWindow: () => BrowserWindow | null): void {
  // Always register IPC so window.canvasio.updater.{check,install} resolve cleanly,
  // even in dev where they intentionally do nothing.
  if (!ipcMain.eventNames().includes('updater:check')) {
    ipcMain.handle('updater:check', async () => {
      if (!updaterActive()) {
        log('debug', 'main', 'updater:check:noop', { reason: 'dev-or-disabled' })
        return
      }
      if (!hasUpdateConfig()) {
        log('info', 'main', 'updater:skipped-local-build', {
          op: 'check',
          message: 'actualizaciones no disponibles en build local'
        })
        return
      }
      try {
        const autoUpdater = await loadAutoUpdater()
        if (!autoUpdater) {
          log('warn', 'main', 'updater:unavailable', { op: 'check' })
          return
        }
        log('info', 'main', 'updater:check', {})
        await autoUpdater.checkForUpdates()
      } catch (err) {
        log('warn', 'main', 'updater:check:error', {
          message: (err as Error)?.message
        })
        sendToRenderer(getWindow, 'updater:error', (err as Error)?.message ?? 'check failed')
      }
    })
  }

  if (!ipcMain.eventNames().includes('updater:install')) {
    ipcMain.handle('updater:install', async () => {
      if (!updaterActive()) {
        log('debug', 'main', 'updater:install:noop', { reason: 'dev-or-disabled' })
        return
      }
      try {
        const autoUpdater = await loadAutoUpdater()
        if (!autoUpdater) {
          log('warn', 'main', 'updater:unavailable', { op: 'install' })
          return
        }
        log('info', 'main', 'updater:install', {})
        autoUpdater.quitAndInstall()
      } catch (err) {
        log('warn', 'main', 'updater:install:error', {
          message: (err as Error)?.message
        })
        sendToRenderer(getWindow, 'updater:error', (err as Error)?.message ?? 'install failed')
      }
    })
  }

  if (!updaterActive()) {
    log('info', 'main', 'updater:disabled', {
      packaged: (() => {
        try {
          return app.isPackaged
        } catch {
          return false
        }
      })(),
      envDisabled: !!process.env.CANVASIO_DISABLE_UPDATER
    })
    return
  }

  // Avoid wiring autoUpdater listeners / timers more than once.
  if (wired) return
  wired = true

  // Wire autoUpdater asynchronously so a missing/broken dependency never throws
  // synchronously out of registration. All wiring is best-effort.
  void (async () => {
    try {
      // Resolve a GH token for the PRIVATE canvasio releases BEFORE obtaining +
      // configuring autoUpdater (the github provider reads GH_TOKEN at request
      // time). Best-effort, never throws, never logs the token value.
      resolvePrivateRepoToken()

      // Obtain autoUpdater and ensure it is NON-NULL before ANY configuration.
      const autoUpdater = await loadAutoUpdater()
      if (!autoUpdater) {
        // electron-updater unavailable / shape unexpected: degrade gracefully.
        // Never throw, never emit 'wire-failed' for this expected condition.
        wired = false
        log('warn', 'main', 'updater:unavailable', { op: 'wire' })
        return
      }

      // Local / unpublished build: no app-update.yml is baked in, so the
      // 'github' provider electron-updater expects is absent and any check would
      // throw ENOENT. Skip wiring entirely (no logger, no 'error' listener, no
      // checkForUpdates) so the benign condition logs a single info line instead
      // of polluting the runtime log with errors the Doctor would chase. Leave
      // `wired = true`: a packaged bundle cannot gain the file at runtime, so we
      // must not retry.
      if (!hasUpdateConfig()) {
        log('info', 'main', 'updater:skipped-local-build', {
          message: 'actualizaciones no disponibles en build local'
        })
        return
      }

      // Forward electron-updater's logging into our structured runtime log so
      // the Doctor can see update activity.
      try {
        autoUpdater.logger = {
          info: (m: unknown) => log('info', 'main', 'updater:lib', { m: String(m) }),
          warn: (m: unknown) => log('warn', 'main', 'updater:lib', { m: String(m) }),
          error: (m: unknown) => log('error', 'main', 'updater:lib', { m: String(m) }),
          debug: (m: unknown) => log('debug', 'main', 'updater:lib', { m: String(m) })
        } as unknown as typeof autoUpdater.logger
      } catch {
        /* logger assignment is optional */
      }

      autoUpdater.autoDownload = true
      autoUpdater.autoInstallOnAppQuit = true

      autoUpdater.on('update-available', (info) => {
        const version = String((info as { version?: unknown })?.version ?? '')
        log('info', 'main', 'updater:available', { version })
        sendToRenderer(getWindow, 'updater:available', version)
      })

      autoUpdater.on('download-progress', (p) => {
        const percent = Math.round(Number((p as { percent?: unknown })?.percent ?? 0))
        sendToRenderer(getWindow, 'updater:progress', percent)
      })

      autoUpdater.on('update-downloaded', (info) => {
        const version = String((info as { version?: unknown })?.version ?? '')
        log('info', 'main', 'updater:downloaded', { version })
        sendToRenderer(getWindow, 'updater:downloaded', version)
      })

      autoUpdater.on('error', (err) => {
        const message = (err as Error)?.message ?? String(err)
        log('error', 'main', 'updater:error', { message })
        sendToRenderer(getWindow, 'updater:error', message)
      })

      // Check on launch.
      try {
        await autoUpdater.checkForUpdates()
      } catch (err) {
        log('warn', 'main', 'updater:initial-check:error', {
          message: (err as Error)?.message
        })
      }

      // Then poll every ~30 min.
      if (!pollTimer) {
        pollTimer = setInterval(() => {
          void autoUpdater.checkForUpdates().catch((err) => {
            log('warn', 'main', 'updater:poll:error', {
              message: (err as Error)?.message
            })
          })
        }, CHECK_INTERVAL_MS)
        // Don't keep the event loop alive solely for the updater poll.
        if (typeof pollTimer.unref === 'function') pollTimer.unref()
      }

      log('info', 'main', 'updater:wired', { intervalMs: CHECK_INTERVAL_MS })
    } catch (err) {
      // electron-updater missing or failed to load — degrade gracefully.
      wired = false
      log('error', 'main', 'updater:wire-failed', {
        message: (err as Error)?.message
      })
    }
  })()
}

/** Tear down the background poll timer. Safe to call multiple times. */
export function shutdownUpdater(): void {
  try {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  } catch {
    /* never throw */
  }
}
