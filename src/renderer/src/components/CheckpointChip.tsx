import { useCheckpoints } from '../store/checkpoints'
import { useT } from '../store/i18n'

/**
 * Checkpoint chip — a compact stacked-layers glyph + count shown on a terminal
 * node's header, right next to the ±N Changeset badge. It reflects how many
 * restorable savepoints (`git stash create` dangling commits, see store/git) this
 * agent has captured. Subscribes by nodeId only (re-renders solely when THIS
 * node's checkpoint list changes) and renders NOTHING when there are none — so a
 * node with no checkpoints looks exactly as before.
 *
 * Clicking it opens the Checkpoint Panel focused on this node (the same
 * 'canvasio:open-checkpoints' CustomEvent the K shortcut / Command Palette use,
 * carrying the nodeId in detail). Pure renderer-side; no geometry/IPC here.
 */
export function CheckpointChip({ nodeId }: { nodeId: string }): JSX.Element | null {
  const t = useT()
  const list = useCheckpoints((s) => s.byNode[nodeId])
  if (!list || list.length === 0) return null
  const n = list.length
  const newest = list[0]
  return (
    <span
      title={
        n === 1
          ? t('checkpointChip.title_one', { adds: newest.adds, dels: newest.dels })
          : t('checkpointChip.title_other', { n, adds: newest.adds, dels: newest.dels })
      }
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        window.dispatchEvent(
          new CustomEvent('canvasio:open-checkpoints', { detail: { nodeId } })
        )
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
        color: '#ffe2b8',
        background: 'rgba(242,200,75,0.16)',
        border: '1px solid rgba(242,200,75,0.42)',
        flex: '0 0 auto',
        userSelect: 'none',
        fontVariantNumeric: 'tabular-nums'
      }}
    >
      {/* stacked-layers glyph */}
      <svg width={12} height={12} viewBox="0 0 16 16" style={{ flex: '0 0 auto' }} aria-hidden>
        <path
          d="M8 1.5 14.5 5 8 8.5 1.5 5 8 1.5Z"
          fill="none"
          stroke="#f2c84b"
          strokeWidth={1.2}
          strokeLinejoin="round"
        />
        <path
          d="M1.5 8 8 11.5 14.5 8"
          fill="none"
          stroke="#f2c84b"
          strokeWidth={1.2}
          strokeLinejoin="round"
        />
        <path
          d="M1.5 11 8 14.5 14.5 11"
          fill="none"
          stroke="#f2c84b"
          strokeWidth={1.2}
          strokeLinejoin="round"
        />
      </svg>
      <span style={{ fontWeight: 700 }}>{n}</span>
    </span>
  )
}
