import { ipcMain, BrowserWindow, app } from 'electron'
import { execFile, spawn, type ChildProcess } from 'child_process'
import { promisify } from 'util'
import { join } from 'path'
import { promises as fs, existsSync, createWriteStream } from 'fs'
import os from 'os'
import https from 'https'
import { log } from './logger'
import {
  type Lang,
  asLang,
  whisperLangCode,
  sayVoiceFor,
  availableVoiceNames,
  PIPER_VOICES_REGISTRY
} from './piperVoices'
import {
  KOKORO_MODEL,
  KOKORO_VOICES,
  KOKORO_VOICE_IDS,
  KOKORO_ESPEAK_LANG,
  kokoroModelPresent,
  ensureKokoroModel
} from './kokoroVoices'

const execFileP = promisify(execFile)

/* ================================================================== *
 *  Paths & capability detection
 * ================================================================== */

const userData = (): string => app.getPath('userData')
const modelsDir = (): string => join(userData(), 'models')
const piperDir = (): string => join(userData(), 'piper')
const piperVoicesDir = (): string => join(piperDir(), 'voices')
const piperVenvBin = (): string => join(userData(), 'piper-venv', 'bin', 'piper')

// Kokoro neural TTS lives in userData/kokoro (model .onnx + voices .bin), driven
// by a persistent Python sidecar (scripts/kokoro_tts.py) running in the shared venv.
const kokoroDir = (): string => join(userData(), 'kokoro')

// The Python interpreter that has kokoro-onnx/soundfile installed: prefer the
// app's venv, otherwise fall back to a bare `python` on PATH (sidecar spawn will
// fail → caught → `say`, so this degrades gracefully).
function venvPython(): string {
  const venv = join(userData(), 'piper-venv', 'bin', 'python3')
  return existsSync(venv) ? venv : 'python'
}

// Resolve the bundled sidecar script across dev + packaged layouts.
function kokoroScriptPath(): string | null {
  const candidates = [
    join(app.getAppPath(), 'scripts', 'kokoro_tts.py'),
    join(process.resourcesPath || '', 'scripts', 'kokoro_tts.py'),
    join(__dirname, '..', '..', 'scripts', 'kokoro_tts.py') // dev (out/main → repo root)
  ]
  for (const c of candidates) if (c && existsSync(c)) return c
  return null
}

// Kokoro ENGINE availability: a usable python interpreter AND the sidecar script.
// venvPython() degrades to the literal 'python' when the venv is missing — treat
// that as "assume system python present" (a real miss just fails the spawn →
// caught → `say`). The model files are a SEPARATE presence gate (kokoroModelPresent).
function kokoroAvailable(): boolean {
  const py = venvPython()
  const pyOk = py !== 'python' ? existsSync(py) : true
  return pyOk && kokoroScriptPath() !== null
}

const WHISPER_CANDIDATES = [
  'whisper-cli',
  '/opt/homebrew/bin/whisper-cli',
  '/usr/local/bin/whisper-cli',
  'whisper-cpp',
  '/opt/homebrew/bin/whisper-cpp'
]
const FFMPEG_CANDIDATES = ['ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']

// Whisper STT model (multilingual; strong Spanish, low latency on Apple Silicon/Metal).
// `MODEL_NAME` is the model we DOWNLOAD on demand and treat as the always-available
// baseline. A larger model (e.g. ggml-medium.bin) noticeably improves Spanish
// accuracy but is ~1.4 GB; we never auto-download it. Instead, if a preferred model
// is already present on disk we use it, otherwise we fall back to the baseline —
// this stays fully offline and never hard-fails.
const MODEL_NAME = process.env.CANVASIO_WHISPER_MODEL_NAME || 'ggml-small.bin'
const MODEL_URL =
  process.env.CANVASIO_WHISPER_MODEL_URL ||
  `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_NAME}`

// Optional higher-accuracy model. Used ONLY when its file already exists in the
// models dir; if absent we silently use the baseline MODEL_NAME above. Override
// with CANVASIO_WHISPER_PREFERRED_MODEL or set it equal to MODEL_NAME to disable.
const PREFERRED_MODEL_NAME =
  process.env.CANVASIO_WHISPER_PREFERRED_MODEL || 'ggml-medium.bin'

