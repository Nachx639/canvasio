import { useEffect, useRef, useState } from 'react'
import { useCanvas, type AgentKind } from '../store/canvas'
import { useTripwire, type Tripwire, type TripwireHit } from '../store/tripwire'
import { AGENT_COLOR } from './MissionLog'
import { useT } from '../store/i18n'

/**
 * Tripwire Panel — a compact, keyboard-first manager for content-triggered
 * output alerts. Add a watch pattern (plain text or `/regex/flags`), arm/disarm
 * it, flip once-vs-repeat, and review the recent hit feed; pressing Enter on a
 * hit flies the camera to the firing agent (centerOnNode) and marks it seen.
 *
 * Keyboard model (mirrors ChangesetLens / AgentLensHud capture-phase handler so
 * plain-key app shortcuts never fire while open):
 *   ↑/↓     move the selection across the hit feed
 *   Enter   jump to the selected hit's agent (camera) + mark it seen
 *   Esc     close (or blur the add-input first if it's focused)
 * The add-input owns its own keys (text/`/regex/`); the global keydown guard in
 * App.tsx already excludes INPUT, so typing a pattern never triggers hotkeys.
 *
 * Opened via the 'canvasio:open-tripwire' CustomEvent (W / the Command Palette).
 * Purely renderer-side: it READS the tripwire/canvas stores and CALLS their
 * actions + centerOnNode — no IPC, no geometry mutation, no persistence.
 */
export function TripwirePanel(): JSX.Element | null {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const wires = useTripwire((s) => s.wires)
  const hits = useTripwire((s) => s.hits)

  // Newest-first hit feed for display + navigation.
  const feed = [...hits].reverse()

  // Open / toggle on the shared event; mark everything seen on open so the toast
  // clears and the badge resets (the operator is now looking at the feed).
  useEffect(() => {
    const onOpen = (): void => {
      setOpen((v) => {
        const next = !v
        if (next) {
          setActive(0)
          useTripwire.getState().markAllSeen()
        }
        return next
      })
    }
    window.addEventListener('canvasio:open-tripwire', onOpen)
    return () => window.removeEventListener('canvasio:open-tripwire', onOpen)
  }, [])

  // Clamp the active row whenever the feed shrinks.
  useEffect(() => {
    setActive((a) => (feed.length === 0 ? 0 : Math.min(a, feed.length - 1)))
  }, [feed.length])

  // Keyboard navigation while open (capture phase, like ChangesetLens). When the
  // add-input is focused we let it own typing entirely (only Esc blurs it).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      const inInput = document.activeElement === inputRef.current
      if (e.key === 'Escape') {
        e.preventDefault()
        if (inInput) inputRef.current?.blur()
        else setOpen(false)
        return
      }
      if (inInput) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((a) => (feed.length ? (a + 1) % feed.length : 0))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((a) => (feed.length ? (a - 1 + feed.length) % feed.length : 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const hit = feed[active]
        if (hit) {
          useCanvas.getState().centerOnNode(hit.nodeId)
          useTripwire.getState().markSeen(hit.id)
          setOpen(false)
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, feed, active])

  // Keep the selected hit row scrolled into view.
  useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  if (!open) return null

  const submitDraft = (): void => {
    const raw = draft.trim()
    if (!raw) return
    useTripwire.getState().add(raw)
    setDraft('')
  }

  return (
    <div
      className="glass no-drag"
      data-overlay="tripwire"
      style={{
        pointerEvents: 'auto',
        position: 'absolute',
        top: 46,
        left: '50%',
        transform: 'translateX(-50%)',
        borderRadius: 14,
        padding: 14,
        width: 520,
        maxHeight: '74vh',
        overflowY: 'auto',
        fontSize: 13,
        color: '#efe6cf',
        zIndex: 60
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontWeight: 700, fontSize: 14, color: '#f4ecd6' }}>Tripwire</span>
        <span
          style={{
            marginLeft: 8,
            fontSize: 10.5,
            color: '#c4b482',
            border: '1px solid rgba(242,200,75,0.24)',
            borderRadius: 6,
            padding: '1px 6px'
          }}
        >
          {t('tripwirePanel.content_alerts')}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 10.5, color: '#b9a877' }}>
          {t('tripwirePanel.kbd_hint')}
        </span>
        <button
          onClick={() => setOpen(false)}
          aria-label={t('tripwirePanel.close_aria')}
          title={t('common.close')}
          style={{
            marginLeft: 10,
            background: 'none',
            border: 'none',
            color: '#c4b482',
            cursor: 'pointer'
          }}
        >
          ✕
        </button>
      </div>

      {/* add-input */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submitDraft()
            }
          }}
          placeholder={t('tripwirePanel.input_placeholder')}
          spellCheck={false}
          autoComplete="off"
          style={{
            flex: 1,
            background: 'rgba(8,10,16,0.6)',
            border: '1px solid rgba(242,200,75,0.28)',
            borderRadius: 9,
            padding: '7px 10px',
            color: '#f4ecd6',
            fontSize: 12.5,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            outline: 'none'
          }}
        />
        <button
          onClick={submitDraft}
          title={t('tripwirePanel.add_trigger_title')}
          style={{
            cursor: 'pointer',
            fontSize: 12,
            fontWeight: 700,
            padding: '7px 12px',
            borderRadius: 9,
            color: '#0c0f14',
            background: '#f2c84b',
            border: 'none'
          }}
        >
          {t('tripwirePanel.add')}
        </button>
      </div>

      {/* wire list */}
      <div style={{ marginBottom: 14 }}>
        {wires.length === 0 ? (
          <div style={{ fontSize: 12, color: '#b9a877', padding: '2px 0 6px' }}>
            {t('tripwirePanel.empty_wires_before')} <em>tests passed</em>
            {t('tripwirePanel.empty_wires_mid')} <em>/regex/</em>
            {t('tripwirePanel.empty_wires_after')}
          </div>
        ) : (
          wires.map((w) => <WireRow key={w.id} wire={w} />)
        )}
        {wires.length > 0 && (
          <button
            onClick={() => useTripwire.getState().clearWires()}
            title={t('tripwirePanel.clear_all_title')}
            style={{
              marginTop: 8,
              cursor: 'pointer',
              fontSize: 10.5,
              fontWeight: 600,
              padding: '3px 9px',
              borderRadius: 8,
              color: '#c4b482',
              background: 'transparent',
              border: '1px solid rgba(242,200,75,0.22)'
            }}
          >
            {t('tripwirePanel.clear_all')}
          </button>
        )}
      </div>

      {/* hit feed */}
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 800,
          letterSpacing: '0.1em',
          color: '#b9a877',
          marginBottom: 6
        }}
      >
        {t('tripwirePanel.recent_alerts')}
      </div>
      <div ref={listRef}>
        {feed.length === 0 ? (
          <div style={{ fontSize: 12, color: '#b9a877', padding: '2px 0' }}>
            {t('tripwirePanel.no_alerts_yet')}
          </div>
        ) : (
          feed.map((h, i) => <HitRow key={h.id} hit={h} active={i === active} index={i} />)
        )}
      </div>
    </div>
  )
}

