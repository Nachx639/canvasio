import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useVoiceChat } from '../store/voiceChat'

/**
 * Glass CHAT BUBBLES for the spoken voice exchange. Renders the recent turns
 * (user on the right, assistant on the left) in the dark-glass style used
 * elsewhere, fading the oldest turns and auto-hiding the whole strip a while
 * after the last activity so it never blocks the canvas.
 *
 * REACTIVITY: the bubble list is read via useShallow so a new array reference
 * each render does NOT retrigger React #185 (the project's known crash mode).
 */
export function VoiceBubbles(): JSX.Element | null {
  // Stable, shallow-compared slice — never a fresh .map()/.filter() in the
  // selector (that would loop-crash the renderer).
  const bubbles = useVoiceChat(useShallow((s) => s.bubbles))

  // Auto-hide the strip a few seconds after the last turn so it doesn't linger
  // over the canvas. Any new bubble resets the timer (via the last id/length).
  const last = bubbles.length ? bubbles[bubbles.length - 1] : null
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!last) {
      setVisible(false)
      return
    }
    setVisible(true)
    const t = setTimeout(() => setVisible(false), 14000)
    return () => clearTimeout(t)
  }, [last?.id, bubbles.length])

  if (!bubbles.length) return null

  return (
    <div
      style={{
        position: 'absolute',
        left: '50%',
        bottom: 132,
        transform: 'translateX(-50%)',
        zIndex: 44,
        width: 'min(720px, 60vw)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        pointerEvents: 'none',
        opacity: visible ? 1 : 0,
        transition: 'opacity 0.6s ease',
        // Fade the TOP of the strip so older turns dissolve into the starfield.
        maskImage: 'linear-gradient(to bottom, transparent 0%, #000 22%)',
        WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, #000 22%)'
      }}
    >
      {bubbles.map((b, i) => {
        // Older bubbles get progressively dimmer; the newest is fully opaque.
        const age = bubbles.length - 1 - i
        const dim = Math.max(0.4, 1 - age * 0.16)
        const isUser = b.role === 'user'
        return (
          <div
            key={b.id}
            style={{
              alignSelf: isUser ? 'flex-end' : 'flex-start',
              maxWidth: '82%',
              opacity: dim
            }}
          >
            <div
              className="glass"
              style={{
                padding: '8px 13px',
                borderRadius: 14,
                borderBottomRightRadius: isUser ? 4 : 14,
                borderBottomLeftRadius: isUser ? 14 : 4,
                fontSize: 13.5,
                lineHeight: 1.35,
                color: isUser ? '#e8eefc' : '#cdd9f5',
                background: isUser
                  ? 'rgba(91,140,255,0.22)'
                  : 'rgba(18,22,38,0.62)',
                border: isUser
                  ? '1px solid rgba(122,162,255,0.5)'
                  : '1px solid rgba(255,255,255,0.1)',
                boxShadow: '0 6px 24px -10px rgba(0,0,0,0.7)',
                backdropFilter: 'blur(14px)',
                WebkitBackdropFilter: 'blur(14px)',
                wordBreak: 'break-word'
              }}
            >
              {b.text}
            </div>
          </div>
        )
      })}
    </div>
  )
}
