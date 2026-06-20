import { useEffect, useMemo, useRef, useState } from 'react'
import { useCanvas } from '../store/canvas'
import { useMission } from '../store/mission'
import { useReplay } from '../store/replay'
import { useDirector } from '../store/director'
import { useT } from '../store/i18n'

// Pulse Radar — off-screen attention beacons.
//
// A renderer-only overlay (mirrors Minimap's pattern): for every node whose live
// status is error / done / working / "te necesita" (waiting) but that is
// currently OUTSIDE the visible viewport, it pins a small directional beacon to
// the viewport edge in the exact direction of that node. Clicking a beacon flies
// the camera straight to the node via the existing centerOnNode tween.
//
// CONTRACT: purely additive, renderer-only. It READS the canvas + mission stores
// and CALLS the existing centerOnNode — it never mutates node/shape geometry,
// never touches IPC/main, and adds no persistence/serialization. It returns null
// when there is nothing to point at, so a calm canvas has zero chrome.

// CHROME insets, kept in sync with canvas.ts so a node is treated as on-screen
// exactly when it is visible inside the usable area (not under the top bar etc.).
const CHROME = { top: 64, bottom: 116, left: 78, right: 84 }

// Reused from NodeView's STATUS_COLOR, plus cyan for the relay/narration
// "waiting" (te necesita) state — the same cyan MissionLog uses for it.
type BeaconStatus = 'error' | 'waiting' | 'done' | 'working'
const BEACON_COLOR: Record<BeaconStatus, string> = {
  error: '#ff6b6b',
  waiting: '#5ad1e8',
  done: '#48d597',
  working: '#f2c84b'
}
// Status -> i18n key for the localized label used in title / aria-label
// (accessibility). Resolved through t() at render time so it follows the active
// language hot-switch (a module-level string constant could not).
const BEACON_LABEL_KEY: Record<BeaconStatus, string> = {
  error: 'pulseRadar.status_error',
  waiting: 'pulseRadar.status_waiting',
  done: 'pulseRadar.status_done',
  working: 'pulseRadar.status_working'
}
// Urgency order: which beacons survive the cap when the edge gets crowded.
const PRIORITY: Record<BeaconStatus, number> = { error: 0, waiting: 1, done: 2, working: 3 }

// Hard cap on visible beacons so the edge never turns into clutter; the rest are
// summarized in a single "+N" overflow chip.
const MAX_BEACONS = 8

interface Beacon {
  id: string
  title: string
  status: BeaconStatus
  /** clamped screen-edge position (px). */
  ex: number
  ey: number
  /** outward-pointing angle in degrees (for the arrow rotation). */
  angle: number
}

// Spyglass long-press threshold (ms): hold past this and the gesture becomes a
// transient PEEK (preview then spring back); a shorter tap stays a committed GO.
const PEEK_HOLD_MS = 180

