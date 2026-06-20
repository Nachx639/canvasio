import { useCallback, useEffect, useRef, useState } from 'react'
import { useCanvas } from '../store/canvas'
import { useDismiss } from '../lib/useDismiss'
import { ARRANGE_GRID_CHOICES, getArrangeGrid, setArrangeGrid } from '../lib/arrangeDensity'
import { CREW_RECIPES } from '../lib/crewRecipes'
import { SettingsPanel } from './SettingsPanel'
import { DoctorPanel, HealthIndicator, type HealthLevel } from './DoctorPanel'
import { MissionLog, MissionPulseChip } from './MissionLog'
import { TriageChip } from './TriageChip'
import { ConductorChip } from './ConductorChip'
import { CourseCorrectChip } from './CourseCorrectChip'
import { ConductorPanel } from './ConductorPanel'
import { HorizonChip } from './HorizonChip'
import { HorizonPanel } from './HorizonPanel'
import { QuestionsChip } from './QuestionsChip'
import { StagesChip } from './StagesChip'
import { BacklogTopChip } from './BacklogChip'
import { UpdateToast } from './UpdateToast'
import { getDoctorBridge } from '../lib/logger'
import { useDirector } from '../store/director'
import { useWorkspace } from '../store/workspace'
import { useFrostRect } from '../hooks/useFrostRect'
import { useT } from '../store/i18n'

