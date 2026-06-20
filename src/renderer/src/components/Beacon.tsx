import { useEffect, useMemo, useRef, useState } from 'react'
import { useCanvas } from '../store/canvas'
import { useT } from '../store/i18n'
import * as termRegistry from '../lib/termRegistry'
import { search, type BeaconHit, type BeaconResult } from '../lib/beacon'

/**
 * Beacon — canvas-wide full-text search over what your agents actually SAID.
 *
 * Opened with ⌘⇧F (App.tsx) or the Command Palette ('cmd:beacon'). On open it
 * takes a ONE-SHOT snapshot of every live terminal's recent scrollback via
 * termRegistry, then runs the PURE lib/beacon.search over it as you type
 * (debounced). Results group by node with a one-line excerpt + per-node match
 * count; ↑/↓ walk the flat hit list, Enter flies the camera to that agent
 * (centerOnNode) AND scrolls its terminal to the matching line with a transient
 * highlight (TerminalOverlay's beaconTarget subscriber), Esc closes.
 *
 * This is the first CanvasIO nav primitive that navigates by CONTENT rather than
 * node metadata. Purely renderer-side: it reads a transient store flag + calls
 * store actions (beaconJump / closeBeacon); no IPC, no geometry, no persistence.
 */

const DEBOUNCE_MS = 110

