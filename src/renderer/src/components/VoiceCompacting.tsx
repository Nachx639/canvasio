import { useEffect, useState } from 'react'
import { useT } from '../store/i18n'

/**
 * Small glass NOTICE shown while the voice brain is auto-compacting its
 * conversation (summarize-then-fresh-session). The main process fires
 * `ai:compacting` true/false around the compaction pass; we mirror that flag
 * through the preload subscription in a one-shot effect with proper cleanup.
 *
 * Local state only — no zustand store, no reactive selector — so it cannot hit
 * the project's React #185 selector-loop pitfall. Renders nothing when idle.
 */
export function VoiceCompacting(): JSX.Element | null {
  const t = useT()
  const [active, setActive] = useState(false)

  useEffect(() => {
    const off = window.canvasio?.ai?.onCompacting?.((v) => setActive(!!v))
    return () => {
      // Always clear the flag on unmount so a stale "compacting" can't stick.
      off?.()
      setActive(false)
    }
  }, [])

  if (!active) return null

  return (
    <div
      style={{
        position: 'absolute',
        left: '50%',
        bottom: 100,
        transform: 'translateX(-50%)',
        zIndex: 46,
        pointerEvents: 'none'
      }}
    >
      <div
        className="glass"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          padding: '7px 14px',
          borderRadius: 999,
          fontSize: 12.5,
          lineHeight: 1.2,
          color: '#dbe5fb',
          // Material (bg tint, hairline border, shadow, blur) supplied by `.glass`.
          // Keep only a matching base tint so the rounded pill reads consistently.
          background: 'rgba(17,27,50,0.66)',
          whiteSpace: 'nowrap'
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: '#7aa2ff',
            boxShadow: '0 0 8px 1px rgba(122,162,255,0.8)',
            animation: 'canvasio-compact-pulse 1.1s ease-in-out infinite'
          }}
        />
        {t('voice.compacting')}
      </div>
      <style>{`
        @keyframes canvasio-compact-pulse {
          0%, 100% { opacity: 0.35; transform: scale(0.85); }
          50% { opacity: 1; transform: scale(1.15); }
        }
      `}</style>
    </div>
  )
}
