# react-canvas-ai

A React mask editor for images — paint binary masks freehand with a brush, or switch to **auto selection** mode and click an object to have AI write its silhouette to the mask for you. Built for AI workflows (inpainting, selective editing, redaction) and any canvas-based image tool.

You can see how it works in the [playground](https://vegidio.github.io/react-canvas-ai/).

## 💡 Motivation

Painting a binary mask over an image with a brush works well — until the thing you actually want to mask is a person, a car, a pet, or any other complex shape. Dragging the brush around its outline is slow, imprecise, and tiring, especially on touch devices.

`react-canvas-ai` ships both interaction modes in one library:

- **`paint` mode** — the freehand editor: brush, eraser, undo/redo, zoom/pan, history, and a lossless black-and-white PNG export of the mask.
- **`auto` mode** — one click on the image and the object under the cursor is segmented by a Segment-Anything-style model; its silhouette is committed to the mask in the same colour, through the same history and change-notification path as a hand-painted stroke. Shift-click (or right-click) subtracts an object instead.

Three things make auto selection practical:

- **Runs entirely in the browser.** No server, no upload, no API key. The bundled backend runs [SlimSAM-77](https://huggingface.co/Xenova/slimsam-77-uniform) (a quantised distillation of Meta's Segment Anything model) through [`onnxruntime-web`](https://onnxruntime.ai/docs/tutorials/web/) on the user's device.
- **Models are persisted client-side.** The first use downloads ~14 MB of ONNX weights; the library caches them in the browser's `Cache` storage, so subsequent visits load with zero network — even after a browser restart.
- **Zero cost when unused.** The AI pipeline lives in a lazily loaded chunk behind a dynamic `import()`. If you never pass the `autoSelect` prop, none of it is downloaded, parsed, or executed — the editor stays a zero-dependency painting library.

## ⬇️ Installation

```bash
$ pnpm add react-canvas-ai
```

Or with `npm` / `yarn`:

```bash
$ npm install react-canvas-ai
$ yarn add react-canvas-ai
```

If you want the AI auto-selection mode, also install the ONNX runtime:

```bash
$ pnpm add onnxruntime-web
```

Peer dependency ranges:

- `react`, `react-dom` — `^19.2.0` (React 19)
- `onnxruntime-web` — `^1.24.3` (**optional** — see below)

There is **no stylesheet to import** — the component applies everything it needs itself.

> **Versioning:** this package uses CalVer (`YY.M.MICRO`, e.g. `26.8.0`). Version numbers carry no semver meaning, so a `^` range *can* pull in breaking changes. Pin an exact version if that matters to you.

### What about `onnxruntime-web`?

Only the auto-selection mode needs ONNX Runtime, so it is declared as an *optional* peer dependency: consumers who use the editor purely for painting don't get an `npm install` warning and never ship a byte of it.

The AI code is reached exclusively through a dynamic `import()`, so bundlers emit it as a separate chunk that the browser only fetches when a configured editor first warms the model. If you pass the `autoSelect` prop, you must install `onnxruntime-web` — the library will otherwise reject with an install hint the first time a detection is attempted.

## 🖌️ Painting masks

```tsx
import { useRef } from 'react';
import { MaskEditor, type MaskEditorCanvasRef, toMask } from 'react-canvas-ai';

const MyComponent = () => {
  const canvas = useRef<MaskEditorCanvasRef>(null);
  return (
    <>
      <MaskEditor src="https://example.com/photo.jpg" onDrawingChange={() => {}} ref={canvas} />
      <button
        onClick={() => {
          if (canvas.current?.maskCanvas) {
            console.log(toMask(canvas.current.maskCanvas)); // black & white PNG data URL
          }
        }}
      >
        Get Mask
      </button>
    </>
  );
};
```

Drag to paint, `Shift`-drag (or drag with the secondary button) to erase, plain wheel to resize the brush, `Ctrl/Cmd + wheel` to zoom, `Space`-drag to pan, `Ctrl/Cmd + Z` / `Ctrl/Cmd + Y` to undo and redo.

### Pre-loading an existing mask

Resume editing from a previously saved mask by passing it as the `initialMask` prop. It expects exactly what `onMaskChange` produces — white is masked, black is not — and the round trip is lossless:

```tsx
<MaskEditor
  src="https://example.com/photo.jpg"
  onDrawingChange={() => {}}
  initialMask={savedMask}
  onMaskChange={(mask) => localStorage.setItem('myMask', mask)}
/>
```

### Component props

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `src` | `string` | Yes | — | Source URL of the image to edit. |
| `onDrawingChange` | `(isDrawing: boolean) => void` | Yes | — | Called when the user starts or stops drawing. |
| `ref` | `Ref<MaskEditorCanvasRef>` | No | — | The editor's imperative handle — see [Ref API](#ref-api-maskeditorcanvasref). Was `canvasRef` before the React 19 release. |
| `autoSelect` | `AutoSelectOptions` | No | — | Enables the AI auto-selection mode — see [🤖 Auto-selection](#-auto-selection-ai). Absent, the editor is paint-only. |
| `mode` | `'paint' \| 'auto'` | No | `'paint'` | Current interaction mode, quasi-controlled: the prop wins when it changes, `setMode` wins in between. Forced to `'paint'` without `autoSelect`. |
| `onModeChange` | `(mode: MaskEditorMode) => void` | No | — | Called when the mode changes through `setMode` / the ref. |
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
| `initialMask` | `string` | No | — | Pre-load an existing mask as a base64 data URL, to resume from a saved state. |
| `scale` | `number` | No | `1` | Initial zoom scale. |
| `minScale` | `number` | No | `0.8` | Minimum zoom scale. |
| `maxScale` | `number` | No | `4` | Maximum zoom scale. |
| `onScaleChange` | `(scale: number) => void` | No | — | Called when the zoom scale changes. |
| `enableWheelZoom` | `boolean` | No | `true` | Allow `Ctrl`/`Cmd` + wheel to zoom. |
| `onPanChange` | `(x: number, y: number) => void` | No | — | Called when the pan position changes. |
| `constrainPan` | `boolean` | No | `true` | Keep the image within view while panning. |
| `keyboardScope` | `'window' \| 'container'` | No | `window` | Where undo/redo and the pan modifier keys are listened for. Use `container` when more than one editor is on the page. |

`MaskBlendMode` is the union of the CSS `mix-blend-mode` keywords: `normal`, `multiply`, `screen`, `overlay`, `darken`, `lighten`, `color-dodge`, `color-burn`, `hard-light`, `soft-light`, `difference`, `exclusion`, `hue`, `saturation`, `color`, `luminosity`.

### Ref API (`MaskEditorCanvasRef`)

The `MaskEditor` component exposes useful methods via `ref`:

| Name | Type | Description |
| --- | --- | --- |
| `maskCanvas?` | `HTMLCanvasElement` | The mask canvas element, or `undefined` before it has mounted. See the representation note below. |
| `maskColor` | `string` | The colour strokes are currently painted with. |
| `maskOpacity` | `number` | The mask layer's current opacity. |
| `maskBlendMode` | `MaskBlendMode` | The mask layer's current `mix-blend-mode`. |
| `cursorSize` | `number` | The current brush radius, wheel-driven changes included. |
| `mode` | `MaskEditorMode` | The active interaction mode (`'paint'` without `autoSelect`). |
| `autoSelectStatus` | `AutoSelectStatus` | Lifecycle of the AI backend (`'idle'` without `autoSelect`). |
| `undo()` | `() => void` | Undo the last mask change. |
| `redo()` | `() => void` | Redo the last undone mask change. |
| `clear()` | `() => void` | Clear the mask. |
| `resetZoom()` | `() => void` | Reset zoom to initial scale and center the image. |
| `setPan()` | `(x: number, y: number) => void` | Set the pan position manually. |
| `zoomIn()` | `() => void` | Zoom in by one step (0.2 scale increment). |
| `zoomOut()` | `() => void` | Zoom out by one step (0.2 scale decrement). |
| `setMode()` | `(mode: MaskEditorMode) => void` | Switch between `'paint'` and `'auto'`. Warns and no-ops on `'auto'` without `autoSelect`. |
| `selectAt()` | `(point: { x; y }) => Promise<DetectedObject \| undefined>` | Programmatic auto-selection at a canvas-pixel point — see [🤖 Auto-selection](#-auto-selection-ai). |

The style members, `mode` and `autoSelectStatus` are live reads of the editor's current state, so a peer component that draws into `maskCanvas` itself can match hand-painted strokes without being handed the same props a second time.

The mask layer holds `maskColor` at full alpha wherever the image is masked and is **fully transparent everywhere else** — coverage is the state, and no colour is reserved to mean anything. If you draw into `maskCanvas` yourself, add coverage with alpha and remove it with `globalCompositeOperation = 'destination-out'`; painting an opaque "background" colour over a stroke does not unmask it, it just paints over the photo. Auto-selected masks are committed through the exact same representation.

## 🤖 Auto-selection (AI)

Pass the `autoSelect` prop and the editor gains its second interaction mode:

```tsx
import { useRef, useState } from 'react';
import {
  MaskEditor,
  type AutoSelectStatus,
  type MaskEditorCanvasRef,
  type MaskEditorMode,
} from 'react-canvas-ai';

const sam = {
  encoderUrl: '/models/vision_encoder_quantized.onnx',
  decoderUrl: '/models/prompt_encoder_mask_decoder_quantized.onnx',
};

export const Editor = ({ src }: { src: string }) => {
  const canvas = useRef<MaskEditorCanvasRef>(null);
  const [mode, setMode] = useState<MaskEditorMode>('paint');
  const [status, setStatus] = useState<AutoSelectStatus>('idle');

  return (
    <>
      <MaskEditor
        src={src}
        onDrawingChange={() => {}}
        ref={canvas}
        mode={mode}
        onModeChange={setMode}
        autoSelect={{
          sam,
          onStatusChange: setStatus,
          onObjectDetected: (object) => console.log('masked', object.bbox, object.score),
          onError: (error) => console.error(error),
        }}
      />

      <button type="button" onClick={() => setMode(mode === 'paint' ? 'auto' : 'paint')}>
        Switch to {mode === 'paint' ? 'auto-select' : 'paint'} mode
      </button>
      <p>Status: {status}</p>
    </>
  );
};
```

In auto mode:

- **Click** an object and its silhouette is written to the mask in the current `maskColor`.
- **Shift-click** or **right-click** subtracts the detected object from the mask instead — the same modifier that erases in paint mode.
- **Zoom and pan keep working** (`Ctrl/Cmd + wheel`, `Space`-drag, middle button), and clicks land correctly at any zoom level — the editor maps them through its own zoom/pan transform.
- Drags, pans, and clicks made while a detection is already running are ignored; the cursor turns to a crosshair, and to `progress` while detecting.
- The brush is fully suspended: no dabs, no brush outline, no wheel resizing.

Every auto selection is committed through the editor's normal pipeline: it lands in the **undo history** (one `Ctrl/Cmd + Z` removes it), fires **`onMaskChange`**, and is painted in the live `maskColor` at full alpha — pixel-identical to manual paint, so recolouring, exporting and erasing treat it like any stroke.

### `AutoSelectOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `sam` | `SamConfig` | required | Model configuration — see below. |
| `preload` | `boolean` | `false` | Warm the sessions and image embedding as soon as the image decodes, instead of on the first switch to auto mode. |
| `minScore` | `number` | `0` | Detections scoring below this are discarded — the click paints nothing. |
| `preview` | `boolean` | `false` | Show what a click would select while the pointer hovers — see [Hover preview](#hover-preview). |
| `onObjectDetected` | `(object: DetectedObject) => void` | — | Called after a detection has been committed to the mask. |
| `onError` | `(error: Error) => void` | — | Called when the model load or a click-driven detection fails. |
| `onStatusChange` | `(status: AutoSelectStatus) => void` | — | Lifecycle notifications; hook/provider consumers can read `autoSelectStatus` from the return value instead. |

`SamConfig` takes `encoderUrl` and `decoderUrl` (required), plus optional `wasmPaths` (override for `ort.env.wasm.wasmPaths`), `executionProviders` (default `['wasm']`) and `debug` (log tensor names on load).

The backend walks through this lifecycle: `idle` → `loading` (downloading the ONNX files and running the encoder once on the image — the embedding is then cached) → `ready` → `detecting` (per click; hover previews are deliberately excluded) → `ready` (or `error`). The model warms on the first switch to auto mode — or eagerly with `preload` — and **stays warm** when the user toggles back to paint. A new `src` automatically re-encodes; there is nothing to invalidate by hand.

### Hover preview

With `preview: true`, moving the pointer over the image in auto mode runs the same detection and draws the object underneath as an **uncommitted overlay** — a faint fill ringed by a solid outline — so the extent of a selection is visible *before* the click that makes it. Nothing touches the mask until an actual click; moving elsewhere previews a different object.

```tsx
<MaskEditor
  src={src}
  autoSelect={{ sam: samConfig, preview: true }}
  onDrawingChange={setDrawing}
/>
```

Off by default, because every hover that settles costs a decoder pass. Worth knowing:

- **It appears as soon as the pointer reaches something it does not already cover** — the detection starts on that move, not on a timer — then follow-ups are rate-limited to one per 150 ms, with a final run for wherever the pointer comes to rest. A superseded run is aborted before its decoder pass, so a fast sweep costs far less than one detection per object crossed. What is already drawn stays up while the next one is detected, rather than blinking out on every twitch.
- **Every position is detected, including one inside the preview already on screen.** SAM answers a *point*, not an object, so a point inside a silhouette is a different question with a different answer — hovering a person and then the bag they are holding previews each in turn. Objects nested inside a larger selection stay reachable.
- **Clicking what you previewed commits exactly that**, with no second decoder pass — the click is instant, and the model cannot come back with a different answer than the one on screen. Click more than a few pixels away and it detects normally.
- **A preview is invisible to the rest of the API.** It never moves `autoSelectStatus` or `isDetecting`, never shows the busy cursor, never reaches `onObjectDetected` or `onError`, and cannot delay or drop a real click. Read `isPreviewing` from the hook return or the context if you want to reflect it.
- It draws on the cursor layer, which auto mode otherwise leaves idle, so there is no extra canvas to mount — headless consumers get it for free as long as they render `cursorCanvasRef`.

### `selectAt` — programmatic selection

`selectAt(point)` is the programmatic twin of a click in auto mode (available on the ref, the hook return, and the context): it detects the object at a canvas-pixel point, commits it to the mask — undoable, reported through `onMaskChange` — and resolves with the `DetectedObject` (`id`, `score`, `bbox`, and the alpha-silhouette `mask: ImageData`), or `undefined` when nothing scored above `minScore`:

```ts
const detected = await canvas.current?.selectAt({ x: 320, y: 180 });
```

It works in either mode and rejects when `autoSelect` is not configured or the image has not loaded. Unlike a click, failures are the caller's to handle — they are not routed to `autoSelect.onError`.

### Where do the model files come from?

The bundled SAM backend takes two strings, `sam.encoderUrl` and `sam.decoderUrl`. They are passed verbatim to `fetch()`, so anything `fetch` accepts works — an absolute URL, a same-origin path, even a `blob:` URL. After the first successful load, both files are stored in `caches.open('react-canvas-ai-sam-v1')` and served from there on every subsequent page load with zero network, until you call `clearSamCache()` or the browser evicts.

You have three reasonable choices for **where** those files live:

#### 1. Hugging Face CDN (prototyping only)

The original [Xenova/slimsam-77-uniform](https://huggingface.co/Xenova/slimsam-77-uniform) export is hosted on the Hugging Face CDN. You can point the library directly at it while you evaluate:

```ts
const sam = {
  encoderUrl: 'https://huggingface.co/Xenova/slimsam-77-uniform/resolve/main/onnx/vision_encoder_quantized.onnx',
  decoderUrl: 'https://huggingface.co/Xenova/slimsam-77-uniform/resolve/main/onnx/prompt_encoder_mask_decoder_quantized.onnx',
};
```

The [`playground/`](playground/) app in this repo uses exactly this approach, parameterised via the `VITE_SAM_ENCODER_URL` / `VITE_SAM_DECODER_URL` env vars (see [`playground/.env.example`](playground/.env.example)).

It works, but it is **not recommended for production**: Hugging Face rate-limits its CDN, you don't control the caching headers, and your app's availability ends up depending on a third party.

#### 2. Self-host on your own CDN (recommended for production)

Mirror both `.onnx` files to your own origin (S3, R2, Cloudfront, your own server, whatever you use), serve them with a strong immutable cache header, and pass those URLs:

```ts
const sam = {
  encoderUrl: 'https://cdn.example.com/sam/vision_encoder_quantized.onnx',
  decoderUrl: 'https://cdn.example.com/sam/prompt_encoder_mask_decoder_quantized.onnx',
};
```

Recommended response header for the `.onnx` files:

```
Cache-Control: public, max-age=31536000, immutable
```

#### 3. Bundle the files locally with your app

Drop the two `.onnx` files into your project's static-assets folder — `public/models/` for Vite or Next.js — and point at the same-origin path:

```ts
const sam = {
  encoderUrl: '/models/vision_encoder_quantized.onnx',
  decoderUrl: '/models/prompt_encoder_mask_decoder_quantized.onnx',
};
```

The two file names are `vision_encoder_quantized.onnx` (~8.9 MB) and `prompt_encoder_mask_decoder_quantized.onnx` (~4.9 MB) — a one-time ~14 MB download regardless of which option you pick. During development you can call `clearSamCache()` (exported from the package) to wipe the persistent cache and force a re-download.

> **A note on the WASM runtime.** Separately from the `.onnx` model files, `onnxruntime-web` also needs its own WebAssembly engine (`ort-wasm-simd-threaded.wasm` and a couple of `.mjs` glue files) to actually execute the model. By default, it loads them from `cdn.jsdelivr.net`, which works well: JSDelivr is fast, the files are immutably cached by the browser, and you don't need any extra setup. If you'd rather control the delivery yourself — for stricter privacy, CSP, or to keep your app independent of a third-party CDN — you can self-host these files the same way you'd self-host the model files (copy them out of `node_modules/onnxruntime-web/dist/` into your static-assets folder) and point ORT at them by passing `wasmPaths: '/your-prefix/'` in the `sam` config.

## 🧪 Advanced usage

### Using the `useMaskEditor` hook

You can manage the full mask editing flow yourself. The hook accepts every prop the component does (`autoSelect`, `mode` and `onModeChange` included) and returns the complete editor state — the auto-selection members `mode`, `setMode`, `autoSelectStatus`, `isDetecting` and `selectAt` among them:

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
    mode,
    setMode,
    isDetecting,
    isPreviewing,
  } = useMaskEditor({
    src: 'https://example.com/photo.jpg',
    maskColor: '#00ff00',
    maxWidth: 1024,
    maxHeight: 1024,
    onDrawingChange: (drawing) => console.log(drawing),
    autoSelect: { sam: { encoderUrl: '/models/encoder.onnx', decoderUrl: '/models/decoder.onnx' } },
    scale: 1,
    minScale: 0.5,
    maxScale: 5,
    enableWheelZoom: true,
    constrainPan: true,
    keyboardScope: 'window',
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

  // In a headless layout you own the cursor: read `mode`/`isDetecting` and pick one.
  const cursor = isPanning ? 'grabbing' : mode === 'auto' ? (isDetecting ? 'progress' : 'crosshair') : 'default';

  return (
    <div className="my-editor" style={{ width: '100%', height: '100%' }}>
      <div className="controls">
        <button onClick={undo}>Undo</button>
        <button onClick={redo}>Redo</button>
        <button onClick={clear}>Clear</button>
        <button onClick={resetZoom}>Reset Zoom</button>
        <button onClick={() => setMode(mode === 'paint' ? 'auto' : 'paint')}>Toggle auto-select</button>
      </div>
      <div
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
        <div className="all-canvases" style={transformStyle}>
          <canvas key={key} ref={canvasRef} width={size.x} height={size.y} />
          <canvas
            ref={maskCanvasRef}
            width={size.x}
            height={size.y}
            style={{ opacity: maskOpacity, mixBlendMode: maskBlendMode, pointerEvents: 'none' }}
          />
          <canvas
            ref={cursorCanvasRef}
            width={size.x}
            height={size.y}
            onMouseUp={handleMouseUp}
            onMouseDown={handleMouseDown}
            style={{ cursor }}
          />
        </div>
      </div>
    </div>
  );
};
```

(Prefer `MaskEditorLayers` over hand-rolling the three canvases — it carries the stacking, z-order, pointer-events and blend-mode contract for you, and its `cursor` prop takes the value computed above. `maskEditorLayerStyles(...)` is exported for layouts that must place the canvases themselves.)

### Using `MaskEditorProvider` context

Ideal if you want to split canvas and controls across components. The context value is the full `useMaskEditor` return, auto-selection state included:

```tsx
import { MaskEditorLayers, MaskEditorProvider, useMaskEditorContext } from 'react-canvas-ai';

const MaskEditorCanvas = () => {
  const { containerProps, size, mode, isDetecting } = useMaskEditorContext();

  return (
    // Spread containerProps: it carries the ref, focus handling and the Space
    // interception that keyboard shortcuts and panning depend on.
    <div {...containerProps} style={{ position: 'relative', width: size.x, height: size.y }}>
      <MaskEditorLayers cursor={mode === 'auto' ? (isDetecting ? 'progress' : 'crosshair') : undefined} />
    </div>
  );
};

const MaskEditorControls = () => {
  const { undo, redo, clear, zoomIn, zoomOut, mode, setMode, autoSelectStatus } = useMaskEditorContext();

  return (
    <div className="controls">
      <button onClick={undo}>Undo</button>
      <button onClick={redo}>Redo</button>
      <button onClick={clear}>Clear</button>
      <button onClick={zoomIn}>Zoom In</button>
      <button onClick={zoomOut}>Zoom Out</button>
      <button onClick={() => setMode(mode === 'paint' ? 'auto' : 'paint')}>
        Mode: {mode} ({autoSelectStatus})
      </button>
    </div>
  );
};

const App = () => (
  <MaskEditorProvider
    src="https://example.com/photo.jpg"
    onDrawingChange={() => {}}
    autoSelect={{ sam: { encoderUrl: '/models/encoder.onnx', decoderUrl: '/models/decoder.onnx' } }}
  >
    <MaskEditorCanvas />
    <MaskEditorControls />
  </MaskEditorProvider>
);
```

## 🔍 Zoom and pan

The editor includes zoom and pan capabilities for precise mask editing, in both modes:

- **Zoom**: `Ctrl/Cmd + Mouse Wheel`, centered on the cursor
- **Pan**: hold `Space` and drag, or use the middle mouse button
- **Erase**: hold `Shift` and drag, or drag with the secondary mouse button (in auto mode: shift-click / right-click subtracts the detected object)
- **Resize brush**: plain `Mouse Wheel` (paint mode only)
- **Undo / Redo**: `Ctrl/Cmd + Z` and `Ctrl/Cmd + Y` (or `Ctrl/Cmd + Shift + Z`)

Programmatic control is available everywhere the editor state is: `zoomIn()`, `zoomOut()`, `resetZoom()` (also recenters), `setPan(x, y)` and `setScale(n)` on the ref, the hook return, and the context.

### Keyboard scope

By default the editor listens for shortcuts on `window`, so `Ctrl/Cmd + Z` works from anywhere on the page. That is the right behaviour for a single editor, but it means **two editors on the same page both respond to one keystroke**.

Set `keyboardScope="container"` to make an editor respond only while focus is inside it:

```jsx
<MaskEditor src={src} onDrawingChange={setDrawing} keyboardScope='container' />
```

In this mode the editor takes focus when you click it, and shows a focus ring you can restyle through the `.react-mask-editor-inner` class. Keystrokes typed into an `<input>`, `<textarea>` or `contenteditable` element are ignored in both modes.

Key *releases* are never scoped — a `Space` release is honoured even if focus has since moved, so panning cannot get stuck on.

## 🎨 Styling

The component ships **no CSS file** and requires no import. Structural styles (canvas stacking, sizing, compositor hints) are applied inline so the library works in any bundler and any SSR setup out of the box.

Two ways to customise it:

```tsx
<MaskEditor src={src} onDrawingChange={setDrawing} className='my-editor' style={{ maxHeight: 600 }} />
```

Or target the stable class names, which are kept purely as styling hooks:

`react-mask-editor-outer` · `react-mask-editor-inner` · `canvas-container` · `all-canvases` · `react-mask-editor-base-canvas` · `react-mask-editor-mask-canvas` · `react-mask-editor-cursor-canvas`

Because the built-in rules are inline, a plain class selector will not beat them — use the `style` prop (it is merged last and wins) or `!important` in your own stylesheet.

## 💣 Troubleshooting

### WebGPU produces noisy or tiled masks (`iou_scores > 1.0`)

The bundled backend defaults to the `wasm` execution provider for a reason. `onnxruntime-web@1.24` cannot assign every operator in the INT8-quantised SlimSAM-77 export to its WebGPU EP, and the operators that fall back to CPU end up round-tripping quantised activations across the EP boundary. The result is silently corrupted mask logits — telltale signs are a noisy, tiled-looking mask and `iou_scores` greater than `1.0`.

Keep the default `executionProviders: ['wasm']` unless you are shipping a different SAM export (e.g. a non-quantised or FP16 one) that you have re-verified end-to-end on WebGPU.

### The model won't load / I changed the model files but the old ones are used

Model files are cached in the browser's Cache Storage under the bucket `react-canvas-ai-sam-v1`, keyed by URL. If you replace the files behind the *same* URL, call the exported `clearSamCache()` (or bump the URL) to force a re-download. A genuine fetch failure (404, CORS) is reported through `autoSelect.onError` with the status code and URL.

### `setMode('auto')` does nothing

Auto mode only exists when the `autoSelect` prop is configured — without it the editor is paint-only, `mode` is forced to `'paint'`, and `setMode('auto')` warns on the console and is ignored.

## 🛠️ Development

```bash
pnpm install
pnpm dev:playground   # library in watch mode + playground on :3000
pnpm check            # what CI runs: biome + typecheck + tests
pnpm build            # ESM + CJS + .d.ts (+ the lazy SAM chunk)
```

Releases are cut by pushing a CalVer tag:

```bash
git tag 26.8.0
git push origin 26.8.0
```

The release workflow stamps that tag onto `packages/react-canvas-ai/package.json` (via `scripts/set-version.mjs`) and publishes to npm. The version in the manifest on `main` is only a placeholder between releases — the tag is the source of truth.

### Why the build is set up this way

Worth recording, because it is a decision to revisit rather than rediscover.

TypeScript 7.0 is a ground-up rewrite in Go, and it does **not** yet expose the JavaScript compiler API (`import * as ts from 'typescript'`) or emit declarations. That breaks every tool that generates `.d.ts` through the compiler — `vite-plugin-dts`, `tsup --dts`, api-extractor. It is not a Vite limitation: ordinary Vite apps run fine on TS 7, and the playground here does.

So this package sets `isolatedDeclarations: true` and lets **tsdown** generate declarations with oxc (Rust), which never loads the TypeScript compiler. The cost is explicit type annotations on exported symbols.

**What changes in TS 7.1:** a new compiler API is being built for 7.1, with declaration emit on the list. Once it ships, `vite-plugin-dts` and friends can support TS 7 and this constraint disappears.

**The decision to make then:** keep `isolatedDeclarations` (faster, parallel, Rust-speed `.d.ts`, but the annotations must be maintained) or drop it and let the compiler infer declarations (no annotations, slower builds). Note that `isolatedDeclarations` shipped in TS 5.5, well before the Go rewrite — it is a deliberate design direction, not a TS 7 workaround — so **both options stay valid long term**, and the annotations are not wasted either way, since explicit public return types are good API hygiene regardless.

Sources worth re-checking when the time comes:
[TypeScript 7 progress](https://devblogs.microsoft.com/typescript/progress-on-typescript-7-december-2025/) ·
[tsdown dts options](https://tsdown.dev/options/dts)

## 📜 Notes

- All mask operations are done on a separate canvas for performance
- The mask is returned as a **black-and-white PNG (base64)** — white where masked, black where not. A pixel counts as masked when the mask layer is at least half covered there, so anti-aliased stroke edges resolve on export the same way they look on screen
- Undo history is byte-budgeted (64 MB by default), so a large canvas keeps fewer states and a small one keeps more
- SAM inference runs on the main thread through ONNX Runtime's own WASM workers; a click typically resolves in well under a second on a warm model
- Forked and modernized from [`react-mask-editor`](https://www.npmjs.com/package/react-mask-editor), with the auto-selection features folded in from [`react-canvas-masker-auto-selection`](https://github.com/vegidio/react-canvas-masker-auto-selection)

## 📝 License

**react-canvas-ai** is released under the Apache 2.0 License. See [LICENSE](LICENSE) for details.

## 👨🏾‍💻 Author

Vinicius Egidio ([vinicius.io](https://vinicius.io))
