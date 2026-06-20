import { useEffect, useRef, useState } from 'react'
import { useCanvas } from '../store/canvas'
import { useMission } from '../store/mission'
import { useLens } from '../store/lens'
import { buildReplyTargets, type ReplyTarget } from '../lib/replyTargets'
import { submitToPty } from '../lib/ptySubmit'
import { STATUS_COLOR } from './NodeView'
import { useT } from '../store/i18n'

/**
 * Reply Rail — a keyboard-first "needs-you" inbox to unblock agents IN PLACE.
 *
 * Every other observability surface (status dot, Mission Pulse, Pulse Radar,
 * Triage Chip, Director) only POINTS at a blocked agent — to actually unblock it
 * you must fly the camera, click into the terminal, and type. Reply Rail closes
 * that loop: it lists every agent currently in the `waiting` state (derived purely
 * by buildReplyTargets from nodes + mission events), each row showing its status
 * dot + name + the exact prompt line the Agent Lens captured ("Allow `rm -rf
 * build`? (y/n)"). You ANSWER straight from the rail — y / n / Enter quick-actions
 * (and y/n/Enter keys) write to that agent's pty via the existing
 * window.canvasio.pty.write bridge; a free-text field handles non-yes/no prompts.
 *
 * Opened via the 'canvasio:open-reply' CustomEvent (dispatched by the plain 'R'
 * key in App.tsx and the Command Palette), mirroring AgentLensHud + 'canvasio:
 * open-lens'. Purely renderer-side and additive: it READS canvas/mission/lens and
 * WRITES only through the existing pty.write IPC (no new channel, no main-process
 * change), mutates no geometry, and is never serialized. Hidden when the queue is
 * empty so a calm canvas shows zero chrome.
 */
export function ReplyRail(): JSX.Element | null {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [draft, setDraft] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const nodes = useCanvas((s) => s.nodes)
  const events = useMission((s) => s.events)
  const lines = useLens((s) => s.lines)

  // Pure derivation: the ordered inbox of agents blocked on the user. SKIP the
  // O(events)+O(nodes)+sort fold entirely while the rail is CLOSED. This
  // component subscribes to `lines` (the Agent Lens store), which updates on
  // every coalesced terminal-output flush (~5 Hz per active agent), so without
  // this gate the full derivation ran on every flush even though the closed rail
  // renders null. The downstream effects (clamp/auto-close/keyboard) are all
  // no-ops on an empty array while closed, so behavior is unchanged.
  const targets = open ? buildReplyTargets(nodes, events, lines, Date.now()) : []

  // Open / toggle on the shared event so App.tsx + the palette can drive it.
  useEffect(() => {
    const onOpen = (): void => setOpen((v) => !v)
    window.addEventListener('canvasio:open-reply', onOpen)
    return () => window.removeEventListener('canvasio:open-reply', onOpen)
  }, [])

  // Clamp the active row whenever the queue shrinks (an agent got unblocked).
  useEffect(() => {
    setActive((a) => (targets.length === 0 ? 0 : Math.min(a, targets.length - 1)))
  }, [targets.length])

  // Auto-close when the queue empties while open (you cleared the inbox).
  useEffect(() => {
    if (open && targets.length === 0) setOpen(false)
  }, [open, targets.length])

  // Write a response to the selected (or given) agent's pty, then optimistically
  // mark it working — exactly as TerminalOverlay does after delivering an initial
  // prompt — and let the next classify settle the real status.
  const answer = (t: ReplyTarget | undefined, data: string): void => {
    if (!t) return
    window.canvasio.pty.write(t.nodeId, data)
    useCanvas.getState().updateNode(t.nodeId, { status: 'working' })
    setDraft('')
  }

  // Submit a free-text reply: write the TEXT then Enter SEPARATELY so an agent
  // TUI (notably Codex) actually submits a multi-character message — a combined
  // text+'\r' chunk leaves the input box unsent (see submitToPty), matching the
  // proven send_to_agent / relay delivery path. The single-key y/n/Enter answers
  // above stay raw (one interactive keystroke), which Codex handles fine.
  const submitDraft = (t: ReplyTarget | undefined): void => {
    if (!t || !draft) return
    submitToPty(t.nodeId, draft)
    useCanvas.getState().updateNode(t.nodeId, { status: 'working' })
    setDraft('')
  }

  // Keyboard navigation while open. Registered at the window (capture phase) so it
  // works without the panel holding DOM focus and wins over App's plain-key
  // shortcuts — but we YIELD when the free-text field is focused so typing there
  // (including y/n/Enter) is never hijacked.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      const typingHere = e.target === inputRef.current
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
        return
      }
      if (typingHere) return // the input owns its own keys (handled in JSX)
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((a) => (targets.length ? (a + 1) % targets.length : 0))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((a) => (targets.length ? (a - 1 + targets.length) % targets.length : 0))
      } else if (e.key === 'y' || e.key === 'Y') {
        e.preventDefault()
        answer(targets[active], 'y\r')
      } else if (e.key === 'n' || e.key === 'N') {
        e.preventDefault()
        answer(targets[active], 'n\r')
      } else if (e.key === 'Enter') {
        e.preventDefault()
        answer(targets[active], '\r')
      } else if (e.key === 'g' || e.key === 'G') {
        // Inspect-first: fly the camera to the selected agent (keep the rail open).
        e.preventDefault()
        const t = targets[active]
        if (t) useCanvas.getState().centerOnNode(t.nodeId)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, targets, active])

  // Keep the selected row scrolled into view.
  useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  // Hidden entirely when there is nothing to answer (calm canvas = zero chrome).
  if (!open || targets.length === 0) return null

  const selected = targets[active]

  return (
    <div
      className="glass no-drag"
      style={{
        pointerEvents: 'auto',
        position: 'absolute',
        top: 46,
        left: '50%',
        transform: 'translateX(-50%)',
        borderRadius: 14,
        padding: 14,
        width: 460,
        maxHeight: '70vh',
        overflowY: 'auto',
        fontSize: 13,
        color: '#d7e1f7',
        zIndex: 60
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontWeight: 700, fontSize: 14 }}>Reply Rail</span>
        <span
          style={{
            marginLeft: 8,
            fontSize: 10.5,
            color: '#ffd27a',
            border: '1px solid rgba(255,200,110,0.3)',
            borderRadius: 6,
            padding: '1px 6px'
          }}
        >
          {targets.length === 1
            ? t('replyRail.needs_you_one', { count: targets.length })
            : t('replyRail.needs_you_many', { count: targets.length })}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 10.5, color: '#6f84ad' }}>
          {t('replyRail.keyboard_hint')}
        </span>
        <button
          onClick={() => setOpen(false)}
          aria-label={t('replyRail.close_aria')}
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

      <div ref={listRef}>
        {targets.map((t, i) => (
          <ReplyRow
            key={t.nodeId}
            target={t}
            active={i === active}
            onHover={() => setActive(i)}
            onAnswer={(data) => answer(t, data)}
            onGo={() => useCanvas.getState().centerOnNode(t.nodeId)}
          />
        ))}
      </div>

      {/* Free-text answer for non-yes/no prompts, targeting the selected row. */}
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              e.stopPropagation()
              submitDraft(selected)
            }
          }}
          placeholder={t('replyRail.reply_placeholder', {
            target: selected?.title ?? t('replyRail.agent_fallback')
          })}
          aria-label={t('replyRail.free_reply_aria')}
          style={{
            flex: '1 1 0',
            minWidth: 0,
            background: 'rgba(8,12,26,0.6)',
            border: '1px solid rgba(120,150,220,0.2)',
            borderRadius: 9,
            padding: '7px 10px',
            color: '#eaf1ff',
            fontSize: 12.5,
            outline: 'none'
          }}
        />
        <button
          type="button"
          onClick={() => submitDraft(selected)}
          style={{
            flex: '0 0 auto',
            background: 'rgba(124,151,224,0.22)',
            border: '1px solid rgba(122,162,255,0.45)',
            borderRadius: 9,
            padding: '7px 12px',
            color: '#eaf1ff',
            cursor: 'pointer',
            fontSize: 12.5
          }}
        >
          {t('replyRail.send')}
        </button>
      </div>
    </div>
  )
}

