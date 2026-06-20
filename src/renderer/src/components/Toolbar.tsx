import { useRef, useState } from 'react'
import { useCanvas, AgentKind } from '../store/canvas'
import { useDrawing, DrawTool } from '../store/drawing'
import { activeCanvasCwd } from '../store/workspace'
import { createMarkdownNote, openProjectFolder, openOrFocusCalendar } from '../lib/fileNodes'
import { useFrostRect } from '../hooks/useFrostRect'
import { useT } from '../store/i18n'

type Tool = DrawTool

export function Toolbar(): JSX.Element {
  const t = useT()
  const tool = useDrawing((s) => s.activeTool)
  const setTool = useDrawing((s) => s.setTool)
  const [agentMenu, setAgentMenu] = useState(false)
  const [menuPos, setMenuPos] = useState<{ x: number; y: number }>({ x: 70, y: 300 })

  // Reveal the z-29 BackdropFrost under the left rail + agent menu glass.
  const railRef = useRef<HTMLDivElement>(null)
  const agentMenuRef = useRef<HTMLDivElement>(null)
  useFrostRect(railRef, { radius: 14 })
  useFrostRect(agentMenuRef, { radius: 12, active: agentMenu })
  const addNode = useCanvas((s) => s.addNode)
  const camera = useCanvas((s) => s.camera)

  // place a new node near the centre of the current viewport
  const center = (): { x: number; y: number } => ({
    x: (window.innerWidth / 2 - camera.x) / camera.zoom - 270,
    y: (window.innerHeight / 2 - camera.y) / camera.zoom - 180
  })

  const spawnAgent = (agent: AgentKind): void => {
    const c = center()
    // Spawn the terminal in the active canvas's working folder when one is set
    // (node.cwd flows to pty:spawn); falls back to home when undefined.
    addNode({ kind: 'terminal', agent, x: c.x, y: c.y, cwd: activeCanvasCwd() })
    setAgentMenu(false)
  }

  const tools: { id: Tool; icon: JSX.Element; title: string }[] = [
    { id: 'select', icon: <CursorIcon />, title: t('toolbar.tool_select') },
    { id: 'hand', icon: <HandIcon />, title: t('toolbar.tool_hand') },
    { id: 'rect', icon: <SquareIcon />, title: t('toolbar.tool_rect') },
    { id: 'diamond', icon: <DiamondIcon />, title: t('toolbar.tool_diamond') },
    { id: 'ellipse', icon: <CircleIcon />, title: t('toolbar.tool_ellipse') },
    { id: 'arrow', icon: <ArrowIcon />, title: t('toolbar.tool_arrow') },
    { id: 'line', icon: <LineIcon />, title: t('toolbar.tool_line') },
    { id: 'pen', icon: <PenIcon />, title: t('toolbar.tool_pen') },
    { id: 'text', icon: <TextIcon />, title: t('toolbar.tool_text') },
    { id: 'eraser', icon: <EraserIcon />, title: t('toolbar.tool_eraser') }
  ]

  const toggleAgentMenu = (e: React.MouseEvent<HTMLButtonElement>): void => {
    if (agentMenu) {
      setAgentMenu(false)
      return
    }
    const r = e.currentTarget.getBoundingClientRect()
    setMenuPos({ x: r.right + 10, y: r.top - 60 })
    setAgentMenu(true)
  }

  return (
    <>
      <div
        ref={railRef}
        className="glass glass-rail"
        style={{
          position: 'absolute',
          left: 14,
          top: '50%',
          transform: 'translateY(-50%)',
          zIndex: 40,
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
          padding: 6,
          borderRadius: 14
        }}
      >
        {tools.map((t) => (
          <button
            key={t.id}
            title={t.title}
            aria-label={t.title}
            aria-pressed={tool === t.id}
            onClick={() => setTool(t.id)}
            style={toolBtn(tool === t.id)}
          >
            {t.icon}
          </button>
        ))}
        <div style={{ height: 1, background: 'rgba(var(--glass-spec),0.08)', margin: '4px 4px' }} />
        <button
          title={t('toolbar.new_agent')}
          aria-label={t('toolbar.new_agent')}
          aria-expanded={agentMenu}
          aria-haspopup="menu"
          onClick={toggleAgentMenu}
          style={toolBtn(agentMenu)}
        >
          <TerminalIcon />
        </button>
        <button
          title={t('toolbar.web_preview')}
          aria-label={t('toolbar.web_preview_new')}
          onClick={() => {
            const c = center()
            addNode({ kind: 'web', x: c.x, y: c.y })
          }}
          style={toolBtn(false)}
        >
          <GlobeIcon />
        </button>
        <button
          title={t('toolbar.radio_player')}
          aria-label={t('toolbar.radio_player_new')}
          onClick={() => {
            const c = center()
            addNode({ kind: 'music', x: c.x, y: c.y })
          }}
          style={toolBtn(false)}
        >
          <MusicIcon />
        </button>
        <div style={{ height: 1, background: 'rgba(var(--glass-spec),0.08)', margin: '4px 4px' }} />
        <button
          title={t('toolbar.markdown_note_title')}
          aria-label={t('toolbar.markdown_note')}
          onClick={() => {
            const c = center()
            void createMarkdownNote(c)
          }}
          style={toolBtn(false)}
        >
          <MarkdownIcon />
        </button>
        <button
          title={t('toolbar.open_project_folder')}
          aria-label={t('toolbar.open_project_folder')}
          onClick={() => {
            const c = center()
            openProjectFolder(c)
          }}
          style={toolBtn(false)}
        >
          <FolderIcon />
        </button>
        <button
          title={t('toolbar.calendar_title')}
          aria-label={t('toolbar.calendar')}
          onClick={() => {
            const c = center()
            openOrFocusCalendar(c)
          }}
          style={toolBtn(false)}
        >
          <CalendarIcon />
        </button>
      </div>

      {/* agent menu — rendered OUTSIDE the toolbar (fixed to viewport) so the
          toolbar's backdrop-filter/overflow can't clip it */}
      {agentMenu && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 59 }} onClick={() => setAgentMenu(false)} />
          <div
            ref={agentMenuRef}
            className="glass"
            style={{
              position: 'fixed',
              left: menuPos.x,
              top: menuPos.y,
              zIndex: 60,
              borderRadius: 12,
              padding: 6,
              minWidth: 178,
              display: 'flex',
              flexDirection: 'column',
              gap: 2
            }}
          >
            <AgentRow color="#d97757" label="Claude Code" onClick={() => spawnAgent('claude')} />
            <AgentRow color="#10a37f" label="Codex" onClick={() => spawnAgent('codex')} />
            <AgentRow color="#7aa2ff" label="Cursor Agent" onClick={() => spawnAgent('cursor')} />
            <AgentRow color="#9aa7c7" label="Shell (zsh)" onClick={() => spawnAgent('shell')} />
          </div>
        </>
      )}
    </>
  )
}

