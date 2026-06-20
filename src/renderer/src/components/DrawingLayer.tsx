import { memo, useEffect, useRef } from 'react'
import { useCanvas } from '../store/canvas'
import {
  useDrawing,
  Shape,
  TextRun,
  shapeBBox,
  unionBBox,
  textBox,
  textBoxWithPadding,
  sanitizeRuns,
  DEFAULT_FONT_SIZE,
  DEFAULT_FONT_FAMILY,
  TEXT_LINE_HEIGHT
} from '../store/drawing'
import { DrawProperties } from './DrawProperties'
import { saveEditorSelection, restoreEditorSelection } from '../lib/textEditing'

/**
 * Render a shape's text content for an HTML container (foreignObject / the
 * contentEditable). When the shape has rich `runs` each run becomes a styled
 * <span>; otherwise the plain `text` is returned unchanged (exact back-compat).
 * Newlines render natively because the container uses white-space: pre-wrap.
 */
function renderRichHTML(sh: Shape): React.ReactNode {
  if (!sh.runs || sh.runs.length === 0) return sh.text
  return sh.runs.map((run, i) => (
    <span
      key={i}
      style={{
        fontWeight: run.bold ? 700 : 400,
        fontStyle: run.italic ? 'italic' : 'normal',
        textDecoration: run.underline ? 'underline' : 'none',
        // Per-run color/size override the shape defaults when present; omitted
        // (undefined) otherwise so the run inherits the container's color/size.
        ...(run.color ? { color: run.color } : null),
        ...(run.fontSize ? { fontSize: `${run.fontSize}px` } : null)
      }}
    >
      {run.text}
    </span>
  ))
}

/**
 * Walk the contentEditable DOM and rebuild TextRun[]. Adjacent runs that share
 * the same style are merged so we don't accumulate fragmented spans across
 * edits. <br> and block boundaries become '\n'. Returns the plain text too.
 */
function extractRunsFromDOM(root: HTMLElement): { text: string; runs: TextRun[] } {
  const runs: TextRun[] = []
  const push = (
    text: string,
    bold: boolean,
    italic: boolean,
    underline: boolean,
    color: string | undefined,
    fontSize: number | undefined
  ): void => {
    if (text.length === 0) return
    const last = runs[runs.length - 1]
    // Merge into the previous run ONLY when every styled attribute matches,
    // including the new per-run color + fontSize, so distinct styling survives.
    if (
      last &&
      !!last.bold === bold &&
      !!last.italic === italic &&
      !!last.underline === underline &&
      last.color === color &&
      last.fontSize === fontSize
    ) {
      last.text += text
    } else {
      runs.push({ text, bold, italic, underline, color, fontSize })
    }
  }
  const pushNewline = (): void => {
    const last = runs[runs.length - 1]
    if (last) last.text += '\n'
    else runs.push({ text: '\n' })
  }

  const isBold = (el: HTMLElement): boolean => {
    const w = window.getComputedStyle(el).fontWeight
    return w === 'bold' || Number(w) >= 600
  }
  const isItalic = (el: HTMLElement): boolean => window.getComputedStyle(el).fontStyle === 'italic'
  const isUnderline = (el: HTMLElement): boolean =>
    window.getComputedStyle(el).textDecorationLine.includes('underline')
  // Per-run color: only captured when the editor span actually set one (skip the
  // default/transparent so plain runs stay color-less and inherit the shape color).
  const getColor = (el: HTMLElement): string | undefined => {
    const c = window.getComputedStyle(el).color
    return c && c !== 'rgba(0, 0, 0, 0)' ? c : undefined
  }
  const getFontSize = (el: HTMLElement): number | undefined => {
    const px = window.getComputedStyle(el).fontSize
    const n = px ? parseFloat(px) : NaN
    return Number.isFinite(n) ? n : undefined
  }
  // The editor root carries the shape's own color + fontSize; runs equal to those
  // defaults must stay color/size-less so they keep inheriting (no spurious
  // per-run override that would survive a later shape-level color/size change).
  const rootStyle = window.getComputedStyle(root)
  const rootColor = rootStyle.color && rootStyle.color !== 'rgba(0, 0, 0, 0)' ? rootStyle.color : undefined
  const rootFontSizePx = rootStyle.fontSize ? parseFloat(rootStyle.fontSize) : NaN
  const rootFontSize = Number.isFinite(rootFontSizePx) ? rootFontSizePx : undefined

  const walk = (
    node: Node,
    b: boolean,
    i: boolean,
    u: boolean,
    color: string | undefined,
    fontSize: number | undefined
  ): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        // Drop color/size that merely match the shape default so plain runs stay
        // override-free; keep genuine per-run differences.
        const c = color && color !== rootColor ? color : undefined
        const fs = fontSize != null && fontSize !== rootFontSize ? fontSize : undefined
        push(child.textContent ?? '', b, i, u, c, fs)
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as HTMLElement
        const tag = el.tagName
        if (tag === 'BR') {
          pushNewline()
          continue
        }
        const blockBefore =
          (tag === 'DIV' || tag === 'P') && runs.length > 0 && !runs[runs.length - 1].text.endsWith('\n')
        if (blockBefore) pushNewline()
        walk(
          el,
          b || isBold(el),
          i || isItalic(el),
          u || isUnderline(el),
          getColor(el) ?? color,
          getFontSize(el) ?? fontSize
        )
      }
    }
  }
  walk(root, false, false, false, undefined, undefined)

  const cleaned = sanitizeRuns(runs)
  const text = (cleaned ?? runs).map((r) => r.text).join('')
  // No rich styling at all => fall back to the plain path (runs undefined).
  return { text, runs: cleaned ?? [] }
}

