import { useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../store/i18n'
import { useCanvas, type CanvasNode } from '../store/canvas'
import { useCatchup } from '../store/catchup'
import { useMission } from '../store/mission'
import { useEcho } from '../store/echo'
import { useCommandTrail } from '../store/commandTrail'
import { useChangeset } from '../store/changeset'
import { STATUS_COLOR } from './NodeView'
import type { CatchupDelta, CatchupItem } from '../lib/catchup'

/**
 * Catch-Up panel — a keyboard-first "morning standup for the last 90 seconds".
 * Lists every agent with UNREAD activity (newest-delta-first), each row a compact
 * "since you left" timeline synthesized from the four substrates CanvasIO already
 * captures (Mission Pulse status, Command Trail, Changeset, Echo) joined against
 * the per-node read-marker (visits.lastTs). It turns alt-tabbing back into the
 * canvas from a re-orientation cost into a two-keystroke review.
 *
 * Opened via the 'canvasio:open-catchup' CustomEvent (⌘U / the Command Palette),
 * exactly like ChangesetLens' 'canvasio:open-changeset'. Keyboard model (capture
 * phase, mirroring ChangesetLens so plain-key app shortcuts never fire while open):
 *   j / ↓   move selection down the flattened agent/timeline list
 *   k / ↑   move selection up
 *   Enter   on an AGENT row → fly there (centerOnNode), which CLEARS its unread
 *           on a FILE row    → open the existing Changeset diff for that file
 *   m       mark ALL caught-up (bump dismissedAt=now for every unread node)
 *   Esc     close
 *
 * Purely renderer-side: it READS the live substrates via the Catch-Up store's
 * pure selectors, CALLS centerOnNode, and re-dispatches the existing changeset
 * event — no geometry mutation, no persistence, no IPC.
 */

/** A flattened, navigable row: an agent header or one of its timeline items. */
type Row =
  | { type: 'agent'; node: CanvasNode; delta: CatchupDelta }
  | { type: 'item'; node: CanvasNode; item: CatchupItem }

const KIND_GLYPH: Record<CatchupItem['kind'], string> = {
  status: '◆',
  command: '⌘',
  output: '›',
  files: '✎'
}

function itemColor(item: CatchupItem): string {
  if (item.kind === 'status') {
    // Color by the stable MissionEvent kind, NOT the localized label.
    if (item.statusKind === 'error') return '#ff6b6b'
    if (item.statusKind === 'waiting') return '#f2c84b'
    if (item.statusKind === 'done') return '#48d597'
    return '#9fb2d8'
  }
  if (item.kind === 'command') {
    if (item.risk === 'destructive') return '#ff6b6b'
    if (item.risk === 'network') return '#7aa2ff'
    if (item.risk === 'vcs') return '#c08cff'
    return '#8fa3cc'
  }
  if (item.kind === 'files') return '#5fd0e6'
  return '#9fb2d8'
}

function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.round(m / 60)}h`
}

export function CatchUpPanel(): JSX.Element | null {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  // Subscribe to every input so the panel reflects live activity while open. We
  // hold the references so the memo recomputes whenever any substrate changes;
  // the actual join is the pure allUnread() selector.
  const nodes = useCanvas((s) => s.nodes)
  const visits = useCanvas((s) => s.visits)
  const events = useMission((s) => s.events)
  const echo = useEcho((s) => s.entries)
  const trail = useCommandTrail((s) => s.entries)
  const byNode = useChangeset((s) => s.byNode)
  const dismissedAt = useCatchup((s) => s.dismissedAt)

  // Build the flattened display model from the pure allUnread() selector.
  const { rows, agentRowCount } = useMemo(() => {
    const deltas = useCatchup.getState().allUnread()
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const rows: Row[] = []
    let agentRowCount = 0
    for (const d of deltas) {
      const node = byId.get(d.nodeId)
      if (!node) continue
      rows.push({ type: 'agent', node, delta: d })
      agentRowCount++
      for (const item of d.milestones) rows.push({ type: 'item', node, item })
    }
    return { rows, agentRowCount }
    // nodes + the subscribed substrate maps drive recompute; allUnread reads them.
  }, [nodes, visits, events, echo, trail, byNode, dismissedAt])

  // Toggle on the shared event.
  useEffect(() => {
    const onOpen = (): void => setOpen((v) => !v)
    window.addEventListener('canvasio:open-catchup', onOpen)
    return () => window.removeEventListener('canvasio:open-catchup', onOpen)
  }, [])

  // Clamp the active row whenever the list shrinks.
  useEffect(() => {
    setActive((a) => (rows.length === 0 ? 0 : Math.min(a, rows.length - 1)))
  }, [rows.length])


  // Keyboard navigation while open (capture phase, like ChangesetLens).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
      } else if (e.key === 'ArrowDown' || e.key === 'j' || e.key === 'J') {
        e.preventDefault()
        setActive((a) => (rows.length ? (a + 1) % rows.length : 0))
      } else if (e.key === 'ArrowUp' || e.key === 'k' || e.key === 'K') {
        e.preventDefault()
        setActive((a) => (rows.length ? (a - 1 + rows.length) % rows.length : 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const row = rows[active]
        if (!row) return
        if (row.type === 'item' && row.item.kind === 'files' && row.item.path) {
          // Open the existing Changeset diff focused on this agent's files.
          window.dispatchEvent(
            new CustomEvent('canvasio:open-changeset', { detail: { nodeId: row.node.id } })
          )
          setOpen(false)
        } else {
          // Fly to the agent — centerOnNode bumps visits.lastTs, clearing its unread.
          useCanvas.getState().centerOnNode(row.node.id)
          setOpen(false)
        }
      } else if (e.key === 'm' || e.key === 'M') {
        e.preventDefault()
        // Mark ALL caught-up without moving the camera (bump dismissedAt=now).
        const ids = rows.filter((r) => r.type === 'agent').map((r) => r.node.id)
        useCatchup.getState().dismissAll(ids)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, rows, active])

  // Keep the selected row scrolled into view.
  useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  if (!open) return null

  const now = Date.now()

  return (
    <div
      className="glass no-drag"
      data-overlay="catchup"
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
        color: '#d7e1f7',
        zIndex: 60
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontWeight: 700, fontSize: 14 }}>Catch-Up</span>
        <span
          style={{
            marginLeft: 8,
            fontSize: 10.5,
            color: '#ffd9a0',
            border: '1px solid rgba(242,168,75,0.3)',
            borderRadius: 6,
            padding: '1px 6px'
          }}
        >
          {t('catchUpPanel.unread_count', { count: agentRowCount })}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 10.5, color: '#6f84ad' }}>
          {t('catchUpPanel.keyboard_hint')}
        </span>
        <button
          onClick={() => setOpen(false)}
          aria-label={t('catchUpPanel.close_aria')}
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

      {rows.length === 0 ? (
        <div style={{ fontSize: 12, color: '#6f84ad', padding: '4px 0' }}>
          {t('catchUpPanel.empty_state')}
        </div>
      ) : (
        <div ref={listRef}>
          {rows.map((row, i) => {
            const isActive = i === active
            if (row.type === 'agent') {
              const statusColor = STATUS_COLOR[row.node.status ?? 'idle']
              return (
                <div
                  key={`agent:${row.node.id}`}
                  data-active={isActive}
                  onPointerEnter={() => setActive(i)}
                  onClick={() => {
                    useCanvas.getState().centerOnNode(row.node.id)
                    setOpen(false)
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 8px 5px',
                    marginTop: i === 0 ? 0 : 6,
                    cursor: 'pointer',
                    borderRadius: 8,
                    background: isActive ? 'rgba(242,168,75,0.16)' : 'transparent',
                    border: isActive
                      ? '1px solid rgba(242,168,75,0.5)'
                      : '1px solid transparent',
                    borderBottom: isActive
                      ? '1px solid rgba(242,168,75,0.5)'
                      : '1px solid rgba(120,150,220,0.12)'
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: statusColor,
                      boxShadow: `0 0 7px ${statusColor}`
                    }}
                  />
                  <span style={{ fontWeight: 700, color: '#eaf1ff' }}>{row.node.title}</span>
                  <span
                    style={{
                      fontSize: 10.5,
                      color: '#ffd9a0',
                      background: 'rgba(242,168,75,0.16)',
                      border: '1px solid rgba(242,168,75,0.4)',
                      borderRadius: 6,
                      padding: '1px 6px',
                      fontVariantNumeric: 'tabular-nums'
                    }}
                  >
                    ↺ {row.delta.unreadCount}
                  </span>
                  <span style={{ marginLeft: 'auto', fontSize: 10.5, color: '#6f84ad' }}>
                    {t('catchUpPanel.time_ago', { time: ago(row.delta.newestTs, now) })}
                  </span>
                </div>
              )
            }
            // timeline item row
            const item = row.item
            const color = itemColor(item)
            const isFile = item.kind === 'files' && !!item.path
            return (
              <div
                key={`item:${row.node.id}:${i}`}
                data-active={isActive}
                onPointerEnter={() => setActive(i)}
                onClick={() => {
                  if (isFile) {
                    window.dispatchEvent(
                      new CustomEvent('canvasio:open-changeset', {
                        detail: { nodeId: row.node.id }
                      })
                    )
                    setOpen(false)
                  } else {
                    useCanvas.getState().centerOnNode(row.node.id)
                    setOpen(false)
                  }
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '4px 10px 4px 18px',
                  cursor: 'pointer',
                  borderRadius: 8,
                  background: isActive ? 'rgba(124,151,224,0.18)' : 'transparent',
                  border: isActive
                    ? '1px solid rgba(122,162,255,0.55)'
                    : '1px solid transparent',
                  opacity: item.meaningful ? 1 : 0.72
                }}
              >
                <span style={{ flex: '0 0 auto', width: 14, textAlign: 'center', color }}>
                  {KIND_GLYPH[item.kind]}
                </span>
                <span
                  style={{
                    flex: '1 1 0',
                    minWidth: 0,
                    overflow: 'hidden',
                    whiteSpace: 'nowrap',
                    textOverflow: 'ellipsis',
                    color: '#d7e1f7',
                    fontFamily:
                      item.kind === 'command' || item.kind === 'output'
                        ? 'ui-monospace, SFMono-Regular, Menlo, monospace'
                        : undefined,
                    fontSize: item.kind === 'command' || item.kind === 'output' ? 12 : 12.5
                  }}
                >
                  {item.label}
                </span>
                {isFile && (
                  <span style={{ flex: '0 0 auto', fontSize: 10, color: '#6f84ad' }}>diff ↵</span>
                )}
                <span
                  style={{ flex: '0 0 auto', fontSize: 10, color: '#6f84ad', fontVariantNumeric: 'tabular-nums' }}
                >
                  {ago(item.ts, now)}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
