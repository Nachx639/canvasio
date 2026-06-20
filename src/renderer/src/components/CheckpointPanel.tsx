import { useEffect, useMemo, useRef, useState } from 'react'
import { useCanvas, type CanvasNode } from '../store/canvas'
import { useCheckpoints, type CheckpointMeta } from '../store/checkpoints'
import { useT } from '../store/i18n'
import { STATUS_COLOR } from './NodeView'

/**
 * Checkpoint Panel — the keyboard-first ACT surface that closes the Changeset
 * Lens story. Where the Lens lets you REVIEW a diff read-only, this lets you
 * FREEZE a state you trust (capture) and later RESTORE it. It lists every
 * terminal agent that has captured savepoints, each agent's checkpoints beneath
 * (newest-first) showing time + ±lines; selecting one previews its full diff and
 * offers Restore behind the SAME main-process confirm gate the Doctor uses.
 *
 * Keyboard model (capture-phase, mirroring ChangesetLens so plain-key app
 * shortcuts never fire while open):
 *   ↑/↓     move across the flat checkpoint list
 *   Enter   expand/collapse the colorized diff for the selected checkpoint
 *   K       capture a NEW checkpoint for the agent owning the selection (or, when
 *           empty, the focused/selected terminal) — non-mutating `git stash create`
 *   R       restore the selected checkpoint (`git stash apply`, behind the gate)
 *   G       fly the camera to the agent owning the selection
 *   Esc     close
 *
 * Opened via the 'canvasio:open-checkpoints' CustomEvent (K in App.tsx, the
 * Command Palette, the per-node chip, and the Changeset Lens header K action);
 * an optional detail.nodeId pre-selects that agent. Purely renderer-side: it
 * READS nodes + checkpoints, CALLS centerOnNode + the (gated/read-only) git
 * checkpoint bridge — no geometry mutation, no persistence.
 */

type Row =
  | { type: 'agent'; node: CanvasNode; count: number }
  | { type: 'cp'; node: CanvasNode; cp: CheckpointMeta; cpIndex: number }