function WireRow({ wire }: { wire: Tripwire }): JSX.Element {
  const t = useT()
  const tw = useTripwire.getState()
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 8px',
        borderRadius: 9,
        marginBottom: 4,
        background: 'rgba(8,12,18,0.5)',
        border: '1px solid rgba(242,200,75,0.12)',
        opacity: wire.armed ? 1 : 0.55
      }}
    >
      <button
        onClick={() => tw.toggleArm(wire.id)}
        title={wire.armed ? t('tripwirePanel.disarm') : t('tripwirePanel.arm')}
        aria-pressed={wire.armed}
        style={{
          cursor: 'pointer',
          width: 9,
          height: 9,
          borderRadius: '50%',
          padding: 0,
          flex: '0 0 auto',
          background: wire.armed ? '#f2c84b' : 'transparent',
          border: '1px solid rgba(242,200,75,0.6)'
        }}
      />
      <span
        style={{
          flex: '1 1 0',
          minWidth: 0,
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 12,
          color: '#f4ecd6'
        }}
        title={wire.pattern}
      >
        {wire.label ?? wire.pattern}
      </span>
      <span
        style={{
          fontSize: 9.5,
          color: wire.compiled.kind === 'regex' ? '#7be0a8' : '#9fb0c8',
          flex: '0 0 auto'
        }}
      >
        {wire.compiled.kind === 'regex' ? 'regex' : t('tripwirePanel.kind_text')}
      </span>
      <button
        onClick={() => tw.toggleOnce(wire.id)}
        title={wire.once ? t('tripwirePanel.once_title') : t('tripwirePanel.repeat_title')}
        aria-pressed={wire.once}
        style={{
          cursor: 'pointer',
          fontSize: 9.5,
          fontWeight: 700,
          letterSpacing: '0.06em',
          padding: '2px 6px',
          borderRadius: 7,
          flex: '0 0 auto',
          color: wire.once ? '#0c0f14' : '#9fb0c8',
          background: wire.once ? '#f2c84b' : 'transparent',
          border: '1px solid rgba(242,200,75,0.3)'
        }}
      >
        {wire.once ? '1×' : '∞'}
      </button>
      <button
        onClick={() => tw.remove(wire.id)}
        title={t('tripwirePanel.remove')}
        aria-label={t('tripwirePanel.remove_trigger_aria')}
        style={{
          cursor: 'pointer',
          background: 'none',
          border: 'none',
          color: '#c4b482',
          fontSize: 12,
          flex: '0 0 auto'
        }}
      >
        ✕
      </button>
    </div>
  )
}

function HitRow({
  hit,
  active,
  index
}: {
  hit: TripwireHit
  active: boolean
  index: number
}): JSX.Element {
  const t = useT()
  const accent = hit.agent ? AGENT_COLOR[hit.agent as AgentKind] ?? '#f2c84b' : '#f2c84b'
  const jump = (): void => {
    useCanvas.getState().centerOnNode(hit.nodeId)
    useTripwire.getState().markSeen(hit.id)
  }
  return (
    <button
      type="button"
      data-active={active}
      onClick={jump}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        width: '100%',
        textAlign: 'left',
        padding: '7px 10px',
        borderRadius: 9,
        marginBottom: 4,
        background: active ? 'rgba(242,200,75,0.16)' : 'rgba(8,12,18,0.45)',
        border: active
          ? '1px solid rgba(242,200,75,0.5)'
          : '1px solid rgba(242,200,75,0.1)',
        color: '#efe6cf',
        cursor: 'pointer',
        opacity: hit.seen ? 0.7 : 1
      }}
    >
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: accent,
          flex: '0 0 auto',
          marginTop: 4
        }}
      />
      <span style={{ flex: '1 1 0', minWidth: 0 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span
            style={{
              fontWeight: 700,
              color: accent,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              maxWidth: 150
            }}
          >
            {hit.title}
          </span>
          {!hit.seen && index === 0 && (
            <span style={{ fontSize: 9, color: '#f2c84b', fontWeight: 700 }}>
              {t('tripwirePanel.new')}
            </span>
          )}
        </span>
        <span
          style={{
            display: 'block',
            fontSize: 11.5,
            color: '#e7ddc4',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            lineHeight: 1.4,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {hit.line}
        </span>
      </span>
    </button>
  )
}
