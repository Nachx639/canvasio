import { Component, useEffect, useState, type ReactNode } from 'react'
import { Background } from './components/Background'
import { Canvas } from './components/Canvas'
import { TopBar } from './components/TopBar'
import { Toolbar } from './components/Toolbar'
import { VoiceBar } from './components/VoiceBar'
import { VoiceBubbles } from './components/VoiceBubbles'
import { VoiceCompacting } from './components/VoiceCompacting'
import { VoiceProvider } from './hooks/VoiceContext'
import { ZoomControls } from './components/ZoomControls'
import { SlipstreamNav } from './components/SlipstreamNav'
import { Minimap } from './components/Minimap'
import { JumpHints } from './components/JumpHints'
import { PipelinePicker } from './components/PipelinePicker'
import { PulseRadar } from './components/PulseRadar'
import { SnapGuides } from './components/SnapGuides'
import { ThermalOverlay } from './components/ThermalOverlay'
import { PromptModal } from './components/PromptModal'
import { WaypointRail } from './components/WaypointRail'
import { Watchtower } from './components/Watchtower'
import { ConstellationFilter } from './components/ConstellationFilter'
import { ReplayBar } from './components/ReplayBar'
import { DirectorChip } from './components/DirectorChip'
import { TourBar } from './components/TourBar'
import { TimefoldBar } from './components/TimefoldBar'
import { useTimefold } from './store/timefold'
import { CollisionWatch } from './components/CollisionWatch'
import { FlightplanChip } from './components/FlightplanChip'
import { CriticalPathChip } from './components/CriticalPathChip'
import { TaskforcesChip } from './components/TaskforcesChip'
import { VigilChip } from './components/VigilChip'
import { SentinelChip } from './components/SentinelChip'
import { useSentinel } from './store/sentinel'
import { useLens } from './store/lens'
import { StallWatchToast } from './components/StallWatchToast'
import { ContextSyncToast } from './components/ContextSyncToast'
import { HistoryToast } from './components/HistoryToast'
import { TripwirePanel } from './components/TripwirePanel'
import { TripwireToast } from './components/TripwireToast'
import { useTripwire } from './store/tripwire'
import { CommandPalette } from './components/CommandPalette'
import { AgentLensHud } from './components/AgentLensHud'
import { ReplyRail } from './components/ReplyRail'
import { ChangesetLens } from './components/ChangesetLens'
import { CheckpointPanel } from './components/CheckpointPanel'
import { Chronoscope } from './components/Chronoscope'
import { CommandTrailPanel } from './components/CommandTrailPanel'
import { CatchUpPanel } from './components/CatchUpPanel'
import { BriefBoard } from './components/BriefBoard'
import { RecallPanel } from './components/RecallPanel'
import { Beacon } from './components/Beacon'
import { QuestionsPanel } from './components/QuestionsPanel'
import { AtlasOverview } from './components/AtlasOverview'
import { useCanvas } from './store/canvas'
import { useMission } from './store/mission'
import { useAwayAlerts } from './store/awayAlerts'
import { shouldNotify, alertKindOf } from './lib/awayAlerts'
import { useConductor } from './store/conductor'
import { useTour } from './store/tour'
import { useChangeset } from './store/changeset'
import { useCheckpoints } from './store/checkpoints'
import { useRegions } from './store/regions'
import { useDrawing } from './store/drawing'
import { useWorkspace, serializeActiveData, writeActiveCanvas } from './store/workspace'
import { TabBar } from './components/TabBar'
import { jumpToBacklogPeak } from './components/BacklogChip'
import { getTheme } from './lib/themes'
import { t, useT } from './store/i18n'

// Spyglass/voice de-confliction: plain Space is claimed by useVoiceCapture's
// push-to-talk whenever STT is available (it calls startRec on Space-not-in-a-
// field). To avoid a single Space press both peeking the camera AND starting a
// recording, the Spyglass peek bails when STT is present and lets voice own
// Space. Cached once at module scope so the always-on keydown listener (created
// in a [] effect) can read it synchronously without re-subscribing. Defaults to
// false (peek active) until capabilities resolve / when there is no STT.
let sttAvailable = false

// Atlas (Hold-O) hold-vs-tap timing. Module-scoped so the always-on keydown/keyup
// listeners (created in [] effects) read/write them synchronously without
// re-subscribing. `atlasDownAt` is the keydown timestamp of the current hold (0 =
// not holding); `atlasToggled` marks that a quick tap promoted Atlas to a sticky
// toggle, so the matching keyup must NOT close it.
let atlasDownAt = 0
let atlasToggled = false
let atlasIsOpen = false
const ATLAS_TAP_MS = 250

// Isolates the voice UI so a render error there (e.g. a provider-ordering
// mistake) is contained instead of unmounting the whole app — which would tear
// down the terminals/PTYs along with it.
class VoiceErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

