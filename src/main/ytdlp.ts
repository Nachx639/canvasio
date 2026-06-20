import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { log } from './logger'

/**
 * yt-dlp RESOLVER for the YouTube Music node.
 *
 * Resolves a YouTube video id into a single, directly-playable progressive
 * stream URL (plus title + duration) via the user's locally-installed `yt-dlp`
 * binary (only present if the user installed it themselves). The renderer plays
 * that URL in a native <video> element when available, with a graceful fallback
 * to the official YouTube (canvasio-yt) embed when no stream resolves.
 *
 * NOTE: stream resolution depends on a user-provided yt-dlp and is the user's
 * responsibility, subject to the source platform's Terms of Service. When yt-dlp
 * is absent the player uses the official embed only.
 *
 * Security contract (authoritative):
 *  - execFile with an ARGS ARRAY only — never a shell — so no injection risk.
 *  - Only a validated 11-char YouTube id (alnum + `-`/`_`) ever reaches yt-dlp;
 *    the canonical watch URL is built HERE, never from raw renderer input.
 *  - A ~20s timeout guards against a hung resolution.
 *  - NEVER throws: every path returns a structured { ok, ... } result. The
 *    time-limited googlevideo signature URL is NEVER written to the log.
 */

const execFileP = promisify(execFile)

/** Resolution timeout — yt-dlp must finish (network + parse) within this window. */
const RESOLVE_TIMEOUT_MS = 20_000

/** Hard-coded binary fallbacks tried before a PATH `which` lookup. */
const BINARY_CANDIDATES = ['/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp']

/** A bare 11-char YouTube video id: alphanumeric plus `-` and `_`. */
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/

export interface YtdlpResult {
  ok: boolean
  url?: string
  title?: string
  duration?: number
  reason?: string
}

/** Cached resolved binary path (null = not yet looked up). */
let cachedBinary: string | null = null

/**
 * Normalize arbitrary renderer input to a clean 11-char video id, or null.
 * Accepts a bare id directly, or extracts the `v=` / youtu.be / embed id from a
 * YouTube URL. Anything else (playlists-only, foreign hosts, junk) is rejected.
 */
export function validateVideoId(input: string): string | null {
  const raw = (input || '').trim()
  if (!raw) return null

  // Fast path: already a bare id.
  if (VIDEO_ID_RE.test(raw)) return raw

  // Otherwise try to extract an id from a YouTube URL shape.
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }

  const host = parsed.hostname.replace(/^www\./, '').toLowerCase()
  let candidate: string | null = null

  if (host === 'youtu.be') {
    // https://youtu.be/<id>
    candidate = parsed.pathname.slice(1).split('/')[0] || null
  } else if (
    host === 'youtube.com' ||
    host === 'm.youtube.com' ||
    host === 'music.youtube.com'
  ) {
    if (parsed.pathname === '/watch') {
      candidate = parsed.searchParams.get('v')
    } else if (parsed.pathname.startsWith('/embed/')) {
      candidate = parsed.pathname.slice('/embed/'.length).split('/')[0] || null
    } else if (parsed.pathname.startsWith('/shorts/')) {
      candidate = parsed.pathname.slice('/shorts/'.length).split('/')[0] || null
    }
  }

  if (candidate && VIDEO_ID_RE.test(candidate)) return candidate
  return null
}

/**
 * Locate the `yt-dlp` binary. Tries hard-coded Homebrew/local paths first, then
 * a PATH `which` lookup (the app merges the login PATH via ensureUserPath at
 * startup, so user installs on PATH resolve here). Caches the result. Returns
 * null when not found anywhere — never throws.
 */
export async function findYtdlpBinary(): Promise<string | null> {
  if (cachedBinary && existsSync(cachedBinary)) return cachedBinary

  for (const cand of BINARY_CANDIDATES) {
    if (existsSync(cand)) {
      cachedBinary = cand
      return cand
    }
  }

  try {
    const { stdout } = await execFileP('which', ['yt-dlp'], { timeout: 5_000 })
    const found = stdout.trim().split('\n')[0]
    if (found && existsSync(found)) {
      cachedBinary = found
      return found
    }
  } catch {
    /* not on PATH */
  }

  return null
}

/**
 * Resolve a YouTube video id/URL to a playable progressive stream.
 * Always resolves to a structured result; never throws.
 */
export async function resolveYtdlp(videoIdOrUrl: string): Promise<YtdlpResult> {
  const id = validateVideoId(videoIdOrUrl)
  if (!id) {
    log('warn', 'youtube', 'ytdlp.invalid-input', { input: String(videoIdOrUrl || '').slice(0, 64) })
    return { ok: false, reason: 'invalid-input' }
  }

  const bin = await findYtdlpBinary()
  if (!bin) {
    log('warn', 'youtube', 'ytdlp.binary-not-found', { videoId: id })
    return { ok: false, reason: 'yt-dlp-not-found' }
  }

  // Canonical URL built HERE from the validated id — raw input never reaches yt-dlp.
  const canonicalUrl = `https://www.youtube.com/watch?v=${id}`

  try {
    const { stdout } = await execFileP(
      bin,
      [
        '-j', // dump a single JSON object describing the (resolved) media
        '-f',
        'best[ext=mp4]/best', // prefer a progressive H.264 MP4; else any best single stream
        '--no-playlist', // never expand to a playlist
        '--no-warnings', // keep stderr quiet
        canonicalUrl
      ],
      { timeout: RESOLVE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }
    )

    let json: Record<string, unknown>
    try {
      json = JSON.parse(stdout.trim()) as Record<string, unknown>
    } catch {
      log('warn', 'youtube', 'ytdlp.parse-failed', { videoId: id })
      return { ok: false, reason: 'resolution-failed' }
    }

    const url = typeof json.url === 'string' ? json.url : undefined
    if (!url) {
      log('warn', 'youtube', 'ytdlp.no-stream-url', { videoId: id })
      return { ok: false, reason: 'resolution-failed' }
    }

    const title = typeof json.title === 'string' ? json.title : undefined
    const duration = typeof json.duration === 'number' ? json.duration : undefined

    // NOTE: never log `url` — it carries a time-limited googlevideo signature.
    log('info', 'youtube', 'ytdlp.resolved', { videoId: id, hasTitle: !!title, duration })
    return { ok: true, url, title, duration }
  } catch (err) {
    // Timeout, non-zero exit, crash, etc. — never surface the raw command/URL.
    log('warn', 'youtube', 'ytdlp.resolution-failed', {
      videoId: id,
      error: String((err as Error)?.message || err).slice(0, 200)
    })
    return { ok: false, reason: 'resolution-failed' }
  }
}

/**
 * Register the `ytdlp:resolve` IPC handler. Idempotent-safe enough for a single
 * call at startup (after ensureUserPath()). The handler never throws.
 */
export async function registerYtdlpHandlers(): Promise<void> {
  ipcMain.handle('ytdlp:resolve', async (_e, videoIdOrUrl: unknown): Promise<YtdlpResult> => {
    try {
      const input = typeof videoIdOrUrl === 'string' ? videoIdOrUrl : ''
      return await resolveYtdlp(input)
    } catch {
      return { ok: false, reason: 'unknown-error' }
    }
  })
}
