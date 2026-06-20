import { useCallback, useMemo, useState, useEffect, useRef } from 'react'
import { useWorkspace, type CanvasMeta } from '../store/workspace'
import { useDismiss } from '../lib/useDismiss'
import { t, useT } from '../store/i18n'

/**
 * "Abrir lienzo" — a dropdown listing ALL canvases on disk (name + relative
 * updated time), with a search box to filter, click-to-open, and per-row delete
 * (with confirm). This is the "find them directly in a dropdown" UX — no file
 * dialog.
 *
 * REACT #185 SAFETY: `canvases` arrives as a prop (already shallow-selected by
 * the parent), and the filtered list is derived with useMemo over it — never a
 * new-ref zustand selector. The local query is plain useState.
 */
export function OpenPicker({ canvases }: { canvases: CanvasMeta[] }): JSX.Element {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement | null>(null)

  // Refresh the on-disk list whenever the dropdown opens so it reflects docs
  // created in other ways. One-shot per open (correct deps, no per-render setState).
  useEffect(() => {
    if (open) void useWorkspace.getState().refresh()
  }, [open])

  // Close on outside click / Escape (shared impl: rootRef wraps trigger + panel).
  useDismiss(open, useCallback(() => setOpen(false), []), rootRef)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return canvases
    return canvases.filter((c) => c.name.toLowerCase().includes(q))
  }, [query, canvases])

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        type="button"
        title={t('openPicker.open_canvas')}
        aria-label={t('openPicker.open_canvas')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          height: 24,
          padding: '0 9px',
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(140,165,225,0.25)',
          borderRadius: 7,
          color: '#aebbd6',
          fontSize: 12,
          cursor: 'pointer'
        }}
      >
        <span style={{ opacity: 0.6, fontSize: 10 }}>▾</span>
        {t('openPicker.open_canvas')}
      </button>

      {open && (
        <div
          className="glass"
          style={{
            // Anchor LEFT (open rightward): the picker lives in the left-edge
            // dock, so a right-anchored panel would spill off the left of the
            // screen. zIndex 70 keeps it above the Toolbar (z 40) it overlaps.
            position: 'absolute',
            top: 30,
            left: 0,
            width: 280,
            maxHeight: 360,
            display: 'flex',
            flexDirection: 'column',
            borderRadius: 10,
            padding: 8,
            zIndex: 70,
            pointerEvents: 'auto'
          }}
        >
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('openPicker.search_placeholder')}
            aria-label={t('openPicker.search_aria')}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              background: 'rgba(0,0,0,0.3)',
              border: '1px solid rgba(140,165,225,0.3)',
              borderRadius: 6,
              color: '#eaf1ff',
              font: 'inherit',
              fontSize: 12.5,
              padding: '5px 8px',
              outline: 'none',
              marginBottom: 6
            }}
          />
          <div style={{ overflowY: 'auto' }}>
            {filtered.length === 0 ? (
              <div style={{ color: '#8ba0c8', fontSize: 12, padding: '8px 6px' }}>
                {canvases.length === 0 ? t('openPicker.empty') : t('openPicker.no_matches')}
              </div>
            ) : (
              filtered.map((c) => (
                <Row key={c.id} meta={c} onPick={() => setOpen(false)} />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function Row({ meta, onPick }: { meta: CanvasMeta; onPick: () => void }): JSX.Element {
  const t = useT()
  return (
    <div
      onClick={() => {
        void useWorkspace.getState().openCanvas(meta.id)
        onPick()
      }}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        padding: '6px 7px',
        borderRadius: 6,
        cursor: 'pointer'
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(120,160,255,0.14)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            color: '#dde7fb',
            fontSize: 12.5,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {meta.name}
        </div>
        <div style={{ color: '#7d8fb3', fontSize: 10.5 }}>{formatRelative(meta.updatedTs)}</div>
      </div>
      <button
        type="button"
        title={t('openPicker.delete_canvas')}
        aria-label={t('openPicker.delete_named', { name: meta.name })}
        onClick={(e) => {
          e.stopPropagation()
          const ok =
            typeof window.confirm === 'function'
              ? window.confirm(t('openPicker.delete_confirm', { name: meta.name }))
              : true
          if (ok) void useWorkspace.getState().deleteCanvas(meta.id)
        }}
        style={{
          flex: '0 0 auto',
          width: 22,
          height: 22,
          display: 'grid',
          placeItems: 'center',
          background: 'transparent',
          border: 'none',
          borderRadius: 5,
          color: '#9aa7c4',
          opacity: 0.7,
          cursor: 'pointer',
          fontSize: 13
        }}
      >
        🗑
      </button>
    </div>
  )
}

/** Compact relative-time formatter (Spanish-first) for the picker rows. */
function formatRelative(ts: number): string {
  if (!ts || !Number.isFinite(ts)) return t('openPicker.time_no_date')
  const diff = Date.now() - ts
  if (diff < 0) return t('openPicker.time_now')
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return t('openPicker.time_moment')
  const min = Math.floor(sec / 60)
  if (min < 60) return t('openPicker.time_minutes', { min })
  const hr = Math.floor(min / 60)
  if (hr < 24) return t('openPicker.time_hours', { hr })
  const day = Math.floor(hr / 24)
  if (day < 30) return t('openPicker.time_days', { day })
  return new Date(ts).toLocaleDateString()
}
