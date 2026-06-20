import { join } from 'path'
import { promises as fs, existsSync, createWriteStream } from 'fs'
import https from 'https'
import { log } from './logger'

/* ================================================================== *
 *  Per-language voice registry + on-demand Piper voice downloads
 * ------------------------------------------------------------------
 *  This module owns:
 *    - the app's supported languages (Lang),
 *    - the whisper `-l` STT code per language,
 *    - the Piper neural voice (HuggingFace .onnx + .onnx.json) per language,
 *    - the macOS `say` fallback voice per language,
 *    - on-demand download of a Piper voice into piperVoicesDir() mirroring the
 *      whisper model-download mechanism (redirects, timeout, atomic rename,
 *      progress callback, in-flight de-dup). Downloads never throw to callers;
 *      a failed/partial download resolves to null so TTS can fall back to `say`.
 * ================================================================== */

export type Lang = 'es' | 'en' | 'pt' | 'zh'

// Language → whisper `-l` code (ISO 639-1). Defaults to 'es' for unknown input.
export const WHISPER_LANG_CODES: Record<Lang, string> = {
  es: 'es',
  en: 'en',
  pt: 'pt',
  zh: 'zh'
}

export interface PiperVoiceSpec {
  name: string
  onnx: string
  onnxJson: string
  urlBase: string
}

// Language → Piper neural voice (rhasspy/piper-voices on HuggingFace).
export const PIPER_VOICES_REGISTRY: Record<Lang, PiperVoiceSpec> = {
  es: {
    name: 'es_ES-davefx-medium',
    onnx: 'es_ES-davefx-medium.onnx',
    onnxJson: 'es_ES-davefx-medium.onnx.json',
    urlBase: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/es/es_ES/davefx/medium'
  },
  en: {
    name: 'en_US-lessac-medium',
    onnx: 'en_US-lessac-medium.onnx',
    onnxJson: 'en_US-lessac-medium.onnx.json',
    urlBase: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium'
  },
  pt: {
    name: 'pt_BR-faber-medium',
    onnx: 'pt_BR-faber-medium.onnx',
    onnxJson: 'pt_BR-faber-medium.onnx.json',
    urlBase: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/pt/pt_BR/faber/medium'
  },
  zh: {
    name: 'zh_CN-huayan-medium',
    onnx: 'zh_CN-huayan-medium.onnx',
    onnxJson: 'zh_CN-huayan-medium.onnx.json',
    urlBase: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/medium'
  }
}

// macOS `say -v` voice per language (graceful fallback TTS, always available).
export const SAY_VOICES: Record<Lang, string> = {
  es: 'Mónica',
  en: 'Samantha',
  pt: 'Luciana',
  zh: 'Sin-ji'
}

// Type guard so IPC payloads coming off the wire are validated before use.
export function isLang(v: unknown): v is Lang {
  return v === 'es' || v === 'en' || v === 'pt' || v === 'zh'
}

// Resolve a (possibly invalid/absent) wire value to a real Lang, defaulting es.
export function asLang(v: unknown): Lang {
  return isLang(v) ? v : 'es'
}

export function whisperLangCode(lang: Lang): string {
  return WHISPER_LANG_CODES[lang] || 'es'
}

export function voiceSpecFor(lang: Lang): PiperVoiceSpec {
  return PIPER_VOICES_REGISTRY[lang] || PIPER_VOICES_REGISTRY.es
}

export function sayVoiceFor(lang: Lang): string {
  return SAY_VOICES[lang] || SAY_VOICES.es
}

// A voice is "ready" only when BOTH its .onnx model and .onnx.json config exist.
export function voiceFilesPresent(piperVoicesDir: string, spec: PiperVoiceSpec): boolean {
  return existsSync(join(piperVoicesDir, spec.onnx)) && existsSync(join(piperVoicesDir, spec.onnxJson))
}

// Return the names of every registry voice already cached on disk.
export function availableVoiceNames(piperVoicesDir: string): string[] {
  return (Object.keys(PIPER_VOICES_REGISTRY) as Lang[])
    .map((l) => PIPER_VOICES_REGISTRY[l])
    .filter((spec) => voiceFilesPresent(piperVoicesDir, spec))
    .map((spec) => spec.name)
}

// Cheap, side-effect-free check: is THIS language's neural voice already on disk?
// Lets the TTS path decide to answer instantly with `say` (and warm the neural
// voice in the background) instead of blocking the first utterance on a download.
export function voiceCached(piperVoicesDir: string, lang: Lang): boolean {
  return voiceFilesPresent(piperVoicesDir, voiceSpecFor(lang))
}

/* ------------------------------------------------------------------ *
 *  Single-file HTTPS download (mirrors voice.ts whisper downloader):
 *  follows redirects, 60s timeout, streams to a unique temp file, then
 *  atomically renames into place. Resolves true on success, false on any
 *  failure (never rejects). Progress is optional and best-effort.
 * ------------------------------------------------------------------ */
