import { spawn } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import { log } from './logger'

/**
 * PATH bootstrap for the PACKAGED app.
 *
 * When the .app is launched from Finder/Desktop the main process inherits a
 * minimal, NON-interactive environment: `~/.zshrc` is NOT sourced, so user
 * tools that live there (claude at ~/.local/bin, node/npm from nvm, codex) are
 * unresolvable for every spawn (ai, doctor, repair loop). In dev the terminal's
 * PATH is inherited so it "just works", masking the problem.
 *
 * We fix it ONCE at startup: capture the real PATH from an INTERACTIVE LOGIN
 * shell (`-ilc`, which DOES source ~/.zshrc), then merge it into
 * process.env.PATH. Every later spawn reads process.env at spawn time, so the
 * fix propagates to ai/doctor/repair-loop/pty automatically.
 *
 * Defensive throughout: a short timeout + fallback to well-known dirs means a
 * slow or misbehaving rc never blocks app startup, and the captured value is
 * never logged (it can contain sensitive directory names).
 */

const CAPTURE_TIMEOUT_MS = 3_000

/** Well-known user-tool dirs to seed PATH with when capture fails or misses them. */
function fallbackDirs(): string[] {
  const home = homedir()
  return [
    join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(home, '.nvm', 'current', 'bin'),
    join(home, '.cargo', 'bin')
  ]
}

/**
 * Run the user's interactive login shell to print its PATH. Resolves with the
 * raw stdout (possibly empty) — never rejects. An interactive rc may emit
 * banners/prompt control sequences, so the caller extracts the PATH segment.
 */
function captureInteractivePath(): Promise<string> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }

    const shell = process.env.SHELL || '/bin/zsh'
    let child: ReturnType<typeof spawn>
    try {
      // printf with no trailing newline keeps the PATH on its own segment even
      // amid rc banner noise; `-ilc` sources ~/.zshrc (interactive + login).
      child = spawn(shell, ['-ilc', 'printf %s "$PATH"'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: process.env
      })
    } catch {
      finish('')
      return
    }

    let out = ''
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      finish(out)
    }, CAPTURE_TIMEOUT_MS)

    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
    })
    child.on('error', () => finish(''))
    child.on('close', () => finish(out))
  })
}

/**
 * Pull the PATH-looking segment out of raw shell stdout. An interactive rc can
 * prepend banners or instant-prompt control sequences, so we scan lines for the
 * one that looks like a colon-separated list of absolute paths and keep the
 * longest such candidate.
 */
function extractPath(raw: string): string {
  if (!raw) return ''
  // Strip ANSI/control escapes that p10k instant-prompt etc. may emit.
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/\[[0-9;?]*[A-Za-z]/g, '').replace(/[\r]/g, '')
  let best = ''
  for (const line of clean.split('\n')) {
    const seg = line.trim()
    // A real PATH is colon-separated and contains at least one absolute dir.
    if (seg.includes('/') && seg.includes(':') && /(^|:)\/[^:]+/.test(seg)) {
      if (seg.length > best.length) best = seg
    }
  }
  // Single-line case (printf %s with no newline): the whole thing may be it.
  if (!best) {
    const seg = clean.trim()
    if (seg.includes('/') && /(^|:)\/[^:]+/.test(seg)) best = seg
  }
  return best
}

/**
 * Merge `captured` PATH entries (highest precedence — the user's intended PATH)
 * ahead of the existing process.env.PATH, then append the fallback dirs, and
 * dedup preserving first-seen order. Empty/duplicate entries are dropped.
 */
function mergePaths(captured: string, existing: string): string {
  const seen = new Set<string>()
  const out: string[] = []
  const push = (list: string): void => {
    for (const entry of list.split(':')) {
      const e = entry.trim()
      if (!e || seen.has(e)) continue
      seen.add(e)
      out.push(e)
    }
  }
  push(captured)
  push(existing)
  push(fallbackDirs().join(':'))
  return out.join(':')
}

/**
 * Capture the interactive-login PATH and merge it into process.env.PATH.
 * Idempotent-safe and never throws. Call ONCE at startup BEFORE any handlers
 * that spawn user CLIs are registered. Logs only the entry COUNT (never the
 * PATH value) to honour the no-secrets constraint.
 */
export async function ensureUserPath(): Promise<void> {
  const existing = process.env.PATH || ''
  try {
    const raw = await captureInteractivePath()
    const captured = extractPath(raw)
    const merged = mergePaths(captured, existing)
    process.env.PATH = merged
    log('info', 'main', 'path:merged', {
      captured: captured ? captured.split(':').length : 0,
      total: merged.split(':').filter(Boolean).length
    })
  } catch (err) {
    // Belt-and-suspenders: even on total failure, seed the fallback dirs.
    try {
      process.env.PATH = mergePaths('', existing)
    } catch {
      /* leave PATH unchanged */
    }
    log('warn', 'main', 'path:capture-failed', { error: String((err as Error)?.message || err) })
  }
}
