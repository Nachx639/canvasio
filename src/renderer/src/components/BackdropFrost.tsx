import { useEffect, useRef, useState } from 'react'
import { setFrostCanvas } from './Background'

/**
 * REAL frosted liquid glass — the blurred-wallpaper backdrop.
 *
 * Chromium does NOT sample a GPU-composited <canvas>/<video> into a CSS
 * `backdrop-filter`, so the wallpaper (Background.tsx, zIndex 0) never frosts
 * the glass surfaces above it — they just show the SHARP wallpaper through a
 * dark tint. The fix here: render ONE extra full-viewport BLURRED + saturated
 * copy of the CURRENT wallpaper as a `position:fixed` layer at z-29 (just under
 * the z-30 terminal overlay), and REVEAL it only under the glass surfaces via a
 * CSS mask built from the union of each terminal box's visible rounded rects.
 *
 * The mask reuses the EXACT visible-region the terminal occlusion code already
 * computes (front occluders subtracted), so z-occlusion / move / resize / zoom
 * stay in lockstep for free, and the blurred source is always exactly ONE
 * (one extra muted <video> decode OR one extra cheap canvas blit — never N).
 */

// Shared mask registry: each TerminalBox publishes its current reveal shape here
// (visible rounded rects in SCREEN px). BackdropFrost composes them into ONE CSS
// mask so the single blurred layer is shown ONLY under glass surfaces. Module
// scope so the z-30 boxes and this z-29 layer share it with no React coupling
// (DOM-stable; never triggers a re-render -> #185-safe).
// `r` is the uniform fallback corner radius (used by HUD bars). Terminals pass
// PER-CORNER radii (tl/tr/br/bl) so the mask matches the box's real shape — square
// top (it meets the header) + rounded bottom — and, when a front window occludes
// it, each visible sub-rect rounds ONLY the corners that coincide with the box's
// true outer corners. Rounding every sub-rect's corners (the old `rx`) pulled the
// frost in at internal cut edges, leaving triangular gaps ("piquitos") where the
// rectangular occlusion clip and the rounded frost disagreed.
type FrostRect = {
  x: number
  y: number
  w: number
  h: number
  r: number
  tl?: number
  tr?: number
  br?: number
  bl?: number
}
// A shape is EITHER a plain list of reveal rects (HUD bars, via useFrostRect) OR
// an `outer` box minus `holes` (terminals): the outer glass shape with rounded
// occluder holes punched out via evenodd, so the reveal matches the occlusion
// clip exactly and keeps the front window's rounded-corner triangles.
type FrostShape = { rects?: FrostRect[]; outer?: FrostRect; holes?: FrostRect[]; z: number }

// Rounded-rect path with four INDEPENDENT corner radii. A 0 radius emits a sharp
// corner (the H/V lines reach it; no arc), so internal occlusion-cut edges stay
// flush with the box's rectangular clip.
function rrPath(
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
    `M${x + tl},${y}` +
    `H${x + w - tr}` +
    (tr ? `A${tr},${tr} 0 0 1 ${x + w},${y + tr}` : '') +
    `V${y + h - br}` +
    (br ? `A${br},${br} 0 0 1 ${x + w - br},${y + h}` : '') +
    `H${x + bl}` +
    (bl ? `A${bl},${bl} 0 0 1 ${x},${y + h - bl}` : '') +
    `V${y + tl}` +
    (tl ? `A${tl},${tl} 0 0 1 ${x + tl},${y}` : '') +
    'Z'
  )
}
const frostShapes = new Map<string, FrostShape>()
let frostEl: HTMLElement | null = null
let frostRaf = 0

