import { useEffect, useRef, useState } from 'react'
import { useCanvas } from '../store/canvas'
import { useDirector } from '../store/director'
import { useDrawing, Shape, ShapeType, hitTest, shapeBBox, DEFAULT_FONT_SIZE } from '../store/drawing'
import { NodeView } from './NodeView'
import { ConduitsLayer } from './ConduitsLayer'
import { RegionsLayer } from './RegionsLayer'
import { DrawingLayer, DrawingOverlays } from './DrawingLayer'
import { TerminalOverlays, ResizeOverlays } from './TerminalOverlay'
import { BackdropFrost } from './BackdropFrost'

type InteractionMode = 'pan' | 'create' | 'move' | 'resize' | 'pen' | 'loupe' | null

/**
 * Loupe — an in-progress drag-a-box marquee-zoom gesture. Tracked in a module-
 * local ref (mirrors the `interaction` ref): the client-space start corner and
 * the live current corner, plus the world-space start corner so the framed
 * region is computed exactly even if the camera somehow shifts mid-drag. The
 * screen-space rect for the rubber-band <div> is derived from these on every
 * move and mirrored into React state (`loupeBox`) for rendering. */
interface LoupeDrag {
  startClient: { x: number; y: number }
  startWorld: { x: number; y: number }
}

interface Interaction {
  mode: InteractionMode
  shapeId: string | null
  handle: string | null
  startWorld: { x: number; y: number }
  origShape: Shape | null
  /** snapshot of EVERY selected shape at pointer-down, for moving the whole
      multi-selection / group together by a shared delta. */
  origShapes: Shape[] | null
}

// Subscribes to `camera` in isolation so that pan/zoom frames (which fire
// setCamera on every wheel/drag frame) only re-render this tiny wrapper to
// update the transform string, instead of re-rendering the whole Canvas body
// (and reconciling RegionsLayer / DrawingLayer / every NodeView) each frame.
function CanvasWorld({ children }: { children: React.ReactNode }): JSX.Element {
  const camera = useCanvas((s) => s.camera)
  return (
    <div
      className="canvas-world"
      style={{
        transform: `translate(${Math.round(camera.x)}px, ${Math.round(camera.y)}px) scale(${camera.zoom})`
      }}
    >
      {children}
    </div>
  )
}

