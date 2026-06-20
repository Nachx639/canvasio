import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

// ── Draggable HUD panels ──────────────────────────────────────────────────────
//
// A reusable hook that makes a floating SCREEN-SPACE HUD panel (DoctorPanel,
// DrawProperties, MissionLog…) draggable by a grip handle, persisting its moved
// position across relaunches under localStorage and clamping it so it can never
// be dragged fully off-screen.
//
// DESIGN — preserve default layouts until the user moves something:
//   • Until the user drags a panel, the hook returns an EMPTY style ({}), so the
//     panel keeps its existing CSS-based default position (right:14, top:50%,…).
//   • Only AFTER a drag (or a previously persisted drag) does it switch to an
//     absolute fixed left/top that overrides those defaults.
//
// These are SCREEN-space HUD panels, not canvas nodes: 1px of pointer movement is
// 1px of panel movement — we deliberately do NOT scale by camera zoom.
//
// Pointer handling mirrors the existing ResizeBox pattern in TerminalOverlay.tsx
// (setPointerCapture / releasePointerCapture). The in-flight drag lives in a ref
// so a drag doesn't trigger a re-render storm; only the COMMITTED position on
// pointerup is written to React state + localStorage.

export interface Pos {
  x: number
  y: number
}

export interface DraggablePanelOptions {
  /** Default CSS `right` of the panel (px) — informational; the hook does not
   *  apply it (the panel's own CSS does), it is reserved for callers. */
  defaultRight?: number
  /** Default CSS `top` of the panel (px) — same note as defaultRight. */
  defaultTop?: number
  /** Minimum number of panel pixels that must remain on-screen on every edge so
   *  the panel can never be dragged fully out of reach. */
  margin?: number
}

export interface DragHandleProps {
  onPointerDown: (e: React.PointerEvent) => void
  onPointerMove: (e: React.PointerEvent) => void
  onPointerUp: (e: React.PointerEvent) => void
  onPointerCancel: (e: React.PointerEvent) => void
  style: React.CSSProperties
}

export interface UseDraggablePanel {
  /** Spread/merge onto the panel ROOT element. {} until a position is active, then
   *  a fixed left/top override. */
  style: React.CSSProperties
  /** Spread onto the drag-handle (grip) element. Carries pointer handlers + the
   *  grab cursor. */
  dragHandleProps: DragHandleProps
  /** Clear the saved position so the panel snaps back to its CSS default. */
  reset: () => void
}

const KEY_PREFIX = 'canvasio:panelpos:'
const DEFAULT_MARGIN = 48

function storageKey(key: string): string {
  return KEY_PREFIX + key
}

function loadPos(key: string): Pos | null {
  try {
    const raw = localStorage.getItem(storageKey(key))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Pos>
    if (
      parsed &&
      typeof parsed.x === 'number' &&
      typeof parsed.y === 'number' &&
      Number.isFinite(parsed.x) &&
      Number.isFinite(parsed.y)
    ) {
      return { x: parsed.x, y: parsed.y }
    }
  } catch {
    /* ignore malformed/blocked storage */
  }
  return null
}

function savePos(key: string, pos: Pos): void {
  try {
    localStorage.setItem(storageKey(key), JSON.stringify(pos))
  } catch {
    /* ignore quota/blocked storage */
  }
}

function clearPos(key: string): void {
  try {
    localStorage.removeItem(storageKey(key))
  } catch {
    /* ignore */
  }
}

/**
 * Clamp a panel's top-left so at least `margin` px of its WIDTH stay inside the
 * window on the left/right edges and at least `margin` px of its HEIGHT stay
 * inside on the top/bottom — i.e. the panel is always reachable. `w`/`h` are the
 * panel's measured size; when 0 (not yet measured) we only guard the top-left
 * corner against going off the top/left so the grip stays grabbable.
 */
function clamp(pos: Pos, w: number, h: number, margin: number): Pos {
  const vw = window.innerWidth
  const vh = window.innerHeight
  // Horizontal: keep at least `margin` px visible on each side.
  const minX = w > 0 ? margin - w : 0
  const maxX = w > 0 ? vw - margin : vw - margin
  // Vertical: same, and never let the top go above 0 by more than nothing — the
  // grip is at the panel top, so the top edge must stay >= 0 (or within margin).
  const minY = 0
  const maxY = h > 0 ? vh - margin : vh - margin
  return {
    x: Math.max(minX, Math.min(maxX, pos.x)),
    y: Math.max(minY, Math.min(maxY, pos.y))
  }
}

