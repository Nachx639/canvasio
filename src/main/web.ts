/**
 * Web lookup bridge (MAIN process) — fetches weather + internet facts for the
 * voice agent so it can SPEAK an answer without opening a web node/window.
 *
 * Mirrors the safety discipline of fs.ts / canvases.ts:
 *   - every handler is wrapped in try/catch and NEVER throws across IPC
 *   - resolves to { ok, text } or { ok:false, reason } (never throws)
 *   - enforces a hard timeout via AbortController (no hangs)
 *   - validates / encodes queries before building URLs (no shell injection;
 *     in fact no shell at all — uses Electron's net.fetch over HTTPS only)
 *   - reads from public, no-auth, read-only endpoints (wttr.in, DuckDuckGo)
 */

import { ipcMain, net } from 'electron'
import { log } from './logger'

// Match AVAILABLE_TIMEOUT_MS from ai.ts so a slow lookup never out-lives the
// voice turn that is waiting on it.
const WEB_TIMEOUT_MS = 8000

type WebResult = { ok: boolean; text?: string; reason?: string }

/**
 * Fetch a URL with a hard timeout, using Electron's native net.fetch (HTTPS,
 * no shell, follows redirects). Resolves the Response or rejects; callers wrap
 * this in try/catch. AbortError surfaces as err.name === 'AbortError'.
 */
async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), WEB_TIMEOUT_MS)
  try {
    return await net.fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'CanvasIO/1.0 (voice-lookup)' },
      signal: controller.signal
    })
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Extract the place name from a Spanish weather query like
 * "¿qué tiempo hace en Valencia?" → "Valencia". Falls back to "Madrid" when no
 * place is detected so the agent still says something useful.
 */
function extractPlaceFromQuery(query: string): string {
  // "en <place>", "en la <place>", "de <place>" — capture up to a closing
  // punctuation mark / end of string. Accents allowed in the place name.
  const match = query.match(/(?:\ben\s+(?:la\s+)?|\bde\s+)([\wáéíóúñü\s]+?)(?:\?|$|[.!,;])/i)
  const place = (match?.[1] || '').trim()
  return place || 'Madrid'
}

/** Strip accents + collapse whitespace; used to make a URL-safe place token. */
function normalizePlace(place: string): string {
  return place
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining accent marks
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Fetch + format current weather for `place` from wttr.in (no API key).
 * Uses the compact custom-format endpoint and wraps it into a short SPANISH
 * spoken sentence, e.g. "En Valencia: despejado, 24 grados, viento 12 km/h".
 * Never throws; returns { ok:false, reason } on any error.
 */
async function fetchWeather(place: string): Promise<WebResult> {
  if (!place || typeof place !== 'string') return { ok: false, reason: 'invalid-place' }

  const normalized = normalizePlace(place)
  if (!normalized) return { ok: false, reason: 'empty-place' }

  // wttr.in compact format: %C=condición, %t=temperatura, %w=viento.
  // lang=es localizes the condition text; &m forces metric units.
  const fmt = '%C|%t|%w'
  const url = `https://wttr.in/${encodeURIComponent(normalized)}?format=${encodeURIComponent(fmt)}&lang=es&m`

  try {
    const res = await fetchWithTimeout(url)
    if (!res.ok) return { ok: false, reason: `http-${res.status}` }

    const raw = (await res.text()).trim()
    // wttr.in returns "Unknown location; ..." (200) for places it can't resolve.
    if (!raw || raw.length < 3 || /unknown location/i.test(raw)) {
      return { ok: false, reason: 'unknown-location' }
    }

    // Parse the pipe-delimited compact line into a spoken sentence.
    const [condRaw, tempRaw, windRaw] = raw.split('|').map((s) => s.trim())
    const parts: string[] = []
    if (condRaw) parts.push(condRaw)
    if (tempRaw) {
      // "+24°C" / "24°C" → "24 grados". Keep a leading minus for cold temps.
      const t = tempRaw.replace(/^\+/, '').replace(/°C?/i, '').trim()
      parts.push(/^-?\d+$/.test(t) ? `${t} grados` : tempRaw)
    }
    if (windRaw) parts.push(`viento ${windRaw}`)

    const detail = parts.join(', ')
    if (!detail) return { ok: false, reason: 'empty-response' }

    return { ok: true, text: `En ${place.trim()}: ${detail}` }
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return { ok: false, reason: 'timeout' }
    return { ok: false, reason: 'fetch-error' }
  }
}

/**
 * Best-effort general internet fact lookup via DuckDuckGo's Instant Answer API.
 * Returns AbstractText or Answer (capped for speech), or { ok:false, reason }.
 * Never throws.
 */
async function fetchGeneral(query: string): Promise<WebResult> {
  if (!query || typeof query !== 'string') return { ok: false, reason: 'invalid-query' }

  // Whitelist: letters (incl. Spanish), digits, spaces, hyphens. Everything
  // else (incl. shell/URL metacharacters) collapses to a space. There is no
  // shell here, but this keeps the query clean before encodeURIComponent.
  const clean = query.replace(/[^\w\s\-áéíóúñü]/gi, ' ').replace(/\s+/g, ' ').trim()
  if (!clean) return { ok: false, reason: 'empty-query' }

  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(clean)}&format=json&no_html=1&no_redirect=1`

  try {
    const res = await fetchWithTimeout(url)
    if (!res.ok) return { ok: false, reason: `http-${res.status}` }

    const json = (await res.json()) as Record<string, unknown>
    const abstractText = typeof json.AbstractText === 'string' ? json.AbstractText.trim() : ''
    const answer = typeof json.Answer === 'string' ? json.Answer.trim() : ''
    const definition = typeof json.Definition === 'string' ? json.Definition.trim() : ''
    const text = abstractText || answer || definition

    if (!text) return { ok: false, reason: 'no-answer' }

    // Cap for speech so a long abstract doesn't run on forever.
    return { ok: true, text: text.slice(0, 300) }
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return { ok: false, reason: 'timeout' }
    return { ok: false, reason: 'fetch-error' }
  }
}

/** Log web lookups (query + outcome only — never the response body / user content). */
function logWeb(type: string, query: unknown, result: WebResult): void {
  try {
    const q = typeof query === 'string' ? query.slice(0, 120) : ''
    log('debug', 'main', `web:${type}`, { query: q, ok: result.ok, reason: result.reason })
  } catch {
    /* ignore */
  }
}

/**
 * Register the `web:answer` IPC handler. Dispatches to weather or general
 * lookup based on the query, and returns { ok, text } | { ok:false, reason }.
 * Never throws.
 */
export function registerWebHandlers(): void {
  ipcMain.handle(
    'web:answer',
    async (_e, payload: { query?: unknown }): Promise<WebResult> => {
      try {
        const query = typeof payload?.query === 'string' ? payload.query.trim() : ''
        if (!query) return { ok: false, reason: 'empty-query' }

        // Detect WEATHER intent (Spanish): tiempo / clima / pronóstico / temperatura.
        const isWeather = /\b(?:tiempo|clima|pron[óo]stico|temperatura|grados|llueve|lluvia)\b/i.test(query)

        if (isWeather) {
          const place = extractPlaceFromQuery(query)
          const result = await fetchWeather(place)
          logWeb('weather', query, result)
          return result
        }

        const result = await fetchGeneral(query)
        logWeb('lookup', query, result)
        return result
      } catch (err) {
        const reason = (err as Error)?.message || 'exception'
        logWeb('error', payload?.query, { ok: false, reason })
        return { ok: false, reason }
      }
    }
  )

  log('info', 'main', 'web:handlers-registered', {})
}
