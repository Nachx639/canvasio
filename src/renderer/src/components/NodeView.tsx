import { memo, useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { CanvasNode, useCanvas, AgentKind, AGENT_LABEL, LOD_ZOOM } from '../store/canvas'
import { useRelay } from '../store/relay'
import { useLens } from '../store/lens'
import { useChangeset } from '../store/changeset'
import { useBoard } from '../store/board'
import { useEcho } from '../store/echo'
import { useMission } from '../store/mission'
import { useTimefold } from '../store/timefold'
import { useSnap } from '../store/snap'
import { promptText } from '../store/promptModal'
import { computeSnap, type SnapBox } from '../lib/snapGuides'
import { useT } from '../store/i18n'
import { lineAtTime, statusAtTime } from '../lib/timefold'
import { assessObjective, judgmentLabel, judgmentColor } from '../lib/objective'
import { MusicPlayer } from './MusicPlayer'
import { NodeFrost } from './NodeFrost'
import { WebPreview } from './WebPreview'
import { MarkdownNode } from './MarkdownNode'
import { FolderNode } from './FolderNode'
import { CalendarNode } from './CalendarNode'
import { CheckpointChip } from './CheckpointChip'
import { CommandTrailChip } from './CommandTrailChip'
import { BacklogChip } from './BacklogChip'
import { CatchUpPip } from './CatchUpPip'
import { SentinelPip } from './SentinelPip'

const AGENT_COLOR: Record<AgentKind, string> = {
  claude: '#d97757',
  codex: '#10a37f',
  cursor: '#7aa2ff',
  shell: '#9aa7c7'
}
export const STATUS_COLOR: Record<NonNullable<CanvasNode['status']>, string> = {
  idle: '#5b6887',
  working: '#f2c84b',
  done: '#48d597',
  error: '#ff6b6b'
}

// Collapsed markdown/folder/calendar chip = a SQUARE liquid-glass tile (macOS-Stack
// style): an icon-pure frosted square with the filename rendered BELOW (outside the
// glass). MUST be equal so the tile is a perfect square.
const COLLAPSED_CHIP_W = 72
const COLLAPSED_CHIP_H = 72 // === COLLAPSED_CHIP_W → perfect square

/**
 * Agent Lens excerpt — the node's live "what it's doing right now" line, rendered
 * muted in the header next to the title and truncated with an ellipsis. Subscribes
 * to the lens store by nodeId only (so it re-renders solely when THIS node's line
 * changes), and renders nothing when there is no excerpt — so idle / non-terminal
 * nodes look exactly as before. The terminal's screen-space xterm overlay starts
 * below the header, so the header (and thus this excerpt) is always visible.
 */
function LensExcerpt({ node }: { node: CanvasNode }): JSX.Element | null {
  const t = useT()
  const line = useLens((s) => s.lines[node.id])
  if (!line?.text) return null
  return (
    <>
      <span
        title={line.text}
        style={{
          flex: '1 1 0',
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          color: 'var(--canvasio-subtext)',
          fontWeight: 500,
          fontStyle: 'italic',
          fontSize: 11.5
        }}
      >
        {line.text}
      </span>
      {/* Brief Board pin — one click pins THIS live Lens line as a shared,
          attributed fact (the line is already captured at the Lens chokepoint;
          no new parsing). Memory-only; the panel ('B') lets you inject it. */}
      <button
        className="node-pin"
        title={t('node.pin_line_tooltip')}
        aria-label={t('node.pin_line_aria')}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          useBoard.getState().pin({
            text: line.text,
            sourceNodeId: node.id,
            sourceTitle: node.title,
            agent: node.agent
          })
        }}
        style={{
          flex: '0 0 auto',
          background: 'none',
          border: 'none',
          color: 'var(--canvasio-subtext)',
          cursor: 'pointer',
          fontSize: 12,
          lineHeight: 1,
          padding: '0 2px'
        }}
      >
        📌
      </button>
    </>
  )
}

/**
 * Changeset Lens badge — a compact "±N" chip showing how many files this agent
 * has CHANGED in its working tree, with green-add / red-del line counts. Polled
 * live by App.tsx into the (memory-only) changeset store; this subscribes by
 * nodeId only (re-renders solely when THIS node's changeset changes) and renders
 * nothing when there is no changeset — so clean / non-git nodes look exactly as
 * before. Clicking it opens the Changeset Lens panel focused on this node.
 */
