import { join } from 'path'
import { promises as fs, existsSync, createWriteStream } from 'fs'
import https from 'https'
import { log } from './logger'
import type { Lang } from './piperVoices'

/* ================================================================== *
 *  Kokoro-82M neural TTS — model registry + on-demand download
 * ------------------------------------------------------------------
 *  This module owns (pure helpers, no electron import — takes the
 *  kokoroDir as an argument):
 *    - the Kokoro model + voices asset URLs (fp16 ONNX + voices bin),
 *    - the per-language Kokoro voice id (passed as voice=) and the
 *      espeak-ng language code (passed as lang=) for kokoro-onnx,
 *    - on-demand download of BOTH assets into kokoroDir, mirroring the
 *      Piper/whisper downloader (redirects, 60s timeout, atomic rename,
 *      progress callback, in-flight de-dup). Downloads never throw to
 *      callers; a failed/partial download resolves false so TTS can
 *      fall back to `say`. Lang is imported from piperVoices (never
 *      duplicated).
 * ================================================================== */

export interface KokoroAsset {
  fileName: string
  url: string
}

// Kokoro model (fp16 ONNX, ~160 MB) — large, gets download progress.
export const KOKORO_MODEL: KokoroAsset = {
  fileName: 'kokoro-v1.0.fp16.onnx',
  url: 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.fp16.onnx'
}
// Kokoro voices bundle (~26 MB) — fetched second, no progress.
export const KOKORO_VOICES: KokoroAsset = {
  fileName: 'voices-v1.0.bin',
  url: 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin'
}

// Per-language Kokoro voice id (passed as voice=). zh uses misaki[zh].
export const KOKORO_VOICE_IDS: Record<Lang, string> = {
  es: 'ef_dora',
  en: 'af_heart',
  pt: 'pf_dora',
  zh: 'zf_xiaoxiao'
}
// Per-language espeak-ng language code (passed as lang= to kokoro-onnx create()).
// NB: Mandarin is 'cmn' in espeak-ng (NOT 'zh', which espeak rejects). Verified
// end-to-end: 'cmn' + voice zf_xiaoxiao synthesizes; 'zh' raises "language not
// supported by the espeak backend" → would silently fall back to `say`.
export const KOKORO_ESPEAK_LANG: Record<Lang, string> = {
  es: 'es',
  en: 'en-us',
  pt: 'pt-br',
  zh: 'cmn'
}

// Kokoro is "ready" only when BOTH the model and the voices bundle exist.
export function kokoroModelPresent(kokoroDir: string): boolean {
  return (
    existsSync(join(kokoroDir, KOKORO_MODEL.fileName)) &&
    existsSync(join(kokoroDir, KOKORO_VOICES.fileName))
  )
}

/* ------------------------------------------------------------------ *
 *  Single-file HTTPS download (mirrors piperVoices downloader):
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
      log('warn', 'voice', 'kokoro:download-fail', {
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
            log('warn', 'voice', 'kokoro:download-fail', {
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
          log('warn', 'voice', 'kokoro:download-fail', {
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
          log('warn', 'voice', 'kokoro:download-fail', {
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
              log('warn', 'voice', 'kokoro:download-fail', {
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
        log('warn', 'voice', 'kokoro:download-fail', {
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

// Download one file with a few retries — a flaky connection shouldn't doom the
// whole download. Brief linear backoff; returns true as soon as any attempt
// succeeds.
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
      log('info', 'voice', 'kokoro:download-retry', {
        voice: voiceName,
        part: label,
        attempt: i + 1
      })
      await new Promise((r) => setTimeout(r, 800 * (i + 1)))
    }
  }
  return false
}

// In-flight guard so concurrent warm-calls share one download.
let kokoroInFlight: Promise<boolean> | null = null

// Ensure both Kokoro assets are on disk, downloading on first use. The model is
// fetched first (with progress); the voices bundle second (no progress). Each
// file is fetched independently and idempotently: a file already on disk is NOT
// re-downloaded. Resolves true only when BOTH files are present. Never throws.
export async function ensureKokoroModel(
  kokoroDir: string,
  onProgress?: (pct: number) => void
): Promise<boolean> {
  if (kokoroModelPresent(kokoroDir)) return true

  if (kokoroInFlight) return kokoroInFlight

  const promise = (async (): Promise<boolean> => {
    try {
      await fs.mkdir(kokoroDir, { recursive: true })

      const modelPath = join(kokoroDir, KOKORO_MODEL.fileName)
      const voicesPath = join(kokoroDir, KOKORO_VOICES.fileName)

      // Model is the large file → report download progress for it. Skip if
      // already present from a prior partial attempt.
      if (!existsSync(modelPath)) {
        const okModel = await downloadFileWithRetries(
          KOKORO_MODEL.url,
          modelPath,
          KOKORO_MODEL.fileName,
          'model',
          3,
          onProgress
        )
        if (!okModel) return false
      } else if (onProgress) {
        // Model already here — reflect that to any progress UI before voices.
        try {
          onProgress(100)
        } catch {
          /* ignore */
        }
      }

      // Voices bundle is smaller → no progress, but retry a little more.
      if (!existsSync(voicesPath)) {
        const okVoices = await downloadFileWithRetries(
          KOKORO_VOICES.url,
          voicesPath,
          KOKORO_VOICES.fileName,
          'voices',
          4
        )
        if (!okVoices) return false
      }

      log('info', 'voice', 'kokoro:download-ok', {})
      return kokoroModelPresent(kokoroDir)
    } catch (err) {
      log('warn', 'voice', 'kokoro:download-fail', {
        reason: 'unexpected',
        error: String(err)
      })
      return false
    } finally {
      kokoroInFlight = null
    }
  })()

  kokoroInFlight = promise
  return promise
}