export function Beacon(): JSX.Element | null {
  const t = useT()
  const open = useCanvas((s) => s.beaconOpen)
  const nodes = useCanvas((s) => s.nodes)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const [raw, setRaw] = useState('')
  const [needle, setNeedle] = useState('')
  const [sel, setSel] = useState(0)
  // The scrollback snapshot is captured ONCE per open so results are stable while
  // typing (and we don't re-walk every buffer on each keystroke). null = closed.
  const [snap, setSnap] = useState<Map<string, string[]> | null>(null)

  // Capture the snapshot + reset transient UI state whenever the overlay opens;
  // drop it on close so closed terminals are never retained.
  useEffect(() => {
    if (open) {
      setSnap(termRegistry.snapshot())
      setRaw('')
      setNeedle('')
      setSel(0)
      // Focus the field after mount so typing lands in Beacon, not the canvas.
      requestAnimationFrame(() => inputRef.current?.focus())
    } else {
      setSnap(null)
    }
  }, [open])

  // Debounce the needle so a fast typist doesn't re-search on every keystroke.
  useEffect(() => {
    const id = window.setTimeout(() => setNeedle(raw), DEBOUNCE_MS)
    return () => window.clearTimeout(id)
  }, [raw])

  const result: BeaconResult = useMemo(() => {
    if (!snap) return { groups: [], hits: [], total: 0, capped: false }
    return search(snap, needle)
  }, [snap, needle])

  // Keep the selection in range as results change.
  useEffect(() => {
    setSel((s) => (result.hits.length === 0 ? 0 : Math.min(s, result.hits.length - 1)))
  }, [result.hits.length])

  // Map node id -> display title for group headers (falls back to the id).
  const titleOf = useMemo(() => {
    const m = new Map<string, string>()
    for (const n of nodes) m.set(n.id, n.title || n.id)
    return m
  }, [nodes])

  if (!open) return null

  const hits = result.hits
  const jump = (h: BeaconHit | undefined): void => {
    if (!h) return
    useCanvas.getState().beaconJump(h.nodeId, h.line)
    useCanvas.getState().closeBeacon()
  }

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      useCanvas.getState().closeBeacon()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel((s) => (hits.length === 0 ? 0 : (s + 1) % hits.length))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((s) => (hits.length === 0 ? 0 : (s - 1 + hits.length) % hits.length))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      jump(hits[sel])
    }
  }

  // Render an excerpt with the matched span highlighted.
  const renderExcerpt = (h: BeaconHit): JSX.Element => {
    const a = h.excerpt.slice(0, h.excerptCol)
    const b = h.excerpt.slice(h.excerptCol, h.excerptCol + h.matchLen)
    const c = h.excerpt.slice(h.excerptCol + h.matchLen)
    return (
      <span style={{ fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 11.5 }}>
        {a}
        <mark style={{ background: 'rgba(122,162,255,0.4)', color: '#eaf1ff', borderRadius: 3 }}>
          {b}
        </mark>
        {c}
      </span>
    )
  }

  // Walk the groups in order, but compute each hit's FLAT index so ↑/↓ selection
  // and the rendered list stay perfectly aligned.
  let flatIdx = -1

  return (
    <div
      className="glass no-drag beacon-overlay"
      data-canvasio-panel-root
      role="dialog"
      aria-label={t('beacon.dialog_label')}
      style={{
        pointerEvents: 'auto',
        position: 'absolute',
        top: '12vh',
        left: '50%',
        transform: 'translateX(-50%)',
        width: 'min(680px, 92vw)',
        maxHeight: '70vh',
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 14,
        padding: 12,
        color: '#d7e1f7',
        zIndex: 80
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <span aria-hidden style={{ fontSize: 15 }}>
          📡
        </span>
        <input
          ref={inputRef}
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          onKeyDown={onKey}
          placeholder={t('beacon.search_placeholder')}
          aria-label={t('beacon.search_label')}
          spellCheck={false}
          autoComplete="off"
          style={{
            flex: '1 1 auto',
            background: 'rgba(8,12,26,0.6)',
            border: '1px solid rgba(122,162,255,0.3)',
            borderRadius: 9,
            padding: '8px 11px',
            color: '#eaf1ff',
            fontSize: 14,
            outline: 'none'
          }}
        />
        <span style={{ fontSize: 10.5, color: '#6f84ad', whiteSpace: 'nowrap' }}>
          {termRegistry.size()}{' '}
          {termRegistry.size() === 1 ? t('beacon.terminal_one') : t('beacon.terminal_many')}
        </span>
        <button
          onClick={() => useCanvas.getState().closeBeacon()}
          aria-label={t('beacon.close_label')}
          title={t('beacon.close_title')}
          style={{ background: 'none', border: 'none', color: '#8fa3cc', cursor: 'pointer' }}
        >
          ✕
        </button>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 10.5,
          color: '#6f84ad',
          marginBottom: 6,
          minHeight: 14
        }}
      >
        {needle.trim() === '' ? (
          <span>{t('beacon.hint')}</span>
        ) : (
          <span>
            {result.total}{' '}
            {result.total === 1 ? t('beacon.match_one') : t('beacon.match_many')} {t('beacon.in')}{' '}
            {result.groups.length}{' '}
            {result.groups.length === 1 ? t('beacon.agent_one') : t('beacon.agent_many')}
            {result.capped && ` · ${t('beacon.capped')}`}
          </span>
        )}
        <span style={{ marginLeft: 'auto' }}>{t('beacon.nav_hints')}</span>
      </div>

      <div style={{ overflowY: 'auto', flex: '1 1 auto', minHeight: 0 }}>
        {needle.trim() !== '' && hits.length === 0 && (
          <div style={{ fontSize: 12, color: '#6f84ad', padding: '8px 4px' }}>
            {t('beacon.no_matches')}
          </div>
        )}
        {result.groups.map((g) => (
          <div key={g.nodeId} style={{ marginBottom: 8 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 11,
                fontWeight: 700,
                color: '#cfe0ff',
                padding: '2px 2px 4px'
              }}
            >
              <span
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  maxWidth: 460
                }}
              >
                {titleOf.get(g.nodeId) ?? g.nodeId}
              </span>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: '#9af0c6',
                  background: 'rgba(72,213,151,0.16)',
                  border: '1px solid rgba(72,213,151,0.45)',
                  borderRadius: 6,
                  padding: '0 6px'
                }}
              >
                {g.count}
              </span>
            </div>
            {g.hits.map((h) => {
              flatIdx++
              const idx = flatIdx
              const active = idx === sel
              return (
                <div
                  key={`${h.nodeId}:${h.line}:${h.col}`}
                  onMouseEnter={() => setSel(idx)}
                  onClick={() => jump(h)}
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 8,
                    padding: '5px 8px',
                    marginBottom: 2,
                    borderRadius: 8,
                    cursor: 'pointer',
                    background: active ? 'rgba(122,162,255,0.18)' : 'rgba(8,12,26,0.4)',
                    border: active
                      ? '1px solid rgba(122,162,255,0.5)'
                      : '1px solid rgba(122,162,255,0.08)'
                  }}
                >
                  <span
                    style={{
                      flex: '0 0 auto',
                      fontSize: 9.5,
                      color: '#6f84ad',
                      fontFamily: 'ui-monospace,Menlo,monospace'
                    }}
                  >
                    {h.line + 1}
                  </span>
                  <span
                    style={{
                      flex: '1 1 0',
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {renderExcerpt(h)}
                  </span>
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
