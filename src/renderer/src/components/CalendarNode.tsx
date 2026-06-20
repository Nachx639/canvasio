import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { CanvasNode } from '../store/canvas'
import { useCalendar } from '../store/calendar'
import { useT } from '../store/i18n'

/**
 * Calendar node — a month view backed by the GLOBAL, cross-canvas calendar store
 * (useCalendar). Annotations live in that store keyed by ISO date (YYYY-MM-DD),
 * NOT on this node, so the same notes appear in any calendar node on any canvas
 * and survive app restarts. Clicking a day opens an in-node panel to view, add,
 * and remove that day's notes; every CRUD op writes straight to the global store.
 *
 * Body is opaque (glass-solid) so it reads cleanly at any zoom, and it never uses
 * an xterm overlay — the whole node is plain DOM inside the CSS-transformed world,
 * so it stays crisp. The scrollable content is marked data-canvas-scroll and stops
 * wheel propagation so scrolling the grid / day panel never pans the canvas.
 */

// i18n key arrays — month names (0-based) and Monday-first weekday abbreviations.
// The translator resolves each per the active language; es.ts holds the originals.
const MONTH_KEYS = [
  'files.month_january',
  'files.month_february',
  'files.month_march',
  'files.month_april',
  'files.month_may',
  'files.month_june',
  'files.month_july',
  'files.month_august',
  'files.month_september',
  'files.month_october',
  'files.month_november',
  'files.month_december'
]
const WEEKDAY_KEYS = [
  'files.weekday_mon',
  'files.weekday_tue',
  'files.weekday_wed',
  'files.weekday_thu',
  'files.weekday_fri',
  'files.weekday_sat',
  'files.weekday_sun'
]

/** Local ISO YYYY-MM-DD for a given year/month(0-based)/day — no UTC drift. */
function isoOf(year: number, month: number, day: number): string {
  const m = String(month + 1).padStart(2, '0')
  const d = String(day).padStart(2, '0')
  return `${year}-${m}-${d}`
}

/** Today's local date parts. */
function todayParts(): { y: number; m: number; d: number; iso: string } {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()
  const d = now.getDate()
  return { y, m, d, iso: isoOf(y, m, d) }
}

