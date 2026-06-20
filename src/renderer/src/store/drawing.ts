import { create } from 'zustand'
import { nanoid } from 'nanoid'

export type DrawTool =
  | 'select'
  | 'hand'
  | 'rect'
  | 'diamond'
  | 'ellipse'
  | 'arrow'
  | 'line'
  | 'pen'
  | 'text'
  | 'eraser'

export type StrokeStyle = 'solid' | 'dashed' | 'dotted'
export type StrokeWidth = 1 | 2 | 4
export type ShapeType = 'rect' | 'diamond' | 'ellipse' | 'arrow' | 'line' | 'pen' | 'text'

/**
 * One contiguous span of text with its own bold/italic/underline. The shape's
 * plain `text` is always the concatenation of every run's text (see
 * syncTextWithRuns), so back-compat consumers (textBox, search, old renderers)
 * keep working unchanged. Newlines live INSIDE run.text as '\n'.
 */
export interface TextRun {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  /** optional per-run text color (CSS color string), independent of the shape */
  color?: string
  /** optional per-run font size in world px (overrides the shape's fontSize) */
  fontSize?: number
}

export interface Shape {
  id: string
  type: ShapeType
  /** box bounds. for line/arrow x,y = start and w,h = dx,dy (endpoint = x+w,y+h). for pen, x/y/w/h = bbox of points */
  x: number
  y: number
  w: number
  h: number
  /** flat [x,y,...] world coords, for pen */
  points?: number[]
  text?: string
  stroke: string
  fill: string // 'transparent' | color
  strokeWidth: StrokeWidth
  strokeStyle: StrokeStyle
  opacity: number // 0..1
  fontSize?: number
  /** optional text color, independent of stroke (e.g. rect post-it text vs border) */
  textColor?: string
  /** optional CSS font-family for the shape's text (post-it label / text shape) */
  fontFamily?: string
  /** text style toggles (post-it label / text shape); booleans round-trip cleanly */
  bold?: boolean
  italic?: boolean
  underline?: boolean
  /** horizontal text alignment for the shape's text (post-it label / text shape) */
  align?: 'left' | 'center' | 'right' | 'justify'
  /**
   * Optional per-run rich text. When present (and non-empty) it is the SOURCE OF
   * TRUTH for how the text is styled: each run carries its own bold/italic/
   * underline and the shape-level bold/italic/underline are IGNORED for rendering.
   * `text` is always kept in sync (= runs.map(r => r.text).join('')) so layout
   * (textBox), search and any plain-text consumer keep working. Shapes WITHOUT
   * runs render exactly as before (shape-level toggles apply to the whole text).
   */
  runs?: TextRun[]
  /** shapes sharing the same groupId are selected/moved/styled/deleted as one unit */
  groupId?: string
}

export interface DrawStyle {
  stroke: string
  fill: string
  strokeWidth: StrokeWidth
  strokeStyle: StrokeStyle
  opacity: number
  fontSize: number
  fontFamily: string
  bold: boolean
  italic: boolean
  underline: boolean
  align: 'left' | 'center' | 'right' | 'justify'
}

/** Default CSS font-family for text (matches the sans default DrawingLayer used). */
export const DEFAULT_FONT_FAMILY = 'ui-sans-serif, system-ui, sans-serif'

interface DrawingState {
  activeTool: DrawTool
  shapes: Shape[]
  selectedShapeIds: string[]
  style: DrawStyle
  // actions
  setTool: (t: DrawTool) => void
  addShape: (partial: Partial<Shape> & { type: ShapeType }) => string
  updateShape: (id: string, patch: Partial<Shape>) => void
  removeShape: (id: string) => void
  /** single select (group-expanded). null clears. Back-compat thin wrapper. */
  selectShape: (id: string | null) => void
  /** replace the selection with these ids (group-expanded). For marquee. */
  setSelection: (ids: string[]) => void
  /** shift-click: add/remove a shape's whole group from the selection */
  toggleInSelection: (id: string) => void
  /** remove every selected shape */
  removeSelected: () => void
  setStyle: (patch: Partial<DrawStyle>) => void
  bringToFront: (id: string) => void
  sendToBack: (id: string) => void
  duplicateShape: (id: string) => void
  clearSelection: () => void
  /** assign one new groupId to all selected shapes */
  group: () => void
  /** clear groupId on all selected shapes */
  ungroup: () => void
  /**
   * Replace ALL shapes (used when SWITCHING to another canvas — the drawing layer
   * is a per-canvas snapshot). Incoming shapes run through the SAME normalization
   * loadShapes() uses (id-dedupe + geometry/style/fontSize sanitize) so a doc with
   * garbage/duplicate ids can never poison the live store. Clears the selection
   * and mirrors into canvasio:shapes (legacy mirror) for coherence.
   */
  setShapes: (shapes: Shape[]) => void
  /**
   * Wipe ALL shapes + selection (new-canvas / before loading another canvas).
   * FIXES the stuck post-it bug: clear()/bootRecipe() in canvas.ts never touched
   * this store, so a "new canvas" kept the previous canvas's drawing layer.
   */
  clearShapes: () => void
}

