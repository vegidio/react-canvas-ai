import { useMemo, useRef, useState } from 'react';
import type { AutoSelectStatus, MaskEditorCanvasRef, MaskEditorMode, SamConfig } from 'react-canvas-ai';
import { MaskEditor, toMask } from 'react-canvas-ai';

const SAMPLE_IMAGE = 'https://images.unsplash.com/photo-1724745523440-e9a3982d8994?auto=format&fit=crop&w=900&q=80';

const DEFAULT_ENCODER_URL =
    'https://huggingface.co/Xenova/slimsam-77-uniform/resolve/main/onnx/vision_encoder_quantized.onnx';
const DEFAULT_DECODER_URL =
    'https://huggingface.co/Xenova/slimsam-77-uniform/resolve/main/onnx/prompt_encoder_mask_decoder_quantized.onnx';

const App = () => {
    const canvas = useRef<MaskEditorCanvasRef>(null);
    const [mode, setMode] = useState<MaskEditorMode>('paint');
    const [status, setStatus] = useState<AutoSelectStatus>('idle');
    // Held here rather than inside the auto-mode branch below, so switching to paint and back
    // does not silently reset a choice the user made.
    const [preview, setPreview] = useState(true);

    /**
     * How long the last detection took. Times a *click*, not a hover: previews are deliberately
     * excluded from `onStatusChange`, but they pay the same decoder pass on the same serial
     * queue — which is what the hover latency is made of now that the trigger is immediate.
     */
    const detectStartedAt = useRef<number | undefined>(undefined);
    const [detectMs, setDetectMs] = useState<number>();

    const handleStatusChange = (next: AutoSelectStatus) => {
        setStatus(next);

        if (next === 'detecting') {
            detectStartedAt.current = performance.now();
        } else if (detectStartedAt.current !== undefined) {
            setDetectMs(Math.round(performance.now() - detectStartedAt.current));
            detectStartedAt.current = undefined;
        }
    };
    const [errorMessage, setErrorMessage] = useState<string>();
    const [mask, setMask] = useState('');
    const [cursorSize, setCursorSize] = useState(20);
    const [color, setColor] = useState('#ffffff');
    const [scale, setScale] = useState(1);
    const [pan, setPan] = useState({ x: 0, y: 0 });
    const [drawing, setDrawing] = useState(false);

    const samConfig = useMemo<SamConfig>(
        () => ({
            encoderUrl: import.meta.env.VITE_SAM_ENCODER_URL ?? DEFAULT_ENCODER_URL,
            decoderUrl: import.meta.env.VITE_SAM_DECODER_URL ?? DEFAULT_DECODER_URL,
        }),
        [],
    );

    /**
     * Re-derives the mask from the canvas rather than reusing the `mask` state: the state is
     * only populated because `onMaskChange` happens to be wired up, and the download should
     * stand on its own if that prop ever goes away.
     */
    const downloadMask = () => {
        const maskCanvas = canvas.current?.maskCanvas;
        if (!maskCanvas) return;

        const dataUrl = toMask(maskCanvas);

        const link = document.createElement('a');
        link.href = dataUrl;
        link.download = 'mask.png';
        link.click();
    };

    const statusLine = (() => {
        switch (status) {
            case 'error':
                return `Error: ${errorMessage ?? 'something went wrong'}`;
            case 'loading':
                return 'Loading SAM model (~14 MB first time, then cached)…';
            case 'detecting':
                return 'Detecting object…';
            default:
                if (mode !== 'auto') {
                    return 'Paint mode: drag to paint, shift-drag or right-drag to erase, ctrl+wheel to zoom, space-drag to pan.';
                }

                return preview
                    ? 'Auto-select mode: hover an object to preview what a click would select, click to mask it, shift-click to remove one.'
                    : 'Auto-select mode: click an object to mask it, shift-click to remove one.';
        }
    })();

    return (
        <main className='playground'>
            <header>
                <h1>react-canvas-ai · playground</h1>
                <p>
                    Freehand mask painting plus an <strong>auto-select</strong> mode where clicks are sent to SlimSAM-77
                    running locally in the browser via <code>onnxruntime-web</code>. Switching to auto mode the first
                    time downloads ~14 MB of quantized ONNX weights and caches them; subsequent loads are instant.
                </p>
            </header>

            <section className='editor'>
                <div className='editor-frame'>
                    <MaskEditor
                        src={SAMPLE_IMAGE}
                        ref={canvas}
                        mode={mode}
                        onModeChange={setMode}
                        autoSelect={{
                            sam: samConfig,
                            preview,
                            onStatusChange: handleStatusChange,
                            onError: (error) => setErrorMessage(error.message),
                        }}
                        maskColor={color}
                        maskOpacity={0.5}
                        cursorSize={cursorSize}
                        onCursorSizeChange={setCursorSize}
                        onDrawingChange={setDrawing}
                        onMaskChange={setMask}
                        scale={scale}
                        maxScale={4}
                        onScaleChange={setScale}
                        enableWheelZoom
                        constrainPan
                        onPanChange={(x, y) => setPan({ x, y })}
                        maxWidth={900}
                        maxHeight={600}
                    />
                </div>
            </section>

            <section className='controls'>
                <button type='button' onClick={() => setMode(mode === 'paint' ? 'auto' : 'paint')}>
                    Switch to {mode === 'paint' ? 'auto-select' : 'paint'} mode
                </button>
                <span className='mode-indicator' data-mode={mode}>
                    Current mode: <strong>{mode}</strong>
                </span>
                <span className='status-indicator' data-status={status}>
                    Status: <strong>{status}</strong>
                </span>
                {detectMs !== undefined && (
                    <span className='status-indicator'>
                        Last detection: <strong>{detectMs} ms</strong>
                    </span>
                )}
                {mode === 'auto' && (
                    <label className='preview-toggle'>
                        <input type='checkbox' checked={preview} onChange={(e) => setPreview(e.target.checked)} />
                        Preview mode
                    </label>
                )}
                <p className='status' role='status'>
                    {statusLine}
                </p>
            </section>

            <section className='controls toolbar'>
                <label>
                    Mask color
                    <input type='color' value={color} onChange={(e) => setColor(e.target.value)} />
                </label>
                <label>
                    Brush size
                    <input
                        type='range'
                        min={1}
                        max={100}
                        value={cursorSize}
                        onChange={(e) => setCursorSize(Number(e.target.value))}
                    />
                    <span className='value'>{cursorSize}px</span>
                </label>
                <label>
                    Zoom
                    {/*
                     * Plain controlled state: the `scale` prop drives the editor, and the editor
                     * echoes its own movement back through `onScaleChange`, which is what keeps
                     * this slider in step with wheel-zoom and Reset zoom too.
                     */}
                    <input
                        type='range'
                        min={0.8}
                        max={4}
                        step={0.1}
                        value={scale}
                        onChange={(e) => setScale(Number(e.target.value))}
                    />
                    <span className='value'>{Math.round(scale * 100)}%</span>
                </label>
                <span className='value'>
                    Pan: {Math.round(pan.x)}, {Math.round(pan.y)}
                </span>
                <span className='value'>{drawing ? 'Drawing…' : 'Idle'}</span>
            </section>

            <section className='controls actions'>
                <button type='button' onClick={() => canvas.current?.undo()}>
                    Undo
                </button>
                <button type='button' onClick={() => canvas.current?.redo()}>
                    Redo
                </button>
                <button type='button' onClick={() => canvas.current?.clear()}>
                    Clear
                </button>
                {/* resetZoom rather than setScale(1): it also recentres the view. */}
                <button type='button' onClick={() => canvas.current?.resetZoom()}>
                    Reset zoom
                </button>
                <button type='button' onClick={() => canvas.current?.setPan(0, 0)}>
                    Center view
                </button>
                <button type='button' onClick={downloadMask}>
                    Download mask
                </button>
            </section>

            {mask && <img src={mask} className='mask-preview' alt='Live mask preview' />}
        </main>
    );
};

export default App;
