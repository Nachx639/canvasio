import { useEffect, useMemo, useRef, useState } from 'react'
import { useCanvas } from '../store/canvas'
import { useCommandTrail, type TrailHit } from '../store/commandTrail'
import type { CommandRisk } from '../lib/commandTrail'
import { submitToPty } from '../lib/ptySubmit'
import { useT } from '../store/i18n'

/**
 * Command Trail — the executed-command AUDIT timeline across every agent.
 *
 * CanvasIO observes agent STATE (Thermal, Pulse, dots), latest OUTPUT (Lens),
 * scrollback (Echo), DIFFS (Changeset, Checkpoints) and TIME (Chronoscope), but
 * never the single most consequential thing each agent DID: the shell commands it
 * ran on your machine. This keyboard-first panel renders the unified, color-coded,
 * risk-tagged record those commands land in (captured at the same flush chokepoint
 * that feeds Lens/Echo/Tripwire, classified by lib/commandTrail.ts).
 *
 * Opened via the 'canvasio:open-cmdtrail' CustomEvent (the plain 'X' key in
 * App.tsx + a Command Palette action), mirroring ReplyRail / Chronoscope. Purely
 * renderer-side and additive: it READS the memory-only commandTrail store and
 * WRITES only through the existing window.canvasio.pty.write bridge to RE-RUN a
 * command into its agent's pty (no new IPC, no main-process change). Mutates no
 * geometry, never serialized. Re-run requires Enter to confirm; destructive
 * commands require a second confirm (mirroring Checkpoint Restore's confirm gate).
 *
 * Keys (capture phase, while open): j/↓ + k/↑ navigate · 1-5/0 filter by risk ·
 * c copy · r / Enter re-run (destructive asks again) · g fly to agent · Esc close.
 */

const RISK_META: Record<CommandRisk, { labelKey: string; color: string; glyph: string }> = {
  destructive: { labelKey: 'commandTrail.risk_destructive', color: '#ff6b6b', glyph: '⚠' },
  network: { labelKey: 'commandTrail.risk_network', color: '#7aa2ff', glyph: '↯' },
  vcs: { labelKey: 'commandTrail.risk_vcs', color: '#c08cff', glyph: '⎇' },
  buildtest: { labelKey: 'commandTrail.risk_buildtest', color: '#5ec8a0', glyph: '⚙' },
  benign: { labelKey: 'commandTrail.risk_benign', color: '#8fa3cc', glyph: '·' }
}

const RISK_ORDER: CommandRisk[] = ['destructive', 'network', 'vcs', 'buildtest', 'benign']

