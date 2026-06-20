import { useEffect, useRef, useState } from 'react'
import { useT } from '../store/i18n'

type Phase = 'idle' | 'downloading' | 'ready'

/** Shape of window.canvasio.updater per the preload bridge contract. */
type UpdaterApi = {
  check: () => Promise<void>
  install: () => Promise<void>
  onAvailable: (cb: (version: string) => void) => () => void
  onProgress: (cb: (percent: number) => void) => () => void
  onDownloaded: (cb: (version: string) => void) => () => void
  onError: (cb: (message: string) => void) => () => void
}

/**
 * Reads the updater bridge defensively. The preload exposes
 * `window.canvasio.updater`; in DEV / unpackaged builds the bridge may be a no-op
 * but is still present. We cast locally so this component compiles standalone.
 */
function getUpdater(): UpdaterApi | undefined {
  const w = window as typeof window & { canvasio?: { updater?: UpdaterApi } }
  return w.canvasio?.updater
}

/**
 * Fixed top-right glass toast surfacing electron-updater events.
 *  - 'downloading' -> "Descargando actualización… N%"
 *  - 'ready'       -> "Actualización lista · Reiniciar para aplicar" + Reiniciar
 *  - 'idle'        -> renders null
 */
export function UpdateToast(): JSX.Element | null {
  const t = useT()
  const [phase, setPhase] = useState<Phase>('idle')
  const [percent, setPercent] = useState(0)
  const [version, setVersion] = useState<string | null>(null)
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const updater = getUpdater()
    if (!updater) return

    const offs: Array<() => void> = []

    offs.push(
      updater.onAvailable((v) => {
        setVersion(v)
        setPhase((p) => (p === 'ready' ? p : 'downloading'))
      })
    )
    offs.push(
      updater.onProgress((pct) => {
        setPercent(Math.max(0, Math.min(100, Math.round(pct))))
        setPhase((p) => (p === 'ready' ? p : 'downloading'))
      })
    )
    offs.push(
      updater.onDownloaded((v) => {
        setVersion(v)
        setPercent(100)
        setPhase('ready')
      })
    )
    offs.push(
      updater.onError(() => {
        // Surface failures quietly: drop back to idle so the toast disappears
        // rather than getting stuck on a stale "downloading" state.
        if (errorTimer.current) clearTimeout(errorTimer.current)
        errorTimer.current = setTimeout(() => {
          setPhase((p) => (p === 'ready' ? p : 'idle'))
        }, 200)
      })
    )

    return () => {
      for (const off of offs) {
        try {
          off()
        } catch {
          /* ignore */
        }
      }
      if (errorTimer.current) clearTimeout(errorTimer.current)
    }
  }, [])

  if (phase === 'idle') return null

  const install = (): void => {
    void getUpdater()?.install()
  }

  return (
    <div
      className="glass no-drag"
      role="status"
      aria-live="polite"
      style={{
        pointerEvents: 'auto',
        position: 'fixed',
        top: 14,
        right: 14,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: phase === 'ready' ? '10px 10px 10px 14px' : '9px 14px',
        borderRadius: 12,
        fontSize: 12.5,
        color: '#e7eeff',
        maxWidth: 320,
        boxShadow: '0 10px 30px -10px rgba(0,0,0,0.55)'
      }}
    >
      {phase === 'downloading' ? (
        <span style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, flex: 1 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <Spinner />
            <span style={{ opacity: 0.92 }}>{t('updateToast.downloading', { percent })}</span>
          </span>
          <span
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            style={{
              display: 'block',
              height: 3,
              borderRadius: 2,
              background: 'rgba(140,165,225,0.2)',
              overflow: 'hidden'
            }}
          >
            <span
              style={{
                display: 'block',
                height: '100%',
                width: `${percent}%`,
                borderRadius: 2,
                background: 'var(--canvasio-accent, #5b8cff)',
                transition: 'width 200ms ease'
              }}
            />
          </span>
        </span>
      ) : (
        <>
          <span style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <span aria-hidden style={{ fontSize: 13 }}>✨</span>
            <span style={{ opacity: 0.95 }}>
              {t('updateToast.ready')}
              {version ? ` · v${version}` : ''}
              <span style={{ opacity: 0.6 }}> · {t('updateToast.restart_to_apply')}</span>
            </span>
          </span>
          <button
            onClick={install}
            aria-label={t('updateToast.restart_aria')}
            title={t('updateToast.restart_to_apply')}
            style={{
              flexShrink: 0,
              border: 'none',
              borderRadius: 8,
              padding: '6px 12px',
              fontSize: 12,
              fontWeight: 600,
              color: '#fff',
              cursor: 'pointer',
              background: 'var(--canvasio-accent, #5b8cff)',
              boxShadow: '0 6px 16px -6px rgba(91,140,255,0.7)'
            }}
          >
            {t('updateToast.restart')}
          </button>
        </>
      )}
    </div>
  )
}

function Spinner(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <circle cx="7" cy="7" r="5.5" stroke="rgba(140,165,225,0.25)" strokeWidth="1.6" />
      <path d="M7 1.5a5.5 5.5 0 015.5 5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 7 7"
          to="360 7 7"
          dur="0.8s"
          repeatCount="indefinite"
        />
      </path>
    </svg>
  )
}
