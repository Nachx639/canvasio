# Liquid Glass — implementation recipe (CanvasIO)

Distilled from Apple HIG (Materials / Liquid Glass), ui-layouts, freefrontend, creative-tim
david-ui, donnywals. Target: Chromium/Electron 33. The signature "liquid glass" look =
**translucent frosted material that refracts the wallpaper behind it, with crisp content on
top and a specular (light) edge**. The wallpaper must visibly bleed THROUGH the windows.

## Core layers (compose all of these)

1. **Translucent tinted base** — semi-transparent, NOT solid. Dark theme example:
   `background: rgba(14, 24, 46, 0.55);` (tune 0.45–0.7 for legibility vs see-through).

2. **Backdrop blur + saturate + slight brightness** — frosts + enriches the wallpaper behind:
   `backdrop-filter: blur(16px) saturate(180%) brightness(1.06);`
   `-webkit-backdrop-filter: ...;` (always include the -webkit- prefix).
   IMPORTANT: backdrop-filter blurs the BACKDROP (pixels behind the element), NOT the element's
   own children — so text/glyphs rendered inside stay perfectly crisp over a blurred wallpaper.

3. **Refraction / "liquid" edge warp (the premium signature)** — an SVG filter that distorts the
   backdrop like curved glass. Inline an SVG once (hidden) and reference it in backdrop-filter:
   ```html
   <svg width="0" height="0" style="position:absolute">
     <filter id="canvasio-glass" x="-20%" y="-20%" width="140%" height="140%">
       <feTurbulence type="fractalNoise" baseFrequency="0.008 0.008" numOctaves="2" seed="92" result="noise"/>
       <feGaussianBlur in="noise" stdDeviation="2" result="blurred"/>
       <feDisplacementMap in="SourceGraphic" in2="blurred" scale="40" xChannelSelector="R" yChannelSelector="G"/>
     </filter>
   </svg>
   ```
   ```css
   backdrop-filter: url(#canvasio-glass) blur(14px) saturate(170%);
   ```
   PERF WARNING: url()-displacement backdrop-filter is EXPENSIVE. With ~8+ live terminal
   windows it can tank FPS. Options: (a) apply refraction ONLY to a thin edge pseudo-element,
   not the whole body; (b) make it a gated/opt-in "fancy" tier; (c) ship the cheaper
   blur+saturate material on the body and add the refraction just on hover/focus. Measure.

4. **Specular highlight edges** — the bright "light catching the glass" rim:
   ```css
   box-shadow:
     inset 0 1px 0 rgba(255,255,255,0.45),     /* top specular line */
     inset 1px 0 0 rgba(255,255,255,0.10),
     inset -1px 0 0 rgba(255,255,255,0.06),
     inset 0 -1px 0 rgba(255,255,255,0.04),
     0 10px 30px rgba(0,0,0,0.40),             /* ambient depth */
     0 2px 8px rgba(0,0,0,0.30);               /* key shadow */
   border: 1px solid rgba(255,255,255,0.14);   /* hairline */
   ```

5. **Sheen overlay** — a faint diagonal/radial gloss via a ::before/::after:
   ```css
   ::before { content:''; position:absolute; inset:0; border-radius:inherit; pointer-events:none;
     background: linear-gradient(135deg, rgba(255,255,255,0.10), rgba(255,255,255,0) 40%); }
   ```

6. **Accent tint (theme-aware)** — mix the app accent into border/glow on focus:
   `border-color: color-mix(in srgb, var(--canvasio-accent) 40%, rgba(255,255,255,0.14));`
   `box-shadow: ..., 0 0 0 1px color-mix(in srgb, var(--canvasio-accent) 24%, transparent);`

## Making the TERMINAL interior glass (the hard part)

The terminal windows must be translucent so the wallpaper shows through behind the text.
- `.node` / `.node-body`: translucent base (layer 1) + backdrop-filter (layers 2/3). Do NOT
  paint an opaque `#070c18` body anymore.
- **xterm background must be TRANSPARENT** so the glass shows behind glyphs:
  - xterm options: `allowTransparency: true`, `theme: { background: 'rgba(0,0,0,0)' }` (or a
    very low-alpha tint like 'rgba(8,12,24,0.18)' for readability).
  - CAVEAT (STALE for @xterm/addon-webgl 0.18.0 — the version vendored here): this caveat is
    outdated. Verified in addon-webgl@0.18.0 that the WebGL2 context is created with
    `alpha: allowTransparency`, `_getBackgroundColor` returns NULL_COLOR (a transparent quad)
    for empty cells when `allowTransparency` is set, and the glyph-atlas path branches on
    `allowTransparency` — so WebGL transparency works. We KEEP WebGL (perf at ~8 terminals)
    with `allowTransparency:true` + a low-alpha `theme.background` tint, frosting the
    screen-space `.terminal-overlay-box` behind the transparent canvas. Historically
    (older versions) the addon had POOR transparency support — a transparent theme may render
    black. Mitigations the design must evaluate:
    (a) drop to the canvas/DOM renderer for transparency; (b) keep WebGL but render the GLASS
    as a layer BEHIND a transparent-cleared webgl canvas; (c) use a low-alpha tint that the
    WebGL renderer tolerates. TerminalOverlay.tsx paints xterm in SCREEN SPACE on top of the
    window — the glass body sits under it; ensure the overlay canvas is transparent where there
    are no glyphs and that occlusion (z-based visible-region clip) still works.
- **Legibility**: terminal text over a busy wallpaper needs contrast. Keep enough base alpha
  (or a subtle dark tint behind text) so code stays readable on bright wallpaper areas; the
  reference keeps a darkened glass, not clear glass. Aim WCAG-ish 4.5:1 for body text.

## Legibility + adaptivity (Apple HIG)

- Thicker (more opaque) material for DENSE content (terminals), thinner for sparse HUD chrome.
- Material should enhance, not compete with, the wallpaper. Don't over-blur to mud.
- Respect that everything must stay readable on ANY theme/wallpaper.

## Where this applies in CanvasIO

Windows (.node/.node-body, NodeView, TerminalOverlay xterm theme) = the big one. Plus the
already-glassy HUD via the shared `.glass`/`.glass-solid` classes (keep those in sync with this
material). Keep z-occlusion + TerminalOverlay geometry (HEADER 34 / BORDER 1 / radius 14)
intact. Action menus that must stay legible over content (arrange popover) stay opaque.