function relTime(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.round(m / 60)}h`
}

export function CommandTrailPanel(): JSX.Element | null {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [filter, setFilter] = useState<CommandRisk | null>(null)
  // nodeId pending a destructive-re-run second confirmation (entry id), or null.
  const [armId, setArmId] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const entries = useCommandTrail((s) => s.entries)
  const nodes = useCanvas((s) => s.nodes)

  // Pure derivation: newest-first timeline, optionally filtered by risk. Skip the
  // fold entirely while CLOSED — the store updates on every flush (~5 Hz per
  // active agent), so this keeps a closed panel from re-deriving on each push.
  const hits = useMemo<TrailHit[]>(() => {
    if (!open) return []
    return useCommandTrail.getState().recent({ risk: filter ?? undefined, limit: 300 })
    // entries is the real dependency (recent reads getState snapshot of it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, filter, entries])

  const titleFor = (nodeId: string): string =>
    nodes.find((n) => n.id === nodeId)?.title ?? t('commandTrail.agent_fallback')

  // Toggle on the shared event so App.tsx + the palette can drive it.
  useEffect(() => {
    const onOpen = (): void => setOpen((v) => !v)
    window.addEventListener('canvasio:open-cmdtrail', onOpen)
    return () => window.removeEventListener('canvasio:open-cmdtrail', onOpen)
  }, [])

  // Clamp the active row when the list shrinks; drop a stale destructive arm.
  useEffect(() => {
    setActive((a) => (hits.length === 0 ? 0 : Math.min(a, hits.length - 1)))
  }, [hits.length])
  useEffect(() => {
    setArmId(null)
  }, [active, filter])

  const copy = (cmd: string): void => {
    try {
      navigator.clipboard?.writeText(cmd)
    } catch {
      /* ignore */
    }
  }

  // Re-run a command into its source agent's pty via the existing write bridge.
  // Destructive commands require the row to be ARMED first (a second keypress),
  // mirroring the Checkpoint Restore confirm gate. Optimistically mark working.
  const rerun = (hit: TrailHit | undefined): void => {
    if (!hit) return
    if (hit.risk === 'destructive' && armId !== hit.id) {
      setArmId(hit.id)
      return
    }
    // Write the command then Enter SEPARATELY so an agent TUI (notably Codex)
    // actually submits it — a combined text+'\r' chunk leaves the input unsent
    // (see submitToPty), matching the proven send_to_agent / relay delivery path.
    submitToPty(hit.nodeId, hit.cmd)
    useCanvas.getState().updateNode(hit.nodeId, { status: 'working' })
    setArmId(null)
  }

  // Keyboard nav while open. Window capture phase so it works without DOM focus
  // and wins over App's plain-key shortcuts; Esc closes.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (armId) {
          setArmId(null)
          return
        }
        setOpen(false)
        return
      }
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((a) => (hits.length ? (a + 1) % hits.length : 0))
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((a) => (hits.length ? (a - 1 + hits.length) % hits.length : 0))
      } else if (e.key === 'c' || e.key === 'C') {
        e.preventDefault()
        const h = hits[active]
        if (h) copy(h.cmd)
      } else if (e.key === 'r' || e.key === 'R' || e.key === 'Enter') {
        e.preventDefault()
        rerun(hits[active])
      } else if (e.key === 'g' || e.key === 'G') {
        e.preventDefault()
        const h = hits[active]
        if (h) useCanvas.getState().centerOnNode(h.nodeId)
      } else if (e.key >= '1' && e.key <= '5') {
        e.preventDefault()
        setFilter(RISK_ORDER[Number(e.key) - 1])
        setActive(0)
      } else if (e.key === '0') {
        e.preventDefault()
        setFilter(null)
        setActive(0)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, hits, active, armId])

  // Keep the selected row in view.
  useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  if (!open) return null

  const now = Date.now()
  const selected = hits[active]

  return (
    <div
      className="glass no-drag"
      data-overlay="cmdtrail"
      style={{
        pointerEvents: 'auto',
        position: 'absolute',
        top: 46,
        left: '50%',
        transform: 'translateX(-50%)',
        borderRadius: 14,
        padding: 14,
        width: 560,
        maxHeight: '74vh',
        display: 'flex',
        flexDirection: 'column',
        fontSize: 13,
        color: '#d7e1f7',
        zIndex: 60
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontWeight: 700, fontSize: 14 }}>Command Trail</span>
        <span
          style={{
            marginLeft: 8,
            fontSize: 10.5,
            color: '#9fb2d8',
            border: '1px solid rgba(120,150,220,0.25)',
            borderRadius: 6,
            padding: '1px 6px'
          }}
        >
          {hits.length === 1
            ? t('commandTrail.count_one', { count: hits.length })
            : t('commandTrail.count_other', { count: hits.length })}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 10.5, color: '#6f84ad' }}>
          {t('commandTrail.shortcuts')}
        </span>
      </div>

      {/* Risk filter chips. */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        <FilterChip label={t('commandTrail.filter_all')} active={filter === null} color="#9fb2d8" onClick={() => { setFilter(null); setActive(0) }} />
        {RISK_ORDER.map((r) => (
          <FilterChip
            key={r}
            label={`${RISK_META[r].glyph} ${t(RISK_META[r].labelKey)}`}
            active={filter === r}
            color={RISK_META[r].color}
            onClick={() => { setFilter(r); setActive(0) }}
          />
        ))}
      </div>

      <div ref={listRef} style={{ overflowY: 'auto', minHeight: 60 }}>
        {hits.length === 0 ? (
          <div style={{ padding: '18px 8px', textAlign: 'center', color: '#6f84ad', fontSize: 12.5 }}>
            {t('commandTrail.empty')}
          </div>
        ) : (
          hits.map((h, i) => {
            const meta = RISK_META[h.risk]
            const isActive = i === active
            const armed = armId === h.id
            return (
              <div
                key={h.id}
                data-active={isActive}
                onPointerEnter={() => setActive(i)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 9,
                  padding: '7px 10px',
                  marginBottom: 6,
                  borderRadius: 10,
                  background: isActive ? 'rgba(124,151,224,0.18)' : 'rgba(8,12,26,0.55)',
                  border: isActive
                    ? '1px solid rgba(122,162,255,0.55)'
                    : '1px solid rgba(120,150,220,0.12)'
                }}
              >
                <span
                  title={t(meta.labelKey)}
                  style={{
                    flex: '0 0 auto',
                    width: 18,
                    textAlign: 'center',
                    color: meta.color,
                    fontWeight: 700,
                    textShadow: h.risk === 'destructive' ? `0 0 7px ${meta.color}` : undefined
                  }}
                >
                  {meta.glyph}
                </span>
                <div style={{ flex: '1 1 0', minWidth: 0 }}>
                  <div
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      fontSize: 12,
                      color: '#eaf1ff'
                    }}
                  >
                    {h.cmd}
                  </div>
                  <div style={{ fontSize: 10.5, color: '#6f84ad', marginTop: 2 }}>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        useCanvas.getState().centerOnNode(h.nodeId)
                      }}
                      title={t('commandTrail.go_to_agent')}
                      style={{
                        background: 'none',
                        border: 'none',
                        padding: 0,
                        color: '#9fb2d8',
                        cursor: 'pointer',
                        fontSize: 10.5
                      }}
                    >
                      {titleFor(h.nodeId)}
                    </button>
                    {' · '}
                    {relTime(h.ts, now)}
                    {' · '}
                    <span style={{ color: meta.color }}>{t(meta.labelKey)}</span>
                  </div>
                </div>
                <div style={{ flex: '0 0 auto', display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      copy(h.cmd)
                    }}
                    title={t('commandTrail.copy_title')}
                    style={quickStyle('rgba(120,150,220,0.4)')}
                  >
                    {t('commandTrail.copy')}
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      setActive(i)
                      rerun(h)
                    }}
                    title={
                      h.risk === 'destructive'
                        ? t('commandTrail.rerun_title_destructive')
                        : t('commandTrail.rerun_title')
                    }
                    style={quickStyle(
                      armed ? 'rgba(255,107,107,0.7)' : 'rgba(122,162,255,0.45)'
                    )}
                  >
                    {armed ? t('commandTrail.confirm') : t('commandTrail.rerun')}
                  </button>
                </div>
              </div>
            )
          })
        )}
      </div>

      {selected && selected.risk === 'destructive' && armId === selected.id && (
        <div style={{ marginTop: 6, fontSize: 11, color: '#ff9b9b' }}>
          {t('commandTrail.armed_hint')}
        </div>
      )}
    </div>
  )
}

function quickStyle(accent: string): React.CSSProperties {
  return {
    flex: '0 0 auto',
    background: 'rgba(8,12,26,0.6)',
    border: `1px solid ${accent}`,
    borderRadius: 8,
    padding: '3px 9px',
    color: '#eaf1ff',
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 700
  }
}

function FilterChip({
  label,
  active,
  color,
  onClick
}: {
  label: string
  active: boolean
  color: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: active ? `${color}26` : 'rgba(8,12,26,0.55)',
        border: `1px solid ${active ? color : 'rgba(120,150,220,0.18)'}`,
        borderRadius: 8,
        padding: '3px 9px',
        color: active ? '#eaf1ff' : '#9fb2d8',
        cursor: 'pointer',
        fontSize: 11
      }}
    >
      {label}
    </button>
  )
}