/**
 * SVG shape layer. MUST be rendered INSIDE `.canvas-world` (the transformed
 * container) so shapes are expressed in world coords and scale crisply with the
 * CSS transform.
 */
export function DrawingLayer({
  editingTextId
}: {
  editingTextId?: string | null
} = {}): JSX.Element {
  const shapes = useDrawing((s) => s.shapes)
  const selectedShapeIds = useDrawing((s) => s.selectedShapeIds)
  const activeTool = useDrawing((s) => s.activeTool)
  const zoom = useCanvas((s) => s.camera.zoom)

  const interactive = activeTool === 'select' || activeTool === 'eraser'

  // The shape SVG MUST have a real (non-zero) viewport, otherwise Chromium/
  // Electron will not paint elements positioned at world coordinates — even
  // with overflow:visible — especially inside the CSS-transformed `.canvas-world`
  // (which itself collapses to 0x0, so width/height:100% would resolve to 0).
  // We therefore give the <svg> a large explicit viewport anchored far in the
  // negative quadrant so it spans world coordinates in every direction. The
  // negative left/top offset re-centers it on the world origin. overflow stays
  // visible as a belt-and-suspenders measure for anything outside even this box.
  const SPAN = 2_000_000
  const HALF = SPAN / 2
  return (
    <svg
      width={SPAN}
      height={SPAN}
      viewBox={`${-HALF} ${-HALF} ${SPAN} ${SPAN}`}
      style={{
        position: 'absolute',
        left: -HALF,
        top: -HALF,
        overflow: 'visible',
        pointerEvents: 'none'
      }}
    >
      <defs>
        {/* one arrowhead marker per stroke color used by arrows */}
        {uniqueArrowColors(shapes).map((c) => (
          <marker
            key={c}
            id={'arrowhead-' + sanitizeId(c)}
            markerWidth="10"
            markerHeight="10"
            refX="8"
            refY="3"
            orient="auto"
            markerUnits="userSpaceOnUse"
          >
            <path d="M0,0 L8,3 L0,6 Z" fill={c} />
          </marker>
        ))}
      </defs>

      {shapes.map((sh) => (
        <ShapeView
          key={sh.id}
          shape={sh}
          interactive={interactive}
          editing={sh.id === editingTextId}
        />
      ))}

      {interactive && selectedShapeIds.length === 1 && (
        <SelectionOverlay shape={shapes.find((s) => s.id === selectedShapeIds[0])} zoom={zoom} />
      )}

      {interactive && selectedShapeIds.length > 1 && (
        <MultiSelectionOutline
          shapes={shapes.filter((s) => selectedShapeIds.includes(s.id))}
          zoom={zoom}
        />
      )}
    </svg>
  )
}

/**
 * Screen-space overlays (text editor + properties panel). MUST be rendered
 * OUTSIDE `.canvas-world` — they use screen/viewport coordinates and would be
 * double-transformed (TextEditor) or mis-placed (DrawProperties uses
 * position:fixed, which resolves against a transformed ancestor) if nested in
 * the transformed container.
 */