export function Canvas(): JSX.Element {
  const nodes = useCanvas((s) => s.nodes)
  const panBy = useCanvas((s) => s.panBy)
  const zoomAt = useCanvas((s) => s.zoomAt)
  const select = useCanvas((s) => s.select)

  const viewportRef = useRef<HTMLDivElement>(null)
  const panning = useRef<{ x: number; y: number } | null>(null)
  const interaction = useRef<Interaction | null>(null)
  const [editingTextId, setEditingTextId] = useState<string | null>(null)
  // Loupe — drag-a-box marquee zoom. `loupeDrag` holds the in-flight gesture (ref,
  // so pointer handlers read it without a re-render); `zHeld` switches the cursor
  // to crosshair while Z is down; `loupeBox` is the screen-space rubber-band rect
  // (null = nothing to draw -> zero chrome / zero cost, like Atlas/Watchtower).
  const loupeDrag = useRef<LoupeDrag | null>(null)
  const [zHeld, setZHeld] = useState(false)
  const [loupeBox, setLoupeBox] = useState<{
    x: number
    y: number
    w: number
    h: number
  } | null>(null)

  // wheel: pan with two-finger, zoom with ctrl/⌘ (pinch)
  useEffect(() => {
    const el = viewportRef.current!
    const onWheel = (e: WheelEvent): void => {
      // A wheel over an interactive terminal overlay must scroll ONLY xterm's
      // scrollback, not pan/zoom the camera. Bail early WITHOUT preventDefault so
      // xterm's own wheel handler proceeds. When the overlay is suspended at low
      // zoom it is pointerEvents:none, so the wheel target is the in-world glance
      // card (NOT inside [data-terminal-overlay]) and the camera still pans here.
      // Also bail over any scrollable node body ([data-canvas-scroll]: the markdown
      // note content/editor, the folder list, …) so the wheel scrolls THAT element
      // instead of being preventDefault'd + panning the canvas. The native canvas
      // listener would otherwise eat the wheel even when the inner element has
      // overflow:auto (React's stopPropagation can't stop this native ancestor).
      const tgt = e.target as HTMLElement | null
      if (tgt && tgt.closest('[data-terminal-overlay],[data-canvas-scroll]')) return
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) {
        zoomAt(e.clientX, e.clientY, e.deltaY)
      } else {
        panBy(-e.deltaX, -e.deltaY)
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [panBy, zoomAt])

  // keyboard: delete / escape / duplicate
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      const typing =
        t &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.isContentEditable ||
          t.tagName === 'SELECT')
      const draw = useDrawing.getState()

      if (e.key === 'Escape') {
        setEditingTextId(null)
        draw.setTool('select')
        draw.clearSelection()
        // Loupe — Esc cancels an armed / in-progress marquee zoom with NO camera
        // move (clear the in-flight drag + rubber-band + crosshair).
        loupeDrag.current = null
        setLoupeBox(null)
        setZHeld(false)
        return
      }
      if (typing) return
      // Loupe — Drag-a-Box Marquee Zoom. Holding bare Z (no meta/ctrl, not typing)
      // arms the gesture: the cursor becomes a crosshair and a left-drag on the
      // canvas rubber-bands a region to fly to. Guarded so Z never hijacks shape /
      // text work: ignore while a creation/drawing tool is active or a text shape
      // is being edited. Mirrors Atlas's hold-O Exposé idiom (self-cancels on keyup
      // /Esc). repeat keydowns (key auto-repeat) are no-ops once armed.
      if (
        (e.key === 'z' || e.key === 'Z') &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        draw.activeTool === 'select' &&
        !editingTextId
      ) {
        if (!zHeld) setZHeld(true)
        return
      }
      // Layout Time Machine: spatial undo/redo. Cmd/Ctrl+Z undoes the last
      // destructive spatial action (drag/resize/arrange/flow/close); add Shift
      // to redo. Guarded by `typing` above so it never steals from inputs/xterm.
      if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        if (e.shiftKey) useCanvas.getState().redo()
        else useCanvas.getState().undo()
        return
      }
      // Director Mode: live auto-follow camera toggle (Cmd/Ctrl+J).
      if ((e.metaKey || e.ctrlKey) && (e.key === 'j' || e.key === 'J')) {
        e.preventDefault()
        useDirector.getState().toggle()
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (draw.selectedShapeIds.length > 0) {
          e.preventDefault()
          draw.removeSelected()
        }
        return
      }
      // group / ungroup (Cmd/Ctrl+G, Cmd/Ctrl+Shift+G)
      if ((e.metaKey || e.ctrlKey) && (e.key === 'g' || e.key === 'G')) {
        e.preventDefault()
        if (e.shiftKey) draw.ungroup()
        else draw.group()
        return
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'd' || e.key === 'D')) {
        if (draw.selectedShapeIds.length === 1) {
          e.preventDefault()
          draw.duplicateShape(draw.selectedShapeIds[0])
        }
      }
    }
    // Loupe — releasing Z disarms the gesture and cancels any in-progress drag
    // with no camera move (a committed zoom happens only on pointerUp). Self-
    // cancelling, exactly like Atlas's hold-O.
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.key === 'z' || e.key === 'Z') {
        setZHeld(false)
        loupeDrag.current = null
        setLoupeBox(null)
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [editingTextId, zHeld])

  // Finish editing a text shape: keep it if it has content, drop it if it's
  // truly empty (e.g. the user clicked to place text then clicked away without
  // typing). The text itself is already persisted to the store on every
  // keystroke, so committing is just clearing the editing overlay.
  const commitText = (): void => {
    const id = editingTextId
    setEditingTextId(null)
    if (!id) return
    const draw = useDrawing.getState()
    const shape = draw.shapes.find((s) => s.id === id)
    if (shape && shape.type === 'text' && !(shape.text ?? '').trim()) {
      draw.removeShape(id)
    }
  }

  const toWorld = (clientX: number, clientY: number): { x: number; y: number } => {
    const cam = useCanvas.getState().camera
    return { x: (clientX - cam.x) / cam.zoom, y: (clientY - cam.y) / cam.zoom }
  }

  const startPan = (e: React.PointerEvent): void => {
    panning.current = { x: e.clientX, y: e.clientY }
    interaction.current = {
      mode: 'pan',
      shapeId: null,
      handle: null,
      startWorld: { x: 0, y: 0 },
      origShape: null,
      origShapes: null
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const onPointerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0 && e.button !== 1) return
    // Loupe — when Z is held, a left-drag starts a marquee-zoom region (BEFORE any
    // tool branch, so it wins over pan/select). Record both the client-space and
    // world-space start corner; the camera does not move until pointerUp. No
    // InteractionMode is needed — the loupeDrag ref fully tracks the gesture.
    if (zHeld && e.button === 0) {
      loupeDrag.current = {
        startClient: { x: e.clientX, y: e.clientY },
        startWorld: toWorld(e.clientX, e.clientY)
      }
      setLoupeBox({ x: e.clientX, y: e.clientY, w: 0, h: 0 })
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      e.preventDefault()
      return
    }
    const draw = useDrawing.getState()
    const tool = draw.activeTool
    const targetEl = e.target as HTMLElement
    const hitShapeId = targetEl.getAttribute?.('data-shape-id') ?? null
    const hitHandle = targetEl.getAttribute?.('data-handle') ?? null
    const onBackground = e.target === e.currentTarget

    // commit any in-progress text edit when clicking elsewhere (the in-place
    // editor is now a contentEditable div, not a textarea)
    if (editingTextId && !targetEl.closest?.('[data-canvasio-text-editor]')) {
      commitText()
    }

    // middle button or hand tool always pans
    if (e.button === 1 || tool === 'hand') {
      if (onBackground || e.button === 1) {
        select(null)
        startPan(e)
        e.preventDefault()
      }
      return
    }

    // node DOM interactions are handled by NodeView (stopPropagation), so if we
    // reach here on a node child, ignore unless it's a shape/handle.
    const world = toWorld(e.clientX, e.clientY)
    const zoom = useCanvas.getState().camera.zoom

    // A creation gesture may start anywhere that isn't a node. We must NOT rely
    // on `e.target === e.currentTarget` (onBackground): now that shapes actually
    // paint, a click landing on a node's DOM must still be excluded, while a
    // click on empty space OR on an existing shape should proceed. Painted
    // shapes have pointerEvents:none unless the select/eraser tool is active, so
    // the only thing we need to guard against here is starting a shape on top of
    // a node.
    const onNode = !!targetEl.closest?.('.node')

    // ---- creation tools ----
    if (tool === 'rect' || tool === 'diamond' || tool === 'ellipse' || tool === 'arrow' || tool === 'line') {
      if (onNode) return
      const id = draw.addShape({
        type: tool as ShapeType,
        x: world.x,
        y: world.y,
        w: 0,
        h: 0
      })
      draw.selectShape(id)
      interaction.current = {
        mode: 'create',
        shapeId: id,
        handle: null,
        startWorld: world,
        origShape: null,
        origShapes: null
      }
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      e.preventDefault()
      return
    }

    if (tool === 'pen') {
      if (onNode) return
      const id = draw.addShape({
        type: 'pen',
        x: world.x,
        y: world.y,
        w: 0,
        h: 0,
        points: [world.x, world.y]
      })
      draw.selectShape(id)
      interaction.current = {
        mode: 'pen',
        shapeId: id,
        handle: null,
        startWorld: world,
        origShape: null,
        origShapes: null
      }
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      e.preventDefault()
      return
    }

    if (tool === 'text') {
      if (onNode) return
      const id = draw.addShape({
        type: 'text',
        x: world.x,
        y: world.y,
        w: 0,
        h: 0,
        text: ''
      })
      draw.selectShape(id)
      setEditingTextId(id)
      draw.setTool('select')
      e.preventDefault()
      return
    }

    if (tool === 'eraser') {
      const id = hitShapeId ?? hitTest(world.x, world.y, draw.shapes, zoom)
      if (id) draw.removeShape(id)
      interaction.current = {
        mode: 'create', // reuse for eraser-drag erasing
        shapeId: null,
        handle: 'eraser',
        startWorld: world,
        origShape: null,
        origShapes: null
      }
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      e.preventDefault()
      return
    }

    // ---- select tool ----
    if (tool === 'select') {
      // resize handle?
      if (hitHandle && hitShapeId) {
        const shape = draw.shapes.find((s) => s.id === hitShapeId)
        if (shape) {
          draw.selectShape(hitShapeId)
          interaction.current = {
            mode: 'resize',
            shapeId: hitShapeId,
            handle: hitHandle,
            startWorld: world,
            origShape: { ...shape },
            origShapes: null
          }
          ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
          e.preventDefault()
        }
        return
      }
      // shape body?
      const id = hitShapeId ?? hitTest(world.x, world.y, draw.shapes, zoom)
      if (id) {
        // shift-click toggles a shape's whole group in/out of the selection
        // without starting a move.
        if (e.shiftKey) {
          draw.toggleInSelection(id)
          e.preventDefault()
          return
        }
        // plain click: if the shape isn't already part of the selection, select
        // it (auto-expanding to its group). If it IS already selected, keep the
        // multi-selection so the whole set can be dragged together.
        if (!draw.selectedShapeIds.includes(id)) {
          draw.selectShape(id)
        }
        // snapshot ALL currently-selected shapes (read fresh AFTER selecting so
        // a freshly-expanded group is captured) for move-together.
        const sel = new Set(useDrawing.getState().selectedShapeIds)
        const origShapes = draw.shapes.filter((s) => sel.has(s.id)).map((s) => ({ ...s }))
        const shape = draw.shapes.find((s) => s.id === id)
        if (shape) {
          interaction.current = {
            mode: 'move',
            shapeId: id,
            handle: null,
            startWorld: world,
            origShape: { ...shape },
            origShapes
          }
          ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
          e.preventDefault()
        }
        return
      }
      // empty space -> clear selection + pan
      if (onBackground) {
        draw.clearSelection()
        select(null)
        startPan(e)
      }
    }
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    // Loupe — while dragging a marquee-zoom box, just update the screen-space
    // rubber-band rect (preview only; the camera is untouched until pointerUp,
    // matching the marquee idiom). Normalized so dragging in any direction works.
    if (loupeDrag.current) {
      const s = loupeDrag.current.startClient
      setLoupeBox({
        x: Math.min(s.x, e.clientX),
        y: Math.min(s.y, e.clientY),
        w: Math.abs(e.clientX - s.x),
        h: Math.abs(e.clientY - s.y)
      })
      return
    }
    const it = interaction.current
    const draw = useDrawing.getState()

    if (panning.current) {
      panBy(e.clientX - panning.current.x, e.clientY - panning.current.y)
      panning.current = { x: e.clientX, y: e.clientY }
      return
    }
    if (!it) return
    const world = toWorld(e.clientX, e.clientY)

    if (it.mode === 'create') {
      if (it.handle === 'eraser') {
        const zoom = useCanvas.getState().camera.zoom
        const id = hitTest(world.x, world.y, draw.shapes, zoom)
        if (id) draw.removeShape(id)
        return
      }
      if (!it.shapeId) return
      draw.updateShape(it.shapeId, {
        w: world.x - it.startWorld.x,
        h: world.y - it.startWorld.y
      })
      return
    }

    if (it.mode === 'pen' && it.shapeId) {
      const shape = draw.shapes.find((s) => s.id === it.shapeId)
      if (!shape) return
      const pts = [...(shape.points ?? []), world.x, world.y]
      draw.updateShape(it.shapeId, { points: pts })
      return
    }

    if (it.mode === 'move' && it.origShapes && it.origShapes.length > 0) {
      const dx = world.x - it.startWorld.x
      const dy = world.y - it.startWorld.y
      // Batch the whole multi-selection / group translation into ONE store update
      // per frame: build an id->orig lookup and apply every patch inside a single
      // map() + single setState (one render), instead of one updateShape() per
      // shape (each a full map() + set() + render). A move only translates x/y/
      // points and never touches text/fontSize, so the store's content-derived
      // text w/h invariant is unaffected — no re-sync needed here. The final
      // positions are committed through updateShape() at pointerUp so the
      // (debounced) persist() still runs exactly as before.
      const origById = new Map(it.origShapes.map((o) => [o.id, o]))
      useDrawing.setState((s) => ({
        shapes: s.shapes.map((sh) => {
          const orig = origById.get(sh.id)
          if (!orig) return sh
          const next: Shape = { ...sh, x: orig.x + dx, y: orig.y + dy }
          if (orig.points) {
            next.points = orig.points.map((v, i) => (i % 2 === 0 ? v + dx : v + dy))
          }
          return next
        })
      }))
      return
    }

    if (it.mode === 'resize' && it.shapeId && it.origShape && it.handle) {
      resizeShape(draw, it.shapeId, it.origShape, it.handle, world)
      return
    }
  }

  const onPointerUp = (e: React.PointerEvent): void => {
    // Loupe — commit the marquee zoom. Convert both client corners to world coords
    // and frame that region via the store (which reuses cameraForBounds + records
    // the jump into Slipstream/Wayback). A sub-threshold drag (a stray Z-click) is
    // a no-op so the camera never lurches. Clear the gesture either way.
    if (loupeDrag.current) {
      const start = loupeDrag.current.startClient
      loupeDrag.current = null
      setLoupeBox(null)
      const THRESH = 12 // px on a side — ignore accidental clicks
      if (Math.abs(e.clientX - start.x) > THRESH && Math.abs(e.clientY - start.y) > THRESH) {
        const a = toWorld(start.x, start.y)
        const b = toWorld(e.clientX, e.clientY)
        useCanvas.getState().frameRegion({
          minX: Math.min(a.x, b.x),
          minY: Math.min(a.y, b.y),
          maxX: Math.max(a.x, b.x),
          maxY: Math.max(a.y, b.y)
        })
      }
      try {
        ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
      return
    }
    const it = interaction.current
    const draw = useDrawing.getState()

    // A move drag updates the store via setState() (batched, no persist) on every
    // frame; commit the final positions through updateShape() once per shape at
    // gesture end so the (debounced) persist() fires with the settled geometry.
    if (it && it.mode === 'move' && it.origShapes && it.origShapes.length > 0) {
      for (const orig of it.origShapes) {
        const cur = draw.shapes.find((s) => s.id === orig.id)
        if (cur) draw.updateShape(orig.id, { x: cur.x, y: cur.y, points: cur.points })
      }
    }

    if (it && it.shapeId && (it.mode === 'create' || it.mode === 'pen')) {
      const shape = draw.shapes.find((s) => s.id === it.shapeId)
      if (shape) {
        if (shape.type === 'pen') {
          // compute bbox of points; drop if too few points
          if (!shape.points || shape.points.length < 4) {
            draw.removeShape(shape.id)
          } else {
            const bb = penBBox(shape.points)
            draw.updateShape(shape.id, bb)
          }
        } else if (shape.type === 'line' || shape.type === 'arrow') {
          if (Math.abs(shape.w) < 2 && Math.abs(shape.h) < 2) {
            draw.removeShape(shape.id)
          }
        } else {
          // box shapes: normalize negative size, drop zero-size
          const nx = shape.w < 0 ? shape.x + shape.w : shape.x
          const ny = shape.h < 0 ? shape.y + shape.h : shape.y
          const nw = Math.abs(shape.w)
          const nh = Math.abs(shape.h)
          if (nw < 2 && nh < 2) {
            draw.removeShape(shape.id)
          } else {
            draw.updateShape(shape.id, { x: nx, y: ny, w: nw, h: nh })
          }
        }
      }
    }

    panning.current = null
    interaction.current = null
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }

  const onDoubleClick = (e: React.PointerEvent): void => {
    // Never treat a double-click that lands on a floating panel / in-place editor
    // as a canvas double-click — otherwise a rapid second click on a panel control
    // (e.g. the font − / + stepper) hit-tests the shape behind the panel and drops
    // it into text-edit, which reads as an accidental deselect.
    const targetEl = e.target as HTMLElement | null
    if (targetEl?.closest?.('[data-canvasio-panel-root],[data-canvasio-text-editor]')) return
    const draw = useDrawing.getState()
    const world = toWorld(e.clientX, e.clientY)
    const zoom = useCanvas.getState().camera.zoom
    const id = hitTest(world.x, world.y, draw.shapes, zoom)
    if (!id) return
    const shape = draw.shapes.find((s) => s.id === id)
    // Double-click to type a label into any closed "box" shape (rect, diamond,
    // ellipse) as well as the dedicated text shape. Open shapes (line/arrow/pen)
    // have no body to hold a label, so they don't enter text-edit.
    if (
      shape?.type === 'text' ||
      shape?.type === 'rect' ||
      shape?.type === 'diamond' ||
      shape?.type === 'ellipse'
    ) {
      // Works even while a drawing tool is active: double-clicking an existing box
      // drops you straight into typing, so switch back to the SELECT (arrow) tool
      // first — otherwise the next click would draw a new shape instead of editing.
      // (Any zero-size draft from the double-click's first click is discarded by
      // the <2px guard in onPointerUp.)
      if (draw.activeTool !== 'select') draw.setTool('select')
      draw.selectShape(id)
      setEditingTextId(id)
    }
  }

  return (
    <div
      ref={viewportRef}
      className={
        'canvas-viewport' + (panning.current ? ' panning' : '') + (zHeld ? ' loupe-armed' : '')
      }
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={onDoubleClick as unknown as React.MouseEventHandler}
      style={{ zIndex: 1 }}
    >
      <CanvasWorld>
        {/* Relay Conduits — the handoff graph, painted FURTHEST back (first child),
            behind Districts/drawings/nodes. Its <svg> is pointer-events:none and it
            renders null when conduits are off or there are zero relay rules, so it
            never intercepts clicks and costs nothing until used. Inherits the
            world's translate+scale for free (zero new coordinate math). */}
        <ConduitsLayer />
        {/* RegionsLayer (Districts) is the FIRST child => painted behind drawings
            AND nodes. Its bodies are pointer-events:none (only the title chip is
            interactive), so node/terminal clicks always win. */}
        <RegionsLayer />
        {/* DrawingLayer is next => behind nodes; node interaction wins */}
        <DrawingLayer editingTextId={editingTextId} />
        {nodes.map((n) => (
          <NodeView key={n.id} node={n} />
        ))}
      </CanvasWorld>
      {/* REAL frosted glass — a blurred copy of the wallpaper, masked to reveal
          only under terminal/bar rects. MUST live here, INSIDE .canvas-viewport
          (a z-index:1 stacking context), at z-29 so it sits ABOVE the in-world
          nodes (canvas-world, auto z) but BELOW the terminal overlays (z-30).
          Mounting it at the App root instead made root z-29 > viewport z-1, so it
          painted OVER the terminals and hid the glyphs. */}
      <BackdropFrost />
      {/* screen-space terminal canvases — OUTSIDE the transformed world so the
          xterm <canvas> composites 1:1 with the device pixel grid and stays
          crisp at any zoom. Sits above the world (z 30), below DrawingOverlays
          (text editor / properties at z 45) and the app chrome. */}
      <TerminalOverlays />
      {/* screen-space resize handles (z 31) — above the terminal overlay so a
          terminal's z-30 box no longer intercepts side/bottom/corner resizes;
          below DrawingOverlays (z 45). Replaces NodeView's in-world handles. */}
      <ResizeOverlays />
      {/* Loupe — transient screen-space rubber-band while Z-dragging a region to
          zoom into. Renders nothing when inactive (zero chrome / zero cost), the
          same idiom as Atlas/Watchtower. */}
      {loupeBox && (
        <div
          className="loupe-box glass"
          style={{
            position: 'absolute',
            left: loupeBox.x,
            top: loupeBox.y,
            width: loupeBox.w,
            height: loupeBox.h,
            pointerEvents: 'none',
            zIndex: 46
          }}
        />
      )}
      {/* screen-space overlays — OUTSIDE the transformed world */}
      <DrawingOverlays editingTextId={editingTextId} onCommitText={commitText} />
    </div>
  )
}

