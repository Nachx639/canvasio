import { create } from 'zustand'
import { nanoid } from 'nanoid'
import { useDrawing, shapeBBox } from './drawing'
// relay.ts and mission.ts import nothing from canvas.ts, so these static imports
// introduce no cycle (mirroring the existing ./drawing import above). Used only
// by resetRelayAndMission() on a full canvas reset.
import { useRelay } from './relay'
import { useMission, latestEventByNode } from './mission'
import { computeHeat, hottestNodeId } from '../lib/thermal'
// Slipstream Pipeline Walk — PURE traversal over the relay handoff graph. The lib
// imports nothing (plain data in/out), so this is a zero-cycle, build-time-safe
// import. Used only by walkPipeline() to resolve the next hop's partner(s).
import { pickWalkTarget } from '../lib/pipelineWalk'
// Declutter — Layout-Preserving Overlap Resolver. resolveOverlaps is a PURE
// function (plain boxes in / position deltas out) that imports nothing from
// canvas.ts, so this runtime value import introduces no cycle (mirroring the
// pickWalkTarget import above). Used only by declutter() to compute which
// overlapping nodes must move and to where.
import { resolveOverlaps } from '../lib/declutter'
// Crew Recipes — MAX_CREW caps a recipe's spawned crew size. crewRecipes.ts
// imports ONLY the AgentKind TYPE from canvas.ts (a type-only import, erased at
// build time), so this runtime value import introduces no cycle (mirroring the
// history.ts note above).
import { MAX_CREW } from '../lib/crewRecipes'
import type { MissionEvent } from './mission'
// Agent Objectives — the per-node goal (one-line mission + optional checklist).
// objective.ts is a PURE module that imports ONLY types from canvas.ts (the
// CanvasNode/MissionEvent types, erased at build time), so this type-only import
// of the Objective type introduces no cycle. The objective rides the node and is
// PERSISTED (it survives App.tsx's existing `...rest` spread, exactly like
// cwd/command — only `fresh`/`pendingPrompt` are explicitly stripped). The
// derived progress/judgment reading is computed live and never stored.
import { objectiveTextFromPrompt, type Objective } from '../lib/objective'
// lens.ts (Agent Lens live excerpts) likewise imports nothing from canvas.ts, so
// this static import introduces no cycle; used only by resetRelayAndMission().
import { useLens } from './lens'
import { useEcho } from './echo'
import { useCommandTrail } from './commandTrail'
// changeset.ts (Changeset Lens per-node git changes) likewise imports nothing
// from canvas.ts, so this static import introduces no cycle; used only by
// resetRelayAndMission().
import { useChangeset } from './changeset'
// Checkpoints — memory-only per-node savepoint mirror; wiped by resetRelayAndMission
// on a full canvas reset (the git refs themselves persist and are re-listed live).
import { useCheckpoints } from './checkpoints'
// board.ts (Brief Board shared context pool) likewise imports nothing from
// canvas.ts, so this static import introduces no cycle; used only by
// resetRelayAndMission() to wipe pinned facts on a full canvas reset.
import { useBoard } from './board'
// questions.ts (Open Questions unblock bus) likewise imports nothing from
// canvas.ts, so this static import introduces no cycle; used only by
// resetRelayAndMission() to wipe live question cards on a full canvas reset.
import { useQuestions } from './questions'
// Mission Horizon — horizon.ts imports useCanvas back, but only ever touches it
// INSIDE getForecast() (call-time), mirroring mission.ts's getBrief() discipline,
// so this static import introduces no initialization-order hazard. Used only by
// resetRelayAndMission() to clear the declared mission goal on a full canvas reset.
import { useHorizon } from './horizon'
// Districts — Spatial Regions. regions.ts imports NOTHING from canvas.ts (it is
// pure data, mirroring relay.ts), so this static import introduces no cycle.
// Used to WIPE regions on a full canvas reset (clear/bootRecipe) and to RESTORE
// persisted regions on the loadLayout cold-start path.
import { useRegions, type Region } from './regions'
// Layout Time Machine — spatial undo/redo. history.ts imports ONLY the
// CanvasNode TYPE from canvas.ts (a type-only import, erased at build time), so
// these runtime imports introduce no cycle (mirroring the relay/mission note
// above). Used to snapshot `nodes` before the four destructive spatial ops and
// to reset the stacks on a full canvas reset. Pure in-memory; never IPC, never
// persisted.
import {
  pushHistory,
  takeUndo,
  takeRedo,
  resetHistory,
  type HistoryLabel
} from './history'
// Stages — Curated Multi-Node Scenes. stages.ts is a PURE module that imports
// ONLY the CanvasNode TYPE from canvas.ts (erased at build time), so these
// runtime value imports introduce no cycle (mirroring the history.ts note
// above). The Stage[] lives on THIS store (beside `waypoints`) to reuse its
// exact persistence wiring; boundsOf/pruneStageIds/sanitizeStages do the
// geometry + sanitize the store + loadLayout call.
import {
  boundsOf,
  pruneStageIds,
  sanitizeStages,
  MAX_STAGES,
  type Stage
} from '../lib/stages'
// Arrange Density — persisted DEFAULT column count for arrange(). Plain module
// (no store/selector → #185-safe); read synchronously inside arrange().
import { resolveArrangeGrid } from '../lib/arrangeDensity'

export type AgentKind = 'claude' | 'codex' | 'cursor' | 'shell'
export type NodeKind = 'terminal' | 'music' | 'web' | 'markdown' | 'folder' | 'calendar'

export interface CanvasNode {
  id: string
  kind: NodeKind
  /** for terminal nodes: which agent persona/CLI */
  agent?: AgentKind
  title: string
  subtitle?: string
  x: number
  y: number
  w: number
  h: number
  z: number
  /** terminal: command to auto-run; web: url */
  command?: string
  url?: string
  cwd?: string
  /**
   * markdown: absolute (or canvas-cwd-relative) path to the .md/text file this
   * note node renders READ-ONLY. PERSISTED with the node (it rides App.tsx's
   * `...rest` spread, exactly like cwd/url — only `fresh`/`pendingPrompt` are
   * stripped before serialization). Undefined for non-markdown nodes.
   */
  filePath?: string
  /**
   * folder: absolute (or canvas-cwd-relative) path to the directory this folder
   * node browses. Mutated in place (updateNode) when the user navigates into a
   * subdirectory. PERSISTED like filePath above. Undefined for non-folder nodes.
   */
  dirPath?: string
  /**
   * markdown/folder: when `true`, the node is COLLAPSED to a small opaque
   * file-icon chip on the canvas instead of showing the full window. The X
   * button on markdown/folder nodes sets this to `true` (minimize) rather than
   * calling removeNode; clicking the chip clears it (`collapsed: false`) to
   * expand again. A small trash affordance on the chip performs the real delete
   * (removeNode). Terminal/web/music nodes ignore this and keep their normal X =
   * close behaviour. PERSISTED with the node via App's `...rest` spread (only
   * `fresh`/`pendingPrompt` are stripped) and normalized to a strict boolean by
   * loadLayout. Undefined/absent → treated as not collapsed.
   */
  collapsed?: boolean
  status?: 'idle' | 'working' | 'done' | 'error'
  /**
   * terminal: an initial task to deliver to the agent once its input prompt is
   * ready. Set only on freshly-created terminal nodes; cleared after delivery.
   */
  pendingPrompt?: string
  /**
   * TRANSIENT runtime-only flag (NEVER persisted to localStorage). Set to `true`
   * exclusively by `addNode` when a node is created live in this session, and
   * deliberately left `undefined` on nodes restored from a saved layout on cold
   * start.
   *
   * Coordination contract with TerminalView (owned by another agent):
   * a terminal node should auto-run its `command` / boot its agent TUI ONLY when
   * `fresh === true`. Restored terminal nodes (`fresh` falsy) must NOT auto-run
   * their persisted agent command on cold start — the user can re-run manually.
   * This flag is stripped before serialization so it is always absent on reload.
   */
  fresh?: boolean
  /**
   * PERSISTED agent session id, used to RESUME the agent's conversation when the
   * node is restored on a later launch (instead of starting a blank session).
   *  - Claude: NOT preset. The fresh terminal runs plain `claude` (interactive
   *    2.1.179 does not honor a pre-assigned `--session-id` for resumable
   *    persistence); its REAL id is captured from ~/.claude/history.jsonl after
   *    the first exchange and persisted here, then a restored node runs
   *    `claude --resume <id>`.
   *  - Codex: captured from the rollout file after the session starts (Codex
   *    does not let us preset it); a restored node runs `codex resume <id>`.
   * Undefined for shell/cursor nodes. See TerminalView.buildRunCommand.
   */
  sessionId?: string
  /**
   * Agent Objectives — the node's GOAL: a one-line mission plus an optional tiny
   * checklist of done-signals. PERSISTED with the node (it survives App.tsx's
   * `...rest` spread, exactly like cwd/command — only `fresh`/`pendingPrompt` are
   * explicitly stripped before serialization). The DERIVED progress/judgment
   * (assessObjective in lib/objective.ts) is computed live from the existing
   * in-memory stores (Echo/Lens/Mission/Changeset) and is NEVER stored here.
   * Undefined when no goal has been set. Auto-seeded from pendingPrompt on spawn.
   */
  objective?: Objective
  /**
   * music: which tab/source the player is using. 'youtube' (default) plays a
   * pasted YouTube link via the IFrame Player API; 'somafm' falls back to the
   * preset live-radio stations. PERSISTED with the node via App's `...rest`
   * spread (only `fresh`/`pendingPrompt` are stripped). The YouTube URL itself
   * is stored in the shared `url` field (mirroring how WebPreview persists web
   * nodes) so it survives canvas switches and app restarts. Undefined → treated
   * as 'youtube' for music nodes. Ignored for non-music nodes.
   */
  musicMode?: 'youtube' | 'somafm'
  /**
   * music: cached YouTube video title so the node can render the label before
   * the iframe/player finishes loading. PERSISTED like `url`. The live playback
   * position is intentionally NOT persisted (a reopened node restarts at 0).
   */
  musicTitle?: string
  /**
   * music: queue for YouTube videos. An ordered list of {videoId, url, title}
   * items held on the node. PERSISTED with the node via App's `...rest` spread
   * (only `fresh`/`pendingPrompt` are stripped) and sanitized by loadLayout.
   * Undefined/empty → no queue. Ignored for non-music nodes.
   */
  musicQueue?: Array<{
    videoId: string
    url: string
    title?: string
  }>
  /**
   * music: current playback index within `musicQueue` (0-based). PERSISTED.
   * Undefined/absent → 0 (first item, or no queue). Auto-advance increments this
   * when the current song ends (detected via readYouTubeWebviewState's `ended`).
   * Clamped to the queue bounds by loadLayout.
   */
  musicQueueIndex?: number
}

export interface Camera {
  x: number
  y: number
  zoom: number
}

/**
 * Waypoints — Spatial Bookmarks. A camera-only "saved view": a named snapshot of
 * {x,y,zoom}. PURE DATA — it stores no node/shape geometry and going to one only
 * tweens the camera (never mutates nodes/shapes, never touches IPC). Persisted to
 * canvasio:layout so a user's mental map of their workspace survives relaunch.
 */
export interface Waypoint {
  id: string
  name: string
  cam: Camera
}

/** Max saved Waypoints, so plain 1..9 / ⌘1..⌘9 always map to a slot. */
const MAX_WAYPOINTS = 9

/** Watchtower — max nodes pinnable into the corner live-watch panel. */
export const MAX_WATCH = 3