// Per-language Piper voice + macOS `say` fallback voice + whisper `-l` codes all
// live in ./piperVoices (registry + on-demand voice downloads).

async function which(cands: string[]): Promise<string | null> {
  for (const c of cands) {
    if (c.startsWith('/')) {
      if (existsSync(c)) return c
      continue
    }
    try {
      const { stdout } = await execFileP('which', [c])
      if (stdout.trim()) return stdout.trim()
    } catch {
      /* not found */
    }
  }
  return null
}

let whisperBin: string | null = null
let ffmpegBin: string | null = null

function modelPath(): string {
  return join(modelsDir(), MODEL_NAME)
}
// Resolve the model file to feed whisper: prefer the higher-accuracy model when
// it is already on disk, otherwise the baseline path (caller guarantees baseline
// exists). Never triggers a download of the preferred model — fully graceful.
function bestModelPath(baseline: string): string {
  if (PREFERRED_MODEL_NAME && PREFERRED_MODEL_NAME !== MODEL_NAME) {
    const preferred = join(modelsDir(), PREFERRED_MODEL_NAME)
    if (existsSync(preferred)) return preferred
  }
  return baseline
}
// Piper ENGINE availability (legacy — retained only for the `piper` capability
// field; Piper is no longer used for synthesis). True when the venv binary exists.
function piperAvailable(): boolean {
  return existsSync(piperVenvBin())
}

/* ================================================================== *
 *  STT model download (whisper)
 * ================================================================== */

// Single in-flight guard so concurrent callers share one download attempt.
let modelInFlight: Promise<string | null> | null = null

async function downloadModelOnce(onProgress?: (pct: number) => void): Promise<string | null> {
  const dest = modelPath()
  if (existsSync(dest)) return dest
  await fs.mkdir(modelsDir(), { recursive: true })

  // Unique temp filename per attempt so parallel/retried downloads never clash.
  const tmp = `${dest}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.download`

  return new Promise<string | null>((resolve) => {
    let settled = false
    const file = createWriteStream(tmp)

    const cleanupTmp = (): void => {
      fs.rm(tmp, { force: true }).catch(() => {})
    }

    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      if (value === null) {
        // make sure the partial .download file never lingers
        try {
          file.destroy()
        } catch {
          /* ignore */
        }
        cleanupTmp()
      }
      resolve(value)
    }

    file.on('error', (err) => {
      log('warn', 'voice', 'model:download-fail', { reason: 'file-write-error', error: String(err) })
      finish(null)
    })

    const req = (url: string, redirectsLeft: number): void => {
      if (settled) return
      const request = https.get(url, { headers: { 'User-Agent': 'CANVASIO' } }, (res) => {
        const status = res.statusCode || 0
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume()
          if (redirectsLeft <= 0) {
            log('warn', 'voice', 'model:download-fail', { reason: 'too-many-redirects' })
            finish(null)
            return
          }
          req(res.headers.location, redirectsLeft - 1)
          return
        }
        if (status !== 200) {
          res.resume()
          log('warn', 'voice', 'model:download-fail', { reason: 'http-status', status })
          finish(null)
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
              /* a throwing progress callback must never break the download stream */
            }
          }
        })
        res.on('error', (err) => {
          log('warn', 'voice', 'model:download-fail', { reason: 'stream-error', error: String(err) })
          finish(null)
        })
        res.pipe(file)
        file.on('finish', () =>
          file.close(async () => {
            try {
              await fs.rename(tmp, dest)
              log('info', 'voice', 'model:download-ok', {})
              finish(dest)
            } catch (err) {
              log('warn', 'voice', 'model:download-fail', { reason: 'rename', error: String(err) })
              finish(null)
            }
          })
        )
      })
      // HTTP timeout: abort a stalled connection and clean up.
      request.setTimeout(60_000, () => {
        request.destroy(new Error('timeout'))
      })
      request.on('error', (err) => {
        log('warn', 'voice', 'model:download-fail', { reason: 'request-error', error: String(err) })
        finish(null)
      })
    }

    req(MODEL_URL, 5)
  })
}