// In Chromium/Electron, an ancestor with a non-none transform/perspective/filter/
// backdrop-filter (or a contain/will-change that implies one) establishes the
// CONTAINING BLOCK for position:fixed descendants. When such an ancestor exists,
// a fixed element's left/top resolve relative to that ancestor's border box, NOT
// the viewport. We keep all drag math in viewport coords; this returns the
// containing block's viewport offset so the rendered left/top can subtract it and
// land at the intended viewport position. Returns {0,0} when no such ancestor
// exists (fixed resolves against the viewport as usual).
function fixedContainingBlockOffset(el: HTMLElement | null): { x: number; y: number } {
  let node: HTMLElement | null = el && el.parentElement ? el.parentElement : null
  while (node && node !== document.body && node !== document.documentElement) {
    const cs = getComputedStyle(node)
    const wbf = (cs as unknown as { webkitBackdropFilter?: string }).webkitBackdropFilter
    const establishes =
      (cs.transform && cs.transform !== 'none') ||
      (cs.perspective && cs.perspective !== 'none') ||
      (cs.filter && cs.filter !== 'none') ||
      (cs.backdropFilter && cs.backdropFilter !== 'none') ||
      (wbf && wbf !== 'none') ||
      (cs.willChange && /transform|filter|perspective/.test(cs.willChange)) ||
      (cs.contain && /paint|layout|strict|content/.test(cs.contain))
    if (establishes) {
      const r = node.getBoundingClientRect()
      return { x: r.left, y: r.top }
    }
    node = node.parentElement
  }
  return { x: 0, y: 0 }
}

interface DragState {
  pointerId: number
  startX: number
  startY: number
  baseLeft: number
  baseTop: number
  w: number
  h: number
}

// Saved document.body inline styles to restore after a drag suppresses native
// text-selection (userSelect) and overrides the cursor (grabbing). Module-level
// so a single in-flight drag's restore is unambiguous even if several panels are
// mounted; we only ever toggle these between one panel's pointerdown/pointerup.
interface BodyStyleSnapshot {
  userSelect: string
  webkitUserSelect: string
  cursor: string
}

function suppressBodySelection(): BodyStyleSnapshot {
  const body = document.body
  const snapshot: BodyStyleSnapshot = {
    userSelect: body.style.userSelect,
    // -webkit-user-select is what Chromium (Electron) actually honors.
    webkitUserSelect: body.style.getPropertyValue('-webkit-user-select'),
    cursor: body.style.cursor
  }
  body.style.userSelect = 'none'
  body.style.setProperty('-webkit-user-select', 'none')
  body.style.cursor = 'grabbing'
  return snapshot
}

function restoreBodySelection(snapshot: BodyStyleSnapshot | null): void {
  if (!snapshot) return
  const body = document.body
  body.style.userSelect = snapshot.userSelect
  if (snapshot.webkitUserSelect) {
    body.style.setProperty('-webkit-user-select', snapshot.webkitUserSelect)
  } else {
    body.style.removeProperty('-webkit-user-select')
  }
  body.style.cursor = snapshot.cursor
}

