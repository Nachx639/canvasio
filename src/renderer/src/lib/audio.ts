/**
 * Decode a recorded audio Blob (webm/ogg/…) and re-render it to a clean
 * 16 kHz mono 16-bit PCM WAV. Doing the container/codec work in the renderer
 * with WebAudio avoids feeding a half-finalised webm to ffmpeg (which failed
 * with "EBML header parsing failed / Invalid data found").
 *
 * The produced WAV is a canonical 44-byte-header RIFF/WAVE file:
 *   PCM (fmt tag 1), 1 channel, 16 kHz, 16-bit little-endian samples.
 * whisper.cpp reads this directly with no transcode needed.
 */

const TARGET_RATE = 16000

/** Errors thrown here use stable string codes the UI can translate. */
export class AudioError extends Error {
  constructor(public code: string, message?: string) {
    super(message || code)
    this.name = 'AudioError'
  }
}

export async function blobToWav16k(blob: Blob): Promise<Blob> {
  const mono = await decodeBlobToMono16k(blob)
  return encodeWav(mono, TARGET_RATE)
}

/**
 * Like blobToWav16k, but PREPENDS pre-roll PCM (the rolling warm-mic buffer,
 * captured slightly BEFORE push-to-talk started) and APPENDS a short trailing
 * silence pad. This is what eliminates start-of-speech clipping: whisper sees
 * the opening syllable the user spoke before the recorder actually fired, and
 * the trailing pad keeps the last word's decay from being cut mid-formant.
 *
 * Both the pre-roll and the decoded clip are resampled to 16 kHz mono and
 * concatenated in the PCM domain ([preRoll][clip][pad]) so the output is still a
 * single canonical WAV — we never try to splice container/codec bytes together.
 *
 * @param blob       the MediaRecorder webm/opus capture
 * @param preRoll    raw Float32 mono PCM captured at `preRollRate` (may be empty)
 * @param preRollRate sample rate of `preRoll` (the warm AudioContext rate)
 * @param padMs      trailing silence to append, in milliseconds
 */
export async function blobToWav16kPadded(
  blob: Blob,
  preRoll: Float32Array,
  preRollRate: number,
  padMs: number
): Promise<Blob> {
  const clip = await decodeBlobToMono16k(blob)

  // Resample the pre-roll (captured at the warm context's native rate) to 16 kHz.
  const pre =
    preRoll && preRoll.length > 0 && preRollRate > 0
      ? resampleLinear(preRoll, preRollRate, TARGET_RATE)
      : new Float32Array(0)

  const padSamples = Math.max(0, Math.round((padMs / 1000) * TARGET_RATE))

  if (pre.length === 0 && padSamples === 0) {
    return encodeWav(clip, TARGET_RATE)
  }

  const out = new Float32Array(pre.length + clip.length + padSamples)
  out.set(pre, 0)
  out.set(clip, pre.length)
  // remaining tail stays zero-filled → silence pad
  return encodeWav(out, TARGET_RATE)
}

/**
 * Decode a recorded Blob to a 16 kHz mono Float32Array (the shared core of
 * blobToWav16k / blobToWav16kPadded). Applies the same empty/short guards.
 */
