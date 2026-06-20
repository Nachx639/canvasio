// PromptModal.tsx
//
// The in-app, centered dark-glass modal that backs promptText() — Electron has
// no working window.prompt(), so this is its replacement. Mounted ONCE near the
// top of the app (App.tsx) at a high zIndex so it floats above every panel.
// Renders null whenever no request is pending.
//
// React #185 discipline: we read each store slice as its own primitive/stable
// ref via separate selectors (the `request` object ref + the stable `settle`
// action) — no derived/new-ref selectors. The local input text is plain
// component state, re-seeded whenever a new request opens (keyed effect on the
// request object identity).

import { useEffect, useRef, useState } from 'react'
import { usePromptModal } from '../store/promptModal'
import { useT } from '../store/i18n'

export function PromptModal(): JSX.Element | null {
  const t = useT()
  const request = usePromptModal((s) => s.request)
  const settle = usePromptModal((s) => s.settle)

  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Re-seed the field and focus + select-all every time a new request opens.
  // Depends on the request object identity (a fresh ref per open()), so it runs
  // once per prompt, not on every keystroke.
  useEffect(() => {
    if (!request) return
    setValue(request.defaultValue)
    // Defer focus to after the input has mounted/painted.
    const id = window.requestAnimationFrame(() => {
      const el = inputRef.current
      if (el) {
        el.focus()
        el.select()
      }
    })
    return () => window.cancelAnimationFrame(id)
  }, [request])

  if (!request) return null

  const accept = (): void => settle(value)
  const cancel = (): void => settle(null)

  return (
    <div
      role="presentation"
      onPointerDown={(e) => e.stopPropagation()}
      // Click on the backdrop (outside the card) cancels.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancel()
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.45)'
      }}
    >
      <div
        className="glass no-drag"
        role="dialog"
        aria-modal="true"
        aria-label={request.message}
        // Swallow clicks inside the card so they don't reach the backdrop.
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          minWidth: 380,
          maxWidth: 'min(560px, 90vw)',
          padding: '18px 20px',
          borderRadius: 14,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          color: '#e8ecf1'
        }}
      >
        <label
          htmlFor="prompt-modal-input"
          style={{ fontSize: 14, lineHeight: 1.4, opacity: 0.92 }}
        >
          {request.message}
        </label>
        <input
          id="prompt-modal-input"
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              accept()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              cancel()
            }
          }}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            padding: '9px 11px',
            fontSize: 14,
            color: '#e8ecf1',
            background: 'rgba(255, 255, 255, 0.06)',
            border: '1px solid rgba(255, 255, 255, 0.16)',
            borderRadius: 9,
            outline: 'none'
          }}
        />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            onClick={cancel}
            style={{
              padding: '7px 14px',
              fontSize: 13,
              color: '#e8ecf1',
              background: 'rgba(255, 255, 255, 0.07)',
              border: '1px solid rgba(255, 255, 255, 0.16)',
              borderRadius: 8,
              cursor: 'pointer'
            }}
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={accept}
            style={{
              padding: '7px 14px',
              fontSize: 13,
              color: '#04231a',
              background: '#48d597',
              border: '1px solid #48d597',
              borderRadius: 8,
              cursor: 'pointer',
              fontWeight: 600
            }}
          >
            {t('files.accept')}
          </button>
        </div>
      </div>
    </div>
  )
}
