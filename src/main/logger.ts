import { app } from 'electron'
import { appendFile, readFile, writeFile, mkdir, stat } from 'fs'
import { join } from 'path'

/**
 * Structured JSON-lines rolling logger for CANVASIO.
 *
 * Contract (authoritative across agents):
 *   userData/canvasio-runtime.log — one JSON object per line, newline-terminated:
 *     { ts, level, cat, msg, data? }
 *   level: 'debug'|'info'|'warn'|'error'
 *   cat:   'main'|'pty'|'voice'|'youtube'|'ai'|'webview'|'renderer'|'action'|'doctor'
 *
 * Rotation: cap ~2MB / ~5000 lines; on exceed keep the LAST ~5000 lines.
 * The logger NEVER throws — every write is best-effort and serialized through a
 * single internal queue so concurrent writers cannot interleave/corrupt a line.
 *
 * This module is also the single owner of the userData write queue, so other
 * main-process modules (e.g. doctor.ts) can piggy-back atomic read-modify-write
 * file operations (canvasio-repairs.json) through `enqueue(...)`.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogCat =
  | 'main'
  | 'pty'
  | 'voice'
  | 'youtube'
  | 'ai'
  | 'webview'
  | 'renderer'
  | 'action'
  | 'doctor'

export interface LogEntry {
  ts: string
  level: LogLevel
  cat: LogCat
  msg: string
  data?: unknown
}

const MAX_BYTES = 2 * 1024 * 1024 // ~2MB
const MAX_LINES = 5000
// How often (in number of appended lines) we check whether rotation is due.
const ROTATE_CHECK_EVERY = 50

let appendCount = 0

/** Resolve userData (falls back to cwd before app is ready / in odd contexts). */
function userDataDir(): string {
  try {
    return app.getPath('userData')
  } catch {
    return process.cwd()
  }
}

/** Absolute path of the JSON-lines runtime log. */
export function logPath(): string {
  return join(userDataDir(), 'canvasio-runtime.log')
}

/**
 * Single serialized task queue. Every disk operation (log append, rotation,
 * repairs.json read-modify-write) chains onto this promise so writes never race.
 * Each task is wrapped so a rejection can never break the chain.
 */
let queue: Promise<void> = Promise.resolve()

/**
 * Enqueue an async task onto the serialized write queue. Returns a promise that
 * resolves with the task's value (or rejects with its error) WITHOUT breaking
 * the internal chain. Safe for atomic read-modify-write on userData files.
 */
export function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(() => task())
  // Keep the chain alive regardless of this task's outcome.
  queue = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

/** Promisified fs helpers (best-effort, swallow nothing here — callers handle). */
function pAppend(file: string, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    appendFile(file, data, (err) => (err ? reject(err) : resolve()))
  })
}
function pReadFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    readFile(file, 'utf8', (err, data) => (err ? reject(err) : resolve(data)))
  })
}
function pWriteFile(file: string, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    writeFile(file, data, (err) => (err ? reject(err) : resolve()))
  })
}
function pStatSize(file: string): Promise<number> {
  return new Promise((resolve) => {
    stat(file, (err, st) => resolve(err ? 0 : st.size))
  })
}

/** Ensure userData dir exists (it normally does once the app is ready). */
function ensureDir(): Promise<void> {
  return new Promise((resolve) => {
    mkdir(userDataDir(), { recursive: true }, () => resolve())
  })
}

/**
 * Trim the log to the last MAX_LINES lines if it has grown past the byte cap.
 * Runs inside the queue; failures are swallowed.
 */
async function rotateIfNeeded(): Promise<void> {
  try {
    const size = await pStatSize(logPath())
    if (size <= MAX_BYTES) return
    const content = await pReadFile(logPath())
    const lines = content.split('\n').filter((l) => l.length > 0)
    if (lines.length <= MAX_LINES) return
    const kept = lines.slice(lines.length - MAX_LINES)
    await pWriteFile(logPath(), kept.join('\n') + '\n')
  } catch {
    /* best-effort: never throw */
  }
}

/** Serialize a payload safely; substitute a marker if it can't be stringified. */
function safeLine(entry: LogEntry): string {
  try {
    return JSON.stringify(entry)
  } catch {
    return JSON.stringify({
      ts: entry.ts,
      level: entry.level,
      cat: entry.cat,
      msg: entry.msg,
      data: { note: 'unserializable payload' }
    })
  }
}

/**
 * Core logging entrypoint. Stamps `ts`, mirrors to the console, and enqueues an
 * append (plus periodic rotation). Never throws.
 */
export function log(level: LogLevel, cat: LogCat, msg: string, data?: unknown): void {
  const entry: LogEntry = { ts: new Date().toISOString(), level, cat, msg }
  if (data !== undefined) entry.data = data

  // Mirror to console (visible in the dev terminal that launched Electron).
  try {
    const tag = `[canvasio:${cat}] ${entry.ts} ${level.toUpperCase()} ${msg}`
    // eslint-disable-next-line no-console
    const fn =
      level === 'error'
        ? console.error
        : level === 'warn'
          ? console.warn
          : console.log
    if (data !== undefined) fn(tag, data)
    else fn(tag)
  } catch {
    /* ignore console failures */
  }

  const line = safeLine(entry) + '\n'
  void enqueue(async () => {
    try {
      await ensureDir()
      await pAppend(logPath(), line)
      appendCount++
      if (appendCount % ROTATE_CHECK_EVERY === 0) {
        await rotateIfNeeded()
      }
    } catch {
      /* best-effort: never throw */
    }
  })
}

/** Convenience level helpers. */
export const logger = {
  debug: (cat: LogCat, msg: string, data?: unknown) => log('debug', cat, msg, data),
  info: (cat: LogCat, msg: string, data?: unknown) => log('info', cat, msg, data),
  warn: (cat: LogCat, msg: string, data?: unknown) => log('warn', cat, msg, data),
  error: (cat: LogCat, msg: string, data?: unknown) => log('error', cat, msg, data)
}

/**
 * Read the last `n` JSON-line entries from the runtime log. Malformed lines are
 * skipped. Never throws — returns [] on any failure. Reads through the queue so
 * it sees a consistent snapshot relative to in-flight appends.
 */
export function getTail(n = 500): Promise<LogEntry[]> {
  return enqueue(async () => {
    try {
      const content = await pReadFile(logPath())
      const lines = content.split('\n').filter((l) => l.length > 0)
      const slice = lines.slice(Math.max(0, lines.length - n))
      const out: LogEntry[] = []
      for (const l of slice) {
        try {
          out.push(JSON.parse(l) as LogEntry)
        } catch {
          /* skip malformed line */
        }
      }
      return out
    } catch {
      return []
    }
  })
}

/**
 * Read the last `n` raw JSON lines (un-parsed text), newline-joined. Useful for
 * feeding straight into a prompt. Never throws — returns '' on failure.
 */
export function getTailRaw(n = 500): Promise<string> {
  return enqueue(async () => {
    try {
      const content = await pReadFile(logPath())
      const lines = content.split('\n').filter((l) => l.length > 0)
      return lines.slice(Math.max(0, lines.length - n)).join('\n')
    } catch {
      return ''
    }
  })
}
