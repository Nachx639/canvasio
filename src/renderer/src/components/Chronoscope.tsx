import { useEffect, useMemo, useRef, useState } from 'react'
import { useCanvas } from '../store/canvas'
import { useMission } from '../store/mission'
import { useReplay } from '../store/replay'
import { buildLanes, tsToFrac, type Lane } from '../lib/chronoscope'
import { AGENT_COLOR, KIND_META, relTime } from './MissionLog'
import { useT } from '../store/i18n'

/**
 * Chronoscope — a per-agent SWIMLANE timeline (a Gantt of the work session).
 * One horizontal lane per agent, time flowing left→right on a shared axis, with
 * colored segments for each agent's working stretches, dots for done/error/
 * waiting/spawn moments, and connector arrows between lanes for Agent Relay
 * handoffs. It reconstructs every interval PURELY from the in-memory Mission
 * Pulse store (mission.ts) via the pure lib buildLanes() — zero new data
 * plumbing, no IPC, no persistence, no geometry mutation.
 *
 * Keyboard-first (mirrors ChangesetLens / AgentLensHud capture-phase handling so
 * plain-key app shortcuts never fire while open):
 *   ↑/↓   move the active lane
 *   Enter fly the camera to that agent (centerOnNode) + close
 *   P     start Flight Recorder Replay from the active lane's latest moment
 *   Esc   close
 *
 * Opens/toggles on the 'canvasio:open-chrono' CustomEvent (⌘-less 'c' in
 * App.tsx, the Command Palette, and the Mission Pulse header button). A 1 Hz
 * tick (only while open) keeps the trailing open-ended "working now" segment and
 * the relative-time labels live.
 */

const LANE_HEIGHT = 30
const LANE_GAP = 8
const TRACK_LEFT = 132 // px reserved for the lane label gutter
const TRACK_RIGHT = 14

// Stable empty timeline used while the overlay is closed, so the (expensive,
// O(events)) buildLanes() reconstruction never runs on background mission-event
// or canvas-node churn while Chronoscope is in its normal (closed) state.
const EMPTY_CHRONO = buildLanes([], [], 0)