export function TopBar(): JSX.Element {
  const t = useT()
  const [menuOpen, setMenuOpen] = useState(false)
  const [recipesOpen, setRecipesOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [volOpen, setVolOpen] = useState(false)
  // Arrange density popover (right-click on the organize button): pick a one-off
  // density, set the persisted default, or cascade. `defaultCols` mirrors the
  // arrangeDensity module's persisted value so the check-mark stays live without
  // a zustand selector (the value lives in a plain module, not the store).
  const [arrangeMenuOpen, setArrangeMenuOpen] = useState(false)
  const [defaultGrid, setDefaultGrid] = useState(() => getArrangeGrid())
  // Human label for a grid spec: 'auto' -> "Auto", '6x3' -> "6 × 3".
  const gridLabel = (g: string): string => (g === 'auto' ? t('topbar.arrange_auto') : g.replace('x', ' × '))
  const [doctorOpen, setDoctorOpen] = useState(false)
  const [missionOpen, setMissionOpen] = useState(false)
  const [conductorOpen, setConductorOpen] = useState(false)
  const [horizonOpen, setHorizonOpen] = useState(false)
  const [health, setHealth] = useState<HealthLevel>('ok')
  const [doctorRunning, setDoctorRunning] = useState(false)

  // Outside-click / Escape dismissal for the SMALL popovers. Each ref wraps BOTH
  // the trigger button AND its popover panel (see useDismiss) so toggling the
  // trigger off doesn't fire the close-then-reopen race. The wrappers use
  // `display: contents`, so they keep the existing flex/absolute layout intact
  // while still being a common DOM ancestor for `.contains()`.
  const volRef = useRef<HTMLDivElement | null>(null)
  const arrangeRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const settingsRef = useRef<HTMLDivElement | null>(null)
  const doctorRef = useRef<HTMLDivElement | null>(null)
  const missionRef = useRef<HTMLDivElement | null>(null)
  const conductorRef = useRef<HTMLDivElement | null>(null)
  const horizonRef = useRef<HTMLDivElement | null>(null)
  // Frost-reveal refs: attached to the actual translucent `.glass` rects (NOT the
  // display:contents dismissal wrappers) so the z-29 BackdropFrost shows under
  // the center pill + popovers as real liquid glass.
  const pillFrostRef = useRef<HTMLDivElement | null>(null)
  const menuFrostRef = useRef<HTMLDivElement | null>(null)
  const volFrostRef = useRef<HTMLDivElement | null>(null)
  const arrangeFrostRef = useRef<HTMLDivElement | null>(null)
  useFrostRect(pillFrostRef, { radius: 11 })
  useFrostRect(menuFrostRef, { radius: 12, active: menuOpen })
  useFrostRect(volFrostRef, { radius: 12, active: volOpen })
  useFrostRect(arrangeFrostRef, { radius: 12, active: arrangeMenuOpen })
  useDismiss(volOpen, useCallback(() => setVolOpen(false), []), volRef)
  useDismiss(arrangeMenuOpen, useCallback(() => setArrangeMenuOpen(false), []), arrangeRef)
  useDismiss(settingsOpen, useCallback(() => setSettingsOpen(false), []), settingsRef)
  useDismiss(doctorOpen, useCallback(() => setDoctorOpen(false), []), doctorRef)
  useDismiss(missionOpen, useCallback(() => setMissionOpen(false), []), missionRef)
  useDismiss(conductorOpen, useCallback(() => setConductorOpen(false), []), conductorRef)
  useDismiss(horizonOpen, useCallback(() => setHorizonOpen(false), []), horizonRef)
  // Closing the main menu also collapses the nested Crew Recipes submenu, matching
  // the trigger's own onClick logic.
  useDismiss(
    menuOpen,
    useCallback(() => {
      setMenuOpen(false)
      setRecipesOpen(false)
    }, []),
    menuRef
  )

  // Keep the TopBar health dot live even while the Doctor panel is closed.
  useEffect(() => {
    const d = getDoctorBridge()
    if (!d) return
    const worst = (issues: { severity: 'info' | 'warn' | 'error' }[]): HealthLevel => {
      let lvl: HealthLevel = 'ok'
      for (const r of issues) {
        if (r.severity === 'error') return 'error'
        if (r.severity === 'warn') lvl = 'warn'
      }
      return lvl
    }
    d.status()
      .then((s) => setHealth(worst(s.issues)))
      .catch(() => {})
    const offReport = d.onReport((issues) => setHealth(worst(issues)))
    const offRunning = d.onRunning((r) => setDoctorRunning(r))
    return () => {
      offReport()
      offRunning()
    }
  }, [])
  // Let the Beacon "Resumen de la misión" command open the Mission Pulse panel
  // (which leads with the Mission Brief) without lifting this local state.
  useEffect(() => {
    const open = (): void => setMissionOpen(true)
    window.addEventListener('canvasio:open-mission', open)
    return () => window.removeEventListener('canvasio:open-mission', open)
  }, [])
  // The 'A' hotkey + the Command Palette open/toggle the Conductor panel via the
  // same CustomEvent convention every other lens panel uses (B/L/D/…).
  useEffect(() => {
    const toggle = (): void => setConductorOpen((v) => !v)
    window.addEventListener('canvasio:open-conductor', toggle)
    return () => window.removeEventListener('canvasio:open-conductor', toggle)
  }, [])
  // The Command Palette opens/toggles the Horizon panel via the same CustomEvent
  // convention every other lens panel uses.
  useEffect(() => {
    const toggle = (): void => setHorizonOpen((v) => !v)
    window.addEventListener('canvasio:open-horizon', toggle)
    return () => window.removeEventListener('canvasio:open-horizon', toggle)
  }, [])

  const directorArmed = useDirector((s) => s.armed)
  const appVolume = useCanvas((s) => s.appVolume)
  const setAppVolume = useCanvas((s) => s.setAppVolume)
  const fitToView = useCanvas((s) => s.fitToView)
  const bootRecipe = useCanvas((s) => s.bootRecipe)
  const loadLayout = useCanvas((s) => s.loadLayout)

  const exportLayout = (): void => {
    const { nodes, waypoints } = useCanvas.getState()
    // Include the camera-only saved views so an exported layout round-trips them
    // (loadLayout sanitizes/clamps them on import); mirrors the canvasio:layout
    // persistence shape in App.tsx.
    const blob = new Blob([JSON.stringify({ nodes, waypoints }, null, 2)], {
      type: 'application/json'
    })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'canvasio-layout.json'
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const openRecent = (): void => {
    try {
      const saved = localStorage.getItem('canvasio:layout')
      if (saved) loadLayout(JSON.parse(saved))
    } catch {
      /* ignore */
    }
  }

  const menuActions: Record<string, () => void> = {
    // Multi-canvas: "New canvas" now creates a NAMED doc in a new tab and switches
    // into it (the old canvas survives on disk). The destructive clear() wipe +
    // useMission.clearAll() are gone — newCanvas's switch path clears the live
    // stores via useCanvas.clear() while persisting the outgoing canvas first.
    'Nuevo lienzo': () => void useWorkspace.getState().newCanvas(),
    'Abrir reciente…': openRecent,
    'Receta de inicio': () => bootRecipe(),
    'Exportar disposición': exportLayout,
    Ajustes: () => setSettingsOpen(true)
  }

  // Stable Spanish action identifiers (the menuActions keys) → i18n label keys.
  // The identifiers stay constant across languages; only the rendered label changes.
  const menuLabelKeys: Record<string, string> = {
    'Nuevo lienzo': 'topbar.menu_new_canvas',
    'Abrir reciente…': 'topbar.menu_open_recent',
    'Receta de inicio': 'topbar.menu_boot_recipe',
    'Exportar disposición': 'topbar.menu_export_layout',
    Ajustes: 'topbar.settings'
  }

  return (
    <div
      className="drag-region"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: 'var(--chrome-h)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
        pointerEvents: 'none'
      }}
    >
      {/* center pill */}
      <div
        ref={pillFrostRef}
        className="glass no-drag"
        style={{
          pointerEvents: 'auto',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '5px 8px',
          borderRadius: 11,
          marginTop: 6
        }}
      >
        {/* Main ☰ menu trigger + popover (incl. nested recipes) share one ref
            (display:contents) so an outside click / Escape dismisses the menu,
            while toggling the trigger still works (no reopen race). */}
        <div ref={menuRef} style={{ display: 'contents' }}>
          <button
            onClick={() =>
              setMenuOpen((v) => {
                // Collapse the Crew Recipes submenu whenever the main menu closes.
                if (v) setRecipesOpen(false)
                return !v
              })
            }
            style={pill}
            aria-label={t('topbar.main_menu')}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <span style={{ opacity: 0.7, fontSize: 10 }}>▾</span>
            <span style={{ fontWeight: 700, letterSpacing: '0.04em' }}>CanvasIO</span>
          </button>
          {menuOpen && (
            <div
              ref={menuFrostRef}
              className="glass no-drag"
              style={{
                pointerEvents: 'auto',
                position: 'absolute',
                top: 46,
                left: '50%',
                transform: 'translateX(-120px)',
                borderRadius: 12,
                padding: 6,
                minWidth: 200,
                fontSize: 13
              }}
            >
              {['Nuevo lienzo', 'Abrir reciente…', 'Receta de inicio', 'Exportar disposición', 'Ajustes'].map(
                (m) => (
                  <button
                    key={m}
                    type="button"
                    style={menuItem}
                    onClick={() => {
                      menuActions[m]?.()
                      setMenuOpen(false)
                    }}
                    onMouseEnter={(e) =>
                      (e.currentTarget.style.background = 'rgba(120,160,255,0.14)')
                    }
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    {t(menuLabelKeys[m] ?? m)}
                  </button>
                )
              )}
              {/* Crew Recipes — one-shot multi-agent mission templates. */}
              <button
                type="button"
                style={menuItem}
                onClick={() => setRecipesOpen((v) => !v)}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(120,160,255,0.14)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                {`Crew Recipes ${recipesOpen ? '▾' : '▸'}`}
              </button>
              {recipesOpen &&
                CREW_RECIPES.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    style={{ ...menuItem, paddingLeft: 22 }}
                    onClick={() => {
                      useCanvas.getState().runRecipe(r)
                      setRecipesOpen(false)
                      setMenuOpen(false)
                    }}
                    onMouseEnter={(e) =>
                      (e.currentTarget.style.background = 'rgba(120,160,255,0.14)')
                    }
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    {`${r.icon}  ${r.title}`}
                  </button>
                ))}
            </div>
          )}
        </div>
        <Divider />
        <button
          style={{
            ...iconBtn,
            width: 'auto',
            padding: '0 8px',
            gap: 5,
            fontSize: 11,
            display: 'flex',
            alignItems: 'center',
            color: '#8ba0c8'
          }}
          title={t('topbar.command_palette_title')}
          aria-label={t('topbar.command_palette_open')}
          onClick={() =>
            window.dispatchEvent(
              new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true })
            )
          }
        >
          <span style={{ opacity: 0.6 }}>🔍</span>
          <kbd
            style={{
              fontFamily: 'inherit',
              fontSize: 10.5,
              border: '1px solid rgba(140,165,225,0.3)',
              borderRadius: 5,
              padding: '1px 5px',
              color: '#aebbd6'
            }}
          >
            ⌘K
          </kbd>
        </button>
        <Divider />
        {/* Arrange trigger + density popover share one ref (display:contents) so
            an outside click / Escape dismisses the menu while toggling the trigger
            still works (no reopen race). Left-click arranges at the persisted
            default; right-click opens the density menu (one-off density, set the
            default, or cascade the windows). */}
        <div ref={arrangeRef} style={{ display: 'contents' }}>
          <button
            style={{ ...iconBtn, color: arrangeMenuOpen ? '#cfe0ff' : '#aebbd6' }}
            title={t('topbar.arrange')}
            aria-label={t('topbar.arrange')}
            aria-haspopup="menu"
            aria-expanded={arrangeMenuOpen}
            onClick={() => useCanvas.getState().arrange()}
            onContextMenu={(e) => {
              e.preventDefault()
              setArrangeMenuOpen((v) => !v)
            }}
          >
            <GridIcon />
          </button>
          {arrangeMenuOpen && (
            <div
              ref={arrangeFrostRef}
              className="glass no-drag topbar-arrange-pop"
              style={{
                pointerEvents: 'auto',
                position: 'absolute',
                top: 46,
                left: '50%',
                transform: 'translateX(-40px)',
                borderRadius: 12,
                padding: 6,
                minWidth: 200,
                fontSize: 13,
                maxHeight: '72vh',
                overflowY: 'auto'
              }}
            >
              {/* Arrange NOW at a chosen density (one-off; doesn't change default). */}
              <div style={{ padding: '4px 10px 2px', color: '#8ba0c8', fontSize: 11 }}>
                {t('topbar.arrange_now')}
              </div>
              {ARRANGE_GRID_CHOICES.map((g) => (
                <button
                  key={`now-${g}`}
                  type="button"
                  style={menuItem}
                  onClick={() => {
                    useCanvas.getState().arrange(g)
                    setArrangeMenuOpen(false)
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.background = 'rgba(120,160,255,0.14)')
                  }
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  {gridLabel(g)}
                </button>
              ))}
              {/* Set the DEFAULT density (used by left-click + voice + palette). */}
              <div style={{ padding: '6px 10px 2px', color: '#8ba0c8', fontSize: 11 }}>
                {t('topbar.arrange_default')}
              </div>
              {ARRANGE_GRID_CHOICES.map((g) => (
                <button
                  key={`def-${g}`}
                  type="button"
                  style={{ ...menuItem, fontWeight: defaultGrid === g ? 700 : 400 }}
                  onClick={() => {
                    setArrangeGrid(g)
                    setDefaultGrid(g)
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.background = 'rgba(120,160,255,0.14)')
                  }
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  {`${defaultGrid === g ? '✓ ' : '   '}${gridLabel(g)}`}
                </button>
              ))}
              {/* Cascade — the same pile op the agent can trigger by voice. */}
              <div style={{ height: 1, background: 'rgba(140,165,225,0.2)', margin: '4px 0' }} />
              <button
                type="button"
                style={menuItem}
                onClick={() => {
                  useCanvas.getState().cascade()
                  setArrangeMenuOpen(false)
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.background = 'rgba(120,160,255,0.14)')
                }
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                {t('topbar.cascade')}
              </button>
            </div>
          )}
        </div>
        <button
          style={iconBtn}
          title={t('topbar.fit_to_view')}
          aria-label={t('topbar.fit_to_view')}
          onClick={() => fitToView()}
        >
          <ExpandIcon />
        </button>
        <button
          style={{ ...iconBtn, color: directorArmed ? '#c77dff' : '#aebbd6' }}
          title={t('topbar.director_mode_title')}
          aria-label={t('topbar.director_mode')}
          aria-pressed={directorArmed}
          onClick={() => useDirector.getState().toggle()}
        >
          <DirectorIcon />
        </button>
        {/* Volume trigger + popover share one ref (display:contents) so an
            outside click / Escape dismisses the slider, while clicking the
            trigger still toggles cleanly (no close-then-reopen race). */}
        <div ref={volRef} style={{ display: 'contents' }}>
          <button
            style={{ ...iconBtn, color: volOpen ? '#cfe0ff' : '#aebbd6' }}
            title={t('topbar.app_volume')}
            aria-label={t('topbar.app_volume')}
            onClick={() => setVolOpen((v) => !v)}
          >
            <VolumeIcon muted={appVolume <= 0} />
          </button>
          {volOpen && (
            <div
              ref={volFrostRef}
              className="glass no-drag"
              style={{
                pointerEvents: 'auto',
                position: 'absolute',
                top: 46,
                left: '50%',
                transform: 'translateX(20px)',
                borderRadius: 12,
                padding: '12px 14px',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                width: 220
              }}
            >
              <button
                onClick={() => setAppVolume(appVolume <= 0 ? 0.85 : 0)}
                aria-label={appVolume <= 0 ? t('topbar.unmute') : t('topbar.mute')}
                title={appVolume <= 0 ? t('topbar.unmute') : t('topbar.mute')}
                style={{ background: 'none', border: 'none', color: '#cdd9f5', fontSize: 15, cursor: 'pointer' }}
              >
                {appVolume <= 0 ? '🔇' : appVolume < 0.5 ? '🔉' : '🔊'}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={appVolume}
                onChange={(e) => setAppVolume(parseFloat(e.target.value))}
                aria-label={t('topbar.app_volume')}
                style={{ flex: 1, accentColor: 'var(--canvasio-accent, #5b8cff)' }}
              />
              <span style={{ color: '#8ba0c8', fontSize: 12, width: 28, textAlign: 'right' }}>
                {Math.round(appVolume * 100)}
              </span>
            </div>
          )}
        </div>
        <div ref={settingsRef} style={{ display: 'contents' }}>
          <button
            style={{ ...iconBtn, color: settingsOpen ? '#cfe0ff' : '#aebbd6' }}
            title={t('topbar.settings')}
            aria-label={t('topbar.settings')}
            onClick={() => setSettingsOpen((v) => !v)}
          >
            <GearIcon />
          </button>
          {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
        </div>
        <div ref={missionRef} style={{ display: 'contents' }}>
          <MissionPulseChip active={missionOpen} onClick={() => setMissionOpen((v) => !v)} />
          <MissionLog open={missionOpen} onClose={() => setMissionOpen(false)} />
        </div>
        <div ref={doctorRef} style={{ display: 'contents' }}>
          <HealthIndicator
            level={health}
            running={doctorRunning}
            active={doctorOpen}
            onClick={() => setDoctorOpen((v) => !v)}
          />
          {doctorOpen && <DoctorPanel onClose={() => setDoctorOpen(false)} />}
        </div>
        {/* Triage notices ("N te necesita" / "Todo al día") live at the RIGHT of
            the bar so they never overlap the centered controls. */}
        <Divider />
        {/* The Conductor's single top next-best-action (prescriptive), then the
            Triage count (descriptive who-needs-you). */}
        <div ref={conductorRef} style={{ display: 'contents' }}>
          <ConductorChip onOpenPanel={() => setConductorOpen((v) => !v)} />
          {conductorOpen && <ConductorPanel onClose={() => setConductorOpen(false)} />}
        </div>
        {/* Course Correct — the one-click corrective nudge to an agent drifting from
            the team's emergent consensus (closes the observability loop). */}
        <CourseCorrectChip />
        {/* The swarm-level mission forecast (forward-looking), beside the Conductor. */}
        <div ref={horizonRef} style={{ display: 'contents' }}>
          <HorizonChip onOpenPanel={() => setHorizonOpen((v) => !v)} />
          {horizonOpen && <HorizonPanel onClose={() => setHorizonOpen(false)} />}
        </div>
        {/* The swarm's unblock bus: live questions agents are stalled on. */}
        <QuestionsChip />
        {/* Stages — curated multi-node scenes (renders nothing until captured). */}
        <StagesChip />
        {/* Backlog — total unseen activity across all agents; click jumps to the
            agent that owes the most (same march as the keyboard action). */}
        <BacklogTopChip />
        <TriageChip />
      </div>

      <UpdateToast />
    </div>
  )
}