// Imperatively rebuild the layer's mask from all registered boxes. Higher-z
// occlusion is ALREADY baked into each box's `rects` (TerminalBox subtracts
// front occluders before publishing), so the union is just every box's rects.
// rAF-coalesced so a multi-box applyRect storm produces ONE mask update.
function scheduleMaskRebuild(): void {
  if (frostRaf) return
  frostRaf = requestAnimationFrame(() => {
    frostRaf = 0
    if (!frostEl) return
    if (frostShapes.size === 0) {
      frostEl.style.webkitMaskImage = 'none'
      frostEl.style.maskImage = 'none'
      return
    }
    // Each visible rect becomes an opaque rounded box in the mask; gaps between
    // windows stay transparent so the SHARP wallpaper shows there. We use one
    // SVG mask of white rounded rects (sharp corners, single raster, kept to the
    // viewport size) rather than N DOM layers.
    const corners = (r: FrostRect): [number, number, number, number] => [
      r.tl ?? r.r,
      r.tr ?? r.r,
      r.br ?? r.r,
      r.bl ?? r.r
    ]
    const spans: string[] = []
    for (const s of frostShapes.values()) {
      if (s.outer) {
        // Terminal: outer glass shape MINUS rounded occluder holes (evenodd).
        const o = s.outer
        let d = rrPath(o.x, o.y, o.w, o.h, ...corners(o))
        if (s.holes) for (const h of s.holes) d += rrPath(h.x, h.y, h.w, h.h, ...corners(h))
        spans.push(`<path fill-rule="evenodd" d="${d}"/>`)
      } else if (s.rects) {
        // HUD bars: independent rounded reveal rects.
        for (const r of s.rects) spans.push(`<path d="${rrPath(r.x, r.y, r.w, r.h, ...corners(r))}"/>`)
      }
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${window.innerWidth}" height="${window.innerHeight}"><g fill="#fff">${spans.join('')}</g></svg>`
    const url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
    frostEl.style.webkitMaskImage = url
    frostEl.style.maskImage = url
    frostEl.style.webkitMaskSize = '100% 100%'
    frostEl.style.maskSize = '100% 100%'
    frostEl.style.webkitMaskRepeat = 'no-repeat'
    frostEl.style.maskRepeat = 'no-repeat'
  })
}

export function frostRegister(id: string, shape: FrostShape): void {
  frostShapes.set(id, shape)
  scheduleMaskRebuild()
}
export function frostUnregister(id: string): void {
  if (frostShapes.delete(id)) scheduleMaskRebuild()
}

// Read the current video selection from localStorage — MUST mirror Background's
// readSelection so the blurred copy always matches the live wallpaper.
function readSelection(): { id: string; mode: 'normal' | 'boom' } | null {
  const id = (localStorage.getItem('canvasio:bg') || '').trim()
  if (!id) return null
  const mode = localStorage.getItem('canvasio:bgmode') === 'boom' ? 'boom' : 'normal'
  return { id, mode }
}

type BgItem = { id: string; name: string; hasBoom: boolean }

/**
 * Blurred copy of the looping video wallpaper. Same `src` as Background's
 * VideoBackground (exactly ONE extra muted decode), paused on visibilitychange,
 * with a heavy CSS blur + saturate. `scale(1.06)` hides the blur-edge
 * transparency at the viewport borders.
 */
function VideoFrost({ id, mode, hasBoom }: { id: string; mode: 'normal' | 'boom'; hasBoom: boolean }): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const variant = mode === 'boom' && hasBoom ? '.boom' : ''
  const src = `canvasio-bg://local/${id}${variant}.mp4`

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onVisibility = (): void => {
      if (document.hidden) video.pause()
      else void video.play().catch(() => {})
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  return (
    <video
      ref={videoRef}
      src={src}
      autoPlay
      loop
      muted
      playsInline
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        objectFit: 'cover',
        // DARKEN (not brighten) the frosted wallpaper so the dark tint over it
        // keeps light text legible over bright wallpapers (audit #8).
        filter: 'blur(30px) saturate(1.35) brightness(1.0)',
        transform: 'scale(1.06)'
      }}
    />
  )
}

/**
 * Blurred copy of the animated pixel-art wallpaper. The Background draw loop
 * blits its already-rendered low-res buffer into this canvas once per frame
 * (setFrostCanvas), so there is exactly ONE extra cheap drawImage — no scene
 * re-draw — and it pauses with the loop when hidden. CSS blur smooths it into a
 * frosted surface (image-rendering:auto, NOT pixelated).
 */
function CanvasFrost(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const el = canvasRef.current
    // Keep the frost buffer at the low-res internal size so the blit is near-free;
    // CSS upscales + blurs it to full viewport anyway.
    if (el) {
      el.width = Math.max(1, Math.ceil(window.innerWidth / 3))
      el.height = Math.max(1, Math.ceil(window.innerHeight / 3))
    }
    setFrostCanvas(el)
    const onResize = (): void => {
      if (!el) return
      el.width = Math.max(1, Math.ceil(window.innerWidth / 3))
      el.height = Math.max(1, Math.ceil(window.innerHeight / 3))
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      setFrostCanvas(null)
    }
  }, [])
  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        imageRendering: 'auto',
        filter: 'blur(22px) saturate(1.32) brightness(1.0)',
        transform: 'scale(1.04)'
      }}
    />
  )
}

/**
 * Single blurred-wallpaper layer (z-29). Mirrors Background's video-vs-canvas
 * selection so the frost always matches the live wallpaper. Sibling of
 * Background/Canvas/TerminalOverlays — never wraps them, never conditionally
 * unmounts a terminal (#185 / pty-safe). The reveal mask is applied imperatively
 * by scheduleMaskRebuild as terminal boxes publish their visible rects.
 */
export function BackdropFrost(): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const [selection, setSelection] = useState<{ id: string; mode: 'normal' | 'boom' } | null>(() =>
    readSelection()
  )
  const [items, setItems] = useState<BgItem[]>([])
  const [failed, setFailed] = useState(false)

  // Hand our root to the module-scope mask registry so registered boxes can
  // reveal the frost; rebuild any pending mask once mounted.
  useEffect(() => {
    frostEl = rootRef.current
    scheduleMaskRebuild()
    const onResize = (): void => scheduleMaskRebuild()
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      frostEl = null
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const refresh = (): void => {
      setSelection(readSelection())
      setFailed(false)
    }
    window.addEventListener('canvasio:bgchange', refresh)
    void window.canvasio.bg
      .list()
      .then((list) => {
        if (!cancelled) setItems(list)
      })
      .catch(() => {
        if (!cancelled) setItems([])
      })
    return () => {
      cancelled = true
      window.removeEventListener('canvasio:bgchange', refresh)
    }
  }, [])

  const useVideo = !!selection && !failed
  const hasBoom = useVideo ? (items.find((b) => b.id === selection!.id)?.hasBoom ?? false) : false

  return (
    <div
      ref={rootRef}
      aria-hidden
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 29,
        pointerEvents: 'none',
        // Until a terminal box publishes a reveal rect there is nothing to show.
        maskImage: 'none',
        WebkitMaskImage: 'none',
        overflow: 'hidden'
      }}
    >
      {useVideo ? (
        <VideoFrost
          // onError on the real Background already triggers its own fallback; if
          // the src is bad the frost simply paints nothing under the mask.
          key={`${selection!.id}:${selection!.mode}`}
          id={selection!.id}
          mode={selection!.mode}
          hasBoom={hasBoom}
        />
      ) : (
        <CanvasFrost />
      )}
    </div>
  )
}