export function Chronoscope(): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [now, setNow] = useState(Date.now())
  const [trackW, setTrackW] = useState(560)
  const trackRef = useRef<HTMLDivElement>(null)

  const events = useMission((s) => s.events)
  const nodes = useCanvas((s) => s.nodes)
  const t = useT()

  // Toggle on the shared event.
  useEffect(() => {
    const onOpen = (): void => setOpen((v) => !v)
    window.addEventListener('canvasio:open-chrono', onOpen)
    return () => window.removeEventListener('canvasio:open-chrono', onOpen)
  }, [])

  // 1 Hz tick for the live open-ended stretch + relative labels, only while open.
  useEffect(() => {
    if (!open) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [open])

  // Measure the actual track width so segments map correctly across resizes.
  useEffect(() => {
    if (!open) return
    const measure = (): void => {
      const w = trackRef.current?.clientWidth
      if (w && w > 0) setTrackW(w)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [open])

  // Re-derive the swimlanes on every events/nodes change AND on the 1 Hz tick
  // (so the open-ended "working now" stretch grows). Hoisted above the early
  // return so hooks always run in the same order.
  const chrono = useMemo(
    () => (open ? buildLanes(events, nodes, now) : EMPTY_CHRONO),
    [open, events, nodes, now]
  )

  // Clamp the active lane when the lane set shrinks.
  useEffect(() => {
    setActive((a) => (chrono.lanes.length === 0 ? 0 : Math.min(a, chrono.lanes.length - 1)))
  }, [chrono.lanes.length])

  // Keyboard navigation while open (capture phase, like ChangesetLens).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      const lanes = chrono.lanes
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((a) => (lanes.length ? (a + 1) % lanes.length : 0))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((a) => (lanes.length ? (a - 1 + lanes.length) % lanes.length : 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const lane = lanes[active]
        if (lane) {
          useCanvas.getState().centerOnNode(lane.nodeId)
          setOpen(false)
        }
      } else if (e.key === 'p' || e.key === 'P') {
        e.preventDefault()
        const lane = lanes[active]
        if (!lane) return
        // Launch Replay from the active lane's most recent moment.
        const evId =
          lane.markers.length > 0
            ? lane.markers[lane.markers.length - 1].eventId
            : lane.segments.length > 0
              ? lane.segments[lane.segments.length - 1].sourceEventId
              : undefined
        replayFromEvent(evId)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, chrono.lanes, active])

  if (!open) return null

  const lanes = chrono.lanes
  const laneTop = (i: number): number => i * (LANE_HEIGHT + LANE_GAP)
  const totalTrackH = lanes.length * (LANE_HEIGHT + LANE_GAP)

  return (
    <div
      className="glass no-drag"
      data-overlay="chronoscope"
      style={{
        pointerEvents: 'auto',
        position: 'absolute',
        top: 46,
        left: '50%',
        transform: 'translateX(-50%)',
        borderRadius: 14,
        padding: 14,
        width: 760,
        maxWidth: '94vw',
        maxHeight: '78vh',
        overflowY: 'auto',
        fontSize: 13,
        color: '#d7e1f7',
        zIndex: 60
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontWeight: 700, fontSize: 14 }}>Chronoscope</span>
        <span
          style={{
            marginLeft: 8,
            fontSize: 10.5,
            color: '#8fa3cc',
            border: '1px solid rgba(120,150,220,0.2)',
            borderRadius: 6,
            padding: '1px 6px'
          }}
        >
          {t('chronoscope.subtitle')}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 10.5, color: '#6f84ad' }}>
          {t('chronoscope.shortcuts_hint')}
        </span>
        <button
          onClick={() => setOpen(false)}
          aria-label={t('chronoscope.close_aria')}
          title={t('common.close')}
          style={{
            marginLeft: 10,
            background: 'none',
            border: 'none',
            color: '#8fa3cc',
            cursor: 'pointer'
          }}
        >
          ✕
        </button>
      </div>

      {/* time axis caption */}
      {!chrono.empty && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            marginLeft: TRACK_LEFT,
            marginRight: TRACK_RIGHT,
            marginBottom: 6,
            fontSize: 10,
            color: '#6f84ad'
          }}
        >
          <span>{relTime(chrono.t0, now)}</span>
          <span>{t('chronoscope.now')}</span>
        </div>
      )}

      {chrono.empty ? (
        <div style={{ fontSize: 12, color: '#6f84ad', padding: '4px 0' }}>
          {t('chronoscope.empty')}
        </div>
      ) : (
        <div style={{ position: 'relative' }}>
          {/* lane rows */}
          <div style={{ position: 'relative' }}>
            {lanes.map((lane, i) => (
              <LaneRow
                key={lane.nodeId}
                lane={lane}
                active={i === active}
                t0={chrono.t0}
                t1={chrono.t1}
                now={now}
                trackRef={i === 0 ? trackRef : undefined}
                onHover={() => setActive(i)}
                onClickLabel={() => {
                  useCanvas.getState().centerOnNode(lane.nodeId)
                  setOpen(false)
                }}
                onClickSegment={(eventId) => replayFromEvent(eventId)}
              />
            ))}
          </div>

          {/* relay handoff connectors, overlaid across lanes */}
          <RelayConnectors
            chrono={chrono}
            laneIndex={new Map(lanes.map((l, i) => [l.nodeId, i] as const))}
            laneTop={laneTop}
            totalTrackH={totalTrackH}
            trackW={trackW}
          />
        </div>
      )}
    </div>
  )
}