async function ensureModel(onProgress?: (pct: number) => void): Promise<string | null> {
  const dest = modelPath()
  if (existsSync(dest)) return dest
  if (modelInFlight) return modelInFlight
  modelInFlight = (async () => {
    try {
      return await downloadModelOnce(onProgress)
    } finally {
      modelInFlight = null
    }
  })()
  return modelInFlight
}

/* ================================================================== *
 *  Friendly error mapping (English engine output -> Spanish UI text)
 * ================================================================== */

function friendlyError(raw: unknown): string {
  const msg = String((raw as { message?: string })?.message || raw || '').trim()
  const low = msg.toLowerCase()

  // Missing dependencies
  if (low.includes('whisper') && (low.includes('no instalado') || low.includes('not found') || low.includes('enoent'))) {
    return 'whisper.cpp no está instalado. Instálalo con: brew install whisper-cpp'
  }
  if (low.includes('ffmpeg') && (low.includes('no instalado') || low.includes('not found') || low.includes('enoent'))) {
    return 'ffmpeg no está instalado. Instálalo con: brew install ffmpeg'
  }
  if (low.includes('enoent') || low.includes('command not found')) {
    return 'No se encontró una herramienta necesaria (whisper, ffmpeg o say).'
  }

  // Model / network
  if (low.includes('modelo de stt') || low.includes('failed to load model') || low.includes('load model')) {
    return 'No se pudo preparar el modelo de reconocimiento de voz. Revisa tu conexión e inténtalo de nuevo.'
  }
  if (low.includes('timeout') || low.includes('etimedout') || low.includes('socket hang up') || low.includes('econnreset') || low.includes('enotfound')) {
    return 'Fallo de red al descargar el modelo. Comprueba tu conexión a internet.'
  }

  // ffmpeg / decoding
  if (low.includes('invalid data found') || low.includes('could not find codec') || low.includes('decoding')) {
    return 'No se pudo procesar el audio grabado. Inténtalo de nuevo.'
  }

  // whisper produced nothing usable
  if (low.includes('empty') || low.includes('no speech')) {
    return 'No se detectó voz en la grabación. Inténtalo de nuevo.'
  }

  // Pipe / process issues
  if (low.includes('epipe') || low.includes('write after end')) {
    return 'Error al comunicar con el motor de voz. Inténtalo de nuevo.'
  }

  if (!msg) return 'Ocurrió un error inesperado con la voz.'
  // Already-Spanish messages pass through unchanged.
  if (/[áéíóúñ¿¡]/i.test(msg) || /\b(no se|fall|error|inst|model)\b/i.test(msg) === false) {
    return msg
  }
  return msg
}

/* ================================================================== *
 *  Speech-to-text (whisper.cpp, Metal-accelerated)
 * ================================================================== */

// Bytes 0-3 = "RIFF", bytes 8-11 = "WAVE" → a real WAV container regardless of
// the declared mime. Lets us take the no-transcode fast path safely.
function isWav(buf: Buffer): boolean {
  return (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WAVE'
  )
}

// Known whisper SILENCE-HALLUCINATIONS: subtitle-credit artifacts baked into its
// training data that it emits on quiet/no-speech audio (the user said nothing but
// gets a made-up command). The renderer's RMS gate blocks most silent clips before
// STT; this is a backstop for the rest. Conservative: only fires when the WHOLE
// output is one of these artifacts.
function isHallucination(text: string): boolean {
  const n = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!n) return false
  const PHRASES = new Set([
    'subtitulos por la comunidad de amara org',
    'subtitulos realizados por la comunidad de amara org',
    'subtitulado por la comunidad de amara org',
    'amara org',
    'mas informacion www',
    'gracias por ver el video',
    'gracias por ver',
    'gracias por verlo',
    'thanks for watching',
    'thank you for watching',
    'subtitles by the amara org community'
  ])
  if (PHRASES.has(n)) return true
  // Short, pure credit fragments ("titulado por", "subtítulos por", "…amara…").
  if (
    n.length <= 40 &&
    (n.includes('amara') ||
      n.startsWith('subtitulos') ||
      n.startsWith('subtitulado') ||
      n.startsWith('titulado por'))
  ) {
    return true
  }
  return false
}

