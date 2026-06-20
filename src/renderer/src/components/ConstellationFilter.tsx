import { useEffect, useRef, useState } from 'react'
import { useCanvas } from '../store/canvas'
import { useT } from '../store/i18n'

/**
 * Constellation Filter — a slim glass search pill (styled like WaypointRail /
 * DirectorChip) that turns the whole spatial scene into a queryable map. As the
 * user types, EVERY matching node lights up (`.spotlit`) and non-matches recede
 * (`.dimmed`) via the existing NodeView derivation, and the camera auto-frames
 * the matched subset so the answer is on screen at once.
 *
 *   • type            → live filter (NodeView spotlights/dims) + debounced frameMatches
 *   • Enter / ⇧Enter  → cycle the camera through matches one-by-one (centerOnNode)
 *   • Escape          → clear the filter (setFilter(null)) + spring the camera back
 *
 * CAMERA/RENDERER-ONLY: never mutates node/shape geometry, never touches IPC.
 * Hidden entirely when filterQuery is null (no chrome when unused), matching the
 * convention every existing overlay follows. Mounted in App.tsx next to
 * WaypointRail; opened by App's '/' (and ⌘F) shortcut via setFilter('').
 */
export function ConstellationFilter(): JSX.Element | null {
  const t = useT()
  const filterQuery = useCanvas((s) => s.filterQuery)
  const setFilter = useCanvas((s) => s.setFilter)
  const frameMatches = useCanvas((s) => s.frameMatches)
  const filterMatches = useCanvas((s) => s.filterMatches)
  const centerOnNode = useCanvas((s) => s.centerOnNode)
  const cameraBack = useCanvas((s) => s.cameraBack)

  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<number>(0)
  // Index into the current match list for Enter/Shift+Enter cycling. Reset to -1
  // whenever the query text changes so the next Enter starts at the first match.
  const cycleRef = useRef<number>(-1)

  // Live match count, recomputed whenever the query (or nodes) change. Subscribing
  // to the whole nodes array keeps the count correct if a node finishes/renames
  // while the pill is open.
  const matchCount = useCanvas((s) => {
    if (s.filterQuery == null) return 0
    return s.filterMatches().length
  })

  // Focus the input as soon as the pill appears (the shortcut opens it).
  const open = filterQuery != null
  useEffect(() => {
    if (open) {
      cycleRef.current = -1
      inputRef.current?.focus()
    }
  }, [open])

  // Debounced camera framing on every query change (kept off the keystroke path
  // so fast typing doesn't fire a tween per character). Cleared on unmount.
  useEffect(() => {
    if (filterQuery == null) return
    window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => frameMatches(), 220)
    return () => window.clearTimeout(debounceRef.current)
  }, [filterQuery, frameMatches])

  if (!open) return null

  const close = (): void => {
    window.clearTimeout(debounceRef.current)
    setFilter(null)
    // Spring the camera back to where we were before framing (Slipstream Back).
    cameraBack()
  }

  const cycle = (dir: 1 | -1): void => {
    const ids = filterMatches()
    if (!ids.length) return
    const len = ids.length
    const cur = cycleRef.current
    const next = cur < 0 ? (dir === 1 ? 0 : len - 1) : (cur + dir + len) % len
    cycleRef.current = next
    centerOnNode(ids[next])
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    // Keep global single-key shortcuts (/, f, t, l, …) from firing while typing.
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      cycle(e.shiftKey ? -1 : 1)
    }
  }

  return (
    <div className="constellation-filter glass no-drag" role="search">
      <span className="constellation-glyph" aria-hidden>
        ⌕
      </span>
      <input
        ref={inputRef}
        className="constellation-input"
        type="text"
        value={filterQuery}
        placeholder={t('constellationFilter.placeholder')}
        aria-label={t('constellationFilter.input_aria')}
        onChange={(e) => {
          cycleRef.current = -1
          setFilter(e.target.value)
        }}
        onKeyDown={onKeyDown}
        spellCheck={false}
        autoComplete="off"
      />
      <span className="constellation-count" aria-live="polite">
        {matchCount}{' '}
        {matchCount === 1
          ? t('constellationFilter.match_one')
          : t('constellationFilter.match_other')}
      </span>
      <button
        type="button"
        className="constellation-close"
        onClick={close}
        title={t('constellationFilter.close_title')}
        aria-label={t('constellationFilter.close_aria')}
      >
        ×
      </button>
    </div>
  )
}
