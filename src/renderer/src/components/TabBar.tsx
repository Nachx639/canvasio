import { useMemo, useState, useRef, useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useWorkspace } from '../store/workspace'
import { useT } from '../store/i18n'
import { OpenPicker } from './OpenPicker'
import appIcon from '../assets/app-icon.png'

/**
 * Multi-canvas list — a vertical glass box docked on the LEFT edge, below the
 * macOS traffic lights and above the tool palette (Toolbar lives at left:14,
 * top:50%). One row per open canvas (name, double-click to rename inline, active
 * highlight, close ×), a scrollable list when there are many, a "+" to create a
 * new named canvas, and the "Abrir lienzo" picker for canvases not open as tabs.
 *
 * REACT #185 SAFETY: openTabs + canvases are arrays, selected with useShallow (a
 * raw array selector returning a new ref each render would crash the renderer with
 * "Maximum update depth exceeded"). activeId is a primitive, selected directly.
 *
 * macOS DRAG REGION: the whole box is className "no-drag" so the OS window-drag
 * region (TopBar .drag-region) does not swallow clicks on the tabs/×/rename.
 */
export function TabBar(): JSX.Element | null {
  const t = useT()
  const openTabs = useWorkspace(useShallow((s) => s.openTabs))
  const canvases = useWorkspace(useShallow((s) => s.canvases))
  const activeId = useWorkspace((s) => s.activeId)
  // Collapsed state persists across restarts (canvasio:tabbar.collapsed).
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem('canvasio:tabbar.collapsed') === '1'
  )

  // id -> name map for rendering the open tabs (memoized over the stable array).
  const nameById = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of canvases) m.set(c.id, c.name)
    return m
  }, [canvases])

  const setColl = (v: boolean): void => {
    setCollapsed(v)
    try {
      localStorage.setItem('canvasio:tabbar.collapsed', v ? '1' : '0')
    } catch {
      /* ignore */
    }
  }

  if (collapsed) return <CollapsedOrb onExpand={() => setColl(false)} />

  // Anchor the expanded panel WHERE THE ORB IS (its persisted drag position),
  // not at the fixed top-left — so clicking the orb opens the list in place.
  // Clamp so the box stays fully on-screen. Falls back to the default corner.
  const dyn = ((): React.CSSProperties => {
    try {
      const raw = localStorage.getItem('canvasio:tabbar.orbpos')
      if (!raw) return boxStyle
      const p = JSON.parse(raw)
      if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) return boxStyle
      return {
        ...boxStyle,
        left: Math.max(8, Math.min(window.innerWidth - 230, p.x)),
        top: Math.max(8, Math.min(window.innerHeight - 270, p.y))
      }
    } catch {
      return boxStyle
    }
  })()

  return (
    <div className="glass no-drag" style={dyn}>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          title={t('tabBar.collapse_to_icon')}
          aria-label={t('tabBar.collapse_bar')}
          onClick={() => setColl(true)}
          style={collapseBtnStyle}
        >
          ⌄
        </button>
      </div>
      {openTabs.length > 0 && (
        <div style={listStyle}>
          {openTabs.map((id) => (
            <Tab key={id} id={id} name={nameById.get(id) ?? id} active={id === activeId} />
          ))}
        </div>
      )}
      <FolderControl />
      <div style={footerStyle}>
        <NewButton />
        <OpenPicker canvases={canvases} />
      </div>
    </div>
  )
}

/**
 * Collapsed TabBar — a small draggable orb (the app glyph) that keeps the canvas
 * tab bar out of the way. Click to expand; drag to reposition. Its position is
 * persisted (canvasio:tabbar.orbpos). A plain click (no drag) expands; a drag never
 * commits as a click.
 */