interface CanvasState {
  nodes: CanvasNode[]
  camera: Camera
  selectedId: string | null
  /**
   * Lighthouse — Spotlight Focus Mode. TRANSIENT runtime-only flag (NEVER
   * persisted): when set, exactly this node is the "star" and every OTHER node
   * is dimmed/blurred via a CSS class. Cleared (null) means no spotlight. It is
   * reset to null by clear()/bootRecipe()/loadLayout() and is excluded from the
   * persistence path (App.tsx only serializes `nodes`), mirroring the same
   * runtime-state-stripping contract as the `fresh` flag.
   */
  focusNodeId: string | null
  /**
   * Spyglass — hold-to-peek spatial preview. TRANSIENT runtime-only (NEVER
   * persisted, NEVER sent over IPC): set to the id of the node currently being
   * "peeked" (the camera has sprung to it and will spring back on release). null
   * means no peek in progress. Excluded from the serialization path (App.tsx only
   * serializes `nodes`/`waypoints`), mirroring the same runtime-state contract as
   * focusNodeId. The actual stashed return camera + re-entrancy guard live at
   * module scope (peekReturn/peeking), mirroring the Slipstream camHistory pattern.
   */
  peekNodeId: string | null
  /**
   * Thermal — Activity Heat overlay flag. TRANSIENT runtime-only (NEVER
   * persisted, NEVER sent over IPC): when true, ThermalOverlay paints a heat
   * glow over active nodes and the Minimap shows heat dots. Reset to false by
   * clear()/bootRecipe()/loadLayout() and excluded from the serialization path
   * (App.tsx only serializes nodes/waypoints), mirroring focusNodeId/peekNodeId.
   */
  thermalOn: boolean
  /**
   * Vigil — Live Follow-Cam flag. TRANSIENT runtime-only (NEVER persisted, NEVER
   * sent over IPC): when true, a module-scope interval auto-pilot gently flies the
   * camera to whichever node is currently HOTTEST (via the SAME computeHeat +
   * hottestNodeId the Thermal overlay/Minimap/flyToHottest already use) and
   * re-targets on its own as the swarm's focus shifts, with hysteresis so it never
   * ping-pongs. The current follow target is `vigilTargetId`. Reset to false by
   * clear()/bootRecipe()/loadLayout() and excluded from the serialization path
   * (App.tsx only serializes nodes/waypoints), mirroring thermalOn/peekNodeId.
   * Camera-only: every auto-move funnels through centerOnNode wrapped in
   * pauseVisitRecording so Vigil never pollutes Slipstream/Wayback.
   */
  vigilOn: boolean
  /**
   * Vigil — the id of the node the follow-cam is currently locked onto, or null
   * when Vigil is off / nothing is hot yet. TRANSIENT runtime-only (same contract
   * as vigilOn); read by VigilChip to label the live target. Reset alongside
   * vigilOn. No geometry, no IPC.
   */
  vigilTargetId: string | null
  /**
   * Relay Conduits — the in-world handoff-graph overlay flag. TRANSIENT runtime-
   * only (NEVER persisted, NEVER sent over IPC): when true, ConduitsLayer paints a
   * faint curved arrow from each relay rule's source node border to its target's
   * border, and the Minimap mirrors the edges. Defaults ON so the handoff graph is
   * visible the moment a relay rule exists (the layer itself early-returns when
   * there are zero rules, so "on" is still zero-chrome until used). Reset to its
   * default by clear()/bootRecipe()/loadLayout() and excluded from the
   * serialization path (App.tsx only serializes nodes/waypoints), mirroring
   * thermalOn/focusNodeId/peekNodeId.
   */
  conduitsOn: boolean
  /**
   * Constellation Filter — the live in-canvas search query. TRANSIENT runtime-only
   * (NEVER persisted, NEVER sent over IPC): null means the filter is OFF (no chrome,
   * no node dimming); '' means the filter pill is OPEN but matches every node; a
   * non-empty string lights up matching nodes (`.spotlit`) and recedes the rest
   * (`.dimmed`) while framing the matched subset. Reset to null by
   * clear()/bootRecipe()/loadLayout() and excluded from the serialization path
   * (App.tsx only serializes nodes/waypoints), mirroring focusNodeId/peekNodeId.
   */
  filterQuery: string | null
  /**
   * Beacon — full-text scrollback search overlay open flag. TRANSIENT runtime-only
   * (NEVER persisted to canvasio:layout, NEVER sent over IPC): it mirrors the exact
   * contract of filterQuery/focusNodeId/jumpMode — false means the overlay renders
   * null (zero chrome/cost); true mounts the search panel. Reset to false by
   * clear()/bootRecipe()/loadLayout() and excluded from the serialization path
   * (App.tsx only serializes nodes/waypoints). Pure flag — the Beacon component
   * owns its own input + the live termRegistry snapshot; no camera, no geometry,
   * no IPC here.
   */
  beaconOpen: boolean
  /**
   * Beacon jump signal — the transient { nodeId, line, token } target consumed by
   * the matching TerminalOverlay to scrollToLine + flash a transient highlight when
   * Beacon flies to a hit. TRANSIENT runtime-only (NEVER persisted, NEVER IPC):
   * mirrors peekNodeId's contract. `token` bumps on every jump so re-jumping to the
   * SAME nodeId+line still re-triggers the subscriber (value-equality would swallow
   * it). null means no pending jump. Reset to null by clear()/bootRecipe()/
   * loadLayout(); pruned in removeNode when its node is closed. The camera move is
   * funneled through centerOnNode in beaconJump (so Slipstream/Wayback keep working).
   */
  beaconTarget: { nodeId: string; line: number; token: number } | null
  /**
   * Watchtower — the ids of the distant nodes PINNED into the corner live-watch
   * panel (max MAX_WATCH). TRANSIENT runtime-only (NEVER persisted to canvasio:layout,
   * NEVER sent over IPC): it mirrors the exact contract of filterQuery/peekNodeId —
   * a fresh / restored canvas always starts with nothing pinned. Pruned of any
   * removed id in removeNode and reset to [] by clear()/bootRecipe()/loadLayout()
   * (App.tsx only serializes nodes/waypoints). Pure data; the Watchtower component
   * reads the live Lens line + node status per id, and clicking a tile funnels
   * through centerOnNode (so Slipstream/Wayback keep working). No camera, no
   * geometry, no IPC here.
   */
  watchIds: string[]
  /**
   * Jump Hints (Ace-Jump Teleport) — when true, every node sprouts a tiny screen-
   * space label badge (a,s,d,f… in (y,x) reading order); typing a label flies the
   * camera straight to that node. TRANSIENT runtime-only (NEVER persisted, NEVER
   * sent over IPC): when false JumpHints renders null (zero chrome/cost). Reset to
   * false by clear()/bootRecipe()/loadLayout() and excluded from the serialization
   * path (App.tsx only serializes nodes/waypoints), mirroring focusNodeId/
   * peekNodeId/thermalOn/filterQuery. Pure flag — no geometry, no camera, no IPC.
   */
  jumpMode: boolean
  /**
   * Slipstream Pipeline Walk — the transient branch-picker state. When walking the
   * relay handoff graph (`walkPipeline`) lands on a node with MULTIPLE partners in
   * the pressed direction, this holds { dir, candidates } so PipelinePicker can
   * render ace-jump labels over ONLY those candidate nodes; null means no branch
   * choice is pending. TRANSIENT runtime-only (NEVER persisted, NEVER sent over
   * IPC): it mirrors the exact contract of peekNodeId/filterQuery/jumpMode — reset
   * to null by clear()/bootRecipe()/loadLayout() and excluded from the
   * serialization path (App.tsx only serializes nodes/waypoints). No geometry, no
   * camera, no IPC; the single-partner walk hops directly via centerOnNode instead.
   */
  pipelinePick: { dir: 'down' | 'up'; candidates: string[] } | null
  /**
   * Wayback — per-node VISIT log powering frecency ordering + the ` quick-switch.
   * TRANSIENT runtime-only (NEVER persisted to canvasio:layout, NEVER sent over IPC):
   * it mirrors the exact contract of filterQuery/peekNodeId. Keyed by node id ->
   * { count: total user-driven visits, lastTs: ms of the most recent visit }.
   * Captured at the SINGLE centerOnNode chokepoint every manual jump funnels
   * through; automated tours (Replay/Director) pause recording so a passive
   * flythrough never pollutes real work history. Reset to {} by
   * clear()/bootRecipe()/loadLayout() and excluded from the serialization path
   * (App.tsx only serializes nodes/waypoints), mirroring focusNodeId/peekNodeId.
   */
  visits: Record<string, { count: number; lastTs: number }>
  /**
   * Waypoints — spatial bookmarks (camera-only saved views). PURE DATA, persisted
   * to canvasio:layout (unlike transient runtime flags). Capped at MAX_WAYPOINTS so
   * 1..9 / ⌘1..⌘9 always map. Reset to [] by clear()/bootRecipe(); restored
   * (sanitized) by loadLayout when present.
   */
  waypoints: Waypoint[]
  /**
   * Stages — Curated Multi-Node Scenes. PURE DATA, persisted to canvasio:layout
   * (beside waypoints/regions): each Stage is a named SET of node ids. Capped at
   * MAX_STAGES so ⌘⇧1..9 always map. Reset to [] by clear()/bootRecipe();
   * restored (sanitized + pruned to live nodes) by loadLayout when present.
   */
  stages: Stage[]
  /**
   * Stages — the ids of the nodes in the CURRENTLY-ACTIVE Stage's spotlight set.
   * TRANSIENT runtime-only (NEVER persisted to canvasio:layout, NEVER sent over IPC):
   * it mirrors the exact contract of filterQuery/focusNodeId — null means no
   * Stage is active (no isolation chrome), a non-null array spotlights those ids
   * (`.spotlit`) and dims every other node (`.dimmed`) via the SAME CSS chrome
   * Constellation/Lighthouse render. Reset to null by clear()/bootRecipe()/
   * loadLayout() and excluded from the serialization path (App.tsx serializes
   * only nodes/waypoints/regions/stages). Pruned of removed ids in removeNode.
   */
  stageIds: string[] | null
  /**
   * Slipstream — a monotonically increasing tick bumped on every camera-history
   * push/traverse. TRANSIENT runtime-only (never persisted, never IPC): it exists
   * solely so React components (SlipstreamNav) re-render and re-read getCameraNav()
   * when Back/Forward availability changes. The actual history stack lives at
   * module scope (camHistory/camIndex), mirroring the flyRaf pattern.
   */
  histTick: number
  topZ: number
  autoFit: boolean
  theme: string
  appVolume: number
  musicRequest: {
    action: 'play' | 'pause' | 'toggle'
    query?: string
    token: number
  } | null
  // actions
  setTheme: (id: string) => void
  setAppVolume: (v: number) => void
  requestMusic: (action: 'play' | 'pause' | 'toggle', query?: string) => void
  setAutoFit: (v: boolean) => void
  addNode: (n: Partial<CanvasNode> & { kind: NodeKind }) => string
  removeNode: (id: string) => void
  updateNode: (id: string, patch: Partial<CanvasNode>) => void
  /**
   * Agent Objectives — set (or replace) a node's goal. Pure node-data write; the
   * derived progress/judgment is computed live elsewhere (assessObjective). No
   * camera, no geometry, no IPC. No-op on an unknown id.
   */
  setObjective: (nodeId: string, objective: Objective) => void
  /** Agent Objectives — clear a node's goal entirely. Pure node-data write. */
  clearObjective: (nodeId: string) => void
  /**
   * Agent Objectives — toggle the MANUAL done flag of one checklist item by index.
   * This is the user's explicit override; the live reading also auto-ticks items
   * from output, but this persists a hand-set state. No-op on an unknown id/index.
   */
  toggleChecklistItem: (nodeId: string, idx: number) => void
  bringToFront: (id: string) => void
  select: (id: string | null) => void
  /**
   * Smoothly fly the camera (pan AND zoom) so the node with `id` lands centered
   * at a crisp readable size, then select it and bring it to front. CAMERA-ONLY:
   * it never mutates node/shape geometry. No-op if the id is unknown.
   */
  centerOnNode: (id: string) => void
  /**
   * Districts — fly the camera to frame an arbitrary world-space rectangle (a
   * District's bounds) with the SAME eased tween + Slipstream/Wayback
   * participation centerOnNode uses. CAMERA-ONLY: never mutates node/shape
   * geometry, never touches IPC. No-op on a non-finite/zero box.
   */
  centerOnBounds: (b: { x: number; y: number; w: number; h: number }) => void
  /**
   * Waypoints — capture the CURRENT camera (pan + zoom) as a named saved view.
   * Camera-only (snapshots {x,y,zoom}); never touches node/shape geometry or IPC.
   * Caps at MAX_WAYPOINTS, dropping the oldest so 1..9 keys stay mapped.
   */
  saveWaypoint: (name?: string) => void
  /**
   * Waypoints — teleport: fly the camera to the saved view with the SAME eased
   * tween centerOnNode uses (shared flyCameraTo helper). Disables autoFit so a
   * later resize doesn't yank the camera away. No-op if the id is unknown.
   */
  goWaypoint: (id: string) => void
  /** Waypoints — rename a saved view (camera-only, pure data). */
  renameWaypoint: (id: string, name: string) => void
  /** Waypoints — delete a saved view (camera-only, pure data). */
  removeWaypoint: (id: string) => void
  /**
   * Stages — capture a named scene from the CURRENT working set. The set is, in
   * priority: the live multi-selection (if Drawing-style multi-select ever feeds
   * it) else the single selectedId, else the current filterMatches() (the open
   * Constellation Filter). Captures NOTHING (no-op) when there's no selection and
   * no active filter. PURE DATA, persisted; caps at MAX_STAGES dropping the
   * oldest so ⌘⇧1..9 stay mapped.
   */
  captureStage: (name?: string) => void
  /**
   * Stages — activate a saved scene: set stageIds to the Stage's nodeIds (pruned
   * to nodes still present), frame the camera over their collective bounding box
   * via setCameraTracked + cameraForBounds (so the move joins Slipstream Back/
   * Forward), and disable autoFit. CAMERA-ONLY: no geometry mutation, no IPC.
   * No-op if the id is unknown or every member node is gone.
   */
  activateStage: (id: string) => void
  /** Stages — release the active scene isolation (stageIds = null). Pure flag. */
  clearStage: () => void
  /** Stages — rename a saved scene (pure data; keeps the old name if blank). */
  renameStage: (id: string, name: string) => void
  /** Stages — delete a saved scene (pure data; clears stageIds if it was active). */
  removeStage: (id: string) => void
  /**
   * Lighthouse — directional spatial hop. From the active node (selectedId, or
   * the node nearest scene-center as a fallback), jump the "active" node to the
   * nearest neighbor in the given compass direction and fly the camera there via
   * centerOnNode (which selects + raises + tweens). Geometry-aware: scores
   * candidates by how directly they lie in `dir`, tie-broken by distance. Pure
   * read over `nodes`; never mutates node geometry. No-op if there is no
   * neighbor in that direction (or no nodes at all).
   */
  focusDirection: (dir: 'up' | 'down' | 'left' | 'right') => void
  /**
   * Lighthouse — cycle the active node in (y,x) reading order (like arrange()),
   * wrapping at the ends, and fly the camera to it via centerOnNode. dir +1 =
   * next, -1 = previous. No-op when there are no nodes.
   */
  cycleNode: (dir: 1 | -1) => void
  /** Lighthouse — set spotlight focus mode on/off (frames selection on enter). */
  setFocusMode: (on: boolean) => void
  /** Lighthouse — toggle spotlight focus mode for the current selection. */
  toggleFocusMode: () => void
  /**
   * Thermal — toggle the Activity Heat overlay on/off. Pure flag flip; the
   * overlay/minimap recompute heat themselves. No camera move, no geometry.
   */
  toggleThermal: () => void
  /**
   * Vigil — toggle the Live Follow-Cam auto-pilot on/off. When turned on it starts
   * a self-cancelling module-scope interval (vigilTick) that, every ~1.2s, flies the
   * camera to the currently hottest present node (computeHeat + hottestNodeId) with
   * hysteresis (heat margin + minimum dwell) so the camera never ping-pongs; turning
   * it off stops the interval and clears vigilTargetId. Each auto-move funnels through
   * centerOnNode wrapped in pauseVisitRecording so it never pollutes Slipstream/Wayback.
   * CAMERA-ONLY: no geometry, no IPC, not persisted.
   */
  toggleVigil: () => void
  /**
   * Relay Conduits — flip the in-world handoff-graph overlay on/off. Renderer-only
   * flag; no IPC, no geometry, no camera. The ConduitsLayer + Minimap recompute the
   * edges themselves from nodes + relay rules.
   */
  toggleConduits: () => void
  /**
   * Watchtower — pin a node into the live-watch panel. Appends if absent, caps at
   * MAX_WATCH (no-op once full), and no-ops if the id is already pinned or is the
   * currently-selected/centered node (you can already see it). Pure data; no
   * camera, no geometry, no IPC.
   */
  pinWatch: (id: string) => void
  /** Watchtower — unpin a node from the live-watch panel. Pure data. */
  unpinWatch: (id: string) => void
  /** Watchtower — toggle a node's pinned state in the live-watch panel. */
  toggleWatch: (id: string) => void
  /** Watchtower — clear every pinned watch tile. Pure data. */
  clearWatch: () => void
  /** Jump Hints — set ace-jump teleport mode on/off. Pure flag flip; no camera,
   *  no geometry, no IPC. JumpHints computes badges + handles keys while on. */
  setJumpMode: (on: boolean) => void
  /** Jump Hints — toggle ace-jump teleport mode. Pure flag flip. */
  toggleJumpMode: () => void
  /**
   * Slipstream Pipeline Walk — fly one hop along the Agent Relay handoff graph from
   * the current node (selectedId): 'down' follows the agents this one feeds, 'up'
   * traces the agents that feed it. Reads the live relay rules + visit frecency,
   * resolves the partner(s) via the PURE lib/pipelineWalk. A single partner hops
   * straight through centerOnNode (inheriting Slipstream/Wayback/Loupe history for
   * free); MULTIPLE partners set the transient pipelinePick branch flag the picker
   * overlay reads. CAMERA-ONLY: reuses centerOnNode, mutates no geometry, touches
   * no IPC, not serialized.
   */
  walkPipeline: (dir: 'down' | 'up') => void
  /** Slipstream Pipeline Walk — clear the transient branch-picker flag (Esc / after
   *  a pick / when no choice is pending). Pure flag clear; no camera, no IPC. */
  clearPipelinePick: () => void
  /**
   * Constellation Filter — set (or clear with null) the live search query. Pure
   * flag set: NodeView derives spotlit/dimmed from it. No camera move here (the
   * pill calls frameMatches separately, debounced), no geometry, no IPC.
   */
  setFilter: (q: string | null) => void
  /**
   * Constellation Filter — pure selector returning the ids of every node whose
   * title / subtitle / agent label / status contains the current filterQuery
   * (lowercase substring). Returns [] when the filter is off (null). An empty
   * query ('') matches EVERY node. Read-only over nodes; never mutates geometry.
   */
  filterMatches: () => string[]
  /**
   * Constellation Filter — frame the camera over the bounding box of the currently
   * matched nodes (reusing sceneBounds-style box union + cameraForBounds) and apply
   * it via setCameraTracked so the move participates in Slipstream Back/Forward.
   * CAMERA-ONLY: no geometry mutation, no IPC. No-op (never throws, never moves)
   * when there are zero matches.
   */
  frameMatches: () => void
  /**
   * Beacon — open the full-text scrollback search overlay (pure flag flip). The
   * Beacon component takes its own termRegistry snapshot on open. No camera, no IPC.
   */
  openBeacon: () => void
  /** Beacon — close the search overlay and clear any pending jump signal. */
  closeBeacon: () => void
  /**
   * Beacon — fly to a content hit: set the { nodeId, line, token } jump signal the
   * matching TerminalOverlay consumes (scrollToLine + transient highlight) AND fly
   * the camera to the node through centerOnNode (inheriting Slipstream/Wayback so
   * Back/Forward + frecency keep working). CAMERA-only beyond the transient signal;
   * mutates no geometry, touches no IPC. Closing the overlay is the caller's job.
   */
  beaconJump: (nodeId: string, line: number) => void
  /**
   * Loupe — Drag-a-Box Marquee Zoom. Fly the camera to frame an arbitrary
   * world-space rectangle (the rubber-band region the user dragged while holding
   * Z) through the SAME framing math fit/filter/Districts use. CAMERA-ONLY: never
   * mutates node/shape geometry, never touches IPC, not persisted. Applies via
   * setCameraTracked so the jump joins Slipstream Back/Forward + Wayback for free.
   * Guards against a non-finite / degenerate box (no-op, never moves).
   */
  frameRegion: (box: { minX: number; minY: number; maxX: number; maxY: number }) => void
  /**
   * Thermal — fly the camera to the single MOST-ACTIVE node right now (computed
   * from the live mission timeline via computeHeat + hottestNodeId, restricted to
   * nodes still on the canvas) using the existing centerOnNode tween. CAMERA-ONLY:
   * reuses centerOnNode, mutates no node/shape geometry, touches no IPC, not
   * persisted. No-op when nothing is hot.
   */
  flyToHottest: () => void
  /**
   * Triage Jump — march the camera to the NEXT agent that needs you in priority
   * order (error > waiting "te necesita" > done; oldest-first within a tier),
   * wrapping around. Builds the queue via attentionQueue(nodes, mission events),
   * finds selectedId's slot, advances (dir 'next'/'prev'), and funnels the chosen
   * id through centerOnNode (which selects + raises + pushes Slipstream history +
   * tweens). CAMERA-ONLY: reuses centerOnNode, mutates no geometry, touches no IPC,
   * not persisted. No-op when the queue is empty.
   */
  cycleAttention: (dir?: 'next' | 'prev') => void
  /**
   * Spyglass — transient hold-to-peek: spring the camera to frame node `id`
   * (selected, else nearest-to-center via peekTargetId) using the SAME 280ms eased
   * fly tween, WITHOUT committing the move — no Slipstream history push, no autoFit
   * change, no selection change, no bringToFront. On the first call it stashes a
   * finite copy of the live camera so endPeek() can spring back exactly. A second
   * call while already peeking just retargets (keeps the original return camera).
   * Camera-only and read-only over the workspace; no-op when `id` is null/unknown.
   */
  peekAt: (id: string | null) => void
  /**
   * Spyglass — end a peek: spring the camera back to the exact view stashed by the
   * first peekAt, then clear all peek state. No-op if no peek is in progress.
   * Because peekAt never pushed history / touched autoFit / selection, the
   * workspace returns byte-for-byte to its pre-peek state.
   */
  endPeek: () => void
  /**
   * Spyglass — resolve the most relevant node to peek with the keyboard gesture:
   * the current selection if still valid, else the node nearest the scene center
   * (same nearest-center logic focusDirection uses). Returns null with 0 nodes.
   */
  peekTargetId: () => string | null
  /**
   * Slipstream — fly the camera BACK to the previously recorded vantage (the view
   * you were at right before the last programmatic jump), browser-style. The very
   * first Back also records the live (tip) view as the forward anchor so Forward
   * can return to it. Camera-only eased tween; no-op when there's nothing behind.
   */
  cameraBack: () => void
  /**
   * Slipstream — re-fly FORWARD to the next recorded vantage after a Back. Mirror
   * of cameraBack. Camera-only; no-op when already at the tip of history.
   */
  cameraForward: () => void
  /**
   * Slipstream — record the current camera then setCamera to a recentered view.
   * Used ONLY by the Minimap (which moves the camera directly via setCamera) so
   * its recenters participate in Back/Forward history. Camera-only; never touches
   * node/shape geometry.
   */
  setCameraTracked: (c: Partial<Camera>) => void
  /** Slipstream — wipe the in-memory camera history (called on canvas reset). */
  clearCameraHistory: () => void
  /**
   * Wayback — frecency-ordered node ids (most-worked first). Score combines
   * frequency (log2(count+1)) with a recency decay over lastTs, descending.
   * Never-visited nodes are excluded (the palette falls back to insertion order
   * for them). Read-only over `visits`; never mutates geometry or touches IPC.
   */
  frecencyOrder: () => string[]
  /**
   * Wayback — the two most-recently-visited DISTINCT node ids that still exist on
   * the canvas, newest first: [current, previous]. Either slot may be null when
   * there aren't enough visits. Read-only; used by quickSwitch + the palette.
   */
  lastTwoVisited: () => [string | null, string | null]
  /**
   * Wayback — alt-tab for the canvas: fly to the PREVIOUS visited node (the second
   * entry of lastTwoVisited) via the existing centerOnNode tween. Camera-only;
   * no-op with fewer than 2 distinct visited nodes still present.
   */
  quickSwitch: () => void
  /** Wayback — wipe the in-memory visit log (called on canvas reset). */
  clearVisits: () => void
  setCamera: (c: Partial<Camera>) => void
  panBy: (dx: number, dy: number) => void
  zoomAt: (clientX: number, clientY: number, delta: number) => void
  resetView: () => void
  fitToView: () => void
  resetZoom100: () => void
  /**
   * Auto-organise the canvas into a grid AT ZOOM 1.0. Column density is
   * configurable: pass an explicit `cols` (voice/menu "arrange at N") or omit it
   * to use the persisted default (TopBar density popover). Clamped 2..12.
   */
  arrange: (spec?: number | string) => void
  /**
   * Cascade — stack every non-collapsed node like a tidy pile: each node placed
   * IN FRONT of the previous with a fixed down-right diagonal offset, assigning
   * increasing z so later nodes sit on top. Mirrors arrange()'s safety surface
   * (drawing shapes never touched, off the persistence path) and is a single
   * undoable step via pushHistory. Wraps to a NEW cascade column when the pile
   * would run off the bottom/right of the viewport so a large canvas stays tidy.
   * Resets the camera to {0,0,1} with autoFit so the whole stack is framed.
   */
  cascade: () => void
  /**
   * Flow Layout — Relay-aware pipeline auto-arrange. A CAMERA+GEOMETRY one-shot
   * with the SAME mutation surface as arrange(): it re-places NODES at zoom 1.0
   * (Math.round'd pixels, crisp/no blur) and resets the camera to {0,0,1} with
   * autoFit on. It NEVER touches drawing shapes, and like arrange() it is off the
   * persistence path (App.tsx serializes only `nodes`/`waypoints`).
   *
   * Unlike arrange()'s blind (y,x) grid, this reads the Agent Relay handoff graph
   * (useRelay.rules, {sourceId -> targetId}) restricted to currently-existing
   * nodes, treats it as a DAG, computes each node's "stage" via longest-path
   * (Kahn) layering, and lays the layers out as left-to-right columns — upstream
   * agents on the left, the agents they hand off to in the next column, etc. So
   * the canvas literally mirrors the pipeline (Nova -> Iris -> Atlas reads
   * left to right). Wired nodes with no further place AND fully un-wired/orphan
   * nodes are parked in a trailing column so nothing is lost. Relay cycles are
   * defused defensively (capped iterations) so a loop can never hang.
   *
   * Graceful fallback: when there are no relay rules OR fewer than 2 nodes it
   * delegates to arrange() and returns, so it can never regress the no-graph case.
   */
  flowLayout: () => void
  /**
   * Declutter — Layout-Preserving Overlap Resolver. A force-directed MICRO-reflow
   * that, unlike arrange()/flowLayout(), preserves your hand-tuned layout: it
   * detects ONLY the nodes whose rectangles actually overlap and gently pushes
   * JUST those apart along their minimal separation axis until no two overlap.
   * Every non-overlapping node stays EXACTLY where it is and the CAMERA NEVER
   * MOVES (no autoFit change, no fly). Mirrors arrange()'s safety surface: drawing
   * shapes are never read/written, no IPC, off the persistence path. The focused
   * node (selectedId) is held anchored so the node you're looking at stays pinned.
   * Single-undo reversible via pushHistory. NO history push and NO set() when
   * nothing overlaps (zero cost on an already-clean layout). Pure delegation to
   * the deterministic lib/declutter resolver.
   */
  declutter: () => void
  bootRecipe: () => void
  /**
   * Crew Recipes — one-shot multi-agent mission templates. Spawns the recipe's
   * whole crew onto the CURRENT canvas (it does NOT wipe nodes/relay/mission like
   * bootRecipe does), delivering each agent its role-prompt as a pendingPrompt,
   * then pre-wires the Agent Relay handoff chain between them (with Smart Relay /
   * includeBoard on) and auto-arranges. Pure composition of existing primitives
   * (addNode + useRelay.addRule + arrange): runtime behavior is identical to a
   * manual setup, so TerminalView still gates pendingPrompt on readiness and the
   * relay still drains on the proven deliverRelay path. In-memory only; recipes
   * are never serialized and the relay rules it creates are off the persistence
   * path (and cleaned up by resetRelayAndMission on a full canvas reset).
   */
  runRecipe: (recipe: import('../lib/crewRecipes').CrewRecipe) => void
  clear: () => void
  loadLayout: (data: {
    nodes: CanvasNode[]
    waypoints?: Waypoint[]
    regions?: Region[]
    stages?: Stage[]
  }) => void
  /**
   * Layout Time Machine — capture the CURRENT `nodes` array into the undo stack
   * under a short label, BEFORE a destructive spatial mutation. Called once at a
   * gesture's START by the views (drag-move / resize) so a whole gesture is a
   * single undo step, and internally at the top of arrange()/flowLayout()/
   * removeNode(). Pure in-memory; never persisted, never IPC.
   */
  snapshotForGesture: (label: HistoryLabel) => void
  /**
   * Layout Time Machine — replace the live `nodes` array with a snapshot from the
   * undo/redo stack, pruning any selection/focus/peek/watch id that no longer
   * exists in it (same pruning contract as removeNode). Restored terminal nodes
   * are never `fresh`, so they don't re-run their agent command. Geometry-only
   * restore; camera is left to Slipstream/Wayback. No IPC, never persisted.
   */
  applyNodes: (nodes: CanvasNode[]) => void
  /** Layout Time Machine — undo the last spatial action (Cmd/Ctrl+Z). No-op
   *  when the undo stack is empty. Restores the pre-action `nodes` snapshot. */
  undo: () => void
  /** Layout Time Machine — redo the last undone action (Shift+Cmd/Ctrl+Z).
   *  No-op when the redo stack is empty. */
  redo: () => void
}