export function DrawingOverlays({
  editingTextId,
  onCommitText
}: {
  editingTextId: string | null
  onCommitText: () => void
}): JSX.Element {
  const shapes = useDrawing((s) => s.shapes)
  const updateShape = useDrawing((s) => s.updateShape)
  const camera = useCanvas((s) => s.camera)

  return (
    <>
      {editingTextId && (
        <TextEditor
          shape={shapes.find((s) => s.id === editingTextId)}
          camera={camera}
          onChange={(text, runs) =>
            updateShape(editingTextId, { text, runs: runs && runs.length > 0 ? runs : undefined })
          }
          onCommit={onCommitText}
        />
      )}
      <DrawProperties />
    </>
  )
}

function uniqueArrowColors(shapes: Shape[]): string[] {
  const set = new Set<string>()
  for (const s of shapes) if (s.type === 'arrow') set.add(s.stroke)
  return [...set]
}

function sanitizeId(c: string): string {
  return c.replace(/[^a-zA-Z0-9]/g, '')
}

function dashArray(sh: Shape): string | undefined {
  const w = sh.strokeWidth
  if (sh.strokeStyle === 'dashed') return `${w * 3.5},${w * 3}`
  if (sh.strokeStyle === 'dotted') return `${w * 0.6},${w * 2}`
  return undefined
}

