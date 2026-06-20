import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useCanvas, type CanvasNode } from '../store/canvas'
import { useLens } from '../store/lens'
import { useT } from '../store/i18n'
import { STATUS_COLOR } from './NodeView'

/**
 * Agent Lens HUD — a compact, keyboard-first panel answering "what is every
 * agent doing RIGHT NOW" from across the whole canvas without moving the camera.
 * Lists every terminal node as status-dot + name + its live last output line
 * (from the lens store). Keyboard: ↑/↓ move the selection, Enter flies the
 * camera to the selected node (centerOnNode) and closes, Esc closes.
 *
 * Opened via the 'canvasio:open-lens' CustomEvent (dispatched by the 'L' key in
 * App.tsx and the Command Palette), mirroring the MissionLog + 'canvasio:open-
 * mission' pattern. Purely renderer-side and additive: it READS nodes + lens
 * lines and CALLS centerOnNode — no IPC, no geometry mutation, no persistence.
 */
export function AgentLensHud(): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const t = useT()

  const nodes = useCanvas(useShallow((s) => s.nodes))
  const lines = useLens((s) => s.lines)
  const terminals = nodes.filter((n) => n.kind === 'terminal')

  // Open / toggle on the shared event so App.tsx + the palette can drive it.
  useEffect(() => {
    const onOpen = (): void => setOpen((v) => !v)
    window.addEventListener('canvasio:open-lens', onOpen)
    return () => window.removeEventListener('canvasio:open-lens', onOpen)
  }, [])

  // Clamp the active row whenever the agent list shrinks.
  useEffect(() => {
    setActive((a) => (terminals.length === 0 ? 0 : Math.min(a, terminals.length - 1)))
  }, [terminals.length])

  // Keyboard navigation while open. Registered at the window so it works without
  // the panel holding DOM focus; we stop here before App's global shortcuts run.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((a) => (terminals.length ? (a + 1) % terminals.length : 0))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((a) => (terminals.length ? (a - 1 + terminals.length) % terminals.length : 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const n = terminals[active]
        if (n) {
          useCanvas.getState().centerOnNode(n.id)
          setOpen(false)
        }
      }
    }
    // Capture phase so we win over the app's plain-key shortcuts (1..9, F, …).
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, terminals, active])

  // Keep the selected row scrolled into view.
  useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  if (!open) return null

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
        width: 420,
        maxHeight: '70vh',
        overflowY: 'auto',
        fontSize: 13,
        color: '#d7e1f7',
        zIndex: 60
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontWeight: 700, fontSize: 14 }}>Agent Lens</span>
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
          {t('agentLensHud.live')}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 10.5, color: '#6f84ad' }}>
          {t('agentLensHud.shortcuts')}
        </span>
        <button
          onClick={() => setOpen(false)}
          aria-label={t('agentLensHud.close_aria')}
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

      {terminals.length === 0 ? (
        <div style={{ fontSize: 12, color: '#6f84ad', padding: '4px 0' }}>
          {t('agentLensHud.empty')}
        </div>
      ) : (
        <div ref={listRef}>
          {terminals.map((n, i) => (
            <LensRow
              key={n.id}
              node={n}
              text={lines[n.id]?.text}
              active={i === active}
              onHover={() => setActive(i)}
              onClick={() => {
                useCanvas.getState().centerOnNode(n.id)
                setOpen(false)
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function LensRow({
  node,
  text,
  active,
  onHover,
  onClick
}: {
  node: CanvasNode
  text?: string
  active: boolean
  onHover: () => void
  onClick: () => void
}): JSX.Element {
  const t = useT()
  const statusColor = STATUS_COLOR[node.status ?? 'idle']
  return (
    <button
      type="button"
      data-active={active}
      onPointerEnter={onHover}
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        width: '100%',
        textAlign: 'left',
        padding: '7px 10px',
        marginBottom: 5,
        borderRadius: 10,
        background: active ? 'rgba(124,151,224,0.18)' : 'rgba(8,12,26,0.55)',
        border: active ? '1px solid rgba(122,162,255,0.55)' : '1px solid rgba(120,150,220,0.12)',
        color: '#d7e1f7',
        cursor: 'pointer'
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
      <span style={{ flex: '0 0 auto', fontWeight: 700, color: '#eaf1ff', maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {node.title}
      </span>
      <span
        style={{
          flex: '1 1 0',
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: 11.5,
          fontStyle: text ? 'italic' : 'normal',
          color: text ? '#aebbd6' : '#6f84ad'
        }}
      >
        {text ?? t('agentLensHud.no_activity')}
      </span>
    </button>
  )
}