const CHROME = { top: 64, bottom: 116, left: 78, right: 190 }

// Cascade — classic window-pile geometry. Each node steps down-right by one
// offset; the stack wraps to a fresh column when it would leave the viewport.
const CASCADE_DX = 32
const CASCADE_DY = 32

/**
 * Atlas — Semantic Zoom Level-of-Detail threshold. Below this camera zoom, a
 * terminal node is too small to read its live xterm, so NodeView swaps the
 * (blurry, costly) screen-space overlay for an in-world "Glance Card" (title +
 * status dot + latest Lens line + changeset badge), and TerminalOverlay suspends
 * the overlay box for those nodes (hide + pause FitAddon; never disposes the
 * xterm/pty). Pure-renderer constant: no new store state, no IPC, no persistence.
 * camera.zoom already lives in useCanvas and is subscribable, so consumers select
 * the boolean `zoom < LOD_ZOOM` narrowly and only re-render when crossing it.
 */
export const LOD_ZOOM = 0.45

/**
 * Tile a column-major arrangement of node ids to fill the available viewport at
 * EXACTLY zoom 1.0 (nothing is CSS-scaled, so xterm text re-renders crisply).
 * Shared by arrange() (one grid-row-major shape expressed as columns) and
 * flowLayout() (relay-pipeline layers), so the constants/cell-size formula and
 * the per-cell placement live in ONE place. Behavior-identical to the previous
 * inline copies: same CHROME-based avail box, gap=16, Math.floor cell sizing,
 * and Math.round per-cell placement.
 */
function tileColumns(
  columns: string[][],
  byId: Map<string, CanvasNode>
): CanvasNode[] {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const availX = CHROME.left
  const availY = CHROME.top
  const availW = Math.max(240, vw - CHROME.left - CHROME.right)
  const availH = Math.max(180, vh - CHROME.top - CHROME.bottom)
  const gap = 16
  const cols = columns.length
  const maxRows = Math.max(1, ...columns.map((c) => c.length))
  const cellW = Math.floor((availW - gap * (cols - 1)) / cols)
  const cellH = Math.floor((availH - gap * (maxRows - 1)) / maxRows)
  const placed: CanvasNode[] = []
  columns.forEach((colIds, c) => {
    colIds.forEach((id, r) => {
      const node = byId.get(id)!
      placed.push({
        ...node,
        x: Math.round(availX + c * (cellW + gap)),
        y: Math.round(availY + r * (cellH + gap)),
        w: cellW,
        h: cellH
      })
    })
  })
  return placed
}

/**
 * Union the world-space bounding boxes of every NODE and every drawing SHAPE.
 * This is read-only over both stores: it NEVER mutates node or shape coordinates.
 * Returns null when there is nothing to frame (no nodes AND no shapes).
 */
function sceneBounds(
  nodes: CanvasNode[]
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let any = false
  for (const n of nodes) {
    minX = Math.min(minX, n.x)
    minY = Math.min(minY, n.y)
    maxX = Math.max(maxX, n.x + n.w)
    maxY = Math.max(maxY, n.y + n.h)
    any = true
  }
  // Read drawing shapes from their own store (read-only). drawing.ts does not
  // import canvas.ts, so this ES import does not create a cycle.
  const shapes = useDrawing.getState().shapes
  for (const sh of shapes) {
    const bb = shapeBBox(sh)
    minX = Math.min(minX, bb.x)
    minY = Math.min(minY, bb.y)
    maxX = Math.max(maxX, bb.x + bb.w)
    maxY = Math.max(maxY, bb.y + bb.h)
    any = true
  }
  if (!any) return null
  return { minX, minY, maxX, maxY }
}

/**
 * Compute a camera (zoom<=1, centered, accounting for CHROME) that frames the
 * given world-space bounds inside the visible viewport. Camera-only: applying
 * this moves nodes and shapes together so they stay perfectly aligned.
 */
function cameraForBounds(b: {
  minX: number
  minY: number
  maxX: number
  maxY: number
}): Camera {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const bw = Math.max(1, b.maxX - b.minX)
  const bh = Math.max(1, b.maxY - b.minY)
  const availW = Math.max(120, vw - CHROME.left - CHROME.right)
  const availH = Math.max(120, vh - CHROME.top - CHROME.bottom)
  // NEVER scale above 1.0 — upscaling the CSS-transformed canvas blurs the
  // terminal text. Fit only ever shrinks (downscaling stays sharp).
  const zoom = Math.min(1, Math.max(0.2, Math.min(availW / bw, availH / bh)))
  const cx = CHROME.left + availW / 2
  const cy = CHROME.top + availH / 2
  return {
    zoom,
    x: cx - (b.minX + bw / 2) * zoom,
    y: cy - (b.minY + bh / 2) * zoom
  }
}

/**
 * Wipe the in-memory relay (rules + queue) and mission (timeline) stores that
 * hang off canvas nodes, used by clear()/bootRecipe() when every node is being
 * replaced. Accessed lazily via getState() so canvas.ts keeps NO static import
 * of these stores (relay.ts / mission.ts import nothing from canvas.ts, so the
 * one-directional import contract and cold-start/persistence behavior are
 * preserved). Both calls are public store methods and idempotent, so the
 * existing TopBar 'New canvas' -> clearAll() becomes a harmless no-op.
 */
/**
 * Stall Watch reset hook. stall.ts imports canvas.ts (like director.ts does), so
 * canvas.ts CANNOT import stall.ts back without a cycle. Instead, stall.ts
 * registers its disarm-and-clear callback here at module load; resetRelayAndMission
 * invokes it if present. Mirrors the one-directional-import discipline used for the
 * other in-memory stores (which DON'T import canvas and so can be imported here).
 */
let stallResetHook: (() => void) | null = null
export function registerStallReset(fn: () => void): void {
  stallResetHook = fn
}

/**
 * Active-canvas working-folder (cwd) hook. workspace.ts imports canvas.ts (it
 * drives useCanvas.loadLayout/clear), so canvas.ts CANNOT import workspace.ts back
 * without a module-load cycle. Instead, workspace.ts registers its
 * activeCanvasCwd() getter here at module load; the recipe spawns
 * (bootRecipe/runRecipe) call activeCwdLazy() to inject the active canvas cwd into
 * new terminal nodes. Returns undefined when no folder is set or the hook is
 * unregistered (=> node.cwd undefined => pty falls back to home, the existing
 * default). Mirrors the one-directional-import discipline above.
 */
let activeCwdHook: (() => string | undefined) | null = null
export function registerActiveCwd(fn: () => string | undefined): void {
  activeCwdHook = fn
}
function activeCwdLazy(): string | undefined {
  try {
    return activeCwdHook ? activeCwdHook() : undefined
  } catch {
    return undefined
  }
}

/**
 * Tripwire reset hook. Same one-directional-import discipline as Stall Watch:
 * tripwire.ts imports canvas.ts (for centerOnNode denormalization + this
 * registry), so canvas.ts CANNOT import tripwire.ts back without a cycle.
 * tripwire.ts registers its clear-all callback here at module load;
 * resetRelayAndMission invokes it if present. No-op if Tripwire was never loaded.
 */
let tripwireResetHook: (() => void) | null = null
export function registerTripwireReset(fn: () => void): void {
  tripwireResetHook = fn
}

/**
 * Context Sync reset hook. contextSync.ts imports relay.ts (which imports
 * canvas.ts), so a static import of contextSync.ts here would close a cycle
 * through canvas.ts. Instead, contextSync.ts registers its clear-all callback at
 * module load and resetRelayAndMission invokes it if present, mirroring the
 * Stall Watch / Tripwire one-directional-import discipline. No-op if Context Sync
 * was never loaded.
 */
let contextSyncResetHook: (() => void) | null = null
export function registerContextSyncReset(fn: () => void): void {
  contextSyncResetHook = fn
}

/**
 * Catch-Up reset hook. catchup.ts (store) imports canvas.ts (for the visits
 * read-marker + this registry), so canvas.ts CANNOT import it back without a
 * cycle. catchup.ts registers its clear-all callback here at module load and
 * resetRelayAndMission invokes it if present — same one-directional-import
 * discipline as Stall Watch / Tripwire / Context Sync. Wiping the per-node
 * "marked caught-up" watermarks guarantees a fresh / loaded canvas starts with no
 * unread. No-op if Catch-Up was never loaded.
 */
let catchupResetHook: (() => void) | null = null
export function registerCatchupReset(fn: () => void): void {
  catchupResetHook = fn
}