/** Build the 6×7 grid of day cells for a month, Monday-first, with leading/trailing blanks. */
function monthCells(year: number, month: number): (number | null)[] {
  const first = new Date(year, month, 1)
  // JS getDay: 0=Sun..6=Sat → shift so Monday=0.
  const lead = (first.getDay() + 6) % 7
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const cells: (number | null)[] = []
  for (let i = 0; i < lead; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(d)
  while (cells.length % 7 !== 0) cells.push(null)
  return cells
}

export function CalendarNode({ node }: { node: CanvasNode }): JSX.Element {
  const tr = useT()
  // The whole annotations map drives the day-has-notes dots. Read primitively
  // (object reference) — it only changes identity on a mutation, so the grid
  // re-renders exactly when a note is added/removed.
  const annotations = useCalendar((s) => s.annotations)

  // "Today" as STATE (not a mount-once memo) so a long-open session updates the
  // highlight + "Hoy" button after midnight. Poll once a minute; only set state
  // when the day actually rolls over (cheap, avoids needless re-renders).
  const [t, setT] = useState(todayParts)
  useEffect(() => {
    const id = window.setInterval(() => {
      setT((prev) => {
        const next = todayParts()
        return next.iso === prev.iso ? prev : next
      })
    }, 60_000)
    return () => window.clearInterval(id)
  }, [])
  const [viewYear, setViewYear] = useState(t.y)
  const [viewMonth, setViewMonth] = useState(t.m)
  // Open day panel (ISO string) or null when closed.
  const [selectedDate, setSelectedDate] = useState<string | null>(null)

  const cells = useMemo(() => monthCells(viewYear, viewMonth), [viewYear, viewMonth])

  const goPrev = (): void => {
    setViewMonth((m) => {
      if (m === 0) {
        setViewYear((y) => y - 1)
        return 11
      }
      return m - 1
    })
  }
  const goNext = (): void => {
    setViewMonth((m) => {
      if (m === 11) {
        setViewYear((y) => y + 1)
        return 0
      }
      return m + 1
    })
  }
  const goToday = (): void => {
    setViewYear(t.y)
    setViewMonth(t.m)
  }

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        // Translucent glass tint (the SAME token + alpha as the terminal) so the
        // in-world <NodeFrost> behind the node shows through. NodeView renders the
        // frost canvas as the bottom layer of .node-body; this body sits over it.
        background: 'rgba(var(--glass-term-tint), var(--glass-term-alpha))'
      }}
    >
      {/* Month header: prev / title / next + Hoy */}
      <div
        style={{
          flex: '0 0 auto',
          padding: '8px 12px',
          borderBottom: '1px solid rgba(120,150,220,0.14)',
          display: 'flex',
          alignItems: 'center',
          gap: 8
        }}
      >
        <span style={{ flex: '0 0 auto', fontSize: 14 }}>📅</span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 13,
            fontWeight: 700,
            color: '#eaf1ff',
            textTransform: 'capitalize',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {tr(MONTH_KEYS[viewMonth])} {viewYear}
        </span>
        <button
          title={tr('files.today')}
          aria-label={tr('files.go_to_today')}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            goToday()
          }}
          style={navBtn}
        >
          {tr('files.today')}
        </button>
        <button
          title={tr('files.prev_month')}
          aria-label={tr('files.prev_month')}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            goPrev()
          }}
          style={arrowBtn}
        >
          ‹
        </button>
        <button
          title={tr('files.next_month')}
          aria-label={tr('files.next_month')}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            goNext()
          }}
          style={arrowBtn}
        >
          ›
        </button>
      </div>

      {/* Weekday row */}
      <div
        style={{
          flex: '0 0 auto',
          display: 'grid',
          gridTemplateColumns: 'repeat(7, 1fr)',
          padding: '6px 10px 2px',
          gap: 4
        }}
      >
        {WEEKDAY_KEYS.map((wk) => (
          <div
            key={wk}
            style={{
              textAlign: 'center',
              fontSize: 10,
              fontWeight: 600,
              color: '#5b6887',
              textTransform: 'uppercase',
              letterSpacing: 0.4
            }}
          >
            {tr(wk)}
          </div>
        ))}
      </div>

      {/* Day grid (scrollable if the node is short) */}
      <div
        data-canvas-scroll
        onWheel={(e) => e.stopPropagation()}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          padding: '2px 10px 12px',
          display: 'grid',
          gridTemplateColumns: 'repeat(7, 1fr)',
          gridAutoRows: 'minmax(40px, 1fr)',
          gap: 4
        }}
      >
        {cells.map((day, i) => {
          if (day == null) return <div key={`blank-${i}`} />
          const iso = isoOf(viewYear, viewMonth, day)
          const count = annotations[iso]?.length ?? 0
          const isToday = iso === t.iso
          return (
            <button
              key={iso}
              title={
                count > 0
                  ? count === 1
                    ? tr('files.note_count_one', { count })
                    : tr('files.note_count_many', { count })
                  : tr('files.no_notes')
              }
              aria-label={
                count > 0
                  ? tr('files.day_with_notes', { day, count })
                  : tr('files.day', { day })
              }
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                setSelectedDate(iso)
              }}
              style={{
                position: 'relative',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 3,
                borderRadius: 8,
                border: isToday
                  ? '1px solid rgba(122,162,255,0.85)'
                  : '1px solid rgba(120,150,220,0.12)',
                // Day cells carry their OWN opaque-enough surface (not the near-
                // transparent 0.02 that relied on the old opaque body) so numbers
                // keep contrast over the translucent frost behind the node.
                background: isToday ? 'rgba(122,162,255,0.22)' : 'rgba(8,13,26,0.32)',
                color: isToday ? '#dce8ff' : '#c2cdec',
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: isToday ? 700 : 500,
                padding: 0
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = isToday
                  ? 'rgba(122,162,255,0.32)'
                  : 'rgba(120,160,255,0.2)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = isToday
                  ? 'rgba(122,162,255,0.22)'
                  : 'rgba(8,13,26,0.32)'
              }}
            >
              <span>{day}</span>
              {count > 0 && (
                <span
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: 50,
                    background: '#7aa2ff',
                    boxShadow: '0 0 6px rgba(122,162,255,0.8)'
                  }}
                />
              )}
            </button>
          )
        })}
      </div>

      {selectedDate && (
        <DayPanel date={selectedDate} onClose={() => setSelectedDate(null)} />
      )}
    </div>
  )
}

/**
 * Floating day panel — absolutely positioned over the calendar body. Lists the
 * day's notes (each with a trash button), an input + Add to append a new one,
 * and a close affordance (the ✕ button, Esc, or clicking the dimmed backdrop).
 * Reads the day's notes via useShallow over the store array (React #185 guard),
 * and writes directly through the global store actions.
 */