const STORAGE_KEY = 'canvasio:shapes'

/** Sane default text size in WORLD px (readable, not gigantic). */
export const DEFAULT_FONT_SIZE = 22
/** Bounds for text size so legacy/garbage values never render gigantic. */
const MIN_FONT_SIZE = 8
const MAX_FONT_SIZE = 200

/**
 * Shared text-box metrics. The SVG <text>, the selection outline + handles and
 * the editing <textarea> overlay MUST all derive their box from these constants
 * so there is exactly ONE bounding box for a text shape (no double box).
 */
export const TEXT_LINE_HEIGHT = 1.2
export const TEXT_CHAR_WIDTH = 0.6

/**
 * Content-derived box (world coords) of a text shape: top-left at (x,y), size
 * computed from font size + text content. Single source of truth for layout.
 */
export function textBox(sh: Shape): { x: number; y: number; w: number; h: number } {
  const fs = sh.fontSize ?? DEFAULT_FONT_SIZE
  const lines = (sh.text ?? '').split('\n')
  const cols = lines.reduce((m, ln) => Math.max(m, ln.length), 0)
  const rows = Math.max(1, lines.length)
  const w = Math.max(fs * TEXT_CHAR_WIDTH * cols, fs)
  const h = rows * fs * TEXT_LINE_HEIGHT
  return { x: sh.x, y: sh.y, w, h }
}

/**
 * Box bounds for a text shape's background/stroke rect, with optional padding.
 * Used to render the fill/stroke border BEHIND the rich foreignObject or the
 * plain SVG <text> of a text shape (the content box itself stays flush at x,y).
 */
export function textBoxWithPadding(
  sh: Shape,
  paddingX: number = 4,
  paddingY: number = 2
): { x: number; y: number; w: number; h: number } {
  const tb = textBox(sh)
  return {
    x: tb.x - paddingX,
    y: tb.y - paddingY,
    w: tb.w + paddingX * 2,
    h: tb.h + paddingY * 2
  }
}

/**
 * Strict CSS-color allowlist. Accepts hex (#rgb..#rrggbbaa), rgb/rgba/hsl/hsla
 * functional notation, and plain color keywords — and NOTHING containing quotes,
 * angle brackets, semicolons or other characters that could break out of a
 * style="" attribute. Used to sanitize untrusted per-run colors before they reach
 * the innerHTML-built editor (DOM-XSS guard).
 */
function isSafeCssColor(c: string): boolean {
  if (c.length > 32) return false
  return (
    /^#[0-9a-fA-F]{3,8}$/.test(c) ||
    /^(?:rgb|rgba|hsl|hsla)\(\s*[0-9.,%\s/]+\)$/i.test(c) ||
    /^[a-zA-Z]{1,30}$/.test(c)
  )
}

/**
 * Coerce an untrusted `runs` value into a clean TextRun[] (or undefined). Drops
 * malformed entries, forces booleans, and collapses an all-empty/absent result
 * to undefined so a shape with no real rich text falls back to the plain path.
 */