function ChangesetBadge({ nodeId }: { nodeId: string }): JSX.Element | null {
  const t = useT()
  const cs = useChangeset((s) => s.byNode[nodeId])
  if (!cs || cs.files.length === 0) return null
  const n = cs.files.length
  return (
    <span
      title={t(n === 1 ? 'node.changeset_tooltip_one' : 'node.changeset_tooltip_other', {
        n,
        adds: cs.adds,
        dels: cs.dels
      })}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        window.dispatchEvent(new CustomEvent('canvasio:open-changeset', { detail: { nodeId } }))
      }}
      style={{
        marginLeft: 2,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 10.5,
        lineHeight: 1,
        padding: '2px 6px',
        borderRadius: 6,
        cursor: 'pointer',
        color: '#cfe0ff',
        background: 'rgba(122,162,255,0.16)',
        border: '1px solid rgba(122,162,255,0.4)',
        flex: '0 0 auto',
        userSelect: 'none',
        fontVariantNumeric: 'tabular-nums'
      }}
    >
      <span style={{ fontWeight: 700 }}>±{n}</span>
      {cs.adds > 0 && <span style={{ color: '#48d597' }}>+{cs.adds}</span>}
      {cs.dels > 0 && <span style={{ color: '#ff6b6b' }}>−{cs.dels}</span>}
    </span>
  )
}

/**
 * Atlas — Semantic Zoom Glance Card. When the camera is zoomed out past LOD_ZOOM
 * a terminal's live xterm overlay is suspended (TerminalOverlay) because at that
 * size it is unreadable AND the most expensive thing on the canvas. In its place
 * NodeView renders THIS card IN-WORLD (inside the CSS scale(zoom) transform, so it
 * stays razor-sharp at any zoom) composing data that ALREADY exists at existing
 * chokepoints: the node title, the live status dot (STATUS_COLOR[node.status]),
 * the single most-recent meaningful Lens line (useLens.lines[node.id]) and the
 * existing <ChangesetBadge>. Pure read-only; introduces no new store state.
 *
 * It paints over the node body's solid #070c18 (the same surface the overlay box
 * normally covers), so when the overlay is suspended the card reads as the node's
 * content. It is mounted ONLY below the threshold (NodeView gates it via the
 * narrow `glance` boolean), so normal-zoom nodes never render or subscribe here.
 */
function GlanceCard({ node }: { node: CanvasNode }): JSX.Element {
  const t = useT()
  const line = useLens((s) => s.lines[node.id])
  const statusColor = STATUS_COLOR[node.status ?? 'idle']
  return (
    <div className="glance-card">
      <div className="glance-card-head">
        <span
          className="node-status-dot"
          style={{ background: statusColor, boxShadow: `0 0 6px ${statusColor}` }}
        />
        <span className="glance-card-title">{node.title}</span>
        <ChangesetBadge nodeId={node.id} />
        <CheckpointChip nodeId={node.id} />
      </div>
      <div className="glance-card-line" title={line?.text}>
        {line?.text || t('node.waiting_output')}
      </div>
    </div>
  )
}

/**
 * Timefold — Canvas Time Machine frozen overlay. While the scrubber is armed,
 * this renders IN-WORLD over a terminal node's body (the same surface the xterm
 * overlay normally covers, and inside the CSS scale(zoom) transform so it stays
 * crisp at any zoom — exactly like the Atlas GlanceCard), reconstructing what the
 * node was showing AS OF the scrub instant `t`: the status dot color from the
 * most-recent transition at-or-before t, and the last meaningful Echo line at-or-
 * before t. Pure read-only: it reconstructs from the existing Echo + Mission
 * substrates via the lib/timefold kernel and mutates nothing.
 *
 * It is mounted ONLY while armed (NodeView gates it on a null-returning selector),
 * so there is zero idle cost — normal live nodes never render or subscribe here.
 */
function TimefoldFrozen({ node, t: foldT }: { node: CanvasNode; t: number }): JSX.Element {
  const t = useT()
  // Subscribe to THIS node's Echo ring + the Mission events so the frozen frame
  // updates live as the playhead moves (foldT is a prop → re-derives on each scrub).
  const ring = useEcho((s) => s.entries[node.id])
  const events = useMission(useShallow((s) => s.events.filter((e) => e.nodeId === node.id)))
  const past = lineAtTime(ring, foldT)
  const status = statusAtTime(events, node.id, foldT)
  const statusColor = STATUS_COLOR[status ?? 'idle']
  // A short wall-clock stamp so the frozen card reads as "this is the past".
  const clock = new Date(foldT).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return (
    <div className="glance-card timefold-frozen">
      <div className="glance-card-head">
        <span
          className="node-status-dot"
          style={{ background: statusColor, boxShadow: `0 0 6px ${statusColor}` }}
        />
        <span className="glance-card-title">{node.title}</span>
        <span className="timefold-frozen-stamp">⏳ {clock}</span>
      </div>
      <div className="glance-card-line" title={past?.text}>
        {past?.text || t('node.no_output_at_instant')}
      </div>
    </div>
  )
}

/**
 * Agent Objectives — Goal-vs-Actual progress, rendered in the node header. Shows
 * a small progress RING with the percent, a calm judgment CHIP (en rumbo /
 * desviado / objetivo cumplido) using the same amber/green/blue convention
 * CollisionWatch / TriageChip use, and an expandable CHECKLIST that auto-ticks as
 * matching signals appear in the agent's own output.
 *
 * It calls the PURE assessObjective with live data pulled from the existing
 * in-memory stores (Echo ring, Lens line, this node's Mission events, Changeset
 * diffstat) — NO new IPC, NO new parse pass. Subscribed narrowly per node, and it
 * renders NOTHING when no objective is set (same "render nothing when unused"
 * convention as every overlay), so existing behavior is provably unchanged.
 */