/**
 * Sentinel reset hook. sentinel.ts (store) imports canvas.ts (for centerOnNode on
 * fire + this registry + the live node ids/mission baseline at arm-time), so
 * canvas.ts CANNOT import it back without a cycle. sentinel.ts registers its
 * clear-all callback here at module load and resetRelayAndMission invokes it if
 * present — same one-directional-import discipline as Stall Watch / Tripwire /
 * Context Sync / Catch-Up. Wiping the armed standing orders guarantees a fresh /
 * loaded canvas never lingers watching a now-gone node. No-op if Sentinel was
 * never loaded.
 */
let sentinelResetHook: (() => void) | null = null
export function registerSentinelReset(fn: () => void): void {
  sentinelResetHook = fn
}

function resetRelayAndMission(): void {
  // Relay: drop all rules and the transient per-target queue.
  useRelay.setState({ rules: [], queue: {} })
  // Mission: wipe the whole timeline (same as its documented new_canvas reset).
  useMission.getState().clearAll()
  // Agent Lens: wipe all live "what it's doing now" excerpts (memory-only).
  useLens.getState().clearAll()
  // Echo Index: wipe every per-node searchable output ring (memory-only). A
  // fresh / loaded canvas always starts with no searchable lines.
  useEcho.getState().clearAll()
  // Command Trail: wipe every per-node executed-command audit ring (memory-only).
  // A fresh / loaded canvas always starts with no recorded commands.
  useCommandTrail.getState().clearAll()
  // Changeset Lens: wipe all per-node git change summaries (memory-only).
  useChangeset.getState().clearAll()
  // Checkpoints: wipe the in-memory per-node savepoint lists (memory-only). The
  // checkpoints themselves persist in the repo's git refs and are re-listed live
  // by the poll, so this only clears the ephemeral mirror — same as changesets.
  useCheckpoints.getState().clearAll()
  // Brief Board: wipe all pinned shared-context facts (memory-only). A fresh /
  // loaded canvas always starts with an empty board.
  useBoard.getState().clearAll()
  // Open Questions: wipe the live unblock-bus cards (memory-only). A fresh /
  // loaded canvas always starts with no open questions.
  useQuestions.getState().clearAll()
  // Mission Horizon: clear the declared overarching mission goal (memory-only) so a
  // fresh / loaded canvas always starts with no goal and a calm idle forecast.
  useHorizon.getState().clearGoal()
  // Districts: wipe all spatial regions so a District can never linger pointing
  // at a now-gone area after every node is replaced. loadLayout RESTORES its own
  // persisted regions AFTER calling this (see loadLayout), so the cold-start
  // path is unaffected; clear()/bootRecipe() leave it empty.
  useRegions.getState().clear()
  // Stall Watch: disarm + wipe stalls so orphaned node ids never linger as
  // "blocked" after every node is replaced. Reached via the registered hook
  // (canvas.ts can't import stall.ts — stall.ts imports canvas.ts). No-op if
  // Stall Watch was never armed/loaded.
  stallResetHook?.()
  // Tripwire: wipe all watch patterns + the hit feed so a fresh / loaded canvas
  // starts clean and no hit can linger pointing at a now-gone node. Reached via
  // the registered hook (canvas.ts can't import tripwire.ts — tripwire.ts imports
  // canvas.ts). No-op if Tripwire was never loaded.
  tripwireResetHook?.()
  // Context Sync: wipe the consumption ledger + pushed/dismissed sets so a fresh
  // / loaded canvas starts with no stale-fact tracking and no correction can
  // linger pointing at a now-gone node. Reached via the registered hook (canvas.ts
  // can't import contextSync.ts — it imports relay.ts -> canvas.ts). No-op if
  // Context Sync was never loaded.
  contextSyncResetHook?.()
  // Catch-Up: wipe the per-node "marked caught-up" watermarks so a fresh / loaded
  // canvas starts with no unread (the natural visits read-marker is already wiped
  // alongside the layout). Reached via the registered hook (canvas.ts can't import
  // catchup.ts — it imports canvas.ts). No-op if Catch-Up was never loaded.
  catchupResetHook?.()
  // Sentinel: wipe all armed standing orders so a fresh / loaded canvas starts
  // with nothing being watched and no order can linger pointing at a now-gone
  // node. Reached via the registered hook (canvas.ts can't import sentinel.ts —
  // it imports canvas.ts). No-op if Sentinel was never loaded.
  sentinelResetHook?.()
}

/**
 * Triage Jump — attention-PRIORITY traversal order.
 *
 * Pure, read-only fold over the live nodes + the mission timeline: it returns an
 * ordered id[] of the agents that currently need the user, highest priority
 * first. This is the SAME "latest mission event per node" derivation PulseRadar
 * uses for its `waitingIds`, generalized to a full ranking:
 *   tier 0 — error    (node.status === 'error' OR last event kind === 'error')
 *   tier 1 — waiting  ("te necesita": last event kind === 'waiting')
 *   tier 2 — done     (last event kind === 'done')
 * Within a tier, OLDEST-waiting-first (smallest reference ts) so you service the
 * agent that has been blocked on you the longest. Nodes whose id no longer exists
 * are skipped, and idle/working nodes never enter the queue.
 *
 * CAMERA/READ-ONLY contract: this never mutates node/shape geometry or events; it
 * is consumed by cycleAttention (which funnels through centerOnNode) and by the
 * TriageChip count, mirroring flyToHottest/cycleNode.
 */
export function attentionQueue(
  nodes: CanvasNode[],
  events: MissionEvent[],
  _now: number
): string[] {
  // Latest mission event per node (same fold as PulseRadar.waitingIds).
  const last = latestEventByNode(events)
  type Entry = { id: string; tier: number; ts: number }
  const out: Entry[] = []
  for (const n of nodes) {
    const ev = last.get(n.id)
    const kind = ev?.kind
    // Reference ts for oldest-first ordering within a tier: the timestamp of the
    // latest transition (i.e. how long the node has been sitting in this state).
    const ts = ev?.ts ?? 0
    let tier: number | null = null
    if (n.status === 'error' || kind === 'error') tier = 0
    else if (kind === 'waiting') tier = 1
    else if (kind === 'done') tier = 2
    if (tier == null) continue
    out.push({ id: n.id, tier, ts })
  }
  // (tier asc, then oldest ts first) — stable enough for a small queue.
  out.sort((a, b) => a.tier - b.tier || a.ts - b.ts)
  return out.map((e) => e.id)
}

const AGENT_LABEL: Record<AgentKind, { title: string; subtitle: string; command?: string }> = {
  claude: { title: 'Claude', subtitle: 'Claude Code', command: 'claude' },
  codex: { title: 'Codex', subtitle: 'Codex', command: 'codex' },
  cursor: { title: 'Cursor', subtitle: 'Cursor Agent', command: 'cursor-agent' },
  shell: { title: 'Terminal', subtitle: 'zsh' }
}

// playful agent names like in CANVASIO (Nova, Atlas, Iris …)
// Agent display-name pool: short, distinct, neutral codenames drawn from a mix of
// origins (celestial, nature, mythic) so a freshly spawned crew reads as varied.
// Deliberately original — no characters borrowed from any other product.
const NAME_POOL = [
  'Nova',
  'Atlas',
  'Iris',
  'Juno',
  'Kai',
  'Vega',
  'Orion',
  'Lyra',
  'Onyx',
  'Ember',
  'Sage',
  'Cleo',
  'Flint',
  'Hazel',
  'Indigo',
  'Jasper',
  'Koa',
  'Luna',
  'Milo',
  'Nyx',
  'Opal',
  'Quill',
  'Reef',
  'Soren',
  'Tycho',
  'Wren',
  'Yuki',
  'Zephyr',
  'Aria',
  'Bodhi',
  'Cove',
  'Dax',
  'Esme',
  'Frey',
  'Gaia',
  'Hugo',
  'Ravi',
  'Suki'
]
// Start at a varied offset so successive sessions don't always open with the same
// first name. (Math.random is fine in the renderer; only workflow scripts ban it.)
let nameIdx = Math.floor(Math.random() * NAME_POOL.length)

// In-flight fly-to animation handle (Beacon). Tracked at module scope so a new
// centerOnNode call cancels the previous tween instead of fighting it frame by
// frame. Any manual pan/zoom (panBy/zoomAt) silently wins because they just
// setCamera on the next frame; the tween reads the live camera each frame so it
// eases from wherever the camera currently is.
let flyRaf = 0

// --- Slipstream: spatial Back/Forward camera history -----------------------
// A browser-style history stack of camera vantage points, recorded right before
// each PROGRAMMATIC fly-to (Beacon centerOnNode, waypoints, Lighthouse hops,
// minimap recenter). IN-MEMORY ONLY: never persisted, never sent over IPC, never
// touches node/shape geometry — the same safety contract as flyRaf/waypoints.
//
// Model:
//   • camHistory = recorded DEPARTURE views, oldest..newest.
//   • camIndex   = the entry within camHistory we are currently "at" when
//                  navigating backward; otherwise it's the last stored entry.
//   • liveAhead  = true when the LIVE camera is a fresh destination NOT yet in
//                  camHistory (i.e. we just jumped and haven't gone Back yet).
//                  The first Back appends the live view as a forward anchor so
//                  Forward can return to exactly where we left.
//   • A new jump while NOT at the tip truncates the forward branch (browser-style).
const MAX_HIST = 50
let camHistory: Camera[] = []
let camIndex = -1
let liveAhead = false
// Re-entrancy guard so a back/forward traversal's own fly-to doesn't get
// recorded back into the stack (which would corrupt the index/branching).
let traversing = false

// --- Spyglass: transient hold-to-peek camera stash -------------------------
// The camera vantage to spring BACK to when the current peek ends. Stashed by
// the FIRST peekAt; cleared by endPeek. IN-MEMORY ONLY (never persisted/IPC),
// the same safety contract as camHistory/flyRaf. `peeking` is the re-entrancy
// guard (exact analogue of `traversing`) that keeps a peek's own fly-to from
// pushing Slipstream history.
let peekReturn: Camera | null = null
let peeking = false

// --- Wayback: visit recording pause gate -----------------------------------
// When true, centerOnNode does NOT record a visit. Set by AUTOMATED tours
// (Replay focusEvent, Director considerNewEvents) around their programmatic
// centerOnNode calls so a passive flythrough never pollutes the user's real
// work history. IN-MEMORY ONLY (never persisted, never IPC), the same safety
// contract as traversing/peeking.
let recordingPaused = false

/**
 * Wayback — pause/resume visit recording. Automated camera tours bracket their
 * centerOnNode calls with pauseVisitRecording(true) / (false) so only manual
 * jumps count toward frecency. Exported so replay.ts / director.ts (which import
 * nothing back into canvas runtime values beyond this) can gate their tours.
 */
export function pauseVisitRecording(b: boolean): void {
  recordingPaused = b
}

// --- Vigil: Live Follow-Cam auto-pilot driver ------------------------------
// A single module-scope interval that, while Vigil is on, gently re-targets the
// camera to whichever node is currently hottest. Mirrors the proven Flight
// Recorder timer discipline in replay.ts: ONE timer is ever pending, always
// cleared on toggle, and every programmatic fly funnels through centerOnNode
// wrapped in pauseVisitRecording so a passive follow never pollutes Slipstream/
// Wayback. CAMERA-ONLY: never mutates node/shape geometry, never touches IPC,
// never persisted. The hysteresis (heat margin + min dwell) is the only new logic.
let vigilTimer: ReturnType<typeof setInterval> | null = null
let vigilLastMoveTs = 0
/** How often the auto-pilot re-evaluates the hottest node, in ms. */
const VIGIL_INTERVAL_MS = 1200
/** New hottest must beat the current target's heat by this margin to steal focus. */
const VIGIL_HEAT_MARGIN = 0.12
/** Minimum time since the last auto-move before another is allowed, in ms. */
const VIGIL_MIN_DWELL_MS = 2500

function stopVigilTimer(): void {
  if (vigilTimer != null) {
    clearInterval(vigilTimer)
    vigilTimer = null
  }
}

/**
 * One auto-pilot evaluation. Reads the live state via the provided get/set
 * (the store closure), recomputes heat, and re-targets only when the hysteresis
 * guards permit. Defined as a factory so it can capture the store's get/set.
 */
function startVigilTimer(
  get: () => CanvasState,
  setTarget: (id: string | null) => void
): void {
  stopVigilTimer()
  vigilLastMoveTs = 0
  const tick = (): void => {
    const s = get()
    if (!s.vigilOn) return
    const nodes = s.nodes
    if (!nodes.length) return
    // Never fight a hold-to-peek or an in-flight manual tween — defer this beat.
    if (s.peekNodeId != null) return
    if (flyRaf !== 0) return
    const present = new Set(nodes.map((n) => n.id))
    const heat = computeHeat(useMission.getState().events, Date.now())
    const hottest = hottestNodeId(heat, present)
    if (!hottest) return // nothing hot yet — hold position
    const cur = s.vigilTargetId
    // Already locked on the hottest node (still present): just keep the label.
    if (cur === hottest && present.has(cur)) {
      if (s.vigilTargetId !== hottest) setTarget(hottest)
      return
    }
    // Hysteresis: require a minimum dwell since the last auto-move, AND require the
    // new candidate's heat to clear the current target's heat by a margin, so the
    // camera never ping-pongs between two near-equal nodes. A target that has left
    // the canvas (or has no current heat) is always replaceable.
    const now = Date.now()
    const curHeat = cur != null && present.has(cur) ? heat.get(cur) ?? 0 : 0
    const newHeat = heat.get(hottest) ?? 0
    const curStillValid = cur != null && present.has(cur) && curHeat > 0
    if (curStillValid) {
      if (now - vigilLastMoveTs < VIGIL_MIN_DWELL_MS) return
      if (newHeat < curHeat + VIGIL_HEAT_MARGIN) return
    }
    // Commit the move. Pause visit recording around the programmatic fly so the
    // passive follow never pollutes the user's frecency recents / quick-switch
    // pair — the IDENTICAL pattern replay.ts uses.
    vigilLastMoveTs = now
    setTarget(hottest)
    pauseVisitRecording(true)
    try {
      get().centerOnNode(hottest)
    } finally {
      pauseVisitRecording(false)
    }
  }
  // Fire once immediately so pressing 'v' snaps to the action without a beat's
  // delay, then settle into the interval cadence.
  tick()
  vigilTimer = setInterval(tick, VIGIL_INTERVAL_MS)
}

/** Snapshot the CURRENT camera (the departure) before a programmatic jump. No-op
 *  while a back/forward traversal is in flight (guarded by `traversing`). After a
 *  push the new destination becomes the live view that sits ahead of the tip. */
function pushCameraHistory(cur: Camera): void {
  // Skip during a back/forward traversal (would corrupt index/branching) AND
  // during a Spyglass peek (a peek is a transient, non-committing camera move
  // that must never push navigation history).
  if (traversing || peeking) return
  const snap: Camera = { x: cur.x, y: cur.y, zoom: cur.zoom }
  // New jump from anywhere but the tip truncates the forward branch.
  if (camIndex < camHistory.length - 1) camHistory = camHistory.slice(0, camIndex + 1)
  // Skip a redundant push when the departure equals the entry we're already at
  // (e.g. jumping again right after a Back, where the current view IS that entry).
  const tip = camHistory[camIndex]
  const same =
    tip &&
    Math.abs(tip.x - snap.x) < 0.5 &&
    Math.abs(tip.y - snap.y) < 0.5 &&
    Math.abs(tip.zoom - snap.zoom) < 0.002
  if (!same) {
    camHistory.push(snap)
    // Clamp to MAX_HIST by dropping the oldest entries.
    if (camHistory.length > MAX_HIST) camHistory = camHistory.slice(camHistory.length - MAX_HIST)
    camIndex = camHistory.length - 1
  }
  liveAhead = true
}

/** Wipe the camera history (new canvas / loaded layout / boot recipe). */
function clearCameraHistory(): void {
  camHistory = []
  camIndex = -1
  liveAhead = false
  traversing = false
  // A canvas reset / layout load also abandons any in-flight peek so a stale
  // return camera from the previous scene can never be flown back to.
  peekReturn = null
  peeking = false
}

/** Read-only nav availability for the Slipstream arrows + commands.
 *  canBack: a stored departure view sits behind the current view.
 *  canForward: a stored view sits ahead of where we've stepped back to. */
export function getCameraNav(): { canBack: boolean; canForward: boolean; length: number } {
  // When liveAhead, the live (unstored) view is conceptually at camIndex+1, so we
  // can always go back to camHistory[camIndex]. Otherwise we can go back only if
  // there's an earlier entry than the one we're currently showing.
  const canBack = liveAhead ? camIndex >= 0 : camIndex > 0
  const canForward = !liveAhead && camIndex >= 0 && camIndex < camHistory.length - 1
  return { canBack, canForward, length: camHistory.length + (liveAhead ? 1 : 0) }
}