export function sanitizeRuns(v: unknown): TextRun[] | undefined {
  if (!Array.isArray(v)) return undefined
  const runs: TextRun[] = []
  for (const r of v) {
    if (r == null || typeof r !== 'object') continue
    const text = typeof (r as TextRun).text === 'string' ? (r as TextRun).text : ''
    // Per-run color must be a non-empty string; per-run fontSize must be a finite
    // number (clamped via the same bounds as the shape-level size). Both are
    // optional and omitted (undefined) when absent so old runs round-trip cleanly.
    const rawColor = (r as TextRun).color
    // SECURITY: a run's color is interpolated into a style="" attribute that is
    // assigned via innerHTML in the in-place editor (buildEditorHTML). Shapes are
    // deserialized from persisted/imported (untrusted) JSON, so a color string
    // must be validated against a strict CSS-color allowlist — anything else
    // (quotes, angle brackets, ';', etc.) is dropped, closing a DOM-XSS vector.
    const color = typeof rawColor === 'string' && isSafeCssColor(rawColor) ? rawColor : undefined
    const rawFontSize = (r as TextRun).fontSize
    const fontSize =
      typeof rawFontSize === 'number' && Number.isFinite(rawFontSize)
        ? sanitizeFontSize(rawFontSize)
        : undefined
    runs.push({
      text,
      bold: (r as TextRun).bold === true,
      italic: (r as TextRun).italic === true,
      underline: (r as TextRun).underline === true,
      color,
      fontSize
    })
  }
  if (runs.length === 0) return undefined
  // If the only content is empty strings there is no rich text to preserve.
  if (runs.every((r) => r.text.length === 0)) return undefined
  return runs
}

/**
 * Keep `shape.text` equal to the concatenation of its runs. No-op when there are
 * no runs (plain-text shape). Returns the same object reference when nothing
 * changed so callers don't trigger needless re-renders / React #185 churn.
 */
export function syncTextWithRuns(sh: Shape): Shape {
  if (!sh.runs || sh.runs.length === 0) return sh
  const combined = sh.runs.map((r) => r.text).join('')
  if (sh.text === combined) return sh
  return { ...sh, text: combined }
}

function sanitizeFontSize(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : DEFAULT_FONT_SIZE
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, n))
}

/**
 * Normalize an UNTRUSTED parsed shape array into clean Shape[]. Shared by
 * loadShapes() (localStorage rehydrate) AND setShapes() (canvas-switch load), so
 * a shape array arriving from EITHER path gets the identical sanitization:
 *   - clamp absurd persisted fontSize (the old default rendered text gigantic),
 *   - re-id duplicate/falsy ids with a fresh nanoid (canvasio:shapes + canvas docs are
 *     hand-editable / round-trip through export-import; colliding ids would make
 *     updateShape/removeShape/bringToFront/sendToBack/setStyle move/restyle/delete
 *     /reorder several shapes together),
 *   - sanitize geometry + opacity/stroke/fill so a missing opacity can't render a
 *     shape permanently invisible and stroke/fill are always non-empty strings.
 * Mirrors canvas.ts loadLayout's re-id discipline; distinct valid ids are kept.
 */
export function sanitizeShapes(parsed: unknown): Shape[] {
  if (!Array.isArray(parsed)) return []
  const seen = new Set<string>()
  return (parsed as Shape[])
    .filter((sh): sh is Shape => sh != null && typeof sh === 'object')
    .map((sh) => {
      const id = sh.id && !seen.has(sh.id) ? sh.id : nanoid(8)
      seen.add(id)
      const geom = {
        x: Number.isFinite(sh.x) ? sh.x : 0,
        y: Number.isFinite(sh.y) ? sh.y : 0,
        w: Number.isFinite(sh.w) ? sh.w : 0,
        h: Number.isFinite(sh.h) ? sh.h : 0,
        points: Array.isArray(sh.points)
          ? sh.points.map((p) => (Number.isFinite(p) ? p : 0))
          : sh.points
      }
      const style = {
        opacity: Number.isFinite(sh.opacity)
          ? Math.min(1, Math.max(0, sh.opacity))
          : DEFAULT_STYLE.opacity,
        stroke: typeof sh.stroke === 'string' && sh.stroke ? sh.stroke : DEFAULT_STYLE.stroke,
        fill: typeof sh.fill === 'string' && sh.fill ? sh.fill : DEFAULT_STYLE.fill
      }
      // Normalize optional rich-text runs (drops garbage; undefined => plain
      // path) and keep `text` synced with the surviving runs so every text
      // consumer (textBox/search/legacy render) stays correct.
      const runs = sanitizeRuns((sh as Shape).runs)
      const withRuns = runs ? { runs } : { runs: undefined }
      const base =
        sh.type === 'text' || sh.fontSize != null
          ? { ...sh, ...geom, ...style, ...withRuns, id, fontSize: sanitizeFontSize(sh.fontSize) }
          : { ...sh, ...geom, ...style, ...withRuns, id }
      return syncTextWithRuns(base)
    })
}

