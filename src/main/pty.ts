import { ipcMain, BrowserWindow } from 'electron'
import os from 'os'
import fs from 'fs'
import path from 'path'
import { createRequire } from 'module'
import { log } from './logger'

// node-pty is a native module — load via createRequire so electron-vite leaves it external
const require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pty = require('node-pty') as typeof import('node-pty')

type PtyProcess = import('node-pty').IPty

interface Term {
  proc: PtyProcess
  cols: number
  rows: number
}

const terms = new Map<string, Term>()

const defaultShell =
  process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/zsh'

/**
 * Resolve a SAFE working directory for a spawned shell.
 *
 * macOS shows a TCC "network volume access" prompt whenever a process sets its
 * cwd onto (or otherwise touches) a mounted network/removable volume under
 * /Volumes. The renderer forwards a persisted node.cwd straight to us, and a
 * once-set /Volumes path would be replayed on every launch — re-triggering the
 * prompt at startup.
 *
 * Policy: only honor opts.cwd when it is a non-empty string, NOT under
 * /Volumes, and an EXISTING local directory. Otherwise fall back to the user's
 * home dir (always local). Never throws.
 */
function resolveSafeCwd(requested: string | undefined): string {
  const home = os.homedir()
  if (!requested || !requested.length) return home
  let resolved: string
  try {
    resolved = path.resolve(requested)
  } catch {
    return home
  }
  // Reject network/removable volumes (the TCC-prompt trigger).
  if (resolved === '/Volumes' || resolved.startsWith('/Volumes/')) return home
  // Must be an existing directory on a local path.
  try {
    const st = fs.statSync(resolved)
    if (!st.isDirectory()) return home
  } catch {
    return home
  }
  return resolved
}

interface SpawnOpts {
  id: string
  cwd?: string
  cols?: number
  rows?: number
  shell?: string
  /** A command to auto-run once the shell is ready (e.g. an agent CLI). */
  command?: string
  env?: Record<string, string>
}

// Sane terminal dimension bounds. node-pty / the underlying tty can throw or
// misbehave on non-finite, non-integer, zero/negative, or absurdly large
// values, so coerce any renderer-supplied dimension into a safe integer range.
const MIN_DIM = 1
const MAX_DIM = 9999

/** Clamp a renderer-supplied terminal dimension to a safe integer, or fall back. */
function clampDim(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  const i = Math.floor(n)
  if (i < MIN_DIM) return MIN_DIM
  if (i > MAX_DIM) return MAX_DIM
  return i
}

