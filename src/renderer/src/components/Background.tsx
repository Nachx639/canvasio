import { useEffect, useRef, useState } from 'react'
import { useCanvas } from '../store/canvas'
import { getTheme, Theme } from '../lib/themes'

// Frost source hand-off (REAL liquid glass): BackdropFrost registers a small
// low-res canvas here; the animated-wallpaper draw loop blits its already-
// rendered buffer into it once per frame (one cheap drawImage, no scene
// re-draw), and BackdropFrost CSS-blurs that copy to make the frosted backdrop.
// Module scope so there is no React coupling and exactly ONE frost source. The
// blit is inside the throttled/paused loop, so it pauses when hidden for free.
let frostCanvas: HTMLCanvasElement | null = null
let frostCtx: CanvasRenderingContext2D | null = null
export function setFrostCanvas(el: HTMLCanvasElement | null): void {
  frostCanvas = el
  frostCtx = el ? el.getContext('2d') : null
}

// Shared wallpaper-frost SOURCE descriptor. BackdropFrost still drives the z-29
// layer (via setFrostCanvas above); NodeFrost (in-world nodes) reads the SAME
// low-res scene buffer to paint the wallpaper slice under each node. kind='video'
// → in-world nodes fall back to a translucent tint (no per-node video clone).
// Module scope = one source, no React coupling. The buffer here is the
// AnimatedCanvas's OWN <canvas> (its internal innerWidth/3 × innerHeight/3
// resolution), registered on mount — NodeFrost reads it live with drawImage, no
// second blit.
type FrostSource = {
  kind: 'canvas' | 'video'
  canvas: HTMLCanvasElement | null
  video: HTMLVideoElement | null
}
let frostSourceCanvas: HTMLCanvasElement | null = null
let frostSourceVideo: HTMLVideoElement | null = null
let frostSource: FrostSource = { kind: 'canvas', canvas: null, video: null }
export function getFrostSource(): FrostSource {
  return frostSource
}
export function setFrostKind(kind: 'canvas' | 'video'): void {
  frostSource = {
    kind,
    canvas: kind === 'canvas' ? frostSourceCanvas : null,
    video: kind === 'video' ? frostSourceVideo : null
  }
}
function setFrostSourceCanvas(el: HTMLCanvasElement | null): void {
  frostSourceCanvas = el
  if (frostSource.kind === 'canvas') frostSource = { ...frostSource, canvas: el }
}
// The looping wallpaper <video> registers itself here so in-world NodeFrost can
// sample its live frame (drawImage works on a <video>) for video backgrounds.
export function setFrostSourceVideo(el: HTMLVideoElement | null): void {
  frostSourceVideo = el
  if (frostSource.kind === 'video') frostSource = { ...frostSource, video: el }
}

/**
 * Pixel-art animated night sky:
 *  - deep gradient sky
 *  - parallax twinkling starfield
 *  - glowing moon with craters + halo
 *  - drifting pixel clouds
 *  - foreground grass band with swaying flowers + fireflies
 * Rendered to a low-res offscreen buffer and upscaled (pixelated) for the
 * crisp retro look, then animated with requestAnimationFrame.
 */