const ShapeView = memo(function ShapeView({
  shape: sh,
  interactive,
  editing
}: {
  shape: Shape
  interactive: boolean
  // While this shape's text is being edited in place, the TextEditor overlay
  // shows the text — so we HIDE the shape's own rendered text to avoid a
  // duplicated/offset "ghost" of the letters under the editor.
  editing?: boolean
}): JSX.Element | null {
  const common = {
    'data-shape-id': sh.id,
    style: { pointerEvents: interactive ? ('all' as const) : ('none' as const) },
    opacity: sh.opacity
  }
  const dash = dashArray(sh)
  const fill = sh.fill === 'transparent' ? 'none' : sh.fill
  // normalize so live-dragging in any direction (negative w/h) renders correctly
  const nx = sh.w < 0 ? sh.x + sh.w : sh.x
  const ny = sh.h < 0 ? sh.y + sh.h : sh.y
  const nw = Math.abs(sh.w)
  const nh = Math.abs(sh.h)

  // Shared "post-it" text label for closed shapes (rect / diamond / ellipse). The
  // label is non-interactive so the shape stays the hit/selection target, and is
  // hidden while editing so the in-place TextEditor overlay isn't ghosted under it.
  // `center` vertically+horizontally centers the text (diamond/ellipse, whose body
  // is centered); rect keeps the top-left "post-it" flow.
  const renderLabel = (center: boolean): JSX.Element | null => {
    if (!sh.text || editing) return null
    const fs = sh.fontSize ?? DEFAULT_FONT_SIZE
    const padX = 8
    const padY = 6
    return (
      <foreignObject
        x={nx + padX}
        y={ny + padY}
        width={Math.max(0, nw - padX * 2)}
        height={Math.max(0, nh - padY * 2)}
        style={{ pointerEvents: 'none', overflow: 'hidden' }}
      >
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: center ? 'center' : 'flex-start',
            color: sh.textColor ?? sh.stroke,
            opacity: sh.opacity,
            fontSize: fs,
            lineHeight: TEXT_LINE_HEIGHT,
            fontFamily: sh.fontFamily ?? DEFAULT_FONT_FAMILY,
            fontWeight: sh.bold ? 700 : 400,
            fontStyle: sh.italic ? 'italic' : 'normal',
            textDecoration: sh.underline ? 'underline' : 'none',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            wordBreak: 'break-word',
            overflow: 'hidden',
            textAlign: sh.align ?? (center ? 'center' : 'left'),
            userSelect: 'none'
          }}
        >
          {renderRichHTML(sh)}
        </div>
      </foreignObject>
    )
  }

  switch (sh.type) {
    case 'rect': {
      // A rect with a `text` label renders the rect border/fill AS-IS (its box is
      // the rect, NOT content-derived) plus a "post-it" text block: the label flows
      // from the TOP-LEFT, WRAPS within the rect width, and a newline (Enter) starts
      // a new line going DOWN. A wrapping HTML <div> inside a <foreignObject> gives
      // proper word-wrap + pre-wrap newlines (SVG <text> can't auto-wrap). The label
      // is non-interactive so the rect stays the hit/selection target.
      return (
        <g>
          <rect
            {...common}
            x={nx}
            y={ny}
            width={nw}
            height={nh}
            rx={Math.min(8, nw / 8, nh / 8)}
            fill={fill}
            stroke={sh.stroke}
            strokeWidth={sh.strokeWidth}
            strokeDasharray={dash}
            strokeLinejoin="round"
          />
          {renderLabel(false)}
        </g>
      )
    }
    case 'diamond': {
      const cx = nx + nw / 2
      const cy = ny + nh / 2
      const pts = `${cx},${ny} ${nx + nw},${cy} ${cx},${ny + nh} ${nx},${cy}`
      return (
        <g>
          <polygon
            {...common}
            points={pts}
            fill={fill}
            stroke={sh.stroke}
            strokeWidth={sh.strokeWidth}
            strokeDasharray={dash}
            strokeLinejoin="round"
          />
          {renderLabel(true)}
        </g>
      )
    }
    case 'ellipse':
      return (
        <g>
          <ellipse
            {...common}
            cx={nx + nw / 2}
            cy={ny + nh / 2}
            rx={nw / 2}
            ry={nh / 2}
            fill={fill}
            stroke={sh.stroke}
            strokeWidth={sh.strokeWidth}
            strokeDasharray={dash}
          />
          {renderLabel(true)}
        </g>
      )
    case 'line':
      return (
        <line
          {...common}
          x1={sh.x}
          y1={sh.y}
          x2={sh.x + sh.w}
          y2={sh.y + sh.h}
          stroke={sh.stroke}
          strokeWidth={sh.strokeWidth}
          strokeDasharray={dash}
          strokeLinecap="round"
        />
      )
    case 'arrow':
      return (
        <line
          {...common}
          x1={sh.x}
          y1={sh.y}
          x2={sh.x + sh.w}
          y2={sh.y + sh.h}
          stroke={sh.stroke}
          strokeWidth={sh.strokeWidth}
          strokeDasharray={dash}
          strokeLinecap="round"
          markerEnd={`url(#arrowhead-${sanitizeId(sh.stroke)})`}
        />
      )
    case 'pen':
      if (!sh.points || sh.points.length < 2) return null
      return (
        <polyline
          {...common}
          points={pointsToStr(sh.points)}
          fill="none"
          stroke={sh.stroke}
          strokeWidth={sh.strokeWidth}
          strokeDasharray={dash}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )
    case 'text': {
      // While editing, the in-place editor overlay shows the text; rendering the
      // SVG <text> too would ghost a duplicated, slightly-offset copy.
      if (editing) return null
      const fs = sh.fontSize ?? DEFAULT_FONT_SIZE
      // Rich text (per-run B/I/U) renders as HTML inside a foreignObject so each
      // run can carry its own styling. Plain-text shapes keep the original crisp
      // SVG <text>/<tspan> path below — identical output to before (back-compat).
      // Optional background fill + border behind the text. `fill` paints a
      // "fondo" (skipped when transparent — back-compat) and `stroke` paints a
      // "trazo" border; textColor stays a SEPARATE property used for the glyphs.
      const pad = textBoxWithPadding(sh)
      const rectFill = sh.fill === 'transparent' ? 'none' : sh.fill
      const bgRect = (
        <rect
          x={pad.x}
          y={pad.y}
          width={Math.max(0, pad.w)}
          height={Math.max(0, pad.h)}
          fill={rectFill}
          stroke={sh.stroke}
          strokeWidth={sh.strokeWidth}
          strokeDasharray={dash}
          opacity={sh.opacity}
          pointerEvents="none"
        />
      )
      if (sh.runs && sh.runs.length > 0) {
        const box = textBox(sh)
        return (
          <g>
            {bgRect}
            <foreignObject
              {...common}
              x={box.x}
              y={box.y}
              width={Math.max(0, box.w)}
              height={Math.max(0, box.h)}
              style={{ ...common.style, overflow: 'visible' }}
            >
              <div
                style={{
                  width: '100%',
                  height: '100%',
                  color: sh.textColor ?? sh.stroke,
                  fontSize: fs,
                  lineHeight: TEXT_LINE_HEIGHT,
                  fontFamily: sh.fontFamily ?? DEFAULT_FONT_FAMILY,
                  // pre-wrap (not pre) so non-left alignment has room to position
                  // each line within the box; plain text shapes are single-run so
                  // wrapping behaviour is unchanged for typical content.
                  whiteSpace: 'pre',
                  textAlign: sh.align ?? 'left',
                  userSelect: 'none'
                }}
              >
                {renderRichHTML(sh)}
              </div>
            </foreignObject>
          </g>
        )
      }
      const align = sh.align ?? 'left'
      // 'justify' has no SVG <text> equivalent; render those plain shapes through a
      // foreignObject <div> (same box as textBox) so CSS text-align can justify.
      if (align === 'justify') {
        const box = textBox(sh)
        return (
          <g>
            {bgRect}
            <foreignObject
              {...common}
              x={box.x}
              y={box.y}
              width={Math.max(0, box.w)}
              height={Math.max(0, box.h)}
              style={{ ...common.style, overflow: 'visible' }}
            >
              <div
                style={{
                  width: '100%',
                  height: '100%',
                  color: sh.textColor ?? sh.stroke,
                  fontSize: fs,
                  lineHeight: TEXT_LINE_HEIGHT,
                  fontFamily: sh.fontFamily ?? DEFAULT_FONT_FAMILY,
                  fontWeight: sh.bold ? 700 : 400,
                  fontStyle: sh.italic ? 'italic' : 'normal',
                  textDecoration: sh.underline ? 'underline' : 'none',
                  whiteSpace: 'pre-wrap',
                  textAlign: 'justify',
                  userSelect: 'none'
                }}
              >
                {sh.text}
              </div>
            </foreignObject>
          </g>
        )
      }
      const lineH = fs * TEXT_LINE_HEIGHT
      // Render each line as a tspan so multi-line text occupies exactly the
      // content-derived box (textBox) shared with the selection outline and the
      // <textarea>. The first baseline sits inside the first line of that box.
      // For left/center/right we keep the crisp SVG <text> path and position via
      // textAnchor + an x anchored to the matching edge of the content box.
      const lines = (sh.text ?? '').split('\n')
      const firstBaseline = sh.y + fs
      const box = textBox(sh)
      const anchorX = align === 'center' ? box.x + box.w / 2 : align === 'right' ? box.x + box.w : box.x
      const textAnchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start'
      return (
        <g>
          {bgRect}
          <text
            {...common}
            x={anchorX}
            y={firstBaseline}
            textAnchor={textAnchor}
            fill={sh.textColor ?? sh.stroke}
            fontSize={fs}
            fontFamily={sh.fontFamily ?? DEFAULT_FONT_FAMILY}
            dominantBaseline="alphabetic"
            style={{
              ...common.style,
              userSelect: 'none',
              whiteSpace: 'pre',
              fontWeight: sh.bold ? 700 : 400,
              fontStyle: sh.italic ? 'italic' : 'normal',
              textDecoration: sh.underline ? 'underline' : 'none'
            }}
          >
            {lines.map((ln, i) => (
              <tspan key={i} x={anchorX} dy={i === 0 ? 0 : lineH}>
                {ln.length ? ln : ' '}
              </tspan>
            ))}
          </text>
        </g>
      )
    }
    default:
      return null
  }
})

