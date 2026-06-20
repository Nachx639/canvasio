import { useEffect, useRef, useState } from 'react'
import { useCanvas } from '../store/canvas'
import { useT } from '../store/i18n'

/**
 * Waypoints — a small glass pill rail (bottom-left, styled like the Minimap /
 * DirectorChip) listing the saved camera views as numbered chips. Camera-only:
 * every action calls a store method that only tweens/edits the camera bookmark —
 * it never mutates node/shape geometry or touches IPC. The whole rail is hidden
 * when there are no waypoints, so it adds no chrome until the feature is used.
 *
 *   • click a chip   → goWaypoint (fly the camera to that saved view)
 *   • ✎              → inline rename
 *   • ×              → remove
 *   • ＋ Guardar vista → saveWaypoint (snapshot the current camera)
 */
export function WaypointRail(): JSX.Element | null {
  const waypoints = useCanvas((s) => s.waypoints)
  const goWaypoint = useCanvas((s) => s.goWaypoint)
  const removeWaypoint = useCanvas((s) => s.removeWaypoint)
  const renameWaypoint = useCanvas((s) => s.renameWaypoint)
  const saveWaypoint = useCanvas((s) => s.saveWaypoint)
  const t = useT()

  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editingId) inputRef.current?.focus()
  }, [editingId])

  // Hidden entirely until the user saves a view (no chrome cost when unused).
  if (waypoints.length === 0) return null

  const beginEdit = (id: string, name: string): void => {
    setEditingId(id)
    setDraft(name)
  }
  const commitEdit = (): void => {
    if (editingId) renameWaypoint(editingId, draft)
    setEditingId(null)
    setDraft('')
  }

  return (
    <div
      className="waypoint-rail glass no-drag"
      role="navigation"
      aria-label={t('waypointRail.nav_aria')}
    >
      {waypoints.map((wp, i) => (
        <div className="waypoint-chip" key={wp.id} title={t('waypointRail.go_title', { name: wp.name })}>
          <span className="waypoint-num" aria-hidden>
            {i < 9 ? i + 1 : '⚑'}
          </span>
          {editingId === wp.id ? (
            <input
              ref={inputRef}
              className="waypoint-edit"
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
                // Don't let global 1..9 / shortcuts fire while renaming.
                e.stopPropagation()
              }}
              aria-label={t('waypointRail.rename_input_aria')}
            />
          ) : (
            <>
              <button
                type="button"
                className="waypoint-name"
                onClick={() => goWaypoint(wp.id)}
                aria-label={t('waypointRail.go_aria', { name: wp.name })}
              >
                {wp.name}
              </button>
              <button
                type="button"
                className="waypoint-act"
                onClick={() => beginEdit(wp.id, wp.name)}
                title={t('waypointRail.rename_title')}
                aria-label={t('waypointRail.rename_aria', { name: wp.name })}
              >
                ✎
              </button>
              <button
                type="button"
                className="waypoint-act"
                onClick={() => removeWaypoint(wp.id)}
                title={t('waypointRail.delete_title')}
                aria-label={t('waypointRail.delete_aria', { name: wp.name })}
              >
                ×
              </button>
            </>
          )}
        </div>
      ))}
      <button
        type="button"
        className="waypoint-chip waypoint-add"
        onClick={() => saveWaypoint()}
        title={t('waypointRail.save_title')}
        aria-label={t('waypointRail.save_aria')}
      >
        <span className="waypoint-num" aria-hidden>
          ＋
        </span>
        {t('waypointRail.save_label')}
      </button>
    </div>
  )
}
