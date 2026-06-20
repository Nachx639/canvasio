import { useEffect, useMemo, useRef, useState } from 'react'
import { useCanvas } from '../store/canvas'
import { useBoard } from '../store/board'
import { useRecall } from '../store/recall'
import { useRelay } from '../store/relay'
import { useContextSync } from '../store/contextSync'
import { formatBoardForInjection } from '../lib/boardFormat'
import { analyzeConsensus, formatReconcilePrompt, subjectKey, assertedValue, type Conflict } from '../lib/consensus'
import { useT } from '../store/i18n'

/**
 * Brief Board — the dockable panel for the SHARED agent context pool. It lists
 * every pinned fact (attribution chip + text + remove ×), lets you type a new
 * fact, and injects the whole board into the SELECTED agent via the proven
 * readiness-gated relay drain (useRelay.enqueueForTarget -> deliverRelay ->
 * window.canvasio.pty.write), the SAME path spawn tasks and Agent Relay handoffs
 * use. No new delivery path is invented.
 *
 * Opened via the 'canvasio:open-board' CustomEvent (dispatched by the 'B' key in
 * App.tsx and the Command Palette), mirroring the AgentLensHud + 'canvasio:open-
 * lens' pattern. Purely renderer-side and additive: it READS nodes + board facts
 * and CALLS store actions — no IPC beyond the already-trusted pty.write the relay
 * drain performs, no geometry mutation, no persistence (the board is memory-only).
 */