export function PulseRadar(): JSX.Element | null {
  const t = useT()
  const nodes = useCanvas((s) => s.nodes)
  const camera = useCanvas((s) => s.camera)
  // Mission events carry the logical "waiting" (te necesita) state, which is NOT
  // on the node's own status field. We fold the latest event per node into a set.
  const events = useMission((s) => s.events)
  // Stay out of the way of any auto-driven camera.
  const replayArmed = useReplay((s) => s.armed)
  const directorArmed = useDirector((s) => s.armed)

  // Spyglass long-press: a hold past PEEK_HOLD_MS previews the beacon's node
  // (peekAt) and the release springs back (endPeek); a short tap keeps the
  // existing centerOnNode commit. peekedRef flags that the timer fired so the
  // release knows whether to endPeek (peek) or centerOnNode (tap).
  const holdTimer = useRef<number | null>(null)
  const peekedRef = useRef(false)
  const clearHold = (): void => {
    if (holdTimer.current != null) {
      window.clearTimeout(holdTimer.current)
      holdTimer.current = null
    }
  }
  useEffect(() => () => clearHold(), [])

  const onBeaconPointerDown = (id: string): void => {
    clearHold()
    peekedRef.current = false
    holdTimer.current = window.setTimeout(() => {
      peekedRef.current = true
      useCanvas.getState().peekAt(id)
    }, PEEK_HOLD_MS)
  }
  const onBeaconPointerUp = (id: string): void => {
    clearHold()
    if (peekedRef.current) {
      // Long-press: transient peek — spring back to the prior view.
      useCanvas.getState().endPeek()
    } else {
      // Short tap: keep the existing committed fly-to.
      useCanvas.getState().centerOnNode(id)
    }
    peekedRef.current = false
  }
  const onBeaconPointerLeave = (): void => {
    // Pointer left the button: cancel a pending tap; if a peek already started,
    // end it (spring back) so it can't get stuck.
    clearHold()
    if (peekedRef.current) {
      useCanvas.getState().endPeek()
      peekedRef.current = false
    }
  }

  const [viewport, setViewport] = useState({
    width: window.innerWidth,
    height: window.innerHeight
  })
  useEffect(() => {
    const onResize = (): void =>
      setViewport({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Per-node logical "waiting" flag: a node whose most-recent mission event is a
  // `waiting` transition is currently asking for the user (te necesita), even
  // though its node.status field only knows idle/working/done/error.
  const waitingIds = useMemo(() => {
    const last = new Map<string, { ts: number; kind: string }>()
    for (const e of events) {
      const prev = last.get(e.nodeId)
      if (!prev || e.ts >= prev.ts) last.set(e.nodeId, { ts: e.ts, kind: e.kind })
    }
    const out = new Set<string>()
    last.forEach((v, id) => {
      if (v.kind === 'waiting') out.add(id)
    })
    return out
  }, [events])

  const beacons = useMemo<Beacon[]>(() => {
    const { width: vw, height: vh } = viewport
    const z = camera.zoom
    // Center of the USABLE viewport (inside the chrome) — beacons radiate from
    // here toward each off-screen node, and clamp to this rect's edge.
    const left = CHROME.left
    const right = vw - CHROME.right
    const top = CHROME.top
    const bottom = vh - CHROME.bottom
    if (right - left < 40 || bottom - top < 40) return []
    const ccx = (left + right) / 2
    const ccy = (top + bottom) / 2

    const candidates: Beacon[] = []
    for (const n of nodes) {
      // Resolve the beacon-worthy status. error wins, then waiting (te necesita),
      // then the node's own done/working. idle nodes produce no beacon.
      const live = n.status
      let status: BeaconStatus | null = null
      if (live === 'error') status = 'error'
      else if (waitingIds.has(n.id)) status = 'waiting'
      else if (live === 'done') status = 'done'
      else if (live === 'working') status = 'working'
      if (!status) continue

      // Node rect in SCREEN space.
      const sx = n.x * z + camera.x
      const sy = n.y * z + camera.y
      const sw = n.w * z
      const sh = n.h * z
      // On-screen if its screen rect intersects the usable viewport — skip those.
      const onScreen = sx < right && sx + sw > left && sy < bottom && sy + sh > top
      if (onScreen) continue

      // Direction from usable-viewport center toward the node's screen center.
      const ncx = sx + sw / 2
      const ncy = sy + sh / 2
      let dx = ncx - ccx
      let dy = ncy - ccy
      if (dx === 0 && dy === 0) continue

      // Clamp the ray (center -> node) to the usable-viewport rectangle edge.
      const halfW = (right - left) / 2
      const halfH = (bottom - top) / 2
      const scaleX = dx !== 0 ? halfW / Math.abs(dx) : Infinity
      const scaleY = dy !== 0 ? halfH / Math.abs(dy) : Infinity
      const t = Math.min(scaleX, scaleY)
      // Pull in slightly so the beacon button sits inside the border, not on it.
      const inset = 14
      const ex = ccx + dx * t
      const ey = ccy + dy * t
      const clampedX = Math.max(left + inset, Math.min(right - inset, ex))
      const clampedY = Math.max(top + inset, Math.min(bottom - inset, ey))
      const angle = (Math.atan2(dy, dx) * 180) / Math.PI

      candidates.push({ id: n.id, title: n.title, status, ex: clampedX, ey: clampedY, angle })
    }

    // Urgency-first ordering so the cap keeps the beacons that matter most.
    candidates.sort((a, b) => PRIORITY[a.status] - PRIORITY[b.status])
    return candidates
  }, [nodes, camera.x, camera.y, camera.zoom, waitingIds, viewport])

  // Hidden entirely while an auto-driven camera owns the view (replay/director),
  // and when there is nothing off-screen to point at (zero chrome when calm).
  if (replayArmed || directorArmed || beacons.length === 0) return null

  const visible = beacons.slice(0, MAX_BEACONS)
  const overflow = beacons.length - visible.length

  return (
    <div
      className="pulse-radar"
      role="navigation"
      aria-label={t('pulseRadar.nav_label')}
    >
      {visible.map((b) => {
        const color = BEACON_COLOR[b.status]
        const throb = b.status === 'error' || b.status === 'waiting'
        return (
          <button
            key={b.id}
            type="button"
            className={`pulse-beacon no-drag${throb ? ' pulse-beacon--throb' : ''}`}
            title={t('pulseRadar.beacon_title', {
              title: b.title,
              status: t(BEACON_LABEL_KEY[b.status])
            })}
            aria-label={t('pulseRadar.beacon_aria', {
              title: b.title,
              status: t(BEACON_LABEL_KEY[b.status])
            })}
            onPointerDown={() => onBeaconPointerDown(b.id)}
            onPointerUp={() => onBeaconPointerUp(b.id)}
            onPointerLeave={onBeaconPointerLeave}
            style={{
              left: b.ex,
              top: b.ey,
              // The colored dot + glow comes from these CSS vars.
              ['--beacon-color' as string]: color
            }}
          >
            {/* Outward-pointing arrow, rotated toward the node. */}
            <span
              className="pulse-beacon__arrow"
              style={{ transform: `rotate(${b.angle}deg)` }}
              aria-hidden
            >
              ➤
            </span>
          </button>
        )
      })}
      {overflow > 0 && (
        <div
          className="pulse-beacon-overflow glass"
          aria-hidden
          title={t('pulseRadar.overflow_title', { overflow })}
        >
          +{overflow}
        </div>
      )}
    </div>
  )
}
