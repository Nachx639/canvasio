import { useSentinel } from '../store/sentinel'
import { useCanvas, AGENT_LABEL } from '../store/canvas'
import { useT } from '../store/i18n'
import type { SentinelKind, SentinelOrder } from '../lib/sentinel'

/**
 * Sentinel Chip — the readout for spatial standing orders ("watch X for Y, then
 * fly me there").
 *
 * Every other nav primitive in CanvasIO is reactive — it points you at things
 * that ALREADY happened (Thermal=hottest, PulseRadar=current off-screen status,
 * Backlog/Catch-Up=unread, Vigil=auto-follow the hottest). Sentinel is the
 * missing forward-looking one: arm a standing order on a node, deep-focus
 * elsewhere, and the moment the condition fires this pill pulses and (if
 * auto-fly is on) the camera flies straight there via centerOnNode.
 *
 * Renderer-ONLY and owns NO timers — the evaluation ticker lives in App.tsx
 * (subscribed to mission/lens), exactly like the Away Alerts watcher. It renders
 * NOTHING when no orders are armed (zero chrome when inactive, the project
 * convention every overlay follows). When armed, it shows a small glass pill
 * listing each order with a kind glyph + agent label; a FIRED order glows and
 * offers "ir" (fly there via centerOnNode — Slipstream/Wayback for free).
 * Clicking an armed row disarms it; clicking a fired "ir" flies + re-arms.
 */
const ACCENT = '#c084fc' // violet — distinct from Vigil's sky and Thermal's warm

/** Per-kind glyph + i18n key for the short label shown in the row. */
const KIND_META: Record<SentinelKind, { glyph: string; labelKey: string }> = {
  waiting: { glyph: '⏸', labelKey: 'sentinelChip.kind_waiting' },
  error: { glyph: '✕', labelKey: 'sentinelChip.kind_error' },
  done: { glyph: '✓', labelKey: 'sentinelChip.kind_done' },
  match: { glyph: '⁂', labelKey: 'sentinelChip.kind_match' }
}

function OrderRow({ order }: { order: SentinelOrder }): JSX.Element {
  const t = useT()
  // Subscribe to nodes so the label re-derives if the node title changes.
  const nodes = useCanvas((s) => s.nodes)
  const node = nodes.find((n) => n.id === order.nodeId)
  const fallback = (): string => {
    const n = useCanvas.getState().nodes.find((x) => x.id === order.nodeId)
    if (!n) return t('sentinelChip.agent_fallback')
    return n.title || (n.agent ? AGENT_LABEL[n.agent].title : t('sentinelChip.agent_fallback'))
  }
  const label = node
    ? node.title || (node.agent ? AGENT_LABEL[node.agent].title : t('sentinelChip.agent_fallback'))
    : fallback()
  const meta = KIND_META[order.kind]
  const metaLabel = t(meta.labelKey)
  const fired = order.firedTs !== null

  const fly = (e: React.MouseEvent): void => {
    e.stopPropagation()
    // Funnel through centerOnNode so Slipstream/Wayback history + select + raise
    // all happen for free. Re-arm so the same condition can wake us again later.
    useCanvas.getState().centerOnNode(order.nodeId)
    useSentinel.getState().rearm(order.id)
  }
  const disarm = (e: React.MouseEvent): void => {
    e.stopPropagation()
    useSentinel.getState().disarm(order.id)
  }

  const title =
    order.kind === 'match'
      ? t('sentinelChip.match_title', { pattern: order.pattern || '' })
      : metaLabel

  return (
    <span
      role="listitem"
      style={{
        pointerEvents: 'auto',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 8px',
        borderRadius: 8,
        fontSize: 11,
        color: fired ? '#fff' : '#e8d8ff',
        background: fired ? `${ACCENT}33` : 'rgba(192,132,252,0.10)',
        border: `1px solid ${ACCENT}${fired ? 'aa' : '44'}`,
        animation: fired ? 'canvasio-sentinel-pulse 1.4s ease-out infinite' : undefined
      }}
    >
      <span aria-hidden style={{ fontWeight: 800, color: ACCENT }}>
        {meta.glyph}
      </span>
      <span style={{ fontWeight: 800, color: fired ? ACCENT : '#cbb6e8' }}>{label}</span>
      <span style={{ color: '#9a86b8', fontSize: 10.5 }} title={title}>
        {order.kind === 'match' ? `/${order.pattern || ''}/` : metaLabel}
      </span>
      {fired ? (
        <button
          className="no-drag"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={fly}
          title={t('sentinelChip.fired_title', { label })}
          aria-label={t('sentinelChip.fired_aria', { label })}
          style={{
            pointerEvents: 'auto',
            cursor: 'pointer',
            border: `1px solid ${ACCENT}`,
            background: ACCENT,
            color: '#1a0b2e',
            fontWeight: 800,
            fontSize: 10.5,
            borderRadius: 6,
            padding: '1px 7px'
          }}
        >
          {t('sentinelChip.go')}
        </button>
      ) : (
        <button
          className="no-drag"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={disarm}
          title={t('sentinelChip.disarm', { label })}
          aria-label={t('sentinelChip.disarm', { label })}
          style={{
            pointerEvents: 'auto',
            cursor: 'pointer',
            border: 'none',
            background: 'transparent',
            color: '#9a86b8',
            fontSize: 12,
            lineHeight: 1,
            padding: '0 2px'
          }}
        >
          ×
        </button>
      )}
    </span>
  )
}