function ObjectiveChip({ node }: { node: CanvasNode }): JSX.Element | null {
  const t = useT()
  const [open, setOpen] = useState(false)
  // Live signals — each subscribed by nodeId so this only re-renders when THIS
  // node's data changes, not on every canvas event.
  const echoLines = useEcho((s) => s.entries[node.id])
  const lensLine = useLens((s) => s.lines[node.id]?.text)
  const nodeEvents = useMission(useShallow((s) => s.events.filter((e) => e.nodeId === node.id)))
  const cs = useChangeset((s) => s.byNode[node.id])

  if (!node.objective?.text) return null

  const assessment = assessObjective({
    objective: node.objective,
    status: node.status,
    echoLines: (echoLines ?? []).map((l) => l.text),
    lensLine,
    events: nodeEvents,
    diff: cs ? { files: cs.files.length, adds: cs.adds, dels: cs.dels } : undefined
  })

  const color = judgmentColor(assessment.judgment)
  const checklist = node.objective.checklist ?? []
  // ring geometry
  const R = 8
  const C = 2 * Math.PI * R
  const dash = (assessment.percent / 100) * C

  return (
    <>
      <span
        title={`${node.objective.text} · ${assessment.percent}% · ${judgmentLabel(assessment.judgment)}`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
        style={{
          marginLeft: 2,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          fontSize: 10.5,
          lineHeight: 1,
          padding: '2px 7px 2px 3px',
          borderRadius: 8,
          cursor: 'pointer',
          color,
          background: `${color}22`,
          border: `1px solid ${color}66`,
          flex: '0 0 auto',
          userSelect: 'none',
          fontVariantNumeric: 'tabular-nums'
        }}
      >
        <svg width={22} height={22} viewBox="0 0 22 22" style={{ flex: '0 0 auto' }}>
          <circle cx={11} cy={11} r={R} fill="none" stroke={`${color}33`} strokeWidth={3} />
          <circle
            cx={11}
            cy={11}
            r={R}
            fill="none"
            stroke={color}
            strokeWidth={3}
            strokeLinecap="round"
            strokeDasharray={`${dash} ${C - dash}`}
            transform="rotate(-90 11 11)"
          />
        </svg>
        <span style={{ fontWeight: 700 }}>{assessment.percent}%</span>
        <span style={{ fontWeight: 600 }}>{judgmentLabel(assessment.judgment)}</span>
      </span>
      {open && (
        <div
          className="no-drag"
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            top: '100%',
            right: 6,
            marginTop: 4,
            zIndex: 40,
            minWidth: 220,
            maxWidth: 320,
            padding: '9px 11px',
            borderRadius: 10,
            background: 'rgba(8,12,26,0.96)',
            border: `1px solid ${color}55`,
            boxShadow: '0 8px 26px rgba(0,0,0,0.45)',
            color: '#d7e1f7',
            fontSize: 11.5,
            cursor: 'default'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 7 }}>
            <span style={{ fontWeight: 700, color, flexShrink: 0 }}>{assessment.percent}%</span>
            <span style={{ fontSize: 10.5, color, flexShrink: 0 }}>
              {judgmentLabel(assessment.judgment)}
            </span>
          </div>
          <div style={{ color: '#cfe0ff', lineHeight: 1.4, marginBottom: checklist.length ? 8 : 0 }}>
            {node.objective.text}
          </div>
          {checklist.map((it, i) => {
            const ticked = assessment.ticked[i]
            return (
              <label
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 7,
                  padding: '3px 2px',
                  cursor: 'pointer',
                  color: ticked ? '#48d597' : '#aebbd6'
                }}
              >
                <input
                  type="checkbox"
                  checked={ticked}
                  onChange={(e) => {
                    e.stopPropagation()
                    useCanvas.getState().toggleChecklistItem(node.id, i)
                  }}
                  style={{ accentColor: '#48d597', cursor: 'pointer' }}
                />
                <span style={{ textDecoration: ticked ? 'line-through' : 'none' }}>{it.label}</span>
              </label>
            )
          })}
          <div style={{ display: 'flex', gap: 8, marginTop: 9 }}>
            <button
              onClick={async (e) => {
                e.stopPropagation()
                const text = await promptText(t('node.objective_prompt'), node.objective?.text ?? '')
                if (text && text.trim()) {
                  useCanvas
                    .getState()
                    .setObjective(node.id, { text: text.trim(), checklist: node.objective?.checklist })
                }
              }}
              style={objBtnStyle}
            >
              ✎ {t('node.objective_edit')}
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation()
                useCanvas.getState().clearObjective(node.id)
                setOpen(false)
              }}
              style={objBtnStyle}
            >
              ✕ {t('node.objective_remove')}
            </button>
          </div>
        </div>
      )}
    </>
  )
}

