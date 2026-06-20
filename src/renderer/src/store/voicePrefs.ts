import { create } from 'zustand'
import type { Lang } from './i18n'

/* ================================================================== *
 *  Per-language Kokoro voice preference
 * ------------------------------------------------------------------
 *  The user picks which Kokoro neural voice speaks each language (the
 *  Settings selector). The choice persists to its OWN localStorage key
 *  'canvasio:voicePrefs' (independent of the language store) and is read as
 *  a primitive at TTS call time — useVoiceCapture.speak() and the
 *  Settings "test voice" button pass it to window.canvasio.voice.tts(),
 *  where the main process maps the rest (espeak phonemizer lang still
 *  derives from the LANGUAGE, so a pick only changes the speaker).
 * ================================================================== */

export interface VoiceOption {
  id: string
  label: string
  gender: 'M' | 'F'
  // Which engine synthesizes this voice. Kokoro = neural multilingual (Latin-am
  // Spanish); Piper = the es_ES (SPAIN/Castilian) neural voices. The main process
  // routes by voice id; this is for display + grouping. Defaults to 'kokoro'.
  engine?: 'kokoro' | 'piper'
}

// Curated voices per app language. Spanish includes the Piper es_ES (SPAIN)
// voices — Kokoro's Spanish is Latin-American only (hexgrad/kokoro#246), so the
// Castilian "davefx" lives on Piper. Men first (the original ask).
export const VOICE_CATALOG: Record<Lang, VoiceOption[]> = {
  es: [
    { id: 'davefx', label: 'David · España (hombre)', gender: 'M', engine: 'piper' },
    { id: 'em_alex', label: 'Álex · latino (hombre)', gender: 'M', engine: 'kokoro' },
    { id: 'em_santa', label: 'Santa · latino (hombre)', gender: 'M', engine: 'kokoro' },
    { id: 'ef_dora', label: 'Dora · latina (mujer)', gender: 'F', engine: 'kokoro' }
  ],
  en: [
    { id: 'am_michael', label: 'Michael (man)', gender: 'M' },
    { id: 'am_onyx', label: 'Onyx (man)', gender: 'M' },
    { id: 'am_adam', label: 'Adam (man)', gender: 'M' },
    { id: 'bm_george', label: 'George (man, UK)', gender: 'M' },
    { id: 'af_heart', label: 'Heart (woman)', gender: 'F' },
    { id: 'af_bella', label: 'Bella (woman)', gender: 'F' },
    { id: 'af_nicole', label: 'Nicole (woman)', gender: 'F' },
    { id: 'bf_emma', label: 'Emma (woman, UK)', gender: 'F' }
  ],
  pt: [
    { id: 'pm_alex', label: 'Alex (homem)', gender: 'M' },
    { id: 'pm_santa', label: 'Santa (homem)', gender: 'M' },
    { id: 'pf_dora', label: 'Dora (mulher)', gender: 'F' }
  ],
  zh: [
    { id: 'zm_yunxi', label: 'Yunxi (男)', gender: 'M' },
    { id: 'zm_yunjian', label: 'Yunjian (男)', gender: 'M' },
    { id: 'zf_xiaoxiao', label: 'Xiaoxiao (女)', gender: 'F' },
    { id: 'zf_xiaobei', label: 'Xiaobei (女)', gender: 'F' }
  ]
}

// Defaults. Spanish defaults to the Castilian (Spain) Piper voice 'davefx' — the
// one the user actually wants; other languages mirror src/main/kokoroVoices.ts.
const DEFAULT_VOICES: Record<Lang, string> = {
  es: 'davefx',
  en: 'af_heart',
  pt: 'pf_dora',
  zh: 'zf_xiaoxiao'
}

/** The engine that synthesizes a given voice id (for engine-aware display). */
export function voiceEngine(lang: Lang, id: string): 'kokoro' | 'piper' {
  return VOICE_CATALOG[lang]?.find((o) => o.id === id)?.engine ?? 'kokoro'
}

const STORAGE_KEY = 'canvasio:voicePrefs'

/** Load persisted prefs, defensively merged over defaults (malformed → defaults). */
function loadVoices(): Record<Lang, string> {
  try {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_VOICES }
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_VOICES }
    const parsed = JSON.parse(raw) as Partial<Record<Lang, string>>
    const merged = { ...DEFAULT_VOICES }
    for (const l of Object.keys(DEFAULT_VOICES) as Lang[]) {
      const v = parsed[l]
      // Only accept a value that is a real option for that language.
      if (typeof v === 'string' && VOICE_CATALOG[l].some((o) => o.id === v)) merged[l] = v
    }
    return merged
  } catch {
    return { ...DEFAULT_VOICES }
  }
}

function saveVoices(voices: Record<Lang, string>): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(STORAGE_KEY, JSON.stringify(voices))
  } catch {
    /* quota / blocked — the in-memory choice still applies this session */
  }
}

interface VoicePrefsState {
  voices: Record<Lang, string>
  setVoice: (lang: Lang, id: string) => void
}

export const useVoicePrefs = create<VoicePrefsState>((set, get) => ({
  voices: loadVoices(),
  setVoice: (lang, id) => {
    if (!VOICE_CATALOG[lang]?.some((o) => o.id === id)) return
    const voices = { ...get().voices, [lang]: id }
    saveVoices(voices)
    set({ voices })
  }
}))

/** Non-reactive read of the chosen voice for a language (TTS call sites). */
export function voiceForLang(lang: Lang): string {
  return useVoicePrefs.getState().voices[lang] || DEFAULT_VOICES[lang]
}
