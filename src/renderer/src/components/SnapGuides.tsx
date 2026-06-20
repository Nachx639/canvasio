import { useMemo } from 'react'
import { useCanvas } from '../store/canvas'
import { useSnap } from '../store/snap'

// Magnetic Align — Smart Snap Guides overlay.
//
// A renderer-only, screen-space SVG overlay (mirrors PulseRadar/JumpHints): while a
// window drag is actively snapping, it flashes thin cyan guide lines exactly where
// the dragged window aligned to a neighbor's edge/center. It reads the live camera
// + the transient guide segments published by NodeView (useSnap) and projects each
// world segment to screen via the SAME mapping the canvas uses (x*zoom + camera.x).
//
// CONTRACT: purely additive, renderer-only. It READS the canvas camera + the
// transient snap bus and draws — it NEVER mutates node geometry, never touches
// IPC/main, and adds NO persistence. It returns null whenever no drag is snapping,
// so a calm (or Alt-held free-placement) canvas has ZERO chrome.

const GUIDE_COLOR = '#5ad1e8' // same cyan the rest of the suite uses for "waiting"/focus
const TICK = 5 // small perpendicular end-cap length (screen px)

export function SnapGuides(): JSX.Element | null {
  const guides = useSnap((s) => s.guides)
  const camera = useCanvas((s) => s.camera)

  // Project each world-space guide to a screen-space line + end caps.
  const lines = useMemo(() => {
    const { x: cx, y: cy, zoom: z } = camera
    return guides.map((g) => {
      if (g.axis === 'v') {
        const sx = g.pos * z + cx
        const y1 = g.from * z + cy
        const y2 = g.to * z + cy
        return { key: `v${g.pos}`, x1: sx, y1, x2: sx, y2, caps: 'v' as const }
      }
      const sy = g.pos * z + cy
      const x1 = g.from * z + cx
      const x2 = g.to * z + cx
      return { key: `h${g.pos}`, x1, y1: sy, x2, y2: sy, caps: 'h' as const }
    })
  }, [guides, camera])

  if (lines.length === 0) return null

  return (
    <svg
      aria-hidden
      style={{
        position: 'fixed',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 60,
        overflow: 'visible'
      }}
    >
      {lines.map((l) => (
        <g key={l.key} stroke={GUIDE_COLOR} strokeWidth={1} shapeRendering="crispEdges">
          <line
            x1={l.x1}
            y1={l.y1}
            x2={l.x2}
            y2={l.y2}
            opacity={0.9}
            style={{ filter: `drop-shadow(0 0 3px ${GUIDE_COLOR})` }}
          />
          {/* Tiny perpendicular end caps so the alignment edge reads clearly. */}
          {l.caps === 'v' ? (
            <>
              <line x1={l.x1 - TICK} y1={l.y1} x2={l.x1 + TICK} y2={l.y1} />
              <line x1={l.x2 - TICK} y1={l.y2} x2={l.x2 + TICK} y2={l.y2} />
            </>
          ) : (
            <>
              <line x1={l.x1} y1={l.y1 - TICK} x2={l.x1} y2={l.y1 + TICK} />
              <line x1={l.x2} y1={l.y2 - TICK} x2={l.x2} y2={l.y2 + TICK} />
            </>
          )}
        </g>
      ))}
    </svg>
  )
}