function CollapsedOrb({ onExpand }: { onExpand: () => void }): JSX.Element {
  const t = useT()
  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    try {
      const raw = localStorage.getItem('canvasio:tabbar.orbpos')
      if (raw) {
        const p = JSON.parse(raw)
        if (Number.isFinite(p?.x) && Number.isFinite(p?.y)) return { x: p.x, y: p.y }
      }
    } catch {
      /* ignore */
    }
    return { x: 14, y: 46 }
  })
  const drag = useRef<{ px: number; py: number; ox: number; oy: number; moved: boolean } | null>(
    null
  )

  return (
    <button
      className="no-drag"
      title={t('tabBar.orb_tooltip')}
      aria-label={t('tabBar.open_bar')}
      onPointerDown={(e) => {
        drag.current = { px: e.clientX, py: e.clientY, ox: pos.x, oy: pos.y, moved: false }
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        const dx = e.clientX - d.px
        const dy = e.clientY - d.py
        if (!d.moved && Math.hypot(dx, dy) > 3) d.moved = true
        if (d.moved) {
          setPos({
            x: Math.max(4, Math.min(window.innerWidth - 44, d.ox + dx)),
            y: Math.max(4, Math.min(window.innerHeight - 44, d.oy + dy))
          })
        }
      }}
      onPointerUp={(e) => {
        const d = drag.current
        drag.current = null
        try {
          ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
        } catch {
          /* ignore */
        }
        if (d && d.moved) {
          try {
            localStorage.setItem('canvasio:tabbar.orbpos', JSON.stringify(pos))
          } catch {
            /* ignore */
          }
        } else {
          onExpand()
        }
      }}
      style={{
        position: 'fixed',
        left: pos.x,
        top: pos.y,
        zIndex: 60,
        width: 40,
        height: 40,
        borderRadius: '50%',
        border: '1px solid rgba(130,160,230,0.45)',
        background: '#0a0e1a',
        boxShadow: '0 0 16px rgba(110,160,255,0.55)',
        overflow: 'hidden',
        display: 'grid',
        placeItems: 'center',
        padding: 0,
        cursor: 'grab',
        touchAction: 'none',
        userSelect: 'none',
        pointerEvents: 'auto'
      }}
    >
      <img
        src={appIcon}
        alt=""
        draggable={false}
        style={{ width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none' }}
      />
    </button>
  )
}

const collapseBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--canvasio-subtext)',
  cursor: 'pointer',
  fontSize: 13,
  lineHeight: 1,
  padding: '0 4px',
  borderRadius: 6
}

/**
 * Working-folder control for the ACTIVE canvas. Shows the folder basename (full
 * path as tooltip) or "Sin carpeta" when unset; clicking opens the native folder
 * picker and persists the choice on the active canvas. Hidden when no canvas is
 * active.
 *
 * REACT #185 SAFETY: both selectors return PRIMITIVES (string|undefined / null),
 * so no useShallow is needed (a new ref every render would crash the renderer).
 */
function FolderControl(): JSX.Element | null {
  const t = useT()
  const activeId = useWorkspace((s) => s.activeId)
  const cwd = useWorkspace((s) => {
    const a = s.canvases.find((c) => c.id === s.activeId)
    return a?.cwd
  })

  if (!activeId) return null

  const basename = cwd ? cwd.split('/').filter(Boolean).pop() : undefined

  const choose = async (): Promise<void> => {
    const picked = await window.canvasio.chooseFolder()
    if (picked) await useWorkspace.getState().setActiveCwd(picked)
  }

  return (
    <button
      type="button"
      title={cwd ?? t('tabBar.no_folder')}
      aria-label={t('tabBar.canvas_folder')}
      onClick={() => void choose()}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        width: '100%',
        boxSizing: 'border-box',
        padding: '4px 8px',
        background: 'transparent',
        border: '1px solid rgba(140,165,225,0.25)',
        borderRadius: 7,
        color: '#aebbd6',
        cursor: 'pointer',
        fontSize: 12.5,
        lineHeight: 1.2,
        textAlign: 'left'
      }}
    >
      <span style={{ flex: '0 0 auto', opacity: 0.8 }} aria-hidden>
        📁
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontStyle: cwd ? 'normal' : 'italic',
          opacity: cwd ? 1 : 0.65
        }}
      >
        {basename ?? t('tabBar.no_folder')}
      </span>
    </button>
  )
}