function loadShapes(): Shape[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    return sanitizeShapes(JSON.parse(raw))
  } catch {
    return []
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
/**
 * Debounce delay for persisting shapes to localStorage. A real delay (not 0) is
 * essential: during a freehand pen stroke / resize / move drag, updateShape runs
 * on every pointermove with an ever-growing points array, and each event is a
 * separate macrotask, so a 0ms timer fires before the next frame — causing a full
 * JSON.stringify of ALL shapes on essentially every frame. A 300ms delay coalesces
 * those mid-drag updates into a single write after the gesture settles, while still
 * persisting promptly after edits (mirrors the 600ms layout-save debounce).
 */
const SAVE_DEBOUNCE_MS = 300
function persist(shapes: Shape[]): void {
  if (typeof localStorage === 'undefined') return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(shapes))
    } catch {
      /* ignore */
    }
  }, SAVE_DEBOUNCE_MS)
}

/**
 * Synchronously force any pending shape write to complete. persist() debounces
 * by SAVE_DEBOUNCE_MS, so a draw/move/edit made within that window is still only
 * queued (not written) when the app quits, reloads, or the Doctor triggers a
 * rebuild+relaunch — losing the most recent change on next cold start. The canvas
 * layout path has a beforeunload flush for exactly this reason (App.tsx); this
 * gives the shapes path the same safety. Behavior-preserving: it does not change
 * WHAT is written, only forces the already-pending write to land before teardown.
 *
 * Exported so App.tsx's onBeforeUnload can call it alongside the layout flush; it
 * is also self-registered on beforeunload below so the guarantee holds even if a
 * caller forgets. Calling it when no write is pending is a cheap no-op write.
 */
export function flushShapes(): void {
  if (typeof localStorage === 'undefined') return
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(useDrawing.getState().shapes))
  } catch {
    /* ignore */
  }
}

// Self-register a synchronous flush on app teardown so a shape change made inside
// the debounce window is never lost on quit/reload/Doctor-relaunch, independent of
// whether App.tsx wires flushShapes() in. beforeunload runs synchronously, so the
// localStorage write completes before the page is torn down.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', flushShapes)
}

/**
 * Expand a set of shape ids so that selecting any shape in a group selects the
 * WHOLE group (all shapes sharing its groupId). Dedupes, preserves no order.
 */
export function expandToGroups(ids: string[], shapes: Shape[]): string[] {
  const idSet = new Set(ids)
  const groupIds = new Set<string>()
  for (const sh of shapes) {
    if (idSet.has(sh.id) && sh.groupId) groupIds.add(sh.groupId)
  }
  if (groupIds.size === 0) return [...idSet]
  for (const sh of shapes) {
    if (sh.groupId && groupIds.has(sh.groupId)) idSet.add(sh.id)
  }
  return [...idSet]
}

const DEFAULT_STYLE: DrawStyle = {
  stroke: '#e6e6e6',
  fill: 'transparent',
  strokeWidth: 2,
  strokeStyle: 'solid',
  opacity: 1,
  fontSize: DEFAULT_FONT_SIZE,
  fontFamily: DEFAULT_FONT_FAMILY,
  bold: false,
  italic: false,
  underline: false,
  align: 'left'
}

/**
 * When EXACTLY one shape is selected, mirror its style into the shared style so
 * DrawProperties reflects the clicked shape. For multi-selection we leave the
 * shared style untouched (otherwise the last-added shape would hijack the panel).
 */
function styleForSelection(ids: string[], shapes: Shape[], current: DrawStyle): DrawStyle {
  if (ids.length !== 1) return current
  const shape = shapes.find((sh) => sh.id === ids[0])
  if (!shape) return current
  return {
    stroke: shape.stroke,
    fill: shape.fill,
    strokeWidth: shape.strokeWidth,
    strokeStyle: shape.strokeStyle,
    opacity: shape.opacity,
    fontSize: shape.fontSize ?? current.fontSize,
    fontFamily: shape.fontFamily ?? current.fontFamily,
    bold: shape.bold ?? current.bold,
    italic: shape.italic ?? current.italic,
    underline: shape.underline ?? current.underline,
    align: shape.align ?? current.align
  }
}

