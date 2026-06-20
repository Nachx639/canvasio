import { useEffect, useRef, useState } from 'react'
import { useHistory, type HistoryLabel } from '../store/history'
import { useT } from '../store/i18n'

/**
 * Layout Time Machine — a tiny bottom-center glass toast that echoes the most
 * recent undo/redo + how many steps remain on that stack ("Deshecho: mover · 3
 * restantes"). It subscribes to the history store's `tick` (bumped on every
 * undo/redo) and reads `lastAction`; it renders null when idle, so there is zero
 * cost while nothing is happening — matching the StallWatchToast/UpdateToast
 * conventions (glass panel, role=status, aria-live). Purely renderer-side: it
 * READS the in-memory history store and never touches geometry, IPC, or
 * persistence.
 */

const VERB_KEY: Record<'undo' | 'redo', string> = {
  undo: 'historyToast.verb_undo',
  redo: 'historyToast.verb_redo'
}

const LABEL_KEY: Record<HistoryLabel, string> = {
  move: 'historyToast.label_move',
  resize: 'historyToast.label_resize',
  arrange: 'historyToast.label_arrange',
  flow: 'historyToast.label_flow',
  declutter: 'historyToast.label_declutter',
  cascade: 'historyToast.label_cascade',
  close: 'historyToast.label_close'
}

const SHOW_MS = 1800

export function HistoryToast(): JSX.Element | null {
  // Subscribe to the tick so the component re-renders on every undo/redo, then
  // read the live action snapshot.
  const t = useT()
  const tick = useHistory((s) => s.tick)
  const lastAction = useHistory((s) => s.lastAction)
  const [visible, setVisible] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    // Only flash for an actual undo/redo (lastAction set). Pushes/resets bump
    // tick too but leave lastAction null (reset) — those should not flash.
    if (!lastAction) {
      setVisible(false)
      return
    }
    setVisible(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setVisible(false), SHOW_MS)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
    // tick is the real trigger (a repeated undo of the same label keeps
    // lastAction object-equal-ish but tick always advances).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick])

  if (!visible || !lastAction) return null

  const { label, dir, remaining } = lastAction
  const verb = t(VERB_KEY[dir])
  const what = LABEL_KEY[label] ? t(LABEL_KEY[label]) : label
  const tail =
    remaining > 0
      ? t(remaining === 1 ? 'historyToast.remaining_one' : 'historyToast.remaining_other', {
          count: remaining
        })
      : t('historyToast.no_more_steps')

  return (
    <div
      className="glass no-drag"
      role="status"
      aria-live="polite"
      style={{
        pointerEvents: 'none',
        position: 'fixed',
        bottom: 26,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 62,
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '8px 14px',
        borderRadius: 12,
        fontSize: 12.5,
        color: '#e7eeff',
        boxShadow: '0 10px 30px -10px rgba(0,0,0,0.55)'
      }}
    >
      <span aria-hidden style={{ fontSize: 13, opacity: 0.85 }}>
        {dir === 'undo' ? '↶' : '↷'}
      </span>
      <span style={{ opacity: 0.95 }}>
        {verb}: <span style={{ fontWeight: 700 }}>{what}</span>
        <span style={{ opacity: 0.6 }}> · {tail}</span>
      </span>
    </div>
  )
}
