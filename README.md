# react-canvas-ai

> 🖌️ A lightweight, flexible React component and hook for drawing and extracting masks from images using canvas. Perfect for AI workflows, in-browser image editing tools, and selective manipulation.

---

## 🧠 What is `react-canvas-ai`?

`react-canvas-ai` is a modern and actively maintained React library that allows users to **draw freeform masks over images**, extract those masked regions, and integrate with **AI-powered image processing** workflows or any kind of **canvas-based editing tool**.

It’s built as an enhanced fork of [`react-mask-editor`](https://www.npmjs.com/package/react-mask-editor), rewritten with:

- ✅ Hook-based architecture
- 🔁 Undo/redo support
- 🔧 Flexible API
- 🧼 Clean and modern codebase

---

## 🚀 Features

- ✅ Draw 1-bit (black/white) masks over any image using a brush tool
- 🩹 Erase with `Shift` + drag or the secondary mouse button
- 🔁 Undo/redo and clear support
- 🎨 Customizable brush: size, color, opacity, blend mode
- 🔍 Zoom and pan capabilities for precise mask editing
- 🖱️ Intuitive controls: mouse wheel zoom, space+drag panning
- 📦 Use as a component, hook, or via React context
- ⚡ Imperative API via `ref`
- 📱 Responsive design that adapts to container size
- 🧪 Local demo/example app included

---

## 📆 Installation

```bash
pnpm add react-canvas-ai
# or
npm install react-canvas-ai
```

There is **no stylesheet to import** — the component applies everything it needs itself.

> **Versioning:** this package uses CalVer (`YY.M.MICRO`, e.g. `26.8.0`). Version numbers
> carry no semver meaning, so a `^` range *can* pull in breaking changes. Pin an exact
> version if that matters to you.

---

## 👨‍💼 Basic Usage – React Component

```tsx
import { useRef } from 'react';
import { MaskEditor, toMask } from 'react-canvas-ai';

const MyComponent = () => {
  const canvas = useRef(null);
  return (
    <>
      <MaskEditor src="https://placekitten.com/256/256" ref={canvas} />
      <button
        onClick={() => {
          if (canvas.current?.maskCanvas) {
            console.log(toMask(canvas.current.maskCanvas));
          }
        }}
      >
        Get Mask
      </button>
    </>
  );
};
```

### Pre-loading an Existing Mask

You can resume editing from a previously saved mask by passing it as the `initialMask` prop:

```tsx
import { useRef, useState } from 'react';
import { MaskEditor, toMask } from 'react-canvas-ai';

const MyComponent = () => {
  const canvas = useRef(null);
  const [savedMask, setSavedMask] = useState(null);

  return (
    <>
      <MaskEditor 
        src="https://placekitten.com/256/256" 
        ref={canvas}
        initialMask={savedMask} // Load previously saved mask
        onMaskChange={(mask) => {
          // Auto-save mask on changes
          localStorage.setItem('myMask', mask);
        }}
      />
      <button
        onClick={() => {
          if (canvas.current?.maskCanvas) {
            const mask = toMask(canvas.current.maskCanvas);
            setSavedMask(mask);
            localStorage.setItem('myMask', mask);
          }
        }}
      >
        Save Mask
      </button>
      <button
        onClick={() => {
          const loadedMask = localStorage.getItem('myMask');
          if (loadedMask) {
            setSavedMask(loadedMask);
          }
        }}
      >
        Load Saved Mask
      </button>
    </>
  );
};
```


---

## ⚙️ Component Props

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `src` | `string` | Yes | — | Source URL of the image to edit. |
| `onDrawingChange` | `(isDrawing: boolean) => void` | Yes | — | Called when the user starts or stops drawing. |
| `ref` | `Ref<MaskEditorCanvasRef>` | No | — | The editor's imperative handle — see [Ref API](#-ref-api-maskeditorcanvasref). Was `canvasRef` before the React 19 release. |
| `className` | `string` | No | — | Appended to the root element's own class name. |
| `style` | `React.CSSProperties` | No | — | Merged over the root element's built-in layout styles (yours win). |
| `cursorSize` | `number` | No | `10` | Radius in pixels of the brush. |
| `onCursorSizeChange` | `(size: number) => void` | No | — | Called when the user changes the brush size with the wheel. Omit it and wheel resizing is disabled. |
| `maskOpacity` | `number` | No | `0.4` | CSS opacity of the mask layer, 0–1. |
| `maskColor` | `string` | No | `#ffffff` | Hex colour for the mask, with or without the leading `#`. Changing it retints strokes that are already on the canvas. |
| `maskBlendMode` | `MaskBlendMode` | No | `normal` | [CSS blend mode](https://developer.mozilla.org/en-US/docs/Web/CSS/blend-mode) for the mask layer. |
| `maxWidth` | `number` | No | `1240` | Images wider than this are scaled down. |
| `maxHeight` | `number` | No | `1240` | Images taller than this are scaled down. |
| `crossOrigin` | `string` | No | `anonymous` | `crossOrigin` attribute for the underlying `<img>`. Useful for CORS images. |
| `onUndoRequest` | `() => void` | No | — | Called when the user requests an undo. |
| `onRedoRequest` | `() => void` | No | — | Called when the user requests a redo. |
| `onMaskChange` | `(mask: string) => void` | No | — | Called with the mask as a data URL. Debounced while drawing. |
| `initialMask` | `string` | No | — | Pre-load an existing mask as a base64 data URL, to resume from a saved state. Expects exactly what `onMaskChange` produces — white is masked, black is not — and the round trip is lossless. |
| `scale` | `number` | No | `1` | Initial zoom scale. |
| `minScale` | `number` | No | `0.8` | Minimum zoom scale. |
| `maxScale` | `number` | No | `4` | Maximum zoom scale. |
| `onScaleChange` | `(scale: number) => void` | No | — | Called when the zoom scale changes. |
| `enableWheelZoom` | `boolean` | No | `true` | Allow `Ctrl`/`Cmd` + wheel to zoom. |
| `onPanChange` | `(x: number, y: number) => void` | No | — | Called when the pan position changes. |
| `constrainPan` | `boolean` | No | `true` | Keep the image within view while panning. |
| `keyboardScope` | `'window' \| 'container'` | No | `window` | Where undo/redo and the pan modifier keys are listened for. Use `container` when more than one editor is on the page. |

`MaskBlendMode` is the union of the CSS `mix-blend-mode` keywords: `normal`, `multiply`,
`screen`, `overlay`, `darken`, `lighten`, `color-dodge`, `color-burn`, `hard-light`,
`soft-light`, `difference`, `exclusion`, `hue`, `saturation`, `color`, `luminosity`.

---

## 🧩 Ref API (`MaskEditorCanvasRef`)

The `MaskEditor` component exposes useful methods via `ref`:

| Name            | Type                             | Description                                                    |
| --------------- | -------------------------------- | -------------------------------------------------------------- |
| `maskCanvas?`   | `HTMLCanvasElement`              | The mask canvas element, or `undefined` before it has mounted. See the representation note below. |
| `maskColor`     | `string`                         | The colour strokes are currently painted with.                 |
| `maskOpacity`   | `number`                         | The mask layer's current opacity.                              |
| `maskBlendMode` | `MaskBlendMode`                  | The mask layer's current `mix-blend-mode`.                     |
| `cursorSize`    | `number`                         | The current brush diameter, wheel-driven changes included.     |
| `undo()`        | `() => void`                     | Undo the last mask change.                                     |
| `redo()`        | `() => void`                     | Redo the last undone mask change.                              |
| `clear()`       | `() => void`                     | Clear the mask.                                                |
| `resetZoom()`   | `() => void`                     | Reset zoom to initial scale and center the image.              |
| `setPan()`      | `(x: number, y: number) => void` | Set the pan position manually.                                 |
| `zoomIn()`      | `() => void`                     | Zoom in by one step (0.2 scale increment).                     |
| `zoomOut()`     | `() => void`                     | Zoom out by one step (0.2 scale decrement).                    |

The four style members are live reads of what the editor is painting with right now, so a peer
component or plugin that draws into `maskCanvas` itself can match hand-painted strokes without
being handed the same style props a second time.

The mask layer holds `maskColor` at full alpha wherever the image is masked and is **fully
transparent everywhere else** — coverage is the state, and no colour is reserved to mean
anything. If you draw into `maskCanvas` yourself, add coverage with alpha and remove it with
`globalCompositeOperation = 'destination-out'`; painting an opaque "background" colour over a
stroke does not unmask it, it just paints over the photo.

---

## 🧪 Advanced Usage

### Using the `useMaskEditor` hook

You can manage the full mask editing flow yourself:

```tsx
const CustomMaskEditor = () => {
  const {
    canvasRef,
    clear,
    cursorCanvasRef,
    handleMouseDown,
    handleMouseUp,
    key,
    maskBlendMode,
    maskCanvasRef,
    maskOpacity,
    redo,
    transform,
    effectiveScale,
    size,
    undo,
    containerProps,
    resetZoom,
    isPanning,
    setPan,
  } = useMaskEditor({
    src: 'https://placekitten.com/256/256',
    maskColor: '#00ff00',
    maxWidth: 1024, // Optional: limit image width
    maxHeight: 1024, // Optional: limit image height
    onDrawingChange: (drawing) => console.log(drawing),
    // Zoom and pan options
    scale: 1, // Initial scale
    minScale: 0.5, // Minimum zoom allowed
    maxScale: 5, // Maximum zoom allowed
    enableWheelZoom: true, // Enable mouse wheel zoom
    constrainPan: true, // Keep image in view while panning
    keyboardScope: 'window', // 'container' scopes shortcuts to the focused editor
    onScaleChange: (newScale) => console.log(`Zoom level: ${newScale}`),
    onPanChange: (x, y) => console.log(`Pan position: ${x}, ${y}`),
  });

  const transformStyle = useMemo(() => {
    return {
      position: 'absolute' as const,
      top: '50%',
      left: '50%',
      transform: `translate(-50%, -50%) scale(${effectiveScale}) translate(${transform.translateX}px, ${transform.translateY}px)`,
      transformOrigin: 'center',
      transition: isPanning ? 'none' : 'transform 0.15s ease-out',
      width: size.x + 'px',
      height: size.y + 'px',
      display: 'block',
    };
  }, [transform, effectiveScale, isPanning, size]);

  return (
    <div
      className="react-mask-editor-outer"
      style={{
        maxWidth: `${1024}px`,
        maxHeight: `${1024}px`,
        minHeight: '300px',
        width: '100%',
        height: '100%',
      }}
      tabIndex={0}
    >
      <div className="controls">
        <button onClick={undo}>Undo</button>
        <button onClick={redo}>Redo</button>
        <button onClick={clear}>Clear</button>
        <button onClick={resetZoom}>Reset Zoom</button>
        <button onClick={() => setPan(0, 0)}>Center Image</button>
      </div>
      <div
        className="react-mask-editor-inner"
        {...containerProps}
        style={{
          width: '100%',
          height: '100%',
          overflow: 'hidden',
          position: 'relative',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        <div
          className="canvas-container"
          style={{
            position: 'relative',
            maxWidth: '100%',
            maxHeight: '100%',
            width: '100%',
            height: '100%',
            minHeight: '200px',
            overflow: 'hidden',
          }}
        >
          <div className="all-canvases" style={transformStyle}>
            <canvas
              key={key}
              ref={canvasRef}
              style={{
                width: size.x,
                height: size.y,
              }}
              width={size.x}
              height={size.y}
              className="react-mask-editor-base-canvas"
            />
            <canvas
              ref={maskCanvasRef}
              width={size.x}
              height={size.y}
              style={{
                width: size.x,
                height: size.y,
                opacity: maskOpacity,
                mixBlendMode: maskBlendMode as any,
              }}
              className="react-mask-editor-mask-canvas"
            />
            <canvas
              ref={cursorCanvasRef}
              width={size.x}
              height={size.y}
              onMouseUp={handleMouseUp}
              onMouseDown={handleMouseDown}
              style={{
                width: size.x,
                height: size.y,
                cursor: isPanning ? 'grabbing' : 'default',
              }}
              className="react-mask-editor-cursor-canvas"
            />
          </div>
        </div>
      </div>
    </div>
  );
};
```

### Using `MaskEditorProvider` context

Ideal if you want to split canvas and controls across components:

```tsx
import {
  MaskEditorLayers,
  MaskEditorProvider,
  useMaskEditorContext,
} from 'react-canvas-ai';

const MaskEditorCanvas = () => {
  const { containerProps, transform, isPanning } = useMaskEditorContext();

  return (
    // Spread containerProps: it carries the ref, focus handling and the Space
    // interception that keyboard shortcuts and panning depend on.
    <div
      {...containerProps}
      style={{ width: '100%', height: '500px', position: 'relative' }}
    >
      <div
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: `translate(-50%, -50%) scale(${transform.scale}) translate(${transform.translateX}px, ${transform.translateY}px)`,
          transition: isPanning ? 'none' : 'transform 0.15s ease-out',
        }}
      >
        {/* Renders the three canvases with the right stacking, z-order,
            pointer-events and blend mode. Use maskEditorLayerStyles instead if
            you need to lay them out yourself. */}
        <MaskEditorLayers />
      </div>
    </div>
  );
};

const MaskEditorControls = () => {
  const { undo, redo, clear, resetZoom, setPan, scale, zoomIn, zoomOut } =
    useMaskEditorContext();

  return (
    <div className="controls">
      <button onClick={undo}>Undo</button>
      <button onClick={redo}>Redo</button>
      <button onClick={clear}>Clear</button>
      <button onClick={zoomIn}>Zoom In</button>
      <button onClick={zoomOut}>Zoom Out</button>
      <button onClick={resetZoom}>Reset Zoom</button>
      <button onClick={() => setPan(0, 0)}>Center Image</button>
      <div>Current Zoom: {Math.round(scale * 100)}%</div>
    </div>
  );
};

const App = () => (
  <MaskEditorProvider
    src="https://placekitten.com/256/256"
    maxWidth={1024} // Optional: limit image width
    maxHeight={1024} // Optional: limit image height
    crossOrigin="anonymous" // Optional: set crossOrigin for CORS
    onDrawingChange={() => {}}
    // Zoom and pan options
    scale={1}
    minScale={0.5}
    maxScale={5}
    enableWheelZoom={true}
    constrainPan={true}
    keyboardScope='window'
    onScaleChange={(scale) => console.log(`Zoom: ${scale}`)}
    onPanChange={(x, y) => console.log(`Pan: ${x}, ${y}`)}
  >
    <MaskEditorCanvas />
    <MaskEditorControls />
  </MaskEditorProvider>
);
```

---

## 🔍 Zoom and Pan Features

The editor includes sophisticated zoom and pan capabilities to enable precise mask editing:

### User Interactions

- **Zoom**: Use `Ctrl/Cmd + Mouse Wheel` to zoom in/out centered on image
- **Pan**: Hold `Space` and drag to pan the image, or use middle mouse button
- **Erase**: Hold `Shift` and drag, or drag with the secondary mouse button, to rub the mask away
- **Resize Brush**: Use `Mouse Wheel` (without modifier keys) to adjust brush size
- **Undo / Redo**: `Ctrl/Cmd + Z` and `Ctrl/Cmd + Y` (or `Ctrl/Cmd + Shift + Z`)

### Keyboard scope

By default the editor listens for shortcuts on `window`, so `Ctrl/Cmd + Z` works from
anywhere on the page. That is the right behaviour for a single editor, but it means **two
editors on the same page both respond to one keystroke**.

Set `keyboardScope="container"` to make an editor respond only while focus is inside it:

```jsx
<MaskEditor src={src} onDrawingChange={setDrawing} keyboardScope='container' />
```

In this mode the editor takes focus when you click it, and shows a focus ring you can
restyle through the `.react-mask-editor-inner` class. Keystrokes typed into an `<input>`,
`<textarea>` or `contenteditable` element are ignored in both modes.

Key *releases* are never scoped — a `Space` release is honoured even if focus has since
moved, so panning cannot get stuck on.

### Zoom Control API

The editor now provides explicit zoom control methods through the imperative API:

- **zoomIn()**: Increases zoom by 0.2 scale increment (respects maxScale limit)
- **zoomOut()**: Decreases zoom by 0.2 scale decrement (respects minScale limit)
- **resetZoom()**: Resets zoom to scale 1 and centers the image
- **setPan(x, y)**: Manually sets the pan position

These methods can be accessed through:

- Component ref: `maskEditorRef.current.zoomIn()`
- Context: `const { zoomIn } = useMaskEditorContext()`
- Hook: `const { zoomIn } = useMaskEditor(props)`

Perfect for implementing custom toolbar zoom controls with buttons or sliders!

### Automatic Behaviors

- **Responsive Scaling**: Images automatically scale to fit their container
- **Smooth Transitions**: Gentle animations when zooming (disabled during active panning)
- **Position Constraints**: Optional boundaries prevent the image from being panned too far out of view
- **Centered Reset**: `resetZoom()` function centers the image and resets scale to 1

### Programmatic Control

```tsx
// Example of programmatically controlling zoom and pan
const CustomZoomControls = () => {
  const maskEditorRef = useRef(null);

  return (
    <>
      <button onClick={() => maskEditorRef.current?.zoomIn()}>Zoom In</button>
      <button onClick={() => maskEditorRef.current?.zoomOut()}>Zoom Out</button>
      <button onClick={() => maskEditorRef.current?.resetZoom()}>
        Reset Zoom & Center
      </button>
      <button onClick={() => maskEditorRef.current?.setPan(50, 20)}>
        Move to Position
      </button>
    </>
  );
};
```

---

## 💡 Use Cases

`react-canvas-ai` is great for:

- ✨ **AI image editing apps** (e.g. Stable Diffusion, DALL·E, Sora, etc.)
- 🔧 **Web-based design tools** (like Figma clones or mockup tools)
- 📍 **Educational tools** where users interact with images
- 🔮 **Selective filtering or redacting images** (blur, crop, etc.)
- 🚀 **Creative playgrounds** or generative UIs

---

## 🎨 Styling

The component ships **no CSS file** and requires no import. Structural styles (canvas
stacking, sizing, compositor hints) are applied inline so the library works in any
bundler and any SSR setup out of the box.

Two ways to customise it:

```tsx
<MaskEditor src={src} onDrawingChange={setDrawing} className='my-editor' style={{ maxHeight: 600 }} />
```

Or target the stable class names, which are kept purely as styling hooks:

`react-mask-editor-outer` · `react-mask-editor-inner` · `canvas-container` ·
`all-canvases` · `react-mask-editor-base-canvas` · `react-mask-editor-mask-canvas` ·
`react-mask-editor-cursor-canvas`

Because the built-in rules are inline, a plain class selector will not beat them — use
the `style` prop (it is merged last and wins) or `!important` in your own stylesheet.

---

## 🔀 Migrating to the React 19 release

CalVer carries no semver signal, so breaking changes are called out here rather than in the
version number. Pin an exact version if you need to upgrade deliberately.

1. **React 19.2 or newer is required.** The peer range was `>=18 <20` and is now `^19.2.0`.
   This is what lets the package use `useEffectEvent`, ref callbacks with cleanup and the
   `<Context>` provider shorthand instead of hand-rolled equivalents.
2. **`MaskEditor`'s `canvasRef` prop is now `ref`.** React 19 passes `ref` as an ordinary
   prop, so the editor's imperative handle uses the standard spelling:
   ```diff
   - <MaskEditor src={src} canvasRef={canvas} />
   + <MaskEditor src={src} ref={canvas} />
   ```
3. **`containerProps.ref` is a callback ref.** Spread `containerProps` rather than reaching
   into it — the zoom/pan wiring has to be told when the container attaches, which a ref
   object cannot do. `containerRef` is still returned, but it is an *output*: attaching it
   by hand instead of spreading `containerProps` leaves the editor unable to fit, zoom or
   pan.
4. **`canvasRef`, `maskCanvasRef` and `cursorCanvasRef` are callable refs.** They are now
   `ElementHandle`, which is a ref callback that also carries `.current`. Both
   `<canvas ref={maskCanvasRef} />` and `maskCanvasRef.current` keep working unchanged; only
   the type differs. This is what lets a conditionally rendered canvas still receive its 2D
   context and brush listeners.
5. **`setCursorSize` takes a number.** It used to be typed as the raw `useState` dispatch.
   Updater functions are no longer accepted:
   ```diff
   - setCursorSize((n) => n + 1);
   + setCursorSize(cursorSize + 1);
   ```
6. **A re-fit preserves your zoom.** `scale` and `transform.scale` used to be separate state
   that disagreed: the mount fit wrote the transform without touching `scale`, so
   `scale={2}` rendered zoomed but could not be panned. They are one value now — an initial
   scale above 1 both renders and pans, and a container resize recentres the pan while
   keeping the zoom instead of silently discarding it.
7. **`onScaleChange` and `onPanChange` are diff-based.** They fire when the value actually
   changes, so they no longer report `1` and `(0, 0)` at mount, and a redundant `resetZoom()`
   at the default view reports nothing.
8. **`onDrawingChange` no longer fires at mount.** It is reported from the pointer handlers
   that own the transition, so the spurious `false` before the user had touched the canvas
   is gone.
9. **The mask canvas holds coverage, not colour.** Masked pixels are `maskColor` at full
   alpha and everything else is fully transparent — there is no white "background" value any
   more. Erasing removes coverage (`destination-out`) instead of painting white over it,
   `toMask` classifies by alpha instead of RGB, and `initialMask` is converted into that
   representation rather than drawn over a white fill. This fixes erasing (which used to
   smear white across the image and never unmask the export), `maskColor: '#000000'` (which
   exported as blank), retinting a mask painted in the default white, the white fringes left
   on any `maskColor` with `r === 255`, and the `onMaskChange` → `initialMask` round trip
   (which used to come back masked everywhere). If you paint into `maskCanvas` yourself, use
   alpha rather than a background colour.

### Earlier breaking changes (from `26.8.x`)

1. **`history` is now `historyLength`.** The hook used to hand back the raw `ImageData[]`,
   which kept every retained undo state alive for as long as you held the hook's return
   value. If you only rendered a count, swap the property:
   ```diff
   - <span>States: {history.length}</span>
   + <span>States: {historyLength}</span>
   ```
2. **`maxHistorySize` is now `maxHistoryBytes`.** Entries are full uncompressed RGBA
   buffers, so a count-based cap scaled with canvas area — 50 states of a 1602×900 canvas
   is roughly 288 MB. The budget is now expressed in bytes and defaults to 64 MB, so a
   large canvas keeps fewer states and a small one keeps more. At least one state is always
   retained.
3. **`setScale` clamps and moves the view.** It used to be the raw state setter, so it
   changed `scale` without touching `transform` — leaving `effectiveScale` and the rendered
   CSS transform disagreeing. It now takes a plain `number`, clamps to
   `[minScale, maxScale]`, and moves the transform with it. Updater functions are no longer
   accepted:
   ```diff
   - setScale((s) => s + 0.2);
   + zoomIn(); // or setScale(scale + 0.2)
   ```
4. **Headless consumers should spread `containerProps`.** `useMaskEditor` now returns a
   `containerProps` bundle (ref, `role`, `tabIndex`, key handling, focus-on-mousedown) in
   place of the bare `containerRef`. This fixes `keyboardScope: 'container'` for
   `MaskEditorProvider` consumers, for whom the focus half of it previously did nothing:
   ```diff
   - <div ref={containerRef}>
   + <div {...containerProps}>
   ```
5. **`MaskEditorLayers` replaces hand-rolled canvas stacks.** The stacking, z-order,
   pointer-events and blend-mode contract is exported now, so a headless layout no longer
   has to re-derive it (and silently lose mask opacity or blend mode). Use
   `maskEditorLayerStyles(...)` if you need to place the canvases yourself.
6. **`restoreFromHistory` is gone** from `useHistory`'s return. Use `undo`/`redo`.

---

## 🔀 Migrating from `react-canvas-masker` 1.x

1. **Rename the dependency** to `react-canvas-ai` and update every import.
2. **Delete the stylesheet import.** `import 'react-canvas-masker/dist/style.css'` no
   longer exists and is no longer needed.
3. **Drop ref casts.** Refs are now typed `RefObject<T | null>`, matching what
   `useRef<T>(null)` actually returns under React 19:
   ```diff
   - const canvas = useRef<MaskEditorCanvasRef>(null) as RefObject<MaskEditorCanvasRef>;
   + const canvas = useRef<MaskEditorCanvasRef>(null);
   ```
4. **Re-check your version range.** Versioning is CalVer now — see
   [Installation](#-installation).

Fixed along the way: `ref.current.maskCanvas` used to stay `null` forever, losing focus
mid-pan left the page stuck on `cursor: grabbing`, and `toMask` crashed when a 2D context
was unavailable.

---

## 🛠️ Development

```bash
pnpm install
pnpm dev:playground   # library in watch mode + playground on :3000
pnpm check            # what CI runs: biome + typecheck + tests
pnpm build            # ESM + CJS + .d.ts
```

Releases are cut by pushing a CalVer tag:

```bash
git tag 26.8.0
git push origin 26.8.0
```

The release workflow stamps that tag onto `packages/react-canvas-ai/package.json` (via
`scripts/set-version.mjs`) and publishes to npm. The version in the manifest on `main` is
only a placeholder between releases — the tag is the source of truth.

### Why the build is set up this way

Worth recording, because it is a decision to revisit rather than rediscover.

TypeScript 7.0 is a ground-up rewrite in Go, and it does **not** yet expose the
JavaScript compiler API (`import * as ts from 'typescript'`) or emit declarations. That
breaks every tool that generates `.d.ts` through the compiler — `vite-plugin-dts`,
`tsup --dts`, api-extractor. It is not a Vite limitation: ordinary Vite apps run fine on
TS 7, and the playground here does.

So this package sets `isolatedDeclarations: true` and lets **tsdown** generate
declarations with oxc (Rust), which never loads the TypeScript compiler. The cost is
explicit type annotations on exported symbols.

**What changes in TS 7.1:** a new compiler API is being built for 7.1, with declaration
emit on the list. Once it ships, `vite-plugin-dts` and friends can support TS 7 and this
constraint disappears.

**The decision to make then:** keep `isolatedDeclarations` (faster, parallel, Rust-speed
`.d.ts`, but the annotations must be maintained) or drop it and let the compiler infer
declarations (no annotations, slower builds). Note that `isolatedDeclarations` shipped in
TS 5.5, well before the Go rewrite — it is a deliberate design direction, not a TS 7
workaround — so **both options stay valid long term**, and the annotations are not wasted
either way, since explicit public return types are good API hygiene regardless.

Sources worth re-checking when the time comes:
[TypeScript 7 progress](https://devblogs.microsoft.com/typescript/progress-on-typescript-7-december-2025/) ·
[tsdown dts options](https://tsdown.dev/options/dts)

---

## 📜 Notes

- All mask operations are done on a separate canvas for performance
- The mask is returned as a **black-and-white PNG (base64)** — white where masked, black where
  not. A pixel counts as masked when the mask layer is at least half covered there, so
  anti-aliased stroke edges resolve on export the same way they look on screen
- Supports up to 50 undo/redo steps
- Forked and modernized from [`react-mask-editor`](https://www.npmjs.com/package/react-mask-editor)

---

## 📖 License

Apache-2.0 — see [LICENSE](./LICENSE).

---

## 🙌 About This Fork

This is a cleaned-up and improved version of an unmaintained package, refactored into a hook-first, React 18+ friendly library with a focus on AI tooling and performance. Key enhancements include:

- Advanced zoom and pan capabilities for precise editing
- Optimized event handling and rendering
- Responsive design that adapts to container dimensions
- Improved coordinate calculations for pixel-perfect precision
- Enhanced user controls with intuitive keyboard and mouse interactions
