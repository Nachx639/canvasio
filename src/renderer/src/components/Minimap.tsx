import { useEffect, useMemo, useState } from 'react'
import { useCanvas, type AgentKind } from '../store/canvas'
import { useMission } from '../store/mission'
import { useRegions } from '../store/regions'
import { useRelay } from '../store/relay'
import { computeHeat } from '../lib/thermal'
import { computeConduits, type ConduitNode } from '../lib/conduits'
import { useT } from '../store/i18n'

// Relay Conduits — edge color by source agent kind (matches the in-world layer +
// NodeView/MissionLog AGENT_COLOR), so the minimap topology reads the same hue.
const CONDUIT_COLOR: Record<AgentKind, string> = {
  claude: '#d97757',
  codex: '#10a37f',
  cursor: '#7aa2ff',
  shell: '#9aa7c7'
}

export function Minimap(): JSX.Element {
  const t = useT()
  const nodes = useCanvas((s) => s.nodes)
  const camera = useCanvas((s) => s.camera)
  // Thermal — the persistent corner map doubles as a heat radar: paint a soft
  // dot per node from the SAME pure computeHeat() the overlay uses. Always on
  // (independent of the full-screen thermalOn flag) so the minimap is a quiet,
  // always-available heat reference. Recomputes on a 1s clock so time-decay shows.
  const events = useMission((s) => s.events)
  // Districts — paint each spatial region as a soft tinted rect so the whole map
  // reads as a labeled territory at a glance. Read-only + additive (behind the
  // node dots), using the SAME world->minimap scale already computing the dots.
  const regions = useRegions((s) => s.regions)
  // Relay Conduits — mirror the handoff graph as faint edges behind the node dots,
  // turning the corner map from a node radar into a true topology radar. Uses the
  // SAME world->minimap scale already computing the dots. Gated on conduitsOn (the
  // same renderer-only flag as the in-world layer) so the toggle dims both at once.
  const relayRules = useRelay((s) => s.rules)
  const conduitsOn = useCanvas((s) => s.conduitsOn)
  const [heatNow, setHeatNow] = useState(() => Date.now())
  // Only run the 1 Hz heat-decay clock when there is activity to decay. With no
  // mission events, computeHeat() is always empty and heatDots renders null, so
  // ticking would force a pointless per-second re-render + recompute forever on
  // an idle canvas. Gate on events.length (mirrors ThermalOverlay's `if (!active)
  // return`) to remove the always-on idle work while preserving live decay.
  const hasEvents = events.length > 0
  useEffect(() => {
    if (!hasEvents) return
    const id = window.setInterval(() => setHeatNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [hasEvents])
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

  // Slipstream — record the prior view so minimap recenters participate in
  // Back/Forward history (setCameraTracked = pushCameraHistory + setCamera).
  const setCameraTracked = useCanvas((s) => s.setCameraTracked)
  const setAutoFit = useCanvas((s) => s.setAutoFit)

  const W = 150
  const H = 96

  // compute world bounds (depends only on nodes; W/H are constants)
  const { minX, minY, scale } = useMemo(() => {
    let minX = 0
    let minY = 0
    let maxX = 1200
    let maxY = 800
    for (const n of nodes) {
      minX = Math.min(minX, n.x)
      minY = Math.min(minY, n.y)
      maxX = Math.max(maxX, n.x + n.w)
      maxY = Math.max(maxY, n.y + n.h)
    }
    const pad = 100
    minX -= pad
    minY -= pad
    maxX += pad
    maxY += pad
    const scale = Math.min(W / (maxX - minX), H / (maxY - minY))
    return { minX, minY, scale }
  }, [nodes])

  // viewport rect in world coords
  const vx = -camera.x / camera.zoom
  const vy = -camera.y / camera.zoom
  const vw = viewport.width / camera.zoom
  const vh = viewport.height / camera.zoom

  // Click/drag on the minimap recenters the camera on the picked world point,
  // keeping the current zoom level.
  // `tracked` records the prior view into Slipstream history. We only track the
  // INITIAL pointer-down (one history entry per gesture); a continuous drag then
  // uses the plain setCamera so it doesn't spam the Back stack (matching the
  // "continuous gestures shouldn't pollute history" rule for panBy/zoomAt).
  const recenterFromEvent = (e: React.PointerEvent<SVGSVGElement>, tracked: boolean): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    // minimap px -> world coords
    const worldX = mx / scale + minX
    const worldY = my / scale + minY
    setAutoFit(false)
    const next = {
      x: viewport.width / 2 - worldX * camera.zoom,
      y: viewport.height / 2 - worldY * camera.zoom
    }
    if (tracked) setCameraTracked(next)
    else useCanvas.getState().setCamera(next)
  }

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>): void => {
    e.currentTarget.setPointerCapture(e.pointerId)
    recenterFromEvent(e, true)
  }
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>): void => {
    if (e.buttons === 0) return
    recenterFromEvent(e, false)
  }

  // Districts — soft tinted rects, one per region, behind the node dots. Pure SVG
  // with pointerEvents none so the minimap click/drag is unchanged.
  const regionRects = useMemo(
    () =>
      regions.map((r) => (
        <rect
          key={`district:${r.id}`}
          x={(r.x - minX) * scale}
          y={(r.y - minY) * scale}
          width={Math.max(2, r.w * scale)}
          height={Math.max(2, r.h * scale)}
          rx={2}
          fill={r.color}
          opacity={0.14}
          stroke={r.color}
          strokeOpacity={0.4}
          strokeWidth={0.75}
          style={{ pointerEvents: 'none' }}
        />
      )),
    [regions, minX, minY, scale]
  )

  // Relay Conduits — faint straight edges (source center -> target center) for the
  // current relay graph, behind the node dots. Reuses the PURE computeConduits()
  // the in-world layer uses (border anchors), then maps world coords through the
  // same (x-minX)*scale transform as the dots. pointerEvents none keeps the
  // minimap click/drag unchanged. Renders null when off or there are no rules.
  const conduitEdges = useMemo(() => {
    if (!conduitsOn || relayRules.length === 0) return null
    const boxes: ConduitNode[] = nodes.map((n) => ({
      id: n.id,
      x: n.x,
      y: n.y,
      w: n.w,
      h: n.h,
      agent: n.agent
    }))
    const conduits = computeConduits(boxes, relayRules)
    if (conduits.length === 0) return null
    return conduits.map((c) => {
      const color = c.kind ? CONDUIT_COLOR[c.kind] : '#7c97e0'
      return (
        <line
          key={`conduit:${c.id}`}
          x1={(c.x1 - minX) * scale}
          y1={(c.y1 - minY) * scale}
          x2={(c.x2 - minX) * scale}
          y2={(c.y2 - minY) * scale}
          stroke={color}
          strokeOpacity={0.5}
          strokeWidth={0.85}
          style={{ pointerEvents: 'none' }}
        />
      )
    })
  }, [conduitsOn, relayRules, nodes, minX, minY, scale])

  // Node rectangles depend only on nodes + computed bounds, never on camera.
  const nodeRects = useMemo(
    () =>
      nodes.map((n) => {
        // Collapsed markdown/folder nodes render in-world as a small icon chip
        // (~128x52), not their stored full window w/h (kept so they can restore).
        // Mirror that here so the minimap shows an icon, not a big open window.
        const ew = n.collapsed ? 128 : n.w
        const eh = n.collapsed ? 52 : n.h
        return (
        <rect
          key={n.id}
          x={(n.x - minX) * scale}
          y={(n.y - minY) * scale}
          width={Math.max(2, ew * scale)}
          height={Math.max(2, eh * scale)}
          rx={1.5}
          fill={
            n.agent === 'claude'
              ? 'rgba(217,119,87,0.8)'
              : n.agent === 'codex'
                ? 'rgba(16,163,127,0.8)'
                : n.agent === 'cursor'
                  ? 'rgba(122,162,255,0.8)'
                  : n.kind === 'music'
                    ? 'rgba(91,140,255,0.8)'
                    : 'rgba(150,170,220,0.7)'
          }
        />
        )
      }),
    [nodes, minX, minY, scale]
  )

  // Thermal — soft heat dots, one per active node, centered on the node's minimap
  // rect. Color warm-orange -> red-hot; radius + opacity scale with heat. Purely
  // additive SVG with pointerEvents none, so minimap click/drag is unchanged.
  const heatDots = useMemo(() => {
    const heat = computeHeat(events, heatNow)
    if (heat.size === 0) return null
    return nodes.map((n) => {
      const h = heat.get(n.id) ?? 0
      if (h <= 0) return null
      const cx = (n.x - minX) * scale + (n.w * scale) / 2
      const cy = (n.y - minY) * scale + (n.h * scale) / 2
      const r = 3 + h * 7
      const color = h > 0.85 ? '#ff6b6b' : '#f2c84b'
      return (
        <circle
          key={`heat:${n.id}`}
          cx={cx}
          cy={cy}
          r={r}
          fill={color}
          opacity={0.18 + h * 0.45}
          style={{ pointerEvents: 'none' }}
        />
      )
    })
  }, [events, heatNow, nodes, minX, minY, scale])

  return (
    <div
      className="glass no-drag"
      role="navigation"
      aria-label={t('minimap.aria_label')}
      title={t('minimap.title')}
      style={{
        position: 'absolute',
        right: 16,
        bottom: 16,
        zIndex: 40,
        width: W + 12,
        height: H + 12,
        padding: 6,
        borderRadius: 12
      }}
    >
      <svg
        width={W}
        height={H}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        style={{ display: 'block', borderRadius: 7, overflow: 'hidden', cursor: 'pointer' }}
      >
        <rect x={0} y={0} width={W} height={H} fill="rgba(8,12,26,0.5)" />
        {regionRects}
        {conduitEdges}
        {nodeRects}
        {heatDots}
        <rect
          x={(vx - minX) * scale}
          y={(vy - minY) * scale}
          width={vw * scale}
          height={vh * scale}
          fill="rgba(120,160,255,0.14)"
          stroke="rgba(160,195,255,0.95)"
          strokeWidth={1.25}
          rx={2}
          style={{ pointerEvents: 'none' }}
        />
      </svg>
    </div>
  )
}