function pointsToStr(p: number[]): string {
  let out = ''
  for (let i = 0; i < p.length - 1; i += 2) out += `${p[i]},${p[i + 1]} `
  return out.trim()
}

function SelectionOverlay({
  shape,
  zoom
}: {
  shape: Shape | undefined
  zoom: number
}): JSX.Element | null {
  if (!shape) return null
  const hs = 8 / zoom // handle size (constant on screen)
  const sw = 1.2 / zoom // selection stroke width

  if (shape.type === 'line' || shape.type === 'arrow') {
    const x1 = shape.x
    const y1 = shape.y
    const x2 = shape.x + shape.w
    const y2 = shape.y + shape.h
    return (
      <g pointerEvents="none">
        <line
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          stroke="#7aa2ff"
          strokeWidth={sw}
          strokeDasharray={`${4 / zoom},${3 / zoom}`}
        />
        {endpointHandle(x1, y1, hs, shape.id, 'p0')}
        {endpointHandle(x2, y2, hs, shape.id, 'p1')}
      </g>
    )
  }

  const bb = shapeBBox(shape)
  const pad = 4 / zoom
  const bx = bb.x - pad
  const by = bb.y - pad
  const bw = bb.w + pad * 2
  const bh = bb.h + pad * 2
  const handles: { x: number; y: number; h: string }[] = [
    { x: bx, y: by, h: 'nw' },
    { x: bx + bw / 2, y: by, h: 'n' },
    { x: bx + bw, y: by, h: 'ne' },
    { x: bx + bw, y: by + bh / 2, h: 'e' },
    { x: bx + bw, y: by + bh, h: 'se' },
    { x: bx + bw / 2, y: by + bh, h: 's' },
    { x: bx, y: by + bh, h: 'sw' },
    { x: bx, y: by + bh / 2, h: 'w' }
  ]
  return (
    <g pointerEvents="none">
      <rect
        x={bx}
        y={by}
        width={bw}
        height={bh}
        fill="none"
        stroke="#7aa2ff"
        strokeWidth={sw}
        strokeDasharray={`${4 / zoom},${3 / zoom}`}
      />
      {handles.map((hnd) => (
        <rect
          key={hnd.h}
          data-shape-id={shape.id}
          data-handle={hnd.h}
          x={hnd.x - hs / 2}
          y={hnd.y - hs / 2}
          width={hs}
          height={hs}
          fill="#0b1020"
          stroke="#7aa2ff"
          strokeWidth={sw}
          style={{ pointerEvents: 'all', cursor: handleCursor(hnd.h) }}
        />
      ))}
    </g>
  )
}

