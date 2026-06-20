import { useEffect, useRef, useState } from 'react'
import { useRecall } from '../store/recall'
import { useFrostRect } from '../hooks/useFrostRect'
import { useBoard } from '../store/board'
import { useDraggablePanel } from '../lib/useDraggablePanel'
import { PanelGrip } from './PanelGrip'
import { useT } from '../store/i18n'

/**
 * Recall Panel — the dockable review surface for the persisted Cross-Mission
 * memory (store/recall.ts). A sibling of BriefBoard: a glass, no-drag, draggable
 * panel that lists every REMEMBERED fact (attribution chip + text + hits badge),
 * and lets you forget one, pin it back to the live Brief Board, or wipe the whole
 * knowledge base.
 *
 * Opened via the 'canvasio:open-recall' CustomEvent (dispatched by the 'M' key in
 * App.tsx and the Command Palette), mirroring the BriefBoard + 'canvasio:open-
 * board' pattern. Purely renderer-side and read-only over the persisted store
 * otherwise — it CALLS store actions (forget / clearAll / useBoard.pin) but never
 * touches IPC, geometry, or canvas serialization. The store owns persistence.
 */
export function RecallPanel(): JSX.Element | null {
  const t = useT()
  const [open, setOpen] = useState(false)
  const facts = useRecall((s) => s.facts)
  const { style: dragStyle, dragHandleProps } = useDraggablePanel('recall')

  // Frost-reveal ref (declared before the early `return null` so the hook order
  // is stable; closed → ref null → useFrostRect unregisters cleanly).
  const frostRef = useRef<HTMLDivElement>(null)
  useFrostRect(frostRef, { radius: 14, active: open })

  // Open / toggle on the shared event so App.tsx + the palette can drive it.
  useEffect(() => {
    const onOpen = (): void => setOpen((v) => !v)
    window.addEventListener('canvasio:open-recall', onOpen)
    return () => window.removeEventListener('canvasio:open-recall', onOpen)
  }, [])

  // Esc closes while open (capture phase so it wins over App's plain-key shortcuts).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  if (!open) return null

  // Pin a remembered fact BACK into the live Brief Board, so a relevant memory can
  // re-enter the active mission's shared pool and be injected/corroborated again.
  const pinBack = (id: string): void => {
    const f = useRecall.getState().facts.find((x) => x.id === id)
    if (!f) return
    useBoard.getState().pin({
      text: f.text,
      sourceTitle: f.sourceTitle,
      agent: f.agent
    })
  }

  return (
    <div
      ref={frostRef}
      className="glass no-drag recall-panel"
      data-canvasio-panel-root
      style={{
        pointerEvents: 'auto',
        position: 'absolute',
        top: 46,
        right: 16,
        borderRadius: 14,
        padding: 14,
        width: 360,
        maxHeight: '74vh',
        display: 'flex',
        flexDirection: 'column',
        fontSize: 13,
        color: '#d7e1f7',
        zIndex: 60,
        ...dragStyle
      }}
    >
      <PanelGrip dragHandleProps={dragHandleProps} />

      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontWeight: 700, fontSize: 14 }}>Recall</span>
        <span
          style={{
            marginLeft: 8,
            fontSize: 10.5,
            color: '#9af0c6',
            border: '1px solid rgba(72,213,151,0.35)',
            borderRadius: 6,
            padding: '1px 6px'
          }}
        >
          {t('recallPanel.persistent_memory')}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 10.5, color: '#6f84ad' }}>
          {facts.length}{' '}
          {facts.length === 1 ? t('recallPanel.memory_one') : t('recallPanel.memory_other')}
        </span>
        <button
          onClick={() => setOpen(false)}
          aria-label={t('recallPanel.close_recall')}
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

      <div style={{ overflowY: 'auto', flex: '1 1 auto', minHeight: 0 }}>
        {facts.length === 0 ? (
          <div style={{ fontSize: 12, color: '#6f84ad', padding: '4px 0' }}>
            {t('recallPanel.empty_state')}
          </div>
        ) : (
          facts
            .slice()
            .reverse()
            .map((f) => (
              <div
                key={f.id}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                  padding: '7px 9px',
                  marginBottom: 5,
                  borderRadius: 10,
                  background: 'rgba(8,12,26,0.55)',
                  border: '1px solid rgba(72,213,151,0.16)'
                }}
              >
                <div style={{ flex: '1 1 0', minWidth: 0 }}>
                  {(f.sourceTitle || f.agent) && (
                    <span
                      style={{
                        display: 'inline-block',
                        marginRight: 6,
                        fontSize: 10,
                        lineHeight: 1.4,
                        padding: '1px 6px',
                        borderRadius: 6,
                        color: '#cfe0ff',
                        background: 'rgba(122,162,255,0.16)',
                        border: '1px solid rgba(122,162,255,0.4)',
                        fontWeight: 700,
                        verticalAlign: 'middle'
                      }}
                    >
                      {f.sourceTitle || f.agent}
                    </span>
                  )}
                  <span style={{ fontSize: 12, color: '#d7e1f7', wordBreak: 'break-word' }}>
                    {f.text}
                  </span>
                  {f.hits > 1 && (
                    <span
                      title={t('recallPanel.hits_title', { hits: f.hits })}
                      aria-label={t('recallPanel.hits_label', { hits: f.hits })}
                      style={{
                        display: 'inline-block',
                        marginLeft: 6,
                        fontSize: 10,
                        lineHeight: 1.4,
                        padding: '1px 6px',
                        borderRadius: 6,
                        color: '#9af0c6',
                        background: 'rgba(72,213,151,0.16)',
                        border: '1px solid rgba(72,213,151,0.5)',
                        fontWeight: 700,
                        verticalAlign: 'middle',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      ×{f.hits}
                    </span>
                  )}
                </div>
                <button
                  onClick={() => pinBack(f.id)}
                  aria-label={t('recallPanel.pin_back')}
                  title={t('recallPanel.pin_back_title')}
                  style={{
                    flex: '0 0 auto',
                    background: 'none',
                    border: 'none',
                    color: '#7aa2ff',
                    cursor: 'pointer',
                    fontSize: 13,
                    lineHeight: 1
                  }}
                >
                  📌
                </button>
                <button
                  onClick={() => useRecall.getState().forget(f.id)}
                  aria-label={t('recallPanel.forget')}
                  title={t('recallPanel.forget_title')}
                  style={{
                    flex: '0 0 auto',
                    background: 'none',
                    border: 'none',
                    color: '#6f84ad',
                    cursor: 'pointer',
                    fontSize: 13,
                    lineHeight: 1
                  }}
                >
                  ✕
                </button>
              </div>
            ))
        )}
      </div>

      {facts.length > 0 && (
        <button
          onClick={() => useRecall.getState().clearAll()}
          title={t('recallPanel.clear_all_title')}
          style={{
            marginTop: 10,
            width: '100%',
            background: 'rgba(255,120,120,0.12)',
            color: '#ffb0b0',
            border: '1px solid rgba(255,120,120,0.4)',
            borderRadius: 10,
            padding: '8px 12px',
            fontWeight: 700,
            fontSize: 12.5,
            cursor: 'pointer'
          }}
        >
          {t('recallPanel.clear_all')}
        </button>
      )}
    </div>
  )
}
