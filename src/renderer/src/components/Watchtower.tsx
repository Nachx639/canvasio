import { useCanvas, AGENT_LABEL, type AgentKind } from '../store/canvas'
import { useLens } from '../store/lens'
import { useMission } from '../store/mission'
import { useT } from '../store/i18n'
import { STATUS_COLOR } from './NodeView'

/**
 * Watchtower — a pinned live-watch panel (bottom-right, above the Minimap). It is
 * the first genuinely MULTI-focus surface in an otherwise all-single-focus nav
 * suite: pin up to MAX_WATCH distant nodes and keep an eye on them WITHOUT moving
 * the camera and WITHOUT a second xterm.
 *
 * Each tile reuses exactly what the semantic-zoom GlanceCard already shows — a
 * status dot (STATUS_COLOR), the title + agent glyph, and the single most-recent
 * meaningful Lens line (`useLens.lines[id]`, ANSI-stripped at the existing
 * chokepoint) — updating live. A tile that flips to error / waiting pulses
 * (.watch-alert) to grab your eye; clicking the tile body funnels through
 * centerOnNode (so Slipstream history, Wayback visit-tracking, and Director all
 * keep working for free).
 *
 * Renderer-only and additive: it READS the canvas/lens/mission stores and CALLS
 * centerOnNode / unpinWatch — no IPC, no geometry mutation, no persistence. It
 * returns null when nothing is pinned, so it adds zero chrome (and zero cost) on
 * an idle / unused canvas.
 */
const AGENT_GLYPH: Record<AgentKind, string> = {
  claude: 'C',
  codex: 'X',
  cursor: '▸',
  shell: '$'
}

export function Watchtower(): JSX.Element | null {
  const t = useT()
  const watchIds = useCanvas((s) => s.watchIds)

  // Hidden entirely until at least one node is pinned (no chrome cost when unused).
  if (watchIds.length === 0) return null

  return (
    <div className="watchtower glass no-drag" role="region" aria-label={t('watchtower.region_aria')}>
      <div className="watch-head" aria-hidden>
        {t('watchtower.heading')}
      </div>
      {watchIds.map((id) => (
        <WatchTile key={id} id={id} />
      ))}
    </div>
  )
}

/**
 * A single watch tile. Subscribes NARROWLY (per-id selectors) so it only
 * re-renders when ITS OWN node data / Lens line / latest mission event changes,
 * preserving the O(1)-per-change model NodeView uses throughout.
 */
function WatchTile({ id }: { id: string }): JSX.Element | null {
  const t = useT()
  // Per-id node snapshot — re-renders only when this node's relevant fields change.
  const node = useCanvas((s) => s.nodes.find((n) => n.id === id) ?? null)
  // Live "what it's doing now" line (same feed the GlanceCard reads).
  const line = useLens((s) => s.lines[id])
  // Latest mission event kind for this node — the "te necesita" (waiting) /
  // error signal isn't on node.status (idle|working|done|error), so we derive the
  // waiting alert from the timeline, the SAME fold attentionQueue/PulseRadar use.
  const lastKind = useMission((s) => {
    let ts = -1
    let kind: string | undefined
    for (const e of s.events) {
      if (e.nodeId === id && e.ts >= ts) {
        ts = e.ts
        kind = e.kind
      }
    }
    return kind
  })

  // Defensive: if the node was pruned between renders, render nothing (the store
  // also prunes watchIds in removeNode, so this is belt-and-suspenders).
  if (!node) return null

  const status = node.status ?? 'idle'
  const statusColor = STATUS_COLOR[status]
  const glyph = node.agent ? AGENT_GLYPH[node.agent] : '·'
  const agentLabel = node.agent ? AGENT_LABEL[node.agent].title : t('watchtower.node_fallback')
  const alert = status === 'error' || lastKind === 'error' || lastKind === 'waiting'

  return (
    <div
      className={'watch-tile' + (alert ? ' watch-alert' : '')}
      role="button"
      tabIndex={0}
      title={t('watchtower.tile_title', { title: node.title })}
      aria-label={t('watchtower.tile_aria', { title: node.title })}
      onClick={() => useCanvas.getState().centerOnNode(id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          useCanvas.getState().centerOnNode(id)
        }
      }}
    >
      <span
        className="watch-dot"
        style={{ background: statusColor, boxShadow: `0 0 8px ${statusColor}` }}
        aria-hidden
      />
      <div className="watch-body">
        <div className="watch-title">
          <span className="watch-glyph" aria-hidden>
            {glyph}
          </span>
          <span className="watch-name">{node.title}</span>
          <span className="watch-agent">{agentLabel}</span>
        </div>
        <div className="watch-line" title={line?.text}>
          {line?.text || t('watchtower.waiting_output')}
        </div>
      </div>
      <button
        type="button"
        className="watch-unpin"
        title={t('watchtower.unpin')}
        aria-label={t('watchtower.unpin_aria', { title: node.title })}
        onClick={(e) => {
          e.stopPropagation()
          useCanvas.getState().unpinWatch(id)
        }}
      >
        ×
      </button>
    </div>
  )
}