/**
 * Eased camera lerp toward an arbitrary target Camera — the shared fly-tween used
 * by BOTH centerOnNode (target = cameraForBounds(nodeBox)) and goWaypoint
 * (target = saved waypoint cam). CAMERA-ONLY: it only ever set()s `camera`, never
 * node/shape geometry. Reuses the same module-scope flyRaf cancel logic, the
 * NaN/already-there guards, and the 280ms ease-out-cubic that centerOnNode used.
 */
function flyCameraTo(
  set: (partial: Partial<CanvasState>) => void,
  getCam: () => Camera,
  target: Camera
): void {
  const from = getCam()
  // Guard against a non-finite start/target (would NaN the lerp -> blank view).
  if (![from.x, from.y, from.zoom, target.x, target.y, target.zoom].every(Number.isFinite)) {
    set({ camera: target })
    return
  }
  // If we're already essentially there, snap (avoids a pointless tween).
  if (
    Math.abs(from.x - target.x) < 0.5 &&
    Math.abs(from.y - target.y) < 0.5 &&
    Math.abs(from.zoom - target.zoom) < 0.002
  ) {
    set({ camera: target })
    return
  }

  cancelAnimationFrame(flyRaf)
  const DURATION = 280
  const t0 = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()
  // ease-out cubic
  const ease = (t: number): number => 1 - Math.pow(1 - t, 3)
  const tick = (): void => {
    const now =
      typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()
    const p = Math.min(1, (now - t0) / DURATION)
    const k = ease(p)
    set({
      camera: {
        x: from.x + (target.x - from.x) * k,
        y: from.y + (target.y - from.y) * k,
        zoom: from.zoom + (target.zoom - from.zoom) * k
      }
    })
    if (p < 1) flyRaf = requestAnimationFrame(tick)
    else flyRaf = 0
  }
  flyRaf = requestAnimationFrame(tick)
}

function nextName(): string {
  const n = NAME_POOL[nameIdx % NAME_POOL.length]
  nameIdx++
  return n
}