function AnimatedCanvas(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const themeId = useCanvas((s) => s.theme)
  const paletteRef = useRef<Theme>(getTheme(themeId))

  useEffect(() => {
    paletteRef.current = getTheme(themeId)
  }, [themeId])

  useEffect(() => {
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    let raf = 0
    let running = false
    let t = 0
    // Throttle the redraw to a sane frame rate so high-refresh displays don't
    // burn CPU/GPU on a full-scene repaint every vsync. 60 FPS matches the
    // motion speed the animation was tuned for (t advances once per drawn frame).
    const FRAME_MS = 1000 / 60
    let lastDraw = 0
    const P = (): Theme => paletteRef.current

    // low-res internal buffer scale (pixel-art)
    const SCALE = 3
    let W = 0
    let H = 0

    // entities (regenerated on resize)
    let stars: { x: number; y: number; s: number; ph: number; depth: number }[] = []
    let clouds: { x: number; y: number; w: number; speed: number; puffs: number[] }[] = []
    let flowers: { x: number; c: string; ph: number; h: number }[] = []
    let fireflies: { x: number; y: number; ph: number; r: number }[] = []
    let shooting: { x: number; y: number; vx: number; vy: number; life: number } | null = null
    let shootTimer = 220

    function rand(a: number, b: number): number {
      return a + Math.random() * (b - a)
    }

    function build(): void {
      const dpr = 1
      W = Math.ceil((window.innerWidth / SCALE) * dpr)
      H = Math.ceil((window.innerHeight / SCALE) * dpr)
      canvas.width = W
      canvas.height = H
      canvas.style.width = window.innerWidth + 'px'
      canvas.style.height = window.innerHeight + 'px'

      stars = []
      const count = Math.floor((W * H) / 520)
      for (let i = 0; i < count; i++) {
        stars.push({
          x: Math.random() * W,
          y: Math.random() * H * 0.82,
          s: Math.random() < 0.85 ? 1 : 2,
          ph: Math.random() * Math.PI * 2,
          depth: rand(0.2, 1)
        })
      }

      clouds = []
      for (let i = 0; i < 6; i++) {
        const puffs: number[] = []
        const n = Math.floor(rand(4, 8))
        for (let j = 0; j < n; j++) puffs.push(rand(6, 16))
        clouds.push({
          x: rand(-100, W),
          y: rand(H * 0.08, H * 0.4),
          w: rand(40, 90),
          speed: rand(0.02, 0.07),
          puffs
        })
      }

      flowers = []
      const fcolors = ['#e85d9a', '#f2c84b', '#8a7bff', '#5ad1e8', '#ff8a5c', '#c77dff']
      const fcount = Math.floor(W / 22)
      for (let i = 0; i < fcount; i++) {
        flowers.push({
          x: rand(0, W),
          c: fcolors[Math.floor(Math.random() * fcolors.length)],
          ph: Math.random() * Math.PI * 2,
          h: rand(5, 12)
        })
      }

      fireflies = []
      for (let i = 0; i < 18; i++) {
        fireflies.push({
          x: rand(0, W),
          y: rand(H * 0.55, H * 0.9),
          ph: Math.random() * Math.PI * 2,
          r: rand(0.6, 1.4)
        })
      }
    }

    function px(x: number, y: number, w: number, h: number, color: string): void {
      ctx.fillStyle = color
      ctx.fillRect(Math.round(x), Math.round(y), Math.ceil(w), Math.ceil(h))
    }

    function render(): void {
      t += 1

      const pal = P()

      // sky gradient
      const g = ctx.createLinearGradient(0, 0, 0, H)
      g.addColorStop(0, pal.sky[0])
      g.addColorStop(0.32, pal.sky[1])
      g.addColorStop(0.68, pal.sky[2])
      g.addColorStop(1, pal.sky[3])
      ctx.fillStyle = g
      ctx.fillRect(0, 0, W, H)

      // nebula glows for depth
      const neb = ctx.createRadialGradient(W * 0.78, H * 0.2, 0, W * 0.78, H * 0.2, W * 0.55)
      neb.addColorStop(0, pal.nebula[0])
      neb.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = neb
      ctx.fillRect(0, 0, W, H)
      const neb2 = ctx.createRadialGradient(W * 0.2, H * 0.5, 0, W * 0.2, H * 0.5, W * 0.45)
      neb2.addColorStop(0, pal.nebula[1])
      neb2.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = neb2
      ctx.fillRect(0, 0, W, H)

      // stars (twinkle)
      for (const st of stars) {
        const a = 0.45 + 0.55 * Math.sin(t * 0.03 * st.depth + st.ph)
        ctx.globalAlpha = Math.max(0, a) * st.depth
        px(st.x, st.y, st.s, st.s, st.depth > 0.7 ? pal.star[0] : pal.star[1])
      }
      ctx.globalAlpha = 1

      // moon
      const mx = W * 0.8
      const my = H * 0.18
      const mr = Math.max(14, W * 0.035)
      const halo = ctx.createRadialGradient(mx, my, mr * 0.4, mx, my, mr * 3.4)
      halo.addColorStop(0, pal.moonHalo)
      halo.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = halo
      ctx.beginPath()
      ctx.arc(mx, my, mr * 3.4, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = pal.moon
      ctx.beginPath()
      ctx.arc(mx, my, mr, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = 'rgba(150,170,220,0.35)'
      ctx.beginPath()
      ctx.arc(mx - mr * 0.35, my - mr * 0.2, mr * 0.2, 0, Math.PI * 2)
      ctx.arc(mx + mr * 0.3, my + mr * 0.25, mr * 0.14, 0, Math.PI * 2)
      ctx.arc(mx + mr * 0.05, my - mr * 0.4, mr * 0.1, 0, Math.PI * 2)
      ctx.fill()

      // shooting star
      shootTimer--
      if (shootTimer <= 0 && !shooting) {
        shooting = { x: rand(0, W * 0.6), y: rand(0, H * 0.3), vx: rand(1.4, 2.4), vy: rand(0.5, 1), life: 1 }
        shootTimer = Math.floor(rand(260, 620))
      }
      if (shooting) {
        shooting.x += shooting.vx
        shooting.y += shooting.vy
        shooting.life -= 0.012
        ctx.globalAlpha = Math.max(0, shooting.life)
        ctx.strokeStyle = '#dfe9ff'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(shooting.x, shooting.y)
        ctx.lineTo(shooting.x - shooting.vx * 8, shooting.y - shooting.vy * 8)
        ctx.stroke()
        ctx.globalAlpha = 1
        if (shooting.life <= 0) shooting = null
      }

      // clouds (pixel puffs)
      for (const cl of clouds) {
        cl.x += cl.speed
        if (cl.x - cl.w > W) cl.x = -cl.w * 2
        ctx.globalAlpha = 0.5
        let ox = cl.x
        for (const p of cl.puffs) {
          px(ox, cl.y - p * 0.4, p, p * 0.8, 'rgba(160,180,225,0.5)')
          ox += p * 0.7
        }
        ctx.globalAlpha = 1
      }

      // distant hills silhouettes
      if (pal.grass) {
        ctx.fillStyle = pal.sky[0]
        const hillBase = H * 0.78
        ctx.beginPath()
        ctx.moveTo(0, hillBase)
        for (let x = 0; x <= W; x += 8) {
          const y = hillBase - Math.sin(x * 0.012 + 1) * 10 - 6
          ctx.lineTo(x, y)
        }
        ctx.lineTo(W, H)
        ctx.lineTo(0, H)
        ctx.fill()

        // foreground grass band
        const grassTop = H * 0.84
        const gg = ctx.createLinearGradient(0, grassTop, 0, H)
        gg.addColorStop(0, pal.grass[0])
        gg.addColorStop(1, pal.grass[1])
        ctx.fillStyle = gg
        ctx.fillRect(0, grassTop, W, H - grassTop)

        // grass blades
        ctx.strokeStyle = pal.blade
        for (let x = 0; x < W; x += 3) {
          const sway = Math.sin(t * 0.04 + x * 0.3) * 1.5
          ctx.beginPath()
          ctx.moveTo(x, H)
          ctx.lineTo(x + sway, grassTop + rand(0, 4))
          ctx.stroke()
        }

        // flowers
        for (const f of flowers) {
          const sway = Math.sin(t * 0.05 + f.ph) * 1.6
          const baseY = grassTop + 2
          const topY = baseY - f.h
          ctx.strokeStyle = pal.blade
          ctx.beginPath()
          ctx.moveTo(f.x, baseY)
          ctx.lineTo(f.x + sway, topY)
          ctx.stroke()
          px(f.x + sway - 1, topY - 1, 2.4, 2.4, f.c)
        }
      }

      // fireflies
      for (const fl of fireflies) {
        fl.x += Math.sin(t * 0.02 + fl.ph) * 0.2
        fl.y += Math.cos(t * 0.017 + fl.ph) * 0.15
        const a = 0.35 + 0.65 * Math.abs(Math.sin(t * 0.05 + fl.ph))
        ctx.globalAlpha = a
        ctx.fillStyle = pal.firefly
        ctx.beginPath()
        ctx.arc(fl.x, fl.y, fl.r, 0, Math.PI * 2)
        ctx.fill()
        ctx.globalAlpha = a * 0.3
        ctx.beginPath()
        ctx.arc(fl.x, fl.y, fl.r * 3, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1

      // Frost source: blit the just-rendered low-res buffer into BackdropFrost's
      // canvas so it can CSS-blur a copy of THIS wallpaper. One drawImage of an
      // already-drawn bitmap — negligible vs the full scene draw above — and only
      // when a frost canvas is registered (video mode registers none -> zero cost).
      if (frostCanvas && frostCtx) {
        frostCtx.drawImage(canvas, 0, 0, frostCanvas.width, frostCanvas.height)
      }
    }

    // rAF tick: throttles to FRAME_MS and only renders while running.
    function tick(now: number): void {
      if (!running) return
      raf = requestAnimationFrame(tick)
      if (now - lastDraw < FRAME_MS) return
      lastDraw = now
      render()
    }

    function start(): void {
      if (running) return
      running = true
      lastDraw = 0
      raf = requestAnimationFrame(tick)
    }

    function stop(): void {
      running = false
      if (raf) {
        cancelAnimationFrame(raf)
        raf = 0
      }
    }

    // Pause the loop entirely when the window/tab is hidden or occluded so we
    // don't run a full-scene redraw forever in the background; resume on show.
    const onVisibility = (): void => {
      if (document.hidden) stop()
      else start()
    }

    // Expose THIS scene canvas as the shared in-world frost source (NodeFrost
    // reads it live). Mark the wallpaper kind as 'canvas' while this is mounted.
    setFrostSourceCanvas(canvas)
    setFrostKind('canvas')

    build()
    if (!document.hidden) start()

    const onResize = (): void => build()
    window.addEventListener('resize', onResize)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      window.removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', onVisibility)
      setFrostSourceCanvas(null)
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
        imageRendering: 'pixelated',
        zIndex: 0
      }}
    />
  )
}

type BgItem = { id: string; name: string; hasBoom: boolean }

// Read the current video selection from localStorage. Returns null when no
// video background is selected (i.e. the animated pixel-art themes are active).
function readSelection(): { id: string; mode: 'normal' | 'boom' } | null {
  const id = (localStorage.getItem('canvasio:bg') || '').trim()
  if (!id) return null
  const mode = localStorage.getItem('canvasio:bgmode') === 'boom' ? 'boom' : 'normal'
  return { id, mode }
}

/**
 * Full-viewport looping video background served via the custom `canvasio-bg://`
 * protocol. Pauses while the document is hidden (perf) and falls back to the
 * animated pixel-art canvas if the video fails to load.
 */
function VideoBackground({
  id,
  mode,
  hasBoom,
  onError
}: {
  id: string
  mode: 'normal' | 'boom'
  hasBoom: boolean
  onError: () => void
}): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const variant = mode === 'boom' && hasBoom ? '.boom' : ''
  const src = `canvasio-bg://local/${id}${variant}.mp4`

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    // Expose this live wallpaper <video> so in-world NodeFrost can sample its
    // frame for the frosted-glass slice under each node.
    setFrostSourceVideo(video)
    // Pause/resume on visibility change so we don't decode video while the
    // window/tab is hidden or occluded.
    const onVisibility = (): void => {
      if (document.hidden) {
        video.pause()
      } else {
        void video.play().catch(() => {})
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      setFrostSourceVideo(null)
    }
  }, [])

  return (
    <video
      ref={videoRef}
      src={src}
      autoPlay
      loop
      muted
      playsInline
      onError={onError}
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        objectFit: 'cover',
        zIndex: 0
      }}
    />
  )
}