export const useDrawing = create<DrawingState>((set, get) => ({
  activeTool: 'select',
  shapes: loadShapes(),
  selectedShapeIds: [],
  style: { ...DEFAULT_STYLE },

  setTool: (t) =>
    set((s) => ({
      activeTool: t,
      selectedShapeIds: t === 'select' ? s.selectedShapeIds : []
    })),

  addShape: (partial) => {
    const id = partial.id ?? nanoid(8)
    const style = get().style
    const shape: Shape = {
      id,
      type: partial.type,
      x: partial.x ?? 0,
      y: partial.y ?? 0,
      w: partial.w ?? 0,
      h: partial.h ?? 0,
      points: partial.points,
      text: partial.text,
      stroke: partial.stroke ?? style.stroke,
      fill: partial.fill ?? style.fill,
      strokeWidth: partial.strokeWidth ?? style.strokeWidth,
      strokeStyle: partial.strokeStyle ?? style.strokeStyle,
      opacity: partial.opacity ?? style.opacity,
      fontSize: partial.fontSize ?? style.fontSize,
      fontFamily: partial.fontFamily ?? style.fontFamily,
      bold: partial.bold ?? style.bold,
      italic: partial.italic ?? style.italic,
      underline: partial.underline ?? style.underline,
      align: partial.align ?? style.align,
      // Optional grouping: lets a single multi-shape command (e.g. draw_diagram's
      // boxes + arrows) be created already grouped so the user can move/delete the
      // whole figure as one unit. Omitted (undefined) for normal single shapes.
      groupId: partial.groupId
    }
    // Initialize text box to its content-derived size right away.
    if (shape.type === 'text') {
      const tb = textBox(shape)
      shape.w = tb.w
      shape.h = tb.h
    }
    set((s) => {
      const shapes = [...s.shapes, shape]
      persist(shapes)
      return { shapes }
    })
    return id
  },

  updateShape: (id, patch) =>
    set((s) => {
      const shapes = s.shapes.map((sh) => {
        if (sh.id !== id) return sh
        let next = { ...sh, ...patch }
        // When runs are patched, the plain `text` must mirror them so textBox /
        // the selection box / search stay correct. (A patch carrying `text`
        // without `runs` is the plain path and is left as-is.)
        if (patch.runs !== undefined) next = syncTextWithRuns(next)
        // Keep stored w/h of text shapes in sync with content so the persisted
        // box always matches the rendered/selection box (no stale double box).
        if (next.type === 'text') {
          const tb = textBox(next)
          next.w = tb.w
          next.h = tb.h
        }
        return next
      })
      persist(shapes)
      return { shapes }
    }),

  removeShape: (id) =>
    set((s) => {
      const shapes = s.shapes.filter((sh) => sh.id !== id)
      persist(shapes)
      return {
        shapes,
        selectedShapeIds: s.selectedShapeIds.filter((x) => x !== id)
      }
    }),

  removeSelected: () =>
    set((s) => {
      if (s.selectedShapeIds.length === 0) return {}
      const sel = new Set(s.selectedShapeIds)
      const shapes = s.shapes.filter((sh) => !sel.has(sh.id))
      persist(shapes)
      return { shapes, selectedShapeIds: [] }
    }),

  selectShape: (id) => get().setSelection(id == null ? [] : [id]),

  setSelection: (ids) =>
    set((s) => {
      const next = expandToGroups(ids, s.shapes)
      return {
        selectedShapeIds: next,
        style: styleForSelection(next, s.shapes, s.style)
      }
    }),

  toggleInSelection: (id) =>
    set((s) => {
      const group = expandToGroups([id], s.shapes)
      const current = new Set(s.selectedShapeIds)
      const fullyIn = group.every((g) => current.has(g))
      if (fullyIn) {
        for (const g of group) current.delete(g)
      } else {
        for (const g of group) current.add(g)
      }
      const next = [...current]
      return {
        selectedShapeIds: next,
        style: styleForSelection(next, s.shapes, s.style)
      }
    }),

  setStyle: (patch) =>
    set((s) => {
      // Sanitize fontSize ONCE so both the shared style AND the patch applied to
      // selected shapes use the same clamped value. Previously only `style` was
      // sanitized while shapes received the raw `patch.fontSize`, so an
      // out-of-range value could be written to (and persisted on) the shapes —
      // the exact gigantic-text problem sanitizeFontSize exists to prevent.
      const safePatch =
        patch.fontSize != null ? { ...patch, fontSize: sanitizeFontSize(patch.fontSize) } : patch
      const style = { ...s.style, ...safePatch }
      let shapes = s.shapes
      if (s.selectedShapeIds.length > 0) {
        const sel = new Set(s.selectedShapeIds)
        shapes = s.shapes.map((sh) => {
          if (!sel.has(sh.id)) return sh
          const next = { ...sh, ...safePatch }
          if (next.type === 'text') {
            const tb = textBox(next)
            next.w = tb.w
            next.h = tb.h
          }
          return next
        })
        persist(shapes)
      }
      return { style, shapes }
    }),

  bringToFront: (id) =>
    set((s) => {
      const shape = s.shapes.find((sh) => sh.id === id)
      if (!shape) return {}
      // If the shape belongs to a group, raise the WHOLE group together (matches
      // expandToGroups selection semantics) so a grouped text box never gets left
      // interleaved behind its own group members. Ungrouped shapes move singly.
      const idsToMove = shape.groupId
        ? s.shapes.filter((sh) => sh.groupId === shape.groupId).map((sh) => sh.id)
        : [id]
      const idSet = new Set(idsToMove)
      const shapes = [
        ...s.shapes.filter((sh) => !idSet.has(sh.id)),
        ...s.shapes.filter((sh) => idSet.has(sh.id))
      ]
      persist(shapes)
      return { shapes }
    }),

  sendToBack: (id) =>
    set((s) => {
      const shape = s.shapes.find((sh) => sh.id === id)
      if (!shape) return {}
      // Mirror bringToFront: lower the whole group together when grouped.
      const idsToMove = shape.groupId
        ? s.shapes.filter((sh) => sh.groupId === shape.groupId).map((sh) => sh.id)
        : [id]
      const idSet = new Set(idsToMove)
      const shapes = [
        ...s.shapes.filter((sh) => idSet.has(sh.id)),
        ...s.shapes.filter((sh) => !idSet.has(sh.id))
      ]
      persist(shapes)
      return { shapes }
    }),

  duplicateShape: (id) =>
    set((s) => {
      const shape = s.shapes.find((sh) => sh.id === id)
      if (!shape) return {}
      const newId = nanoid(8)
      const { groupId: _g, ...base } = shape
      const clone: Shape = {
        ...base,
        id: newId,
        x: shape.x + 12,
        y: shape.y + 12,
        points: shape.points ? shape.points.map((v) => v + 12) : undefined
      }
      const shapes = [...s.shapes, clone]
      persist(shapes)
      return { shapes, selectedShapeIds: [newId] }
    }),

  clearSelection: () => set({ selectedShapeIds: [] }),

  group: () =>
    set((s) => {
      if (s.selectedShapeIds.length < 2) return {}
      const sel = new Set(s.selectedShapeIds)
      const gid = nanoid(8)
      const shapes = s.shapes.map((sh) => (sel.has(sh.id) ? { ...sh, groupId: gid } : sh))
      persist(shapes)
      return { shapes }
    }),

  ungroup: () =>
    set((s) => {
      if (s.selectedShapeIds.length === 0) return {}
      const sel = new Set(s.selectedShapeIds)
      let changed = false
      const shapes = s.shapes.map((sh) => {
        if (sel.has(sh.id) && sh.groupId != null) {
          changed = true
          const { groupId: _drop, ...rest } = sh
          return rest as Shape
        }
        return sh
      })
      if (!changed) return {}
      persist(shapes)
      return { shapes }
    }),

  setShapes: (shapes) =>
    set(() => {
      const next = sanitizeShapes(shapes)
      // Keep the legacy canvasio:shapes mirror coherent with the freshly-loaded
      // canvas (harmless now that the active canvas file is authoritative).
      persist(next)
      return { shapes: next, selectedShapeIds: [] }
    }),

  clearShapes: () =>
    set(() => {
      persist([])
      return { shapes: [], selectedShapeIds: [] }
    })
}))

