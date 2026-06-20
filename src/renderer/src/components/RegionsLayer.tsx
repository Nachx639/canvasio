import { memo, useRef, useState } from 'react'
import { useCanvas } from '../store/canvas'
import { useRegions, type Region } from '../store/regions'
import { nodesInRegion } from '../lib/territory'
import { useT } from '../store/i18n'

/**
 * Districts — Spatial Regions layer. Renders inside `.canvas-world` as the FIRST
 * child (before <DrawingLayer/> and the nodes), so regions paint BEHIND drawings
 * and nodes in the SAME translate+scale transform already on canvas-world — zero
 * new coordinate math (world px == node px here).
 *
 * Pointer discipline (mirrors DrawingLayer-as-first-child): the region BODY is
 * pointer-events:none so it NEVER intercepts node/terminal clicks. Only the title
 * CHIP is interactive: dbl-click renames, drag-to-move translates the District
 * AND every node it contains (Sections-style containment move) by the same delta.
 * A region create/move is wrapped in snapshotForGesture so it joins the existing
 * undo/redo stack.
 */
export function RegionsLayer(): JSX.Element | null {
  const regions = useRegions((s) => s.regions)
  if (!regions.length) return null
  return (
    <>
      {regions.map((r) => (
        <RegionView key={r.id} region={r} />
      ))}
    </>
  )
}

const RegionView = memo(function RegionView({ region }: { region: Region }): JSX.Element {
  const t = useT()
  const renameRegion = useRegions((s) => s.renameRegion)
  const removeRegion = useRegions((s) => s.removeRegion)
  const [editing, setEditing] = useState(false)

  // Drag state: captured node ids + their starting positions are snapshotted
  // up-front at pointer-down so the containment move is byte-stable for the whole
  // gesture (a node that drifts out mid-drag is still carried, matching Figma).
  const drag = useRef<{
    px: number
    py: number
    rx: number
    ry: number
    nodes: { id: string; x: number; y: number }[]
  } | null>(null)

  const onChipPointerDown = (e: React.PointerEvent): void => {
    if (editing) return
    e.stopPropagation()
    // Layout Time Machine — snapshot ONCE at the gesture start (the contained
    // nodes are about to move), so the whole containment drag is a single undo
    // step (mirrors NodeView's onHeaderPointerDown).
    useCanvas.getState().snapshotForGesture('move')
    useCanvas.getState().setAutoFit(false)
    const allNodes = useCanvas.getState().nodes
    const inside = nodesInRegion(region, allNodes).map((n) => ({ id: n.id, x: n.x, y: n.y }))
    drag.current = { px: e.clientX, py: e.clientY, rx: region.x, ry: region.y, nodes: inside }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }

  const onChipPointerMove = (e: React.PointerEvent): void => {
    const d = drag.current
    if (!d) return
    const zoom = useCanvas.getState().camera.zoom
    const dx = (e.clientX - d.px) / zoom
    const dy = (e.clientY - d.py) / zoom
    // Move the region rectangle (absolute, from its captured origin)…
    useRegions.getState().moveRegion(region.id, d.rx + dx - region.x, d.ry + dy - region.y)
    // …and translate every captured contained node by the same delta in ONE
    // batched store write. Each contained node's target position is its captured
    // origin + the gesture delta (byte-identical to the previous per-node
    // updateNode({ x: n.x + dx, y: n.y + dy }) loop), but folded into a single
    // `set` with a single nodes.map + a single subscriber notification per frame,
    // instead of K maps + K notification waves (avoids the O(K·N) drag hot path).
    const targets = new Map(d.nodes.map((n) => [n.id, { x: n.x + dx, y: n.y + dy }]))
    useCanvas.setState((s) => ({
      nodes: s.nodes.map((n) => {
        const t = targets.get(n.id)
        return t ? { ...n, x: t.x, y: t.y } : n
      })
    }))
  }

  const onChipPointerUp = (e: React.PointerEvent): void => {
    drag.current = null
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }

  const commitName = (value: string): void => {
    setEditing(false)
    const next = value.trim()
    if (next) renameRegion(region.id, next)
  }

  // A translucent fill from the District color (hex -> rgba at low alpha) so the
  // region reads as a soft territory tint behind everything.
  const fill = hexToRgba(region.color, 0.1)
  const border = hexToRgba(region.color, 0.4)

  return (
    <div
      className="district"
      style={{
        position: 'absolute',
        left: region.x,
        top: region.y,
        width: region.w,
        height: region.h,
        background: fill,
        border: `1.5px solid ${border}`,
        borderRadius: 14,
        // The BODY never intercepts pointer events — node/terminal clicks win.
        pointerEvents: 'none',
        // Behind nodes within the world (nodes carry their own z >= 1); the layer
        // renders first so it's already underneath, but pin it explicitly.
        zIndex: 0
      }}
    >
      {/* Title chip — the ONLY pointer-interactive part. */}
      {editing ? (
        <input
          autoFocus
          defaultValue={region.name}
          className="district-chip-input"
          onPointerDown={(e) => e.stopPropagation()}
          onBlur={(e) => commitName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitName((e.target as HTMLInputElement).value)
            else if (e.key === 'Escape') setEditing(false)
          }}
          style={{
            position: 'absolute',
            top: 8,
            left: 8,
            pointerEvents: 'all',
            background: hexToRgba(region.color, 0.9),
            color: '#0b1020',
            border: 'none',
            outline: 'none',
            borderRadius: 8,
            padding: '4px 8px',
            fontSize: 12,
            fontWeight: 600,
            maxWidth: Math.max(80, region.w - 16)
          }}
        />
      ) : (
        <div
          className="district-chip no-drag"
          title={t('regionsLayer.chip_title')}
          onPointerDown={onChipPointerDown}
          onPointerMove={onChipPointerMove}
          onPointerUp={onChipPointerUp}
          onDoubleClick={(e) => {
            e.stopPropagation()
            setEditing(true)
          }}
          style={{
            position: 'absolute',
            top: 8,
            left: 8,
            pointerEvents: 'all',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            background: hexToRgba(region.color, 0.9),
            color: '#0b1020',
            borderRadius: 8,
            padding: '4px 8px',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'grab',
            userSelect: 'none',
            maxWidth: Math.max(80, region.w - 16),
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
        >
          <span aria-hidden>▦</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{region.name}</span>
          <button
            type="button"
            className="district-chip-x"
            title={t('regionsLayer.delete_title')}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              removeRegion(region.id)
            }}
            style={{
              pointerEvents: 'all',
              background: 'transparent',
              border: 'none',
              color: '#0b1020',
              cursor: 'pointer',
              fontSize: 13,
              lineHeight: 1,
              padding: '0 0 0 2px',
              opacity: 0.7
            }}
          >
            ×
          </button>
        </div>
      )}
    </div>
  )
})

/** Convert a #rrggbb (or #rgb) hex to an rgba() string at the given alpha. Falls
 *  back to a neutral blue tint on a malformed input so a District always paints. */
function hexToRgba(hex: string, alpha: number): string {
  let h = hex.replace('#', '').trim()
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const n = parseInt(h, 16)
  if (h.length !== 6 || Number.isNaN(n)) return `rgba(122,162,255,${alpha})`
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return `rgba(${r},${g},${b},${alpha})`
}