function ReplyRow({
  target,
  active,
  onHover,
  onAnswer,
  onGo
}: {
  target: ReplyTarget
  active: boolean
  onHover: () => void
  onAnswer: (data: string) => void
  onGo: () => void
}): JSX.Element {
  const t = useT()
  // The node is provably 'waiting'; show it with its current visual status dot.
  const node = useCanvas((s) => s.nodes.find((n) => n.id === target.nodeId))
  const statusColor = STATUS_COLOR[node?.status ?? 'working']

  const quick = (
    label: string,
    data: string,
    accent: string
  ): JSX.Element => (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onAnswer(data)
      }}
      style={{
        flex: '0 0 auto',
        background: 'rgba(8,12,26,0.6)',
        border: `1px solid ${accent}`,
        borderRadius: 8,
        padding: '3px 9px',
        color: '#eaf1ff',
        cursor: 'pointer',
        fontSize: 11.5,
        fontWeight: 700
      }}
    >
      {label}
    </button>
  )

  return (
    <div
      data-active={active}
      onPointerEnter={onHover}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        width: '100%',
        padding: '7px 10px',
        marginBottom: 6,
        borderRadius: 10,
        background: active ? 'rgba(124,151,224,0.18)' : 'rgba(8,12,26,0.55)',
        border: active ? '1px solid rgba(122,162,255,0.55)' : '1px solid rgba(120,150,220,0.12)'
      }}
    >
      <span
        style={{
          flex: '0 0 auto',
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: statusColor,
          boxShadow: `0 0 7px ${statusColor}`
        }}
      />
      <div style={{ flex: '1 1 0', minWidth: 0 }}>
        <button
          type="button"
          onClick={onGo}
          title={t('replyRail.go_to_agent')}
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            color: '#eaf1ff',
            fontWeight: 700,
            cursor: 'pointer',
            maxWidth: '100%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            display: 'block',
            textAlign: 'left'
          }}
        >
          {target.title}
        </button>
        <div
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 11.5,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontStyle: target.prompt ? 'normal' : 'italic',
            color: target.prompt ? '#ffd9a8' : '#6f84ad'
          }}
        >
          {target.prompt ?? t('replyRail.awaiting_reply')}
        </div>
      </div>
      <div style={{ flex: '0 0 auto', display: 'flex', gap: 6 }}>
        {quick(t('replyRail.yes'), 'y\r', 'rgba(120,210,150,0.5)')}
        {quick(t('replyRail.no'), 'n\r', 'rgba(230,130,130,0.5)')}
        {quick('↵', '\r', 'rgba(122,162,255,0.45)')}
      </div>
    </div>
  )
}
