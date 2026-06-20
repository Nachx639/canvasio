import { useEffect, useRef, useState } from 'react'
import { useCanvas } from '../store/canvas'
import { useT } from '../store/i18n'

/**
 * Stages — Curated Multi-Node Scenes chip (TopBar, right cluster).
 *
 * A tiny inline rail of numbered pills, one per saved Stage (a named, durable
 * SET of node ids — "the 3 agents building the API"). Clicking a pill activates
 * that scene: it frames the camera over the collective bounding box of exactly
 * those nodes and spotlights the subset (dimming the rest) via the SAME
 * .spotlit/.dimmed chrome the Constellation Filter / Lighthouse already render.
 * ⌘⇧1..9 drive the same activateStage from anywhere.
 *
 * No-chrome-until-used: renders NOTHING until the first Stage is captured
 * (matching WaypointRail / TriageChip). While a scene is active an extra "✕"
 * pill releases the isolation (same as Esc / re-click). Inline rename (double-
 * click a pill) and delete (× on the pill) keep it self-managing.
 *
 * Purely renderer-side and additive: it READS the canvas store and CALLS the new
 * Stage store actions — no IPC, no geometry mutation. Persistence rides the
 * existing canvasio:layout path (App.tsx serializes `stages`).
 */
const ACCENT = '#c084fc' // purple, distinct from Triage cyan / Conductor

export function StagesChip(): JSX.Element | null {
  const t = useT()
  const stages = useCanvas((s) => s.stages)
  const stageIds = useCanvas((s) => s.stageIds)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editingId) inputRef.current?.focus()
  }, [editingId])

  // No-chrome-until-used: nothing renders until the first scene is captured.
  if (stages.length === 0) return null

  const isActive = (nodeIds: string[]): boolean => {
    if (!stageIds || stageIds.length !== nodeIds.length) return false
    const set = new Set(stageIds)
    return nodeIds.every((id) => set.has(id))
  }

  const beginEdit = (id: string, name: string): void => {
    setEditingId(id)
    setDraft(name)
  }
  const commitEdit = (): void => {
    if (editingId) useCanvas.getState().renameStage(editingId, draft)
    setEditingId(null)
    setDraft('')
  }

  return (
    <div
      className="no-drag"
      role="navigation"
      aria-label={t('stagesChip.nav_label')}
      style={{
        pointerEvents: 'auto',
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        flex: '0 0 auto'
      }}
    >
      {stages.map((st, i) => {
        const active = isActive(st.nodeIds)
        if (editingId === st.id) {
          return (
            <input
              key={st.id}
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitEdit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitEdit()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  setEditingId(null)
                  setDraft('')
                }
                // Don't let global ⌘⇧1..9 / shortcuts fire while renaming.
                e.stopPropagation()
              }}
              aria-label={t('stagesChip.rename_scene')}
              style={{
                width: 96,
                fontSize: 12,
                padding: '3px 7px',
                borderRadius: 8,
                color: '#e7e0f7',
                background: 'rgba(192,132,252,0.12)',
                border: `1px solid ${ACCENT}66`,
                outline: 'none'
              }}
            />
          )
        }
        return (
          <button
            key={st.id}
            type="button"
            onClick={() => useCanvas.getState().activateStage(st.id)}
            onDoubleClick={() => beginEdit(st.id, st.name)}
            title={`${st.name} — ${t('stagesChip.node_count', { count: st.nodeIds.length })}${i < 9 ? ` · ⌘⇧${i + 1}` : ''} ${t('stagesChip.double_click_rename')}`}
            aria-label={t('stagesChip.activate_scene', { name: st.name, count: st.nodeIds.length })}
            aria-pressed={active}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              borderRadius: 8,
              padding: '4px 8px',
              cursor: 'pointer',
              fontSize: 12.5,
              fontWeight: 600,
              color: active ? ACCENT : '#d7e1f7',
              background: active ? `${ACCENT}26` : 'rgba(192,132,252,0.10)',
              border: `1px solid ${active ? `${ACCENT}88` : `${ACCENT}3a`}`
            }}
          >
            <span
              aria-hidden
              style={{ fontSize: 11, fontWeight: 800, color: active ? ACCENT : '#9fb0c9' }}
            >
              {i < 9 ? i + 1 : '◆'}
            </span>
            <span style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {st.name}
            </span>
            <span
              role="button"
              tabIndex={-1}
              aria-label={t('stagesChip.delete_scene', { name: st.name })}
              title={t('stagesChip.delete_scene_short')}
              onClick={(e) => {
                e.stopPropagation()
                useCanvas.getState().removeStage(st.id)
              }}
              style={{ marginLeft: 1, opacity: 0.55, fontWeight: 700, lineHeight: 1 }}
            >
              ×
            </span>
          </button>
        )
      })}
      {stageIds != null && (
        <button
          type="button"
          onClick={() => useCanvas.getState().clearStage()}
          title={t('stagesChip.exit_scene')}
          aria-label={t('stagesChip.exit_active_scene')}
          style={{
            borderRadius: 8,
            padding: '4px 8px',
            cursor: 'pointer',
            fontSize: 12,
            fontWeight: 700,
            color: '#9fb0c9',
            background: 'rgba(120,140,170,0.12)',
            border: '1px solid rgba(120,140,170,0.28)'
          }}
        >
          ✕
        </button>
      )}
    </div>
  )
}
