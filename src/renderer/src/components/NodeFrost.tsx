import { useEffect, useRef } from 'react'
import { useCanvas } from '../store/canvas'
import { getFrostSource } from './Background'

// Mirror NodeView / TerminalOverlay geometry so the in-world frost lines up with
// the node body exactly (same header strip + hairline border).
const HEADER = 34
const BORDER = 1

/**
 * Per-node in-body frosted wallpaper. Renders the blurred slice of the live
 * pixel-art wallpaper that sits UNDER this node's body, as the bottom layer of
 * .node-body, so an in-world node (music/web/markdown/...) reads as the SAME
 * liquid glass as the terminals — without the z-29 layer (which can't reach
 * in-world content past the .canvas-world stacking context).
 *
 * Canvas wallpaper only: blits the shared low-res frost buffer (already drawn by
 * Background each frame) into a small per-node canvas, sampling the sub-rect under
 * this node. VIDEO wallpaper → returns null (NodeView paints the translucent
 * fallback tint instead). Pauses with the wallpaper loop (same rAF cadence) and
 * on visibilitychange.
 *
 * #185-safe: the draw loop reads `camera` imperatively (never subscribes); the
 * only reactive read is a PRIMITIVE boolean selector (canvas vs video) that flips
 * the mount.
 */
export function NodeFrost({
  node,
  header = HEADER
}: {
  node: { x: number; y: number; w: number; h: number }
  // Header strip height to skip when sampling the wallpaper slice. Full nodes use
  // the default 34px chrome header; the headerless collapsed chip passes 0 so the
  // frosted slice fills the whole square exactly.
  header?: number
}): JSX.Element | null {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // No reactive subscription: the rAF loop reads getFrostSource() imperatively
  // each frame and adapts to whatever the current wallpaper is (canvas OR video),
  // so a kind flip is picked up live with no re-render (#185-safe).

  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const ctx = el.getContext('2d')
    if (!ctx) return

    let raf = 0
    let stopped = false
    // Internal buffer kept low-res (the source IS low-res; CSS blur upscales).
    const DOWNSCALE = 3

    const draw = (): void => {
      if (stopped) return
      raf = requestAnimationFrame(draw)
      const src = getFrostSource()
      // Source = the low-res canvas buffer (canvas bg) OR the live wallpaper
      // <video> frame (video bg). drawImage samples both; for video we need the
      // frame ready (readyState >= HAVE_CURRENT_DATA).
      let buf: HTMLCanvasElement | HTMLVideoElement | null = null
      let iw = 0
      let ih = 0
      if (src.kind === 'canvas' && src.canvas) {
        buf = src.canvas
        iw = src.canvas.width
        ih = src.canvas.height
      } else if (src.kind === 'video' && src.video && src.video.readyState >= 2) {
        buf = src.video
        iw = src.video.videoWidth
        ih = src.video.videoHeight
      }
      if (!buf || iw < 1 || ih < 1) return
      const cam = useCanvas.getState().camera
      const z = cam.zoom

      // This node body's rect in SCREEN px (mirror TerminalOverlay rounding).
      const ox = Math.round(cam.x)
      const oy = Math.round(cam.y)
      const bodyLeft = ox + node.x * z + BORDER * z
      const bodyTop = oy + (node.y + header) * z
      const bodyW = (node.w - 2 * BORDER) * z
      const bodyH = (node.h - header - BORDER) * z
      if (bodyW < 1 || bodyH < 1) return

      // Map screen px → shared buffer px. The buffer is the wallpaper rendered at
      // (innerWidth/SCALE)×(innerHeight/SCALE) covering the FULL viewport, so
      // bufX = screenX * (buf.width / innerWidth).
      const sx = iw / window.innerWidth
      const sy = ih / window.innerHeight
      const srcX = bodyLeft * sx
      const srcY = bodyTop * sy
      const srcW = bodyW * sx
      const srcH = bodyH * sy

      // Our per-node canvas is sized to the body WORLD px / DOWNSCALE so it's tiny
      // and zoom-independent; CSS stretches it to 100% of the body.
      const dw = Math.max(1, Math.ceil((node.w - 2 * BORDER) / DOWNSCALE))
      const dh = Math.max(1, Math.ceil((node.h - header - BORDER) / DOWNSCALE))
      if (el.width !== dw || el.height !== dh) {
        el.width = dw
        el.height = dh
      }
      ctx.clearRect(0, 0, dw, dh)
      try {
        // Sample the wallpaper slice under this node and draw it stretched to our
        // little canvas. (Source rect may extend past the buffer when the node is
        // partly off-screen — drawImage clamps/transparent-fills gracefully.)
        ctx.drawImage(buf, srcX, srcY, srcW, srcH, 0, 0, dw, dh)
      } catch {
        /* buffer not ready this frame — skip */
      }
    }
    raf = requestAnimationFrame(draw)
    const onVis = (): void => {
      if (document.hidden && raf) {
        cancelAnimationFrame(raf)
        raf = 0
      } else if (!document.hidden && !raf && !stopped) {
        raf = requestAnimationFrame(draw)
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      stopped = true
      if (raf) cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [node.x, node.y, node.w, node.h, header])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        zIndex: 0, // bottom layer of .node-body (content sits above)
        pointerEvents: 'none',
        imageRendering: 'auto',
        filter: 'blur(18px) saturate(1.32) brightness(1.0)',
        // The blur softens the edge; a slight scale hides blur-edge transparency.
        transform: 'scale(1.06)'
      }}
    />
  )
}