async function transcribe(audioBuf: Buffer, mime: string, lang: Lang = 'es'): Promise<string> {
  // Guard empty / truncated payloads before doing any work.
  if (!audioBuf || audioBuf.length < 64) {
    throw new Error('No se detectó voz en la grabación. Inténtalo de nuevo.')
  }

  if (!whisperBin) whisperBin = await which(WHISPER_CANDIDATES)
  if (!whisperBin) throw new Error('whisper.cpp no instalado (brew install whisper-cpp)')

  // Make sure the model is on disk; download it on first use if needed.
  let model = modelPath()
  if (!existsSync(model)) {
    const fetched = await ensureModel()
    if (!fetched || !existsSync(fetched)) {
      throw new Error(
        'No se pudo preparar el modelo de reconocimiento de voz. Revisa tu conexión e inténtalo de nuevo.'
      )
    }
    model = fetched
  }

  const tmpDir = await fs.mkdtemp(join(os.tmpdir(), 'canvasio-stt-'))
  try {
    const wavFile = join(tmpDir, 'in16k.wav')

    // Fast path: the renderer already produced clean 16 kHz mono PCM16 WAV.
    // Detect by mime OR by sniffing the RIFF/WAVE magic — write it straight to
    // disk, no ffmpeg, no extra decode. This is the normal mic path.
    if (mime.includes('wav') || isWav(audioBuf)) {
      await fs.writeFile(wavFile, audioBuf)
    } else {
      // Fallback for raw container formats (webm/ogg) that reached us undecoded.
      if (!ffmpegBin) ffmpegBin = await which(FFMPEG_CANDIDATES)
      if (!ffmpegBin) throw new Error('ffmpeg no instalado')
      const ext = mime.includes('ogg') ? 'ogg' : 'webm'
      const inFile = join(tmpDir, `in.${ext}`)
      await fs.writeFile(inFile, audioBuf)
      try {
        await execFileP(ffmpegBin, [
          '-y',
          '-i',
          inFile,
          '-ar',
          '16000',
          '-ac',
          '1',
          '-c:a',
          'pcm_s16le',
          wavFile
        ])
      } catch (err) {
        throw new Error('No se pudo procesar el audio grabado. Inténtalo de nuevo.')
      }
    }

    // Use the higher-accuracy model when present; otherwise the baseline we just
    // ensured is on disk. This never downloads the preferred model.
    const sttModel = bestModelPath(model)

    // Map the requested app language to its whisper `-l` code (es/en/pt/zh).
    // Forcing the language (never auto-detect) avoids wrong-language guesses on
    // short clips. Unknown/absent → 'es'.
    const whisperLang = whisperLangCode(lang)

    const outBase = join(tmpDir, 'out')
    // Verified args (whisper-cli / whisper-cpp 1.8.x) tuned for short Spanish
    // utterances:
    //   -l es        force Spanish (never auto-detect → no wrong-language guesses)
    //   -nt          no timestamps (we only want the text)
    //   -bs 2        beam size 2 — a touch more accurate than greedy(1), still well
    //                under a second on Metal for these short clips
    //   -tp 0        sampling temperature 0 → deterministic, highest-prob tokens
    //   -nf          no temperature fallback — never re-decode at a higher (random)
    //                temperature, keeping output reproducible
    //   -mc 0        max-context 0 → do NOT condition on previous text. Isolated
    //                commands have no history, so prior-text context only invites
    //                hallucinated carry-over.
    //   -nth 0.6     no-speech threshold — suppress silence / room-noise segments
    //                below 60% speech confidence
    //   -otxt -of    plain-text output to <outBase>.txt
    // Metal accel is automatic.
    try {
      await execFileP(whisperBin, [
        '-m',
        sttModel,
        '-f',
        wavFile,
        '-l',
        whisperLang,
        '-nt',
        '-bs',
        '2',
        '-tp',
        '0',
        '-nf',
        '-mc',
        '0',
        '-nth',
        '0.6',
        '-otxt',
        '-of',
        outBase
      ])
    } catch (err) {
      // whisper failing to load the model usually means a corrupt/partial file.
      const m = String((err as { message?: string })?.message || err).toLowerCase()
      if (m.includes('load model') || m.includes('failed to load')) {
        // The model file is corrupt/partial; delete it (best-effort) so the
        // next STT call re-downloads a fresh copy instead of reusing the bad one.
        await fs.rm(model, { force: true }).catch(() => {})
        throw new Error(
          'No se pudo preparar el modelo de reconocimiento de voz. Revisa tu conexión e inténtalo de nuevo.'
        )
      }
      throw new Error('No se pudo procesar el audio grabado. Inténtalo de nuevo.')
    }

    let text = ''
    try {
      text = (await fs.readFile(outBase + '.txt', 'utf8')).trim()
    } catch {
      /* whisper wrote no output file → treat as no speech below */
    }
    // strip whisper's bracketed non-speech annotations like [Música]
    const clean = text.replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim()
    // Backstop for whisper's silence HALLUCINATIONS: on quiet/no-speech audio it
    // emits subtitle-credit artifacts from its training data. If the WHOLE output
    // is one of these (or a bare credit fragment), drop it so it never runs as a
    // command. (The renderer's RMS silence-gate already blocks most before STT.)
    if (isHallucination(clean)) return ''
    return clean
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

/* ================================================================== *
 *  Text-to-speech — layered backends:
 *    1) Kokoro-82M (neural, multilingual) via persistent Python sidecar
 *    2) macOS `say -v <voice>` (always available) -> wav via afconvert
 * ================================================================== */

// Spawn `file args` via execFile and feed `text` to its stdin, resolving when the
// child exits (or rejecting on any spawn/stdin/EPIPE error). Used by ttsSay.
function runWithStdin(file: string, args: string[], text: string, label: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const done = (err?: Error): void => {
      if (settled) return
      settled = true
      if (err) reject(err)
      else resolve()
    }

    let child: ReturnType<typeof execFile>
    try {
      child = execFile(file, args, (err) => done(err || undefined))
    } catch (err) {
      // execFile can throw synchronously (e.g. bad binary path)
      done(err as Error)
      return
    }

    // Guard against EPIPE / write-after-end becoming unhandled rejections.
    child.on('error', (err) => done(err))
    const stdin = child.stdin
    if (!stdin) {
      done(new Error(`${label} stdin no disponible`))
      return
    }
    stdin.on('error', (err) => done(err))
    try {
      stdin.write(text, (err) => {
        if (err) {
          done(err)
          return
        }
        stdin.end()
      })
    } catch (err) {
      done(err as Error)
    }
  })
}