/* ---------- geometry helpers (shared with Canvas pointer pipeline) ---------- */

export function shapeBBox(sh: Shape): { x: number; y: number; w: number; h: number } {
  if (sh.type === 'line' || sh.type === 'arrow') {
    const x1 = sh.x
    const y1 = sh.y
    const x2 = sh.x + sh.w
    const y2 = sh.y + sh.h
    return {
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      w: Math.abs(sh.w),
      h: Math.abs(sh.h)
    }
  }

  // Text shapes always derive their box from font size + content (see textBox),
  // so the rendered text, selection outline, handles and the edit <textarea>
  // overlay share ONE consistent bounding box. The stored w/h are kept in sync
  // with this (Canvas keeps them updated) but content remains the source of truth.
  if (sh.type === 'text') {
    return textBox(sh)
  }

  // All other box shapes: normalize negative drags (shift origin) and never
  // return a zero/negative size so handles always spread to real corners.
  const x = sh.w < 0 ? sh.x + sh.w : sh.x
  const y = sh.h < 0 ? sh.y + sh.h : sh.y
  const w = Math.max(Math.abs(sh.w), 1)
  const h = Math.max(Math.abs(sh.h), 1)
  return { x, y, w, h }
}

/** Union of the bounding boxes of the given shapes (world coords). */
export function unionBBox(
  shapes: Shape[]
): { x: number; y: number; w: number; h: number } | null {
  if (shapes.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const sh of shapes) {
    const bb = shapeBBox(sh)
    minX = Math.min(minX, bb.x)
    minY = Math.min(minY, bb.y)
    maxX = Math.max(maxX, bb.x + bb.w)
    maxY = Math.max(maxY, bb.y + bb.h)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

function distToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): number {
  const dx = x2 - x1
  const dy = y2 - y1
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(px - x1, py - y1)
  let t = ((px - x1) * dx + (py - y1) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  const cx = x1 + t * dx
  const cy = y1 + t * dy
  return Math.hypot(px - cx, py - cy)
}

/** topmost shape id whose geometry is within tolerance of the point */
export function hitTest(
  wx: number,
  wy: number,
  shapes: Shape[],
  zoom: number
): string | null {
  const tol = 8 / zoom
  for (let i = shapes.length - 1; i >= 0; i--) {
    const sh = shapes[i]
    if (sh.type === 'line' || sh.type === 'arrow') {
      const d = distToSegment(wx, wy, sh.x, sh.y, sh.x + sh.w, sh.y + sh.h)
      if (d <= tol) return sh.id
      continue
    }
    if (sh.type === 'pen' && sh.points && sh.points.length >= 4) {
      const p = sh.points
      let min = Infinity
      for (let j = 0; j < p.length - 2; j += 2) {
        const d = distToSegment(wx, wy, p[j], p[j + 1], p[j + 2], p[j + 3])
        if (d < min) min = d
      }
      if (min <= tol) return sh.id
      continue
    }
    const bb = shapeBBox(sh)
    const inside =
      wx >= bb.x - tol &&
      wx <= bb.x + bb.w + tol &&
      wy >= bb.y - tol &&
      wy <= bb.y + bb.h + tol
    if (!inside) continue
    if (sh.type === 'text') return sh.id
    // filled shapes: whole bbox is hittable
    if (sh.fill && sh.fill !== 'transparent') return sh.id
    // transparent fill: only near the edge
    const nearLeft = Math.abs(wx - bb.x) <= tol
    const nearRight = Math.abs(wx - (bb.x + bb.w)) <= tol
    const nearTop = Math.abs(wy - bb.y) <= tol
    const nearBottom = Math.abs(wy - (bb.y + bb.h)) <= tol
    const withinX = wx >= bb.x - tol && wx <= bb.x + bb.w + tol
    const withinY = wy >= bb.y - tol && wy <= bb.y + bb.h + tol
    if (sh.type === 'ellipse') {
      // distance to ellipse edge
      const cx = bb.x + bb.w / 2
      const cy = bb.y + bb.h / 2
      const rx = bb.w / 2 || 1
      const ry = bb.h / 2 || 1
      const norm = ((wx - cx) / rx) ** 2 + ((wy - cy) / ry) ** 2
      const tolN = (tol / Math.min(rx, ry)) * 2
      if (Math.abs(norm - 1) <= tolN + 0.15) return sh.id
      continue
    }
    if (((nearLeft || nearRight) && withinY) || ((nearTop || nearBottom) && withinX)) {
      return sh.id
    }
  }
  return null
}