function penBBox(points: number[]): { x: number; y: number; w: number; h: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < points.length - 1; i += 2) {
    minX = Math.min(minX, points[i])
    maxX = Math.max(maxX, points[i])
    minY = Math.min(minY, points[i + 1])
    maxY = Math.max(maxY, points[i + 1])
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

function resizeShape(
  draw: ReturnType<typeof useDrawing.getState>,
  id: string,
  orig: Shape,
  handle: string,
  world: { x: number; y: number }
): void {
  // line/arrow endpoint handles
  if (orig.type === 'line' || orig.type === 'arrow') {
    if (handle === 'p0') {
      const x2 = orig.x + orig.w
      const y2 = orig.y + orig.h
      draw.updateShape(id, { x: world.x, y: world.y, w: x2 - world.x, h: y2 - world.y })
    } else if (handle === 'p1') {
      draw.updateShape(id, { w: world.x - orig.x, h: world.y - orig.y })
    }
    return
  }

  const bb = shapeBBox(orig)
  let left = bb.x
  let top = bb.y
  let right = bb.x + bb.w
  let bottom = bb.y + bb.h

  if (handle.includes('w')) left = world.x
  if (handle.includes('e')) right = world.x
  if (handle.includes('n')) top = world.y
  if (handle.includes('s')) bottom = world.y

  let nx = Math.min(left, right)
  let ny = Math.min(top, bottom)
  let nw = Math.abs(right - left)
  let nh = Math.abs(bottom - top)

  if (orig.type === 'pen' && orig.points) {
    // scale points relative to the original bbox into the new bbox
    const ow = bb.w || 1
    const oh = bb.h || 1
    const newPoints = orig.points.map((v, i) => {
      if (i % 2 === 0) return nx + ((v - bb.x) / ow) * nw
      return ny + ((v - bb.y) / oh) * nh
    })
    draw.updateShape(id, { x: nx, y: ny, w: nw, h: nh, points: newPoints })
    return
  }

  if (orig.type === 'text') {
    // text scales font size with vertical resize, keeps position anchor
    const scale = nh / (bb.h || 1)
    const fs = Math.max(8, Math.round((orig.fontSize ?? DEFAULT_FONT_SIZE) * scale))
    draw.updateShape(id, { x: nx, y: ny, fontSize: fs })
    return
  }

  draw.updateShape(id, { x: nx, y: ny, w: nw, h: nh })
}
