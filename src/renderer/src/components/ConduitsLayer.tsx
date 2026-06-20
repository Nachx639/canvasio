import { memo, useMemo } from 'react'
import { useCanvas, type AgentKind } from '../store/canvas'
import { useRelay } from '../store/relay'
import { computeConduits, conduitPath, arrowHead, type ConduitNode } from '../lib/conduits'

/**
 * Relay Conduits — the handoff graph, drawn in world space. Mounted as the FIRST
 * child inside `.canvas-world` (before RegionsLayer), so it paints furthest back,
 * BEHIND drawings and nodes, in the SAME translate+scale transform already on
 * canvas-world — zero new coordinate math (world px == node px here, exactly like
 * RegionsLayer).
 *
 * Pointer discipline (mirrors RegionsLayer-as-first-child): the whole <svg> is
 * pointer-events:none so it NEVER intercepts node/terminal/shape clicks.
 *
 * Zero chrome until used: when there are no relay rules OR the user has toggled
 * conduits off, it early-returns null (no SVG, no cost), matching the universal
 * project convention (RegionsLayer/WaypointRail/JumpHints early-return on empty).
 *
 * Each rule with both endpoints present becomes a faint, curved, arrow-headed
 * bezier from the source node's border to the target's border, color-coded by the
 * source agent kind. When a handoff actually fires (relay.lastFired), a single
 * baton dot animates once along that edge via SVG <animateMotion> — you watch the
 * work travel across the canvas.
 */

/** Edge color by source agent kind — reuses NodeView/MissionLog's AGENT_COLOR. */
const AGENT_COLOR: Record<AgentKind, string> = {
  claude: '#d97757',
  codex: '#10a37f',
  cursor: '#7aa2ff',
  shell: '#9aa7c7'
}
const NEUTRAL = '#7c97e0'

function colorFor(kind?: AgentKind): string {
  return kind ? AGENT_COLOR[kind] : NEUTRAL
}

function ConduitsLayerImpl(): JSX.Element | null {
  const nodes = useCanvas((s) => s.nodes)
  const rules = useRelay((s) => s.rules)
  const lastFired = useRelay((s) => s.lastFired)
  const conduitsOn = useCanvas((s) => s.conduitsOn)

  // Zero chrome / zero cost when disabled or there is nothing to draw.
  const enabled = conduitsOn && rules.length > 0

  // Recompute the geometry only when nodes (positions) or rules change. The fire
  // pulse (lastFired) does NOT enter here — it only drives which edge animates.
  const conduits = useMemo(() => {
    if (!enabled) return []
    const boxes: ConduitNode[] = nodes.map((n) => ({
      id: n.id,
      x: n.x,
      y: n.y,
      w: n.w,
      h: n.h,
      agent: n.agent
    }))
    return computeConduits(boxes, rules)
  }, [enabled, nodes, rules])

  if (!enabled || conduits.length === 0) return null

  // The edge id whose baton should currently animate (the most recent fire). The
  // `at` timestamp is folded into the React key so a repeat fire of the same pair
  // remounts the <circle>, retriggering the one-shot animation.
  const firedId = lastFired ? `${lastFired.sourceId}->${lastFired.targetId}` : null
  const firedKey = lastFired ? `${firedId}:${lastFired.at}` : null

  return (
    <svg
      className="conduits-layer"
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        // The world is unbounded; a generous fixed canvas with `overflow: visible`
        // lets paths extend past these bounds (we never clip). pointer-events:none
        // so node/terminal/shape clicks always win (RegionsLayer pointer discipline).
        width: 1,
        height: 1,
        overflow: 'visible',
        pointerEvents: 'none',
        zIndex: 0
      }}
    >
      {conduits.map((c) => {
        const stroke = colorFor(c.kind)
        const path = conduitPath(c)
        const isFired = c.id === firedId
        return (
          <g key={c.id}>
            <path
              d={path}
              fill="none"
              stroke={stroke}
              strokeOpacity={0.32}
              strokeWidth={2}
              strokeLinecap="round"
            />
            <polygon points={arrowHead(c)} fill={stroke} fillOpacity={0.5} />
            {isFired && firedKey && (
              // One-shot baton: a bright dot riding the wire source -> target once.
              // Keyed by `${id}:${at}` so each fire remounts -> the SMIL animation
              // (which runs once, fill="freeze") replays. Self-clearing visually:
              // after the run the dot rests at the target (opacity fades via the
              // second animate). No timers, no state — pure declarative SVG.
              <circle key={firedKey} r={5} fill={stroke}>
                <animateMotion dur="0.9s" path={path} fill="freeze" />
                <animate
                  attributeName="opacity"
                  values="0;1;1;0"
                  keyTimes="0;0.1;0.85;1"
                  dur="0.9s"
                  fill="freeze"
                />
              </circle>
            )}
          </g>
        )
      })}
    </svg>
  )
}

export const ConduitsLayer = memo(ConduitsLayerImpl)
