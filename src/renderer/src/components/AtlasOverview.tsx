import { useEffect, useMemo, useState } from 'react'
import { useCanvas, AGENT_LABEL } from '../store/canvas'
import { useLens } from '../store/lens'
import { useMission } from '../store/mission'
import { computeHeat } from '../lib/thermal'
import { AGENT_COLOR } from './MissionLog'
import { STATUS_COLOR } from './NodeView'
import { useT } from '../store/i18n'

// Atlas — Hold-O Spatial Overview (Exposé for the Canvas).
//
// Press and hold (or tap) 'O' and the whole infinite canvas is reframed as a
// grid of large, readable, live thumbnails laid out to fit the screen at once.
// Each tile shows the kind glyph, the agent/title, a one-line subtitle and a
// status dot (idle/working/done/error). Tiles are laid out in (y,x) reading
// order — the SAME ordering arrange()/cycleNode/JumpHints use — so positions
// feel learnable and consistent with the rest of the nav suite. Click a tile
// (or type its ace-jump letter) and the camera springs straight to that node;
// release/Esc without picking and the camera is exactly where it was (Atlas
// never moves the camera — it only paints tiles).
//
// CONTRACT: purely additive, renderer-only. It READS the canvas/lens/mission
// stores + camera and reuses the EXISTING centerOnNode for the teleport (full
// Slipstream/Wayback participation for free). It never mutates node/shape
// geometry, never touches IPC/main, and adds no persistence. It renders NOTHING
// (zero chrome/cost) when inactive, matching the project's convention.

// Home-row-first ace-jump alphabet — fast to reach, deliberate order. Single
// chars for the first 9 tiles; two-char combos for any overflow (mirrors
// JumpHints.buildLabels so labels stay learnable across the nav suite).
const KEYS = 'asdfghjkl'.split('')

function buildLabels(orderedIds: string[]): Map<string, string> {
  const out = new Map<string, string>()
  if (orderedIds.length <= KEYS.length) {
    orderedIds.forEach((id, i) => out.set(KEYS[i], id))
    return out
  }
  let i = 0
  for (const a of KEYS) {
    for (const b of KEYS) {
      if (i >= orderedIds.length) return out
      out.set(a + b, orderedIds[i])
      i++
    }
  }
  return out
}

const KIND_GLYPH: Record<string, string> = {
  terminal: '▤',
  music: '♪',
  web: '◎'
}

function tileSubtitle(line: string | undefined, fallback: string | undefined): string {
  if (line && line.trim()) return line
  return fallback ?? ''
}

export function AtlasOverview({
  active,
  onClose
}: {
  active: boolean
  onClose: () => void
}): JSX.Element | null {
  const t = useT()
  const nodes = useCanvas((s) => s.nodes)
  const centerOnNode = useCanvas((s) => s.centerOnNode)
  const lensLines = useLens((s) => s.lines)
  const events = useMission((s) => s.events)

  // The chars typed so far while narrowing to a unique ace-jump label.
  const [typed, setTyped] = useState('')
  useEffect(() => {
    if (active) setTyped('')
  }, [active])

  // (y,x) reading order — matches arrange()/cycleNode/JumpHints so tiles land in
  // a stable, learnable layout.
  const ordered = useMemo(() => [...nodes].sort((a, b) => a.y - b.y || a.x - b.x), [nodes])
  const labels = useMemo(() => buildLabels(ordered.map((n) => n.id)), [ordered])
  const idToLabel = useMemo(() => {
    const m = new Map<string, string>()
    for (const [label, id] of labels) m.set(id, label)
    return m
  }, [labels])

  // At-a-glance heat per node (warm = recently active). Computed once on open;
  // Atlas is a momentary survey so it does not need the 1 Hz decay clock.
  const heat = useMemo(() => (active ? computeHeat(events, Date.now()) : new Map()), [active, events])

  const teleport = (id: string): void => {
    onClose()
    centerOnNode(id)
  }

  // Owns the keyboard while open: a typed char narrows the visible tiles; a
  // unique match flies there and exits; Escape / any non-label key cancels.
  // Capture phase + preventDefault/stopPropagation so a stray key never leaks to
  // xterm or the App-level shortcuts while Atlas claims the keyboard.
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) {
        onClose()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
        return
      }
      const ch = e.key.toLowerCase()
      if (ch.length !== 1 || !KEYS.includes(ch)) {
        e.preventDefault()
        e.stopPropagation()
        onClose()
        return
      }
      e.preventDefault()
      e.stopPropagation()
      const next = typed + ch
      const exact = labels.get(next)
      if (exact) {
        teleport(exact)
        return
      }
      let isPrefix = false
      for (const label of labels.keys()) {
        if (label.startsWith(next)) {
          isPrefix = true
          break
        }
      }
      if (isPrefix) setTyped(next)
      else onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, typed, labels])

  if (!active) return null // zero chrome / zero cost when inactive

  return (
    <div
      className="atlas-backdrop"
      role="dialog"
      aria-label={t('atlasOverview.dialog_label')}
      onClick={onClose}
    >
      <div className="atlas-hint">{t('atlasOverview.hint')}</div>
      <div className="atlas-grid">
        {ordered.map((n) => {
          const label = idToLabel.get(n.id) ?? ''
          const matched = !typed || label.startsWith(typed)
          const status = n.status ?? 'idle'
          const dot = STATUS_COLOR[status]
          const accent = n.agent ? AGENT_COLOR[n.agent] : '#7c97e0'
          const title = n.agent ? AGENT_LABEL[n.agent].title : n.title
          const sub = tileSubtitle(lensLines[n.id]?.text, n.subtitle ?? n.title)
          const h = (heat.get(n.id) as number | undefined) ?? 0
          return (
            <button
              key={n.id}
              type="button"
              className="atlas-tile glass"
              data-dim={!matched}
              data-hot={h > 0.55}
              style={{ ['--atlas-accent' as string]: accent }}
              onClick={(e) => {
                e.stopPropagation()
                teleport(n.id)
              }}
            >
              <div className="atlas-tile-head">
                <span className="atlas-glyph" aria-hidden="true">
                  {KIND_GLYPH[n.kind] ?? '▤'}
                </span>
                <span className="atlas-title">{title}</span>
                <span
                  className="atlas-status-dot"
                  style={{ background: dot }}
                  data-working={status === 'working'}
                  title={status}
                />
              </div>
              <div className="atlas-sub">{sub}</div>
              {label && (
                <div className="atlas-label" aria-hidden="true">
                  {typed && label.startsWith(typed) ? (
                    <>
                      <span className="atlas-label-typed">{typed}</span>
                      {label.slice(typed.length)}
                    </>
                  ) : (
                    label
                  )}
                </div>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