/**
 * Lightweight dashed bounding box around the union of a multi-selection / group.
 * No resize handles (group resize is out of scope) so it can never trigger the
 * single-shape resize math and corrupt geometry.
 */
function MultiSelectionOutline({
  shapes,
  zoom
}: {
  shapes: Shape[]
  zoom: number
}): JSX.Element | null {
  const bb = unionBBox(shapes)
  if (!bb) return null
  const sw = 1.2 / zoom
  const pad = 4 / zoom
  return (
    <g pointerEvents="none">
      <rect
        x={bb.x - pad}
        y={bb.y - pad}
        width={bb.w + pad * 2}
        height={bb.h + pad * 2}
        fill="none"
        stroke="#7aa2ff"
        strokeWidth={sw}
        strokeDasharray={`${4 / zoom},${3 / zoom}`}
      />
    </g>
  )
}

function endpointHandle(
  x: number,
  y: number,
  hs: number,
  id: string,
  handle: string
): JSX.Element {
  return (
    <rect
      data-shape-id={id}
      data-handle={handle}
      x={x - hs / 2}
      y={y - hs / 2}
      width={hs}
      height={hs}
      fill="#0b1020"
      stroke="#7aa2ff"
      strokeWidth={hs / 6}
      style={{ pointerEvents: 'all', cursor: 'crosshair' }}
    />
  )
}

function handleCursor(h: string): string {
  switch (h) {
    case 'nw':
    case 'se':
      return 'nwse-resize'
    case 'ne':
    case 'sw':
      return 'nesw-resize'
    case 'n':
    case 's':
      return 'ns-resize'
    case 'e':
    case 'w':
      return 'ew-resize'
    default:
      return 'pointer'
  }
}

/**
 * The live in-place rich-text editor element, shared with DrawProperties so its
 * B/I/U buttons can run document.execCommand on the CURRENT selection inside the
 * editor. A module-level singleton (not a zustand selector) deliberately avoids
 * returning a fresh array/object from a store selector (React #185 risk) — the
 * editor registers itself on mount and clears on unmount.
 */
let activeTextEditorEl: HTMLDivElement | null = null
export function getActiveTextEditor(): HTMLDivElement | null {
  return activeTextEditorEl
}

// The LAST non-collapsed selection seen inside the active editor (text-node
// offsets). A DrawProperties button click can blur the editor and collapse the
// live selection BEFORE the click handler runs, so the format would leak to the
// whole shape. The panel restores THIS saved range before applying, so per-run
// styling targets the text the user actually selected.
let activeEditorSelection: { start: number; end: number } | null = null
export function getActiveEditorSelection(): { start: number; end: number } | null {
  return activeEditorSelection
}

