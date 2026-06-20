import { useEffect, useMemo, useRef, useState } from 'react'
import { useCanvas } from '../store/canvas'
import { useFrostRect } from '../hooks/useFrostRect'
import { useBoard } from '../store/board'
import { useLens } from '../store/lens'
import { useRelay } from '../store/relay'
import { useQuestions, type OpenQuestion } from '../store/questions'
import { scoreAnswerSources, type AnswerSource, type NodeExcerpt } from '../lib/openQuestion'
import { useDraggablePanel } from '../lib/useDraggablePanel'
import { PanelGrip } from './PanelGrip'
import { useT } from '../store/i18n'

/**
 * Open Questions Panel — the dockable "unblock bus". It lists every LIVE
 * (unresolved) question an agent emitted, attributed to the asking node. For each
 * card it matches the question's subject against (a) every Brief Board fact and
 * (b) every sibling agent's live Agent Lens excerpt — using the SAME pure
 * scoreAnswerSources matcher (which reuses consensus.subjectKey) — and, when a
 * confident source exists, offers a one-click "Responder desde <fuente>" that
 * injects the matching answer straight into the ASKING agent via the EXACT Brief
 * Board relay-drain delivery path (useRelay.enqueueForTarget -> deliverRelay ->
 * window.canvasio.pty.write). No new delivery path, no new IPC.
 *
 * When nothing matches, the card offers "Avisarme" (flag to me) / dismiss, so a
 * blocked agent's question is never silent — it pairs with the existing `waiting`
 * logical status surfaced by narration.
 *
 * Opened via the 'canvasio:open-questions' CustomEvent (the TopBar QuestionsChip
 * and, optionally, the palette), mirroring BriefBoard's 'canvasio:open-board'.
 * Purely renderer-side and additive: it READS nodes + facts + lens + questions and
 * CALLS store actions — no IPC beyond the already-trusted pty.write the relay
 * drain performs, no geometry mutation, no persistence (the bus is memory-only).
 */