export default function App(): JSX.Element {
  const tr = useT()
  const bootRecipe = useCanvas((s) => s.bootRecipe)
  const loadLayout = useCanvas((s) => s.loadLayout)
  const fitToView = useCanvas((s) => s.fitToView)

  // Boot + MIGRATION into the multi-canvas workspace. Runs once. The workspace
  // store owns "which named doc is live"; useCanvas stays the single source of
  // truth for the live canvas interior.
  //   1. refresh() the on-disk canvas list.
  //   2. No canvases yet AND a legacy canvasio:layout exists -> migrate it into a
  //      "Lienzo principal" doc (NO DATA LOSS; canvasio:layout is kept as backup).
  //   3. No canvases AND no legacy -> create an empty "Lienzo principal", then
  //      bootRecipe() to seed the first-run starter windows, then persist the
  //      booted state into the doc.
  //   4. Canvases exist -> open the most-recent as the active tab.
  useEffect(() => {
    let alive = true
    void (async () => {
      const ws = useWorkspace.getState()
      await ws.refresh()
      if (!alive) return
      const metas = useWorkspace.getState().canvases
      if (metas.length > 0) {
        // Open the most-recent (list is sorted updatedTs desc) as the active tab.
        await useWorkspace.getState().openCanvas(metas[0].id)
        return
      }
      // No canvases on disk. Try migrating a legacy single-canvas layout.
      let legacy: unknown = null
      try {
        const raw = localStorage.getItem('canvasio:layout')
        if (raw != null) legacy = JSON.parse(raw)
      } catch {
        legacy = null
      }
      if (legacy && typeof legacy === 'object') {
        const l = legacy as {
          nodes?: unknown[]
          waypoints?: unknown[]
          regions?: unknown[]
          stages?: unknown[]
        }
        let shapes: unknown[] = []
        try {
          const rawShapes = localStorage.getItem('canvasio:shapes')
          if (rawShapes) {
            const parsed = JSON.parse(rawShapes)
            if (Array.isArray(parsed)) shapes = parsed
          }
        } catch {
          shapes = []
        }
        const data = {
          nodes: Array.isArray(l.nodes) ? l.nodes : [],
          waypoints: Array.isArray(l.waypoints) ? l.waypoints : [],
          regions: Array.isArray(l.regions) ? l.regions : [],
          stages: Array.isArray(l.stages) ? l.stages : [],
          shapes
        }
        const id = await useWorkspace.getState().newCanvas(tr('app.main_canvas_name'))
        if (!alive) return
        // newCanvas created+activated an EMPTY doc + cleared the live stores; now
        // write the migrated data into that doc and load it live.
        try {
          await window.canvasio.canvases.write(id, {
            id,
            name: tr('app.main_canvas_name'),
            createdTs: Date.now(),
            updatedTs: Date.now(),
            schema: 1,
            data
          })
        } catch {
          /* best-effort */
        }
        // Load the migrated data into the live stores (loadLayout-or-clear path).
        if (data.nodes.length) loadLayout(data as never)
        else useCanvas.getState().clear()
        useDrawing.getState().setShapes(shapes as never[])
        return
      }
      // Truly first run: empty default canvas, then seed the recipe + persist it.
      const id = await useWorkspace.getState().newCanvas(tr('app.main_canvas_name'))
      if (!alive) return
      bootRecipe()
      // Persist the booted starter windows into the doc so they survive restart.
      try {
        await window.canvasio.canvases.write(id, {
          id,
          name: tr('app.main_canvas_name'),
          createdTs: Date.now(),
          updatedTs: Date.now(),
          schema: 1,
          data: serializeActiveData()
        })
      } catch {
        /* best-effort */
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // responsive: re-tile nodes into the frame on window resize (geometry-based,
  // keeps zoom at 1.0 so terminals stay crisp — no CSS upscaling/blur)
  const arrange = useCanvas((s) => s.arrange)
  useEffect(() => {
    let raf = 0
    const onResize = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        if (useCanvas.getState().autoFit) arrange()
      })
    }
    window.addEventListener('resize', onResize)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
    }
  }, [arrange])

  // persist layout (debounced) only when the NODES change — not on every
  // camera pan/zoom frame
  useEffect(() => {
    // Single source of truth for the serialize+write so the debounced path and
    // the synchronous flush can never diverge. Snapshots nodes + waypoints +
    // regions (all tiny pure data, safe to persist unlike transient flags) and
    // writes canvasio:layout synchronously. Strips transient runtime state before
    // persisting so a cold start never resurrects a stale 'working' status /
    // pending prompt and never marks restored nodes `fresh` (which would auto-run
    // their agent command). Always stamps booted:true so the load effect knows
    // this is not a first run even when the user has closed every window (and the
    // node set is empty) — preventing bootRecipe from re-spawning the starter
    // windows the user deliberately closed.
    // Multi-canvas: the ACTIVE canvas autosaves to ITS OWN file (not canvasio:layout).
    // We build the same node-stripped + waypoints/regions/stages snapshot as
    // before via serializeActiveData() (the shared App.tsx contract), now EXTENDED
    // with the drawing-layer shapes, and route it to the active doc. Skipped while
    // a canvas switch is in flight (isSwitching) so the bulk load mutations can't
    // persist a half-loaded snapshot. Fire-and-forget is fine for the debounced
    // path; switchTo() awaits its own save-out before loading.
    const writeNow = (sync = false): void => writeActiveCanvas(sync)
    // Flush: cancel any pending debounce and write immediately. `sync` uses the
    // SYNCHRONOUS canvases.writeSync (sendSync) so the doc reaches disk before the
    // renderer tears down on quit — a plain async invoke is NOT guaranteed to
    // complete during teardown, losing the last <=600ms of edits (audit #1).
    const flush = (sync = false): void => {
      clearTimeout((window as any).__canvasioSave)
      writeNow(sync)
    }
    // Debounced writer: coalesces frequent drag/resize/pan geometry edits.
    const save = (): void => {
      clearTimeout((window as any).__canvasioSave)
      ;(window as any).__canvasioSave = setTimeout(writeNow, 600)
    }
    let prevNodes = useCanvas.getState().nodes
    let prevWaypoints = useCanvas.getState().waypoints
    let prevStages = useCanvas.getState().stages
    const unsubCanvas = useCanvas.subscribe((s) => {
      // Persist when the nodes, the waypoints, OR the curated Stages change.
      if (s.nodes === prevNodes && s.waypoints === prevWaypoints && s.stages === prevStages)
        return
      // A DROP in node count means a window was closed (or several). Persist that
      // immediately instead of waiting out the debounce, so a closed window can
      // never be resurrected by a kill within the 600ms window. Ordinary edits
      // (add / geometry / waypoint / stage changes) keep the debounce.
      const closed = s.nodes.length < prevNodes.length
      prevNodes = s.nodes
      prevWaypoints = s.waypoints
      prevStages = s.stages
      if (closed) flush()
      else save()
    })
    // Districts — also persist when the region set changes (separate store).
    let prevRegions = useRegions.getState().regions
    const unsubRegions = useRegions.subscribe((s) => {
      if (s.regions === prevRegions) return
      prevRegions = s.regions
      save()
    })
    // Drawing layer — persist when the shapes change so post-its/rects/arrows/pen
    // edits land in the ACTIVE canvas file too (previously they only hit the
    // legacy canvasio:shapes mirror). drawing.ts keeps its own canvasio:shapes flush; this
    // adds the per-canvas-doc autosave on top. Skipped mid-switch via writeNow's
    // isSwitching guard (setShapes/clearShapes during a load fire this subscriber).
    let prevShapes = useDrawing.getState().shapes
    const unsubDrawing = useDrawing.subscribe((s) => {
      if (s.shapes === prevShapes) return
      prevShapes = s.shapes
      save()
    })
    // Quitting the app (or reloading) always persists the freshest layout, even
    // mid-debounce. We persist via the SYNCHRONOUS write (sendSync) so the active
    // canvas doc reaches disk before the renderer tears down. Listen on BOTH
    // beforeunload and pagehide (the reliable teardown event) — audit #1.
    const onQuit = (): void => flush(true)
    window.addEventListener('beforeunload', onQuit)
    window.addEventListener('pagehide', onQuit)
    return () => {
      unsubCanvas()
      unsubRegions()
      unsubDrawing()
      window.removeEventListener('beforeunload', onQuit)
      window.removeEventListener('pagehide', onQuit)
    }
  }, [])

  // reflect the active theme accent into a CSS variable for chrome accents
  const theme = useCanvas((s) => s.theme)
  useEffect(() => {
    document.documentElement.style.setProperty('--canvasio-accent', getTheme(theme).accent)
    // Drive the per-theme glass-token overrides via a [data-theme] CSS block
    // (index.css). Default themes set no override block → :root fallbacks apply →
    // glass is identical to today. Only "obsidian" (and any future glass theme)
    // declares an override block.
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  // warm voice models on launch
  useEffect(() => {
    window.canvasio?.voice.warm().catch(() => {})
  }, [])

  // Changeset Lens — poll the read-only git bridge for every terminal node that
  // has a cwd, writing each summary into the (memory-only) changeset store. Runs
  // every ~3.5s, but is SKIPPED entirely while the window/tab is hidden so a
  // backgrounded app spawns no git subprocesses. A re-entrancy guard prevents
  // overlapping sweeps if git is slow. Everything is additive + best-effort: any
  // failure resolves to null and the store simply clears that node's badge, so no
  // existing behavior can break. Reads nodes imperatively (getState) so it does
  // not re-run on every node move/resize.
  useEffect(() => {
    if (!window.canvasio?.git) return
    let busy = false
    const sweep = async (): Promise<void> => {
      if (busy) return
      if (typeof document !== 'undefined' && document.hidden) return
      busy = true
      try {
        const nodes = useCanvas.getState().nodes
        const set = useChangeset.getState().set
        const clearForNode = useChangeset.getState().clearForNode
        const refreshCheckpoints = useCheckpoints.getState().refresh
        for (const n of nodes) {
          if (n.kind !== 'terminal' || !n.cwd) continue
          try {
            const summary = await window.canvasio.git.status(n.cwd)
            if (summary) set(n.id, summary)
            else clearForNode(n.id)
          } catch {
            /* per-node best-effort; leave any existing summary untouched */
          }
          // Checkpoints persist in git refs (refs/canvasio/checkpoints), so they
          // survive restart even though the store is ephemeral. Re-list them live
          // here so a returning agent's chip repopulates and a freshly captured
          // savepoint always reflects the authoritative git state. Best-effort.
          try {
            await refreshCheckpoints(n.id, n.cwd)
          } catch {
            /* per-node best-effort; leave any existing checkpoint list untouched */
          }
        }
      } finally {
        busy = false
      }
    }
    // One sweep shortly after mount, then on the interval.
    const kickoff = window.setTimeout(() => void sweep(), 1200)
    const id = window.setInterval(() => void sweep(), 3500)
    return () => {
      window.clearTimeout(kickoff)
      window.clearInterval(id)
    }
  }, [])

  // Away Alerts — native OS notifications + dock badge for agents that need you.
  // CanvasIO has rich IN-WINDOW attention surfaces but ZERO native OS integration:
  // fire off several agents, alt-tab to your editor, and you never learn when one
  // finishes, errors, or goes `waiting` on your input. This watcher closes the loop.
  //
  // It subscribes to the live Mission Pulse feed (the exact useMission.subscribe
  // pattern stall.ts uses) and, when the window is AWAY (blurred or tab-hidden) AND
  // Away Alerts is enabled AND a NEW terminal event is a human-relevant transition
  // whose type is enabled, fires a debounced+coalesced native Notification via the
  // one-way notify:agent IPC channel. While focused it is SILENT, so it never nags
  // during active work. Click-to-focus flies the camera to the agent (centerOnNode)
  // and clears the badge. Self-cancelling teardown (unsub + removeEventListener +
  // clearTimeout) exactly like the effects above.
  useEffect(() => {
    if (!window.canvasio?.notify) return

    // Window-away gate. We start "away" from document.hidden so a launch into the
    // background is honored; focus/blur keep it live thereafter.
    let away = typeof document !== 'undefined' ? document.hidden : false
    const onFocus = (): void => {
      away = false
      // Returning to the app: clear the dock badge + any queued (not-yet-flushed)
      // pending alerts — you're here now, so there is nothing to chase.
      pending.clear()
      if (debounce != null) {
        window.clearTimeout(debounce)
        debounce = null
      }
      try {
        window.canvasio.notify.clearBadge()
      } catch {
        /* best-effort */
      }
    }
    const onBlur = (): void => {
      away = true
    }
    const onVisibility = (): void => {
      if (document.hidden) away = true
      else onFocus()
    }
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onVisibility)

    // Click-through from a notification: fly the camera to the agent via the
    // existing centerOnNode tween (selects + raises + Slipstream history), no IPC.
    const offFocusNode = window.canvasio.notify.onFocusNode((nodeId) => {
      try {
        if (nodeId) useCanvas.getState().centerOnNode(nodeId)
      } catch {
        /* best-effort camera fly */
      }
    })

    // Only react to events recorded AFTER mount; never replay the backlog into a
    // burst of notifications on launch. The high-water mark is the event count.
    let seen = useMission.getState().events.length
    // Coalesce a burst of transitions into ONE notification: collect the latest
    // notice + count over a short debounce window, then flush once.
    const pending = new Map<string, { title: string; body: string }>()
    let latestNodeId = ''
    let debounce: number | null = null

    const flush = (): void => {
      debounce = null
      if (!away || pending.size === 0) {
        pending.clear()
        return
      }
      const count = pending.size
      // The single notification: if one agent, name it precisely; if several,
      // summarize. Either way the click flies to the most-recent one.
      let notice: { title: string; body: string }
      if (count === 1) {
        notice = [...pending.values()][0]
      } else {
        notice = {
          title: t('app.alert_many_title', { count }),
          body: t('app.alert_many_body')
        }
      }
      try {
        window.canvasio.notify.agent({
          title: notice.title,
          body: notice.body,
          nodeId: latestNodeId,
          count
        })
      } catch {
        /* best-effort — never let a notification failure surface */
      }
      pending.clear()
    }

    const onMissionChange = (): void => {
      const events = useMission.getState().events
      if (events.length <= seen) {
        // Ring buffer trimmed (or no growth): just resync the mark, no replay.
        seen = events.length
        return
      }
      const fresh = events.slice(seen)
      seen = events.length
      // Silent while focused; preferences gate everything else (read live).
      if (!away) return
      const prefs = useAwayAlerts.getState()
      if (!prefs.enabled) return
      const nodes = useCanvas.getState().nodes
      for (const ev of fresh) {
        if (!alertKindOf(ev.kind)) continue
        // Only terminal (agent) nodes are human-relevant attention targets.
        const node = nodes.find((n) => n.id === ev.nodeId)
        if (node && node.kind !== 'terminal') continue
        const notice = shouldNotify({ kind: ev.kind, title: ev.title }, prefs)
        if (!notice) continue
        // Coalesce per node: the latest transition for a node wins.
        pending.set(ev.nodeId, notice)
        latestNodeId = ev.nodeId
      }
      if (pending.size > 0 && debounce == null) {
        debounce = window.setTimeout(flush, 400)
      }
    }

    const unsub = useMission.subscribe(onMissionChange)

    return () => {
      unsub()
      offFocusNode()
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibility)
      if (debounce != null) window.clearTimeout(debounce)
    }
  }, [])

  // Sentinel: the forward-looking standing-order ticker. Subscribes to the two
  // live substrates the orders are evaluated against — Mission Pulse transitions
  // (waiting/error/done) and Agent Lens lines (regex match) — and on any change
  // runs the PURE evaluator. Each NEWLY-firing order is marked fired (so it goes
  // quiet until re-armed) and, when its auto-fly is on, the camera flies straight
  // there via centerOnNode (Slipstream/Wayback for free). Camera-only on fire; no
  // IPC. A guard flag coalesces back-to-back substrate bursts so a single tick
  // can't double-fire the same order, exactly like the Away Alerts watcher.
  useEffect(() => {
    let inFlight = false
    const tick = (): void => {
      if (inFlight) return
      inFlight = true
      try {
        const sentinel = useSentinel.getState()
        if (sentinel.orders.length === 0) return
        // Prune orders for any node that no longer exists before evaluating, so a
        // fired jump can never target a gone node.
        const live = new Set(useCanvas.getState().nodes.map((n) => n.id))
        sentinel.pruneFor(live)
        const fired = useSentinel.getState().evaluate()
        if (fired.length === 0) return
        const orders = useSentinel.getState().orders
        // Auto-fly to at most one node per tick (the first fired with autoFly) so
        // a burst that trips several orders doesn't yank the camera in a war.
        let flew = false
        for (const id of fired) {
          useSentinel.getState().markFired(id)
          const order = orders.find((o) => o.id === id)
          if (!flew && order?.autoFly) {
            useCanvas.getState().centerOnNode(order.nodeId)
            flew = true
          }
        }
      } finally {
        inFlight = false
      }
    }
    const unsubMission = useMission.subscribe(tick)
    const unsubLens = useLens.subscribe(tick)
    return () => {
      unsubMission()
      unsubLens()
    }
  }, [])

  // Beacon: global ⌘K / Ctrl+K opens the command palette. Guard against firing
  // while the user is typing in an input/textarea/contentEditable (e.g. xterm),
  // mirroring the `typing` check in Canvas.tsx onKey.
  const [paletteOpen, setPaletteOpen] = useState(false)
  // Atlas — Hold-O Spatial Overview (Exposé for the canvas). Memory-only runtime
  // flag (never persisted). Opened from the Lighthouse keydown effect below
  // (plain 'O', same typing/xterm + no-modifier guard); HOLD peeks while held,
  // TAP promotes it to a sticky toggle. AtlasOverview owns its own key handling
  // (ace-jump letters / Esc) once open and closes via this setter.
  const [atlasOpen, setAtlasOpen] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        const t = e.target as HTMLElement | null
        const typing =
          t &&
          (t.tagName === 'INPUT' ||
            t.tagName === 'TEXTAREA' ||
            t.isContentEditable ||
            t.tagName === 'SELECT')
        // Always allow the shortcut even while typing in our own palette input —
        // ⌘K then toggles it closed. Block it only for OTHER text inputs.
        if (typing && !t?.closest?.('.beacon')) return
        e.preventDefault()
        setPaletteOpen((v) => !v)
        return
      }
      // Waypoints — ⌘/Ctrl+S captures the current camera as a saved view; Stages —
      // ⌘/Ctrl+⇧S captures the current working set (selection, else the open
      // Constellation Filter matches) as a named scene. (Neither chord does
      // anything in-app otherwise, so there's no conflict; preventDefault
      // suppresses the browser "Save page" dialog.) Same typing guard so neither
      // fires while editing a text input/xterm.
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        const t = e.target as HTMLElement | null
        const typing =
          !!t &&
          (t.tagName === 'INPUT' ||
            t.tagName === 'TEXTAREA' ||
            t.isContentEditable ||
            t.tagName === 'SELECT' ||
            !!t.closest?.('.terminal-overlays') ||
            !!t.closest?.('.xterm'))
        if (typing) return
        e.preventDefault()
        if (e.shiftKey) useCanvas.getState().captureStage()
        else useCanvas.getState().saveWaypoint()
        return
      }
      // Stages — ⌘/Ctrl+⇧1..9 activate the Nth saved scene (frame its members +
      // spotlight the subset, dim the rest). ⌘/Ctrl alone is reserved for OS/
      // browser shortcuts, so we require Shift to claim these digit chords. No-op
      // when that slot doesn't exist. Same typing guard as the chords above.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.code >= 'Digit1' && e.code <= 'Digit9') {
        const t = e.target as HTMLElement | null
        const typing =
          !!t &&
          (t.tagName === 'INPUT' ||
            t.tagName === 'TEXTAREA' ||
            t.isContentEditable ||
            t.tagName === 'SELECT' ||
            !!t.closest?.('.terminal-overlays') ||
            !!t.closest?.('.xterm'))
        if (typing) return
        const idx = Number(e.code.slice('Digit'.length)) - 1
        const st = useCanvas.getState().stages[idx]
        if (st) {
          e.preventDefault()
          useCanvas.getState().activateStage(st.id)
        }
        return
      }
      // Changeset Lens — ⌘/Ctrl+D toggles the per-agent file-change review panel.
      // Same typing/xterm guard; preventDefault suppresses the browser bookmark
      // dialog. The panel owns its own ↑↓/Enter/Esc handling once open.
      if ((e.metaKey || e.ctrlKey) && (e.key === 'd' || e.key === 'D')) {
        const t = e.target as HTMLElement | null
        const typing =
          !!t &&
          (t.tagName === 'INPUT' ||
            t.tagName === 'TEXTAREA' ||
            t.isContentEditable ||
            t.tagName === 'SELECT' ||
            !!t.closest?.('.terminal-overlays') ||
            !!t.closest?.('.xterm'))
        if (typing) return
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('canvasio:open-changeset'))
        return
      }
      // Catch-Up — ⌘/Ctrl+U toggles the per-agent "what happened since you last
      // looked" unread digest. Same typing/xterm guard as ⌘D; preventDefault
      // suppresses the browser view-source shortcut. The panel owns its own
      // j/k/Enter/m/Esc handling once open.
      if ((e.metaKey || e.ctrlKey) && (e.key === 'u' || e.key === 'U')) {
        const t = e.target as HTMLElement | null
        const typing =
          !!t &&
          (t.tagName === 'INPUT' ||
            t.tagName === 'TEXTAREA' ||
            t.isContentEditable ||
            t.tagName === 'SELECT' ||
            !!t.closest?.('.terminal-overlays') ||
            !!t.closest?.('.xterm'))
        if (typing) return
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('canvasio:open-catchup'))
        return
      }
      // Beacon — ⌘/Ctrl+⇧F opens the full-text scrollback search overlay (content
      // search across every live terminal). Checked BEFORE the plain ⌘F filter so
      // the Shift variant doesn't fall through to it. Same typing/xterm guard as the
      // other modifier shortcuts; preventDefault suppresses any browser default.
      // Toggle: ⌘⇧F while open closes it (Esc inside the panel also closes).
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
        const t = e.target as HTMLElement | null
        const typing =
          !!t &&
          (t.tagName === 'INPUT' ||
            t.tagName === 'TEXTAREA' ||
            t.isContentEditable ||
            t.tagName === 'SELECT' ||
            !!t.closest?.('.terminal-overlays') ||
            !!t.closest?.('.xterm'))
        // Allow the toggle while focused in Beacon's OWN field; block other inputs.
        if (typing && !t?.closest?.('.beacon-overlay')) return
        e.preventDefault()
        const s = useCanvas.getState()
        if (s.beaconOpen) s.closeBeacon()
        else s.openBeacon()
        return
      }
      // Constellation Filter — ⌘/Ctrl+F opens the live in-canvas search pill
      // (alongside the plain '/' shortcut below). Same typing/xterm guard;
      // preventDefault suppresses the browser in-page find. Opening sets the
      // query to '' (pill visible, every node matched); the component owns its
      // own input + Enter/Escape once open. No-op toggle-close is intentional:
      // ⌘F while open just refocuses (the field is already mounted).
      if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
        const t = e.target as HTMLElement | null
        const typing =
          !!t &&
          (t.tagName === 'INPUT' ||
            t.tagName === 'TEXTAREA' ||
            t.isContentEditable ||
            t.tagName === 'SELECT' ||
            !!t.closest?.('.terminal-overlays') ||
            !!t.closest?.('.xterm'))
        // Allow ⌘F while typing in our OWN filter input (refocus); block for
        // other text inputs/xterm.
        if (typing && !t?.closest?.('.constellation-filter')) return
        e.preventDefault()
        if (useCanvas.getState().filterQuery == null) useCanvas.getState().setFilter('')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Lighthouse — keyboard spatial navigation + spotlight focus mode. Uses the
  // SAME typing guard as ⌘K so xterm/input typing is never hijacked. All paths
  // call camera-only store actions (no IPC, no geometry mutation):
  //   Alt+Arrow → directional hop to the nearest neighbor in that direction
  //   Tab / Shift+Tab → cycle the active node in reading order (wraps)
  //   F → toggle spotlight focus mode (dim every other node)
  //   Esc → release spotlight focus mode if it's on
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      const typing =
        !!t &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.isContentEditable ||
          t.tagName === 'SELECT' ||
          // xterm renders into a .terminal container; never steal its keys.
          !!t.closest?.('.terminal-overlays') ||
          !!t.closest?.('.xterm'))
      if (typing) return
      // Don't compete with browser/OS shortcuts that hold ⌘/Ctrl.
      if (e.metaKey || e.ctrlKey) return
      const s = useCanvas.getState()

      if (e.altKey && e.key.startsWith('Arrow')) {
        e.preventDefault()
        if (e.key === 'ArrowUp') s.focusDirection('up')
        else if (e.key === 'ArrowDown') s.focusDirection('down')
        else if (e.key === 'ArrowLeft') s.focusDirection('left')
        else if (e.key === 'ArrowRight') s.focusDirection('right')
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        s.cycleNode(e.shiftKey ? -1 : 1)
        return
      }
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault()
        s.toggleFocusMode()
        return
      }
      // Constellation Filter — plain '/' opens the live in-canvas search pill
      // (same surface as ⌘F). Opening sets the query to '' so the pill appears
      // with every node matched; the component owns its own input + Enter/Escape
      // once open. Renderer/camera-only. Same typing + no-modifier guard already
      // in scope as the other plain-key shortcuts above.
      if (e.key === '/') {
        e.preventDefault()
        if (s.filterQuery == null) s.setFilter('')
        return
      }
      // Thermal — 'T' toggles the Activity Heat overlay; Shift+T flies the camera
      // to the single most-active node right now. Both are renderer/camera-only
      // (no IPC, no geometry mutation), matching the surrounding plain-key cases.
      if (e.key === 't' || e.key === 'T') {
        e.preventDefault()
        if (e.shiftKey) s.flyToHottest()
        else s.toggleThermal()
        return
      }
      // Vigil — 'V' toggles the Live Follow-Cam auto-pilot: the camera becomes a
      // hands-free pilot that gently flies to whichever node is hottest RIGHT NOW
      // (reusing the SAME computeHeat the Thermal overlay uses) and re-targets on
      // its own. The live, forward-looking twin of Flight Recorder Replay. Camera-
      // only (no IPC, no geometry mutation), matching the surrounding plain-key
      // cases. 'v' is otherwise unbound in the canvas shortcut map.
      if (e.key === 'v' || e.key === 'V') {
        e.preventDefault()
        s.toggleVigil()
        return
      }
      // Relay Conduits — 'E' (edges) toggles the in-world handoff-graph overlay
      // (the curved arrows between relayed agents) AND the matching minimap edges.
      // Renderer-only (no IPC, no geometry mutation); the layer itself renders
      // nothing when there are zero relay rules. Same typing + no-modifier guard
      // already in scope as the surrounding plain-key cases.
      if (e.key === 'e' || e.key === 'E') {
        e.preventDefault()
        s.toggleConduits()
        return
      }
      // Agent Lens HUD — 'L' toggles the keyboard-first live-activity panel.
      // Same typing/xterm guard as the other plain-key shortcuts above. The HUD
      // owns its own ↑/↓/Enter/Esc handling (in capture phase) once open.
      if (e.key === 'l' || e.key === 'L') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('canvasio:open-lens'))
        return
      }
      // Changeset Lens — plain 'D' also toggles the file-change review panel
      // (same surface as ⌘D), matching the L/open-lens plain-key wiring. The
      // panel owns its own ↑/↓/Enter/O/C/G/Esc handling (capture phase) once open.
      if (e.key === 'd' || e.key === 'D') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('canvasio:open-changeset'))
        return
      }
      // Checkpoints — plain 'K' captures a restorable savepoint for the focused/
      // selected terminal agent (non-mutating `git stash create`) AND opens the
      // Checkpoint Panel focused on it. The first WRITE-capable quick-action,
      // closing the Changeset Lens "review -> now act" loop. Restore (the only
      // mutation) is gated behind the Doctor's confirm modal from inside the
      // panel. If the panel is already open it owns 'K' (capture-phase) and this
      // never fires. Bail while the Beacon palette owns the keyboard (mirrors the
      // C/Chronoscope + W/Tripwire guards). Same typing/no-modifier guard above.
      if (e.key === 'k' || e.key === 'K') {
        if (document.querySelector('.beacon-backdrop')) return
        if (document.querySelector('[data-overlay="checkpoints"]')) return
        e.preventDefault()
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
        // Open the panel (focused on the captured/target agent) so the new
        // savepoint is immediately visible and inspectable.
        window.dispatchEvent(
          new CustomEvent('canvasio:open-checkpoints', {
            detail: target ? { nodeId: target.id } : undefined
          })
        )
        return
      }
      // Brief Board — plain 'B' toggles the shared-context pool panel, matching
      // the L/open-lens + D/open-changeset plain-key wiring. The panel owns its
      // own Esc handling (capture phase) once open.
      if (e.key === 'b' || e.key === 'B') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('canvasio:open-board'))
        return
      }
      // Recall — plain 'M' (memory) toggles the persisted Cross-Mission memory
      // panel, matching the B/open-board plain-key wiring. The panel owns its own
      // Esc handling (capture phase) once open.
      if (e.key === 'm' || e.key === 'M') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('canvasio:open-recall'))
        return
      }
      // Grand Tour — plain 'P' ("present"/"play") toggles the hands-free, looping
      // Waypoint presentation: the camera flies saved view -> saved view, dwelling
      // a few seconds at each, then loops. Camera-only (funnels through goWaypoint's
      // eased tween); no-op when there are <2 saved Waypoints. The tour store defers
      // to Replay/Director and stops itself the moment the user pans/zooms. Same
      // typing/no-modifier guard already in scope; bail while the Beacon palette owns
      // the keyboard (mirrors the C/W/K guards).
      if (e.key === 'p' || e.key === 'P') {
        if (document.querySelector('.beacon-backdrop')) return
        e.preventDefault()
        useTour.getState().toggle()
        return
      }
      // Chronoscope — plain 'C' toggles the per-agent swimlane timeline (a Gantt
      // of the work session reconstructed from the Mission Pulse flight recorder).
      // Same typing/no-modifier guard already in scope; the panel owns its own
      // ↑/↓/Enter/P/Esc handling (capture phase) once open. Yield to the Changeset
      // Lens while it's open since it claims 'C' for copy-path, so one 'C' press
      // never both copies a path AND toggles Chronoscope (mirrors the 'O'/Atlas
      // yield to the changeset overlay). Also bail while the Beacon palette owns
      // the keyboard (mirrors the ';' / 'O' guards).
      if (e.key === 'c' || e.key === 'C') {
        if (document.querySelector('.beacon-backdrop')) return
        if (document.querySelector('[data-overlay="changeset"]')) return
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('canvasio:open-chrono'))
        return
      }
      // Timefold — plain 'Y' ("ayer"/yesterday) toggles the Canvas Time Machine:
      // a bottom-edge scrubber that rewinds the ENTIRE canvas to any past wall-
      // clock instant, freezing every terminal's as-of-T status + last output line
      // in place at once (the spatial, all-nodes counterpart to the one-camera
      // Replay). Reconstruction is read-only over the existing Echo + Mission
      // substrates; camera moves (framePast) funnel through centerOnBounds. No-op
      // when nothing is recorded yet. The TimefoldBar owns its own ←/→/Esc handling
      // (capture phase) once armed. Same typing/no-modifier guard already in scope;
      // bail while the Beacon palette owns the keyboard (mirrors the C/W/K guards).
      if (e.key === 'y' || e.key === 'Y') {
        if (document.querySelector('.beacon-backdrop')) return
        e.preventDefault()
        useTimefold.getState().toggle()
        return
      }
      // Flow Layout — plain 'G' ("graph") arranges nodes into left-to-right
      // pipeline columns derived from the Agent Relay handoff DAG. Same
      // camera+geometry one-shot as arrange() (which it falls back to when there
      // is no relay graph); renderer-only, no IPC. Same typing + no-modifier
      // guard already in scope as the other plain-key shortcuts above.
      if (e.key === 'g' || e.key === 'G') {
        e.preventDefault()
        // Declutter — ⇧G is a layout-PRESERVING micro-reflow: it pushes apart ONLY
        // the nodes that actually overlap (e.g. after dragging windows onto each
        // other or a spawnCrew/Pipeline programmatic drop), leaving every other
        // node exactly where it is and the camera completely still. It's the
        // counterpart to plain-G flowLayout's full re-grid: a one-key, single-undo
        // "tidy up without reorganizing". Renderer-only, no IPC; no-op when nothing
        // overlaps. Plain G stays flowLayout (the Relay-DAG pipeline arrange).
        if (e.shiftKey) s.declutter()
        else s.flowLayout()
        return
      }
      // Triage Jump — plain 'J' flies the camera to the NEXT agent that needs you
      // in priority order (error > "te necesita" > done; oldest-first within a
      // tier, wrapping); Shift+J goes to the PREVIOUS. Camera-only (funnels through
      // centerOnNode -> selects + raises + Slipstream history), no IPC. Same typing
      // + no-modifier guard already in scope as the other plain-key shortcuts.
      if (e.key === 'j' || e.key === 'J') {
        e.preventDefault()
        s.cycleAttention(e.shiftKey ? 'prev' : 'next')
        return
      }
      // The Conductor — plain 'A' ("act") EXECUTES the single highest-leverage
      // next-best-action right now (runAction on the head of the ranked queue);
      // ⇧A opens the ranked Conductor panel. This is the prescriptive counterpart
      // to Triage's 'J' (which only marches the camera): the Conductor reasons
      // across every intelligence surface and does the one thing most worth doing.
      // runAction routes only through existing store actions (centerOnNode /
      // cycleAttention / open the relevant lens) — no IPC, no geometry mutation.
      // Same typing + no-modifier guard already in scope as the other plain keys.
      if (e.key === 'a' || e.key === 'A') {
        e.preventDefault()
        if (e.shiftKey) {
          window.dispatchEvent(new CustomEvent('canvasio:open-conductor'))
        } else {
          const recs = useConductor.getState().getRecommendations()
          useConductor.getState().runAction(recs[0])
        }
        return
      }
      // Reply Rail — plain 'R' toggles the keyboard-first "needs-you" inbox that
      // lists every agent blocked on a confirmation prompt and lets you answer in
      // place (y/n/Enter/free-text) without moving the camera. Renderer-only here
      // (just dispatches the event); the HUD owns its own ↑/↓/Y/N/Enter/G/Esc
      // handling (capture phase) once open. Same typing/no-modifier guard above.
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('canvasio:open-reply'))
        return
      }
      // Tripwire — plain 'W' opens the keyboard-first watch-list manager (add/arm/
      // disarm content-triggered alerts + the recent hit feed); ⇧W flies the camera
      // to the newest UNSEEN hit (via centerOnNode, marking it seen). The panel owns
      // its own ↑/↓/Enter/Esc handling (capture phase) once open. Renderer/camera-
      // only here. Same typing/no-modifier guard already in scope; bail while the
      // Beacon palette owns the keyboard (mirrors the C/Chronoscope guard).
      if (e.key === 'w' || e.key === 'W') {
        if (document.querySelector('.beacon-backdrop')) return
        e.preventDefault()
        if (e.shiftKey) {
          const hit = useTripwire.getState().newestUnseen()
          if (hit) {
            useCanvas.getState().centerOnNode(hit.nodeId)
            useTripwire.getState().markSeen(hit.id)
          }
        } else {
          window.dispatchEvent(new CustomEvent('canvasio:open-tripwire'))
        }
        return
      }
      // Command Trail — plain 'X' toggles the executed-command audit timeline:
      // the unified, risk-tagged, color-coded record of every shell command each
      // agent actually RAN (captured at the same flush chokepoint that feeds Lens/
      // Echo/Tripwire). The panel owns its own ↑↓/j/k/Enter/Esc + copy/re-run
      // handling (capture phase) once open. Renderer-only here (just dispatches the
      // event; re-run writes via the existing pty.write bridge from inside the
      // panel). Same typing/no-modifier guard already in scope; bail while the
      // Beacon palette owns the keyboard (mirrors the C/W/K guards).
      if (e.key === 'x' || e.key === 'X') {
        if (document.querySelector('.beacon-backdrop')) return
        e.preventDefault()
        window.dispatchEvent(new CustomEvent('canvasio:open-cmdtrail'))
        return
      }
      // Jump Hints — plain ';' toggles ace-jump teleport mode: every node sprouts
      // a tiny screen-space label badge; typing the label flies the camera there
      // (two keystrokes, zero pointer travel). Renderer-only here (just flips the
      // transient flag); JumpHints owns its own key handling + the teleport (via
      // centerOnNode) once active. Same typing/no-modifier guard already in scope
      // as the other plain-key shortcuts. Bail while the Beacon palette is open so
      // we never double-claim keys with an overlay that owns the keyboard.
      if (e.key === ';') {
        if (document.querySelector('.beacon-backdrop')) return
        e.preventDefault()
        s.toggleJumpMode()
        return
      }
      // Slipstream Pipeline Walk — plain 'n' flies one hop DOWNSTREAM along the
      // Agent Relay handoff graph (the agent the current one feeds) and 'u' flies
      // UPSTREAM (the agent that feeds it), tracing the actual pipeline hop by hop.
      // A single partner is a direct centerOnNode tween (full Slipstream/Wayback
      // participation); multiple partners raise the PipelinePicker branch overlay
      // (which then owns the keyboard for its one-keystroke choice). Renderer/
      // camera-only here — no IPC, no geometry mutation. Same typing/no-modifier
      // guard already in scope. Bail while the Beacon palette owns the keyboard
      // (mirrors the ';' / 'O' guards) so we never double-claim keys.
      if (e.key === 'n' || e.key === 'N') {
        if (document.querySelector('.beacon-backdrop')) return
        e.preventDefault()
        s.walkPipeline('down')
        return
      }
      if (e.key === 'u' || e.key === 'U') {
        if (document.querySelector('.beacon-backdrop')) return
        e.preventDefault()
        s.walkPipeline('up')
        return
      }
      // Atlas — Hold-O Spatial Overview (Exposé for the canvas). Press/hold 'O'
      // to reframe the whole workspace as a grid of large, readable, live tiles;
      // type a tile's ace-jump letter (or click) to fly there; release/Esc
      // without picking leaves the camera exactly where it was. Hold-to-peek vs
      // tap-to-toggle: keydown opens + stamps the hold start; the keyup effect
      // closes a quick-release UNLESS a tap (<250ms) promoted it to a sticky
      // toggle. Renderer-only here (flips a transient flag); AtlasOverview owns
      // its own key handling (ace-jump letters / Esc) once open. Same typing +
      // no-modifier guard already in scope. Bail while the Beacon palette is open
      // so we never double-claim keys with an overlay that owns the keyboard
      // (mirrors the ';' JumpHints guard).
      if (e.key === 'o' || e.key === 'O') {
        if (document.querySelector('.beacon-backdrop')) return
        // The Changeset Lens panel ('D') claims 'O' for reveal-file while open;
        // yield to it so one 'O' press never both reveals a file AND opens Atlas.
        if (document.querySelector('[data-overlay="changeset"]')) return
        e.preventDefault()
        // Pressing 'O' while it's already open toggles it closed. (Read the
        // module mirror, not the stale closure of atlasOpen captured by this
        // []-deps effect.)
        if (atlasIsOpen) {
          atlasDownAt = 0
          atlasToggled = false
          setAtlasOpen(false)
          return
        }
        if (e.repeat) return // key auto-repeat: don't restart the hold timer
        atlasDownAt = Date.now()
        atlasToggled = false
        setAtlasOpen(true)
        return
      }
      // Grand Tour — Escape stops a running presentation first (before peek/focus/
      // stage Escapes below), so one Esc always reliably ends the hands-free tour.
      if (e.key === 'Escape' && useTour.getState().armed) {
        e.preventDefault()
        useTour.getState().stop()
        return
      }
      // Vigil — Escape also stops the Live Follow-Cam auto-pilot (a hands-free
      // camera mode like the Tour), so one consistent Esc always releases the
      // self-driving camera. Pure flag/timer stop, geometry untouched.
      if (e.key === 'Escape' && s.vigilOn) {
        e.preventDefault()
        s.toggleVigil()
        return
      }
      // Pipeline Walk — Escape also dismisses a pending relay-graph branch choice
      // (a safety net; PipelinePicker's own capture-phase listener normally clears
      // it first, but this guarantees one Esc can never leave the branch flag set
      // if focus moved away from the overlay). Camera untouched, pure flag clear.
      if (e.key === 'Escape' && s.pipelinePick != null) {
        e.preventDefault()
        s.clearPipelinePick()
        return
      }
      // Spyglass — Escape also aborts an in-flight peek (springs back), so a peek
      // can never get "stuck" if a keyup is missed (e.g. focus moved to xterm).
      if (e.key === 'Escape' && s.peekNodeId != null) {
        e.preventDefault()
        s.endPeek()
        return
      }
      if (e.key === 'Escape' && s.focusNodeId != null) {
        e.preventDefault()
        s.setFocusMode(false)
        return
      }
      // Stages — Escape also releases an active scene's spotlight isolation (after
      // the higher-priority peek/focus Escapes above, so one Esc clears the
      // topmost isolation only). Pure flag, camera untouched.
      if (e.key === 'Escape' && s.stageIds != null) {
        e.preventDefault()
        s.clearStage()
        return
      }
      // Spyglass — hold Space to peek the most relevant node (selected, else
      // nearest scene-center), springing the camera there transiently. The
      // matching keyup (separate effect below) springs it back. Camera-only and
      // non-committing: it pushes NO Slipstream history and leaves selection /
      // focus mode untouched. Guard against key auto-repeat and against starting
      // a second peek while one is already in flight.
      if (e.code === 'Space' && !e.altKey && !e.shiftKey) {
        // De-conflict with voice push-to-talk: when STT is available,
        // useVoiceCapture owns plain Space (start/stop recording), so the peek
        // yields to avoid firing both on one press. With no STT, voice's Space
        // handler is a no-op, so the peek keeps Space to itself as before.
        if (sttAvailable) return
        if (e.repeat) {
          e.preventDefault()
          return
        }
        if (s.peekNodeId != null) {
          e.preventDefault()
          return
        }
        e.preventDefault()
        s.peekAt(s.peekTargetId())
        return
      }
      // Slipstream — plain [ / ] fly the camera Back / Forward through the
      // navigation history (browser-style). Both are camera-only no-ops when
      // there's nothing in that direction. Placed before the 1..9 waypoint block.
      if (e.key === '[') {
        e.preventDefault()
        s.cameraBack()
        return
      }
      if (e.key === ']') {
        e.preventDefault()
        s.cameraForward()
        return
      }
      // Wayback — plain backtick (`) is alt-tab for the canvas: instantly fly to
      // the PREVIOUS visited node (the second of your two most-recent), so you can
      // ping-pong between an agent and the file/preview it's editing. Camera-only
      // (funnels through centerOnNode), no-op with <2 distinct visited nodes. Same
      // typing + no-modifier guard already in scope as the other plain-key cases.
      if (e.key === '`') {
        e.preventDefault()
        s.quickSwitch()
        return
      }
      // Waypoints — plain 1..9 (no modifier; meta/ctrl already returned above)
      // teleport to the Nth saved view. No-op when that slot doesn't exist.
      if (e.key >= '1' && e.key <= '9') {
        const idx = Number(e.key) - 1
        const wp = s.waypoints[idx]
        if (wp) {
          e.preventDefault()
          s.goWaypoint(wp.id)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Backlog — capture-phase '.' (period) flies the camera to the agent with the
  // most UNSEEN activity (meaningful Echo lines produced since you last looked at
  // it), the keyboard-first triage loop for productive agents racing ahead while
  // you're heads-down elsewhere. The Triage 'J' jump only marches to agents that
  // NEED you (waiting/error/done); this complements it by jumping to the one that
  // produced the most you haven't read. Camera-only (centerOnNode bumps lastTs,
  // zeroing that node's backlog), so it can never regress the STABLE+ state.
  //
  // Registered in CAPTURE phase (mirroring ChangesetLens / Chronoscope) so the
  // dedicated handler always sees the key first, and gated behind the SettingsPanel
  // flag ('canvasio:backlog', default ON when unset) just like cmdtrail/harvest.
  // Same typing/xterm guard + no-⌘/Ctrl guard + beacon-backdrop guard as the plain
  // keys above so it never steals input from a focused field, overlay, or palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== '.') return
      // Off switch: only 'off' disables it (default ON), mirroring TerminalOverlay.
      try {
        if (localStorage.getItem('canvasio:backlog') === 'off') return
      } catch {
        /* localStorage unavailable — treat as ON */
      }
      const t = e.target as HTMLElement | null
      const typing =
        !!t &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.isContentEditable ||
          t.tagName === 'SELECT' ||
          !!t.closest?.('.terminal-overlays') ||
          !!t.closest?.('.xterm'))
      if (typing) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      // Yield while the Beacon palette owns the keyboard (mirrors the C/W/K guards).
      if (document.querySelector('.beacon-backdrop')) return
      e.preventDefault()
      jumpToBacklogPeak()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // Resolve once whether speech-to-text is available so the Spyglass Space peek
  // can yield plain Space to voice push-to-talk when STT is present (see the
  // module-scoped sttAvailable note). Best-effort and additive: if the IPC is
  // missing (older main bundle) or rejects, sttAvailable stays false and the
  // peek keeps working on Space as before.
  useEffect(() => {
    let alive = true
    window.canvasio?.voice
      ?.capabilities?.()
      .then((c) => {
        if (alive) sttAvailable = !!c?.stt
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // Spyglass — release: ending the hold (Space keyup) springs the camera back to
  // the exact pre-peek view. Also end on window blur so a peek can never get
  // "stuck" if the keyup is swallowed (e.g. focus jumps into an xterm while held).
  // endPeek is a no-op when no peek is in flight, so these listeners are harmless
  // otherwise. The keyup is intentionally NOT typing-guarded: we must catch the
  // release even if focus has since moved into a text input.
  useEffect(() => {
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code !== 'Space') return
      const s = useCanvas.getState()
      if (s.peekNodeId != null) s.endPeek()
    }
    const onBlur = (): void => {
      const s = useCanvas.getState()
      if (s.peekNodeId != null) s.endPeek()
    }
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  // Spyglass — the peek HUD: a tiny bottom-center hint chip shown only while a
  // peek is in progress (peekNodeId != null). The pulsing ring around the peeked
  // node is rendered by NodeView via the peekNodeId flag; this chip just tells the
  // user how to dismiss. Renderer-only, additive.
  const peekNodeId = useCanvas((s) => s.peekNodeId)

  // Atlas — keep the module-scoped mirror in sync with React state so the
  // always-on []-deps keydown listener can read the live open flag, and treat a
  // quick TAP as a sticky toggle. When Atlas opens, schedule a one-shot timer:
  // if 'O' is still held past the tap threshold it's a HOLD (do nothing here —
  // the keyup will close it); if the key was already released within the
  // threshold it's a TAP, so promote it to a sticky toggle so the (already-fired)
  // or upcoming keyup leaves it open. Cleared whenever Atlas closes.
  useEffect(() => {
    atlasIsOpen = atlasOpen
    if (!atlasOpen) {
      atlasDownAt = 0
      atlasToggled = false
      return
    }
    const startedAt = atlasDownAt
    const id = window.setTimeout(() => {
      // Still holding past the tap threshold → it's a hold; keyup will close it.
      // If atlasDownAt was cleared (key already released) it was a tap → sticky.
      if (atlasDownAt === startedAt && atlasDownAt !== 0) return
      atlasToggled = true
    }, ATLAS_TAP_MS)
    return () => window.clearTimeout(id)
  }, [atlasOpen])

  // Atlas — release: ending the 'O' hold closes the overview UNLESS a quick tap
  // promoted it to a sticky toggle (atlasToggled) or a tile was already picked
  // (which closes it directly). A tap that releases BEFORE the threshold timer
  // fires is handled here: short hold + not yet toggled ⇒ promote to sticky.
  // Not typing-guarded (mirrors the Spyglass keyup) so we always catch the
  // release even if focus moved into an xterm while held. Also close on blur so
  // a hold can never get "stuck" if the keyup is swallowed.
  useEffect(() => {
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.key !== 'o' && e.key !== 'O') return
      if (!atlasIsOpen) return
      const heldMs = atlasDownAt ? Date.now() - atlasDownAt : Infinity
      atlasDownAt = 0
      if (atlasToggled) return // a tap already made it sticky → leave open
      if (heldMs < ATLAS_TAP_MS) {
        atlasToggled = true // quick tap → promote to sticky toggle
        return
      }
      setAtlasOpen(false) // genuine hold released → close
    }
    const onBlur = (): void => {
      if (atlasIsOpen && !atlasToggled) setAtlasOpen(false)
    }
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  return (
    <div className="app-root">
      <Background />
      {/* REAL frosted glass: ONE blurred copy of the wallpaper, revealed only
          under the glass surfaces via a shared imperative mask. Mounted INSIDE
          .canvas-viewport (see Canvas.tsx) — NOT here — because the viewport is a
          z-index:1 stacking context that traps the terminal overlays (z-30); a
          root-level frost (z-29 > viewport z-1) would paint OVER the terminals. */}
      <Canvas />
      <TopBar />
      {/* Multi-canvas workspace tab bar — a slim fixed row at the very top, painted
          above TopBar (its own higher zIndex). Owns the open tabs (rename/close/
          active highlight), the "+" new-canvas, and the "Abrir lienzo" picker. */}
      <TabBar />
      <Toolbar />
      <ZoomControls />
      <SlipstreamNav />
      <Minimap />
      <Watchtower />
      <JumpHints />
      <PipelinePicker />
      <PulseRadar />
      <SnapGuides />
      <ThermalOverlay />
      <WaypointRail />
      <ConstellationFilter />
      <ReplayBar />
      <DirectorChip />
      <TourBar />
      <TimefoldBar />
      <CollisionWatch />
      <FlightplanChip />
      <CriticalPathChip />
      <TaskforcesChip />
      <VigilChip />
      {/* Sentinel — armed standing orders ("watch X for Y, then fly me there").
          Renders nothing when none armed; pulses + offers "ir" when one fires.
          The evaluation ticker lives in the effect above (mission/lens subscribed). */}
      <SentinelChip />
      <StallWatchToast />
      <ContextSyncToast />
      <TripwireToast />
      <HistoryToast />
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
      {peekNodeId != null && (
        <div className="spyglass-hint glass" role="status" aria-live="polite">
          {tr('app.spyglass_hint')}
        </div>
      )}
      <AgentLensHud />
      <ReplyRail />
      <ChangesetLens />
      <CheckpointPanel />
      <TripwirePanel />
      <Chronoscope />
      <CommandTrailPanel />
      <CatchUpPanel />
      <BriefBoard />
      <RecallPanel />
      <Beacon />
      <QuestionsPanel />
      <AtlasOverview active={atlasOpen} onClose={() => setAtlasOpen(false)} />
      {/* One shared voice pipeline (single recorder) drives BOTH the command
          bar and the quick-access floating FAB. */}
      <VoiceErrorBoundary>
        <VoiceProvider>
          <VoiceBubbles />
          <VoiceCompacting />
          <VoiceBar />
        </VoiceProvider>
      </VoiceErrorBoundary>
      {/* In-app replacement for window.prompt() (unsupported in Electron).
          Mounted once, last, at a high zIndex so it floats above every panel.
          Renders nothing unless a promptText() request is pending. */}
      <PromptModal />
    </div>
  )
}
