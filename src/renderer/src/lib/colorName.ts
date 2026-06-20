/**
 * Spanish/English colour-NAME -> hex resolver for the voice-brain drawing actions
 * (draw_note / draw_shape). There is no prior colour-name precedent in the app, so
 * this establishes it. Accent/case-insensitive via the same NFD-strip the rest of
 * the AI pipeline uses (mirrors norm() in aiActions.ts / voiceCommands.ts).
 *
 * Returns a hex string for a known name, or null for an unknown one so the caller
 * can fall back to a default (note yellow / DEFAULT_STYLE stroke).
 */

const normColor = (s: string): string =>
  (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()

/** Note (post-it) background when the user asks for yellow / gives no colour. */
export const NOTE_YELLOW = '#ffe98a'

/** Canonical name -> hex. Synonyms are folded onto these via COLOR_ALIASES. */
const COLOR_HEX: Record<string, string> = {
  rojo: '#ef4444',
  azul: '#3b82f6',
  verde: '#22c55e',
  amarillo: '#eab308',
  naranja: '#f97316',
  morado: '#a855f7',
  rosa: '#ec4899',
  negro: '#111827',
  blanco: '#f8fafc',
  gris: '#9ca3af',
  cian: '#06b6d4'
}

/** English / synonym names folded onto a canonical key in COLOR_HEX. */
const COLOR_ALIASES: Record<string, string> = {
  red: 'rojo',
  blue: 'azul',
  green: 'verde',
  yellow: 'amarillo',
  orange: 'naranja',
  purple: 'morado',
  violeta: 'morado',
  violet: 'morado',
  pink: 'rosa',
  black: 'negro',
  white: 'blanco',
  gray: 'gris',
  grey: 'gris',
  cyan: 'cian'
}

/**
 * Resolve a raw colour name to a hex string, or null if unknown. Strips accents +
 * case so "Amarillo", "morado", "VIOLETA", "blue" all resolve.
 */
export function colorName(raw: unknown): string | null {
  const n = normColor(typeof raw === 'string' ? raw : '')
  if (!n) return null
  if (COLOR_HEX[n]) return COLOR_HEX[n]
  const alias = COLOR_ALIASES[n]
  if (alias && COLOR_HEX[alias]) return COLOR_HEX[alias]
  return null
}

/** Reverse map: canonical hex -> Spanish colour name (for context read-back). */
const HEX_TO_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(COLOR_HEX).map(([name, hex]) => [hex.toLowerCase(), name])
)

/**
 * Best-effort reverse lookup: a known hex -> its Spanish colour name, else the
 * original string unchanged (so the brain still sees *something* for the shape).
 * Used only to make the SHAPES context block human/brain-readable.
 */
export function hexToColorName(hex: unknown): string {
  const h = (typeof hex === 'string' ? hex : '').trim().toLowerCase()
  if (!h) return ''
  return HEX_TO_NAME[h] ?? h
}

/**
 * Decide whether a hex colour is "light" (needs dark text on top). Simple
 * luminance test on the #rrggbb channels; tolerates short/invalid hex (-> false).
 */
export function isLightColor(hex: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim())
  if (!m) return false
  const v = parseInt(m[1], 16)
  const r = (v >> 16) & 0xff
  const g = (v >> 8) & 0xff
  const b = v & 0xff
  // Rec. 601 luma; >0.6 of 255 ~= visibly light.
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luma > 0.6
}
