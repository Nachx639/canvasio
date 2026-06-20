import { useCommandTrail } from '../store/commandTrail'

/**
 * Command Trail chip — a compact ⚠ + count shown on a terminal node's header when
 * this agent has run one or more DESTRUCTIVE shell commands (rm -rf, force-push,
 * reset --hard, sudo, curl|sh …). It is the at-a-glance "this agent did something
 * irreversible to your machine" flag. Subscribes by nodeId only (re-renders solely
 * when THIS node's command ring changes) and renders NOTHING otherwise — so a node
 * that never ran a destructive command looks exactly as before.
 *
 * Clicking it opens the Command Trail panel (the same 'canvasio:open-cmdtrail'
 * event the X shortcut / Command Palette use). Pure renderer-side; no geometry/IPC.
 */
export function CommandTrailChip({ nodeId }: { nodeId: string }): JSX.Element | null {
  // Subscribe to this node's ring; recompute the destructive count locally so the
  // chip updates the instant a destructive command lands or the ring is cleared.
  const ring = useCommandTrail((s) => s.entries[nodeId])
  if (!ring || ring.length === 0) return null
  const n = ring.reduce((acc, e) => (e.risk === 'destructive' ? acc + 1 : acc), 0)
  if (n === 0) return null

  return (
    <span
      title={`${n} comando${n === 1 ? '' : 's'} destructivo${n === 1 ? '' : 's'} ejecutado${n === 1 ? '' : 's'} · clic para auditar`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        window.dispatchEvent(new CustomEvent('canvasio:open-cmdtrail'))
      }}
      style={{
        marginLeft: 2,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 10.5,
        lineHeight: 1,
        padding: '2px 6px',
        borderRadius: 6,
        cursor: 'pointer',
        color: '#ffd1d1',
        background: 'rgba(255,107,107,0.16)',
        border: '1px solid rgba(255,107,107,0.45)',
        flex: '0 0 auto',
        userSelect: 'none',
        fontVariantNumeric: 'tabular-nums'
      }}
    >
      <span aria-hidden style={{ fontWeight: 700 }}>⚠</span>
      <span style={{ fontWeight: 700 }}>{n}</span>
    </span>
  )
}
