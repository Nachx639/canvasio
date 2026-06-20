import { useMemo } from 'react'
import { useQuestions } from '../store/questions'
import { useReplay } from '../store/replay'
import { useDirector } from '../store/director'
import { useT } from '../store/i18n'

/**
 * Open Questions Chip — the swarm's "unblock" count, rendered INSIDE the TopBar
 * pill (like ConductorChip / HorizonChip / TriageChip) so it never overlaps the
 * centered controls.
 *
 * It badges the number of LIVE (unresolved) questions agents have emitted but
 * nobody has answered. Clicking it opens the Open Questions Panel via the shared
 * 'canvasio:open-questions' CustomEvent (mirroring the Brief Board's
 * 'canvasio:open-board'), where each card can be answered in one click from the
 * team's accumulated context.
 *
 * Purely renderer-side and additive: it READS the questions store (memory-only)
 * and dispatches a window event — no IPC, no geometry mutation, no persistence.
 * Hidden when there are no open questions, and while an auto-driven camera
 * (replay/director) owns the view so it never fights them, matching the sibling
 * chips. Amber when blocked, since an unanswered question is a stall.
 */
export function QuestionsChip(): JSX.Element | null {
  const t = useT()
  const questions = useQuestions((s) => s.questions)
  const replayArmed = useReplay((s) => s.armed)
  const directorArmed = useDirector((s) => s.armed)

  const count = useMemo(() => questions.filter((q) => !q.resolved).length, [questions])

  // Nothing blocked, or an auto-driven camera owns the view -> stay out of the way.
  if (count === 0) return null
  if (replayArmed || directorArmed) return null

  const accent = '#ffb020'

  return (
    <button
      className="no-drag"
      onClick={() => window.dispatchEvent(new CustomEvent('canvasio:open-questions'))}
      title={
        count === 1
          ? t('questionsChip.title_one', { count })
          : t('questionsChip.title_other', { count })
      }
      aria-label={t('questionsChip.aria_label', { count })}
      style={{
        pointerEvents: 'auto',
        flex: '0 0 auto',
        borderRadius: 8,
        padding: '4px 9px',
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        color: accent,
        cursor: 'pointer',
        background: `${accent}1f`,
        border: `1px solid ${accent}55`
      }}
    >
      <span aria-hidden style={{ fontSize: 12, color: accent, lineHeight: 1 }}>
        ?
      </span>
      <span
        style={{
          fontWeight: 700,
          color: accent,
          fontSize: 12.5,
          whiteSpace: 'nowrap'
        }}
      >
        {count === 1 ? t('questionsChip.count_one', { count }) : t('questionsChip.count_other', { count })}
      </span>
    </button>
  )
}