export const useCanvas = create<CanvasState>((set, get) => ({
  nodes: [],
  camera: { x: 0, y: 0, zoom: 1 },
  selectedId: null,
  focusNodeId: null,
  peekNodeId: null,
  thermalOn: false,
  vigilOn: false,
  vigilTargetId: null,
  conduitsOn: true,
  filterQuery: null,
  beaconOpen: false,
  beaconTarget: null,
  watchIds: [],
  jumpMode: false,
  pipelinePick: null,
  visits: {},
  waypoints: [],
  stages: [],
  stageIds: null,
  histTick: 0,
  topZ: 1,
  autoFit: true,
  theme: (typeof localStorage !== 'undefined' && localStorage.getItem('canvasio:theme')) || 'midnight',
  appVolume: (() => {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('canvasio:volume') : null
    const n = v != null ? Number(v) : 0.85
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.85
  })(),

  setTheme: (id) => {
    try {
      localStorage.setItem('canvasio:theme', id)
    } catch {
      /* ignore */
    }
    set({ theme: id })
  },

  setAppVolume: (v) => {
    const vol = Math.min(1, Math.max(0, v))
    try {
      localStorage.setItem('canvasio:volume', String(vol))
    } catch {
      /* ignore */
    }
    set({ appVolume: vol })
  },

  musicRequest: null,
  requestMusic: (action, query) =>
    set((s) => ({ musicRequest: { action, query, token: (s.musicRequest?.token ?? 0) + 1 } })),
  setAutoFit: (v) => set({ autoFit: v }),

  addNode: (n) => {
    const id = n.id ?? nanoid(8)
    const topZ = get().topZ + 1
    const base: CanvasNode = {
      id,
      kind: n.kind,
      agent: n.agent,
      title: n.title ?? (n.agent ? nextName() : 'Node'),
      subtitle:
        n.subtitle ?? (n.agent ? AGENT_LABEL[n.agent].subtitle : n.kind === 'music' ? 'CanvasIO' : ''),
      x: n.x ?? 80 + Math.random() * 120,
      y: n.y ?? 80 + Math.random() * 80,
      w:
        n.w ??
        (n.kind === 'music'
          ? 430
          : n.kind === 'web'
            ? 560
            : n.kind === 'markdown'
              ? 480
              : n.kind === 'folder'
                ? 520
                : n.kind === 'calendar'
                  ? 560
                  : 540),
      h:
        n.h ??
        (n.kind === 'music'
          ? 430
          : n.kind === 'web'
            ? 420
            : n.kind === 'markdown'
              ? 500
              : n.kind === 'folder'
                ? 480
                : n.kind === 'calendar'
                  ? 480
                  : 360),
      z: topZ,
      command: n.command ?? (n.agent ? AGENT_LABEL[n.agent].command : undefined),
      url: n.url,
      cwd: n.cwd,
      // Markdown note file / folder browser directory. Pure node data; rides the
      // persistence `...rest` spread like url/cwd.
      filePath: n.filePath,
      dirPath: n.dirPath,
      status: n.status ?? 'idle',
      pendingPrompt: n.pendingPrompt,
      // Agent Objectives — auto-seed the goal from an explicit objective when
      // given, else from the node's initial task (pendingPrompt) so a spawned
      // agent always starts with a measurable mission. Only terminal nodes carry
      // an objective. Pure node data; the live progress reading derives elsewhere.
      objective:
        n.objective ??
        (n.kind === 'terminal' && n.pendingPrompt && n.pendingPrompt.trim()
          ? { text: objectiveTextFromPrompt(n.pendingPrompt) }
          : undefined),
      // No pre-assigned session id. EMPIRICAL (Claude Code 2.1.179): an
      // interactive claude does NOT honor a pre-assigned `--session-id` for
      // resumable persistence under our node-pty spawn (the legacy
      // projects/<cwd>/<uuid>.jsonl transcript is never written), so a preset
      // UUID is a dead resume key. Both claude AND codex now mint their own id;
      // TerminalView captures the REAL id afterward (claude from
      // ~/.claude/history.jsonl, codex from its rollout file) and persists it
      // here so a later restore can `--resume` the conversation that truly
      // exists on disk. An explicit caller-supplied id is still respected.
      sessionId: n.sessionId,
      // Mark as live-created so TerminalView may auto-run its command/boot the
      // agent TUI. Restored nodes never carry this flag (see loadLayout).
      fresh: true
    }
    set((s) => ({ nodes: [...s.nodes, base], topZ, selectedId: id }))
    return id
  },

  removeNode: (id) => {
    // Layout Time Machine — snapshot BEFORE the close so undo can resurrect the
    // node (and its persisted sessionId, so the agent can be --resumed). No-op
    // if the id isn't actually present, so a spurious close never bloats history.
    if (get().nodes.some((n) => n.id === id)) pushHistory('close', get().nodes)
    set((s) => ({
      nodes: s.nodes.filter((n) => n.id !== id),
      selectedId: s.selectedId === id ? null : s.selectedId,
      // If the spotlighted ("star") node is closed, release focus mode so the
      // remaining nodes don't stay dimmed with no star to read.
      focusNodeId: s.focusNodeId === id ? null : s.focusNodeId,
      // If the node currently being peeked is closed, drop the HUD flag (the
      // return-camera stash still springs back correctly on release).
      peekNodeId: s.peekNodeId === id ? null : s.peekNodeId,
      // Beacon — drop any pending jump signal aimed at the closed node so its
      // (now-gone) terminal can never be asked to scroll/highlight a dead line.
      beaconTarget: s.beaconTarget?.nodeId === id ? null : s.beaconTarget,
      // Watchtower — prune the closed node from the live-watch panel so a tile
      // can never point at a node that no longer exists.
      watchIds: s.watchIds.includes(id) ? s.watchIds.filter((w) => w !== id) : s.watchIds,
      // Stages — drop the closed id from any SAVED scene's member list (so a
      // scene never activates onto a gone node) and from the LIVE spotlight set
      // (so the dim/spotlight chrome never references a closed node). A scene
      // left empty by the prune is dropped entirely.
      stages: s.stages.some((st) => st.nodeIds.includes(id))
        ? s.stages
            .map((st) => ({ ...st, nodeIds: st.nodeIds.filter((n) => n !== id) }))
            .filter((st) => st.nodeIds.length > 0)
        : s.stages,
      stageIds:
        s.stageIds && s.stageIds.includes(id)
          ? (() => {
              const next = s.stageIds!.filter((n) => n !== id)
              return next.length ? next : null
            })()
          : s.stageIds
    }))
  },

  updateNode: (id, patch) =>
    set((s) => ({ nodes: s.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) })),

  // --- Agent Objectives: per-node goal (pure node-data writes) --------------
  setObjective: (nodeId, objective) =>
    set((s) => {
      if (!s.nodes.some((n) => n.id === nodeId)) return {}
      const text = (objective.text || '').trim()
      if (!text) return {}
      const checklist = (objective.checklist ?? [])
        .map((it) => ({ label: (it.label || '').trim(), done: !!it.done }))
        .filter((it) => it.label)
      const next: Objective = checklist.length ? { text, checklist } : { text }
      return { nodes: s.nodes.map((n) => (n.id === nodeId ? { ...n, objective: next } : n)) }
    }),

  clearObjective: (nodeId) =>
    set((s) => {
      const node = s.nodes.find((n) => n.id === nodeId)
      if (!node || !node.objective) return {}
      return { nodes: s.nodes.map((n) => (n.id === nodeId ? { ...n, objective: undefined } : n)) }
    }),

  toggleChecklistItem: (nodeId, idx) =>
    set((s) => {
      const node = s.nodes.find((n) => n.id === nodeId)
      const list = node?.objective?.checklist
      if (!node || !list || idx < 0 || idx >= list.length) return {}
      const checklist = list.map((it, i) => (i === idx ? { ...it, done: !it.done } : it))
      return {
        nodes: s.nodes.map((n) =>
          n.id === nodeId ? { ...n, objective: { ...node.objective!, checklist } } : n
        )
      }
    }),

  bringToFront: (id) =>
    set((s) => {
      const topZ = s.topZ + 1
      return { topZ, nodes: s.nodes.map((n) => (n.id === id ? { ...n, z: topZ } : n)) }
    }),

  select: (id) => set({ selectedId: id }),

  centerOnNode: (id) => {
    const node = get().nodes.find((n) => n.id === id)
    if (!node) return
    // Wayback — record this visit at the SINGLE chokepoint every user-driven jump
    // funnels through (Beacon, Lighthouse, Tab, Triage, Constellation, AgentLens,
    // PulseRadar, Changeset). Skipped while an automated tour has paused recording
    // (Replay/Director) so a passive flythrough never pollutes real work history.
    // In-memory only; never persisted, never IPC.
    if (!recordingPaused) {
      set((s) => {
        const prev = s.visits[id]
        return {
          visits: {
            ...s.visits,
            [id]: { count: (prev?.count ?? 0) + 1, lastTs: Date.now() }
          }
        }
      })
    }
    // Slipstream — record where we are BEFORE flying away (skipped automatically
    // during a back/forward traversal via the `traversing` guard). focusDirection
    // and cycleNode both funnel through centerOnNode, so recording here covers the
    // whole Lighthouse + Beacon jump set without double-pushing.
    pushCameraHistory(get().camera)
    set((s) => ({ histTick: s.histTick + 1 }))
    // Target camera frames JUST this node (camera-only; cameraForBounds clamps
    // zoom to <=1 so terminal text stays crisp). Disable autoFit so a later
    // resize doesn't yank the camera back to the whole-scene frame.
    const target = cameraForBounds({
      minX: node.x,
      minY: node.y,
      maxX: node.x + node.w,
      maxY: node.y + node.h
    })
    // Select + raise immediately so the destination node is visibly active
    // while the camera travels to it.
    set({ selectedId: id, autoFit: false })
    get().bringToFront(id)

    // Behavior-preserving extraction: the eased camera lerp (flyRaf cancel, the
    // NaN/already-there guards, the 280ms ease-out-cubic) now lives in the shared
    // flyCameraTo helper, reused verbatim by goWaypoint.
    flyCameraTo(set, () => get().camera, target)
  },

  // --- Districts: fly the camera to a region's bounds -----------------------
  centerOnBounds: (b) => {
    if (
      !b ||
      ![b.x, b.y, b.w, b.h].every(Number.isFinite) ||
      b.w <= 0 ||
      b.h <= 0
    )
      return
    // Slipstream — record the current view before flying away (the same history
    // participation centerOnNode/goWaypoint get). Disable autoFit so a later
    // resize doesn't yank the camera off the District.
    pushCameraHistory(get().camera)
    set((s) => ({ autoFit: false, histTick: s.histTick + 1 }))
    const target = cameraForBounds({
      minX: b.x,
      minY: b.y,
      maxX: b.x + b.w,
      maxY: b.y + b.h
    })
    flyCameraTo(set, () => get().camera, target)
  },

  // --- Waypoints: spatial bookmarks (camera-only saved views) ---------------
  saveWaypoint: (name) =>
    set((s) => {
      const cam = s.camera
      // Snapshot a fresh, finite copy of the current camera (pure data).
      const wp: Waypoint = {
        id: nanoid(8),
        name: (name && name.trim()) || `Vista ${s.waypoints.length + 1}`,
        cam: { x: cam.x, y: cam.y, zoom: cam.zoom }
      }
      // Cap at MAX_WAYPOINTS, dropping the OLDEST so 1..9 keys stay mapped.
      const next = [...s.waypoints, wp].slice(-MAX_WAYPOINTS)
      return { waypoints: next }
    }),

  goWaypoint: (id) => {
    const wp = get().waypoints.find((w) => w.id === id)
    if (!wp) return
    // Slipstream — record the current view before teleporting to the waypoint.
    pushCameraHistory(get().camera)
    // Disable autoFit so a later resize doesn't yank the camera back to the
    // whole-scene frame, then fly to the saved camera with the shared tween.
    set((s) => ({ autoFit: false, histTick: s.histTick + 1 }))
    flyCameraTo(set, () => get().camera, wp.cam)
  },

  renameWaypoint: (id, name) =>
    set((s) => ({
      waypoints: s.waypoints.map((w) =>
        w.id === id ? { ...w, name: name.trim() || w.name } : w
      )
    })),

  removeWaypoint: (id) =>
    set((s) => ({ waypoints: s.waypoints.filter((w) => w.id !== id) })),

  // --- Stages: curated multi-node scenes (named, persisted working sets) -----
  captureStage: (name) => {
    const s = get()
    const present = new Set(s.nodes.map((n) => n.id))
    // Resolve the working set, in priority: the single selection, else the
    // current Constellation Filter matches (the open filter pill). Pruned to live
    // nodes + de-duped. Capturing NOTHING when there is no selection and no active
    // filter is intentional (no-op) so a stray ⌘⇧S never saves an empty scene.
    let ids: string[] = []
    if (s.selectedId && present.has(s.selectedId)) ids = [s.selectedId]
    else if (s.filterQuery != null) ids = pruneStageIds(s.filterMatches(), present)
    ids = pruneStageIds(ids, present)
    if (!ids.length) return
    const stage: Stage = {
      id: nanoid(8),
      name: (name && name.trim()) || `Escena ${s.stages.length + 1}`,
      nodeIds: ids
    }
    // Cap at MAX_STAGES, dropping the OLDEST so ⌘⇧1..9 keys stay mapped.
    set({ stages: [...s.stages, stage].slice(-MAX_STAGES) })
  },

  activateStage: (id) => {
    const s = get()
    const stage = s.stages.find((st) => st.id === id)
    if (!stage) return
    const present = new Set(s.nodes.map((n) => n.id))
    const ids = pruneStageIds(stage.nodeIds, present)
    if (!ids.length) return // every member node is gone; nothing to frame/isolate
    // Spotlight the subset (pure CSS via NodeView's stageIds selector).
    set({ stageIds: ids })
    // Frame the collective bounding box via the SHARED boundsOf() + the existing
    // cameraForBounds, applied through setCameraTracked so the move joins
    // Slipstream Back/Forward. Disable autoFit so a later resize doesn't yank the
    // camera off the scene. CAMERA-ONLY: no geometry mutation, no IPC.
    const b = boundsOf(s.nodes, ids)
    if (b) {
      set({ autoFit: false })
      get().setCameraTracked(cameraForBounds(b))
    }
  },

  clearStage: () => set((s) => (s.stageIds != null ? { stageIds: null } : {})),

  renameStage: (id, name) =>
    set((s) => ({
      stages: s.stages.map((st) => (st.id === id ? { ...st, name: name.trim() || st.name } : st))
    })),

  removeStage: (id) =>
    set((s) => {
      const target = s.stages.find((st) => st.id === id)
      if (!target) return {}
      // Release the live isolation when the deleted scene's exact node set is the
      // one currently spotlit (same membership, order-independent) — so a node
      // can never stay dimmed pointing at a scene that no longer exists. A
      // different active scene is left untouched.
      const active = s.stageIds
      const isActive =
        !!active &&
        active.length === target.nodeIds.length &&
        new Set(active).size === new Set([...active, ...target.nodeIds]).size
      return {
        stages: s.stages.filter((st) => st.id !== id),
        stageIds: isActive ? null : active
      }
    }),

  // --- Lighthouse: directional spatial hop ---------------------------------
  focusDirection: (dir) => {
    const nodes = get().nodes
    if (nodes.length < 2) {
      // With 0 or 1 nodes there is no neighbor to hop to. If there's a single
      // node and nothing selected, still select it so the user has an anchor.
      if (nodes.length === 1 && !get().selectedId) get().centerOnNode(nodes[0].id)
      return
    }
    const center = (n: CanvasNode): { cx: number; cy: number } => ({
      cx: n.x + n.w / 2,
      cy: n.y + n.h / 2
    })
    // Active node: the current selection, else the node nearest the scene center.
    let active = nodes.find((n) => n.id === get().selectedId)
    if (!active) {
      const b = sceneBounds(nodes)
      if (b) {
        const sx = (b.minX + b.maxX) / 2
        const sy = (b.minY + b.maxY) / 2
        active = nodes.reduce((best, n) => {
          const c = center(n)
          const d = (c.cx - sx) ** 2 + (c.cy - sy) ** 2
          const bc = center(best)
          const bd = (bc.cx - sx) ** 2 + (bc.cy - sy) ** 2
          return d < bd ? n : best
        }, nodes[0])
      } else {
        active = nodes[0]
      }
    }
    const a = center(active)
    // Unit vector for the pressed direction (screen coords: +y is down).
    const ux = dir === 'left' ? -1 : dir === 'right' ? 1 : 0
    const uy = dir === 'up' ? -1 : dir === 'down' ? 1 : 0
    let best: CanvasNode | null = null
    let bestScore = -Infinity
    for (const n of nodes) {
      if (n.id === active.id) continue
      const c = center(n)
      const dx = c.cx - a.cx
      const dy = c.cy - a.cy
      const dist = Math.hypot(dx, dy)
      if (dist < 1) continue
      // Dot product of the offset against the direction unit vector: positive
      // means the candidate is on that side. Require it to be meaningfully in
      // the pressed direction (not merely perpendicular).
      const dot = dx * ux + dy * uy
      if (dot <= 0) continue
      // alignment in [0,1]: 1 = perfectly in the pressed direction.
      const alignment = dot / dist
      if (alignment < 0.35) continue
      // Prefer well-aligned AND near candidates: reward alignment, penalize
      // distance. Same scale as a "walk one step" feel.
      const score = alignment * 1000 - dist
      if (score > bestScore) {
        bestScore = score
        best = n
      }
    }
    if (best) get().centerOnNode(best.id)
  },

  cycleNode: (dir) => {
    const nodes = get().nodes
    if (!nodes.length) return
    // (y,x) reading order, same ordering language as arrange().
    const ordered = [...nodes].sort((a, b) => a.y - b.y || a.x - b.x)
    const cur = ordered.findIndex((n) => n.id === get().selectedId)
    const len = ordered.length
    // From no selection: +1 starts at the first, -1 at the last.
    const next = cur < 0 ? (dir === 1 ? 0 : len - 1) : (cur + dir + len) % len
    get().centerOnNode(ordered[next].id)
  },

  setFocusMode: (on) => {
    if (!on) {
      set({ focusNodeId: null })
      return
    }
    const id = get().selectedId
    if (!id || !get().nodes.some((n) => n.id === id)) return // need a valid selection
    set({ focusNodeId: id })
    get().centerOnNode(id)
  },

  toggleFocusMode: () => get().setFocusMode(get().focusNodeId == null),

  // --- Thermal: Activity Heat overlay + "fly to hottest" -------------------
  toggleThermal: () => set((s) => ({ thermalOn: !s.thermalOn })),

  // --- Vigil: Live Follow-Cam auto-pilot toggle ----------------------------
  toggleVigil: () => {
    const next = !get().vigilOn
    if (next) {
      set({ vigilOn: true, vigilTargetId: null })
      // Start the self-cancelling interval driver; it captures get/set so it can
      // re-evaluate the hottest node live and update the follow target.
      startVigilTimer(get, (id) => set({ vigilTargetId: id }))
    } else {
      stopVigilTimer()
      set({ vigilOn: false, vigilTargetId: null })
    }
  },

  toggleConduits: () => set((s) => ({ conduitsOn: !s.conduitsOn })),

  // --- Watchtower: pinned live-watch panel ---------------------------------
  pinWatch: (id) =>
    set((s) => {
      // No-op if unknown, already pinned, the panel is full, or it's the node you
      // are already looking at (selected/centered) — no point watching it.
      if (
        s.watchIds.includes(id) ||
        s.watchIds.length >= MAX_WATCH ||
        s.selectedId === id ||
        !s.nodes.some((n) => n.id === id)
      ) {
        return {}
      }
      return { watchIds: [...s.watchIds, id] }
    }),
  unpinWatch: (id) =>
    set((s) => (s.watchIds.includes(id) ? { watchIds: s.watchIds.filter((w) => w !== id) } : {})),
  toggleWatch: (id) =>
    get().watchIds.includes(id) ? get().unpinWatch(id) : get().pinWatch(id),
  clearWatch: () => set((s) => (s.watchIds.length ? { watchIds: [] } : {})),

  // --- Jump Hints: ace-jump teleport ---------------------------------------
  setJumpMode: (on) => set({ jumpMode: on }),
  toggleJumpMode: () => set((s) => ({ jumpMode: !s.jumpMode })),

  // --- Slipstream Pipeline Walk: traverse the relay handoff graph by keyboard ----
  walkPipeline: (dir) => {
    const nodes = get().nodes
    if (!nodes.length) return
    // The walk pivots on the current selection (the same anchor Lighthouse/Tab use).
    // With nothing selected there is no "current stage" to walk from, so no-op
    // rather than guessing — pressing Tab/; first establishes a selection.
    const current = get().selectedId
    if (!current || !nodes.some((n) => n.id === current)) return
    // Read the live relay graph lazily (call-time only; same useRelay.getState()
    // discipline flowLayout uses). Only nodes still on the canvas are valid hops.
    const rules = useRelay.getState().rules
    const existing = new Set(nodes.map((n) => n.id))
    // Frecency breaks candidate-order ties so the branch picker's labels surface
    // the most-likely partner first; it never auto-picks a multi-partner branch.
    const res = pickWalkTarget(current, dir, rules, existing, get().visits)
    if (res.targetId) {
      // Single partner -> hop straight through centerOnNode (inherits Slipstream
      // back/forward, Wayback frecency, and Loupe history for free). Clear any
      // stale branch flag so the picker never lingers after a clean hop.
      set({ pipelinePick: null })
      get().centerOnNode(res.targetId)
      return
    }
    if (res.candidates && res.candidates.length) {
      // Multiple partners -> hand off to PipelinePicker via the transient flag.
      set({ pipelinePick: { dir, candidates: res.candidates } })
      return
    }
    // Dead end (no partner in this direction): clear any pending branch, no move.
    if (get().pipelinePick) set({ pipelinePick: null })
  },

  clearPipelinePick: () => set((s) => (s.pipelinePick ? { pipelinePick: null } : {})),

  // --- Constellation Filter: live in-canvas multi-node search & isolate -----
  setFilter: (q) => set({ filterQuery: q }),

  filterMatches: () => {
    const q = get().filterQuery
    if (q == null) return []
    const needle = q.trim().toLowerCase()
    const nodes = get().nodes
    // An empty query matches every node (the pill is open but nothing typed yet).
    if (!needle) return nodes.map((n) => n.id)
    return nodes
      .filter((n) => {
        const agentLabel = n.agent ? AGENT_LABEL[n.agent].title : ''
        const hay = `${n.title} ${n.subtitle ?? ''} ${agentLabel} ${n.status ?? ''}`.toLowerCase()
        return hay.includes(needle)
      })
      .map((n) => n.id)
  },

  frameMatches: () => {
    const ids = new Set(get().filterMatches())
    if (ids.size === 0) return // never throw / never move on an empty set
    // Union the matched node boxes via the shared boundsOf() helper (the same
    // box-union Stages' activateStage uses), then frame them through the EXISTING
    // camera helpers. Apply via setCameraTracked so the move joins Slipstream
    // Back/Forward history.
    const b = boundsOf(get().nodes, ids)
    if (!b) return
    const target = cameraForBounds(b)
    // Disable autoFit so a later resize doesn't yank the camera off the matched
    // subset, then commit the move (tracked for Back/Forward).
    set({ autoFit: false })
    get().setCameraTracked(target)
  },

  // --- Beacon: full-text scrollback search (transient flags only) -----------
  openBeacon: () => set({ beaconOpen: true }),
  closeBeacon: () => set({ beaconOpen: false, beaconTarget: null }),
  beaconJump: (nodeId, line) => {
    if (!get().nodes.some((n) => n.id === nodeId)) return
    // Bump a monotonic token so re-jumping to the SAME nodeId+line still fires the
    // TerminalOverlay subscriber (value-equality would otherwise swallow it).
    set((s) => ({
      beaconTarget: { nodeId, line, token: (s.beaconTarget?.token ?? 0) + 1 }
    }))
    // Funnel the camera move through the single centerOnNode chokepoint (selects +
    // raises + records Slipstream/Wayback), exactly like every other jump primitive.
    get().centerOnNode(nodeId)
  },

  // --- Loupe: drag-a-box marquee zoom (camera-only) -------------------------
  frameRegion: (box) => {
    if (
      !box ||
      ![box.minX, box.minY, box.maxX, box.maxY].every(Number.isFinite) ||
      box.maxX <= box.minX ||
      box.maxY <= box.minY
    )
      return
    const target = cameraForBounds(box)
    // Disable autoFit so a later resize doesn't yank the camera off the framed
    // region, then commit the move (tracked for Slipstream Back/Forward + Wayback).
    set({ autoFit: false })
    get().setCameraTracked(target)
  },

  flyToHottest: () => {
    const nodes = get().nodes
    if (!nodes.length) return
    // Compute heat from the live mission timeline (pure), then pick the hottest
    // node that is still present on the canvas, and reuse the existing camera
    // tween. Camera-only: no geometry mutation, no IPC, not persisted.
    const heat = computeHeat(useMission.getState().events, Date.now())
    const id = hottestNodeId(heat, new Set(nodes.map((n) => n.id)))
    if (id) get().centerOnNode(id)
  },

  // --- Triage Jump: attention-priority traversal ---------------------------
  cycleAttention: (dir = 'next') => {
    const nodes = get().nodes
    if (!nodes.length) return
    // Build the priority-ordered queue from the live mission timeline (pure).
    const queue = attentionQueue(nodes, useMission.getState().events, Date.now())
    if (!queue.length) return
    const len = queue.length
    const cur = queue.indexOf(get().selectedId ?? '')
    // From outside the queue: 'next' starts at the head (highest priority), 'prev'
    // at the tail. Within it, advance/retreat with wraparound.
    const next =
      cur < 0 ? (dir === 'next' ? 0 : len - 1) : (cur + (dir === 'next' ? 1 : -1) + len) % len
    get().centerOnNode(queue[next])
  },

  // --- Spyglass: transient hold-to-peek ------------------------------------
  peekTargetId: () => {
    const nodes = get().nodes
    if (!nodes.length) return null
    // Prefer the current selection when it still exists.
    const sel = get().selectedId
    if (sel && nodes.some((n) => n.id === sel)) return sel
    // Else the node nearest the scene center (same logic as focusDirection's
    // fallback active-node pick).
    const b = sceneBounds(nodes)
    if (!b) return nodes[0].id
    const sx = (b.minX + b.maxX) / 2
    const sy = (b.minY + b.maxY) / 2
    const best = nodes.reduce((acc, n) => {
      const cx = n.x + n.w / 2
      const cy = n.y + n.h / 2
      const d = (cx - sx) ** 2 + (cy - sy) ** 2
      const acx = acc.x + acc.w / 2
      const acy = acc.y + acc.h / 2
      const ad = (acx - sx) ** 2 + (acy - sy) ** 2
      return d < ad ? n : acc
    }, nodes[0])
    return best.id
  },

  peekAt: (id) => {
    if (!id) return
    const node = get().nodes.find((n) => n.id === id)
    if (!node) return
    // First peek stashes a finite copy of the live camera as the return view.
    // A second peek while already peeking just retargets (keep the stash).
    if (peekReturn == null) {
      const cam = get().camera
      peekReturn = { x: cam.x, y: cam.y, zoom: cam.zoom }
    }
    // Guard so the fly below does NOT push Slipstream history (a peek is a
    // transient, non-committing move). Deliberately do NOT change selectedId,
    // autoFit, or z-order — a peek is read-only over the workspace.
    peeking = true
    const target = cameraForBounds({
      minX: node.x,
      minY: node.y,
      maxX: node.x + node.w,
      maxY: node.y + node.h
    })
    flyCameraTo(set, () => get().camera, target)
    set({ peekNodeId: id })
  },

  endPeek: () => {
    if (peekReturn == null) {
      // Nothing in flight; just make sure the HUD flag is cleared.
      if (get().peekNodeId != null) set({ peekNodeId: null })
      peeking = false
      return
    }
    const back = peekReturn
    flyCameraTo(set, () => get().camera, back)
    peekReturn = null
    peeking = false
    set({ peekNodeId: null })
  },

  // --- Slipstream: spatial Back/Forward ------------------------------------
  cameraBack: () => {
    const nav = getCameraNav()
    if (!nav.canBack) return
    traversing = true
    try {
      if (liveAhead) {
        // First Back after a jump: the live (unstored) view is ahead of the tip.
        // Append it as the forward anchor so Forward can return here, then fly to
        // the stored departure at camIndex (camIndex is unchanged: it now points
        // at the entry we're flying to; the appended live view sits at +1).
        const live = get().camera
        camHistory.push({ x: live.x, y: live.y, zoom: live.zoom })
        liveAhead = false
      } else {
        camIndex--
      }
      set((s) => ({ autoFit: false, histTick: s.histTick + 1 }))
      flyCameraTo(set, () => get().camera, camHistory[camIndex])
    } finally {
      traversing = false
    }
  },

  cameraForward: () => {
    const nav = getCameraNav()
    if (!nav.canForward) return
    traversing = true
    try {
      camIndex++
      set((s) => ({ autoFit: false, histTick: s.histTick + 1 }))
      flyCameraTo(set, () => get().camera, camHistory[camIndex])
    } finally {
      traversing = false
    }
  },

  setCameraTracked: (c) => {
    pushCameraHistory(get().camera)
    set((s) => ({ camera: { ...s.camera, ...c }, histTick: s.histTick + 1 }))
  },

  clearCameraHistory: () => {
    clearCameraHistory()
    set((s) => ({ histTick: s.histTick + 1 }))
  },

  // --- Wayback: frecency recents + ` quick-switch --------------------------
  frecencyOrder: () => {
    const visits = get().visits
    const now = Date.now()
    // Score = frequency term (diminishing returns via log2) + recency term that
    // decays with a ~10 minute half-life. Restricted to nodes still present.
    const live = new Set(get().nodes.map((n) => n.id))
    const HALF_LIFE_MS = 10 * 60 * 1000
    const scored: { id: string; score: number }[] = []
    for (const id of Object.keys(visits)) {
      if (!live.has(id)) continue
      const v = visits[id]
      const freq = Math.log2(v.count + 1)
      const age = Math.max(0, now - v.lastTs)
      const recency = Math.pow(0.5, age / HALF_LIFE_MS)
      scored.push({ id, score: freq + recency })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.map((s) => s.id)
  },

  lastTwoVisited: () => {
    const visits = get().visits
    const live = new Set(get().nodes.map((n) => n.id))
    const byRecent = Object.keys(visits)
      .filter((id) => live.has(id))
      .sort((a, b) => visits[b].lastTs - visits[a].lastTs)
    return [byRecent[0] ?? null, byRecent[1] ?? null]
  },

  quickSwitch: () => {
    const prev = get().lastTwoVisited()[1]
    if (!prev) return // need at least 2 distinct visited nodes still on canvas
    get().centerOnNode(prev)
  },

  clearVisits: () => set({ visits: {} }),

  // --- Layout Time Machine: spatial undo/redo ------------------------------
  snapshotForGesture: (label) => {
    // Captured once at a gesture's START (drag-move / resize) by the views, so a
    // whole gesture is a single undo step. No-op with no nodes.
    if (get().nodes.length) pushHistory(label, get().nodes)
  },

  applyNodes: (incoming) => {
    // Restore a snapshot, pruning any transient id that no longer points at a
    // node in the restored set (same pruning contract as removeNode). Geometry-
    // only: the camera is left to Slipstream/Wayback. Snapshots already had the
    // `fresh` flag stripped, so restored terminals won't re-run their command.
    set((s) => {
      const ids = new Set(incoming.map((n) => n.id))
      const topZ = incoming.reduce((m, n) => Math.max(m, Number.isFinite(n.z) ? n.z : 1), 1)
      return {
        nodes: incoming.map((n) => ({ ...n })),
        selectedId: s.selectedId && ids.has(s.selectedId) ? s.selectedId : null,
        focusNodeId: s.focusNodeId && ids.has(s.focusNodeId) ? s.focusNodeId : null,
        peekNodeId: s.peekNodeId && ids.has(s.peekNodeId) ? s.peekNodeId : null,
        watchIds: s.watchIds.filter((w) => ids.has(w)),
        // Stages — prune saved scenes + the live spotlight set to the restored
        // node ids (same pruning contract as watchIds), dropping a scene that
        // ends up empty, so an undo/redo can never leave a scene/spotlight
        // pointing at a node absent from the restored snapshot.
        stages: s.stages
          .map((st) => ({ ...st, nodeIds: pruneStageIds(st.nodeIds, ids) }))
          .filter((st) => st.nodeIds.length > 0),
        stageIds: s.stageIds ? (pruneStageIds(s.stageIds, ids).length ? pruneStageIds(s.stageIds, ids) : null) : null,
        // Keep topZ at least as high as before so a future bringToFront still
        // raises above everything (never lower it on a restore).
        topZ: Math.max(s.topZ, topZ)
      }
    })
  },

  undo: () => {
    const snap = takeUndo(get().nodes)
    if (!snap) return
    get().applyNodes(snap.nodes)
  },

  redo: () => {
    const snap = takeRedo(get().nodes)
    if (!snap) return
    get().applyNodes(snap.nodes)
  },

  setCamera: (c) => set((s) => ({ camera: { ...s.camera, ...c } })),

  panBy: (dx, dy) =>
    set((s) => ({ autoFit: false, camera: { ...s.camera, x: s.camera.x + dx, y: s.camera.y + dy } })),

  zoomAt: (clientX, clientY, delta) =>
    set((s) => {
      const { x, y, zoom } = s.camera
      const next = Math.min(2.5, Math.max(0.2, zoom * (1 - delta * 0.0015)))
      // keep the point under the cursor fixed
      const wx = (clientX - x) / zoom
      const wy = (clientY - y) / zoom
      return {
        autoFit: false,
        camera: {
          zoom: next,
          x: clientX - wx * next,
          y: clientY - wy * next
        }
      }
    }),

  resetView: () => get().arrange(),

  // Responsive tiling: lay the nodes out in an organized grid that fills the
  // available viewport AT ZOOM 1.0. Because nothing is CSS-scaled, terminals
  // re-render crisply at their new pixel size (no blur). Re-runs on resize.
  arrange: (spec?: number | string) => {
    const nodes = get().nodes
    if (!nodes.length) {
      set({ autoFit: true, camera: { x: 0, y: 0, zoom: 1 } })
      return
    }
    // Layout Time Machine — snapshot BEFORE bulk-repositioning EVERY node so a
    // single keystroke that reshuffles the whole canvas is fully reversible.
    pushHistory('arrange', nodes)

    // File-backed nodes (markdown notes, folders, calendar) are small reference
    // surfaces — they should NOT each eat a full grid cell. Group them, COLLAPSED
    // to icon chips, into ONE cell of the grid; the big windows (terminal/web/
    // music) get the rest of the cells as before.
    const FILE_KINDS = new Set<string>(['markdown', 'folder', 'calendar'])
    const fileNodes = nodes.filter((nd) => FILE_KINDS.has(nd.kind))
    const mainNodes = [...nodes.filter((nd) => !FILE_KINDS.has(nd.kind))].sort(
      (a, b) => a.y - b.y || a.x - b.x
    )
    const hasFiles = fileNodes.length > 0

    // Each main node is a grid slot; ALL the file nodes share ONE extra slot.
    const slots = mainNodes.length + (hasFiles ? 1 : 0)
    // Density: explicit arg (voice/menu "arrange at N") wins; else the persisted
    // default (TopBar density popover). Never exceed the slot count (no empty
    // columns) and never drop below 1. Higher cols = smaller/denser grid.
    const grid = resolveArrangeGrid(spec, slots, window.innerWidth / Math.max(1, window.innerHeight))
    // BALANCED grid (not N full-height columns): pick a column count that keeps
    // cells landscape-ish for the ACTUAL slot count, bounded by the user's max
    // (`want`). A few windows become a tidy 3x2 grid instead of 3 full-height cols.
    // grid (cols/rows/explicit) was resolved above via resolveArrangeGrid.
    const cols =
      slots <= 1
        ? 1
        : grid.cols
    const FILE_SLOT = ' file-cluster'
    const slotIds: string[] = mainNodes.map((nd) => nd.id)
    if (hasFiles) slotIds.push(FILE_SLOT)
    const columns: string[][] = Array.from({ length: cols }, () => [])
    slotIds.forEach((id, i) => columns[i % cols].push(id))

    // Cell geometry — same CHROME-based avail box / gap / sizing as tileColumns.
    const vw = window.innerWidth
    const vh = window.innerHeight
    const availX = CHROME.left
    const availY = CHROME.top
    const availW = Math.max(240, vw - CHROME.left - CHROME.right)
    const availH = Math.max(180, vh - CHROME.top - CHROME.bottom)
    const gap = 16
    const filledRows = Math.max(1, ...columns.map((c) => c.length))
    // Explicit 'CxR' grid uses its chosen R rows for cell HEIGHT (so cells match
    // the picked density, e.g. 5x5 makes small cells); 'auto' uses filled rows.
    const maxRows = grid.explicit ? grid.rows : filledRows
    const cellW = Math.floor((availW - gap * (cols - 1)) / cols)
    // CAP the cell height so a single-row layout never blows windows up to the
    // FULL canvas height (the "columns ocupan todo el alto" bug). Capped cells are
    // a pleasant landscape size; the grid block is centered vertically below.
    const MAX_CELL_H = 460
    const rawCellH = Math.floor((availH - gap * (maxRows - 1)) / maxRows)
    const cellH = Math.max(140, Math.min(rawCellH, MAX_CELL_H))
    const gridBlockH = maxRows * cellH + gap * (maxRows - 1)
    const cellOffY = Math.max(0, Math.floor((availH - gridBlockH) / 2))

    const mainById = new Map(mainNodes.map((nd) => [nd.id, nd] as const))
    const placedById = new Map<string, CanvasNode>()
    columns.forEach((colIds, c) => {
      colIds.forEach((id, r) => {
        const cx = Math.round(availX + c * (cellW + gap))
        const cy = Math.round(availY + cellOffY + r * (cellH + gap))
        if (id === FILE_SLOT) {
          // Pack file nodes as the same 72×72 collapsed icon chips rendered by
          // NodeView. Keeping this geometry in sync prevents a phantom 128×52
          // footprint from leaving large gaps when Arrange groups references.
          const CHIP_W = 72
          const CHIP_H = 72
          const ig = 10
          const perRow = Math.max(1, Math.floor((cellW + ig) / (CHIP_W + ig)))
          fileNodes.forEach((fn, k) => {
            const ir = Math.floor(k / perRow)
            const ic = k % perRow
            placedById.set(fn.id, {
              ...fn,
              collapsed: true,
              x: cx + ic * (CHIP_W + ig),
              y: cy + ir * (CHIP_H + ig)
            })
          })
        } else {
          const node = mainById.get(id)!
          placedById.set(id, { ...node, x: cx, y: cy, w: cellW, h: cellH })
        }
      })
    })

    // Re-place at EXACTLY zoom 1.0 (no CSS scale → crisp xterm text). Drawing
    // shapes are never moved. Preserve the original node array order.
    const placed = nodes.map((nd) => placedById.get(nd.id) ?? nd)
    set({ autoFit: true, camera: { x: 0, y: 0, zoom: 1 }, nodes: placed })
  },

  // --- Cascade: stack the windows like a pile -------------------------------
  // The agent-facing "apila/cascada" verb. Like arrange()/flowLayout() it is a
  // CAMERA+GEOMETRY one-shot at zoom 1.0 with the SAME mutation surface, but it
  // PILES nodes diagonally instead of gridding them. COLLAPSED file chips keep
  // their size and are skipped from the diagonal stepping (they stay where they
  // are), so cascade never blows up a reference chip into a full window. Later
  // nodes get higher z (front of the pile). Single undo step via pushHistory.
  cascade: () => {
    const nodes = get().nodes
    const movable = nodes.filter((n) => !n.collapsed)
    if (!movable.length) {
      set({ autoFit: true, camera: { x: 0, y: 0, zoom: 1 } })
      return
    }
    // Layout Time Machine — snapshot BEFORE piling so one cascade is fully
    // reversible (z is part of the snapshot, so undo restores stacking too).
    pushHistory('cascade', nodes)

    const vw = window.innerWidth
    const vh = window.innerHeight
    const availW = Math.max(240, vw - CHROME.left - CHROME.right)
    const availH = Math.max(180, vh - CHROME.top - CHROME.bottom)
    // Stable, deterministic pile order (matches arrange()'s reading-order feel).
    const ordered = [...movable].sort((a, b) => a.y - b.y || a.x - b.x)
    // Wrap to a new column when the next step would push a window off-screen.
    const wrapAt = Math.max(1, Math.floor(Math.min(availH, availW) / CASCADE_DY) - 1)
    let baseZ = get().topZ
    const placedById = new Map<string, CanvasNode>()
    ordered.forEach((node, i) => {
      const colIndex = Math.floor(i / wrapAt)
      const stepInCol = i % wrapAt
      const x = Math.round(
        CHROME.left + colIndex * (CASCADE_DX * wrapAt + 48) + stepInCol * CASCADE_DX
      )
      const y = Math.round(CHROME.top + stepInCol * CASCADE_DY)
      baseZ += 1
      placedById.set(node.id, { ...node, x, y, z: baseZ })
    })

    const placed = nodes.map((n) => placedById.get(n.id) ?? n)
    set({
      autoFit: true,
      camera: { x: 0, y: 0, zoom: 1 },
      nodes: placed,
      topZ: baseZ // keep topZ above every assigned z so a later bringToFront still wins
    })
  },

  // --- Declutter: Layout-Preserving Overlap Resolver ------------------------
  // The OPPOSITE verb to arrange()/flowLayout(): instead of blindly re-gridding
  // EVERY node and resetting the camera (which nukes your spatial memory), this
  // nudges apart ONLY the nodes that actually overlap and leaves every other node
  // exactly where it is. CRITICAL safety mirrors of arrange(): the CAMERA is
  // UNTOUCHED, autoFit is UNTOUCHED, drawing shapes are never read/written, and
  // there is no IPC. The selectedId is passed as the anchor so the focused node
  // stays pinned. No history push and no set() when nothing overlaps, so it is a
  // true no-op (zero cost) on an already-clean layout and can never regress one.
  declutter: () => {
    const nodes = get().nodes
    if (nodes.length < 2) return
    const moved = resolveOverlaps(
      nodes.map((n) => ({ id: n.id, x: n.x, y: n.y, w: n.w, h: n.h })),
      { anchorId: get().selectedId }
    )
    // Nothing overlapped — leave the layout (and history) completely untouched.
    if (moved.size === 0) return
    // Layout Time Machine — snapshot BEFORE nudging so a single Declutter is one
    // fully-reversible undo step, exactly like arrange()/flowLayout().
    pushHistory('declutter', nodes)
    set({
      nodes: nodes.map((n) => {
        const p = moved.get(n.id)
        return p ? { ...n, x: p.x, y: p.y } : n
      })
    })
  },

  // --- Flow Layout: Relay-aware pipeline auto-arrange -----------------------
  // Turn the latent Agent Relay handoff graph into space: layer nodes by their
  // position in the {sourceId -> targetId} DAG and tile them as left-to-right
  // pipeline columns at zoom 1.0 (same crisp tiling + mutation surface as
  // arrange()). Drawing shapes are never moved. Falls back to arrange() when
  // there is no graph so it can never regress the empty/no-graph case.
  flowLayout: () => {
    const nodes = get().nodes
    // Read the relay graph (statically imported above; relay.ts imports nothing
    // from canvas.ts, so no cycle — same pattern as resetRelayAndMission).
    const rules = useRelay.getState().rules
    // Graceful fallback: with no graph (or too few nodes to form a pipeline)
    // there is nothing to lay out by handoffs — defer to the grid arrange().
    if (rules.length === 0 || nodes.length < 2) {
      get().arrange()
      return
    }

    const ids = new Set(nodes.map((n) => n.id))
    // Build adjacency + in-degree restricted to currently-existing nodes. A rule
    // may reference a node that was since closed; ignore those edges entirely.
    const out = new Map<string, Set<string>>()
    const indeg = new Map<string, number>()
    for (const n of nodes) {
      out.set(n.id, new Set())
      indeg.set(n.id, 0)
    }
    for (const r of rules) {
      if (r.sourceId === r.targetId) continue // defensive (addRule forbids it)
      if (!ids.has(r.sourceId) || !ids.has(r.targetId)) continue
      const dst = out.get(r.sourceId)!
      if (!dst.has(r.targetId)) {
        dst.add(r.targetId)
        indeg.set(r.targetId, (indeg.get(r.targetId) ?? 0) + 1)
      }
    }

    // Longest-path (Kahn topological) layering: a node's layer is 1 + the max
    // layer of any of its sources, so a handoff always lands one column to the
    // right of its upstream agent. Cycle-safe: we cap total processing at
    // nodes.length iterations and assign any node still unresolved (a relay loop)
    // to the deepest known layer, so a loop can never hang the layout.
    const layer = new Map<string, number>()
    const deg = new Map(indeg)
    let frontier = nodes.filter((n) => (deg.get(n.id) ?? 0) === 0).map((n) => n.id)
    for (const id of frontier) layer.set(id, 0)
    let guard = 0
    while (frontier.length && guard <= nodes.length) {
      guard++
      const next: string[] = []
      for (const u of frontier) {
        const lu = layer.get(u) ?? 0
        for (const v of out.get(u)!) {
          layer.set(v, Math.max(layer.get(v) ?? 0, lu + 1))
          const d = (deg.get(v) ?? 0) - 1
          deg.set(v, d)
          if (d === 0) next.push(v)
        }
      }
      frontier = next
    }
    // Any node not reached by Kahn (part of a relay cycle) gets parked at the
    // deepest assigned layer so it is never lost and the loop can't hang.
    const maxLayer = layer.size ? Math.max(...layer.values()) : 0
    for (const n of nodes) if (!layer.has(n.id)) layer.set(n.id, maxLayer)

    // Group node ids into columns by layer. Nodes with NO in/out edges (true
    // orphans) are pulled out of layer 0 into a trailing "orphans" column so the
    // pipeline columns stay purely the wired graph and nothing is lost.
    const wired = (id: string): boolean => out.get(id)!.size > 0 || (indeg.get(id) ?? 0) > 0
    const colMap = new Map<number, string[]>()
    const orphans: string[] = []
    // Stable within-column ordering by current (y,x), matching arrange()'s feel.
    const orderById = new Map(
      [...nodes].sort((a, b) => a.y - b.y || a.x - b.x).map((n, i) => [n.id, i] as const)
    )
    const byOrder = (a: string, b: string): number =>
      (orderById.get(a) ?? 0) - (orderById.get(b) ?? 0)
    for (const n of nodes) {
      if (!wired(n.id)) {
        orphans.push(n.id)
        continue
      }
      const l = layer.get(n.id) ?? 0
      const list = colMap.get(l) ?? []
      list.push(n.id)
      colMap.set(l, list)
    }
    // Assemble ordered columns: graph layers ascending, then the orphans column.
    const columns: string[][] = []
    const sortedLayers = [...colMap.keys()].sort((a, b) => a - b)
    for (const l of sortedLayers) columns.push(colMap.get(l)!.sort(byOrder))
    if (orphans.length) columns.push(orphans.sort(byOrder))
    // Defensive: if somehow no column formed (shouldn't happen given the early
    // fallback), defer to the grid arrange().
    if (!columns.length) {
      get().arrange()
      return
    }

    // Tile EXACTLY like arrange(): zoom-1.0 columns/rows filling the available
    // viewport (no CSS scaling -> crisp xterm text). Drawing shapes untouched.
    // Shared cell sizing + placement via tileColumns().
    const byId = new Map(nodes.map((n) => [n.id, n] as const))
    const placed: CanvasNode[] = tileColumns(columns, byId)
    // Carry over any node that (defensively) wasn't placed, untouched.
    for (const n of nodes) if (!placed.some((p) => p.id === n.id)) placed.push(n)

    // Layout Time Machine — snapshot BEFORE committing the re-layout. Done here
    // (after every early/defensive fallback to arrange(), which records its own
    // 'arrange' step) so the real pipeline reflow is exactly one 'flow' step.
    pushHistory('flow', nodes)
    set({ autoFit: true, camera: { x: 0, y: 0, zoom: 1 }, nodes: placed })
  },

  // Frame EVERYTHING (nodes AND drawing shapes) within the visible area
  // (responsive: re-runs on window resize while autoFit is on). This is
  // CAMERA-ONLY — it never moves or rescales any node or drawing shape, so the
  // windows and the drawings stay perfectly aligned and nothing is cut off or
  // shifted out of view. Accounts for the surrounding chrome.
  fitToView: () => {
    const bounds = sceneBounds(get().nodes)
    if (!bounds) {
      // No nodes and no shapes — keep the current empty behavior.
      set({ autoFit: true, camera: { x: 0, y: 0, zoom: 1 } })
      return
    }
    set({ autoFit: true, camera: cameraForBounds(bounds) })
  },

  // Return to EXACTLY 100% zoom (crisp) while keeping the world point that is
  // currently under the viewport center pinned in place — so it 'returns to
  // 100%' without jumping to a corner. This is a MANUAL zoom (autoFit:false).
  resetZoom100: () =>
    set((s) => {
      const { x, y, zoom } = s.camera
      const cx = window.innerWidth / 2
      const cy = window.innerHeight / 2
      // world point currently at the viewport center
      const wx = (cx - x) / zoom
      const wy = (cy - y) / zoom
      // at zoom 1 keep that same world point at the viewport center
      return {
        autoFit: false,
        camera: { zoom: 1, x: cx - wx, y: cy - wy }
      }
    }),

  clear: () => {
    // Slipstream — a new canvas starts with an empty Back/Forward stack so stale
    // cross-session vantage points can't be flown to.
    clearCameraHistory()
    // Vigil — a new canvas stops any running follow-cam auto-pilot.
    stopVigilTimer()
    // Layout Time Machine — a new canvas starts with an empty undo/redo stack so
    // stale snapshots referencing now-gone nodes can never be restored.
    resetHistory()
    set((s) => ({
      nodes: [],
      selectedId: null,
      focusNodeId: null,
      peekNodeId: null,
      thermalOn: false,
      // Vigil — a new canvas leaves the follow-cam auto-pilot off.
      vigilOn: false,
      vigilTargetId: null,
      conduitsOn: true,
      filterQuery: null,
      beaconOpen: false,
      beaconTarget: null,
      // Watchtower — a new canvas starts with nothing pinned in the live-watch panel.
      watchIds: [],
      // Jump Hints — a new canvas leaves ace-jump teleport mode off (no badges).
      jumpMode: false,
      // Pipeline Walk — a new canvas has no pending relay-graph branch choice.
      pipelinePick: null,
      // Wayback — a new canvas starts with an empty visit log so stale recents
      // can never surface or be quick-switched to.
      visits: {},
      waypoints: [],
      // Stages — a new canvas starts with no saved scenes and no active isolation.
      stages: [],
      stageIds: null,
      histTick: s.histTick + 1
    }))
    // A full canvas reset deletes every node, so any in-memory relay rules/queue
    // and mission events that referenced those (now-gone) nodes are orphaned:
    // they can never fire usefully yet count against caps and could render stale
    // badges if an id is later reused. Reset them too via resetRelayAndMission()
    // (these stores import no canvas runtime value, so no cycle) — purely an
    // in-memory wipe, off the persistence path. Mirrors the per-node
    // clearForNode already done on terminal close.
    resetRelayAndMission()
  },

  bootRecipe: () => {
    nameIdx = 0
    clearCameraHistory()
    // Vigil — seeding a recipe stops any running follow-cam auto-pilot.
    stopVigilTimer()
    // Layout Time Machine — the seeded recipe starts with an empty undo/redo
    // stack (the seeding addNode/arrange calls below must not be undoable into a
    // pre-recipe state).
    resetHistory()
    set((s) => ({
      nodes: [],
      selectedId: null,
      focusNodeId: null,
      peekNodeId: null,
      thermalOn: false,
      // Vigil — the seeded recipe leaves the follow-cam auto-pilot off.
      vigilOn: false,
      vigilTargetId: null,
      conduitsOn: true,
      filterQuery: null,
      beaconOpen: false,
      beaconTarget: null,
      // Watchtower — the seeded recipe starts with nothing pinned.
      watchIds: [],
      jumpMode: false,
      // Pipeline Walk — the seeded recipe starts with no pending branch choice.
      pipelinePick: null,
      visits: {},
      waypoints: [],
      // Stages — the seeded recipe starts with no saved scenes / active isolation.
      stages: [],
      stageIds: null,
      topZ: 1,
      histTick: s.histTick + 1
    }))
    // Same reason as clear(): the recipe replaces all nodes, so orphaned relay
    // rules/queue and mission events from the previous session must be cleared.
    resetRelayAndMission()
    const add = get().addNode
    // Spawn recipe terminals in the active canvas's working folder when one is set.
    // Read lazily to avoid a module-top workspace<->canvas import cycle.
    const cwd = activeCwdLazy()
    add({ kind: 'music', x: 70, y: 70, w: 430, h: 430 })
    // Titles omitted on purpose so addNode draws varied names from NAME_POOL.
    add({ kind: 'terminal', agent: 'claude', x: 560, y: 70, w: 560, h: 360, cwd })
    add({ kind: 'terminal', agent: 'cursor', x: 70, y: 540, w: 470, h: 320, cwd })
    add({ kind: 'terminal', agent: 'codex', x: 560, y: 470, w: 560, h: 390, cwd })
    setTimeout(() => get().arrange(), 60)
  },

  runRecipe: (recipe) => {
    // Crew Recipes — additive: spawn the crew onto the CURRENT canvas without
    // clearing existing nodes/relay/mission (unlike bootRecipe). Bound the crew
    // size defensively so a recipe can never spawn an unbounded swarm.
    if (!recipe?.agents?.length) return
    const agents = recipe.agents.slice(0, MAX_CREW)
    const add = get().addNode
    // Spawn crew terminals in the active canvas's working folder when one is set.
    const cwd = activeCwdLazy()
    // (a) Spawn each agent with its role-prompt; collect index -> real node id.
    const ids: string[] = agents.map((a) =>
      add({
        kind: 'terminal',
        agent: a.agent,
        title: a.title,
        cwd,
        pendingPrompt: a.prompt,
        // Agent Objectives — seed the role's GOAL so a recipe becomes a measurable
        // mission. An explicit recipe `objective` wins; otherwise addNode falls
        // back to auto-seeding the goal text from the pendingPrompt above.
        objective: a.objective ? { text: a.objective.text.trim(), checklist: a.objective.checklist?.map((c) => ({ label: c.label, done: !!c.done })) } : undefined,
        w: a.relW,
        h: a.relH
      })
    )
    // (b) Pre-wire the relay handoff chain. Reached lazily via getState() to
    // preserve the one-directional import contract relay/canvas already follow.
    // Skip any edge whose endpoints fall outside the (capped) spawned crew.
    const relay = useRelay.getState()
    for (const h of recipe.handoffs ?? []) {
      const sourceId = ids[h.from]
      const targetId = ids[h.to]
      if (!sourceId || !targetId || sourceId === targetId) continue
      relay.addRule({
        sourceId,
        targetId,
        text: h.text,
        once: true,
        // Smart Relay defaults ON for recipes so the baton carries the team's
        // accumulated Brief Board findings to the next agent.
        includeBoard: h.includeBoard !== false
      })
    }
    // (c) Auto-arrange, mirroring bootRecipe's deferred arrange so the freshly
    // added nodes are measured before tiling.
    setTimeout(() => get().arrange(), 60)
  },

  loadLayout: (data) => {
    if (!data?.nodes?.length) return
    // Drop any null/non-object entries from a hand-edited or imported layout
    // before reading geometry, so the topZ reduce and the map below never touch
    // a non-node value.
    const raw = data.nodes.filter((n): n is CanvasNode => !!n && typeof n === 'object')
    if (!raw.length) return
    // Same reason as clear()/bootRecipe(): loadLayout replaces every node, so any
    // in-memory relay rules/queue and mission events from the previous session
    // would be orphaned (they reference now-gone node ids, can never fire, still
    // count against caps, and could render stale badges — worsened by the re-id of
    // duplicate/falsy ids below). Wipe them via resetRelayAndMission() (off the
    // persistence path, imports no canvas runtime value, so no cycle). The
    // cold-start path in App.tsx is unaffected since relay/mission start empty.
    resetRelayAndMission()
    const topZ = raw.reduce((m, n) => Math.max(m, Number.isFinite(n.z) ? n.z : 1), 1)
    // Sanitize persisted nodes so a cold start does NOT resurrect stale runtime
    // state: never restore a 'working' status or a pending prompt, and never
    // mark a restored node `fresh` (so TerminalView will not auto-run its agent
    // command on reload). The `command` is kept on the node for manual re-run.
    // Also coerce geometry (mirroring drawing.ts loadShapes) so a NaN/Infinity or
    // non-number x/y/w/h can't propagate into fitToView -> cameraForBounds and
    // produce a NaN camera / blank view.
    // Enforce node-id uniqueness: a shared/imported layout (exported then
    // re-imported) or a hand-edited canvasio:layout can contain two nodes with the
    // same id. updateNode/bringToFront/removeNode all key on `n.id === id`, so a
    // collision would move/restyle/delete both nodes together. Re-id any
    // duplicate (or falsy) id with a fresh nanoid; distinct valid ids are left
    // untouched. A duplicated layout entry almost always carries a duplicated
    // `sessionId` too, so when we re-id a node we ALSO clear its sessionId: two
    // distinct node ids must never share one Claude/Codex session (both would
    // `claude --resume`/`codex resume` the same conversation and cross-contaminate
    // it). A re-keyed node therefore starts a fresh session; nodes that kept their
    // original (distinct, valid) id keep their sessionId untouched.
    const seen = new Set<string>()
    const nodes = raw.map((n) => {
      const dup = !n.id || seen.has(n.id)
      const id = dup ? nanoid(8) : n.id
      seen.add(id)
      // Music queue — sanitize a persisted/imported queue into a clean array of
      // {videoId, url, title?} items: drop anything that isn't an object with
      // string videoId+url, and clamp the saved index into the queue bounds (or
      // reset to 0). Empty/invalid queue → undefined index so the node behaves as
      // if it has no queue. Harmless on non-music nodes (they never read it).
      const rawQueue = Array.isArray(n.musicQueue) ? n.musicQueue : undefined
      const musicQueue = rawQueue
        ? rawQueue
            .filter(
              (item): item is { videoId: string; url: string; title?: string } =>
                !!item &&
                typeof item === 'object' &&
                typeof item.videoId === 'string' &&
                typeof item.url === 'string'
            )
            .map((item) => ({
              videoId: item.videoId,
              url: item.url,
              title: typeof item.title === 'string' ? item.title : undefined
            }))
        : undefined
      const hasQueue = !!musicQueue && musicQueue.length > 0
      const musicQueueIndex = hasQueue
        ? Math.max(
            0,
            Math.min(
              Number.isFinite(n.musicQueueIndex) ? (n.musicQueueIndex as number) : 0,
              musicQueue!.length - 1
            )
          )
        : undefined
      return {
        ...n,
        id,
        sessionId: dup ? undefined : n.sessionId,
        x: Number.isFinite(n.x) ? n.x : 0,
        y: Number.isFinite(n.y) ? n.y : 0,
        w: Number.isFinite(n.w) && n.w > 0 ? n.w : 540,
        h: Number.isFinite(n.h) && n.h > 0 ? n.h : 360,
        z: Number.isFinite(n.z) ? n.z : 1,
        // Collapse-to-icon — coerce the persisted flag to a strict boolean so a
        // hand-edited/imported layout can't carry a truthy non-boolean (only
        // markdown/folder nodes ever render the collapsed chip; the flag is
        // harmless on others). Absent/falsy → undefined (not collapsed).
        collapsed: n.collapsed === true ? true : undefined,
        musicQueue: hasQueue ? musicQueue : undefined,
        musicQueueIndex,
        status: 'idle' as const,
        pendingPrompt: undefined,
        fresh: false
      }
    })
    // Enforce sessionId uniqueness across the FINAL node array. The re-id pass
    // above only clears sessionId for re-keyed (falsy/duplicate-id) nodes, so
    // two nodes with DISTINCT valid ids that share one sessionId (a hand-edited
    // canvasio:layout where only the id was changed on a copied node, or an
    // import/export quirk that touched id but not sessionId) would both keep it
    // and both `claude --resume`/`codex resume` the same conversation,
    // cross-contaminating it. Keep the first node for each sessionId; clear the
    // sessionId on any later collider so it starts a fresh session. Distinct
    // sessions are untouched.
    const seenSessions = new Set<string>()
    for (const n of nodes) {
      if (!n.sessionId) continue
      if (seenSessions.has(n.sessionId)) n.sessionId = undefined
      else seenSessions.add(n.sessionId)
    }
    // Restore saved Waypoints if present. Sanitize like geometry above: finite
    // x/y, finite zoom clamped to the same [0.2, 2.5] range zoomAt enforces, a
    // non-empty name, a usable id, and cap at MAX_WAYPOINTS. Anything malformed
    // is dropped so a hand-edited/imported layout can't produce a NaN camera.
    const rawWps = Array.isArray(data.waypoints) ? data.waypoints : []
    const wpSeen = new Set<string>()
    const waypoints: Waypoint[] = []
    for (const w of rawWps) {
      if (!w || typeof w !== 'object' || !w.cam || typeof w.cam !== 'object') continue
      const { x, y, zoom } = w.cam
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(zoom)) continue
      const id = w.id && !wpSeen.has(w.id) ? w.id : nanoid(8)
      wpSeen.add(id)
      waypoints.push({
        id,
        name: (typeof w.name === 'string' && w.name.trim()) || `Vista ${waypoints.length + 1}`,
        cam: { x, y, zoom: Math.min(2.5, Math.max(0.2, zoom)) }
      })
      if (waypoints.length >= MAX_WAYPOINTS) break
    }
    // Stages — restore saved scenes if present, sanitized + PRUNED to the FINAL
    // node ids (so a scene can never reference a node that didn't survive the
    // load / re-id pass). Empty scenes are dropped; capped at MAX_STAGES. Absent
    // / malformed `stages` simply leaves the Stage set empty.
    const presentIds = new Set(nodes.map((n) => n.id))
    const stages = sanitizeStages(data.stages, presentIds)
    // Slipstream — a freshly loaded layout starts with an empty Back/Forward
    // stack (no stale vantage points from the previous canvas).
    clearCameraHistory()
    // Vigil — a freshly loaded layout stops any running follow-cam auto-pilot.
    stopVigilTimer()
    // Layout Time Machine — a freshly loaded layout starts with an empty
    // undo/redo stack (snapshots from the previous canvas reference gone nodes).
    resetHistory()
    set((s) => ({
      nodes,
      selectedId: null,
      focusNodeId: null,
      peekNodeId: null,
      thermalOn: false,
      // Vigil — a freshly loaded layout leaves the follow-cam auto-pilot off.
      vigilOn: false,
      vigilTargetId: null,
      conduitsOn: true,
      filterQuery: null,
      beaconOpen: false,
      beaconTarget: null,
      // Watchtower — a freshly loaded layout starts with nothing pinned (watch
      // pins are transient runtime state, never serialized into canvasio:layout).
      watchIds: [],
      // Jump Hints — a freshly loaded layout starts with ace-jump teleport off.
      jumpMode: false,
      // Pipeline Walk — a freshly loaded layout starts with no pending branch choice.
      pipelinePick: null,
      // Wayback — a freshly loaded layout starts with an empty visit log (visits
      // are transient runtime state, never serialized into canvasio:layout).
      visits: {},
      waypoints,
      // Stages — restore saved scenes (pruned above); the live spotlight set
      // (stageIds) is transient and always starts null on a cold load.
      stages,
      stageIds: null,
      topZ,
      histTick: s.histTick + 1
    }))
    // Districts — restore persisted regions (resetRelayAndMission above already
    // wiped any stale ones from the previous canvas). setRegions sanitizes every
    // entry, so a hand-edited/imported layout can't inject a NaN box. Absent /
    // malformed `regions` simply leaves the District set empty.
    useRegions.getState().setRegions(Array.isArray(data.regions) ? data.regions : [])
    // Frame the restored layout WITHOUT resizing anything: arrange() re-tiled the
    // nodes to fill the viewport, which blew up a custom-sized terminal to look
    // "maximized" on every canvas switch (and re-saved the inflated size). The
    // whole point of a saved canvas is to come back EXACTLY as left, so we only
    // move the CAMERA (fitToView → cameraForBounds, capped at zoom 1.0) to bring
    // the saved nodes into view at their real sizes.
    setTimeout(() => get().fitToView(), 60)
  }
}))

export { AGENT_LABEL }
// Stages — re-export the Stage type so consumers (StagesChip, CommandPalette)
// can import it from the canvas store alongside CanvasNode/Waypoint, mirroring
// how Region is consumed.
export type { Stage }
