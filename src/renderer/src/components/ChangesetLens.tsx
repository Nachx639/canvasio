import { useEffect, useMemo, useRef, useState } from 'react'
import { useCanvas, type CanvasNode } from '../store/canvas'
import { useChangeset, type ChangedFile } from '../store/changeset'
import { useCheckpoints } from '../store/checkpoints'
import { t, useT } from '../store/i18n'
import { STATUS_COLOR } from './NodeView'

/**
 * Changeset Lens — a compact, keyboard-first panel answering "what FILES has
 * every agent changed, and can I review the diff + act on it WITHOUT leaving the
 * canvas". It complements Agent Lens (last output line) and Mission Pulse
 * (state) by adding the orthogonal ARTIFACT axis: concrete file changes.
 *
 * It lists every terminal node that has changes (most-changed first) as a header
 * row, with its changed files beneath. Keyboard model (mirrors AgentLensHud's
 * capture-phase handler so plain-key app shortcuts never fire while open):
 *   ↑/↓     move the selection across the flat file list
 *   Enter   expand/collapse the colorized inline diff for the selected file
 *   O       reveal the selected file in the OS file manager (read-only IPC)
 *   C       copy the selected file's repo-relative path
 *   G       fly the camera to the agent that owns the selected file (centerOnNode)
 *   Esc     close
 *
 * Opened via the 'canvasio:open-changeset' CustomEvent (dispatched by ⌘D / 'D'
 * in App.tsx, the Command Palette, and the per-node ±N badge — whose detail may
 * carry a nodeId to pre-select that agent's first file). Purely renderer-side:
 * it READS nodes + changesets, CALLS centerOnNode, and uses the read-only
 * window.canvasio.git.{diff,revealFile} bridge — no geometry mutation, no
 * persistence.
 */

/** A flattened, navigable item: either an agent header or one of its files. */
type Row =
  | { type: 'agent'; node: CanvasNode; fileCount: number; adds: number; dels: number }
  | { type: 'file'; node: CanvasNode; file: ChangedFile; fileIndex: number }