function AgentRow({ color, label, onClick }: { color: string; label: string; onClick: () => void }): JSX.Element {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        background: 'transparent',
        border: 'none',
        color: '#d6e0f7',
        padding: '7px 9px',
        borderRadius: 7,
        fontSize: 12.5,
        textAlign: 'left'
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(120,160,255,0.14)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <span style={{ width: 8, height: 8, borderRadius: 2, background: color, boxShadow: `0 0 8px ${color}` }} />
      {label}
    </button>
  )
}

function toolBtn(active: boolean): React.CSSProperties {
  return {
    width: 34,
    height: 34,
    display: 'grid',
    placeItems: 'center',
    borderRadius: 9,
    border: 'none',
    background: active ? 'rgba(91,140,255,0.22)' : 'transparent',
    color: active ? '#cfe0ff' : '#9fb0d2'
  }
}

/* --- icons --- */
const S = { width: 17, height: 17, viewBox: '0 0 18 18', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 } as const
const CursorIcon = (): JSX.Element => (<svg {...S}><path d="M3 2l5 12 2-5 5-2z" /></svg>)
const HandIcon = (): JSX.Element => (<svg {...S}><path d="M6 8V4a1 1 0 012 0v3m0 0V3a1 1 0 012 0v4m0 0V4a1 1 0 012 0v6c0 3-2 5-5 5s-5-2-5-4l1-2" /></svg>)
const SquareIcon = (): JSX.Element => (<svg {...S}><rect x="3" y="3" width="12" height="12" rx="2" /></svg>)
const DiamondIcon = (): JSX.Element => (<svg {...S}><path d="M9 2l7 7-7 7-7-7z" /></svg>)
const CircleIcon = (): JSX.Element => (<svg {...S}><circle cx="9" cy="9" r="6.5" /></svg>)
const ArrowIcon = (): JSX.Element => (<svg {...S}><path d="M3 15L15 3M15 3H8M15 3v7" /></svg>)
const LineIcon = (): JSX.Element => (<svg {...S}><path d="M3 15L15 3" /></svg>)
const PenIcon = (): JSX.Element => (<svg {...S}><path d="M3 15l2-1 8-8-1-1-8 8z M11 5l2 2" /></svg>)
const TextIcon = (): JSX.Element => (<svg {...S}><path d="M4 4h10M9 4v11" /></svg>)
const EraserIcon = (): JSX.Element => (<svg {...S}><path d="M7 14l-3-3 7-7 4 4-6 6z M4 14h8" /></svg>)
const TerminalIcon = (): JSX.Element => (<svg {...S}><rect x="2" y="3" width="14" height="12" rx="2" /><path d="M5 7l2.5 2L5 11M9.5 11H12" /></svg>)
const GlobeIcon = (): JSX.Element => (<svg {...S}><circle cx="9" cy="9" r="6.5" /><path d="M2.5 9h13M9 2.5c2 2 2 11 0 13M9 2.5c-2 2-2 11 0 13" /></svg>)
const MusicIcon = (): JSX.Element => (<svg {...S}><path d="M6 13V4l8-2v9" /><circle cx="4.5" cy="13" r="1.6" /><circle cx="12.5" cy="11" r="1.6" /></svg>)
const MarkdownIcon = (): JSX.Element => (<svg {...S}><rect x="3" y="2.5" width="12" height="13" rx="2" /><path d="M5.5 11V7l1.8 2 1.8-2v4M12 7v3.5M12 10.5l-1.2-1.4M12 10.5l1.2-1.4" /></svg>)
const FolderIcon = (): JSX.Element => (<svg {...S}><path d="M2.5 5.5a1 1 0 011-1h3l1.5 1.5h5a1 1 0 011 1v6a1 1 0 01-1 1h-10a1 1 0 01-1-1z" /></svg>)
const CalendarIcon = (): JSX.Element => (<svg {...S}><rect x="2.5" y="3.5" width="13" height="12" rx="2" /><path d="M2.5 7h13M6 2.5v2M12 2.5v2" /></svg>)
