import { useEffect, useState } from 'react'
import { useCanvas } from '../store/canvas'
import { useBoard } from '../store/board'
import { useContextSync } from '../store/contextSync'
import { hitKey, type StaleHit } from '../lib/contextSync'
import { AGENT_COLOR } from './MissionLog'
import { useT } from '../store/i18n'

/**
 * Context Sync Toast — the operator surface for the Fact Invalidation Bus. When a
 * Board fact a node already consumed is superseded (a newer value pinned/harvested/
 * corroborated, or a human edit), this small non-modal glass panel (bottom-left,
 * stacked above StallWatchToast) lists each pending correction: the node, the
 * subject, and old -> new value. Per-row Confirm pushes the one-line Spanish
 * correction through the proven relay drain (useContextSync.pushCorrection ->
 * useRelay.enqueueForTarget -> deliverRelay -> window.canvasio.pty.write); Dismiss
 * silences it. A header "AUTO" toggle arms auto-push so corrections fire on detect.
 *
 * Purely renderer-side and additive: it READS the contextSync/board/canvas stores
 * and CALLS contextSync actions — no IPC beyond the already-trusted relay drain,
 * no geometry mutation, no persistence (the ledger is memory-only). Style-matched
 * to StallWatchToast (glass + accent dot + AUTO toggle).
 */
export function ContextSyncToast(): JSX.Element | null {
  const t = useT()
  const armed = useContextSync((s) => s.armed)
  // Re-subscribe to the cheap signals that change when a correction could arise:
  // the live Board facts (supersession source) and the ledger/pushed/dismissed
  // sets. detectStale() reads the live board at call time; these subscriptions
  // are what re-run this render so the list stays current.
  const facts = useBoard((s) => s.facts)
  const ledger = useContextSync((s) => s.ledger)
  const pushed = useContextSync((s) => s.pushed)
  const dismissed = useContextSync((s) => s.dismissed)
  const nodes = useCanvas((s) => s.nodes)

  const hits: StaleHit[] = useContextSync.getState().detectStale()

  // When armed, auto-push any freshly-detected hit. Effect keyed on a stable
  // signature of the current hits so it fires exactly when the set changes.
  const sig = hits.map(hitKey).join('|')
  useEffect(() => {
    if (!armed) return
    if (hits.length === 0) return
    useContextSync.getState().pushAllDetected()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [armed, sig])

  // Keep the dependency-array linter honest while signalling intent: these drive
  // the recompute above even though `hits` is derived imperatively from the store.
  void facts
  void ledger
  void pushed
  void dismissed

  if (hits.length === 0) return null

  return (
    <div
      className="glass no-drag"
      role="status"
      aria-live="polite"
      style={{
        pointerEvents: 'auto',
        position: 'absolute',
        bottom: 220,
        left: 22,
        borderRadius: 12,
        padding: '10px 12px',
        minWidth: 264,
        maxWidth: 360,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        color: '#dfe7d2',
        zIndex: 61,
        border: '1px solid rgba(255,176,32,0.4)'
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
            background: '#ffb020',
            animation: 'canvasio-ctxsync-pulse 1.4s ease-out infinite'
          }}
        />
        <span
          style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '0.12em', color: '#ffb020' }}
        >
          CONTEXT SYNC
        </span>
        <span style={{ flex: 1 }} />
        <button
          className="no-drag"
          onClick={() => useContextSync.getState().toggleArmed()}
          title={t('contextSyncToast.auto_toggle_title')}
          aria-pressed={armed}
          style={{
            pointerEvents: 'auto',
            cursor: 'pointer',
            fontSize: 9.5,
            fontWeight: 800,
            letterSpacing: '0.08em',
            padding: '3px 7px',
            borderRadius: 8,
            color: armed ? '#0c0f14' : '#9fb0c8',
            background: armed ? '#ffb020' : 'transparent',
            border: '1px solid rgba(255,176,32,0.4)'
          }}
        >
          AUTO
        </button>
      </div>

      {/* one row per stale (node, subject) hit */}
      {hits.map((hit) => {
        const node = nodes.find((n) => n.id === hit.nodeId)
        const accent = node?.agent ? AGENT_COLOR[node.agent] : '#ffb020'
        const name = node?.title ?? t('contextSyncToast.agent_fallback')
        return (
          <div
            key={hitKey(hit)}
            style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
                  maxWidth: 120
                }}
              >
                {name}
              </span>
              <span style={{ color: '#9fb0c8', fontSize: 11, whiteSpace: 'nowrap' }}>
                {hit.subject}
              </span>
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 11,
                color: '#ffe0ad',
                paddingLeft: 15
              }}
            >
              <span style={{ textDecoration: 'line-through', opacity: 0.7 }}>{hit.oldValue}</span>
              <span aria-hidden style={{ color: '#8fa3cc' }}>→</span>
              <span style={{ fontWeight: 700, color: '#ffce7a' }}>{hit.newValue}</span>
              <span style={{ flex: 1 }} />
              <button
                className="no-drag"
                onClick={() => useContextSync.getState().pushCorrection(hit)}
                title={t('contextSyncToast.notify_button_title', {
                  name,
                  subject: hit.subject,
                  newValue: hit.newValue
                })}
                style={{
                  pointerEvents: 'auto',
                  cursor: 'pointer',
                  fontSize: 10.5,
                  fontWeight: 700,
                  padding: '3px 8px',
                  borderRadius: 8,
                  color: '#0c0f14',
                  background: '#ffb020',
                  border: '1px solid rgba(255,176,32,0.5)'
                }}
              >
                {t('contextSyncToast.notify_button')}
              </button>
              <button
                className="no-drag"
                onClick={() => useContextSync.getState().dismiss(hit)}
                title={t('contextSyncToast.dismiss_button_title')}
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
                {t('contextSyncToast.dismiss_button')}
              </button>
            </div>
          </div>
        )
      })}

      <style>{`
        @keyframes canvasio-ctxsync-pulse {
          0%   { box-shadow: 0 0 0 0 #ffb02066; }
          70%  { box-shadow: 0 0 0 7px #ffb02000; }
          100% { box-shadow: 0 0 0 0 #ffb02000; }
        }
      `}</style>
    </div>
  )
}
