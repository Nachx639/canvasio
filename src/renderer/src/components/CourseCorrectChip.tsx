import { useMemo, useState } from 'react'
import { useCanvas } from '../store/canvas'
import { useBoard } from '../store/board'
import { useReplay } from '../store/replay'
import { useDirector } from '../store/director'
import { useCourseCorrect } from '../store/courseCorrect'
import { narrateBaton } from '../lib/narration'
import { useT } from '../store/i18n'

/**
 * Course Correct Chip — the first surface that turns the team's emergent consensus
 * into an actual nudge to the agent drifting from it. Rendered INSIDE the TopBar
 * pill (like ConductorChip / TriageChip) so it never overlaps the centered controls.
 *
 * Every other intelligence surface OBSERVES agents and then tells the human or moves
 * the camera. Course Correct closes that loop: when the Consensus Lens detects a
 * cross-agent CONTRADICTION AND one of the conflicting agents is STILL a running/idle
 * terminal on the canvas (it can still act), this chip surfaces a single human-gated
 * row — "Atlas: auth apikey→bearer" — with one "Avisar" button that enqueues a
 * short, polite Spanish course-correction note to that node via the EXISTING
 * readiness-gated relay drain (enqueueForTarget). Nothing fires without a click.
 *
 * Purely renderer-side and additive: it READS the canvas + board stores (the inputs
 * the reasoner folds, via analyzeConsensus) so it re-derives whenever any signal
 * changes, and CALLS the Course Correct store — no IPC, no geometry mutation, no
 * persistence. Hidden while an auto-driven camera (replay/director) owns the view so
 * it never fights them, matching ConductorChip / TriageChip. Empty -> chip hidden.
 */
// Consensus magenta accent (matches the Consensus Lens contradiction colour).
const ACCENT = '#f29bff'

export function CourseCorrectChip(): JSX.Element | null {
  // Subscribe to the inputs the reasoner reads so the chip re-derives live.
  const nodes = useCanvas((s) => s.nodes)
  const facts = useBoard((s) => s.facts)
  const replayArmed = useReplay((s) => s.armed)
  const directorArmed = useDirector((s) => s.armed)
  // Re-render after a whisper marks a correction sent (it leaves the list).
  const sent = useCourseCorrect((s) => s.sent)

  const [open, setOpen] = useState(false)
  const t = useT()

  // Re-derive whenever any input changes. getCorrections() reads every store lazily;
  // the subscriptions above are what trigger the recompute.
  const corrections = useMemo(
    () => useCourseCorrect.getState().getCorrections(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodes, facts, sent]
  )

  // Hidden while an auto-driven camera owns the view (mirrors ConductorChip), and
  // hidden entirely when there is nothing to correct (precision over noise).
  if (replayArmed || directorArmed) return null
  if (corrections.length === 0) return null

  const count = corrections.length

  return (
    <div className="no-drag" style={{ position: 'relative', flex: '0 0 auto' }}>
      <button
        className="no-drag"
        onClick={() => setOpen((v) => !v)}
        title={t('courseCorrectChip.button_title', { count })}
        aria-label={t('courseCorrectChip.button_aria', { count })}
        style={{
          pointerEvents: 'auto',
          borderRadius: 8,
          padding: '4px 9px',
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          color: ACCENT,
          cursor: 'pointer',
          background: `${ACCENT}1f`,
          border: `1px solid ${ACCENT}55`
        }}
      >
        {/* A divergent-arrows glyph: the team has drifted from this agent. */}
        <span aria-hidden style={{ fontSize: 12, color: ACCENT, lineHeight: 1 }}>
          ⤳
        </span>
        <span
          style={{ fontWeight: 700, color: ACCENT, fontSize: 12.5, whiteSpace: 'nowrap' }}
        >
          {t('courseCorrectChip.label')}
        </span>
        <span
          aria-hidden
          style={{ fontSize: 11, fontWeight: 800, color: '#d7e1f7', letterSpacing: '0.04em' }}
        >
          {count}
        </span>
      </button>

      {open && (
        <div
          className="glass no-drag"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            zIndex: 50,
            minWidth: 280,
            maxWidth: 360,
            padding: 8,
            borderRadius: 10,
            border: `1px solid ${ACCENT}40`,
            display: 'flex',
            flexDirection: 'column',
            gap: 6
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: ACCENT,
              letterSpacing: '0.03em',
              padding: '2px 4px 4px'
            }}
          >
            {t('courseCorrectChip.panel_header')}
          </div>
          {corrections.map((c) => (
            <div
              key={c.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 6px',
                borderRadius: 8,
                background: 'rgba(120,140,170,0.08)'
              }}
            >
              <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 12.5,
                    fontWeight: 700,
                    color: '#d7e1f7',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis'
                  }}
                >
                  {c.targetTitle}
                </div>
                <div
                  style={{
                    fontSize: 11.5,
                    color: '#9fb0c9',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis'
                  }}
                  title={c.note}
                >
                  {c.subject}: <span style={{ color: '#e08a8a' }}>{c.staleValue}</span>
                  {' → '}
                  <span style={{ color: ACCENT }}>{c.teamValue}</span>
                </div>
              </div>
              <button
                className="no-drag"
                onClick={() => {
                  const ok = useCourseCorrect.getState().whisper(c)
                  if (ok) narrateBaton(c.targetTitle)
                  // Close the menu when the last actionable row is consumed.
                  if (corrections.length <= 1) setOpen(false)
                }}
                title={t('courseCorrectChip.row_button_title', {
                  target: c.targetTitle,
                  note: c.note
                })}
                aria-label={t('courseCorrectChip.row_button_aria', {
                  target: c.targetTitle,
                  subject: c.subject,
                  value: c.teamValue
                })}
                style={{
                  flex: '0 0 auto',
                  pointerEvents: 'auto',
                  cursor: 'pointer',
                  borderRadius: 7,
                  padding: '4px 10px',
                  fontSize: 12,
                  fontWeight: 700,
                  color: ACCENT,
                  background: `${ACCENT}22`,
                  border: `1px solid ${ACCENT}66`
                }}
              >
                {t('courseCorrectChip.notify')}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
