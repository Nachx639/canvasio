import type { DragHandleProps } from '../lib/useDraggablePanel'
import { useT } from '../store/i18n'

// Subtle drag-grip for a floating HUD panel. A slim centered row of faint dots at
// the very top of a panel; cursor: grab (grabbing while dragging). Spread the
// hook's `dragHandleProps` onto it so ONLY this element starts a drag — never the
// panel's interactive controls (buttons, inputs, swatches, sliders).
//
// Styled to match the dark-glass look. Unobtrusive: a thin band of dim dots that
// brightens slightly on hover.
export function PanelGrip({
  dragHandleProps,
  title,
  style
}: {
  dragHandleProps: DragHandleProps
  title?: string
  style?: React.CSSProperties
}): JSX.Element {
  const t = useT()
  const label = title ?? t('panelGrip.drag_to_move')
  return (
    <div
      {...dragHandleProps}
      role="separator"
      aria-label={label}
      title={label}
      className="panel-grip"
      style={{
        // Full-width slim grab band at the panel top.
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        // A slightly taller band gives an easier hit area to grab the panel.
        height: 18,
        marginBottom: 8,
        borderRadius: 8,
        userSelect: 'none',
        touchAction: 'none',
        // From the hook: cursor:grab + touchAction:none.
        ...dragHandleProps.style,
        ...style
      }}
    >
      {/* a centered row of faint grip dots */}
      {Array.from({ length: 6 }).map((_, i) => (
        <span
          key={i}
          aria-hidden
          style={{
            width: 3,
            height: 3,
            borderRadius: '50%',
            background: 'rgba(160,180,240,0.32)',
            display: 'block'
          }}
        />
      ))}
    </div>
  )
}
