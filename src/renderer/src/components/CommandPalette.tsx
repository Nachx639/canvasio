import { useEffect, useMemo, useRef, useState } from 'react'
import { useCanvas, AGENT_LABEL, type AgentKind } from '../store/canvas'
import { activeCanvasCwd } from '../store/workspace'
import { openOrFocusFileNode, openOrFocusCalendar } from '../lib/fileNodes'
import { resolveMarkdownPath } from '../lib/pathResolver'
import { useReplay } from '../store/replay'
import { useMission } from '../store/mission'
import { useChangeset } from '../store/changeset'
import { useCheckpoints } from '../store/checkpoints'
import { useDirector } from '../store/director'
import { useTour } from '../store/tour'
import { useTimefold } from '../store/timefold'
import { useStall } from '../store/stall'
import { promptText } from '../store/promptModal'
import { useAwayAlerts } from '../store/awayAlerts'
import { useBoard } from '../store/board'
import { useRecall } from '../store/recall'
import { useRelay } from '../store/relay'
import { useConductor } from '../store/conductor'
import { useHorizon } from '../store/horizon'
import { useVoiceLoop } from '../store/voiceLoop'
import { useLens } from '../store/lens'
import { useEcho } from '../store/echo'
import { useBacklog } from '../store/backlog'
import { useSentinel } from '../store/sentinel'
import { useTripwire } from '../store/tripwire'
import { useHistory } from '../store/history'
import { useRegions } from '../store/regions'
import { regionBounds, suggestDistricts } from '../lib/territory'
import { formatBoardForInjection } from '../lib/boardFormat'
import { analyzeConsensus, subjectKey, assertedValue } from '../lib/consensus'
import { THEMES } from '../lib/themes'
import { CREW_RECIPES } from '../lib/crewRecipes'
import { useScorecard } from '../store/scorecard'
import { classifyTask } from '../lib/skillMemory'
import { briefHeadline } from '../lib/missionBrief'
import { narrateBrief } from '../lib/narration'
import { etaLabel } from '../lib/horizon'
import { useT, t } from '../store/i18n'

interface Command {
  id: string
  /** primary searchable label */
  title: string
  /** secondary muted hint (node subtitle, command group, etc.) */
  hint?: string
  /** small leading glyph */
  icon: string
  /** keywords folded into the search haystack */
  keywords?: string
  run: () => void
  /**
   * Layout Time Machine — when true the row renders muted (the underlying
   * undo/redo stack is empty). It still runs harmlessly (undo()/redo() are
   * no-ops on an empty stack), so this is purely a discoverability affordance.
   */
  disabled?: boolean
  /**
   * Spyglass — when set, this row is a SPATIAL target whose node can be previewed
   * with a long-press (peekAt this id, then endPeek on release) before committing
   * Enter/click. Node rows set it to the node id; waypoint rows resolve a target
   * node lazily via peekTargetId at hold-time (a waypoint is a camera view, not a
   * node), so this is set only for node rows.
   */
  peekId?: string
  /**
   * Agent Scorecard — a quiet 'más fiable' badge on a recipe row whose crew uses
   * the persona the cross-mission track record ranks most reliable. Purely
   * informational; it never changes what the row runs.
   */
  badge?: string
}

/**
 * Beacon — a ⌘K command palette that doubles as a spatial teleporter. Typing a
 * node name and pressing Enter flies the camera to it (centerOnNode). The same
 * surface runs canvas commands wired to EXISTING store actions only. Purely
 * renderer-side and additive: it READS nodes and CALLS store actions — it never
 * mutates node/shape geometry, touches IPC, or changes the main process.
 */