function DayPanel({ date, onClose }: { date: string; onClose: () => void }): JSX.Element {
  const tr = useT()
  // React #185 guard: subscribe via useShallow so a fresh `?? []` array literal
  // doesn't force a re-render every parent tick — only when the contents change.
  const notes = useCalendar(useShallow((s) => s.annotations[date] ?? []))
  const [draft, setDraft] = useState('')

  // Esc closes the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const submit = (): void => {
    const t = draft.trim()
    if (!t) return
    useCalendar.getState().addNote(date, t)
    setDraft('')
  }

  // Human title e.g. "17 de junio de 2026".
  const [y, m, d] = date.split('-').map((n) => parseInt(n, 10))
  const title = tr('files.day_title', { day: d, month: tr(MONTH_KEYS[m - 1]), year: y })

  return (
    <div
      // Dim backdrop — clicking outside the card closes the panel.
      onPointerDown={(e) => {
        e.stopPropagation()
        onClose()
      }}
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(4,8,18,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        zIndex: 2
      }}
    >
      <div
        // The card itself: swallow pointer/wheel so canvas drag/pan never leaks.
        onPointerDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 360,
          maxHeight: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: '#0e1426',
          border: '1px solid rgba(122,162,255,0.32)',
          borderRadius: 12,
          boxShadow: '0 12px 40px rgba(0,0,0,0.55)',
          overflow: 'hidden'
        }}
      >
        <div
          style={{
            flex: '0 0 auto',
            padding: '10px 12px',
            borderBottom: '1px solid rgba(120,150,220,0.16)',
            display: 'flex',
            alignItems: 'center',
            gap: 8
          }}
        >
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 13,
              fontWeight: 700,
              color: '#eaf1ff',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {title}
          </span>
          <button
            title={tr('common.close')}
            aria-label={tr('common.close')}
            onClick={(e) => {
              e.stopPropagation()
              onClose()
            }}
            style={{
              flex: '0 0 auto',
              width: 22,
              height: 22,
              borderRadius: 6,
              background: 'rgba(120,150,220,0.14)',
              border: '1px solid rgba(120,150,220,0.3)',
              color: '#cfe0ff',
              cursor: 'pointer',
              fontSize: 12,
              lineHeight: 1,
              padding: 0
            }}
          >
            ✕
          </button>
        </div>

        {/* Notes list (scrollable) */}
        <div
          data-canvas-scroll
          onWheel={(e) => e.stopPropagation()}
          style={{
            flex: 1,
            minHeight: 0,
            overflow: 'auto',
            padding: '8px 12px',
            display: 'flex',
            flexDirection: 'column',
            gap: 6
          }}
        >
          {notes.length === 0 ? (
            <div
              style={{
                color: '#5b6887',
                fontSize: 12,
                fontStyle: 'italic',
                padding: '8px 0'
              }}
            >
              {tr('files.no_notes_for_day')}
            </div>
          ) : (
            notes.map((n) => (
              <div
                key={n.id}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid rgba(120,150,220,0.14)',
                  borderRadius: 8,
                  padding: '7px 9px'
                }}
              >
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 12.5,
                    lineHeight: 1.45,
                    color: '#dde6fb',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word'
                  }}
                >
                  {n.text}
                </span>
                <button
                  title={tr('files.remove_note')}
                  aria-label={tr('files.remove_note')}
                  onClick={(e) => {
                    e.stopPropagation()
                    useCalendar.getState().removeNote(date, n.id)
                  }}
                  style={{
                    flex: '0 0 auto',
                    width: 22,
                    height: 22,
                    borderRadius: 6,
                    background: 'rgba(255,107,107,0.16)',
                    border: '1px solid rgba(255,107,107,0.38)',
                    color: '#ff6b6b',
                    cursor: 'pointer',
                    fontSize: 11,
                    lineHeight: 1,
                    padding: 0
                  }}
                >
                  🗑
                </button>
              </div>
            ))
          )}
        </div>

        {/* Add note */}
        <div
          style={{
            flex: '0 0 auto',
            padding: '10px 12px',
            borderTop: '1px solid rgba(120,150,220,0.16)',
            display: 'flex',
            gap: 8
          }}
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') {
                e.preventDefault()
                submit()
              }
            }}
            placeholder={tr('files.new_note')}
            autoFocus
            style={{
              flex: 1,
              minWidth: 0,
              boxSizing: 'border-box',
              background: '#0a0e1a',
              border: '1px solid rgba(122,162,255,0.28)',
              borderRadius: 7,
              color: '#eaf1ff',
              fontSize: 12.5,
              padding: '7px 9px',
              outline: 'none'
            }}
          />
          <button
            title={tr('files.add_note')}
            aria-label={tr('files.add_note')}
            onClick={(e) => {
              e.stopPropagation()
              submit()
            }}
            style={{
              flex: '0 0 auto',
              background: 'rgba(122,162,255,0.22)',
              border: '1px solid rgba(122,162,255,0.5)',
              borderRadius: 7,
              color: '#cfe0ff',
              cursor: 'pointer',
              fontSize: 12.5,
              fontWeight: 600,
              padding: '7px 12px'
            }}
          >
            {tr('files.add')}
          </button>
        </div>
      </div>
    </div>
  )
}

const navBtn: React.CSSProperties = {
  flex: '0 0 auto',
  background: 'rgba(120,150,220,0.14)',
  border: '1px solid rgba(120,150,220,0.3)',
  borderRadius: 6,
  color: '#cfe0ff',
  cursor: 'pointer',
  fontSize: 11,
  fontWeight: 600,
  lineHeight: 1,
  padding: '4px 8px'
}

const arrowBtn: React.CSSProperties = {
  flex: '0 0 auto',
  width: 24,
  height: 24,
  background: 'rgba(120,150,220,0.14)',
  border: '1px solid rgba(120,150,220,0.3)',
  borderRadius: 6,
  color: '#cfe0ff',
  cursor: 'pointer',
  fontSize: 15,
  lineHeight: 1,
  padding: 0
}