/** A single swimlane row: label gutter + a positioned segment/marker track. */
function LaneRow({
  lane,
  active,
  t0,
  t1,
  now,
  trackRef,
  onHover,
  onClickLabel,
  onClickSegment
}: {
  lane: Lane
  active: boolean
  t0: number
  t1: number
  now: number
  trackRef?: React.Ref<HTMLDivElement>
  onHover: () => void
  onClickLabel: () => void
  onClickSegment: (eventId: string) => void
}): JSX.Element {
  const t = useT()
  const accent = lane.agent ? AGENT_COLOR[lane.agent] : '#7c97e0'
  const blockerColor =
    lane.blockerKind === 'error' ? '#f2564b' : lane.blockerKind === 'waiting' ? '#5ad1e8' : undefined
  return (
    <div
      onPointerEnter={onHover}
      style={{
        display: 'flex',
        alignItems: 'center',
        height: LANE_HEIGHT,
        marginBottom: LANE_GAP,
        borderRadius: 8,
        background: active ? 'rgba(124,151,224,0.14)' : 'transparent',
        boxShadow: active ? `inset 0 0 0 1px ${accent}55` : undefined
      }}
    >
      {/* label gutter */}
      <button
        type="button"
        onClick={onClickLabel}
        title={t('chronoscope.go_to', { title: lane.title })}
        style={{
          flex: `0 0 ${TRACK_LEFT - 8}px`,
          width: TRACK_LEFT - 8,
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          padding: '0 8px',
          background: 'transparent',
          border: 'none',
          color: '#d7e1f7',
          cursor: 'pointer',
          textAlign: 'left',
          overflow: 'hidden'
        }}
      >
        <span
          style={{
            flex: '0 0 auto',
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: blockerColor ?? accent,
            boxShadow: `0 0 7px ${blockerColor ?? accent}`,
            opacity: lane.live ? 1 : 0.4
          }}
        />
        <span
          style={{
            fontWeight: 600,
            fontSize: 11.5,
            color: lane.live ? accent : '#6f84ad',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
        >
          {lane.title}
        </span>
      </button>

      {/* segment + marker track */}
      <div
        ref={trackRef}
        style={{
          position: 'relative',
          flex: '1 1 0',
          height: LANE_HEIGHT,
          marginRight: TRACK_RIGHT,
          borderRadius: 6,
          background: 'rgba(8,12,26,0.45)',
          border: '1px solid rgba(120,150,220,0.1)',
          overflow: 'hidden'
        }}
      >
        {/* working segments */}
        {lane.segments.map((seg, si) => {
          const left = tsToFrac(seg.startTs, t0, t1) * 100
          const right = tsToFrac(seg.endTs, t0, t1) * 100
          const widthPct = Math.max(0.6, right - left)
          const color = seg.open ? KIND_META['work-start'].color : KIND_META[seg.kind].color
          return (
            <button
              key={`seg:${seg.sourceEventId}:${si}`}
              type="button"
              title={`${t(`missionLog.kind_${seg.kind}`)}${seg.open ? ` ${t('chronoscope.now_paren')}` : ''} · ${t('chronoscope.replay_from_here')}`}
              onClick={(e) => {
                e.stopPropagation()
                onClickSegment(seg.sourceEventId)
              }}
              style={{
                position: 'absolute',
                left: `${left}%`,
                width: `${widthPct}%`,
                top: 6,
                height: LANE_HEIGHT - 12,
                borderRadius: 4,
                border: 'none',
                cursor: 'pointer',
                background: seg.open
                  ? `repeating-linear-gradient(90deg, ${color}cc 0 6px, ${color}88 6px 12px)`
                  : `${color}cc`,
                boxShadow: seg.open ? `0 0 8px ${color}88` : undefined
              }}
            />
          )
        })}

        {/* point markers (spawn / done / error / waiting / close) */}
        {lane.markers.map((m, mi) => {
          const left = tsToFrac(m.ts, t0, t1) * 100
          const meta = KIND_META[m.kind]
          return (
            <button
              key={`mk:${m.eventId}:${mi}`}
              type="button"
              title={`${t(`missionLog.kind_${m.kind}`)} · ${relTime(m.ts, now)} · ${t('chronoscope.replay_from_here')}`}
              onClick={(e) => {
                e.stopPropagation()
                onClickSegment(m.eventId)
              }}
              style={{
                position: 'absolute',
                left: `calc(${left}% - 5px)`,
                top: LANE_HEIGHT / 2 - 5,
                width: 10,
                height: 10,
                borderRadius: '50%',
                border: '1.5px solid rgba(8,12,26,0.85)',
                background: meta.color,
                boxShadow: `0 0 6px ${meta.color}aa`,
                cursor: 'pointer',
                padding: 0
              }}
            />
          )
        })}
      </div>
    </div>
  )
}

/**
 * Relay handoff connectors — thin curved arrows from each relay event's source
 * lane (at the event ts) down/up to its resolved target lane. Drawn as an SVG
 * overlay sized to the track area; pointer-events disabled so it never blocks the
 * underlying segment/marker buttons.
 */
function RelayConnectors({
  chrono,
  laneIndex,
  laneTop,
  totalTrackH,
  trackW
}: {
  chrono: ReturnType<typeof buildLanes>
  laneIndex: Map<string, number>
  laneTop: (i: number) => number
  totalTrackH: number
  trackW: number
}): JSX.Element | null {
  const links = chrono.links.filter((l) => l.targetNodeId && laneIndex.has(l.sourceNodeId) && laneIndex.has(l.targetNodeId!))
  if (links.length === 0) return null
  const color = KIND_META.relay.color
  const laneCenter = (i: number): number => laneTop(i) + LANE_HEIGHT / 2
  return (
    <svg
      width="100%"
      height={totalTrackH}
      style={{
        position: 'absolute',
        top: 0,
        left: TRACK_LEFT,
        width: trackW,
        height: totalTrackH,
        pointerEvents: 'none',
        overflow: 'visible'
      }}
    >
      <defs>
        <marker
          id="chronoArrow"
          markerWidth="6"
          markerHeight="6"
          refX="4"
          refY="3"
          orient="auto"
        >
          <path d="M0,0 L6,3 L0,6 Z" fill={color} />
        </marker>
      </defs>
      {links.map((l) => {
        const si = laneIndex.get(l.sourceNodeId)!
        const ti = laneIndex.get(l.targetNodeId!)!
        const x = tsToFrac(l.ts, chrono.t0, chrono.t1) * trackW
        const y1 = laneCenter(si)
        const y2 = laneCenter(ti)
        const midY = (y1 + y2) / 2
        const bow = Math.min(40, Math.abs(y2 - y1) * 0.5 + 14)
        const d = `M ${x} ${y1} C ${x + bow} ${midY}, ${x + bow} ${midY}, ${x} ${y2}`
        return (
          <path
            key={l.eventId}
            d={d}
            fill="none"
            stroke={color}
            strokeWidth={1.4}
            strokeOpacity={0.75}
            markerEnd="url(#chronoArrow)"
          />
        )
      })}
    </svg>
  )
}

/**
 * Launch (or re-aim) Flight Recorder Replay at the given mission event id. Maps
 * the event id to its index in the LIVE mission.events list, arms replay (which
 * snapshots that same list), jumps the playhead there and resumes auto-advance.
 * No-op when the id can't be found or the timeline is empty.
 */
function replayFromEvent(eventId: string | undefined): void {
  if (!eventId) return
  const events = useMission.getState().events
  const idx = events.findIndex((e) => e.id === eventId)
  if (idx < 0) return
  const replay = useReplay.getState()
  replay.start() // arms + snapshots events (in the same order findIndex used)
  replay.stepTo(idx) // jump playhead (pauses)
  replay.togglePlay() // resume auto-advance from here
}