async function ttsSay(text: string, voice: string): Promise<Buffer> {
  const tmpDir = await fs.mkdtemp(join(os.tmpdir(), 'canvasio-tts-'))
  try {
    const aiff = join(tmpDir, 'out.aiff')
    const wav = join(tmpDir, 'out.wav')

    // `say` writes AIFF; pass text via stdin to avoid arg/length issues and EPIPE.
    await runWithStdin('say', ['-v', voice, '-o', aiff], text, 'say')

    // ALWAYS transcode the AIFF to a real WAV using afconvert (ships with macOS).
    // Never return raw AIFF — the renderer expects WAV/PCM.
    await execFileP('afconvert', [aiff, wav, '-d', 'LEI16', '-f', 'WAVE'])
    return await fs.readFile(wav)
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

/* ------------------------------------------------------------------ *
 *  Piper es_ES (SPAIN/Castilian) voices — selectable alongside Kokoro.
 *  Kokoro's Spanish is Latin-American only (hexgrad/kokoro#246), so the
 *  genuine Castilian voices stay on Piper. Map a selector voice id to its
 *  .onnx basename in piperVoicesDir(); both .onnx and .onnx.json must exist.
 * ------------------------------------------------------------------ */
const PIPER_VOICE_FILES: Record<string, string> = {
  davefx: 'es_ES-davefx-medium'
}

// True when the Piper engine (venv binary) AND this voice's model are on disk.
function piperVoiceReady(base: string): boolean {
  return (
    existsSync(piperVenvBin()) &&
    existsSync(join(piperVoicesDir(), `${base}.onnx`)) &&
    existsSync(join(piperVoicesDir(), `${base}.onnx.json`))
  )
}

async function ttsPiperVoice(text: string, base: string): Promise<Buffer> {
  const onnx = join(piperVoicesDir(), `${base}.onnx`)
  const tmpDir = await fs.mkdtemp(join(os.tmpdir(), 'canvasio-tts-'))
  try {
    const wav = join(tmpDir, 'out.wav')
    await runWithStdin(piperVenvBin(), ['--model', onnx, '--output_file', wav], text, 'piper')
    return await fs.readFile(wav)
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

/* ------------------------------------------------------------------ *
 *  Persistent Kokoro sidecar manager
 * ------------------------------------------------------------------
 *  ONE long-lived Python child (scripts/kokoro_tts.py) loads the ~160 MB ONNX
 *  model once and serves many synthesis requests over newline-delimited JSON.
 *  We lazy-spawn it on first use, track readiness from its {"ready":true} /
 *  {"fatal":...} startup line, key in-flight requests by id, respawn after a
 *  death, and kill it on app quit / all-windows-closed. Every request has a
 *  20 s timeout so a wedged sidecar never hangs the UI — the caller falls back
 *  to `say`.
 * ------------------------------------------------------------------ */
interface KReq {
  resolve: () => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}
let kProc: ChildProcess | null = null
let kReady: Promise<void> | null = null
let kStdoutBuf = ''
const kPending = new Map<string, KReq>()
const KOKORO_REQ_TIMEOUT_MS = 20_000

function killKokoro(): void {
  for (const [, p] of kPending) {
    clearTimeout(p.timer)
    p.reject(new Error('kokoro:killed'))
  }
  kPending.clear()
  if (kProc) {
    try {
      kProc.kill('SIGKILL')
    } catch {
      /* already gone */
    }
    kProc = null
  }
  kReady = null
  kStdoutBuf = ''
}

function ensureKokoroProc(): Promise<void> {
  if (kProc && kReady) return kReady
  const script = kokoroScriptPath()
  if (!script) return Promise.reject(new Error('kokoro:script-missing'))
  const model = join(kokoroDir(), KOKORO_MODEL.fileName)
  const voices = join(kokoroDir(), KOKORO_VOICES.fileName)

  kReady = new Promise<void>((resolve, reject) => {
    let settledReady = false
    const child = spawn(venvPython(), [script, '--model', model, '--voices', voices], {
      stdio: ['pipe', 'pipe', 'pipe']
    })
    kProc = child
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => {
      kStdoutBuf += chunk
      let nl: number
      while ((nl = kStdoutBuf.indexOf('\n')) >= 0) {
        const line = kStdoutBuf.slice(0, nl).trim()
        kStdoutBuf = kStdoutBuf.slice(nl + 1)
        if (!line) continue
        let msg: any
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.ready === true && !settledReady) {
          settledReady = true
          resolve()
          continue
        }
        if (msg.fatal === true && !settledReady) {
          settledReady = true
          reject(new Error(`kokoro:fatal ${msg.error || ''}`))
          return
        }
        if (msg.id && kPending.has(msg.id)) {
          const p = kPending.get(msg.id)!
          clearTimeout(p.timer)
          kPending.delete(msg.id)
          if (msg.ok) p.resolve()
          else p.reject(new Error(`kokoro:req ${msg.error || ''}`))
        }
      }
    })
    child.stderr!.on('data', () => {
      /* swallow espeak/onnx chatter */
    })
    child.on('error', (err) => {
      if (!settledReady) {
        settledReady = true
        reject(err)
      }
      killKokoro()
    })
    child.on('exit', () => {
      if (!settledReady) {
        settledReady = true
        reject(new Error('kokoro:exited-before-ready'))
      }
      killKokoro() // respawn happens lazily on next ensureKokoroProc()
    })
  }).catch((e) => {
    killKokoro()
    throw e
  })
  return kReady
}

function kokoroRequest(payload: {
  text: string
  voice: string
  lang: string
  out: string
}): Promise<void> {
  const id = `${Date.now()}.${Math.random().toString(36).slice(2)}`
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      kPending.delete(id)
      reject(new Error('kokoro:timeout'))
    }, KOKORO_REQ_TIMEOUT_MS)
    kPending.set(id, { resolve, reject, timer })
    try {
      kProc!.stdin!.write(JSON.stringify({ id, ...payload }) + '\n')
    } catch (err) {
      clearTimeout(timer)
      kPending.delete(id)
      reject(err as Error)
    }
  })
}