function escapeHTML(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Newlines -> <br> for contentEditable, with HTML-escaped text. */
function textToEditableHTML(text: string): string {
  return text.split('\n').map(escapeHTML).join('<br>')
}

/**
 * Build the INITIAL innerHTML for the contentEditable from a shape's runs (or
 * plain text). Applied imperatively ONCE on mount — never as React children — so
 * React's reconciler never re-writes the DOM under the caret while typing.
 */
function buildEditorHTML(shape: Shape): string {
  if (!shape.runs || shape.runs.length === 0) return textToEditableHTML(shape.text ?? '')
  return shape.runs
    .map((run) => {
      const style =
        `font-weight:${run.bold ? 700 : 400};` +
        `font-style:${run.italic ? 'italic' : 'normal'};` +
        `text-decoration:${run.underline ? 'underline' : 'none'}` +
        (run.color ? `;color:${run.color}` : '') +
        (run.fontSize ? `;font-size:${run.fontSize}px` : '')
      return `<span style="${style}">${textToEditableHTML(run.text)}</span>`
    })
    .join('')
}

function TextEditor({
  shape,
  camera,
  onChange,
  onCommit
}: {
  shape: Shape | undefined
  camera: { x: number; y: number; zoom: number }
  onChange: (text: string, runs: TextRun[]) => void
  onCommit: () => void
}): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  // Commit on blur, but guard against blurs caused by clicking a DrawProperties
  // B/I/U button (those re-focus the editor): a queued commit is cancelled if the
  // editor regains focus on the next tick.
  const blurCommitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Capture the shape's content ONCE for the initial DOM; subsequent store
  // updates (per keystroke) must NOT re-seed the editor or the caret jumps.
  const initialShapeRef = useRef(shape)

  useEffect(() => {
    const el = ref.current
    const sh = initialShapeRef.current
    if (!el || !sh) return
    activeTextEditorEl = el
    // Seed the DOM imperatively (NOT via React children) so React never rewrites
    // the editor's nodes under the caret on the per-keystroke store re-render.
    el.innerHTML = buildEditorHTML(sh)
    el.focus()
    // Select all on first focus (matches the old textarea .select()).
    const range = document.createRange()
    range.selectNodeContents(el)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    // Remember the latest NON-COLLAPSED selection inside this editor so a panel
    // button click (which can blur + collapse the live selection before its
    // onClick runs) can restore the exact range to style. Ignore collapsed carets.
    const onSelChange = (): void => {
      const s = window.getSelection()
      if (!s || s.rangeCount === 0 || s.isCollapsed) return
      const r = s.getRangeAt(0)
      if (!el.contains(r.commonAncestorContainer)) return
      activeEditorSelection = saveEditorSelection(el)
    }
    document.addEventListener('selectionchange', onSelChange)
    return () => {
      if (activeTextEditorEl === el) activeTextEditorEl = null
      activeEditorSelection = null
      document.removeEventListener('selectionchange', onSelChange)
      if (blurCommitTimer.current) clearTimeout(blurCommitTimer.current)
    }
  }, [])

  if (!shape) return null
  // For a TEXT shape, use the SAME content-derived box as the SVG text +
  // selection outline so the editing overlay, rendered text and selection box
  // stay perfectly aligned. For a RECT we edit a label inside the rect's own box
  // (shapeBBox), so the editor overlays the whole rect.
  const isBox = shape.type === 'rect' || shape.type === 'diamond' || shape.type === 'ellipse'
  const box = isBox ? shapeBBox(shape) : textBox(shape)
  const screenX = box.x * camera.zoom + camera.x
  const screenY = box.y * camera.zoom + camera.y
  const fontSize = (shape.fontSize ?? DEFAULT_FONT_SIZE) * camera.zoom
  const width = box.w * camera.zoom
  const height = box.h * camera.zoom
  // Rect = "post-it": text starts at the TOP-LEFT with a small inset matching the
  // rendered foreignObject (padX 8 / padY 6 world px), wraps, and Enter adds a line.
  // Text shapes stay flush top-left with no wrap.
  const padX = isBox ? 8 * camera.zoom : 0
  const padY = isBox ? 6 * camera.zoom : 0

  const emit = (): void => {
    const el = ref.current
    if (!el) return
    const { text, runs } = extractRunsFromDOM(el)
    onChange(text, runs)
  }

  // Geometry of the fondo/trazo rect drawn BEHIND the contentEditable. For a TEXT
  // shape the SVG <text> + its bgRect are hidden while editing (ShapeView returns
  // null), so without this the fondo/trazo would visually disappear during edit.
  // We mirror textBoxWithPadding (the same padded box the SVG bgRect uses) so the
  // background stays put. For a RECT the background IS the rect itself (still
  // rendered by ShapeView since only TEXT shapes return null while editing), so we
  // only need the behind-editor rect for the text shape.
  const bgScreenX = isBox ? screenX : (textBoxWithPadding(shape).x * camera.zoom + camera.x)
  const bgScreenY = isBox ? screenY : (textBoxWithPadding(shape).y * camera.zoom + camera.y)
  const bgWidth = isBox ? width : textBoxWithPadding(shape).w * camera.zoom
  const bgHeight = isBox ? height : textBoxWithPadding(shape).h * camera.zoom
  const showBg = shape.type === 'text'

  return (
    <>
      {/* Fondo + trazo behind the contentEditable while editing a TEXT shape, so
          the background/border stays visible (the SVG copy is hidden during edit). */}
      {showBg && (
        <div
          style={{
            position: 'absolute',
            left: bgScreenX,
            top: bgScreenY,
            zIndex: 44,
            width: bgWidth,
            height: bgHeight,
            boxSizing: 'border-box',
            background: shape.fill === 'transparent' ? 'transparent' : shape.fill,
            border:
              shape.strokeWidth && shape.stroke
                ? `${shape.strokeWidth * camera.zoom}px solid ${shape.stroke}`
                : 'none',
            opacity: shape.opacity,
            pointerEvents: 'none'
          }}
        />
      )}
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        data-canvasio-text-editor
        onInput={emit}
        onBlur={() => {
          // Defer: a DrawProperties B/I/U click blurs the editor then re-focuses
          // it; only commit if focus did NOT return to the editor. We also SAVE the
          // selection so that if the editor regains focus (a panel button) we can
          // restore the exact range the format command needs to act on.
          const el = ref.current
          const savedSelection = el ? saveEditorSelection(el) : null
          if (blurCommitTimer.current) clearTimeout(blurCommitTimer.current)
          blurCommitTimer.current = setTimeout(() => {
            if (document.activeElement !== ref.current) {
              onCommit()
            } else if (savedSelection && ref.current) {
              restoreEditorSelection(ref.current, savedSelection)
            }
          }, 150)
        }}
        onFocus={() => {
          if (blurCommitTimer.current) {
            clearTimeout(blurCommitTimer.current)
            blurCommitTimer.current = null
          }
        }}
        onKeyDown={(e) => {
          // Enter ALWAYS inserts a newline (real text-box behaviour). Commit by
          // clicking away (onBlur), pressing Escape, or Cmd/Ctrl+Enter. Inline
          // B/I/U via Cmd/Ctrl+B/I/U applies to the current selection.
          if (e.key === 'Escape') {
            e.preventDefault()
            onCommit()
          } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            onCommit()
          } else if ((e.metaKey || e.ctrlKey) && !e.altKey) {
            const k = e.key.toLowerCase()
            if (k === 'b' || k === 'i' || k === 'u') {
              e.preventDefault()
              document.execCommand(k === 'b' ? 'bold' : k === 'i' ? 'italic' : 'underline')
              emit()
            }
          }
        }}
        onPointerDown={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          left: screenX,
          top: screenY,
          zIndex: 45,
          width,
          height,
          boxSizing: 'border-box',
          background: 'transparent',
          color: shape.textColor ?? shape.stroke,
          fontSize,
          lineHeight: TEXT_LINE_HEIGHT,
          fontFamily: shape.fontFamily ?? DEFAULT_FONT_FAMILY,
          // Shape-level B/I/U remain the DEFAULT styling for runs that don't set
          // their own (plain shapes are fully shape-styled, exactly as before).
          fontWeight: shape.bold ? 700 : 400,
          fontStyle: shape.italic ? 'italic' : 'normal',
          textDecoration: shape.underline ? 'underline' : 'none',
          border: 'none',
          outline: 'none',
          padding: `${padY}px ${padX}px`,
          margin: 0,
          overflow: 'hidden',
          whiteSpace: isBox ? 'pre-wrap' : 'pre',
          wordBreak: isBox ? 'break-word' : 'normal',
          textAlign: shape.align ?? 'left',
          transformOrigin: 'top left'
        }}
      />
    </>
  )
}
