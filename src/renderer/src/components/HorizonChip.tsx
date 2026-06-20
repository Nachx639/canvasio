import { useMemo, useState } from 'react'
import { useCanvas } from '../store/canvas'
import { useMission } from '../store/mission'
import { useRelay } from '../store/relay'
import { useReplay } from '../store/replay'
import { useDirector } from '../store/director'
import { useHorizon } from '../store/horizon'
import { horizonColor } from '../lib/horizon'
import { useT } from '../store/i18n'

/**
 * Horizon Chip — the swarm-level "Horizonte" forecast, rendered INSIDE the TopBar
 * pill (like ConductorChip / TriageChip) so it never overlaps the centered controls.
 *
 * Where the Conductor answers "what should I do next?" and per-node Objectives answer
 * "is THIS agent on-track?", the Horizon answers the one question an operator running
 * a swarm actually has: "Is my WHOLE mission going to finish, and WHEN?" It reads
 * "68% · ~7m · falta Atlas" — aggregate % complete, a predicted ETA extrapolated
 * from recorded task velocity, and the single horizon-gating agent (the incomplete
 * on-critical agent deciding the finish line).
 *
 * Purely renderer-side and additive: it READS the canvas/mission/relay stores (the
 * same inputs the forecaster folds) so it re-derives whenever any signal changes, and
 * CALLS the Horizon store — no IPC, no geometry mutation, no persistence. When no
 * mission goal is declared it reads a calm idle state and forecasts nothing; clicking
 * then lets the operator declare the goal via a tiny inline prompt. Hidden while an
 * auto-driven camera (replay/director) owns the view so it never fights them.
 */
export function HorizonChip({ onOpenPanel }: { onOpenPanel?: () => void }): JSX.Element | null {
  // Subscribe to the inputs the forecaster reads so the chip re-derives live, plus
  // the declared goal so it flips between idle and forecasting instantly.
  const nodes = useCanvas((s) => s.nodes)
  const events = useMission((s) => s.events)
  const rules = useRelay((s) => s.rules)
  const goal = useHorizon((s) => s.goal)
  const replayArmed = useReplay((s) => s.armed)
  const directorArmed = useDirector((s) => s.armed)
  const [editing, setEditing] = useState(false)
  const t = useT()

  // Re-derive the forecast whenever any input changes. getForecast() reads every
  // store lazily; the subscriptions above are what trigger the recompute.
  const forecast = useMemo(
    () => useHorizon.getState().getForecast(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes, events, rules, goal]
  )

  // Hidden while an auto-driven camera owns the view (mirrors ConductorChip).
  if (replayArmed || directorArmed) return null

  const accent = horizonColor(forecast)
  const idle = forecast.idle
  const label = idle ? (goal ? t('horizonChip.mission_no_progress') : t('horizonChip.set_objective')) : forecast.headline

  // Inline goal prompt (declare / edit the mission goal). Small, in-place affordance
  // matching the calm renderer-only convention — no modal, no IPC.
  if (editing) {
    return (
      <form
        className="no-drag"
        onSubmit={(e) => {
          e.preventDefault()
          const v = (new FormData(e.currentTarget).get('goal') as string) ?? ''
          useHorizon.getState().setGoal(v)
          setEditing(false)
        }}
        style={{ pointerEvents: 'auto', flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 6 }}
      >
        <input
          name="goal"
          autoFocus
          defaultValue={goal}
          placeholder={t('horizonChip.goal_placeholder')}
          aria-label={t('horizonChip.goal_aria')}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              setEditing(false)
            }
          }}
          onBlur={(e) => {
            // Commit on blur so a click elsewhere doesn't silently discard typing.
            useHorizon.getState().setGoal(e.currentTarget.value)
            setEditing(false)
          }}
          style={{
            width: 180,
            borderRadius: 8,
            padding: '4px 8px',
            fontSize: 12.5,
            color: '#e7eeff',
            background: 'rgba(20,28,48,0.85)',
            border: '1px solid rgba(120,150,220,0.4)',
            outline: 'none'
          }}
        />
      </form>
    )
  }

  return (
    <button
      className="no-drag"
      onClick={(e) => {
        // ⌥-click / right-click open the panel; a plain click sets/edits the goal
        // when none is declared, otherwise flies to the gating long-pole agent.
        if (e.altKey) {
          if (onOpenPanel) onOpenPanel()
          return
        }
        if (!goal) {
          setEditing(true)
          return
        }
        if (forecast.gatingNodeId) {
          try {
            useCanvas.getState().centerOnNode(forecast.gatingNodeId)
          } catch {
            /* camera optional */
          }
        } else if (onOpenPanel) {
          onOpenPanel()
        }
      }}
      onContextMenu={(e) => {
        if (onOpenPanel) {
          e.preventDefault()
          onOpenPanel()
        }
      }}
      title={
        idle
          ? goal
            ? t('horizonChip.title_idle_goal', { goal })
            : t('horizonChip.title_idle_no_goal')
          : t('horizonChip.title_active', {
              headline: forecast.headline,
              goal: forecast.goal
            })
      }
      aria-label={
        idle
          ? goal
            ? t('horizonChip.aria_idle_goal', { goal })
            : t('horizonChip.aria_idle_no_goal')
          : forecast.gatingTitle
            ? t('horizonChip.aria_active_gating', {
                percent: forecast.percent,
                gatingTitle: forecast.gatingTitle
              })
            : t('horizonChip.aria_active', { percent: forecast.percent })
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
        cursor: 'pointer',
        background: idle ? 'rgba(120,140,170,0.10)' : `${accent}1f`,
        opacity: idle ? 0.6 : 1,
        maxWidth: 240,
        border: `1px solid ${idle ? 'rgba(120,140,170,0.22)' : `${accent}55`}`
      }}
    >
      {/* Horizon glyph: a small rising arc / sunrise tick. */}
      <span aria-hidden style={{ fontSize: 12, color: idle ? '#9fb0c9' : accent, lineHeight: 1 }}>
        ◠
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
    </button>
  )
}
