# Graphics, 3D & custom effects

Besides the catalog (text, shapes, components, icons, effects), Claude can design its own graphics, turn layers in 3D, and write its own effects. Everything stays in the project document, so it is editable and undoable.

## Custom graphics (`create_graphic`)

Claude writes an SVG and it is placed on the video like an image overlay: lower thirds, title cards, UI mockups, charts, badges, logos, styled text. Anything SVG draws works, including gradients, masks, clip paths, strokes and filters (`feDropShadow` for shadows, blurs and glows). Fonts in the fonts folder are available by family name.

- The `<svg>` needs a `viewBox`. It is drawn at `width` (a fraction of the frame width) with the viewBox's shape, centered at `position`.
- **Animation:** `{{ expression }}` placeholders anywhere in the SVG are evaluated on every frame. Variables: `t` (seconds), `p` (progress 0..1), `d`, `n`, `w`, `h`. Functions include `sin`, `clamp`, `lerp`, `seg(t,a,b)`, `wave(t,period)` and easings (`easeOut`, `back`, `elastic`, `bounce`). Expressions are parsed by a small math grammar, never run as code.
- A still SVG becomes a PNG; an animated one becomes a lossless video with transparency (FFV1). The SVG source is kept on the asset (`svg`), and `update_graphic` redraws it.
- Rendering needs the optional package `@resvg/resvg-js`.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 120">
  <filter id="s"><feDropShadow dy="6" stdDeviation="8" flood-opacity="0.5"/></filter>
  <rect width="{{ 800*easeOut(seg(t,0,0.6)) }}" height="120" rx="20" fill="#2B6CFF" filter="url(#s)"/>
  <text x="40" y="78" font-family="Montserrat" font-size="52" fill="#fff" opacity="{{ seg(t,0.4,0.8) }}">New feature</text>
</svg>
```

## 3D layers

Media and graphic layers take `rotateX` (tilt), `rotateY` (turn) and `perspective` (camera distance in layer widths, default 2), and `animate_layer` animates `rotateX` and `rotateY` with keyframes: card flips, spins, tilted screens. The layer is projected through a pinhole camera with FFmpeg's `perspective` filter, after its rounded corners and shadow. For 3D text, draw the text with `create_graphic` and turn the graphic.

## Custom effects (`create_effect`)

The `custom` effect runs an FFmpeg filter chain Claude writes, for looks the catalog lacks: per-pixel math with `geq`, glitches, light trails, lens distortion, comic looks. `create_effect` saves one by name in the project (`customEffects`), and `add_effect` with `{ type: "custom", params: { name } }` uses it.

- Only filters that change the picture of one stream are allowed (`CUSTOM_FILTERS`). Filters that read or write files, take extra streams or change timing are refused, and so are `[labels]` and `;`.
- Every chain is test-rendered on a small picture before it is saved or added, so mistakes come back as errors instead of failed renders.
- The frame size is restored after geometry filters. Chains that mix frames or use time (`lagfun`, `t` in an expression) are not cached per clip.

## Fonts

`install_fonts` installs whole packs of Google Fonts families at once (sans, display, serif, script, handwriting, mono: 132 families), six downloads at a time, skipping installed ones. `install_font` adds a single family, and `list_fonts` lists what is available.