const objBtnStyle: React.CSSProperties = {
  background: 'rgba(124,151,224,0.16)',
  border: '1px solid rgba(120,150,220,0.22)',
  color: '#cfe0ff',
  borderRadius: 7,
  padding: '3px 9px',
  fontSize: 11,
  fontWeight: 600,
  cursor: 'pointer'
}

function NodeViewImpl({ node }: { node: CanvasNode }): JSX.Element {
  const t = useT()
  const updateNode = useCanvas((s) => s.updateNode)
  const removeNode = useCanvas((s) => s.removeNode)
  const bringToFront = useCanvas((s) => s.bringToFront)
  const select = useCanvas((s) => s.select)
  // Derive the per-node booleans inside the selector so each subscription only
  // fires when THIS node's value flips — not on every selection/focus/peek
  // change across the canvas. With N nodes this turns an O(N) re-render per
  // selection/peek change into O(1). Mirrors how TerminalBox derives
  // spotlit/dimmed from focusNodeId.
  const selected = useCanvas((s) => s.selectedId === node.id)
  // Lighthouse spotlight: when focus mode is on, the star node is spotlit and
  // every OTHER node is dimmed/blurred. Pure CSS — no geometry, no IPC.
  // Constellation Filter shares the same .spotlit/.dimmed chrome. Focus mode
  // (focusNodeId) takes PRIORITY when active; otherwise, when a filter query is
  // non-null, a node is spotlit if it matches the query and dimmed if not. The
  // match test runs INSIDE the selector (over title/subtitle/agent label/status,
  // lowercase substring) so each node's subscription only fires when ITS own
  // boolean flips — preserving the O(1)-per-change model.
  const matchesFilter = (s: ReturnType<typeof useCanvas.getState>): boolean => {
    if (s.filterQuery == null) return false
    const needle = s.filterQuery.trim().toLowerCase()
    if (!needle) return true // empty query matches everything
    const agentLabel = node.agent ? AGENT_LABEL[node.agent].title : ''
    const hay =
      `${node.title} ${node.subtitle ?? ''} ${agentLabel} ${node.status ?? ''}`.toLowerCase()
    return hay.includes(needle)
  }
  // Isolation chrome priority: Lighthouse focus (focusNodeId) > Stages
  // (stageIds, a named durable scene) > Constellation Filter (filterQuery). Each
  // tier yields the SAME .spotlit/.dimmed CSS NodeView already renders — Stages
  // just makes the spotlight set named + durable instead of derived-from-a-query.
  // Kept inside the selector so this node's subscription only fires when ITS own
  // boolean flips, preserving the O(1)-per-change model.
  const spotlit = useCanvas((s) =>
    s.focusNodeId != null
      ? s.focusNodeId === node.id
      : s.stageIds != null
        ? s.stageIds.includes(node.id)
        : s.filterQuery != null && matchesFilter(s)
  )
  const dimmed = useCanvas((s) =>
    s.focusNodeId != null
      ? s.focusNodeId !== node.id
      : s.stageIds != null
        ? !s.stageIds.includes(node.id)
        : s.filterQuery != null && !matchesFilter(s)
  )
  // Spyglass: a pulsing ring marks the node currently being peeked (transient
  // hold-to-preview). Pure CSS — no geometry, no IPC, no persistence.
  const peeking = useCanvas((s) => s.peekNodeId === node.id)
  // Watchtower — is this node pinned into the corner live-watch panel? Subscribed
  // as a per-node boolean so only THIS node re-renders when its pin flips.
  const watched = useCanvas((s) => s.watchIds.includes(node.id))
  // Atlas — Semantic Zoom LOD: are we zoomed out far enough that this terminal's
  // live xterm overlay is suspended and the in-world Glance Card should show
  // instead? The selector returns the BOOLEAN (not the raw zoom), so this node
  // only re-renders when the camera actually crosses LOD_ZOOM — never on every
  // zoom frame. Only terminals have an overlay to swap, so gate on kind too.
  const glance = useCanvas((s) => node.kind === 'terminal' && s.camera.zoom < LOD_ZOOM)
  // Timefold — Canvas Time Machine. While the scrubber is armed, every terminal
  // shows a frozen "as-of T" overlay. The selector returns the scrub instant
  // (or null), so this node only re-renders while armed and never costs anything
  // idle — exactly like the Atlas `glance` swap above. Gate on kind here so only
  // terminals reconstruct a frozen body.
  const foldAt = useTimefold((s) => (s.armed && node.kind === 'terminal' ? s.t : null))

  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState(node.title)
  const titleInputRef = useRef<HTMLInputElement | null>(null)

  const drag = useRef<{
    px: number
    py: number
    nx: number
    ny: number
    pointerId?: number
    captured?: boolean
  } | null>(null)

  // Agent Relay wiring visible on terminal nodes: this node is a relay SOURCE
  // (its finish triggers a handoff) and/or a TARGET (it receives one). We
  // subscribe to the rules array so the badge appears/disappears live.
  const isRelaySource = useRelay(
    (s) => node.kind === 'terminal' && s.rules.some((r) => r.sourceId === node.id)
  )
  const isRelayTarget = useRelay(
    (s) => node.kind === 'terminal' && s.rules.some((r) => r.targetId === node.id)
  )
  const clearRelayForNode = useRelay((s) => s.clearForNode)

  // Only bump z-index when this node isn't already the top-most one. This
  // avoids constantly incrementing topZ (which re-renders every node) on each
  // pointerdown.
  const bringToFrontIfNeeded = (): void => {
    if (node.z < useCanvas.getState().topZ) bringToFront(node.id)
  }

  useEffect(() => {
    if (editingTitle) {
      const input = titleInputRef.current
      if (input) {
        input.focus()
        input.select()
      }
    }
  }, [editingTitle])

  const beginEditTitle = (): void => {
    setTitleDraft(node.title)
    setEditingTitle(true)
  }
  const commitTitle = (): void => {
    if (!editingTitle) return
    const next = titleDraft.trim()
    if (next && next !== node.title) updateNode(node.id, { title: next })
    setEditingTitle(false)
  }
  const cancelTitle = (): void => {
    setTitleDraft(node.title)
    setEditingTitle(false)
  }
  const onTitleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitTitle()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelTitle()
    }
  }

  const onHeaderPointerDown = (e: React.PointerEvent): void => {
    if ((e.target as HTMLElement).closest('.node-close')) return
    if (editingTitle) return
    e.stopPropagation()
    select(node.id)
    bringToFrontIfNeeded()
    useCanvas.getState().setAutoFit(false)
    // Layout Time Machine — snapshot ONCE at the gesture start (never per move)
    // so the whole drag is a single undo step.
    useCanvas.getState().snapshotForGesture('move')
    // LAZY pointer capture: do NOT capture on pointerdown. Capturing here makes the
    // browser dispatch click/dblclick to THIS header instead of the title <span>,
    // which silently broke double-click-to-rename for every node. We capture on the
    // first real move (a drag) instead, so a click/dblclick reaches the title.
    drag.current = { px: e.clientX, py: e.clientY, nx: node.x, ny: node.y, pointerId: e.pointerId }
  }
  const onHeaderPointerMove = (e: React.PointerEvent): void => {
    if (!drag.current) return
    if (!drag.current.captured && drag.current.pointerId != null) {
      try {
        ;(e.currentTarget as HTMLElement).setPointerCapture(drag.current.pointerId)
      } catch {
        /* ignore */
      }
      drag.current.captured = true
    }
    const cv = useCanvas.getState()
    const zoom = cv.camera.zoom
    const dx = (e.clientX - drag.current.px) / zoom
    const dy = (e.clientY - drag.current.py) / zoom
    // Raw, un-snapped world position the pointer is asking for.
    let nx = drag.current.nx + dx
    let ny = drag.current.ny + dy

    // Magnetic Align — snap the dragged window's edges/centers onto nearby nodes,
    // unless Alt is held (free placement) or the user disabled it in Settings.
    // Holding Alt suspends snapping entirely; the Setting is read live per move so
    // toggling it takes effect without a remount. Closed nodes are not in `nodes`,
    // so every candidate is a live, visible window. We exclude self.
    const snapOff = e.altKey || localStorage.getItem('canvasio:snap') === 'off'
    if (snapOff) {
      useSnap.getState().setGuides([])
      useSnap.getState().setAltHeld(e.altKey)
    } else {
      const moving: SnapBox = { x: nx, y: ny, w: node.w, h: node.h }
      const others: SnapBox[] = []
      for (const o of cv.nodes) {
        if (o.id === node.id) continue
        others.push({ x: o.x, y: o.y, w: o.w, h: o.h })
      }
      const snap = computeSnap(moving, others, { zoom })
      nx += snap.dx
      ny += snap.dy
      useSnap.getState().setGuides(snap.guides)
      useSnap.getState().setAltHeld(false)
    }

    updateNode(node.id, { x: nx, y: ny })
  }
  const onHeaderPointerUp = (e: React.PointerEvent): void => {
    drag.current = null
    // Magnetic Align — clear the flashed guides the instant the gesture ends.
    useSnap.getState().clearGuides()
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }

  const accent = node.agent ? AGENT_COLOR[node.agent] : '#7c97e0'
  const statusColor = STATUS_COLOR[node.status ?? 'idle']

  // Collapse-to-icon — markdown/folder nodes minimized via the X button render
  // as a compact opaque file-icon chip instead of the full window. The chip is
  // draggable (same drag.current logic as the header), selectable, expands on
  // click (collapsed=false), and carries a small trash for the real delete. It
  // lives inside the CSS scale(zoom) world like the full node, but uses an
  // OPAQUE background and NO backdrop-filter so it stays crisp at any zoom.
  if (
    node.collapsed &&
    (node.kind === 'markdown' || node.kind === 'folder' || node.kind === 'calendar')
  ) {
    const glyph = node.kind === 'markdown' ? '📝' : node.kind === 'calendar' ? '📅' : '📁'
    return (
      <div
        style={{
          position: 'absolute',
          left: node.x,
          top: node.y,
          zIndex: node.z,
          width: COLLAPSED_CHIP_W,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 5
        }}
      >
        {/* The square carries the glass tint, all drag/select/expand handlers and
            the NodeFrost backdrop. Icon ON TOP + the filename BELOW it INSIDE the
            tile (white), so the name reads clearly against the wallpaper. */}
        <div
          className={'node-collapsed-chip' + (selected ? ' selected' : '')}
          title={t('node.collapsed_expand', { title: node.title })}
          style={{
            position: 'relative',
            width: COLLAPSED_CHIP_W,
            height: COLLAPSED_CHIP_H, // === _W → perfect square
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 3,
            padding: '6px 5px',
            cursor: 'pointer',
            overflow: 'hidden'
          }}
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).closest('.node-collapsed-trash')) return
            e.stopPropagation()
            select(node.id)
            bringToFrontIfNeeded()
            useCanvas.getState().setAutoFit(false)
            useCanvas.getState().snapshotForGesture('move')
            drag.current = { px: e.clientX, py: e.clientY, nx: node.x, ny: node.y }
            ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
          }}
          onPointerMove={(e) => {
            if (!drag.current) return
            const zoom = useCanvas.getState().camera.zoom
            const dx = (e.clientX - drag.current.px) / zoom
            const dy = (e.clientY - drag.current.py) / zoom
            updateNode(node.id, {
              x: drag.current.nx + dx,
              y: drag.current.ny + dy
            })
          }}
          onPointerUp={(e) => {
            const moved = drag.current
            drag.current = null
            try {
              ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
            } catch {
              /* ignore */
            }
            // Treat a near-zero-movement press as a click → expand. A real drag
            // (cursor moved more than a few px in world space) just repositions.
            if (!moved) return
            const zoom = useCanvas.getState().camera.zoom
            const dx = (e.clientX - moved.px) / zoom
            const dy = (e.clientY - moved.py) / zoom
            if (Math.hypot(dx, dy) < 4) updateNode(node.id, { collapsed: false })
          }}
        >
          {/* In-world frosted wallpaper backdrop — same liquid glass as the nodes.
              The chip is headerless, so pass header={0} so the sampled slice fills
              the whole square exactly (zIndex 0 = bottom layer). */}
          <NodeFrost
            node={{ x: node.x, y: node.y, w: COLLAPSED_CHIP_W, h: COLLAPSED_CHIP_H }}
            header={0}
          />
          <span style={{ position: 'relative', zIndex: 1, fontSize: 28, lineHeight: 1 }}>
            {glyph}
          </span>
          <span
            className="node-collapsed-chip-label"
            style={{
              position: 'relative',
              zIndex: 1,
              maxWidth: '100%',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              textAlign: 'center'
            }}
          >
            {node.title}
          </span>
          <button
            className="node-collapsed-trash"
            title={t('node.delete_permanently')}
            aria-label={t('node.delete_aria', { title: node.title })}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              clearRelayForNode(node.id)
              removeNode(node.id)
            }}
            style={{
              position: 'absolute',
              top: 3,
              right: 3,
              zIndex: 2,
              width: 18,
              height: 18,
              borderRadius: 50,
              background: 'rgba(255,107,107,0.18)',
              border: '1px solid rgba(255,107,107,0.4)',
              color: '#ff6b6b',
              cursor: 'pointer',
              fontSize: 10,
              lineHeight: 1,
              padding: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            🗑
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      className={
        'node node-' +
        node.kind +
        (selected ? ' selected' : '') +
        (dimmed ? ' dimmed' : '') +
        (spotlit ? ' spotlit' : '') +
        (peeking ? ' peeking' : '')
      }
      style={{ left: node.x, top: node.y, width: node.w, height: node.h, zIndex: node.z }}
      onPointerDown={() => {
        select(node.id)
        bringToFrontIfNeeded()
      }}
    >
      <div
        className="node-header"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
        onPointerCancel={onHeaderPointerUp}
      >
        <span className="node-status-dot" style={{ background: statusColor, boxShadow: `0 0 8px ${statusColor}` }} />
        {node.kind === 'terminal' && (
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: 2,
              background: accent,
              boxShadow: `0 0 8px ${accent}`,
              flex: '0 0 auto'
            }}
          />
        )}
        {editingTitle ? (
          <input
            ref={titleInputRef}
            className="node-title-input"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onKeyDown={onTitleKeyDown}
            onBlur={commitTitle}
            onPointerDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            style={{
              color: '#eaf1ff',
              fontWeight: 700,
              fontSize: 'inherit',
              fontFamily: 'inherit',
              background: 'rgba(255,255,255,0.08)',
              border: '1px solid rgba(124,151,224,0.6)',
              borderRadius: 4,
              padding: '1px 4px',
              outline: 'none',
              minWidth: 60,
              maxWidth: 220
            }}
          />
        ) : (
          <span
            style={{ color: '#eaf1ff', fontWeight: 700, cursor: 'text' }}
            title={t('node.rename_hint')}
            onDoubleClick={(e) => {
              e.stopPropagation()
              beginEditTitle()
            }}
          >
            {node.title}
          </span>
        )}
        {node.subtitle && (
          <span style={{ color: 'var(--canvasio-subtext)', fontWeight: 500, fontSize: 11.5 }}>· {node.subtitle}</span>
        )}
        {(isRelaySource || isRelayTarget) && (
          <span
            title={
              isRelaySource
                ? t('node.relay_source_tooltip')
                : t('node.relay_target_tooltip')
            }
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              // Clicking the SOURCE badge clears this node's relay wiring.
              if (!isRelaySource) return
              e.stopPropagation()
              clearRelayForNode(node.id)
            }}
            style={{
              marginLeft: 2,
              fontSize: 11,
              lineHeight: 1,
              padding: '1px 5px',
              borderRadius: 6,
              cursor: isRelaySource ? 'pointer' : 'default',
              color: isRelaySource ? '#0b1326' : '#cfe0ff',
              background: isRelaySource ? '#7aa2ff' : 'rgba(122,162,255,0.18)',
              border: '1px solid rgba(122,162,255,0.55)',
              flex: '0 0 auto',
              userSelect: 'none'
            }}
          >
            {isRelaySource ? `↦ ${t('node.relay')}` : `↤ ${t('node.relay')}`}
          </span>
        )}
        {node.kind === 'terminal' && <ChangesetBadge nodeId={node.id} />}
        {/* Checkpoints — stacked-layers chip + count of restorable savepoints.
            Renders nothing when this agent has none. Clicking opens the panel. */}
        {node.kind === 'terminal' && <CheckpointChip nodeId={node.id} />}
        {/* Command Trail — ⚠ + count when this agent ran a destructive command.
            Renders nothing otherwise. Clicking opens the audit timeline panel. */}
        {node.kind === 'terminal' && <CommandTrailChip nodeId={node.id} />}
        {/* Backlog — "•N" unseen-activity badge: meaningful Echo lines produced
            since you last looked at this agent. Renders nothing when nothing is
            unseen. Clicking flies here (centerOnNode), which zeroes the count. */}
        {node.kind === 'terminal' && <BacklogChip nodeId={node.id} />}
        {/* Catch-Up — "↺N" pip: meaningful milestones (status/command/files/
            output) this agent crossed since you last looked at it. Renders nothing
            when caught up or the feature is off; hidden at low zoom like the rest
            of the node chrome. Clicking flies here (centerOnNode), zeroing it. */}
        {node.kind === 'terminal' && <CatchUpPip nodeId={node.id} hidden={glance} />}
        {/* Sentinel — arm a forward-looking standing order on this agent ("wake me
            when it goes waiting/errors/finishes/prints a regex match, then fly me
            here"). Click cycles status triggers; right-click prompts for a regex.
            Hidden at low zoom like the rest of the node chrome. */}
        {node.kind === 'terminal' && <SentinelPip nodeId={node.id} hidden={glance} />}
        {/* Agent Objectives — goal-vs-actual progress. Renders nothing when no
            objective is set; otherwise a ring + percent + judgment chip. */}
        {node.kind === 'terminal' && node.objective?.text && <ObjectiveChip node={node} />}
        {node.kind === 'terminal' && !node.objective?.text && (
          <button
            className="node-watch"
            title={t('node.set_objective_tooltip')}
            aria-label={t('node.set_objective_aria', { title: node.title })}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={async (e) => {
              e.stopPropagation()
              const text = await promptText(t('node.objective_prompt'), '')
              if (text && text.trim()) {
                useCanvas.getState().setObjective(node.id, { text: text.trim() })
              }
            }}
          >
            🎯
          </button>
        )}
        {node.kind === 'terminal' && <LensExcerpt node={node} />}
        {node.kind === 'terminal' && (
          <button
            className={'node-watch' + (watched ? ' active' : '')}
            title={watched ? t('node.unwatch_tooltip') : t('node.watch_tooltip')}
            aria-label={
              watched
                ? t('node.unwatch_aria', { title: node.title })
                : t('node.watch_aria', { title: node.title })
            }
            aria-pressed={watched}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              useCanvas.getState().toggleWatch(node.id)
            }}
          >
            👁
          </button>
        )}
        <button
          className="node-close"
          title={
            node.kind === 'markdown' || node.kind === 'folder' || node.kind === 'calendar'
              ? t('node.minimize')
              : t('common.close')
          }
          aria-label={
            node.kind === 'markdown' || node.kind === 'folder' || node.kind === 'calendar'
              ? t('node.minimize_aria', { title: node.title })
              : t('node.close_aria', { title: node.title })
          }
          onClick={() => {
            clearRelayForNode(node.id)
            // Markdown/folder/calendar nodes minimize to an icon chip
            // (collapsed=true) instead of being removed; the chip's trash
            // performs the real delete. Terminal/web/music keep X = close.
            if (node.kind === 'markdown' || node.kind === 'folder' || node.kind === 'calendar') {
              updateNode(node.id, { collapsed: true })
            } else {
              removeNode(node.id)
            }
          }}
        >
          ✕
        </button>
      </div>

      <div className="node-body">
        {/* Terminal nodes render their xterm <canvas> in a screen-space overlay
            (TerminalOverlays), NOT here in the CSS-transformed world — a canvas
            inside scale(zoom) gets bitmap-scaled by the GPU and blurs. The body
            now carries a translucent rgba(7,12,24,0.34) glass tint that EXACTLY
            mirrors the overlay box / xterm tint, so the overlay box (which sits
            exactly over this area) reads as part of the same liquid-glass
            surface, with no seam. */}
        {/* In-world liquid glass: a blurred slice of the live pixel-art wallpaper
            under the body (canvas wallpaper only), rendered as the BOTTOM layer
            (zIndex:0) so the in-world content reads as the SAME frosted glass as
            the terminals. Only mounted where the body is TRANSLUCENT and the frost
            can actually show through — music (lowered tint) + web (chrome/border).
            Terminals frost via the z-30 overlay + z-29 layer; markdown/folder/
            calendar keep their intentionally OPAQUE bodies for legibility, so a
            frost layer behind them would be invisible (skipped → no wasted draw).
            Video wallpaper → NodeFrost returns null and the body tint is the
            graceful fallback. */}
        {(node.kind === 'music' ||
          node.kind === 'web' ||
          node.kind === 'markdown' ||
          node.kind === 'folder' ||
          node.kind === 'calendar') && (
          <NodeFrost node={{ x: node.x, y: node.y, w: node.w, h: node.h }} />
        )}
        {node.kind === 'music' && <MusicPlayer node={node} />}
        {node.kind === 'web' && <WebPreview node={node} />}
        {/* Markdown note — reads its filePath via window.canvasio.fs, renders the
            file READ-ONLY as a clean macOS-style preview, and live-reloads when
            the file changes on disk (fs.watch). Lives in the CSS-transformed
            world; no xterm overlay, so its body is fully visible. */}
        {node.kind === 'markdown' && <MarkdownNode node={node} />}
        {/* Folder browser — lists its dirPath (Finder-like); clicking a file
            opens it in a NEW node beside it, clicking a directory navigates the
            same node into it (updateNode dirPath). */}
        {node.kind === 'folder' && <FolderNode node={node} />}
        {/* Calendar — a month view backed by the GLOBAL, cross-canvas calendar
            store (annotations keyed by ISO date, persisted to localStorage).
            Clicking a day opens a panel to view/add/remove that day's notes.
            Plain DOM in the CSS-transformed world; no xterm overlay, always
            readable; its grid + day panel are data-canvas-scroll so scrolling
            never pans the canvas. */}
        {node.kind === 'calendar' && <CalendarNode node={node} />}
        {/* Atlas — at low zoom the terminal's screen-space xterm overlay is
            suspended (see TerminalOverlay), so we render the in-world Glance Card
            here. It lives inside scale(zoom), so it stays crisp at any zoom. */}
        {glance && <GlanceCard node={node} />}
        {/* Timefold — while the time machine is armed, the terminal body is
            replaced by a frozen "as-of T" reconstruction (status + Echo line at
            that instant). It lives inside scale(zoom) like the Glance Card, so it
            stays crisp at any zoom; clearing t (disarm) removes it and the live
            body resumes instantly. Rendered last so it sits above the Glance
            Card if both apply. */}
        {foldAt != null && <TimefoldFrozen node={node} t={foldAt} />}
      </div>

      {/* Resize handles are rendered in a SCREEN-SPACE overlay (ResizeOverlays in
          TerminalOverlay.tsx, z-31) instead of in-world here. A terminal's z-30
          overlay box composited above these in-world handles and intercepted the
          pointer over the body, so side/bottom/corner resizes died — the overlay
          lives above that box and fixes it for all nodes. */}
    </div>
  )
}

/**
 * Memoized so dragging/resizing ONE node (which produces a new array but reuses
 * the other nodes' object identities) does not re-render every other node.
 * NodeView still subscribes to selectedId internally, so selection changes
 * propagate correctly. Zoom is read imperatively at drag time (not subscribed)
 * so node frames don't re-render on every zoom frame.
 */
export const NodeView = memo(NodeViewImpl)
