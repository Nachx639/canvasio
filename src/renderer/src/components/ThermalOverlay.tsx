import { useEffect, useMemo, useState } from 'react'
import { useCanvas } from '../store/canvas'
import { useMission } from '../store/mission'
import { computeHeat } from '../lib/thermal'
import { STATUS_COLOR } from './NodeView'

// Thermal — Activity Heat overlay.
//
// A renderer-only "thermal vision" for the canvas (mirrors PulseRadar's pattern).
// When the Thermal flag is on, it bathes each agent window in a heat glow scaled
// by how active it has been recently: busy = warm orange, erroring = red-hot,
// quiet = cool/transparent. Heat is read from the existing Mission Pulse timeline
// via the pure computeHeat() helper. Because heat decays with wall-clock time, the
// overlay recomputes on a ~1s interval even when no new event arrives.
//
// CONTRACT: purely additive, renderer-only. It READS the canvas + mission stores
// and computes heat — it never mutates node/shape geometry, never touches
// IPC/main, adds no persistence. It renders NOTHING (zero chrome) when the flag
// is off OR there is no heat anywhere, so a calm canvas stays clean.

// CHROME insets kept in sync with canvas.ts so heat never bleeds under the chrome.
const CHROME = { top: 64, bottom: 116, left: 78, right: 190 }

// Shared empty results returned when the overlay is off, so the heat/errorId
// memos skip all work (computeHeat's per-event Math.pow loop + the error fold)
// while the flag is down — they're only consumed by `glows`, which itself
// returns [] when !thermalOn.
const EMPTY_HEAT = new Map<string, number>()
const EMPTY_ERROR_IDS = new Set<string>()

/** Map a status to its glow color; error always wins (red-hot). */
function heatColor(status: string | undefined, isError: boolean): string {
  if (isError) return STATUS_COLOR.error
  if (status === 'error') return STATUS_COLOR.error
  if (status === 'done') return STATUS_COLOR.done
  // Default warm orange for "active" — matches the working accent.
  return STATUS_COLOR.working
}

export function ThermalOverlay(): JSX.Element | null {
  const thermalOn = useCanvas((s) => s.thermalOn)
  const nodes = useCanvas((s) => s.nodes)
  const camera = useCanvas((s) => s.camera)
  const events = useMission((s) => s.events)

  // A self-advancing clock so the time-decayed heat re-evaluates even with no new
  // mission events. Only ticks while the overlay is on (no idle work when off).
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!thermalOn) return
    setNow(Date.now())
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [thermalOn])

  const [viewport, setViewport] = useState({
    width: window.innerWidth,
    height: window.innerHeight
  })
  useEffect(() => {
    const onResize = (): void =>
      setViewport({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Heat per node from the (pure) timeline scorer; recomputed when events change
  // or the 1s clock advances (decay) — never reads/writes any store imperatively.
  // Skip the per-event scan entirely while the overlay is off — both results are
  // only consumed by `glows`, which returns [] when !thermalOn, so the work is
  // pure waste on a calm/default canvas where mission events still fire often.
  const heat = useMemo(
    () => (thermalOn ? computeHeat(events, now) : EMPTY_HEAT),
    [thermalOn, events, now]
  )

  // The most-recent in-window event being an error pins a node red-hot; surface
  // that here too so the glow color matches (computeHeat already pins the value).
  const errorIds = useMemo(() => {
    if (!thermalOn) return EMPTY_ERROR_IDS
    const last = new Map<string, { ts: number; kind: string }>()
    for (const e of events) {
      const prev = last.get(e.nodeId)
      if (!prev || e.ts >= prev.ts) last.set(e.nodeId, { ts: e.ts, kind: e.kind })
    }
    const out = new Set<string>()
    last.forEach((v, id) => {
      if (v.kind === 'error') out.add(id)
    })
    return out
  }, [thermalOn, events])

  const glows = useMemo(() => {
    if (!thermalOn) return []
    const { width: vw, height: vh } = viewport
    const z = camera.zoom
    const left = CHROME.left
    const right = vw - CHROME.right
    const top = CHROME.top
    const bottom = vh - CHROME.bottom
    const out: {
      id: string
      x: number
      y: number
      w: number
      h: number
      color: string
      heat: number
    }[] = []
    for (const n of nodes) {
      const h = heat.get(n.id) ?? 0
      if (h <= 0) continue
      // Node rect in SCREEN space (same transform NodeView/PulseRadar use).
      const sx = n.x * z + camera.x
      const sy = n.y * z + camera.y
      const sw = n.w * z
      const sh = n.h * z
      // Cull glows fully outside the usable viewport (Pulse Radar covers those).
      if (sx + sw < left || sx > right || sy + sh < top || sy > bottom) continue
      out.push({
        id: n.id,
        x: sx,
        y: sy,
        w: sw,
        h: sh,
        color: heatColor(n.status, errorIds.has(n.id)),
        heat: h
      })
    }
    return out
  }, [thermalOn, nodes, camera.x, camera.y, camera.zoom, heat, errorIds, viewport])

  // Zero chrome when off or when nothing is hot.
  if (!thermalOn || glows.length === 0) return null

  return (
    <div
      className="thermal-overlay"
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 35,
        pointerEvents: 'none',
        overflow: 'hidden'
      }}
    >
      {glows.map((g) => {
        // Pad the glow beyond the node rect so it reads as a soft halo, scaled by
        // heat. Opacity also scales with heat (cool nodes barely glow).
        const pad = 28 + g.heat * 70
        const opacity = 0.18 + g.heat * 0.5
        return (
          <div
            key={g.id}
            style={{
              position: 'absolute',
              left: g.x - pad,
              top: g.y - pad,
              width: g.w + pad * 2,
              height: g.h + pad * 2,
              borderRadius: 24,
              opacity,
              background: `radial-gradient(ellipse at center, ${g.color} 0%, ${g.color}66 38%, transparent 72%)`,
              mixBlendMode: 'screen',
              filter: `blur(${6 + g.heat * 10}px)`,
              transition: 'opacity 600ms ease-out'
            }}
          />
        )
      })}
    </div>
  )
}