export function registerPtyHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('pty:spawn', (_e, opts: SpawnOpts) => {
    if (!opts || typeof opts.id !== 'string' || !opts.id.length) {
      log('warn', 'pty', 'spawn:invalid-id', {})
      return { ok: false, error: 'invalid id' }
    }

    // If a terminal with this id already exists, kill it first so we never
    // orphan/leak the previous pty process by overwriting the map entry.
    const existing = terms.get(opts.id)
    if (existing) {
      try {
        existing.proc.kill()
      } catch (err) {
        log('warn', 'pty', 'spawn:respawn-kill-fail', {
          id: opts.id,
          error: err instanceof Error ? err.message : String(err)
        })
      }
      terms.delete(opts.id)
    }

    const cols = clampDim(opts.cols, 80)
    const rows = clampDim(opts.rows, 24)
    const shell = (typeof opts.shell === 'string' && opts.shell) || defaultShell

    // sanitize renderer-supplied env: only accept string values, ignore the rest
    const safeEnv: Record<string, string> = {}
    if (opts.env && typeof opts.env === 'object') {
      for (const [key, value] of Object.entries(opts.env)) {
        if (typeof value === 'string') safeEnv[key] = value
      }
    }

    const env = {
      ...process.env,
      ...safeEnv,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      LANG: process.env.LANG || 'es_ES.UTF-8',
      // Disable macOS Apple-Terminal zsh "session save/restore". When the app is
      // launched from Terminal.app, TERM_PROGRAM=Apple_Terminal is inherited and
      // /etc/zshrc_Apple_Terminal then prints "Restored session: <date>" and
      // tries to `rm` a (often non-existent) ~/.zsh_sessions file on every spawn,
      // leaking that noise into our clean PTY. SHELL_SESSIONS_DISABLE=1 is the
      // documented opt-out.
      SHELL_SESSIONS_DISABLE: '1',
      // CRITICAL for claude --resume. When CanvasIO is launched from inside an
      // existing Claude Code session (or any nested/child context), claude
      // inherits CLAUDECODE=1 / CLAUDE_CODE_CHILD_SESSION=1 and then DISABLES
      // transcript writes: an INTERACTIVE `claude --session-id <uuid>` runs and
      // answers normally but NEVER writes ~/.claude/projects/<cwd>/<uuid>.jsonl
      // (only an empty `memory/` subdir appears), so a later `claude --resume
      // <uuid>` prints "No conversation found with session ID". Empirically
      // verified (claude 2.1.179) that setting this flag forces claude to write
      // the transcript under the preset --session-id, making resume reliable.
      // We also strip the inherited child-session markers below as belt-and-braces.
      CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1',
      // CANVASIO shared-memory hint so agents know they're on a canvas
      CANVASIO: '1'
    } as Record<string, string>

    // Belt-and-braces: also strip the Apple-Terminal markers so the session
    // restore logic never engages even if SHELL_SESSIONS_DISABLE is ignored.
    delete env.TERM_PROGRAM
    delete env.TERM_PROGRAM_VERSION
    delete env.TERM_SESSION_ID

    // Strip inherited Claude Code child-session markers so a claude launched in
    // this PTY behaves as a top-level session and persists its transcript (see
    // CLAUDE_CODE_FORCE_SESSION_PERSISTENCE above). Without this, a CanvasIO
    // launched from within a claude session would propagate the child context
    // and claude would skip writing the resumable <uuid>.jsonl.
    delete env.CLAUDECODE
    delete env.CLAUDE_CODE_CHILD_SESSION
    delete env.CLAUDE_CODE_ENTRYPOINT
    delete env.CLAUDE_CODE_SESSION_ID

    const cwd = resolveSafeCwd(opts.cwd)

    let proc: PtyProcess
    try {
      proc = pty.spawn(shell, ['-l'], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env
      })
    } catch (err) {
      log('error', 'pty', 'spawn:failed', {
        id: opts.id,
        shell,
        error: err instanceof Error ? err.message : String(err)
      })
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }

    terms.set(opts.id, { proc, cols, rows })
    log('info', 'pty', 'spawn', { id: opts.id, pid: proc.pid, shell, cols, rows, cwd })

    const safeSend = (channel: string, payload: unknown): void => {
      const win = getWindow()
      if (!win || win.isDestroyed()) return
      const wc = win.webContents
      if (!wc || wc.isDestroyed()) return
      try {
        wc.send(channel, payload)
      } catch {
        /* window/webContents gone */
      }
    }

    proc.onData((data) => {
      // Guard by process identity (mirrors onExit below): node-pty can flush
      // buffered output from a killed shell asynchronously AFTER a respawn has
      // replaced this id's entry with a new proc. Without this check that stale
      // data would be sent on pty:data:${opts.id} — now owned by the live NEW
      // terminal — injecting the dead shell's leftover output into it.
      if (terms.get(opts.id)?.proc !== proc) return
      safeSend(`pty:data:${opts.id}`, data)
    })

    proc.onExit(({ exitCode }) => {
      // Guard by process identity: if a respawn has already replaced this id's
      // entry with a new proc, this is the OLD (killed) proc's exit firing late.
      // Acting here would delete the live terminal's map entry and emit a stale
      // pty:exit for an id the renderer now believes is alive.
      if (terms.get(opts.id)?.proc !== proc) return
      log(exitCode === 0 ? 'info' : 'warn', 'pty', 'exit', { id: opts.id, exitCode })
      safeSend(`pty:exit:${opts.id}`, exitCode)
      terms.delete(opts.id)
    })

    // auto-run an agent command if provided
    if (typeof opts.command === 'string' && opts.command.length) {
      const command = opts.command
      setTimeout(() => {
        // bail if the term was killed/exited before the timer fired
        if (terms.get(opts.id)?.proc !== proc) return
        try {
          proc.write(command + '\r')
        } catch {
          /* ignore */
        }
      }, 350)
    }

    return { ok: true, pid: proc.pid }
  })

  ipcMain.on('pty:write', (_e, id: string, data: string) => {
    if (typeof data !== 'string') return
    const t = terms.get(id)
    if (!t) return
    try {
      t.proc.write(data)
    } catch (err) {
      log('warn', 'pty', 'write:failed', { id, error: err instanceof Error ? err.message : String(err) })
    }
  })

  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => {
    const t = terms.get(id)
    if (!t) return
    const safeCols = clampDim(cols, t.cols)
    const safeRows = clampDim(rows, t.rows)
    t.cols = safeCols
    t.rows = safeRows
    try {
      t.proc.resize(safeCols, safeRows)
    } catch {
      /* pty may have exited */
    }
  })

  // Detect the Codex session id of a just-started session so the renderer can
  // persist it and later `codex resume <id>`. Codex writes one rollout file per
  // session at ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl; we return
  // the UUID of the newest rollout modified at/after `sinceMs`. Best-effort and
  // never throws (returns null on any problem or no match).
  ipcMain.handle('session:detectCodex', (_e, sinceMs: number): string | null => {
    try {
      const base = path.join(os.homedir(), '.codex', 'sessions')
      if (!fs.existsSync(base)) return null
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) ? sinceMs : 0
      const uuidRe =
        /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/
      let best: string | null = null
      let bestT = since - 1
      const stack: string[] = [base]
      while (stack.length) {
        const dir = stack.pop() as string
        let entries: fs.Dirent[]
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch {
          continue
        }
        for (const ent of entries) {
          const p = path.join(dir, ent.name)
          if (ent.isDirectory()) {
            stack.push(p)
          } else if (ent.isFile() && ent.name.startsWith('rollout-') && ent.name.endsWith('.jsonl')) {
            let t: number
            try {
              t = fs.statSync(p).mtimeMs
            } catch {
              continue
            }
            if (t >= bestT) {
              const m = ent.name.match(uuidRe)
              if (m) {
                best = m[1]
                bestT = t
              }
            }
          }
        }
      }
      return best
    } catch {
      return null
    }
  })

  // Claude Code writes its conversation to ~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
  // (the filename IS the session id). After a fresh claude terminal starts we
  // detect the newest such file written since spawn so a later restore can
  // `claude --resume <id>` THIS conversation (today claude had no capture, so a
  // restored claude fell back to `claude --continue`, resuming the wrong/most-recent
  // conversation or none). SCOPE to the terminal's cwd project dir when given, so we
  // never grab the VOICE BRAIN's claude session (it runs in a different cwd).
  ipcMain.handle(
    'session:detectClaude',
    (_e, sinceMs: number, cwd?: string): string | null => {
      try {
        const base = path.join(os.homedir(), '.claude', 'projects')
        if (!fs.existsSync(base)) return null
        const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) ? sinceMs : 0
        const uuidRe =
          /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/
        // Claude encodes the project-dir name as realpath(cwd) with EVERY
        // non-alphanumeric char (case preserved) replaced by '-'. Verified
        // empirically: '_', spaces, '.', and symlink components (macOS /tmp ->
        // /private/tmp) all matter, so we must realpath first and replace the full
        // [^A-Za-z0-9] class — not just '/' and '.', which silently missed dirs.
        const roots: string[] = []
        if (typeof cwd === 'string' && cwd) {
          let real = cwd
          try {
            real = fs.realpathSync(cwd)
          } catch {
            // cwd may not exist (yet); fall back to the raw path.
          }
          const enc = real.replace(/[^A-Za-z0-9]/g, '-')
          const scoped = path.join(base, enc)
          if (fs.existsSync(scoped)) roots.push(scoped)
        }
        // Fall back to scanning every project dir if the cwd dir is unknown/absent.
        if (!roots.length) {
          try {
            for (const ent of fs.readdirSync(base, { withFileTypes: true })) {
              if (ent.isDirectory()) roots.push(path.join(base, ent.name))
            }
          } catch {
            return null
          }
        }
        let best: string | null = null
        let bestT = since - 1
        for (const dir of roots) {
          let entries: fs.Dirent[]
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true })
          } catch {
            continue
          }
          for (const ent of entries) {
            if (!ent.isFile()) continue
            const m = ent.name.match(uuidRe)
            if (!m) continue
            let t: number
            try {
              t = fs.statSync(path.join(dir, ent.name)).mtimeMs
            } catch {
              continue
            }
            if (t >= bestT) {
              best = m[1]
              bestT = t
            }
          }
        }
        return best
      } catch {
        return null
      }
    }
  )

  // Pre-accept Claude Code's per-folder TRUST prompt for a cwd before we spawn an
  // interactive `claude` there. EMPIRICAL: Claude Code 2.1.179, launched
  // interactively in a not-yet-trusted dir, blocks on "Is this a project you
  // trust? 1. Yes / 2. No, exit" and EXITS code 1 without persisting any session
  // — and `--dangerously-skip-permissions` (injected by the user's `claude` shell
  // function) does NOT bypass it. Claude tracks trust per-folder in
  // ~/.claude.json under projects[<cwd>].hasTrustDialogAccepted. We set that to
  // true for the resolved cwd here so the interactive session boots straight to
  // the prompt and can actually run + persist a conversation. Best-effort and
  // never throws: a missing/locked/garbage ~/.claude.json just means we skip it
  // (claude will then show the prompt as before — no worse than today).
  ipcMain.handle('session:claudeTrust', (_e, cwd?: string): boolean => {
    try {
      if (typeof cwd !== 'string' || !cwd.length) return false
      // Match the SAME key Claude uses: the realpath of the cwd (it resolves
      // symlinks like macOS /tmp -> /private/tmp before keying projects[]).
      let real = cwd
      try {
        real = fs.realpathSync(cwd)
      } catch {
        // cwd may not exist yet; fall back to the raw path so we at least seed
        // SOMETHING — but the spawn's resolveSafeCwd would also reject it, so a
        // non-existent dir is unlikely to reach here in practice.
      }
      const jsonPath = path.join(os.homedir(), '.claude.json')
      let cfg: Record<string, unknown> = {}
      try {
        cfg = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as Record<string, unknown>
      } catch {
        // No config yet (or unreadable/corrupt): start from an empty object. We
        // only ever ADD our one key, so we never clobber unrelated state on a
        // readable file; on an unreadable one we won't overwrite (see below).
        cfg = {}
      }
      const projects = (cfg.projects && typeof cfg.projects === 'object'
        ? (cfg.projects as Record<string, Record<string, unknown>>)
        : {}) as Record<string, Record<string, unknown>>
      const entry = projects[real] && typeof projects[real] === 'object' ? projects[real] : {}
      if (entry.hasTrustDialogAccepted === true) return true // already trusted; nothing to write
      entry.hasTrustDialogAccepted = true
      projects[real] = entry
      cfg.projects = projects
      // Atomic-ish write: write to a temp file then rename, so a crash mid-write
      // can never leave the user's ~/.claude.json truncated/corrupt.
      const tmp = jsonPath + '.canvasio.tmp'
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2))
      fs.renameSync(tmp, jsonPath)
      log('info', 'pty', 'claudeTrust:seeded', { cwd: real })
      return true
    } catch (err) {
      log('warn', 'pty', 'claudeTrust:fail', {
        error: err instanceof Error ? err.message : String(err)
      })
      return false
    }
  })

  // Recover the REAL session id of an interactive `claude` started in `cwd`.
  // EMPIRICAL (Claude Code 2.1.179): an interactive claude launched the way
  // CanvasIO launches it does NOT reliably write the legacy
  // ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl transcript, so `detectClaude`
  // (which scans for that file) finds nothing. But claude DOES append one line
  // per user prompt to ~/.claude/history.jsonl as
  // {display, pastedContents, timestamp, project:<cwd>, sessionId:<uuid>}. We
  // tail that file and return the sessionId of the NEWEST entry whose `project`
  // matches the terminal's cwd AND whose timestamp is >= sinceMs (the spawn
  // time), so we only ever pick up THIS session's id — never a stale prior one
  // in the same cwd. Best-effort, never throws (null on any problem/no match).
  ipcMain.handle(
    'session:detectClaudeHistory',
    (_e, sinceMs: number, cwd?: string): string | null => {
      try {
        // No cwd -> the terminal spawned in the home dir (resolveSafeCwd default),
        // so match claude's `project` against home.
        const effCwd = typeof cwd === 'string' && cwd.length ? cwd : os.homedir()
        const histPath = path.join(os.homedir(), '.claude', 'history.jsonl')
        if (!fs.existsSync(histPath)) return null
        // Match against BOTH the raw cwd and its realpath — claude records the
        // `project` as the path it was launched with (which, via our login-shell
        // spawn + resolveSafeCwd, is already realpath-resolved), but we compare
        // permissively so a symlinked cwd still matches.
        let real = effCwd
        try {
          real = fs.realpathSync(effCwd)
        } catch {
          /* cwd may not exist; keep raw */
        }
        const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) ? sinceMs : 0
        // history.jsonl is append-only and can be large; read it and scan from the
        // END for the first (newest) matching entry. timestamps are ms epoch.
        const raw = fs.readFileSync(histPath, 'utf8')
        const lines = raw.split('\n')
        for (let i = lines.length - 1; i >= 0; i--) {
          const ln = lines[i].trim()
          if (!ln) continue
          let obj: { project?: unknown; sessionId?: unknown; timestamp?: unknown }
          try {
            obj = JSON.parse(ln)
          } catch {
            continue
          }
          if (typeof obj.sessionId !== 'string' || !obj.sessionId) continue
          if (typeof obj.project !== 'string') continue
          if (obj.project !== real && obj.project !== effCwd) continue
          // Reject entries older than the spawn so we never resurrect a stale id.
          // Treat a missing/garbage timestamp as "old" (skip) to be safe.
          const t = typeof obj.timestamp === 'number' ? obj.timestamp : NaN
          if (!Number.isFinite(t) || t < since) continue
          return obj.sessionId
        }
        return null
      } catch {
        return null
      }
    }
  )

  ipcMain.on('pty:kill', (_e, id: string) => {
    const t = terms.get(id)
    if (!t) return
    log('debug', 'pty', 'kill', { id })
    try {
      t.proc.kill()
    } catch (err) {
      log('warn', 'pty', 'kill:fail', { id, error: err instanceof Error ? err.message : String(err) })
    }
    terms.delete(id)
  })
}

export function killAllPtys(): void {
  const n = terms.size
  if (n > 0) log('info', 'pty', 'kill-all', { count: n })
  for (const { proc } of terms.values()) {
    try {
      proc.kill()
    } catch (err) {
      log('warn', 'pty', 'kill-all:fail', { error: err instanceof Error ? err.message : String(err) })
    }
  }
  terms.clear()
}