export function CommandPalette({ onClose }: { onClose: () => void }): JSX.Element {
  const t = useT()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Build the command set once per open (snapshot of nodes + static commands).
  const commands = useMemo<Command[]>(() => buildCommands(onClose), [onClose])

  // Echo Index — content-search mode. A leading `>` switches the result SOURCE
  // from the command/node set to a spatial grep over every agent's captured
  // output lines (useEcho.search). Each hit becomes a node-fly-to row, so
  // Enter/click + Spyglass long-press inherit the existing machinery untouched.
  const isContentSearch = query.trimStart().startsWith('>')
  const results = useMemo(() => {
    if (isContentSearch) {
      const q = query.trimStart().slice(1)
      return buildEchoCommands(q)
    }
    return rank(commands, query)
  }, [commands, query, isContentSearch])

  // clamp the active index whenever the result set shrinks
  useEffect(() => {
    setActive((a) => (results.length === 0 ? 0 : Math.min(a, results.length - 1)))
  }, [results.length])

  // focus the input on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // keep the active row scrolled into view
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const runActive = (): void => {
    const cmd = results[active]
    if (!cmd) return
    onClose()
    cmd.run()
  }

  // Spyglass — long-press a spatial (node) row to PREVIEW it (peekAt) without
  // committing; the release springs the camera back (endPeek). A short tap/click
  // keeps the existing centerOnNode commit. The peek does NOT close the palette,
  // so you can keep browsing; Enter/click still commit + close as before.
  const PEEK_HOLD_MS = 180
  const holdTimer = useRef<number | null>(null)
  const peekedRef = useRef(false)
  // Set when a long-press peek just ended on this pointer sequence, so the
  // trailing synthetic click is ignored (does not commit + close the palette).
  const justPeekedRef = useRef(false)
  const clearHold = (): void => {
    if (holdTimer.current != null) {
      window.clearTimeout(holdTimer.current)
      holdTimer.current = null
    }
  }
  useEffect(() => () => {
    // On unmount (palette close), make sure any in-flight peek springs back.
    clearHold()
    if (peekedRef.current) {
      useCanvas.getState().endPeek()
      peekedRef.current = false
    }
  }, [])
  const onRowPointerDown = (cmd: Command): void => {
    if (!cmd.peekId) return
    clearHold()
    peekedRef.current = false
    const id = cmd.peekId
    holdTimer.current = window.setTimeout(() => {
      peekedRef.current = true
      useCanvas.getState().peekAt(id)
    }, PEEK_HOLD_MS)
  }
  const onRowPointerUp = (): void => {
    clearHold()
    if (peekedRef.current) {
      useCanvas.getState().endPeek()
      peekedRef.current = false
      // Flag so the trailing click on this same row is ignored.
      justPeekedRef.current = true
    }
  }
  const onRowPointerLeave = (): void => {
    clearHold()
    if (peekedRef.current) {
      useCanvas.getState().endPeek()
      peekedRef.current = false
    }
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => (results.length ? (a + 1) % results.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => (results.length ? (a - 1 + results.length) % results.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      runActive()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div className="beacon-backdrop" onPointerDown={onClose}>
      <div
        className="beacon glass"
        role="dialog"
        aria-modal="true"
        aria-label={t('palette.dialog_label')}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="beacon-input-row">
          <span className="beacon-glyph" aria-hidden>
            ⌘
          </span>
          <input
            ref={inputRef}
            className="beacon-input"
            placeholder={t('palette.placeholder')}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            onKeyDown={onKeyDown}
            aria-label={t('palette.search_aria')}
          />
        </div>
        <div className="beacon-list" ref={listRef}>
          {results.length === 0 ? (
            <div className="beacon-empty">
              {isContentSearch
                ? query.trimStart().length <= 1
                  ? t('palette.search_prompt')
                  : t('palette.no_output_matches')
                : t('palette.no_results')}
            </div>
          ) : (
            results.map((cmd, i) => (
              <button
                key={cmd.id}
                type="button"
                className="beacon-row"
                data-active={i === active}
                style={cmd.disabled ? { opacity: 0.42 } : undefined}
                onPointerEnter={() => setActive(i)}
                onPointerDown={() => onRowPointerDown(cmd)}
                onPointerUp={onRowPointerUp}
                onPointerLeave={onRowPointerLeave}
                onClick={() => {
                  // Suppress the synthetic click that follows a long-press peek so
                  // a preview never accidentally commits + closes the palette.
                  if (justPeekedRef.current) {
                    justPeekedRef.current = false
                    return
                  }
                  onClose()
                  cmd.run()
                }}
              >
                <span className="beacon-row-icon" aria-hidden>
                  {cmd.icon}
                </span>
                <span className="beacon-row-title">{cmd.title}</span>
                {cmd.hint && <span className="beacon-row-hint">{cmd.hint}</span>}
                {cmd.badge && (
                  <span
                    className="beacon-row-badge"
                    title={t('palette.badge_tooltip')}
                    style={{
                      marginLeft: 'auto',
                      fontSize: 10.5,
                      fontWeight: 700,
                      color: '#9b8cff',
                      background: 'rgba(155,140,255,0.12)',
                      border: '1px solid rgba(155,140,255,0.33)',
                      borderRadius: 6,
                      padding: '1px 6px',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    ◆ {cmd.badge}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

/** Build the full command list: node fly-to targets + static canvas commands. */
function buildCommands(_onClose: () => void): Command[] {
  const c = useCanvas.getState()
  const cmds: Command[] = []

  // ---- spatial: fly to each node ----
  // Wayback — when the palette opens (empty query) show the nodes you've ACTUALLY
  // been working in first: order by frecency (recency x frequency of real visits)
  // and fall back to raw insertion order for never-visited nodes. Typing still
  // fuzzy-ranks every node via rank() below, so this only changes the resting
  // order. Read-only over the visit log; never mutates geometry / touches IPC.
  const visits = c.visits
  const frecency = c.frecencyOrder()
  const rankIdx = new Map(frecency.map((id, i) => [id, i] as const))
  const orderedNodes = [...c.nodes].sort((a, b) => {
    const ra = rankIdx.get(a.id)
    const rb = rankIdx.get(b.id)
    // Visited nodes come first (by frecency rank); unvisited keep insertion order.
    if (ra != null && rb != null) return ra - rb
    if (ra != null) return -1
    if (rb != null) return 1
    return 0
  })
  for (const n of orderedNodes) {
    const badge =
      n.kind === 'terminal' && n.agent
        ? AGENT_LABEL[n.agent].title
        : n.kind === 'music'
          ? t('palette.kind_music')
          : n.kind === 'web'
            ? t('palette.kind_web')
            : n.kind === 'calendar'
              ? t('palette.kind_calendar')
              : t('palette.kind_node')
    const base = n.subtitle ? `${badge} · ${n.subtitle}` : badge
    // Wayback — append a muted recency hint for visited nodes (e.g. "· hace 2m ·
    // 3 visitas") reusing the existing beacon-row-hint slot.
    const v = visits[n.id]
    const hint = v ? `${base} · ${formatAgo(v.lastTs)} · ${formatVisits(v.count)}` : base
    cmds.push({
      id: `node:${n.id}`,
      title: n.title,
      hint,
      icon: n.kind === 'music' ? '♪' : n.kind === 'web' ? '◍' : n.kind === 'calendar' ? '📅' : '▸',
      keywords: `${badge} ${n.subtitle ?? ''} ${n.agent ?? ''}`,
      run: () => useCanvas.getState().centerOnNode(n.id),
      // Spyglass — long-press this row to preview the node (peek) then spring back.
      peekId: n.id
    })
    // Watchtower — a companion command per node to pin/unpin it into the corner
    // live-watch panel, so the feature is fully voice / ⌘K reachable. Only terminal
    // nodes carry a live Lens line worth watching.
    if (n.kind === 'terminal') {
      const watched = c.watchIds.includes(n.id)
      cmds.push({
        id: `watch:${n.id}`,
        title: watched
          ? t('palette.watch_stop', { title: n.title })
          : t('palette.watch_start', { title: n.title }),
        hint: watched ? t('palette.watch_hint_remove') : t('palette.watch_hint_add'),
        icon: '👁',
        keywords: `watch vigilar pin monitor panel torre vigilancia ${n.agent ?? ''}`,
        run: () => useCanvas.getState().toggleWatch(n.id)
      })
    }
  }

  // ---- Sentinel: forward-looking standing orders on the SELECTED terminal ----
  // "Arm Sentinel on selected node…" — one entry per trigger kind, plus a regex
  // 'match' prompt. Scoped to the current selection (not every node) so the
  // palette stays lean; the per-node header pip + the SentinelChip cover the rest.
  // Arming captures the arm-time baseline in the store so an already-true
  // condition never instantly fires. Clear-all is always available below.
  const sel = c.selectedId ? c.nodes.find((n) => n.id === c.selectedId) : undefined
  if (sel && sel.kind === 'terminal') {
    const label = sel.title || (sel.agent ? AGENT_LABEL[sel.agent].title : t('palette.the_agent'))
    const kw = `sentinel orden permanente standing order watch vigilar avisar despierta wake when cuando vuela fly ${sel.agent ?? ''}`
    cmds.push(
      {
        id: `sentinel:waiting:${sel.id}`,
        title: t('palette.sentinel_waiting', { label }),
        hint: t('palette.sentinel_waiting_hint'),
        icon: '☉',
        keywords: `${kw} waiting esperando respuesta y/n prompt`,
        run: () => useSentinel.getState().arm(sel.id, 'waiting')
      },
      {
        id: `sentinel:error:${sel.id}`,
        title: t('palette.sentinel_error', { label }),
        hint: t('palette.sentinel_error_hint'),
        icon: '☉',
        keywords: `${kw} error fallo falla crash`,
        run: () => useSentinel.getState().arm(sel.id, 'error')
      },
      {
        id: `sentinel:done:${sel.id}`,
        title: t('palette.sentinel_done', { label }),
        hint: t('palette.sentinel_done_hint'),
        icon: '☉',
        keywords: `${kw} done terminado completado finished hecho`,
        run: () => useSentinel.getState().arm(sel.id, 'done')
      },
      {
        id: `sentinel:match:${sel.id}`,
        title: t('palette.sentinel_match', { label }),
        hint: t('palette.sentinel_match_hint'),
        icon: '☉',
        keywords: `${kw} match regex coincidencia patrón pattern grep`,
        run: async () => {
          const pattern = await promptText(
            t('palette.sentinel_match_prompt', { label }),
            ''
          )
          if (pattern && pattern.trim()) useSentinel.getState().arm(sel.id, 'match', pattern.trim())
        }
      }
    )
  }
  // Clear every armed Sentinel order (only meaningful when some are armed).
  if (useSentinel.getState().orders.length > 0) {
    cmds.push({
      id: 'sentinel:clear',
      title: t('palette.sentinel_clear'),
      hint: t('palette.sentinel_clear_hint'),
      icon: '☉',
      keywords: 'sentinel clear limpiar borrar desarmar standing order todas all',
      run: () => useSentinel.getState().reset()
    })
  }

  // ---- spatial: fly to each saved Waypoint (camera-only saved views) ----
  c.waypoints.forEach((wp, i) => {
    cmds.push({
      id: `wp:${wp.id}`,
      title: wp.name,
      hint: i < 9 ? t('palette.saved_view_n', { n: i + 1 }) : t('palette.saved_view'),
      icon: '⚑',
      keywords: `waypoint vista guardada saved view ${wp.name} ${i + 1}`,
      run: () => useCanvas.getState().goWaypoint(wp.id)
    })
  })

  // ---- Stages: curated multi-node scenes (named, persisted working sets) ----
  // Capture the current working set as a named scene (selection, else the open
  // Constellation Filter matches). No-op when neither exists; the row is always
  // listed for discoverability (mirrors the "Guardar vista" Waypoint row).
  cmds.push({
    id: 'stage:capture',
    title: t('palette.stage_capture'),
    hint: t('palette.stage_capture_hint'),
    icon: '◆',
    keywords: 'stage escena capturar scene capture working set conjunto guardar',
    run: () => useCanvas.getState().captureStage()
  })
  // Activate / delete each saved scene. Activating frames + spotlights its
  // members (shared boundsOf + the .spotlit/.dimmed chrome); the first member
  // node seeds peekId so a long-press previews the scene for free (Spyglass).
  c.stages.forEach((st, i) => {
    cmds.push({
      id: `stage:${st.id}`,
      title: t('palette.stage_activate', { name: st.name }),
      hint:
        t('palette.stage_nodes', { n: st.nodeIds.length }) +
        (i < 9 ? ` · ⌘⇧${i + 1}` : ''),
      icon: '◆',
      keywords: `stage escena scene activar activate ${st.name} ${i + 1}`,
      run: () => useCanvas.getState().activateStage(st.id),
      // Spyglass — long-press to preview the scene's first member, then spring back.
      peekId: st.nodeIds[0]
    })
    cmds.push({
      id: `stage:del:${st.id}`,
      title: t('palette.stage_delete', { name: st.name }),
      hint: 'Stage',
      icon: '×',
      keywords: `stage escena scene eliminar delete remove ${st.name}`,
      run: () => useCanvas.getState().removeStage(st.id)
    })
  })
  // Release the active scene's spotlight isolation (only when one is active).
  if (c.stageIds != null) {
    cmds.push({
      id: 'stage:clear',
      title: t('palette.stage_clear'),
      hint: t('palette.stage_clear_hint'),
      icon: '✕',
      keywords: 'stage escena scene salir clear exit isolation aislamiento',
      run: () => useCanvas.getState().clearStage()
    })
  }

  // ---- spatial: fly to each District (Region) ----
  // Districts are first-class teleport targets: flying to one frames its bounds
  // via the same camera tween (centerOnBounds -> cameraForBounds), so the move
  // participates in Slipstream Back/Forward exactly like the Waypoint rows above.
  for (const r of useRegions.getState().regions) {
    cmds.push({
      id: `district:${r.id}`,
      title: t('palette.fly_to', { name: r.name }),
      hint: t('palette.district'),
      icon: '▦',
      keywords: `district distrito region zona area territorio fly volar ${r.name}`,
      run: () => useCanvas.getState().centerOnBounds(regionBounds(r))
    })
  }

  // ---- static canvas commands (existing store actions only) ----
  const spawn =
    (agent: AgentKind): (() => void) =>
    () =>
      useCanvas.getState().addNode({ kind: 'terminal', agent, cwd: activeCanvasCwd() })

  cmds.push(
    {
      id: 'cmd:arrange',
      title: t('palette.arrange'),
      hint: t('palette.command'),
      icon: '▦',
      keywords: 'arrange grid tile organizar cuadricula',
      run: () => useCanvas.getState().arrange()
    },
    {
      id: 'cmd:declutter',
      title: t('palette.declutter'),
      hint: t('palette.declutter_hint'),
      icon: '⤧',
      keywords: 'declutter tidy spread overlap separate ordenar despejar solapar despejar',
      run: () => useCanvas.getState().declutter()
    },
    {
      id: 'flow-layout',
      title: 'Flow Layout',
      hint: t('palette.flow_layout_hint'),
      icon: '⇄',
      keywords: 'graph pipeline relay dag arrange tidy flow handoff columnas flujo',
      run: () => useCanvas.getState().flowLayout()
    },
    {
      id: 'pipeline-walk-down',
      title: t('palette.pipeline_down'),
      hint: 'Relay · n',
      icon: '↳',
      keywords: 'pipeline relay handoff downstream upstream flujo siguiente etapa walk seguir caminar aguas abajo',
      run: () => useCanvas.getState().walkPipeline('down')
    },
    {
      id: 'pipeline-walk-up',
      title: t('palette.pipeline_up'),
      hint: 'Relay · u',
      icon: '↰',
      keywords: 'pipeline relay handoff downstream upstream flujo anterior etapa walk seguir caminar aguas arriba',
      run: () => useCanvas.getState().walkPipeline('up')
    },
    {
      id: 'cmd:territory:map',
      title: t('palette.territory_map'),
      hint: t('palette.districts'),
      icon: '🗺',
      keywords:
        'districts distritos territory territorio map mapear cluster agrupar regiones zonas areas auto organizar etiquetar pipeline relay bandas',
      run: () => {
        // "Map my territory" — auto-cluster the live nodes into suggested
        // Districts, reusing the EXISTING (y,x) reading-order + Agent Relay graph
        // (suggestDistricts). Wrap the geometry-touching nothing (regions are pure
        // data) but snapshot first so the prior layout is undoable, then replace
        // the District set in one shot via setRegions.
        useCanvas.getState().snapshotForGesture('arrange')
        const nodes = useCanvas.getState().nodes.map((n) => ({
          id: n.id,
          x: n.x,
          y: n.y,
          w: n.w,
          h: n.h
        }))
        const edges = useRelay.getState().rules.map((r) => ({
          sourceId: r.sourceId,
          targetId: r.targetId
        }))
        useRegions.getState().setRegions(suggestDistricts(nodes, edges))
      }
    },
    {
      id: 'cmd:district:new',
      title: t('palette.district_new'),
      hint: t('palette.districts'),
      icon: '▦',
      keywords:
        'district distrito new nuevo region zona area territorio crear seccion section frame marco etiqueta',
      run: () => {
        // Create a District framing the CURRENT viewport center (world coords),
        // sized to comfortably hold a couple of nodes. The user then drags the
        // chip to position it, renames on dbl-click, and nodes whose centers fall
        // inside ride along. snapshotForGesture keeps the layout undoable even
        // though creating a region touches no node geometry.
        useCanvas.getState().snapshotForGesture('arrange')
        const cam = useCanvas.getState().camera
        const W = 720
        const H = 520
        // viewport center -> world coords (inverse of the canvas-world transform)
        const cx = (window.innerWidth / 2 - cam.x) / cam.zoom
        const cy = (window.innerHeight / 2 - cam.y) / cam.zoom
        useRegions
          .getState()
          .addRegion({ name: t('palette.district'), x: cx - W / 2, y: cy - H / 2, w: W, h: H })
      }
    },
    // Layout Time Machine — spatial undo/redo. Read stack depth at build time
    // (the command set is rebuilt on every palette open) so the hint shows the
    // remaining steps and the row mutes when the respective stack is empty.
    (() => {
      const depth = useHistory.getState().past.length
      return {
        id: 'cmd:history:undo',
        title: t('palette.history_undo'),
        hint: depth
          ? `Time Machine · ${depth === 1 ? t('palette.available_one', { n: depth }) : t('palette.available_many', { n: depth })}`
          : `Time Machine · ${t('palette.nothing_to_undo')}`,
        icon: '↶',
        keywords: 'undo deshacer history time machine layout disposicion atras revert',
        disabled: depth === 0,
        run: () => useCanvas.getState().undo()
      }
    })(),
    (() => {
      const depth = useHistory.getState().future.length
      return {
        id: 'cmd:history:redo',
        title: t('palette.history_redo'),
        hint: depth
          ? `Time Machine · ${depth === 1 ? t('palette.available_one', { n: depth }) : t('palette.available_many', { n: depth })}`
          : `Time Machine · ${t('palette.nothing_to_redo')}`,
        icon: '↷',
        keywords: 'redo rehacer history time machine layout disposicion adelante',
        disabled: depth === 0,
        run: () => useCanvas.getState().redo()
      }
    })(),
    {
      id: 'cmd:waypoint:save',
      title: t('palette.waypoint_save'),
      hint: 'Waypoint',
      icon: '🚩',
      keywords: 'waypoint guardar vista saved view bookmark marcador camara snapshot',
      run: () => useCanvas.getState().saveWaypoint()
    },
    (() => {
      const armed = useTour.getState().armed
      return {
        id: 'cmd:tour',
        title: armed ? t('palette.tour_stop') : t('palette.tour_start'),
        hint: t('palette.presentation'),
        icon: '🎬',
        keywords:
          'tour grand presentacion presentation guiada recorrido waypoints vistas camara loop hands free manos libres demo standup play reproducir',
        disabled: !armed && useCanvas.getState().waypoints.length < 2,
        run: () => useTour.getState().toggle()
      }
    })(),
    {
      id: 'cmd:wayback:switch',
      title: t('palette.wayback_switch'),
      hint: 'Wayback',
      icon: '⌫',
      keywords:
        'wayback quick switch alt tab anterior previous nodo recent reciente backtick ` ping pong toggle alternar',
      run: () => useCanvas.getState().quickSwitch()
    },
    {
      id: 'cmd:slipstream:back',
      title: t('palette.slipstream_back'),
      hint: t('palette.camera'),
      icon: '‹',
      keywords: 'back atras anterior previous history historial slipstream volver vista navegacion',
      run: () => useCanvas.getState().cameraBack()
    },
    {
      id: 'cmd:slipstream:forward',
      title: t('palette.slipstream_forward'),
      hint: t('palette.camera'),
      icon: '›',
      keywords: 'forward avanzar siguiente next history historial slipstream vista navegacion',
      run: () => useCanvas.getState().cameraForward()
    },
    {
      id: 'cmd:fit',
      title: t('palette.fit'),
      hint: t('palette.command'),
      icon: '⤢',
      keywords: 'fit view zoom encajar todo',
      run: () => useCanvas.getState().fitToView()
    },
    {
      // Beacon — full-text scrollback search across every live terminal. Opening
      // the overlay is enough; the panel takes its own snapshot + owns its input.
      id: 'cmd:beacon',
      title: t('palette.beacon_search'),
      hint: `${t('palette.search')} · ⌘⇧F`,
      icon: '📡',
      keywords:
        'beacon search buscar scrollback terminal output salida content contenido grep find texto stack trace error agente faro',
      run: () => useCanvas.getState().openBeacon()
    },
    {
      // Loupe — discoverability affordance only. The gesture itself lives in
      // Canvas (hold Z + drag); this row just teaches it. Closing the palette is
      // enough to let the user perform it, so run() is a harmless no-op.
      id: 'cmd:loupe',
      title: t('palette.loupe'),
      hint: t('palette.camera_gesture'),
      icon: '🔍',
      keywords: 'loupe lupa zoom box marquee region area drag arrastrar z zona acercar recuadro encuadre',
      run: () => {}
    },
    {
      id: 'cmd:reset100',
      title: t('palette.zoom_100'),
      hint: t('palette.command'),
      icon: '⊙',
      keywords: 'reset zoom 100 crisp',
      run: () => useCanvas.getState().resetZoom100()
    },
    {
      id: 'cmd:boot',
      title: 'Boot recipe',
      hint: t('palette.command'),
      icon: '✦',
      keywords: 'boot recipe seed default layout',
      run: () => useCanvas.getState().bootRecipe()
    },
    // ---- Crew Recipes: one-shot multi-agent mission templates ----
    // Agent Scorecard cross-check (read-only, call-time): resolve the single most
    // reliable persona across your past missions, then quietly badge any recipe
    // whose crew actually uses it as 'más fiable'. Defensive — any scorecard hiccup
    // degrades to no badge, never breaking the recipe rows.
    ...(() => {
      const topReliable = (() => {
        try {
          const ranked = useScorecard.getState().getRanked().ranked
          const top = ranked[0]
          // Only badge when the top persona has real evidence (precision over recall).
          return top && !top.insufficient ? top.kind : null
        } catch {
          return null
        }
      })()
      return CREW_RECIPES.map((r) => {
        // Skill Memory: classify the recipe's LEAD role-prompt into a coarse skill
        // bucket and ask "for THIS kind of task, who's most reliable?". When the
        // bucket has decisive evidence AND that persona is actually on the crew, show
        // a task-relevant badge ("tests → codex 5/5"). Degrade SILENTLY to the global
        // 'más fiable' badge when the bucket is thin — any hiccup → no skill badge.
        const skillBadge = (() => {
          try {
            const lead = r.agents[0]?.prompt
            if (!lead) return null
            const bucket = classifyTask(lead)
            if (bucket === 'other') return null
            const best = useScorecard.getState().bestForBucket(bucket)
            if (!best || !r.agents.some((a) => a.agent === best.kind)) return null
            const done = best.samples - Math.round(best.samples * (1 - best.successRate))
            return `${bucket} → ${best.kind} ${done}/${best.samples}`
          } catch {
            return null
          }
        })()
        return {
          id: `recipe:${r.id}`,
          title: t('palette.recipe', { title: r.title }),
          hint: t('palette.recipe_hint'),
          icon: r.icon,
          keywords: `recipe receta crew equipo mission mision ${r.keywords}`,
          badge:
            skillBadge ??
            (topReliable && r.agents.some((a) => a.agent === topReliable)
              ? `${topReliable} · ${t('palette.most_reliable')}`
              : undefined),
          run: () => useCanvas.getState().runRecipe(r)
        }
      })
    })(),
    {
      id: 'cmd:new',
      title: t('palette.new_canvas'),
      hint: t('palette.command'),
      icon: '＋',
      keywords: 'new canvas clear empty nuevo lienzo limpiar',
      run: () => useCanvas.getState().clear()
    },
    {
      id: 'cmd:spawn:claude',
      title: t('palette.spawn_terminal', { agent: 'Claude' }),
      hint: t('palette.agent'),
      icon: '▸',
      keywords: 'spawn terminal claude agent nuevo',
      run: spawn('claude')
    },
    {
      id: 'cmd:spawn:codex',
      title: t('palette.spawn_terminal', { agent: 'Codex' }),
      hint: t('palette.agent'),
      icon: '▸',
      keywords: 'spawn terminal codex agent nuevo',
      run: spawn('codex')
    },
    {
      id: 'cmd:spawn:cursor',
      title: t('palette.spawn_terminal', { agent: 'Cursor' }),
      hint: t('palette.agent'),
      icon: '▸',
      keywords: 'spawn terminal cursor agent nuevo',
      run: spawn('cursor')
    },
    {
      id: 'cmd:spawn:shell',
      title: t('palette.spawn_terminal', { agent: 'Shell' }),
      hint: t('palette.agent'),
      icon: '▸',
      keywords: 'spawn terminal shell zsh nuevo',
      run: spawn('shell')
    },
    {
      id: 'cmd:file:open-markdown',
      title: t('palette.file_open_md'),
      hint: t('palette.files'),
      icon: '📝',
      keywords: 'markdown md nota note abrir open archivo file documento',
      run: async () => {
        const path = await promptText(
          t('palette.file_path_prompt'),
          'notas.md'
        )
        if (!path || !path.trim()) return
        // Resolve via the SAME resolver the voice path uses: it handles absolute
        // inputs (cwd=dirname, path=basename), cwd-relative inputs, fuzzy/.md
        // matching, AND returns null when the file doesn't exist — so we never open
        // a wrong/broken node.
        const resolved = await resolveMarkdownPath(path.trim())
        if (!resolved) {
          await promptText(t('palette.file_not_found'), '')
          return
        }
        openOrFocusFileNode({
          kind: 'markdown',
          cwd: resolved.cwd,
          filePath: resolved.path,
          title: resolved.path.split('/').pop() || t('palette.note')
        })
      }
    },
    {
      id: 'cmd:file:new-markdown',
      title: t('palette.file_new_md'),
      hint: t('palette.files'),
      icon: '✏️',
      keywords: 'markdown md nota note nueva crear new archivo file documento',
      run: async () => {
        const cwd = activeCanvasCwd()
        if (!cwd) {
          await promptText(
            t('palette.no_workdir'),
            ''
          )
          return
        }
        const name = await promptText(t('palette.new_note_prompt'), 'nueva-nota.md')
        if (!name || !name.trim()) return
        const rel = name.trim().endsWith('.md') ? name.trim() : `${name.trim()}.md`
        const result = await window.canvasio.fs.write(rel, `# ${rel.replace(/\.md$/i, '')}\n\n`, cwd)
        if (!result.ok) {
          await promptText(t('palette.file_create_failed'), '')
          return
        }
        openOrFocusFileNode({
          kind: 'markdown',
          cwd,
          filePath: rel,
          title: rel.split('/').pop() || t('palette.note')
        })
      }
    },
    {
      id: 'cmd:file:open-folder',
      title: t('palette.file_open_folder'),
      hint: t('palette.files'),
      icon: '📁',
      keywords: 'carpeta folder directorio directory navegador explorer proyecto abrir open archivos',
      run: async () => {
        const cwd = activeCanvasCwd()
        if (!cwd) {
          await promptText(
            t('palette.no_workdir'),
            ''
          )
          return
        }
        // dirPath is relative to the node's cwd base (the canvas folder); '.' is
        // the folder root. Navigation appends child names; the main-process fs
        // bridge resolves + traversal-validates every path against cwd.
        openOrFocusFileNode({
          kind: 'folder',
          cwd,
          dirPath: '.',
          title: cwd.split('/').pop() || t('palette.folder')
        })
      }
    },
    {
      id: 'cmd:calendar:new',
      title: t('palette.calendar_new'),
      hint: t('palette.shared_annotations'),
      icon: '📅',
      keywords: 'calendario calendar agenda anotaciones notas fechas mes compartido nuevo new',
      run: () => {
        // Calendar annotations are GLOBAL (cross-canvas, persisted); the node is
        // just a viewport onto them. Place it near the centre of the viewport.
        const cam = useCanvas.getState().camera
        const x = (window.innerWidth / 2 - cam.x) / cam.zoom - 280
        const y = (window.innerHeight / 2 - cam.y) / cam.zoom - 240
        // Dedup: reuse the existing calendar node (only one per canvas) + title it.
        openOrFocusCalendar({ x, y })
      }
    },
    {
      id: 'cmd:replay',
      title: t('palette.replay'),
      hint: 'Flight Recorder',
      icon: '⏵',
      keywords: 'replay reproducir mision flight recorder cronologia timeline pulse',
      run: () => {
        if (useMission.getState().events.length > 0) useReplay.getState().start()
      }
    },
    {
      id: 'cmd:brief',
      title: t('palette.brief'),
      hint: 'Mission Brief',
      icon: '🎯',
      keywords: 'brief resumen standup mision quien bloqueado bloqueo error digest insight inteligencia',
      run: () => {
        // Open the Mission Pulse panel (which now leads with the Brief). When
        // there is recorded activity, also speak the one-line standup through the
        // existing throttled narration queue.
        window.dispatchEvent(new CustomEvent('canvasio:open-mission'))
        if (useMission.getState().events.length > 0) {
          narrateBrief(briefHeadline(useMission.getState().getBrief()))
        }
      }
    },
    {
      id: 'cmd:chrono',
      title: t('palette.chrono'),
      hint: 'Chronoscope',
      icon: '⛓',
      keywords:
        'chronoscope chrono linea de tiempo timeline swimlane carril gantt cronologia paralelo who when quien cuando idle ocioso bloqueado relevo handoff flight recorder',
      run: () => window.dispatchEvent(new CustomEvent('canvasio:open-chrono'))
    },
    {
      id: 'cmd:timefold',
      title: t('palette.timefold'),
      hint: 'Timefold',
      icon: '⏳',
      keywords:
        'timefold time machine maquina del tiempo scrub rewind retroceder historial pasado momento instante congelar lienzo entero todas las ventanas ayer rebobinar session replay',
      run: () => useTimefold.getState().arm()
    },
    {
      id: 'cmd:cmdtrail',
      title: t('palette.cmdtrail'),
      hint: 'Command Trail',
      icon: '⌗',
      keywords:
        'command trail comando comandos ejecutados executed shell auditoria audit riesgo risk destructivo destructive rm force push reset re-ejecutar rerun historial registro que hizo accion',
      run: () => window.dispatchEvent(new CustomEvent('canvasio:open-cmdtrail'))
    },
    {
      id: 'cmd:lens',
      title: t('palette.lens'),
      hint: 'Agent Lens',
      icon: '👁',
      keywords: 'lens agent lens actividad live en vivo que hace ahora excerpt linea last line hud teclado keyboard',
      run: () => window.dispatchEvent(new CustomEvent('canvasio:open-lens'))
    },
    {
      id: 'cmd:changeset',
      title: t('palette.changeset'),
      hint: 'Changeset Lens',
      icon: '📝',
      keywords:
        'changeset cambios diff archivos files git review revisar adds dels lineas modificado teclado keyboard radar artefacto',
      run: () => window.dispatchEvent(new CustomEvent('canvasio:open-changeset'))
    },
    {
      id: 'cmd:catchup',
      title: t('palette.catchup'),
      hint: 'Catch-Up',
      icon: '↺',
      keywords:
        'catch up catchup ponerse al día novedades sin leer unread digest resumen desde la última vez que miré agente actividad standup teclado keyboard',
      run: () => window.dispatchEvent(new CustomEvent('canvasio:open-catchup'))
    },
    {
      id: 'cmd:changeset:most',
      title: t('palette.changeset_most'),
      hint: 'Changeset Lens',
      icon: '📝',
      keywords:
        'changeset cambios diff mas archivos files most changed ir volar camara triage agente git artefacto',
      run: () => {
        // Pick the terminal node with the most changed files (read-only over the
        // changeset store), then reuse the existing camera tween. No-op when no
        // agent has changes. Camera-only / existing-action-only.
        const byNode = useChangeset.getState().byNode
        const nodes = useCanvas.getState().nodes
        let bestId: string | null = null
        let bestCount = 0
        for (const n of nodes) {
          if (n.kind !== 'terminal') continue
          const c = byNode[n.id]?.files.length ?? 0
          if (c > bestCount) {
            bestCount = c
            bestId = n.id
          }
        }
        if (bestId) useCanvas.getState().centerOnNode(bestId)
      }
    },
    {
      id: 'cmd:backlog:peak',
      title: t('palette.backlog_peak'),
      hint: 'Backlog',
      icon: '•',
      keywords:
        'backlog sin ver unseen actividad pendiente atencion attention mas saltar ir volar camara agente leer lineas output novedades novedad que paso mientras',
      run: () => {
        // Read-only over visits + echo: resolve the agent with the most unseen
        // lines, then fly there via the existing tween (which zeroes its backlog).
        // No-op when nobody has unseen activity. Camera-only / existing-action-only.
        const peak = useBacklog.getState().peakNode()
        if (peak) useCanvas.getState().centerOnNode(peak)
      }
    },
    {
      id: 'cmd:checkpoint:list',
      title: t('palette.checkpoint_list'),
      hint: 'Checkpoints',
      icon: '🧊',
      keywords:
        'checkpoint checkpoints savepoint punto restauracion restaurar restore stash congelar freeze guardar estado lock git teclado keyboard',
      run: () => window.dispatchEvent(new CustomEvent('canvasio:open-checkpoints'))
    },
    {
      id: 'cmd:checkpoint:capture',
      title: t('palette.checkpoint_capture'),
      hint: 'Checkpoints',
      icon: '🧊',
      keywords:
        'checkpoint capturar capture savepoint congelar freeze guardar estado lock stash create git punto restauracion',
      run: () => {
        // Capture for the selected terminal (else the first terminal with a cwd),
        // then open the panel focused on it. Non-mutating `git stash create`.
        const cs = useCanvas.getState()
        const sel = cs.nodes.find((n) => n.id === cs.selectedId)
        const target =
          sel && sel.kind === 'terminal' && sel.cwd
            ? sel
            : cs.nodes.find((n) => n.kind === 'terminal' && !!n.cwd)
        if (target?.cwd) {
          const label = `${target.title} · ${new Date().toLocaleTimeString()}`
          void useCheckpoints.getState().captureFor(target.id, target.cwd, label)
        }
        window.dispatchEvent(
          new CustomEvent('canvasio:open-checkpoints', {
            detail: target ? { nodeId: target.id } : undefined
          })
        )
      }
    },
    {
      id: 'cmd:triage',
      title: t('palette.triage'),
      hint: 'Triage Jump',
      icon: '⏭',
      keywords:
        'triage jump attention atencion waiting te necesita next siguiente blocked bloqueado error prioridad cola inbox agente',
      run: () => useCanvas.getState().cycleAttention('next')
    },
    {
      id: 'cmd:reply',
      title: t('palette.reply'),
      hint: 'Reply Rail',
      icon: '⌨',
      keywords:
        'reply rail responder contestar agentes bloqueados blocked waiting te necesita y n yes no enter confirmar permiso prompt inbox bandeja teclado keyboard desbloquear unblock',
      run: () => window.dispatchEvent(new CustomEvent('canvasio:open-reply'))
    },
    {
      id: 'cmd:focus',
      title: t('palette.focus_mode'),
      hint: t('palette.camera'),
      icon: '◉',
      keywords: 'focus foco spotlight destacar resaltar agente dim atenuar lighthouse',
      run: () => useCanvas.getState().toggleFocusMode()
    },
    {
      id: 'cmd:thermal',
      title: t('palette.thermal_toggle'),
      hint: 'Thermal',
      icon: '🔥',
      keywords: 'thermal calor heat mapa actividad heatmap overlay glow brillo temperatura mas activo',
      run: () => useCanvas.getState().toggleThermal()
    },
    {
      id: 'cmd:conduits',
      title: t('palette.conduits_toggle'),
      hint: 'Relay',
      icon: '↝',
      keywords:
        'conduits conductos relay relevo handoff graph grafo edges aristas conexiones lineas flechas topologia pipeline flujo wire baton',
      run: () => useCanvas.getState().toggleConduits()
    },
    {
      id: 'cmd:thermal:hottest',
      title: t('palette.thermal_hottest'),
      hint: 'Thermal',
      icon: '🔥',
      keywords: 'thermal calor heat hottest mas activo ir volar camara atencion donde trabajo actividad',
      run: () => useCanvas.getState().flyToHottest()
    },
    {
      id: 'cmd:vigil',
      title: t('palette.vigil'),
      hint: 'Vigil',
      icon: '🛰️',
      keywords:
        'vigil follow cam seguir auto pilot autopilot camara manos libres lean back livestream director hottest mas activo activo siguiente swarm enjambre v',
      run: () => useCanvas.getState().toggleVigil()
    },
    {
      id: 'cmd:conductor:act',
      title: t('palette.conductor_act'),
      hint: 'Conductor',
      icon: '❯',
      keywords:
        'conductor next best action accion siguiente mejor que hago what should i do pilotar baton prescriptivo leverage prioridad ejecutar act',
      run: () => {
        const recs = useConductor.getState().getRecommendations()
        useConductor.getState().runAction(recs[0])
      }
    },
    {
      id: 'cmd:conductor:open',
      title: t('palette.conductor_open'),
      hint: 'Conductor',
      icon: '🎼',
      keywords:
        'conductor panel cola acciones ranked next best action lista prioridad pilotar abrir',
      run: () => window.dispatchEvent(new CustomEvent('canvasio:open-conductor'))
    },
    {
      id: 'cmd:horizon:goal',
      title: t('palette.horizon_goal'),
      hint: t('palette.horizon'),
      icon: '◠',
      keywords:
        'horizonte horizon objetivo mision goal fijar declarar meta swarm enjambre completar finalizar eta cuando termina forecast pronostico',
      run: () => window.dispatchEvent(new CustomEvent('canvasio:open-horizon'))
    },
    {
      id: 'cmd:horizon:standup',
      title: t('palette.horizon_standup'),
      hint: t('palette.horizon'),
      icon: '🌅',
      keywords:
        'horizonte horizon mision standup resumen swarm enjambre porcentaje completado eta cuando termina final pronostico forecast gating cuello marca el ritmo hablado voz',
      run: () => {
        // Open the panel and, when a goal is declared, speak the one-line forecast
        // through the existing throttled narration queue (mirrors the Brief standup).
        window.dispatchEvent(new CustomEvent('canvasio:open-horizon'))
        const f = useHorizon.getState().getForecast()
        if (!f.idle) {
          const eta = f.etaMs != null ? t('palette.horizon_eta', { eta: etaLabel(f.etaMs) }) : ''
          const gate = f.gatingTitle ? t('palette.horizon_gate', { title: f.gatingTitle }) : ''
          narrateBrief(t('palette.horizon_narration', { percent: f.percent, eta, gate }))
        }
      }
    },
    {
      id: 'cmd:voiceloop',
      title: useVoiceLoop.getState().armed
        ? t('palette.voiceloop_off')
        : t('palette.voiceloop_on'),
      hint: t('palette.voiceloop_hint'),
      icon: '🔁',
      keywords:
        'bucle de voz voice loop standup conversacional manos libres hands free pregunta bloqueante blocked question responder hablar voz agente unblock desbloquear conversacion eyes off respuesta hablada',
      run: () => {
        // Arm/disarm the hands-free Q&A loop. When armed, a detected blocking
        // question is spoken aloud and your next push-to-talk reply is routed
        // verbatim to the asking agent (consumed in useVoiceCapture). In-memory,
        // self-cancelling; mirrors the Stall Watch / standup command entries.
        useVoiceLoop.getState().toggle()
      }
    },
    {
      id: 'cmd:board',
      title: t('palette.board'),
      hint: 'Brief Board',
      icon: '📋',
      keywords:
        'brief board tablero contexto compartido shared context pool datos hallazgos fijar pin equipo team conocimiento memoria',
      run: () => window.dispatchEvent(new CustomEvent('canvasio:open-board'))
    },
    {
      id: 'cmd:board:pin',
      title: t('palette.board_pin'),
      hint: 'Brief Board',
      icon: '📌',
      keywords: 'pin fijar linea actual agente seleccionado lens excerpt brief board dato hallazgo',
      run: () => {
        // Pin the selected terminal's current Agent Lens line as a shared fact.
        const c = useCanvas.getState()
        const n = c.nodes.find((x) => x.id === c.selectedId && x.kind === 'terminal')
        if (!n) return
        const line = useLens.getState().lines[n.id]?.text
        if (!line) return
        useBoard
          .getState()
          .pin({ text: line, sourceNodeId: n.id, sourceTitle: n.title, agent: n.agent })
      }
    },
    {
      id: 'cmd:board:inject',
      title: t('palette.board_inject'),
      hint: 'Brief Board',
      icon: '📋',
      keywords:
        'inject inyectar board tablero contexto compartido agente seleccionado brief brief new agent equipo',
      run: () => {
        // Compose the board and deliver it to the selected agent via the proven
        // readiness-gated relay drain (enqueueForTarget -> deliverRelay).
        const c = useCanvas.getState()
        const n = c.nodes.find((x) => x.id === c.selectedId && x.kind === 'terminal')
        if (!n) return
        const block = formatBoardForInjection(useBoard.getState().facts)
        if (!block) return
        useRelay.getState().enqueueForTarget(n.id, block)
      }
    },
    {
      id: 'cmd:board:clear',
      title: t('palette.board_clear'),
      hint: 'Brief Board',
      icon: '🗑',
      keywords: 'clear vaciar limpiar board tablero contexto compartido datos reset',
      run: () => useBoard.getState().clearAll()
    },
    {
      id: 'cmd:recall:open',
      title: t('palette.recall_open'),
      hint: 'Recall',
      icon: '✦',
      keywords:
        'recall memoria persistente cross mission long term conocimiento recuerdos remember saber sabemos M',
      run: () => window.dispatchEvent(new CustomEvent('canvasio:open-recall'))
    },
    {
      id: 'cmd:recall:remember',
      title: t('palette.recall_remember'),
      hint: 'Recall',
      icon: '✦',
      keywords:
        'recordar remember corroborado consenso recall memoria persistente guardar acordado equipo',
      run: () => {
        // Promote every corroborated board fact into persisted Recall memory,
        // re-deriving the same consensus subject+value keys for dedup + matching.
        const facts = useBoard.getState().facts
        const consensus = analyzeConsensus(facts)
        for (const c of consensus.corroborated) {
          for (const fid of c.factIds) {
            const f = facts.find((x) => x.id === fid)
            if (!f) continue
            const subject = subjectKey(f.text) || undefined
            const value = subject ? assertedValue(f.text, subject) || undefined : undefined
            useRecall
              .getState()
              .remember({ text: f.text, subject, value, agent: f.agent, sourceTitle: f.sourceTitle })
          }
        }
      }
    },
    {
      id: 'cmd:recall:clear',
      title: t('palette.recall_clear'),
      hint: 'Recall',
      icon: '🗑',
      keywords: 'forget olvidar wipe clear recall memoria persistente borrar todo reset',
      run: () => useRecall.getState().clearAll()
    },
    {
      id: 'cmd:director',
      title: t('palette.director'),
      hint: t('palette.camera'),
      icon: '◎',
      keywords: 'director seguir en vivo live follow camera camara atencion broadcast',
      run: () => useDirector.getState().toggle()
    },
    {
      id: 'cmd:stall',
      title: t('palette.stall'),
      hint: t('palette.surveillance'),
      icon: '⚠',
      keywords:
        'stall watch vigilancia bloqueado blocked stuck atascado rescate rescue nudge watchdog waiting esperando error desbloquear unblock autonomo',
      run: () => useStall.getState().toggle()
    },
    {
      id: 'cmd:stall:auto',
      title: 'Stall Watch · auto-nudge',
      hint: t('palette.surveillance'),
      icon: '⚡',
      keywords:
        'stall watch auto nudge automatico rescate automatico bloqueado blocked desbloquear unblock autonomo board contexto',
      run: () => useStall.getState().toggleAutoNudge()
    },
    {
      id: 'cmd:awayAlerts',
      title: t('palette.away_alerts'),
      hint: t('palette.surveillance'),
      icon: '🔔',
      keywords:
        'away alerts avisos notificaciones notification dock badge contador sistema os native nativo fondo background unfocused desenfocado bloqueado waiting esperando error done terminado attention atencion',
      run: () => useAwayAlerts.getState().toggle()
    },
    {
      id: 'cmd:tripwire',
      title: t('palette.tripwire_manage'),
      hint: 'Tripwire',
      icon: '🎯',
      keywords:
        'tripwire disparadores avisos alertas patron pattern regex texto vigilar watch trigger content contenido salto jump teclado keyboard output salida linea',
      run: () => window.dispatchEvent(new CustomEvent('canvasio:open-tripwire'))
    },
    {
      id: 'cmd:tripwire:jump',
      title: t('palette.tripwire_jump'),
      hint: 'Tripwire',
      icon: '🎯',
      keywords:
        'tripwire saltar jump último aviso newest hit nuevo ir volar cámara agente disparador alerta unseen no visto',
      run: () => {
        const hit = useTripwire.getState().newestUnseen()
        if (hit) {
          useCanvas.getState().centerOnNode(hit.nodeId)
          useTripwire.getState().markSeen(hit.id)
        }
      }
    },
    {
      id: 'cmd:tripwire:clear',
      title: t('palette.tripwire_clear'),
      hint: 'Tripwire',
      icon: '🗑',
      keywords:
        'tripwire limpiar clear vaciar disparadores avisos hits reset borrar patrones todo',
      run: () => useTripwire.getState().clearAll()
    },
    {
      id: 'cmd:music:toggle',
      title: t('palette.music_toggle'),
      hint: t('palette.kind_music'),
      icon: '♪',
      keywords: 'music play pause toggle musica reproducir',
      run: () => useCanvas.getState().requestMusic('toggle')
    }
  )

  // ---- theme switch commands ----
  for (const th of THEMES) {
    cmds.push({
      id: `cmd:theme:${th.id}`,
      title: t('palette.theme', { name: th.name }),
      hint: t('palette.theme_group'),
      icon: '◐',
      keywords: `theme tema ${th.id} ${th.name}`,
      run: () => useCanvas.getState().setTheme(th.id)
    })
  }

  return cmds
}

/**
 * Echo Index — build fly-to rows from a content-search query. Each ranked hit
 * (useEcho.search) becomes a node-fly-to Command: the matched output LINE is the
 * title, the hint names the source agent + a relative timestamp, and peekId is
 * the source node (so Spyglass long-press preview works for free). run() reuses
 * the existing centerOnNode camera tween — full Slipstream/Wayback inherited.
 * Pure / read-only over the echo + canvas stores.
 */
function buildEchoCommands(query: string): Command[] {
  const q = query.trim()
  if (!q) return []
  const hits = useEcho.getState().search(q)
  if (hits.length === 0) return []
  const nodes = useCanvas.getState().nodes
  const byId = new Map(nodes.map((n) => [n.id, n] as const))
  const cmds: Command[] = []
  hits.forEach((hit, i) => {
    const n = byId.get(hit.nodeId)
    if (!n) return // node was closed since capture; skip stale hits.
    const source =
      n.kind === 'terminal' && n.agent ? AGENT_LABEL[n.agent].title : n.title
    cmds.push({
      id: `echo:${hit.nodeId}:${i}`,
      title: hit.text,
      hint: `${source} · ${formatAgo(hit.ts)}`,
      icon: '⌕',
      run: () => useCanvas.getState().centerOnNode(hit.nodeId),
      // Spyglass — long-press to preview the source node, then spring back.
      peekId: hit.nodeId
    })
  })
  return cmds
}

/**
 * Simple substring/fuzzy ranking. Empty query keeps the natural order (nodes
 * first). Otherwise scores by match quality: prefix > word-start > substring >
 * subsequence, against title and keywords.
 */
function rank(commands: Command[], query: string): Command[] {
  const q = query.trim().toLowerCase()
  if (!q) return commands
  const scored: { cmd: Command; score: number }[] = []
  for (const cmd of commands) {
    const title = cmd.title.toLowerCase()
    const hay = `${title} ${(cmd.keywords ?? '').toLowerCase()}`
    let score = -1
    if (title.startsWith(q)) score = 100
    else if (new RegExp(`\\b${escapeRe(q)}`).test(title)) score = 80
    else if (title.includes(q)) score = 60
    else if (hay.includes(q)) score = 40
    else if (subseq(q, hay)) score = 20
    if (score >= 0) {
      // shorter titles rank slightly higher on equal score (tighter match)
      scored.push({ cmd, score: score - title.length * 0.05 })
    }
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.map((s) => s.cmd)
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Wayback — compact "time ago" for a visit timestamp. */
function formatAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 5) return t('palette.ago_now')
  if (s < 60) return t('palette.ago_seconds', { n: s })
  const m = Math.round(s / 60)
  if (m < 60) return t('palette.ago_minutes', { n: m })
  const h = Math.round(m / 60)
  if (h < 24) return t('palette.ago_hours', { n: h })
  const d = Math.round(h / 24)
  return t('palette.ago_days', { n: d })
}

/** Wayback — pluralized visit count. */
function formatVisits(count: number): string {
  return count === 1 ? t('palette.visits_one') : t('palette.visits_many', { n: count })
}

/** Does `needle` appear as an ordered subsequence inside `hay`? */
function subseq(needle: string, hay: string): boolean {
  let i = 0
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (hay[j] === needle[i]) i++
  }
  return i === needle.length
}