export function SentinelChip(): JSX.Element | null {
  const t = useT()
  const orders = useSentinel((s) => s.orders)

  // Zero chrome when nothing is armed (the convention every overlay follows).
  if (orders.length === 0) return null

  const anyFired = orders.some((o) => o.firedTs !== null)

  return (
    <div
      className="no-drag"
      role="list"
      aria-live="polite"
      aria-label={t('sentinelChip.container_aria')}
      style={{
        pointerEvents: 'none',
        position: 'absolute',
        bottom: 184,
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        justifyContent: 'center',
        zIndex: 60
      }}
    >
      <div
        className="glass no-drag"
        style={{
          pointerEvents: 'auto',
          borderRadius: 12,
          padding: '6px 10px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          flexWrap: 'wrap',
          maxWidth: 560,
          color: '#eaf6ff',
          border: `1px solid ${ACCENT}${anyFired ? '88' : '55'}`
        }}
      >
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: ACCENT,
            animation: anyFired ? 'canvasio-sentinel-pulse 1.4s ease-out infinite' : undefined,
            flex: '0 0 auto'
          }}
        />
        <span
          style={{ fontSize: 11.5, fontWeight: 700, color: '#cbb6e8', letterSpacing: '0.02em', flex: '0 0 auto' }}
        >
          Sentinel
        </span>
        {orders.map((o) => (
          <OrderRow key={o.id} order={o} />
        ))}
        <button
          className="no-drag"
          onClick={() => useSentinel.getState().reset()}
          title={t('sentinelChip.clear_all')}
          aria-label={t('sentinelChip.clear_all')}
          style={{
            pointerEvents: 'auto',
            cursor: 'pointer',
            border: '1px solid rgba(255,255,255,0.12)',
            background: 'transparent',
            color: '#9a86b8',
            fontSize: 10.5,
            borderRadius: 6,
            padding: '2px 7px',
            flex: '0 0 auto'
          }}
        >
          {t('sentinelChip.clear')}
        </button>
        <style>{`
          @keyframes canvasio-sentinel-pulse {
            0%   { box-shadow: 0 0 0 0 ${ACCENT}66; }
            70%  { box-shadow: 0 0 0 7px ${ACCENT}00; }
            100% { box-shadow: 0 0 0 0 ${ACCENT}00; }
          }
        `}</style>
      </div>
    </div>
  )
}