const pill: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  background: 'transparent',
  border: 'none',
  color: '#e7eeff',
  fontSize: 13,
  padding: '4px 8px',
  borderRadius: 8
}
const iconBtn: React.CSSProperties = {
  width: 28,
  height: 26,
  display: 'grid',
  placeItems: 'center',
  background: 'transparent',
  border: 'none',
  color: '#aebbd6',
  borderRadius: 7
}
const menuItem: React.CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  padding: '7px 10px',
  borderRadius: 7,
  color: '#cdd9f5',
  cursor: 'pointer',
  background: 'transparent',
  border: 'none',
  font: 'inherit',
  fontSize: 13
}

function Divider(): JSX.Element {
  return <div style={{ width: 1, height: 18, background: 'rgba(140,165,225,0.2)', margin: '0 3px' }} />
}
function GridIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <rect x="1" y="1" width="5" height="5" rx="1" stroke="currentColor" />
      <rect x="8" y="1" width="5" height="5" rx="1" stroke="currentColor" />
      <rect x="1" y="8" width="5" height="5" rx="1" stroke="currentColor" />
      <rect x="8" y="8" width="5" height="5" rx="1" stroke="currentColor" />
    </svg>
  )
}
function ExpandIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M5 1H1v4M9 13h4V9M13 5V1H9M1 9v4h4" />
    </svg>
  )
}
function VolumeIcon({ muted }: { muted: boolean }): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M2 6v4h2.5L8 13V3L4.5 6H2z" />
      {muted ? (
        <path d="M11 6l3 4M14 6l-3 4" />
      ) : (
        <path d="M10.5 5.5a3.5 3.5 0 010 5M12.5 3.8a6 6 0 010 8.4" />
      )}
    </svg>
  )
}
function DirectorIcon(): JSX.Element {
  // A camera/target "follow" glyph: a ring with a center dot.
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
      <circle cx="8" cy="8" r="5.4" />
      <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
      <path d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15" />
    </svg>
  )
}
function GearIcon(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.1">
      <circle cx="8" cy="8" r="2.1" />
      <path
        d="M8 1.6l.8 1.5a5 5 0 0 1 1.7.7l1.7-.5.9 1.6-1.2 1.2a5 5 0 0 1 0 1.4l1.2 1.2-.9 1.6-1.7-.5a5 5 0 0 1-1.7.7L8 14.4l-.8-1.5a5 5 0 0 1-1.7-.7l-1.7.5-.9-1.6 1.2-1.2a5 5 0 0 1 0-1.4L2.9 6.9l.9-1.6 1.7.5a5 5 0 0 1 1.7-.7z"
        strokeLinejoin="round"
      />
    </svg>
  )
}