async function decodeBlobToMono16k(blob: Blob): Promise<Float32Array> {
  if (!blob || blob.size === 0) throw new AudioError('empty-recording', 'grabación vacía')

  const arrayBuf = await blob.arrayBuffer()
  if (arrayBuf.byteLength < 1024) throw new AudioError('empty-recording', 'grabación vacía')

  const AudioCtx: typeof AudioContext | undefined =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioCtx) throw new AudioError('no-audio-api', 'WebAudio no disponible')

  const ac = new AudioCtx()
  let decoded: AudioBuffer
  try {
    decoded = await decodeAudioData(ac, arrayBuf.slice(0))
  } catch (err) {
    throw new AudioError(
      'decode-failed',
      'no se pudo decodificar el audio grabado: ' + String((err as Error)?.message || err)
    )
  } finally {
    ac.close().catch(() => {})
  }

  if (!decoded || decoded.length === 0 || !isFinite(decoded.duration) || decoded.duration <= 0) {
    throw new AudioError('decode-empty', 'la grabación no contiene audio')
  }
  if (decoded.duration < 0.15) throw new AudioError('too-short', 'grabación muy corta')

  const frames = Math.max(1, Math.ceil(decoded.duration * TARGET_RATE))
  const offline = new OfflineAudioContext(1, frames, TARGET_RATE)
  const src = offline.createBufferSource()
  src.buffer = decoded
  src.connect(offline.destination)
  src.start()
  const rendered = await offline.startRendering()
  const mono = rendered.getChannelData(0)
  if (mono.length === 0) throw new AudioError('decode-empty', 'la grabación no contiene audio')
  // SILENCE GATE: whisper hallucinates subtitle-credit phrases ("titulado por",
  // "Subtítulos por…", "Amara.org") on near-silent audio. If the clip's RMS energy
  // is below a speech floor, treat it as no-speech and bail BEFORE transcribing, so
  // pressing record + saying nothing never produces a made-up command.
  let sumSq = 0
  for (let i = 0; i < mono.length; i++) sumSq += mono[i] * mono[i]
  const rms = Math.sqrt(sumSq / mono.length)
  if (rms < 0.006) throw new AudioError('silent', 'sin voz (silencio)')
  // Copy out of the rendered buffer so the AudioContext can be GC'd.
  return mono.slice(0)
}

/**
 * Cheap linear resample of mono Float32 PCM. The pre-roll is only ~300 ms, so
 * linear interpolation is more than adequate and avoids spinning up another
 * OfflineAudioContext on the hot path.
 */
function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input
  const ratio = toRate / fromRate
  const outLen = Math.max(1, Math.round(input.length * ratio))
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const srcPos = i / ratio
    const i0 = Math.floor(srcPos)
    const i1 = Math.min(input.length - 1, i0 + 1)
    const frac = srcPos - i0
    out[i] = input[i0] * (1 - frac) + input[i1] * frac
  }
  return out
}

/**
 * decodeAudioData has both a Promise-based and a legacy callback signature.
 * Some Chromium builds only resolve the callback form for certain webm/opus
 * blobs, so try the Promise first and fall back to the callback form.
 */
function decodeAudioData(ac: BaseAudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise<AudioBuffer>((resolve, reject) => {
    let settled = false
    const ok = (b: AudioBuffer): void => {
      if (settled) return
      settled = true
      resolve(b)
    }
    const fail = (e: unknown): void => {
      if (settled) return
      settled = true
      reject(e instanceof Error ? e : new Error(String(e || 'decodeAudioData failed')))
    }
    try {
      const maybe = ac.decodeAudioData(data, ok, fail)
      // Promise-returning implementations: prefer it but the callbacks above
      // still cover engines that ignore the return value.
      if (maybe && typeof (maybe as Promise<AudioBuffer>).then === 'function') {
        ;(maybe as Promise<AudioBuffer>).then(ok, fail)
      }
    } catch (e) {
      fail(e)
    }
  })
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const dataBytes = samples.length * 2
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)
  const writeStr = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
  }
  // RIFF header
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true) // file size - 8
  writeStr(8, 'WAVE')
  // fmt chunk (PCM)
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // audio format = PCM
  view.setUint16(22, 1, true) // channels = 1 (mono)
  view.setUint32(24, sampleRate, true) // sample rate
  view.setUint32(28, sampleRate * 2, true) // byte rate = rate * channels * bytesPerSample
  view.setUint16(32, 2, true) // block align = channels * bytesPerSample
  view.setUint16(34, 16, true) // bits per sample
  // data chunk
  writeStr(36, 'data')
  view.setUint32(40, dataBytes, true)
  let off = 44
  for (let i = 0; i < samples.length; i++) {
    let s = samples[i]
    // clamp then convert to signed 16-bit
    s = s < -1 ? -1 : s > 1 ? 1 : s
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    off += 2
  }
  return new Blob([buffer], { type: 'audio/wav' })
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < buf.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + chunk)) as unknown as number[])
  }
  return btoa(bin)
}