export function QuestionsPanel(): JSX.Element | null {
  const t = useT()
  const [open, setOpen] = useState(false)
  const { style: dragStyle, dragHandleProps } = useDraggablePanel('questions')

  const questions = useQuestions((s) => s.questions)
  const facts = useBoard((s) => s.facts)
  const lensLines = useLens((s) => s.lines)
  const nodes = useCanvas((s) => s.nodes)

  // Frost-reveal ref (declared before the early `return null` so the hook order
  // is stable; when closed the ref is null → useFrostRect unregisters cleanly).
  const frostRef = useRef<HTMLDivElement>(null)
  useFrostRect(frostRef, { radius: 14, active: open })

  // Only LIVE cards are actionable; resolved ones drop out of the list.
  const live = useMemo(() => questions.filter((q) => !q.resolved), [questions])

  // Build the sibling-excerpt list once per relevant change: each terminal node's
  // latest Agent Lens line, paired with its current title. The matcher excludes
  // the asking node per-card, so we include every terminal here.
  const excerpts = useMemo<NodeExcerpt[]>(() => {
    if (!open) return []
    const out: NodeExcerpt[] = []
    for (const n of nodes) {
      if (n.kind !== 'terminal') continue
      const ln = lensLines[n.id]
      if (!ln || !ln.text) continue
      out.push({ nodeId: n.id, title: n.title, excerpt: ln.text, ts: ln.ts })
    }
    return out
  }, [open, nodes, lensLines])

  // Per-card best answer-source candidates, recomputed when any input changes.
  const candidatesByCard = useMemo(() => {
    const m = new Map<string, AnswerSource[]>()
    if (!open) return m
    for (const q of live) {
      m.set(q.id, scoreAnswerSources(q, facts, excerpts, q.askingNodeId))
    }
    return m
  }, [open, live, facts, excerpts])

  useEffect(() => {
    const onOpen = (): void => setOpen((v) => !v)
    window.addEventListener('canvasio:open-questions', onOpen)
    return () => window.removeEventListener('canvasio:open-questions', onOpen)
  }, [])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  if (!open) return null

  // Inject the matched answer into the ASKING node via the proven relay drain —
  // the SAME path the Brief Board injection uses. Then resolve the card.
  const answer = (q: OpenQuestion, src: AnswerSource): void => {
    const target = nodes.find((n) => n.id === q.askingNodeId && n.kind === 'terminal')
    if (!target) {
      // The asking node is gone; just resolve so the stale card clears.
      useQuestions.getState().resolve(q.id)
      return
    }
    const block = t('questionsPanel.answer_injection', { source: src.source, answer: src.answer })
    useRelay.getState().enqueueForTarget(target.id, block)
    useQuestions.getState().resolve(q.id)
  }

  return (
    <div
      ref={frostRef}
      className="glass no-drag"
      data-canvasio-panel-root
      role="dialog"
      aria-label={t('questionsPanel.dialog_aria')}
      style={{
        pointerEvents: 'auto',
        position: 'absolute',
        top: 46,
        right: 16,
        borderRadius: 14,
        padding: 14,
        width: 370,
        maxHeight: '74vh',
        display: 'flex',
        flexDirection: 'column',
        fontSize: 13,
        color: '#d7e1f7',
        zIndex: 60,
        ...dragStyle
      }}
    >
      <PanelGrip dragHandleProps={dragHandleProps} />
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontWeight: 700, fontSize: 14 }}>{t('questionsPanel.title')}</span>
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
          {t('questionsPanel.unblock_bus')}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 10.5, color: '#6f84ad' }}>
          {live.length} {live.length === 1 ? t('questionsPanel.count_one') : t('questionsPanel.count_other')}
        </span>
        <button
          onClick={() => setOpen(false)}
          aria-label={t('questionsPanel.close_aria')}
          title={t('common.close')}
          style={{
            marginLeft: 10,
            background: 'none',
            border: 'none',
            color: '#8fa3cc',
            cursor: 'pointer'
          }}
        >
          ✕
        </button>
      </div>

      <div style={{ overflowY: 'auto', flex: '1 1 auto', minHeight: 0 }}>
        {live.length === 0 ? (
          <div style={{ fontSize: 12, color: '#6f84ad', padding: '4px 0' }}>
            {t('questionsPanel.empty')}
          </div>
        ) : (
          live.map((q) => {
            const cands = candidatesByCard.get(q.id) ?? []
            const top = cands[0]
            return (
              <div
                key={q.id}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 7,
                  padding: '8px 10px',
                  marginBottom: 6,
                  borderRadius: 10,
                  background: 'rgba(8,12,26,0.55)',
                  border: top
                    ? '1px solid rgba(72,213,151,0.4)'
                    : '1px solid rgba(255,176,32,0.35)'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  <span
                    style={{
                      flex: '0 0 auto',
                      fontSize: 10,
                      lineHeight: 1.4,
                      padding: '1px 6px',
                      borderRadius: 6,
                      color: '#cfe0ff',
                      background: 'rgba(122,162,255,0.16)',
                      border: '1px solid rgba(122,162,255,0.4)',
                      fontWeight: 700
                    }}
                  >
                    {q.askingTitle}
                  </span>
                  <span style={{ flex: '1 1 0', minWidth: 0, fontSize: 12.5, color: '#e7eeff' }}>
                    {q.text}
                  </span>
                  <button
                    onClick={() => useQuestions.getState().remove(q.id)}
                    aria-label={t('questionsPanel.dismiss_aria')}
                    title={t('questionsPanel.dismiss')}
                    style={{
                      flex: '0 0 auto',
                      background: 'none',
                      border: 'none',
                      color: '#6f84ad',
                      cursor: 'pointer',
                      fontSize: 13,
                      lineHeight: 1
                    }}
                  >
                    ✕
                  </button>
                </div>

                {top ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span
                      title={top.answer}
                      style={{
                        flex: '1 1 0',
                        minWidth: 0,
                        fontSize: 11.5,
                        color: '#9af0c6',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      {top.kind === 'fact' ? '✦' : '↪'} {top.answer}
                    </span>
                    <button
                      onClick={() => answer(q, top)}
                      title={t('questionsPanel.inject_tooltip', { source: top.source, target: q.askingTitle })}
                      style={{
                        flex: '0 0 auto',
                        background: 'rgba(72,213,151,0.2)',
                        color: '#9af0c6',
                        border: '1px solid rgba(72,213,151,0.55)',
                        borderRadius: 8,
                        padding: '3px 9px',
                        fontWeight: 700,
                        fontSize: 11,
                        cursor: 'pointer'
                      }}
                    >
                      {t('questionsPanel.answer_from', { source: top.source })}
                    </button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ flex: '1 1 0', fontSize: 11, color: '#ffce7a' }}>
                      {t('questionsPanel.no_answer')}
                    </span>
                    <button
                      onClick={() => useQuestions.getState().resolve(q.id)}
                      title={t('questionsPanel.flag_tooltip')}
                      style={{
                        flex: '0 0 auto',
                        background: 'rgba(255,176,32,0.18)',
                        color: '#ffce7a',
                        border: '1px solid rgba(255,176,32,0.5)',
                        borderRadius: 8,
                        padding: '3px 9px',
                        fontWeight: 700,
                        fontSize: 11,
                        cursor: 'pointer'
                      }}
                    >
                      {t('questionsPanel.flag_me')}
                    </button>
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
