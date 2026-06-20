import { useEffect, useState } from 'react'
import { useCanvas } from '../store/canvas'
import { useStall } from '../store/stall'
import { useT } from '../store/i18n'
import { AGENT_COLOR } from './MissionLog'

/**
 * Stall Watch HUD — a small non-modal glass panel (bottom-left, stacked above
 * the DirectorChip slot) shown only while Stall Watch is armed AND there is at
 * least one current stall. Each row names a blocked agent, how long it's been
 * stuck, and offers "Nudge" (deliver a Board-backed rescue through the relay
 * drain path) + "Ver" (fly the camera to it). A header "auto" toggle arms
 * auto-nudge.
 *
 * Purely renderer-side and additive: it READS the stall/canvas stores and CALLS
 * stall.nudge / canvas.centerOnNode — no IPC, no geometry mutation, no
 * persistence. Style-matched to DirectorChip / UpdateToast (glass + accent dot).
 */
export function StallWatchToast(): JSX.Element | null {
  const t = useT()
  const armed = useStall((s) => s.armed)
  const autoNudge = useStall((s) => s.autoNudge)
  const stalls = useStall((s) => s.stalls)
  const nodes = useCanvas((s) => s.nodes)

  // Re-render once per second so the "1m12s" elapsed labels stay live.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!armed) return
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [armed])

  if (!armed) return null

  const entries = Object.entries(stalls)
  if (entries.length === 0) return null

  const now = Date.now()

  return (
    <div
      className="glass no-drag"
      role="status"
      aria-live="polite"
      style={{
        pointerEvents: 'auto',
        position: 'absolute',
        bottom: 64,
        left: 22,
        borderRadius: 12,
        padding: '10px 12px',
        minWidth: 248,
        maxWidth: 340,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        color: '#e7d2da',
        zIndex: 61,
        border: '1px solid rgba(255,107,129,0.34)'
      }}
    >
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: '#ff6b81',
            animation: 'canvasio-stall-pulse 1.4s ease-out infinite'
          }}
        />
        <span
          style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.12em', color: '#ff6b81' }}
        >
          STALL WATCH
        </span>
        <span style={{ flex: 1 }} />
        <button
          className="no-drag"
          onClick={() => useStall.getState().toggleAutoNudge()}
          title={t('stallWatchToast.auto_nudge_tooltip')}
          aria-pressed={autoNudge}
          style={{
            pointerEvents: 'auto',
            cursor: 'pointer',
            fontSize: 9.5,
            fontWeight: 800,
            letterSpacing: '0.08em',
            padding: '3px 7px',
            borderRadius: 8,
            color: autoNudge ? '#0c0f14' : '#9fb0c8',
            background: autoNudge ? '#ff6b81' : 'transparent',
            border: '1px solid rgba(255,107,129,0.4)'
          }}
        >
          AUTO
        </button>
      </div>

      {/* one row per stalled node */}
      {entries.map(([nodeId, entry]) => {
        const node = nodes.find((n) => n.id === nodeId)
        const accent = node?.agent ? AGENT_COLOR[node.agent] : '#ff6b81'
        const name = node?.title ?? t('stallWatchToast.agent_fallback')
        const secs = Math.max(0, Math.round((now - entry.since) / 1000))
        const ago = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m${secs % 60}s`
        const stateLabel =
          entry.kind === 'error' ? t('stallWatchToast.state_error') : t('stallWatchToast.state_waiting')
        return (
          <div
            key={nodeId}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 12
            }}
          >
            <span
              aria-hidden
              style={{ width: 7, height: 7, borderRadius: '50%', background: accent, flex: '0 0 auto' }}
            />
            <span
              style={{
                fontWeight: 700,
                color: accent,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                maxWidth: 110
              }}
            >
              {name}
            </span>
            <span style={{ color: '#9fb0c8', fontSize: 11, whiteSpace: 'nowrap' }}>
              {stateLabel} · {ago}
            </span>
            <span style={{ flex: 1 }} />
            <button
              className="no-drag"
              onClick={() => useStall.getState().nudge(nodeId)}
              title={t('stallWatchToast.nudge_tooltip')}
              style={{
                pointerEvents: 'auto',
                cursor: 'pointer',
                fontSize: 10.5,
                fontWeight: 700,
                padding: '3px 8px',
                borderRadius: 8,
                color: entry.nudged ? '#7d8aa0' : '#0c0f14',
                background: entry.nudged ? 'transparent' : accent,
                border: `1px solid ${accent}66`
              }}
            >
              {entry.nudged ? 'Nudged' : 'Nudge'}
            </button>
            <button
              className="no-drag"
              onClick={() => useCanvas.getState().centerOnNode(nodeId)}
              title={t('stallWatchToast.view_tooltip')}
              style={{
                pointerEvents: 'auto',
                cursor: 'pointer',
                fontSize: 10.5,
                fontWeight: 700,
                padding: '3px 8px',
                borderRadius: 8,
                color: '#cdd8ee',
                background: 'transparent',
                border: '1px solid rgba(205,216,238,0.22)'
              }}
            >
              {t('stallWatchToast.view')}
            </button>
          </div>
        )
      })}

      <style>{`
        @keyframes canvasio-stall-pulse {
          0%   { box-shadow: 0 0 0 0 #ff6b8166; }
          70%  { box-shadow: 0 0 0 7px #ff6b8100; }
          100% { box-shadow: 0 0 0 0 #ff6b8100; }
        }
      `}</style>
    </div>
  )
}