export function CheckpointPanel(): JSX.Element | null {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const [diff, setDiff] = useState<string | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const nodes = useCanvas((s) => s.nodes)
  const byNode = useCheckpoints((s) => s.byNode)

  const { rows, cpRows } = useMemo(() => {
    const terminals = nodes.filter((n) => n.kind === 'terminal' && byNode[n.id]?.length)
    terminals.sort((a, b) => (byNode[b.id]?.length ?? 0) - (byNode[a.id]?.length ?? 0))
    const rows: Row[] = []
    const cpRows: Array<{ node: CanvasNode; cp: CheckpointMeta }> = []
    for (const n of terminals) {
      const list = byNode[n.id]
      if (!list) continue
      rows.push({ type: 'agent', node: n, count: list.length })
      list.forEach((cp, cpIndex) => {
        rows.push({ type: 'cp', node: n, cp, cpIndex })
        cpRows.push({ node: n, cp })
      })
    }
    return { rows, cpRows }
  }, [nodes, byNode])

  // Resolve the terminal node a fresh capture should target when the panel is
  // empty (no selection): the selected node if it's a terminal with a cwd, else
  // the first terminal with a cwd.
  const captureTargetWhenEmpty = (): CanvasNode | null => {
    const s = useCanvas.getState()
    const sel = s.nodes.find((n) => n.id === s.selectedId)
    if (sel && sel.kind === 'terminal' && sel.cwd) return sel
    return s.nodes.find((n) => n.kind === 'terminal' && !!n.cwd) ?? null
  }

  useEffect(() => {
    const onOpen = (e: Event): void => {
      const detail = (e as CustomEvent<{ nodeId?: string }>).detail
      setOpen((v) => {
        const next = !v
        if (next) {
          setNotice(null)
          if (detail?.nodeId) {
            const idx = cpRows.findIndex((r) => r.node.id === detail.nodeId)
            if (idx >= 0) {
              setActive(idx)
              setExpanded(false)
            }
          }
        }
        return next
      })
    }
    window.addEventListener('canvasio:open-checkpoints', onOpen)
    return () => window.removeEventListener('canvasio:open-checkpoints', onOpen)
  }, [cpRows])

  useEffect(() => {
    setActive((a) => (cpRows.length === 0 ? 0 : Math.min(a, cpRows.length - 1)))
  }, [cpRows.length])

  const selected = cpRows[active]

  // Lazy-load the selected checkpoint's diff when expanded.
  useEffect(() => {
    if (!open || !expanded || !selected) {
      setDiff(null)
      return
    }
    let cancelled = false
    setDiffLoading(true)
    setDiff(null)
    const { node, cp } = selected
    const cwd = node.cwd
    if (!cwd) {
      setDiffLoading(false)
      setDiff(null)
      return
    }
    window.canvasio.git.checkpoints
      .diff(cwd, cp.sha)
      .then((d) => {
        if (cancelled) return
        setDiff(d ?? '')
        setDiffLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setDiff('')
        setDiffLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, expanded, selected?.node.id, selected?.cp.sha])

  // Capture a new checkpoint for the relevant agent (selection owner, else the
  // empty-target terminal). Non-mutating `git stash create`.
  const capture = async (): Promise<void> => {
    if (busy) return
    const target = selected?.node ?? captureTargetWhenEmpty()
    if (!target?.cwd) {
      setNotice(t('checkpointPanel.no_git_agent'))
      return
    }
    setBusy(true)
    setNotice(t('checkpointPanel.capturing'))
    try {
      const label = `${target.title} · ${new Date().toLocaleTimeString()}`
      const meta = await useCheckpoints.getState().captureFor(target.id, target.cwd, label)
      setNotice(
        meta
          ? t('checkpointPanel.captured', { adds: meta.adds, dels: meta.dels })
          : t('checkpointPanel.no_changes')
      )
    } catch {
      setNotice(t('checkpointPanel.capture_failed'))
    } finally {
      setBusy(false)
    }
  }

  // Restore the selected checkpoint (gated in main via confirm dialog).
  const restore = async (): Promise<void> => {
    if (busy || !selected) return
    const { node, cp } = selected
    const cwd = node.cwd
    if (!cwd) return
    setBusy(true)
    setNotice(t('checkpointPanel.restoring'))
    try {
      const res = await window.canvasio.git.checkpoints.restore(cwd, cp.sha, cp.short)
      if (!res.ok) setNotice(t('checkpointPanel.restore_cancelled'))
      else if (res.conflicted)
        setNotice(t('checkpointPanel.restored_conflicts'))
      else setNotice(t('checkpointPanel.restored'))
    } catch {
      setNotice(t('checkpointPanel.restore_failed'))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      // Capture phase + stopPropagation so the keys we consume here NEVER also
      // fire the canvas's bubble-phase plain-key shortcuts (e.g. 'G' flowLayout,
      // 'R' Reply Rail). This is the keyboard-ownership model: while the panel is
      // open it owns its keys outright.
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        if (expanded) setExpanded(false)
        else setOpen(false)
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        e.stopPropagation()
        setExpanded(false)
        setActive((a) => (cpRows.length ? (a + 1) % cpRows.length : 0))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        e.stopPropagation()
        setExpanded(false)
        setActive((a) => (cpRows.length ? (a - 1 + cpRows.length) % cpRows.length : 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        if (cpRows.length) setExpanded((v) => !v)
      } else if (e.key === 'k' || e.key === 'K') {
        e.preventDefault()
        e.stopPropagation()
        void capture()
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault()
        e.stopPropagation()
        void restore()
      } else if (e.key === 'g' || e.key === 'G') {
        e.preventDefault()
        e.stopPropagation()
        if (selected) {
          useCanvas.getState().centerOnNode(selected.node.id)
          setOpen(false)
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cpRows, selected, expanded, busy])

  useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [active, open, expanded])

  if (!open) return null

  return (
    <div
      className="glass no-drag"
      data-overlay="checkpoints"
      style={{
        pointerEvents: 'auto',
        position: 'absolute',
        top: 46,
        left: '50%',
        transform: 'translateX(-50%)',
        borderRadius: 14,
        padding: 14,
        width: 540,
        maxHeight: '74vh',
        overflowY: 'auto',
        fontSize: 13,
        color: '#d7e1f7',
        zIndex: 61
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontWeight: 700, fontSize: 14 }}>Checkpoints</span>
        <span
          style={{
            marginLeft: 8,
            fontSize: 10.5,
            color: '#ffd08a',
            border: '1px solid rgba(242,200,75,0.3)',
            borderRadius: 6,
            padding: '1px 6px'
          }}
        >
          {t('checkpointPanel.badge')}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 10.5, color: '#6f84ad' }}>
          {t('checkpointPanel.shortcuts')}
        </span>
        <button
          onClick={() => setOpen(false)}
          aria-label={t('checkpointPanel.close_aria')}
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

      {notice && (
        <div
          style={{
            fontSize: 11.5,
            color: '#ffd08a',
            background: 'rgba(242,200,75,0.1)',
            border: '1px solid rgba(242,200,75,0.25)',
            borderRadius: 8,
            padding: '5px 9px',
            marginBottom: 8
          }}
        >
          {notice}
        </div>
      )}

      {cpRows.length === 0 ? (
        <div style={{ fontSize: 12, color: '#6f84ad', padding: '4px 0' }}>
          {t('checkpointPanel.empty_before')} <b style={{ color: '#ffd08a' }}>K</b>{' '}
          {t('checkpointPanel.empty_after')}
        </div>
      ) : (
        <div ref={listRef}>
          {rows.map((row, i) => {
            if (row.type === 'agent') {
              const statusColor = STATUS_COLOR[row.node.status ?? 'idle']
              return (
                <div
                  key={`agent:${row.node.id}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 6px 4px',
                    marginTop: i === 0 ? 0 : 6,
                    borderBottom: '1px solid rgba(120,150,220,0.12)'
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
                  <span style={{ fontSize: 11, color: '#8398c4' }}>
                    {row.count} checkpoint{row.count === 1 ? '' : 's'}
                  </span>
                </div>
              )
            }
            const cpIdx = cpRows.findIndex(
              (r) => r.node.id === row.node.id && r.cp.sha === row.cp.sha
            )
            const isActive = cpIdx === active
            return (
              <CheckpointRow
                key={`cp:${row.node.id}:${row.cp.sha}`}
                cp={row.cp}
                active={isActive}
                expanded={isActive && expanded}
                diff={isActive && expanded ? diff : null}
                diffLoading={isActive && expanded && diffLoading}
                onHover={() => {
                  if (cpIdx >= 0) {
                    setActive(cpIdx)
                    setExpanded(false)
                  }
                }}
                onClick={() => {
                  if (cpIdx >= 0) {
                    if (cpIdx === active) setExpanded((v) => !v)
                    else {
                      setActive(cpIdx)
                      setExpanded(true)
                    }
                  }
                }}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

function CheckpointRow({
  cp,
  active,
  expanded,
  diff,
  diffLoading,
  onHover,
  onClick
}: {
  cp: CheckpointMeta
  active: boolean
  expanded: boolean
  diff: string | null
  diffLoading: boolean
  onHover: () => void
  onClick: () => void
}): JSX.Element {
  const t = useT()
  const when = new Date(cp.ts)
  const label = isNaN(when.getTime()) ? cp.short : when.toLocaleString()
  return (
    <div style={{ marginBottom: 4 }}>
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
          padding: '6px 10px',
          borderRadius: 9,
          background: active ? 'rgba(242,200,75,0.16)' : 'rgba(8,12,26,0.45)',
          border: active
            ? '1px solid rgba(242,200,75,0.55)'
            : '1px solid rgba(120,150,220,0.1)',
          color: '#d7e1f7',
          cursor: 'pointer'
        }}
      >
        <span style={{ flex: '1 1 0', minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
          <span style={{ color: '#eaf1ff', fontWeight: 600 }}>{label}</span>
          <span style={{ color: '#6f84ad', marginLeft: 8, fontFamily: 'monospace', fontSize: 10.5 }}>
            {cp.short}
          </span>
        </span>
        <span style={{ flex: '0 0 auto', fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
          {cp.files > 0 && <span style={{ color: '#8398c4' }}>{cp.files}f </span>}
          {cp.adds > 0 && <span style={{ color: '#48d597' }}>+{cp.adds} </span>}
          {cp.dels > 0 && <span style={{ color: '#ff6b6b' }}>−{cp.dels}</span>}
        </span>
        <span style={{ flex: '0 0 auto', color: '#6f84ad', fontSize: 10 }}>
          {expanded ? '▾' : '▸'}
        </span>
      </button>
      {expanded && (
        <div
          style={{
            marginTop: 4,
            marginLeft: 8,
            padding: '8px 10px',
            borderRadius: 8,
            background: 'rgba(4,7,16,0.7)',
            border: '1px solid rgba(120,150,220,0.12)',
            maxHeight: 280,
            overflow: 'auto',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 11.5,
            lineHeight: 1.45,
            whiteSpace: 'pre',
            tabSize: 2
          }}
        >
          {diffLoading ? (
            <span style={{ color: '#6f84ad' }}>{t('checkpointPanel.loading_diff')}</span>
          ) : diff && diff.trim() ? (
            <DiffBody diff={diff} />
          ) : (
            <span style={{ color: '#6f84ad' }}>{t('checkpointPanel.no_diff')}</span>
          )}
        </div>
      )}
    </div>
  )
}

/** Per-line colorized unified diff (shared shape with ChangesetLens.DiffBody). */
function DiffBody({ diff }: { diff: string }): JSX.Element {
  const lines = diff.split('\n')
  return (
    <>
      {lines.map((ln, i) => {
        let color = '#aebbd6'
        if (ln.startsWith('+++') || ln.startsWith('---')) color = '#6f84ad'
        else if (ln.startsWith('@@')) color = '#5fd0e6'
        else if (ln.startsWith('+')) color = '#7be0a8'
        else if (ln.startsWith('-')) color = '#ff8b8b'
        else if (ln.startsWith('diff ') || ln.startsWith('index ')) color = '#6f84ad'
        return (
          <div key={i} style={{ color }}>
            {ln || ' '}
          </div>
        )
      })}
    </>
  )
}
