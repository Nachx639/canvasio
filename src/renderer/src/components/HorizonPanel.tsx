import { useEffect, useMemo, useRef, useState } from 'react'
import { useCanvas } from '../store/canvas'
import { useFrostRect } from '../hooks/useFrostRect'
import { useMission } from '../store/mission'
import { useRelay } from '../store/relay'
import { useHorizon } from '../store/horizon'
import { etaLabel, horizonColor } from '../lib/horizon'
import { judgmentColor, judgmentLabel } from '../lib/objective'
import { useDraggablePanel } from '../lib/useDraggablePanel'
import { PanelGrip } from './PanelGrip'
import { useT } from '../store/i18n'

/**
 * Horizon Panel — the swarm-level mission completion forecast.
 *
 * A draggable floating HUD (useDraggablePanel + PanelGrip, same as ConductorPanel /
 * Mission Pulse) behind the TopBar's HorizonChip. It shows the ONE declared mission
 * goal, the aggregate % complete, the predicted ETA, and a per-agent contribution
 * breakdown (percent bar + the gating "marca el ritmo" badge on the long pole) so the
 * operator can see WHICH agent is deciding the finish line. A small field declares /
 * clears the mission goal.
 *
 * 100% DERIVED from already-in-memory surfaces via the pure forecaster; read-only
 * over every store except setGoal / clearGoal. No new IPC, no geometry mutation
 * beyond the existing camera tween (click an agent to fly to it), no persistence.
 */
