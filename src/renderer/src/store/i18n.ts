// i18n.ts (store + module helpers)
//
// The i18n CORE for CanvasIO. A tiny zustand store holds the active language; a
// module-level `t()` does dictionary lookup + {placeholder} interpolation; and a
// `useT()` hook subscribes a component to the language so it re-renders on switch.
//
// PERSISTENCE CONTRACT — like the other USER PREFERENCES (awayAlerts / catchup):
//   * persists to its OWN localStorage key 'canvasio:lang' (loaded lazily at store
//     init, written back on setLang, all inside try/catch — quota / blocked /
//     malformed storage degrades silently to the 'en' default),
//   * NEVER added to canvasio:layout / App.tsx canvas serialization, NEVER over IPC,
//     and deliberately NOT part of the full-reset surface: New Canvas wipes the
//     board but the chosen language persists.
//
// REACT #185 SAFETY: every selector exposed here returns a PRIMITIVE (the `lang`
// string), never a fresh array/object, so `useI18n((s) => s.lang)` is referentially
// stable across renders and cannot trip React error #185.

import { create } from 'zustand'
import { es } from '../lib/i18n/es'
import { en } from '../lib/i18n/en'
import { pt } from '../lib/i18n/pt'
import { zh } from '../lib/i18n/zh'

export type Lang = 'es' | 'en' | 'pt' | 'zh'

/** The four bundled dictionaries, keyed by Lang. Spanish is the source of truth
 *  and the universal fallback. */
const DICTS: Record<Lang, Record<string, string>> = { es, en, pt, zh }

/** localStorage key for the persisted language preference. Its OWN key, untouched
 *  by canvasio:layout serialization. */
const STORAGE_KEY = 'canvasio:lang'

const DEFAULT_LANG: Lang = 'en'

/** The set of valid langs, for defensive coercion of stored / passed values. */
function isLang(v: unknown): v is Lang {
  return v === 'es' || v === 'en' || v === 'pt' || v === 'zh'
}

/** Load the persisted language. Defensive: any malformed/blocked storage → 'en'. */
function loadLang(): Lang {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_LANG
    const raw = localStorage.getItem(STORAGE_KEY)
    return isLang(raw) ? raw : DEFAULT_LANG
  } catch {
    return DEFAULT_LANG
  }
}

/** Persist synchronously. Defensive: quota/blocked storage is ignored. */
function saveLang(lang: Lang): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(STORAGE_KEY, lang)
  } catch {
    /* ignore quota/blocked storage — preferences must never throw into a caller */
  }
}

interface I18nState {
  lang: Lang
  setLang: (l: Lang) => void
}

export const useI18n = create<I18nState>((set) => ({
  lang: loadLang(),
  setLang: (l) => {
    if (!isLang(l)) return
    saveLang(l)
    set({ lang: l })
  }
}))

/** Replace every {token} in `s` with vars[token] (stringified). Tokens with no
 *  matching var are left untouched so a missing var is visible, not silently empty. */
function interpolate(s: string, vars?: Record<string, string | number>): string {
  if (!vars) return s
  return s.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole
  )
}

/**
 * Module-level translate. Looks up the key in the active language, falling back
 * to Spanish, then to the raw key itself, then interpolates {placeholder} tokens.
 * For use in NON-component modules (lib/*.ts). Components should use useT() so they
 * re-render on a language switch.
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const lang = useI18n.getState().lang
  const raw = DICTS[lang][key] ?? DICTS.es[key] ?? key
  return interpolate(raw, vars)
}

/**
 * Hook form of t(). SUBSCRIBES to the active language (selector returns the
 * primitive `lang` string — #185-safe) so the calling component re-renders when
 * the language changes, then returns a bound translate function.
 */
export function useT(): (key: string, vars?: Record<string, string | number>) => string {
  const lang = useI18n((s) => s.lang)
  return (key: string, vars?: Record<string, string | number>): string => {
    const raw = DICTS[lang][key] ?? DICTS.es[key] ?? key
    return interpolate(raw, vars)
  }
}