// Resolve the Kokoro voice id to use: the caller's explicit choice (the user's
// per-language preference from the Settings selector) when it's a non-empty
// string, otherwise the language default. The espeak phonemizer language always
// derives from `lang`, not the voice, so a mismatched pick still phonemizes right.
function resolveKokoroVoice(lang: Lang, voiceId?: string): string {
  const v = (voiceId || '').trim()
  return v || KOKORO_VOICE_IDS[lang]
}

async function ttsKokoro(text: string, lang: Lang, voiceId?: string): Promise<Buffer> {
  // Model not on disk yet → throw so synthesize() warms in the background and
  // answers this utterance instantly with `say`.
  if (!kokoroModelPresent(kokoroDir())) throw new Error('kokoro model not present')
  await ensureKokoroProc() // throws if sidecar fatal/missing → caught upstream
  const tmpDir = await fs.mkdtemp(join(os.tmpdir(), 'canvasio-tts-'))
  try {
    const wav = join(tmpDir, 'out.wav')
    await kokoroRequest({
      text,
      voice: resolveKokoroVoice(lang, voiceId),
      lang: KOKORO_ESPEAK_LANG[lang],
      out: wav
    })
    return await fs.readFile(wav)
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function synthesize(
  text: string,
  lang: Lang = 'es',
  onProgress?: (pct: number) => void,
  voiceId?: string
): Promise<{ buf: Buffer; backend: string; voice: string }> {
  // Piper es_ES (Spain/Castilian) voice explicitly chosen → route to Piper. A
  // Piper-only voice id must NEVER reach Kokoro (it has no such voice), so on any
  // failure we null it and fall through to the language's Kokoro/say default.
  const piperBase = PIPER_VOICE_FILES[(voiceId || '').trim()]
  if (piperBase) {
    if (piperVoiceReady(piperBase)) {
      try {
        return { buf: await ttsPiperVoice(text, piperBase), backend: 'piper', voice: voiceId!.trim() }
      } catch (err) {
        log('warn', 'voice', 'piper:fallback', { voice: voiceId, error: String(err) })
      }
    } else {
      log('info', 'voice', 'piper:voice-missing', { voice: voiceId })
    }
    voiceId = undefined
  }
  if (kokoroAvailable()) {
    if (kokoroModelPresent(kokoroDir())) {
      // Neural model already on disk → synthesize via the persistent sidecar.
      try {
        return {
          buf: await ttsKokoro(text, lang, voiceId),
          backend: 'kokoro',
          voice: resolveKokoroVoice(lang, voiceId)
        }
      } catch (err) {
        // Sidecar/synthesis failed → graceful fallback to `say`. Never throw.
        log('warn', 'voice', 'kokoro:fallback', { lang, error: String(err) })
      }
    } else {
      // Model NOT downloaded yet. Don't block this utterance on the ~160 MB
      // download — answer INSTANTLY with `say`, and warm the model in the
      // background so the NEXT call speaks with Kokoro. Reuse the existing
      // progress callback so the renderer's download bar shows the fetch.
      log('info', 'voice', 'kokoro:warming', { lang })
      ensureKokoroModel(kokoroDir(), onProgress).catch(() => {})
    }
  }
  const sayVoice = sayVoiceFor(lang)
  return { buf: await ttsSay(text, sayVoice), backend: 'say', voice: sayVoice }
}

/* ================================================================== *
 *  IPC
 * ================================================================== */

export function registerVoiceHandlers(getWindow: () => BrowserWindow | null): void {
  // Tear down the persistent Kokoro sidecar on shutdown so it never outlives the
  // app (rejects any in-flight requests and SIGKILLs the child).
  app.on('before-quit', killKokoro)
  app.on('window-all-closed', killKokoro)

  ipcMain.handle('voice:capabilities', async () => {
    whisperBin = await which(WHISPER_CANDIDATES)
    ffmpegBin = await which(FFMPEG_CANDIDATES)
    const piper = piperAvailable()
    const kokoro = kokoroAvailable()
    const kokoroReady = kokoroModelPresent(kokoroDir())
    if (!whisperBin) log('warn', 'voice', 'dep-missing', { dep: 'whisper' })
    if (!ffmpegBin) log('warn', 'voice', 'dep-missing', { dep: 'ffmpeg' })
    // Which per-language Piper voices are already cached on disk (legacy field,
    // kept so the renderer's existing `voices`/`piper` reads keep working).
    const cachedVoices = availableVoiceNames(piperVoicesDir())
    log('info', 'voice', 'capabilities', {
      stt: !!whisperBin,
      piper,
      kokoro,
      kokoroModelReady: kokoroReady,
      modelReady: existsSync(modelPath()),
      cachedVoices
    })
    return {
      stt: !!whisperBin,
      sttBackend: whisperBin ? 'whisper.cpp' : null,
      tts: true,
      // Kokoro is the primary TTS once its model is on disk; until then we speak
      // with macOS `say` (and warm Kokoro in the background on first use).
      ttsBackend: kokoroReady ? 'kokoro' : 'say · multilingual',
      modelReady: existsSync(modelPath()),
      piper,
      // Every supported Piper voice (legacy registry); cached subset above.
      voices: Object.values(PIPER_VOICES_REGISTRY).map((v) => v.name),
      kokoro,
      kokoroModelReady: kokoroReady
    }
  })

  ipcMain.handle('voice:ensureModel', async () => {
    const sendProgress = (pct: number): void => {
      // Guard against the window being closed mid-download: getWindow() may still
      // return a window whose webContents is destroyed, so send() would throw and
      // escape the download stream's 'data' handler as an uncaughtException.
      const win = getWindow()
      if (!win || win.isDestroyed()) return
      const wc = win.webContents
      if (!wc || wc.isDestroyed()) return
      try {
        wc.send('voice:modelProgress', pct)
      } catch {
        /* window/webContents gone between checks */
      }
    }
    const m = await ensureModel(sendProgress)
    return { ok: !!m }
  })

  ipcMain.handle(
    'voice:stt',
    async (_e, payload: { audioBase64: string; mime: string; lang?: string }) => {
      try {
        const buf = Buffer.from(payload.audioBase64, 'base64')
        const lang = asLang(payload.lang)
        const text = await transcribe(buf, payload.mime || 'audio/webm', lang)
        return { ok: true, text }
      } catch (err: any) {
        // Log the RAW cause (the friendly Spanish text is only for the UI).
        log('error', 'voice', 'stt:fail', { stage: 'stt', rawMessage: String(err?.message ?? err) })
        return { ok: false, error: friendlyError(err) }
      }
    }
  )

  ipcMain.handle(
    'voice:tts',
    async (_e, payload: { text: string; voice?: string; lang?: string }) => {
      try {
        const lang = asLang(payload.lang)
        // First-use voice downloads stream progress to the renderer on the same
        // channel as the whisper model download.
        const sendProgress = (pct: number): void => {
          const win = getWindow()
          if (!win || win.isDestroyed()) return
          const wc = win.webContents
          if (!wc || wc.isDestroyed()) return
          try {
            wc.send('voice:modelProgress', pct)
          } catch {
            /* window/webContents gone between checks */
          }
        }
        // payload.voice is the user's per-language Kokoro voice choice (Settings
        // selector); undefined → language default inside synthesize().
        const { buf, backend, voice } = await synthesize(
          payload.text,
          lang,
          sendProgress,
          payload.voice
        )
        return { ok: true, wavBase64: buf.toString('base64'), backend, voice }
      } catch (err: any) {
        log('error', 'voice', 'tts:fail', { stage: 'tts', rawMessage: String(err?.message ?? err) })
        return { ok: false, error: friendlyError(err) }
      }
    }
  )

  ipcMain.handle('voice:warm', async () => {
    // warm whisper model in the background so first STT is fast
    ensureModel().catch(() => {})
    return { ok: true }
  })
}
