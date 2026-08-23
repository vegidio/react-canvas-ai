---
'react-canvas-ai': patch
---

Restart the project as `react-canvas-ai` on a rebuilt toolchain.

**Breaking changes**

- Renamed from `react-canvas-masker` to `react-canvas-ai`.
- **No stylesheet is shipped any more.** Remove `import 'react-canvas-masker/dist/style.css'` — all styles are applied by the component itself, so no CSS import is required.
- Ref types now reflect reality: `canvasRef` and friends are `RefObject<T | null>`, matching React 19's `useRef<T>(null)`. Casts that worked around the old types can be deleted.
- Versioning moved to CalVer (`YY.M.MICRO`). A `^` range can therefore pull in breaking changes; pin exactly if that matters to you.

**Added**

- `className` and `style` props on `<MaskEditor />` for styling the root element.

**Fixed**

- `ref.current.maskCanvas` stayed `null` forever; it now resolves to the live mask canvas.
- Losing focus mid-pan left the page stuck on `cursor: grabbing`.
- `toMask` crashed when a 2D context was unavailable.
