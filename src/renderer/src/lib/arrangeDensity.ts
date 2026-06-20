// Arrange grid density — the persisted DEFAULT grid for arrange(). A plain module
// (not a store): arrange() reads it synchronously and the TopBar density popover
// writes it. Persisted to localStorage so it survives reload. Defensive try/catch
// (quota/blocked storage must never throw into a layout op), mirroring i18n.ts.
//
// A grid spec is either 'auto' (balanced cols x rows by node count + viewport
// aspect, with a capped cell height) or an explicit 'CxR' string (C columns x R
// rows) chosen from ARRANGE_GRID_CHOICES — so the user controls BOTH columns and
// rows of the default layout.
const STORAGE_KEY = 'canvasio:arrangeGrid'

/** Selectable grids in the TopBar popover: 'auto' + explicit cols x rows. */
export const ARRANGE_GRID_CHOICES = [
  'auto',
  '2x2',
  '3x2',
  '3x3',
  '4x3',
  '4x4',
  '5x5',
  '6x3'
] as const

export type ArrangeGrid = (typeof ARRANGE_GRID_CHOICES)[number] | string

const DEFAULT_GRID = 'auto'
const MIN = 1
const MAX = 12

/** Clamp to a sane integer in [1,12]. */
export function clampCols(n: number): number {
  if (!Number.isFinite(n)) return 4
  return Math.min(MAX, Math.max(MIN, Math.round(n)))
}

/** True for 'auto' or a well-formed 'CxR' spec. */
export function isArrangeGrid(s: unknown): s is string {
  return typeof s === 'string' && (s === 'auto' || /^\d{1,2}x\d{1,2}$/.test(s))
}

/** The persisted default grid (no arg to arrange() uses this). */
export function getArrangeGrid(): string {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_GRID
    const raw = localStorage.getItem(STORAGE_KEY)
    return isArrangeGrid(raw) ? (raw as string) : DEFAULT_GRID
  } catch {
    return DEFAULT_GRID
  }
}

/** Persist a new default grid. Quota/blocked storage is ignored. */
export function setArrangeGrid(s: string): void {
  try {
    if (typeof localStorage === 'undefined') return
    if (isArrangeGrid(s)) localStorage.setItem(STORAGE_KEY, s)
  } catch {
    /* ignore — preferences must never throw into a caller */
  }
}

/**
 * Resolve a spec to a concrete grid for `slots` nodes given the viewport aspect.
 *  - number          -> that many COLUMNS, rows auto (voice "arrange at N" compat).
 *  - 'CxR' string    -> EXACT C columns x R rows (explicit; user-chosen).
 *  - 'auto'/undefined-> BALANCED columns (by slots + aspect) + auto rows, capped.
 * `explicit` is true only for a 'CxR' spec, so arrange() can honour the chosen row
 * count exactly (vs the capped/balanced auto behaviour).
 */
export function resolveArrangeGrid(
  spec: string | number | undefined,
  slots: number,
  aspect: number
): { cols: number; rows: number; explicit: boolean } {
  const n = Math.max(1, slots)
  if (typeof spec === 'number' && Number.isFinite(spec)) {
    const cols = clampCols(spec)
    return { cols, rows: Math.max(1, Math.ceil(n / cols)), explicit: false }
  }
  const s = isArrangeGrid(spec) ? (spec as string) : getArrangeGrid()
  const m = /^(\d{1,2})x(\d{1,2})$/.exec(s)
  if (m) {
    return { cols: clampCols(Number(m[1])), rows: clampCols(Number(m[2])), explicit: true }
  }
  // 'auto' — balance columns so cells stay landscape-ish, then rows follow.
  if (n <= 1) return { cols: 1, rows: 1, explicit: false }
  const cols = Math.max(1, Math.min(6, Math.round(Math.sqrt(n * Math.max(0.5, aspect)))))
  return { cols, rows: Math.max(1, Math.ceil(n / cols)), explicit: false }
}