/**
 * Background switcher. Renders a looping video background when one is selected
 * (localStorage `canvasio:bg`), otherwise the existing animated pixel-art canvas.
 * Re-reads the selection on the `canvasio:bgchange` event (dispatched in-window
 * by SettingsPanel, since the native `storage` event does not fire same-window).
 */
export function Background(): JSX.Element {
  const [selection, setSelection] = useState<{ id: string; mode: 'normal' | 'boom' } | null>(() =>
    readSelection()
  )
  const [items, setItems] = useState<BgItem[]>([])
  // When a video fails to load we fall back to the animated canvas until the
  // selection changes again.
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    const refresh = (): void => {
      setSelection(readSelection())
      setFailed(false)
    }
    window.addEventListener('canvasio:bgchange', refresh)
    // Load the available backgrounds once so we know each id's hasBoom flag.
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

  // Flip the shared frost KIND for in-world NodeFrost: video bg → 'video' (nodes
  // fall back to a translucent tint, no per-node video clone); otherwise the
  // AnimatedCanvas self-registers 'canvas' on mount. Render-effect, not in the
  // render body, so it never mutates module state during render.
  const usingVideo = !!selection && !failed
  useEffect(() => {
    if (usingVideo) setFrostKind('video')
    else setFrostKind('canvas')
  }, [usingVideo])

  if (selection && !failed) {
    const hasBoom = items.find((b) => b.id === selection.id)?.hasBoom ?? false
    return (
      <VideoBackground
        key={`${selection.id}:${selection.mode}`}
        id={selection.id}
        mode={selection.mode}
        hasBoom={hasBoom}
        onError={() => setFailed(true)}
      />
    )
  }

  return <AnimatedCanvas />
}