export function BriefBoard(): JSX.Element | null {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')

  const facts = useBoard((s) => s.facts)
  const nodes = useCanvas((s) => s.nodes)
  const selectedId = useCanvas((s) => s.selectedId)

  const selected = useMemo(
    () => nodes.find((n) => n.id === selectedId && n.kind === 'terminal'),
    [nodes, selectedId]
  )

  // Consensus Lens — derive cross-agent agreement/contradiction from the board.
  // Pure + memoized: recomputes only when the facts array changes. The readout is
  // memory-only (never stored), exactly like every other intelligence surface.
  const consensus = useMemo(() => analyzeConsensus(facts), [facts])

  // factId -> number of distinct agents that corroborate the value it asserts, so
  // a corroborated row can show a green "N agree" badge inline.
  const agreeByFactId = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of consensus.corroborated) {
      for (const id of c.factIds) m.set(id, c.agents.length)
    }
    return m
  }, [consensus])

  // Deliver a reconcile prompt for ONE conflict to the SELECTED agent, reusing
  // the EXACT relay drain the board injection uses (enqueueForTarget -> deliverRelay
  // -> window.canvasio.pty.write). No new delivery path, no IPC, no persistence.
  const reconcile = (conflict: Conflict): void => {
    if (!selected) return
    const prompt = formatReconcilePrompt(conflict)
    if (!prompt) return
    useRelay.getState().enqueueForTarget(selected.id, prompt)
  }

  // Recall — promote a board fact into the PERSISTED Cross-Mission memory. We
  // re-derive subject+value (the same consensus keys) so Recall can dedup + match
  // it later. Used by the per-row 'Recordar' button on corroborated facts.
  const rememberFact = (id: string): void => {
    const f = useBoard.getState().facts.find((x) => x.id === id)
    if (!f) return
    const subject = subjectKey(f.text) || undefined
    const value = subject ? assertedValue(f.text, subject) || undefined : undefined
    useRecall.getState().remember({
      text: f.text,
      subject,
      value,
      agent: f.agent,
      sourceTitle: f.sourceTitle
    })
  }

  // Remember EVERY corroborated fact at once. One distinct fact per corroborated
  // value is enough; remember() dedups by subject+value so duplicates collapse.
  const rememberAllCorroborated = (): void => {
    for (const c of consensus.corroborated) {
      for (const fid of c.factIds) rememberFact(fid)
    }
  }

  const listRef = useRef<HTMLDivElement>(null)

  // Open / toggle on the shared event so App.tsx + the palette can drive it.
  useEffect(() => {
    const onOpen = (): void => setOpen((v) => !v)
    window.addEventListener('canvasio:open-board', onOpen)
    return () => window.removeEventListener('canvasio:open-board', onOpen)
  }, [])

  // Esc closes while open (capture phase so it wins over App's plain-key shortcuts).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        const t = e.target as HTMLElement | null
        // Don't steal Esc from the add-fact input's own blur/clear if it's focused;
        // but with nothing else to handle, close the panel.
        if (t && t.closest?.('.brief-board')) {
          e.preventDefault()
          setOpen(false)
        } else {
          setOpen(false)
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  if (!open) return null

  const addFact = (): void => {
    const text = draft.trim()
    if (!text) return
    useBoard.getState().pin({ text })
    setDraft('')
  }

  const inject = (): void => {
    if (!selected) return
    const liveFacts = useBoard.getState().facts
    const block = formatBoardForInjection(liveFacts)
    if (!block) return
    // Reuse the proven relay drain: enqueue the composed block for the selected
    // node; deliverRelay (in TerminalOverlay) writes it via window.canvasio.pty.write
    // once the terminal's classifier reports it idle/ready (and has worked once).
    useRelay.getState().enqueueForTarget(selected.id, block)
    // Context Sync — record WHICH facts this node just consumed, so a later
    // supersession of any of their subjects can correct it (the Fact Invalidation
    // Bus). In-memory only; the one-line consumption ledger entry off the
    // persistence path. Same liveFacts that were composed into the block above.
    useContextSync.getState().recordInjection(selected.id, liveFacts)
  }

  return (
    <div
      className="glass no-drag brief-board"
      style={{
        pointerEvents: 'auto',
        position: 'absolute',
        top: 46,
        right: 16,
        borderRadius: 14,
        padding: 14,
        width: 360,
        maxHeight: '74vh',
        display: 'flex',
        flexDirection: 'column',
        fontSize: 13,
        color: '#d7e1f7',
        zIndex: 60
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontWeight: 700, fontSize: 14 }}>Brief Board</span>
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
          {t('briefBoard.shared_context')}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 10.5, color: '#6f84ad' }}>
          {facts.length} {facts.length === 1 ? t('briefBoard.fact_one') : t('briefBoard.fact_many')}
        </span>
        <button
          onClick={() => setOpen(false)}
          aria-label={t('briefBoard.close_aria')}
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

      {/* Consensus Lens — amber contradiction chips. One per conflicting subject.
          Clicking "Reconciliar" fires the existing relay drain to ask the selected
          agent to reconcile, injecting both attributed claims. */}
      {consensus.conflicts.length > 0 && (
        <div style={{ marginBottom: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {consensus.conflicts.map((k) => {
            const a = k.claims[0]?.agent ?? '?'
            const b = k.claims[1]?.agent ?? '?'
            return (
              <div
                key={k.subject}
                title={k.claims.map((c) => `${c.agent}: "${c.value}"`).join('  vs  ')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 9px',
                  borderRadius: 10,
                  background: 'rgba(255,176,32,0.12)',
                  border: '1px solid rgba(255,176,32,0.45)'
                }}
              >
                <span style={{ fontSize: 12, color: '#ffce7a', fontWeight: 700 }}>⚠ {t('briefBoard.consensus')}</span>
                <span
                  style={{
                    fontSize: 11.5,
                    color: '#ffe0ad',
                    flex: '1 1 0',
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {a} vs {b} — {k.subject}
                </span>
                <button
                  onClick={() => reconcile(k)}
                  disabled={!selected}
                  title={
                    selected
                      ? t('briefBoard.reconcile_title', { agent: selected.title, subject: k.subject })
                      : t('briefBoard.reconcile_no_agent')
                  }
                  style={{
                    flex: '0 0 auto',
                    background: selected ? 'rgba(255,176,32,0.22)' : 'rgba(120,150,220,0.1)',
                    color: selected ? '#ffce7a' : '#6f84ad',
                    border: selected
                      ? '1px solid rgba(255,176,32,0.55)'
                      : '1px solid rgba(120,150,220,0.18)',
                    borderRadius: 8,
                    padding: '3px 9px',
                    fontWeight: 700,
                    fontSize: 11,
                    cursor: selected ? 'pointer' : 'default'
                  }}
                >
                  {t('briefBoard.reconcile')}
                </button>
              </div>
            )
          })}
        </div>
      )}

      {/* Facts list */}
      <div ref={listRef} style={{ overflowY: 'auto', flex: '1 1 auto', minHeight: 0 }}>
        {facts.length === 0 ? (
          <div style={{ fontSize: 12, color: '#6f84ad', padding: '4px 0' }}>
            {t('briefBoard.empty')}
          </div>
        ) : (
          facts.map((f) => (
            <div
              key={f.id}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                padding: '7px 9px',
                marginBottom: 5,
                borderRadius: 10,
                background: 'rgba(8,12,26,0.55)',
                border: '1px solid rgba(120,150,220,0.12)'
              }}
            >
              <div style={{ flex: '1 1 0', minWidth: 0 }}>
                {f.harvested && (
                  <span
                    title={t('briefBoard.harvested_title')}
                    aria-label={t('briefBoard.harvested_aria')}
                    style={{
                      display: 'inline-block',
                      marginRight: 5,
                      fontSize: 10,
                      lineHeight: 1.4,
                      verticalAlign: 'middle',
                      color: '#ffd479'
                    }}
                  >
                    ✦
                  </span>
                )}
                {(f.sourceTitle || f.agent) && (
                  <span
                    style={{
                      display: 'inline-block',
                      marginRight: 6,
                      fontSize: 10,
                      lineHeight: 1.4,
                      padding: '1px 6px',
                      borderRadius: 6,
                      color: '#cfe0ff',
                      background: 'rgba(122,162,255,0.16)',
                      border: '1px solid rgba(122,162,255,0.4)',
                      fontWeight: 700,
                      verticalAlign: 'middle'
                    }}
                  >
                    {f.sourceTitle || f.agent}
                  </span>
                )}
                <span style={{ fontSize: 12, color: '#d7e1f7', wordBreak: 'break-word' }}>
                  {f.text}
                </span>
                {agreeByFactId.has(f.id) && (
                  <span
                    title={t('briefBoard.corroborated_title')}
                    aria-label={t('briefBoard.corroborated_aria')}
                    style={{
                      display: 'inline-block',
                      marginLeft: 6,
                      fontSize: 10,
                      lineHeight: 1.4,
                      padding: '1px 6px',
                      borderRadius: 6,
                      color: '#9af0c6',
                      background: 'rgba(72,213,151,0.16)',
                      border: '1px solid rgba(72,213,151,0.5)',
                      fontWeight: 700,
                      verticalAlign: 'middle',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    ✓ {t('briefBoard.agents_agree', { count: agreeByFactId.get(f.id) ?? 0 })}
                  </span>
                )}
              </div>
              {agreeByFactId.has(f.id) && (
                <button
                  onClick={() => rememberFact(f.id)}
                  aria-label={t('briefBoard.remember_fact_aria')}
                  title={t('briefBoard.remember_fact_title')}
                  style={{
                    flex: '0 0 auto',
                    background: 'none',
                    border: 'none',
                    color: '#9af0c6',
                    cursor: 'pointer',
                    fontSize: 13,
                    lineHeight: 1
                  }}
                >
                  ✦
                </button>
              )}
              <button
                onClick={() => useBoard.getState().remove(f.id)}
                aria-label={t('briefBoard.remove_aria')}
                title={t('briefBoard.remove')}
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
          ))
        )}
      </div>

      {/* Add a fact */}
      <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              addFact()
            }
          }}
          placeholder={t('briefBoard.add_placeholder')}
          aria-label={t('briefBoard.add_aria')}
          style={{
            flex: '1 1 0',
            minWidth: 0,
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(124,151,224,0.4)',
            borderRadius: 8,
            padding: '6px 9px',
            color: '#eaf1ff',
            fontSize: 12.5,
            outline: 'none'
          }}
        />
        <button
          onClick={addFact}
          disabled={!draft.trim()}
          style={{
            flex: '0 0 auto',
            background: draft.trim() ? '#7aa2ff' : 'rgba(122,162,255,0.25)',
            color: draft.trim() ? '#0b1326' : '#8fa3cc',
            border: 'none',
            borderRadius: 8,
            padding: '6px 12px',
            fontWeight: 700,
            fontSize: 12.5,
            cursor: draft.trim() ? 'pointer' : 'default'
          }}
        >
          {t('briefBoard.pin')}
        </button>
      </div>

      {/* Recall — remember everything the team has corroborated, into persisted
          Cross-Mission memory. Only shown when there is something agreed-upon to
          remember (precision: corroboration is the quality gate). */}
      {consensus.corroborated.length > 0 && (
        <button
          onClick={rememberAllCorroborated}
          title={t('briefBoard.remember_all_title')}
          style={{
            marginTop: 8,
            width: '100%',
            background: 'rgba(72,213,151,0.14)',
            color: '#9af0c6',
            border: '1px solid rgba(72,213,151,0.45)',
            borderRadius: 10,
            padding: '8px 12px',
            fontWeight: 700,
            fontSize: 12.5,
            cursor: 'pointer'
          }}
        >
          ✦ {t('briefBoard.remember_all')}
        </button>
      )}

      {/* Inject into selected agent */}
      <button
        onClick={inject}
        disabled={!selected || facts.length === 0}
        title={
          !selected
            ? t('briefBoard.inject_no_agent')
            : facts.length === 0
              ? t('briefBoard.inject_empty')
              : t('briefBoard.inject_title', { agent: selected.title })
        }
        style={{
          marginTop: 8,
          width: '100%',
          background: selected && facts.length ? 'rgba(72,213,151,0.18)' : 'rgba(120,150,220,0.1)',
          color: selected && facts.length ? '#9af0c6' : '#6f84ad',
          border:
            selected && facts.length
              ? '1px solid rgba(72,213,151,0.5)'
              : '1px solid rgba(120,150,220,0.18)',
          borderRadius: 10,
          padding: '8px 12px',
          fontWeight: 700,
          fontSize: 12.5,
          cursor: selected && facts.length ? 'pointer' : 'default'
        }}
      >
        {selected ? t('briefBoard.inject_button', { agent: selected.title }) : t('briefBoard.inject_button_no_agent')}
      </button>
    </div>
  )
}