function downloadFileTo(
  url: string,
  dest: string,
  voiceName: string,
  label: string,
  onProgress?: (pct: number) => void
): Promise<boolean> {
  // Unique temp filename per attempt so parallel/retried downloads never clash.
  const tmp = `${dest}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.download`

  return new Promise<boolean>((resolve) => {
    let settled = false
    const file = createWriteStream(tmp)

    const cleanupTmp = (): void => {
      fs.rm(tmp, { force: true }).catch(() => {})
    }

    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      if (!ok) {
        try {
          file.destroy()
        } catch {
          /* ignore */
        }
        cleanupTmp()
      }
      resolve(ok)
    }

    file.on('error', (err) => {
      log('warn', 'voice', 'piper:download-fail', {
        voice: voiceName,
        part: label,
        reason: 'file-write-error',
        error: String(err)
      })
      finish(false)
    })

    const req = (u: string, redirectsLeft: number): void => {
      if (settled) return
      const request = https.get(u, { headers: { 'User-Agent': 'CANVASIO' } }, (res) => {
        const status = res.statusCode || 0
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume()
          if (redirectsLeft <= 0) {
            log('warn', 'voice', 'piper:download-fail', {
              voice: voiceName,
              part: label,
              reason: 'too-many-redirects'
            })
            finish(false)
            return
          }
          req(res.headers.location, redirectsLeft - 1)
          return
        }
        if (status !== 200) {
          res.resume()
          log('warn', 'voice', 'piper:download-fail', {
            voice: voiceName,
            part: label,
            reason: 'http-status',
            status
          })
          finish(false)
          return
        }
        const total = parseInt(res.headers['content-length'] || '0', 10)
        let got = 0
        res.on('data', (c) => {
          got += c.length
          if (total && onProgress) {
            try {
              onProgress(Math.round((got / total) * 100))
            } catch {
              /* a throwing progress callback must never break the stream */
            }
          }
        })
        res.on('error', (err) => {
          log('warn', 'voice', 'piper:download-fail', {
            voice: voiceName,
            part: label,
            reason: 'stream-error',
            error: String(err)
          })
          finish(false)
        })
        res.pipe(file)
        file.on('finish', () =>
          file.close(async () => {
            try {
              await fs.rename(tmp, dest)
              finish(true)
            } catch (err) {
              log('warn', 'voice', 'piper:download-fail', {
                voice: voiceName,
                part: label,
                reason: 'rename',
                error: String(err)
              })
              finish(false)
            }
          })
        )
      })
      // HTTP timeout: abort a stalled connection and clean up.
      request.setTimeout(60_000, () => {
        request.destroy(new Error('timeout'))
      })
      request.on('error', (err) => {
        log('warn', 'voice', 'piper:download-fail', {
          voice: voiceName,
          part: label,
          reason: 'request-error',
          error: String(err)
        })
        finish(false)
      })
    }

    req(url, 5)
  })
}

// Download one file with a few retries — a flaky connection (the .json part has
// been seen to time out on otherwise-fine networks) shouldn't doom the whole
// voice. Brief linear backoff; returns true as soon as any attempt succeeds.
async function downloadFileWithRetries(
  url: string,
  dest: string,
  voiceName: string,
  label: string,
  attempts: number,
  onProgress?: (pct: number) => void
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await downloadFileTo(url, dest, voiceName, label, onProgress)) return true
    if (i < attempts - 1) {
      log('info', 'voice', 'piper:download-retry', { voice: voiceName, part: label, attempt: i + 1 })
      await new Promise((r) => setTimeout(r, 800 * (i + 1)))
    }
  }
  return false
}

// Download a voice's .onnx (with progress) then its .onnx.json into destDir.
// Resolves the .onnx path on success, or null on any failure. Each file is
// fetched independently and idempotently: an .onnx already on disk is NOT
// re-downloaded (so a prior run that only missed the tiny .json just retries the
// .json), and a failed .json no longer discards the large .onnx.
async function downloadVoiceOnce(
  destDir: string,
  spec: PiperVoiceSpec,
  onProgress?: (pct: number) => void
): Promise<string | null> {
  const destOnnx = join(destDir, spec.onnx)
  const destOnnxJson = join(destDir, spec.onnxJson)

  if (existsSync(destOnnx) && existsSync(destOnnxJson)) return destOnnx

  await fs.mkdir(destDir, { recursive: true })

  // .onnx is the large file → report download progress for it. Skip if already
  // present from a prior partial attempt.
  if (!existsSync(destOnnx)) {
    const okOnnx = await downloadFileWithRetries(
      `${spec.urlBase}/${spec.onnx}`,
      destOnnx,
      spec.name,
      'onnx',
      3,
      onProgress
    )
    if (!okOnnx) return null
  } else if (onProgress) {
    // Onnx already here — reflect that to any progress UI before the json fetch.
    try {
      onProgress(100)
    } catch {
      /* ignore */
    }
  }

  // .onnx.json is tiny → no progress, but retry it: this is the part that has
  // been observed to time out. Keep the .onnx on failure so the next attempt is
  // cheap (json-only) rather than re-downloading ~60 MB.
  const okJson = await downloadFileWithRetries(
    `${spec.urlBase}/${spec.onnxJson}`,
    destOnnxJson,
    spec.name,
    'json',
    4
  )
  if (!okJson) return null

  log('info', 'voice', 'piper:download-ok', { voice: spec.name })
  return destOnnx
}

// In-flight guard per voice name so concurrent callers share one download.
const voiceInFlight = new Map<string, Promise<string | null>>()

// Ensure a language's Piper voice is on disk, downloading on first use.
// Resolves the .onnx path when ready, or null when unavailable / download failed.
// Never throws.
export async function ensureVoice(
  piperVoicesDir: string,
  lang: Lang,
  onProgress?: (pct: number) => void
): Promise<string | null> {
  const spec = voiceSpecFor(lang)
  const destOnnx = join(piperVoicesDir, spec.onnx)

  if (voiceFilesPresent(piperVoicesDir, spec)) return destOnnx

  const existing = voiceInFlight.get(spec.name)
  if (existing) return existing

  const promise = (async () => {
    try {
      return await downloadVoiceOnce(piperVoicesDir, spec, onProgress)
    } catch (err) {
      log('warn', 'voice', 'piper:download-fail', {
        voice: spec.name,
        reason: 'unexpected',
        error: String(err)
      })
      return null
    } finally {
      voiceInFlight.delete(spec.name)
    }
  })()

  voiceInFlight.set(spec.name, promise)
  return promise
}
