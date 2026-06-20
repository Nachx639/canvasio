import { useMemo } from 'react'
import { useCanvas, attentionQueue } from '../store/canvas'
import { useMission } from '../store/mission'
import { useReplay } from '../store/replay'
import { useDirector } from '../store/director'
import { useT } from '../store/i18n'

/**
 * Triage Chip — Triage Jump's live HUD count (top-center).
 *
 * A tiny glass pill showing how many agents currently need you ("N te
 * necesitan" / "Todo al día"), colored red when any are in error and cyan
 * otherwise. Clicking it jumps the camera to the next agent in priority order
 * via the existing cycleAttention('next') store action — the same march the
 * J hotkey drives. As you service each agent and it leaves the waiting/error/done
 * state, the queue shrinks until the chip reads "Todo al día".
 *
 * Purely renderer-side and additive: it READS the mission + canvas stores
 * (reusing the shared attentionQueue derivation) and CALLS cycleAttention — no
 * IPC, no geometry mutation, no persistence. Hidden while an auto-driven camera
 * (replay/director) owns the view so it never fights them, matching PulseRadar.
 */
const WAITING_COLOR = '#5ad1e8'
const ERROR_COLOR = '#ff6b6b'

export function TriageChip(): JSX.Element | null {
  const t = useT()
  const nodes = useCanvas((s) => s.nodes)
  const events = useMission((s) => s.events)
  const replayArmed = useReplay((s) => s.armed)
  const directorArmed = useDirector((s) => s.armed)

  // The priority-ordered attention queue (shared derivation with cycleAttention).
  const queue = useMemo(() => attentionQueue(nodes, events, Date.now()), [nodes, events])

  // Whether the head of the queue is an error node (drives the accent color).
  const hasError = useMemo(() => {
    if (!queue.length) return false
    // attentionQueue sorts error (tier 0) first, so an error present means the
    // head is an error. Recompute the flag cheaply for the first id.
    const head = nodes.find((n) => n.id === queue[0])
    if (head?.status === 'error') return true
    // Else check the latest event kind for the head node.
    let last: { ts: number; kind: string } | null = null
    for (const e of events) {
      if (e.nodeId !== queue[0]) continue
      if (!last || e.ts >= last.ts) last = { ts: e.ts, kind: e.kind }
    }
    return last?.kind === 'error'
  }, [queue, nodes, events])

  // Hidden while an auto-driven camera owns the view (mirrors PulseRadar).
  if (replayArmed || directorArmed) return null

  const count = queue.length
  const clear = count === 0
  const accent = hasError ? ERROR_COLOR : WAITING_COLOR
  const label = clear
    ? t('triageChip.all_clear')
    : count === 1
      ? t('triageChip.one_needs_you')
      : t('triageChip.many_need_you', { count })

  return (
    <button
      className="no-drag"
      onClick={() => useCanvas.getState().cycleAttention('next')}
      title={clear ? t('triageChip.title_clear') : t('triageChip.title_next')}
      aria-label={
        clear
          ? t('triageChip.aria_clear')
          : t('triageChip.aria_count', { count })
      }
      style={{
        // Inline chip living at the RIGHT of the TopBar pill (rendered inside it),
        // so it never overlaps the centered controls like the old top-center HUD did.
        pointerEvents: 'auto',
        flex: '0 0 auto',
        borderRadius: 8,
        padding: '4px 9px',
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        color: '#d7e1f7',
        cursor: clear ? 'default' : 'pointer',
        background: clear ? 'rgba(120,140,170,0.10)' : `${accent}1f`,
        opacity: clear ? 0.55 : 1,
        border: `1px solid ${clear ? 'rgba(120,140,170,0.22)' : `${accent}55`}`
      }}
    >
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: clear ? '#48d597' : accent,
          boxShadow: clear ? 'none' : `0 0 0 0 ${accent}`,
          animation: clear ? undefined : 'canvasio-triage-pulse 1.6s ease-out infinite'
        }}
      />
      <span style={{ fontWeight: 700, color: clear ? '#9fb0c9' : accent, fontSize: 12.5 }}>
        {label}
      </span>
      {!clear && (
        <span
          aria-hidden
          style={{ fontSize: 11, fontWeight: 800, color: '#9fb0c9', letterSpacing: '0.04em' }}
        >
          J
        </span>
      )}
      <style>{`
        @keyframes canvasio-triage-pulse {
          0%   { box-shadow: 0 0 0 0 ${accent}66; }
          70%  { box-shadow: 0 0 0 7px ${accent}00; }
          100% { box-shadow: 0 0 0 0 ${accent}00; }
        }
      `}</style>
    </button>
  )
}
