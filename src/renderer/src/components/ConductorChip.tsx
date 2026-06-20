import { useMemo } from 'react'
import { useCanvas } from '../store/canvas'
import { useMission } from '../store/mission'
import { useRelay } from '../store/relay'
import { useBoard } from '../store/board'
import { useReplay } from '../store/replay'
import { useDirector } from '../store/director'
import { useConductor } from '../store/conductor'
import { recommendationColor } from '../lib/conductor'
import { useT } from '../store/i18n'

/**
 * Conductor Chip — the single top Next-Best-Action, rendered INSIDE the TopBar
 * pill (like TriageChip) so it never overlaps the centered controls.
 *
 * Where TriageChip only ranks WHO needs you by status tier, the Conductor reasons
 * ACROSS every intelligence surface (attention tiers, critical-path centrality,
 * objective drift, consensus conflicts, relay readiness) and shows the ONE highest-
 * leverage action to take right now — "Resolver el error de Atlas", "Confirmar
 * el relevo de Iris", "Revisar a Nova". Clicking it (or the 'A' hotkey) executes
 * that action via runAction(top), which routes only through EXISTING store actions.
 *
 * Purely renderer-side and additive: it READS the canvas/mission/relay/board
 * stores (the same inputs the reasoner folds) so it re-derives whenever any signal
 * changes, and CALLS the Conductor store — no IPC, no geometry mutation, no
 * persistence. Hidden while an auto-driven camera (replay/director) owns the view
 * so it never fights them, matching TriageChip / PulseRadar.
 */
export function ConductorChip({ onOpenPanel }: { onOpenPanel?: () => void }): JSX.Element | null {
  const t = useT()
  // Subscribe to the inputs the reasoner reads so the chip re-derives live.
  const nodes = useCanvas((s) => s.nodes)
  const events = useMission((s) => s.events)
  const rules = useRelay((s) => s.rules)
  const facts = useBoard((s) => s.facts)
  const replayArmed = useReplay((s) => s.armed)
  const directorArmed = useDirector((s) => s.armed)

  // Re-derive the ranked list whenever any input changes. getRecommendations()
  // reads every store lazily; the subscriptions above are what trigger the recompute.
  const recs = useMemo(
    () => useConductor.getState().getRecommendations(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes, events, rules, facts]
  )

  // Hidden while an auto-driven camera owns the view (mirrors TriageChip).
  if (replayArmed || directorArmed) return null

  const top = recs[0]
  const idle = !top
  const accent = top ? recommendationColor(top.kind) : '#48d597'
  const label = top ? top.title : t('conductorChip.no_actions')

  return (
    <button
      className="no-drag"
      onClick={(e) => {
        if (e.altKey && onOpenPanel) {
          onOpenPanel()
          return
        }
        if (top) useConductor.getState().runAction(top)
      }}
      onContextMenu={(e) => {
        // Right-click opens the ranked panel (a discoverable secondary affordance).
        if (onOpenPanel) {
          e.preventDefault()
          onOpenPanel()
        }
      }}
      title={
        top
          ? t('conductorChip.title_active', { title: top.title, reason: top.reason })
          : t('conductorChip.title_idle')
      }
      aria-label={
        top
          ? t('conductorChip.aria_active', { title: top.title, reason: top.reason })
          : t('conductorChip.aria_idle')
      }
      style={{
        pointerEvents: 'auto',
        flex: '0 0 auto',
        borderRadius: 8,
        padding: '4px 9px',
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        color: '#d7e1f7',
        cursor: idle && !onOpenPanel ? 'default' : 'pointer',
        background: idle ? 'rgba(120,140,170,0.10)' : `${accent}1f`,
        opacity: idle ? 0.55 : 1,
        maxWidth: 230,
        border: `1px solid ${idle ? 'rgba(120,140,170,0.22)' : `${accent}55`}`
      }}
    >
      {/* Conductor's baton glyph: a small angled tick. */}
      <span aria-hidden style={{ fontSize: 12, color: idle ? '#9fb0c9' : accent, lineHeight: 1 }}>
        ❯
      </span>
      <span
        style={{
          fontWeight: 700,
          color: idle ? '#9fb0c9' : accent,
          fontSize: 12.5,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis'
        }}
      >
        {label}
      </span>
      {!idle && (
        <span
          aria-hidden
          style={{ fontSize: 11, fontWeight: 800, color: '#9fb0c9', letterSpacing: '0.04em' }}
        >
          A
        </span>
      )}
    </button>
  )
}