export function ChangesetLens(): JSX.Element | null {
  const t = useT()
  const [open, setOpen] = useState(false)
  // index into the FILE rows only (agent headers are not directly selectable).
  const [active, setActive] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const [diff, setDiff] = useState<string | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  const nodes = useCanvas((s) => s.nodes)
  const byNode = useChangeset((s) => s.byNode)

  // Build the display model: agents (with changes) ranked by file count desc,
  // then a flat list of file rows for keyboard navigation.
  const { rows, fileRows } = useMemo(() => {
    const terminals = nodes.filter((n) => n.kind === 'terminal' && byNode[n.id]?.files.length)
    terminals.sort((a, b) => (byNode[b.id]?.files.length ?? 0) - (byNode[a.id]?.files.length ?? 0))
    const rows: Row[] = []
    const fileRows: Array<{ node: CanvasNode; file: ChangedFile }> = []
    for (const n of terminals) {
      const cs = byNode[n.id]
      if (!cs) continue
      rows.push({
        type: 'agent',
        node: n,
        fileCount: cs.files.length,
        adds: cs.adds,
        dels: cs.dels
      })
      cs.files.forEach((file, fileIndex) => {
        rows.push({ type: 'file', node: n, file, fileIndex })
        fileRows.push({ node: n, file })
      })
    }
    return { rows, fileRows }
  }, [nodes, byNode])

  // Open / toggle on the shared event; an optional detail.nodeId pre-selects the
  // first file of that agent (from the ±N badge click).
  useEffect(() => {
    const onOpen = (e: Event): void => {
      const detail = (e as CustomEvent<{ nodeId?: string }>).detail
      setOpen((v) => {
        const next = !v
        if (next && detail?.nodeId) {
          const idx = fileRows.findIndex((r) => r.node.id === detail.nodeId)
          if (idx >= 0) {
            setActive(idx)
            setExpanded(false)
          }
        }
        return next
      })
    }
    window.addEventListener('canvasio:open-changeset', onOpen)
    return () => window.removeEventListener('canvasio:open-changeset', onOpen)
  }, [fileRows])

  // Clamp the active row whenever the file list shrinks.
  useEffect(() => {
    setActive((a) => (fileRows.length === 0 ? 0 : Math.min(a, fileRows.length - 1)))
  }, [fileRows.length])

  const selected = fileRows[active]

  // Load the diff lazily when a file is expanded (or the selection changes while
  // expanded). Cancelled by a token so a stale fetch can't overwrite a newer one.
  useEffect(() => {
    if (!open || !expanded || !selected) {
      setDiff(null)
      return
    }
    let cancelled = false
    setDiffLoading(true)
    setDiff(null)
    const { node, file } = selected
    const cwd = node.cwd
    if (!cwd) {
      setDiffLoading(false)
      setDiff(null)
      return
    }
    window.canvasio.git
      .diff(cwd, file.path)
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
    // Key the refetch on the STABLE identity of the selection (node id + path),
    // not the object reference, so an unrelated node's poll (which rebuilds
    // fileRows) doesn't needlessly refetch the currently-open diff.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, expanded, selected?.node.id, selected?.file.path])

  // Keyboard navigation while open (capture phase, like AgentLensHud).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (expanded) setExpanded(false)
        else setOpen(false)
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setExpanded(false)
        setActive((a) => (fileRows.length ? (a + 1) % fileRows.length : 0))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setExpanded(false)
        setActive((a) => (fileRows.length ? (a - 1 + fileRows.length) % fileRows.length : 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (fileRows.length) setExpanded((v) => !v)
      } else if (e.key === 'o' || e.key === 'O') {
        e.preventDefault()
        if (selected?.node.cwd) {
          void window.canvasio.git.revealFile(selected.node.cwd, selected.file.path)
        }
      } else if (e.key === 'c' || e.key === 'C') {
        e.preventDefault()
        if (selected) void copyText(selected.file.path)
      } else if (e.key === 'g' || e.key === 'G') {
        e.preventDefault()
        if (selected) {
          useCanvas.getState().centerOnNode(selected.node.id)
          setOpen(false)
        }
      } else if (e.key === 'k' || e.key === 'K') {
        // Checkpoints — "this diff is good, lock it in". Capture a restorable
        // savepoint of the selected file's owning agent (non-mutating `git stash
        // create`) and hand off to the Checkpoint Panel focused on it. Closes the
        // review -> ACT loop right where you reviewed the diff.
        e.preventDefault()
        if (selected) {
          const node = selected.node
          const cwd = node.cwd
          if (cwd) {
            const label = `${node.title} · ${new Date().toLocaleTimeString()}`
            void useCheckpoints.getState().captureFor(node.id, cwd, label)
            setOpen(false)
            window.dispatchEvent(
              new CustomEvent('canvasio:open-checkpoints', { detail: { nodeId: node.id } })
            )
          }
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, fileRows, selected, expanded])

  // Keep the selected row scrolled into view.
  useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [active, open, expanded])

  if (!open) return null

  return (
    <div
      className="glass no-drag"
      data-overlay="changeset"
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
        <span style={{ fontWeight: 700, fontSize: 14 }}>Changeset Lens</span>
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
          {t('changesetLens.read_only_badge')}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 10.5, color: '#6f84ad' }}>
          {t('changesetLens.shortcuts_hint')}
        </span>
        <button
          onClick={() => setOpen(false)}
          aria-label={t('changesetLens.close_aria')}
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

      {fileRows.length === 0 ? (
        <div style={{ fontSize: 12, color: '#6f84ad', padding: '4px 0' }}>
          {t('changesetLens.empty')}
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
                  <span style={{ fontSize: 11, color: 'var(--canvasio-subtext)' }}>
                    {row.fileCount === 1
                      ? t('changesetLens.file_count_one', { count: row.fileCount })
                      : t('changesetLens.file_count_other', { count: row.fileCount })}
                  </span>
                  <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums' }}>
                    {row.adds > 0 && <span style={{ color: '#48d597' }}>+{row.adds} </span>}
                    {row.dels > 0 && <span style={{ color: '#ff6b6b' }}>−{row.dels}</span>}
                  </span>
                </div>
              )
            }
            // file row
            const fileIdx = fileRows.findIndex(
              (r) => r.node.id === row.node.id && r.file.path === row.file.path
            )
            const isActive = fileIdx === active
            return (
              <FileRow
                key={`file:${row.node.id}:${row.file.path}`}
                file={row.file}
                active={isActive}
                expanded={isActive && expanded}
                diff={isActive && expanded ? diff : null}
                diffLoading={isActive && expanded && diffLoading}
                onHover={() => {
                  if (fileIdx >= 0) {
                    setActive(fileIdx)
                    setExpanded(false)
                  }
                }}
                onClick={() => {
                  if (fileIdx >= 0) {
                    if (fileIdx === active) setExpanded((v) => !v)
                    else {
                      setActive(fileIdx)
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

function FileRow({
  file,
  active,
  expanded,
  diff,
  diffLoading,
  onHover,
  onClick
}: {
  file: ChangedFile
  active: boolean
  expanded: boolean
  diff: string | null
  diffLoading: boolean
  onHover: () => void
  onClick: () => void
}): JSX.Element {
  const t = useT()
  const name = file.path.split('/').pop() || file.path
  const dir = file.path.slice(0, file.path.length - name.length)
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
          background: active ? 'rgba(124,151,224,0.18)' : 'rgba(8,12,26,0.45)',
          border: active
            ? '1px solid rgba(122,162,255,0.55)'
            : '1px solid rgba(120,150,220,0.1)',
          color: '#d7e1f7',
          cursor: 'pointer'
        }}
      >
        <span
          title={statusLabel(file.status)}
          style={{
            flex: '0 0 auto',
            width: 26,
            textAlign: 'center',
            fontSize: 10,
            fontWeight: 700,
            color: statusColor(file.status),
            fontFamily: 'monospace'
          }}
        >
          {file.status.trim() || '··'}
        </span>
        <span style={{ flex: '1 1 0', minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
          {dir && <span style={{ color: '#6f84ad' }}>{dir}</span>}
          <span style={{ color: '#eaf1ff', fontWeight: 600 }}>{name}</span>
        </span>
        <span style={{ flex: '0 0 auto', fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
          {file.adds > 0 && <span style={{ color: '#48d597' }}>+{file.adds} </span>}
          {file.dels > 0 && <span style={{ color: '#ff6b6b' }}>−{file.dels}</span>}
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
            <span style={{ color: '#6f84ad' }}>{t('changesetLens.loading_diff')}</span>
          ) : diff && diff.trim() ? (
            <DiffBody diff={diff} />
          ) : (
            <span style={{ color: '#6f84ad' }}>{t('changesetLens.no_diff')}</span>
          )}
        </div>
      )}
    </div>
  )
}

/** Render a unified diff with per-line coloring (+adds green, −dels red, @@ hunk
 *  cyan, file headers muted). Pure presentational split — no parsing beyond the
 *  leading char of each line. */
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
            {ln || ' '}
          </div>
        )
      })}
    </>
  )
}

function statusColor(status: string): string {
  const s = status.trim()
  if (s.includes('?')) return '#5fd0e6' // untracked
  if (s.includes('A')) return '#48d597' // added
  if (s.includes('D')) return '#ff6b6b' // deleted
  if (s.includes('R')) return '#c89bff' // renamed
  return '#f2c84b' // modified / other
}

function statusLabel(status: string): string {
  const s = status.trim()
  if (s.includes('?')) return t('changesetLens.status_untracked')
  if (s.includes('A')) return t('changesetLens.status_added')
  if (s.includes('D')) return t('changesetLens.status_deleted')
  if (s.includes('R')) return t('changesetLens.status_renamed')
  if (s.includes('M')) return t('changesetLens.status_modified')
  return s || t('changesetLens.status_changed')
}

/** Copy to clipboard, falling back gracefully if the async API is unavailable. */
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    /* ignore — clipboard may be unavailable / denied */
  }
}