export function useDraggablePanel(
  key: string,
  opts: DraggablePanelOptions = {}
): UseDraggablePanel {
  const margin = opts.margin ?? DEFAULT_MARGIN
  // Committed, persisted position. null => no override yet (keep CSS default).
  // Clamp the persisted pos into the CURRENT viewport on first paint so a stale
  // off-screen saved value (e.g. from a previously larger window, or an
  // edge-parked panel after the window shrank) never renders out of view. The
  // element isn't measured yet, so this is a w/h=0 corner clamp; a useLayoutEffect
  // below re-clamps with the real measured size right after mount.
  const [pos, setPos] = useState<Pos | null>(() => {
    const saved = loadPos(key)
    if (!saved) return null
    return clamp(saved, 0, 0, margin)
  })
  // Viewport offset of the panel's fixed-positioning containing block (the .glass
  // pill whose backdrop-filter establishes one). `pos` stays in viewport coords;
  // the rendered fixed left/top subtract this so the panel lands where intended.
  const [cbOffset, setCbOffset] = useState<Pos>({ x: 0, y: 0 })
  // In-flight drag state — a ref so pointermove never re-renders the panel.
  const dragRef = useRef<DragState | null>(null)
  // The element that received pointer capture (the grip), so pointermove/up can
  // imperatively move the panel ROOT and release capture.
  const handleElRef = useRef<HTMLElement | null>(null)
  // The panel ROOT element we move during a drag, resolved from the grip's
  // offsetParent-independent closest positioned ancestor at drag start.
  const rootElRef = useRef<HTMLElement | null>(null)
  // Saved document.body inline styles captured at pointerdown so we can restore
  // them on pointerup/pointercancel after suppressing text-selection.
  const bodyStyleRef = useRef<BodyStyleSnapshot | null>(null)

  // Re-clamp on window resize so a panel parked near an edge stays reachable when
  // the window shrinks. Only matters once a position is active.
  useEffect(() => {
    if (!pos) return
    const onResize = (): void => {
      setPos((prev) => {
        if (!prev) return prev
        // We don't have a live measured size here cheaply; use the last known
        // element size if the root is still mounted, else fall back to corner
        // clamp. The root element is resolved lazily on the next drag; for resize
        // we approximate with 0 size (corner clamp), which keeps the top-left
        // reachable — the common case for an edge-parked panel.
        const root = rootElRef.current
        // The centered .glass pill moves when the window resizes, so its
        // containing-block offset changes; refresh it for the rendered left/top.
        if (root) setCbOffset(fixedContainingBlockOffset(root))
        const w = root ? root.offsetWidth : 0
        const h = root ? root.offsetHeight : 0
        const next = clamp(prev, w, h, margin)
        if (next.x === prev.x && next.y === prev.y) return prev
        savePos(key, next)
        return next
      })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [pos, key, margin])

  // Re-clamp ONCE on mount with the real measured panel size so a panel always
  // opens FULLY visible — not just corner-reachable like the lazy w/h=0 init
  // clamp above. Runs before paint (useLayoutEffect) to avoid a visible jump.
  // Only acts when a position is active; resolves the root via the same
  // [data-canvasio-panel-root] tag the drag uses, then persists if it changed.
  useLayoutEffect(() => {
    if (!pos) return
    // Resolve THIS panel's root. Prefer the rootRef the caller wired via the
    // returned `rootRef` callback (unambiguous even with several panels mounted).
    // Fall back to the unique `[data-canvasio-panel-root]` element whose rendered
    // top-left already matches our just-applied `pos` — that is the element React
    // styled from this hook — and finally to the sole tagged element if there is
    // only one. If none can be resolved we corner-clamp (w/h=0), which the lazy
    // init already did, so this is a safe no-op in the worst case.
    let root = rootElRef.current
    if (!root) {
      const tagged = Array.from(
        document.querySelectorAll<HTMLElement>('[data-canvasio-panel-root]')
      )
      if (tagged.length === 1) {
        root = tagged[0]
      } else {
        root =
          tagged.find((el) => {
            const r = el.getBoundingClientRect()
            return Math.abs(r.left - pos.x) < 1 && Math.abs(r.top - pos.y) < 1
          }) ?? null
      }
      if (root) rootElRef.current = root
    }
    // A REOPENED panel renders from persisted `pos` without a drag; refresh the
    // containing-block offset so its fixed left/top subtract the right amount.
    if (root) setCbOffset(fixedContainingBlockOffset(root))
    const w = root ? root.offsetWidth : 0
    const h = root ? root.offsetHeight : 0
    setPos((prev) => {
      if (!prev) return prev
      const next = clamp(prev, w, h, margin)
      if (next.x === prev.x && next.y === prev.y) return prev
      savePos(key, next)
      return next
    })
    // Run once on mount; we intentionally don't depend on `pos` so this doesn't
    // re-fire on every drag-driven setPos.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Safety net: if the panel unmounts mid-drag, restore any body styles we
  // suppressed so the page's selection/cursor never get permanently stuck.
  useEffect(() => {
    return () => {
      if (bodyStyleRef.current) {
        restoreBodySelection(bodyStyleRef.current)
        bodyStyleRef.current = null
      }
    }
  }, [])

  const onPointerDown = useCallback(
    (e: React.PointerEvent): void => {
      // Only primary button / touch / pen starts a drag.
      if (e.button != null && e.button !== 0) return
      const handle = e.currentTarget as HTMLElement
      // Resolve the panel ROOT to move: the nearest positioned ancestor that is
      // the panel itself. We tag the root via a data attribute applied by the
      // grip's container; fall back to the handle's offsetParent.
      const root =
        (handle.closest('[data-canvasio-panel-root]') as HTMLElement | null) ??
        (handle.offsetParent as HTMLElement | null) ??
        handle.parentElement
      if (!root) return
      const rect = root.getBoundingClientRect()
      dragRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        baseLeft: rect.left,
        baseTop: rect.top,
        w: rect.width,
        h: rect.height
      }
      handleElRef.current = handle
      rootElRef.current = root
      // Capture the fixed-positioning containing block's viewport offset so the
      // rendered fixed left/top can subtract it (the .glass pill ancestor).
      const cb = fixedContainingBlockOffset(root)
      setCbOffset(cb)
      // Pin the panel to its EXACT current viewport rect the instant it is grabbed,
      // switching position:absolute -> position:fixed BEFORE any movement. rect comes
      // from getBoundingClientRect (always viewport-relative), so fixed renders at the
      // same on-screen spot the user sees — killing the absolute->fixed jump that
      // otherwise displaced the panel sideways on the first pointermove.
      setPos(clamp({ x: rect.left, y: rect.top }, rect.width, rect.height, margin))
      try {
        handle.setPointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
      // Suppress native text-selection for the DURATION of the drag: pointerdown
      // preventDefault alone does NOT reliably cancel Chromium's text selection as
      // the pointer drifts over the panel's selectable body content. We flip
      // document.body user-select to none (+ a grabbing cursor) and restore the
      // prior values on pointerup/pointercancel. Because this lives only between
      // down and up, a plain click is unaffected, so panel buttons/inputs still
      // work normally.
      bodyStyleRef.current = suppressBodySelection()
      e.preventDefault()
      e.stopPropagation()
    },
    [margin]
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent): void => {
      const d = dragRef.current
      if (!d || e.pointerId !== d.pointerId) return
      const root = rootElRef.current
      if (!root) return
      const dx = e.clientX - d.startX
      const dy = e.clientY - d.startY
      const next = clamp(
        { x: d.baseLeft + dx, y: d.baseTop + dy },
        d.w,
        d.h,
        margin
      )
      // Drive the position through React state on every move. These HUD panels
      // (Doctor/MissionLog) re-render constantly from live data; an imperative
      // inline style would be CLOBBERED by React's next render (which would revert
      // the panel to its CSS default, making it jump up to top:46/top:50%). Setting
      // committed `pos` keeps React's own style attribute in sync with the drag, so
      // a mid-drag re-render can never fight us. One setState per move is cheap for
      // a single element.
      setPos(next)
      e.stopPropagation()
    },
    [margin]
  )

  const onPointerUp = useCallback(
    (e: React.PointerEvent): void => {
      const d = dragRef.current
      if (!d || e.pointerId !== d.pointerId) return
      const handle = handleElRef.current
      try {
        handle?.releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
      const dx = e.clientX - d.startX
      const dy = e.clientY - d.startY
      const next = clamp(
        { x: d.baseLeft + dx, y: d.baseTop + dy },
        d.w,
        d.h,
        margin
      )
      dragRef.current = null
      handleElRef.current = null
      // Restore the body's text-selection + cursor we suppressed on pointerdown.
      restoreBodySelection(bodyStyleRef.current)
      bodyStyleRef.current = null
      // Position is already live in React state from the last pointermove; just
      // persist the committed value. React owns the inline style throughout, so
      // there is nothing imperative to clean up.
      setPos(next)
      savePos(key, next)
      e.stopPropagation()
    },
    [key, margin]
  )

  // If the OS/browser cancels the pointer mid-drag (e.g. a gesture interrupt),
  // tear down exactly like pointerup minus the commit: release capture, drop the
  // drag state, and restore the body styles so selection/cursor never get stuck.
  const onPointerCancel = useCallback((e: React.PointerEvent): void => {
    const d = dragRef.current
    if (!d || e.pointerId !== d.pointerId) return
    const handle = handleElRef.current
    try {
      handle?.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    dragRef.current = null
    handleElRef.current = null
    restoreBodySelection(bodyStyleRef.current)
    bodyStyleRef.current = null
    e.stopPropagation()
  }, [])

  const reset = useCallback((): void => {
    clearPos(key)
    setPos(null)
  }, [key])

  const style: React.CSSProperties = pos
    ? {
        position: 'fixed',
        left: pos.x - cbOffset.x,
        top: pos.y - cbOffset.y,
        right: 'auto',
        bottom: 'auto',
        transform: 'none'
      }
    : {}

  const dragHandleProps: DragHandleProps = {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    style: { cursor: 'grab', touchAction: 'none', userSelect: 'none' }
  }

  return { style, dragHandleProps, reset }
}
