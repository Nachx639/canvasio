import { useEffect, useMemo } from 'react'
import { useCanvas } from '../store/canvas'
import { useMission } from '../store/mission'
import { useRelay } from '../store/relay'
import { useBoard } from '../store/board'
import { useConductor } from '../store/conductor'
import { recommendationColor } from '../lib/conductor'
import { useDraggablePanel } from '../lib/useDraggablePanel'
import { useT } from '../store/i18n'
import { PanelGrip } from './PanelGrip'

/**
 * Conductor Panel — the ranked Next-Best-Action queue.
 *
 * A draggable floating HUD (useDraggablePanel + PanelGrip, same as DoctorPanel /
 * Mission Pulse) that lists the Conductor's ranked recommendations: each row is a
 * one-leverage-action headline + the WHY, with a per-row action button that routes
 * through runAction (existing store actions only — fly / cycleAttention / open the
 * relevant lens). It is the panel behind the TopBar's ConductorChip head.
 *
 * 100% DERIVED from already-in-memory surfaces via the pure reasoner; no new IPC,
 * no geometry mutation beyond the existing camera tween, no persistence.
 */
export function ConductorPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const t = useT()
  const { style: dragStyle, dragHandleProps } = useDraggablePanel('conductor')

  // Subscribe to the inputs the reasoner reads so the list re-derives live.
  const nodes = useCanvas((s) => s.nodes)
  const events = useMission((s) => s.events)
  const rules = useRelay((s) => s.rules)
  const facts = useBoard((s) => s.facts)

  const recs = useMemo(
    () => useConductor.getState().getRecommendations(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes, events, rules, facts]
  )

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

  return (
    <div
      className="glass-solid no-drag"
      data-canvasio-panel-root
      role="dialog"
      aria-label={t('panels.conductor_aria')}
      style={{
        pointerEvents: 'auto',
        position: 'absolute',
        top: 46,
        right: 14,
        borderRadius: 14,
        padding: 16,
        width: 360,
        maxHeight: '78vh',
        overflowY: 'auto',
        fontSize: 13,
        color: '#d7e1f7',
        ...dragStyle
      }}
    >
      <PanelGrip dragHandleProps={dragHandleProps} />
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ fontWeight: 700, fontSize: 14 }}>{t('panels.conductor_title')}</span>
        <span
          style={{
            marginLeft: 8,
            fontSize: 10.5,
            color: '#8fa3cc',
            border: '1px solid rgba(120,150,220,0.2)',
            borderRadius: 6,
            padding: '1px 6px'
          }}
        >
          {recs.length
            ? t(recs.length === 1 ? 'panels.conductor_count_one' : 'panels.conductor_count_other', {
                n: recs.length
              })
            : t('panels.conductor_uptodate')}
        </span>
        <button
          onClick={onClose}
          aria-label={t('panels.conductor_close')}
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

      {recs.length === 0 && (
        <div style={{ color: '#8fa3cc', fontSize: 12.5, padding: '6px 2px' }}>
          {t('panels.conductor_empty')}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {recs.map((rec, i) => {
          const accent = recommendationColor(rec.kind)
          return (
            <div
              key={rec.id}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                padding: '9px 10px',
                borderRadius: 10,
                background: i === 0 ? `${accent}14` : 'rgba(120,140,170,0.06)',
                border: `1px solid ${i === 0 ? `${accent}44` : 'rgba(120,150,220,0.14)'}`
              }}
            >
              {/* leverage rank + accent dot */}
              <span
                aria-hidden
                style={{
                  flex: '0 0 auto',
                  marginTop: 2,
                  width: 18,
                  height: 18,
                  borderRadius: '50%',
                  display: 'grid',
                  placeItems: 'center',
                  fontSize: 10.5,
                  fontWeight: 800,
                  color: accent,
                  background: `${accent}22`
                }}
              >
                {i + 1}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontWeight: 700,
                    fontSize: 12.8,
                    color: '#e7eeff',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis'
                  }}
                >
                  {rec.title}
                </div>
                <div style={{ fontSize: 11.5, color: '#9fb0c9', marginTop: 2, lineHeight: 1.35 }}>
                  {rec.reason}
                </div>
                {/* Agent Scorecard 'prefer-reliable' hint — a quiet sub-line shown
                    only when the cross-mission track record flags a clearly more
                    reliable persona. Purely informational; no action attached. */}
                {rec.hint && (
                  <div
                    style={{
                      fontSize: 11,
                      color: '#7f93b8',
                      marginTop: 4,
                      lineHeight: 1.35,
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: 5
                    }}
                  >
                    <span aria-hidden style={{ color: '#9b8cff' }}>
                      ◆
                    </span>
                    <span>{rec.hint}</span>
                  </div>
                )}
              </div>
              <button
                className="no-drag"
                onClick={() => useConductor.getState().runAction(rec)}
                title={rec.actionLabel}
                aria-label={`${rec.actionLabel}: ${rec.title}`}
                style={{
                  flex: '0 0 auto',
                  alignSelf: 'center',
                  borderRadius: 8,
                  padding: '5px 10px',
                  fontSize: 11.5,
                  fontWeight: 700,
                  color: accent,
                  background: `${accent}1f`,
                  border: `1px solid ${accent}55`,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap'
                }}
              >
                {rec.actionLabel}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