function NewButton(): JSX.Element {
  const t = useT()
  return (
    <button
      type="button"
      title={t('tabBar.new_canvas')}
      aria-label={t('tabBar.new_canvas')}
      onClick={() => void useWorkspace.getState().newCanvas()}
      style={{
        width: 26,
        height: 26,
        flex: '0 0 auto',
        display: 'grid',
        placeItems: 'center',
        background: 'transparent',
        border: '1px solid rgba(140,165,225,0.25)',
        borderRadius: 7,
        color: '#aebbd6',
        cursor: 'pointer',
        fontSize: 16,
        lineHeight: 1
      }}
    >
      +
    </button>
  )
}

function Tab({ id, name, active }: { id: string; name: string; active: boolean }): JSX.Element {
  const t = useT()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Keep the draft in sync if the name changes externally while not editing.
  useEffect(() => {
    if (!editing) setDraft(name)
  }, [name, editing])

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  const commit = (): void => {
    setEditing(false)
    const next = draft.trim()
    if (next && next !== name) void useWorkspace.getState().renameCanvas(id, next)
    else setDraft(name)
  }

  return (
    <div
      onClick={() => {
        if (!active && !editing) void useWorkspace.getState().openCanvas(id)
      }}
      onDoubleClick={() => setEditing(true)}
      title={name}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        width: '100%',
        minWidth: 150,
        maxWidth: 240,
        boxSizing: 'border-box',
        padding: '4px 6px 4px 10px',
        borderRadius: 8,
        cursor: 'pointer',
        background: active ? 'rgba(120,160,255,0.22)' : 'rgba(255,255,255,0.04)',
        border: active ? '1px solid rgba(140,180,255,0.45)' : '1px solid transparent',
        color: active ? '#eaf1ff' : '#aebbd6',
        fontSize: 12.5
      }}
    >
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            else if (e.key === 'Escape') {
              setEditing(false)
              setDraft(name)
            }
          }}
          style={{
            flex: 1,
            minWidth: 0,
            background: 'rgba(0,0,0,0.3)',
            border: '1px solid rgba(140,165,225,0.4)',
            borderRadius: 5,
            color: '#eaf1ff',
            font: 'inherit',
            fontSize: 12.5,
            padding: '1px 5px',
            outline: 'none'
          }}
        />
      ) : (
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {name}
        </span>
      )}
      <button
        type="button"
        title={t('tabBar.close_canvas')}
        aria-label={t('tabBar.close_named', { name })}
        onClick={(e) => {
          e.stopPropagation()
          useWorkspace.getState().closeTab(id)
        }}
        style={{
          width: 16,
          height: 16,
          flex: '0 0 auto',
          display: 'grid',
          placeItems: 'center',
          background: 'transparent',
          border: 'none',
          borderRadius: 4,
          color: 'inherit',
          opacity: 0.6,
          cursor: 'pointer',
          fontSize: 13,
          lineHeight: 1
        }}
      >
        ×
      </button>
    </div>
  )
}

// Vertical glass box on the left edge, BELOW the macOS traffic lights (which sit
// at x:18,y:22 under titleBarStyle hiddenInset) and above the Toolbar (left:14,
// top:50%). Scrolls when there are many canvases.
const boxStyle: React.CSSProperties = {
  position: 'fixed',
  left: 14,
  top: 46,
  zIndex: 60,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: 6,
  borderRadius: 12,
  // Hard cap so the box never grows down into the Toolbar (left:14, top:50%)
  // when many canvases are open — the list scrolls internally instead.
  maxHeight: 'min(40vh, 250px)',
  pointerEvents: 'auto'
}

const listStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  overflowY: 'auto',
  // Bounded so the list scrolls (≈6 rows) instead of pushing the box into the
  // Toolbar below it; pairs with the box maxHeight cap.
  maxHeight: 'min(30vh, 190px)',
  // room for the scrollbar so it doesn't overlap the close ×
  paddingRight: 2
}

const footerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 6
}