export function HorizonPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const t = useT()
  const { style: dragStyle, dragHandleProps } = useDraggablePanel('horizon')

  // Subscribe to the inputs the forecaster reads so the readout re-derives live.
  const nodes = useCanvas((s) => s.nodes)
  const events = useMission((s) => s.events)
  const rules = useRelay((s) => s.rules)
  const goal = useHorizon((s) => s.goal)
  const [draft, setDraft] = useState(goal)

  const forecast = useMemo(
    () => useHorizon.getState().getForecast(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes, events, rules, goal]
  )

  // Keep the draft in sync if the goal changes elsewhere (e.g. the chip prompt).
  useEffect(() => setDraft(goal), [goal])

  // Esc closes the panel (capture phase, like the other HUD panels).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const accent = horizonColor(forecast)

  const frostRef = useRef<HTMLDivElement>(null)
  useFrostRect(frostRef, { radius: 14 })

  return (
    <div
      ref={frostRef}
      className="glass no-drag"
      data-canvasio-panel-root
      role="dialog"
      aria-label={t('horizonPanel.aria')}
      style={{
        pointerEvents: 'auto',
        position: 'absolute',
        top: 46,
        right: 14,
        borderRadius: 14,
        padding: 16,
        width: 370,
        maxHeight: '78vh',
        overflowY: 'auto',
        fontSize: 13,
        color: '#d7e1f7',
        ...dragStyle
      }}
    >
      <PanelGrip dragHandleProps={dragHandleProps} />
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ fontWeight: 700, fontSize: 14 }}>{t('horizonPanel.title')}</span>
        {!forecast.idle && (
          <span
            style={{
              marginLeft: 8,
              fontSize: 10.5,
              color: accent,
              border: `1px solid ${accent}55`,
              borderRadius: 6,
              padding: '1px 6px',
              fontWeight: 700
            }}
          >
            {forecast.percent}%{forecast.etaMs != null ? ` · ~${etaLabel(forecast.etaMs)}` : ''}
          </span>
        )}
        <button
          onClick={onClose}
          aria-label={t('horizonPanel.close_aria')}
          title={t('common.close')}
          style={{
            marginLeft: 'auto',
            background: 'none',
            border: 'none',
            color: '#8fa3cc',
            cursor: 'pointer'
          }}
        >
          ✕
        </button>
      </div>

      {/* Goal declaration field. */}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          useHorizon.getState().setGoal(draft)
        }}
        style={{ display: 'flex', gap: 6, marginBottom: 12 }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t('horizonPanel.goal_placeholder')}
          aria-label={t('horizonPanel.goal_aria')}
          style={{
            flex: 1,
            minWidth: 0,
            borderRadius: 8,
            padding: '6px 9px',
            fontSize: 12.5,
            color: '#e7eeff',
            background: 'rgba(20,28,48,0.7)',
            border: '1px solid rgba(120,150,220,0.3)',
            outline: 'none'
          }}
        />
        <button
          type="submit"
          title={t('horizonPanel.set_goal')}
          style={{
            flex: '0 0 auto',
            borderRadius: 8,
            padding: '6px 11px',
            fontSize: 12,
            fontWeight: 700,
            color: '#9bd1ff',
            background: 'rgba(120,150,220,0.16)',
            border: '1px solid rgba(120,150,220,0.4)',
            cursor: 'pointer'
          }}
        >
          {t('horizonPanel.set')}
        </button>
        {goal && (
          <button
            type="button"
            onClick={() => useHorizon.getState().clearGoal()}
            title={t('horizonPanel.clear_goal')}
            style={{
              flex: '0 0 auto',
              borderRadius: 8,
              padding: '6px 9px',
              fontSize: 12,
              color: '#9fb0c9',
              background: 'rgba(120,140,170,0.1)',
              border: '1px solid rgba(120,150,220,0.22)',
              cursor: 'pointer'
            }}
          >
            {t('horizonPanel.clear')}
          </button>
        )}
      </form>

      {forecast.idle && (
        <div style={{ color: '#8fa3cc', fontSize: 12.5, padding: '6px 2px', lineHeight: 1.4 }}>
          {goal ? t('horizonPanel.idle_no_progress') : t('horizonPanel.idle_no_goal')}
        </div>
      )}

      {!forecast.idle && (
        <>
          {/* aggregate bar + ETA */}
          <div style={{ marginBottom: 6, display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontSize: 22, fontWeight: 800, color: accent }}>{forecast.percent}%</span>
            <span style={{ fontSize: 12.5, color: '#9fb0c9' }}>
              {forecast.etaMs != null
                ? t('horizonPanel.eta_estimate', { eta: etaLabel(forecast.etaMs) })
                : t('horizonPanel.no_velocity')}
            </span>
          </div>
          <div
            aria-hidden
            style={{
              height: 8,
              borderRadius: 5,
              background: 'rgba(120,140,170,0.16)',
              overflow: 'hidden',
              marginBottom: 14
            }}
          >
            <div
              style={{
                width: `${forecast.percent}%`,
                height: '100%',
                background: accent,
                transition: 'width 220ms ease'
              }}
            />
          </div>

          <div
            style={{
              fontSize: 10.5,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: '#8fa3cc',
              marginBottom: 8
            }}
          >
            {t(
              forecast.contributing === 1
                ? 'horizonPanel.agents_with_goal_one'
                : 'horizonPanel.agents_with_goal_other',
              { count: forecast.contributing }
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {forecast.agents.map((a) => {
              const isGating = a.nodeId === forecast.gatingNodeId
              const jColor = judgmentColor(a.judgment)
              return (
                <button
                  key={a.nodeId}
                  className="no-drag"
                  onClick={() => {
                    try {
                      useCanvas.getState().centerOnNode(a.nodeId)
                    } catch {
                      /* camera optional */
                    }
                  }}
                  title={`${t('horizonPanel.agent_title', {
                    title: a.title,
                    percent: a.percent,
                    judgment: judgmentLabel(a.judgment)
                  })}${a.onCritical ? t('horizonPanel.on_critical_path') : ''}`}
                  style={{
                    textAlign: 'left',
                    padding: '8px 10px',
                    borderRadius: 10,
                    background: isGating ? `${accent}14` : 'rgba(120,140,170,0.06)',
                    border: `1px solid ${isGating ? `${accent}44` : 'rgba(120,150,220,0.14)'}`,
                    cursor: 'pointer',
                    color: '#d7e1f7'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                    <span
                      aria-hidden
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: jColor,
                        flex: '0 0 auto'
                      }}
                    />
                    <span
                      style={{
                        fontWeight: 700,
                        fontSize: 12.5,
                        color: '#e7eeff',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        flex: 1,
                        minWidth: 0
                      }}
                    >
                      {a.title}
                    </span>
                    {isGating && (
                      <span
                        style={{
                          fontSize: 9.5,
                          fontWeight: 800,
                          textTransform: 'uppercase',
                          letterSpacing: '0.05em',
                          color: accent,
                          background: `${accent}22`,
                          border: `1px solid ${accent}55`,
                          borderRadius: 5,
                          padding: '1px 5px'
                        }}
                      >
                        {t('horizonPanel.sets_the_pace')}
                      </span>
                    )}
                    <span style={{ fontSize: 11.5, fontWeight: 700, color: '#9fb0c9' }}>
                      {a.percent}%
                    </span>
                  </div>
                  <div
                    aria-hidden
                    style={{
                      height: 5,
                      borderRadius: 4,
                      background: 'rgba(120,140,170,0.16)',
                      overflow: 'hidden'
                    }}
                  >
                    <div style={{ width: `${a.percent}%`, height: '100%', background: jColor }} />
                  </div>
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
