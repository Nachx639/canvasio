import { useSentinel } from '../store/sentinel'
import { useShallow } from 'zustand/react/shallow'
import type { SentinelKind } from '../lib/sentinel'
import { promptText } from '../store/promptModal'
import { useT } from '../store/i18n'

/**
 * Sentinel pip — the per-node header affordance to arm/disarm a forward-looking
 * standing order on THIS agent ("wake me when it goes waiting / errors / finishes
 * / prints a regex match"). It is the node-side companion to the bottom-stack
 * SentinelChip and the Command Palette entries, reusing the muscle memory of the
 * other node-header chrome (CatchUpPip / BacklogChip).
 *
 * A bell glyph that lights when this node has any armed order. Click cycles the
 * common status triggers (none -> waiting -> error -> done -> off); a long-press /
 * right-click prompts for a regex 'match' order. Arming captures the arm-time
 * baseline in the store so an already-true condition doesn't instantly fire.
 *
 * Pure renderer-side: READS the live orders + CALLS the store's arm/disarm — no
 * new state, no IPC, no geometry mutation. Subscribes to this node's orders only,
 * renders the same whether armed or not (it is an affordance, not an alert — the
 * SentinelChip owns the alert surface), and is hidden at low zoom (`hidden`) like
 * the rest of the node chrome.
 */
const STATUS_CYCLE: SentinelKind[] = ['waiting', 'error', 'done']
const GLYPH: Record<SentinelKind, string> = {
  waiting: '⏸',
  error: '✕',
  done: '✓',
  match: '⁂'
}
const LABEL_KEY: Record<SentinelKind, string> = {
  waiting: 'sentinelPip.label_waiting',
  error: 'sentinelPip.label_error',
  done: 'sentinelPip.label_done',
  match: 'sentinelPip.label_match'
}

export function SentinelPip({
  nodeId,
  hidden
}: {
  nodeId: string
  hidden?: boolean
}): JSX.Element | null {
  // Subscribe to THIS node's orders only, so the pip re-renders just when its own
  // arming changes (not on every other node's order churn).
  const orders = useSentinel(useShallow((s) => s.orders.filter((o) => o.nodeId === nodeId)))
  const t = useT()

  if (hidden) return null

  const armed = orders.length > 0
  const kinds = orders.map((o) => o.kind)

  // Click cycles the status triggers: arm the next status kind this node doesn't
  // already have; if it already has the whole status cycle armed, disarm them all.
  const onClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
    const s = useSentinel.getState()
    const next = STATUS_CYCLE.find((k) => !kinds.includes(k))
    if (next) s.arm(nodeId, next)
    else s.disarmNode(nodeId) // all status kinds armed -> clear everything on this node
  }

  // Right-click / context menu prompts for a regex 'match' order.
  const onContext = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    void (async () => {
      const pattern = await promptText(t('sentinelPip.prompt_regex'), '')
      if (pattern && pattern.trim()) {
        useSentinel.getState().arm(nodeId, 'match', pattern.trim())
      }
    })()
  }

  const armedSummary = armed
    ? t('sentinelPip.watching', {
        triggers: orders
          .map((o) =>
            o.kind === 'match'
              ? t('sentinelPip.match_pattern', { pattern: o.pattern || '' })
              : t(LABEL_KEY[o.kind])
          )
          .join('; ')
      })
    : t('sentinelPip.arm_hint')

  return (
    <span
      role="button"
      tabIndex={0}
      title={t('sentinelPip.title', { summary: armedSummary })}
      aria-label={
        armed
          ? t('sentinelPip.aria_armed', { summary: armedSummary })
          : t('sentinelPip.aria_arm')
      }
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onClick}
      onContextMenu={onContext}
      style={{
        marginLeft: 2,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        fontSize: 10.5,
        lineHeight: 1,
        padding: '2px 6px',
        borderRadius: 6,
        cursor: 'pointer',
        color: armed ? '#e8d8ff' : '#9a86b8',
        background: armed ? 'rgba(192,132,252,0.16)' : 'transparent',
        border: `1px solid ${armed ? 'rgba(192,132,252,0.5)' : 'rgba(255,255,255,0.12)'}`,
        flex: '0 0 auto',
        userSelect: 'none'
      }}
    >
      <span aria-hidden style={{ fontWeight: 700 }}>
        {'☉' /* sun/sentinel glyph */}
      </span>
      {armed && (
        <span aria-hidden style={{ fontWeight: 700, letterSpacing: '-0.04em' }}>
          {kinds.map((k) => GLYPH[k]).join('')}
        </span>
      )}
    </span>
  )
}
