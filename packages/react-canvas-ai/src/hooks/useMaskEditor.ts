import type {
    Dispatch,
    KeyboardEvent as ReactKeyboardEvent,
    MouseEvent as ReactMouseEvent,
    RefObject,
    SetStateAction,
} from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Point, Transform } from '../internal/geometry';
import type { KeyboardScope } from '../internal/keyboard';

export { MaskEditorDefaults } from '../internal/defaults';

import { paintMaskDot, recolorMask } from '../internal/canvas';
import { MaskEditorDefaults } from '../internal/defaults';
import { isFormField, isKeyboardInScope } from '../internal/keyboard';
import { loadImage } from '../internal/loadImage';
import { useBrushCursor, useBrushSizeWheel, useCursorPainter } from '../internal/useBrush';
import { useCanvas2dContext } from '../internal/useCanvas2dContext';
import { useEventCallback, useLatest } from '../internal/useLatest';
import { hexToRgb, toMask } from '../utils';
import { useHistory } from './useHistory';
import { useImageLoader } from './useImageLoader';
import { useZoomPan } from './useZoomPan';

/** The CSS `mix-blend-mode` values the mask layer supports. */
export type MaskBlendMode =
    | 'normal'
    | 'multiply'
    | 'screen'
    | 'overlay'
    | 'darken'
    | 'lighten'
    | 'color-dodge'
    | 'color-burn'
    | 'hard-light'
    | 'soft-light'
    | 'difference'
    | 'exclusion'
    | 'hue'
    | 'saturation'
    | 'color'
    | 'luminosity';

export type UseMaskEditorProps = {
    src: string;
    /**
     * Cross-origin attribute for the image.
     * Useful if the image is hosted on a different domain and requires CORS.
     */
    crossOrigin?: string;
    /**
     * Maximum width for loaded images (default: 1240)
     */
    maxWidth?: number;
    /**
     * Maximum height for loaded images (default: 1240)
     */
    maxHeight?: number;
    cursorSize?: number;
    onCursorSizeChange?: (size: number) => void;
    maskOpacity?: number;
    maskColor?: string;
    maskBlendMode?: MaskBlendMode;
    onDrawingChange: (isDrawing: boolean) => void;
    onUndoRequest?: () => void;
    onRedoRequest?: () => void;
    /**
     * Called with the current mask (as a dataURL) when the mask changes.
     * Debounced while drawing, called immediately on mouse up.
     */
    onMaskChange?: (mask: string) => void;
    /**
     * Pre-load an existing mask as base64 data URL.
     * Useful for continuing editing from a previously saved state.
     */
    initialMask?: string;
    /**
     * Current zoom scale (default: 1)
     */
    scale?: number;
    /**
     * Minimum allowed zoom scale (default: 0.8)
     */
    minScale?: number;
    /**
     * Maximum allowed zoom scale (default: 4)
     */
    maxScale?: number;
    /**
     * Callback when zoom scale changes
     */
    onScaleChange?: (scale: number) => void;
    /**
     * Enable/disable zoom with mouse wheel (default: true)
     */
    enableWheelZoom?: boolean;
    /**
     * Callback when pan position changes (dx, dy)
     */
    onPanChange?: (x: number, y: number) => void;

    /**
     * Enable/disable pan constraints to keep image in view (default: true)
     */
    constrainPan?: boolean;

    /**
     * Where undo/redo and the pan modifier keys are listened for (default: `'window'`).
     *
     * `'window'` responds to shortcuts from anywhere on the page. `'container'` responds
     * only while focus is inside this editor, which is what you want when more than one
     * editor is mounted — otherwise a single Ctrl+Z undoes in all of them.
     */
    keyboardScope?: KeyboardScope;
};

export type { KeyboardScope };

/**
 * Props for the element that owns the editor's keyboard and focus behaviour. Spread these
 * onto the scrolling container that wraps the canvas stack.
 *
 * Returned from the hook rather than baked into `MaskEditor`, so a headless consumer
 * building its own layout gets the same behaviour — `keyboardScope: 'container'` used to
 * work only for the component, because the focus handling lived in its JSX.
 */
export type MaskEditorContainerProps = {
    ref: RefObject<HTMLDivElement | null>;
    role: 'application';
    tabIndex: 0;
    onKeyDown: (e: ReactKeyboardEvent) => void;
    onMouseDown: () => void;
};

export type UseMaskEditorReturn = {
    canvasRef: RefObject<HTMLCanvasElement | null>;
    /** Spread onto the element wrapping the canvas stack. See {@link MaskEditorContainerProps}. */
    containerProps: MaskEditorContainerProps;
    clear: () => void;
    cursorCanvasRef: RefObject<HTMLCanvasElement | null>;
    cursorSize: number;
    handleMouseDown: (e: ReactMouseEvent<HTMLCanvasElement>) => void;
    handleMouseUp: (e: ReactMouseEvent<HTMLCanvasElement>) => void;
    /**
     * How many undo states are retained.
     *
     * A count rather than the entries themselves: each is a full uncompressed RGBA buffer,
     * and handing the array out kept the whole stack alive for as long as a consumer held
     * the hook's return value.
     */
    historyLength: number;
    historyIndex: number;
    isDrawing: boolean;
    key: number;
    maskBlendMode: MaskBlendMode;
    maskCanvasRef: RefObject<HTMLCanvasElement | null>;
    maskColor: string;
    maskOpacity: number;
    redo: () => void;
    setCursorSize: Dispatch<SetStateAction<number>>;
    size: Point;
    undo: () => void;
    scale: number;
    /** Sets the zoom, clamped to `[minScale, maxScale]`, moving the transform with it. */
    setScale: (scale: number) => void;
    transform: Transform;
    containerRef: RefObject<HTMLDivElement | null>;
    resetZoom: () => void;
    isPanning: boolean;
    isZoomKeyDown: boolean;
    setPan: (x: number, y: number) => void;
    effectiveScale: number; // Combined (baseScale * userScale)
    zoomIn: () => void;
    zoomOut: () => void;
};

/**
 * The imperative surface exposed through `MaskEditor`'s `canvasRef`.
 *
 * Derived from the hook's return rather than restated, so adding a method is one edit
 * instead of three that have to agree.
 */
export type MaskEditorCanvasRef = Pick<
    UseMaskEditorReturn,
    'undo' | 'redo' | 'clear' | 'resetZoom' | 'setPan' | 'zoomIn' | 'zoomOut'
> & {
    maskCanvas?: HTMLCanvasElement;
};

/** Painting with the secondary button or shift held erases back to the mask background. */
const ERASE_COLOR = '#ffffff';

/** How long the mask report waits for the stroke to settle. */
const MASK_DEBOUNCE_MS = 300;

export const useMaskEditor = (props: UseMaskEditorProps): UseMaskEditorReturn => {
    const {
        src,
        crossOrigin,
        maxWidth = MaskEditorDefaults.maxWidth,
        maxHeight = MaskEditorDefaults.maxHeight,
        cursorSize: initialCursorSize = MaskEditorDefaults.cursorSize,
        maskColor = MaskEditorDefaults.maskColor,
        maskBlendMode = MaskEditorDefaults.maskBlendMode,
        maskOpacity = MaskEditorDefaults.maskOpacity,
        onCursorSizeChange,
        onDrawingChange,
        onUndoRequest,
        onRedoRequest,
        onMaskChange,
        initialMask,
        scale: initialScale = MaskEditorDefaults.scale,
        minScale = MaskEditorDefaults.minScale,
        maxScale = MaskEditorDefaults.maxScale,
        onScaleChange,
        enableWheelZoom = MaskEditorDefaults.enableWheelZoom,
        onPanChange,
        constrainPan = MaskEditorDefaults.constrainPan,
        keyboardScope = MaskEditorDefaults.keyboardScope,
    } = props;

    const canvasRef = useRef<HTMLCanvasElement>(null);
    const maskCanvasRef = useRef<HTMLCanvasElement>(null);
    const cursorCanvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const initialMaskAppliedRef = useRef<string | undefined>(undefined);

    // Only the mask layer is ever read back (history snapshots, recolouring, `toMask`), so it
    // is the only one that wants `willReadFrequently`. The cursor layer is repainted on every
    // pointer move and must stay on the GPU path.
    const maskContext = useCanvas2dContext(maskCanvasRef, { willReadFrequently: true });
    const cursorContext = useCanvas2dContext(cursorCanvasRef);

    const [isDrawing, setIsDrawing] = useState(false);
    const [currentCursorSize, setCursorSize] = useState(initialCursorSize);

    const { image, size, key } = useImageLoader(src, maxWidth, maxHeight, crossOrigin);

    const [zoomPanState, zoomPanActions] = useZoomPan(containerRef, size, {
        initialScale,
        minScale,
        maxScale,
        enableWheelZoom,
        constrainPan,
        keyboardScope,
        onScaleChange,
        onPanChange,
    });

    const historyManager = useHistory(maskContext, size, { onUndoRequest, onRedoRequest });

    // Latest-value mirrors, for the handlers that must not be re-attached on every render.
    // The brush hooks below do their own mirroring; these are the ones this hook reads
    // directly.
    const isPanningRef = useLatest(zoomPanState.isPanning);
    const isSpaceKeyDownRef = useLatest(zoomPanState.isSpaceKeyDown);
    const getImageCoordinatesRef = useLatest(zoomPanActions.getImageCoordinates);
    const historyRef = useLatest(historyManager);
    const cursorSizeRef = useLatest(currentCursorSize);
    const maskColorRef = useLatest(maskColor);
    const onMaskChangeRef = useLatest(onMaskChange);
    const keyboardScopeRef = useLatest(keyboardScope);

    const notifyCursorSizeChange = useEventCallback<[number]>(onCursorSizeChange);
    const notifyDrawingChange = useEventCallback<[boolean]>(onDrawingChange);

    /** Reports the current mask, skipping the pixel work when nobody is listening. */
    const reportMask = useCallback(() => {
        const canvas = maskCanvasRef.current;
        if (!canvas || !onMaskChangeRef.current) return;

        try {
            onMaskChangeRef.current(toMask(canvas));
        } catch (error) {
            console.error('[MaskEditor] onMaskChange callback threw:', error);
        }
    }, []);

    /**
     * Sizes the three layers and paints the image.
     *
     * A layout effect rather than a timer: the base canvas carries `key`, so it is a brand
     * new element by the time a deferred draw would have run. React attaches refs before
     * layout effects, so this always sees the element that is actually mounted.
     */
    useLayoutEffect(() => {
        if (size.x === 0 || size.y === 0) return;

        for (const ref of [canvasRef, maskCanvasRef, cursorCanvasRef]) {
            const canvas = ref.current;
            if (!canvas) continue;
            canvas.width = size.x;
            canvas.height = size.y;
        }

        const canvas = canvasRef.current;
        if (!image || !canvas) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        ctx.clearRect(0, 0, size.x, size.y);
        ctx.drawImage(image, 0, 0, size.x, size.y);
    }, [image, size]);

    // Load an existing mask, once per distinct value. This goes through `loadImage` rather
    // than a second hand-rolled `new Image()`: it already owns handler detaching and the
    // guarantee that a superseded load cannot win a race against the one that replaced it.
    useEffect(() => {
        if (!initialMask || !maskContext || size.x === 0 || size.y === 0) return;
        if (initialMaskAppliedRef.current === initialMask) return;

        const controller = new AbortController();

        loadImage(initialMask, { signal: controller.signal })
            .then((img) => {
                if (controller.signal.aborted || !maskCanvasRef.current) return;

                maskContext.clearRect(0, 0, size.x, size.y);
                maskContext.fillStyle = ERASE_COLOR;
                maskContext.fillRect(0, 0, size.x, size.y);
                maskContext.drawImage(img, 0, 0, size.x, size.y);

                // Seed history so undo/redo works from this base state.
                historyRef.current.saveToHistory();
                reportMask();

                initialMaskAppliedRef.current = initialMask;
            })
            .catch((error: unknown) => {
                if (controller.signal.aborted) return;
                console.error('[MaskEditor] Failed to apply initial mask:', error);
            });

        return () => controller.abort();
    }, [initialMask, maskContext, size, reportMask]);

    useEffect(() => {
        setCursorSize(initialCursorSize);
    }, [initialCursorSize]);

    // Recolour existing strokes when the mask colour changes. Guarded on the colour actually
    // changing: `recolorMask` walks every pixel, and without this it also ran once at mount
    // against a blank canvas for no visual effect.
    const appliedMaskColorRef = useRef<string | undefined>(undefined);
    useEffect(() => {
        if (!maskContext || size.x === 0 || size.y === 0) return;
        if (appliedMaskColorRef.current === maskColor) return;

        appliedMaskColorRef.current = maskColor;
        recolorMask(maskContext, size, hexToRgb(maskColor));
    }, [maskContext, maskColor, size]);

    /**
     * Stamps one brush dab for a pointer event. Both the freehand move handler and mousedown
     * paint identically — the secondary button or shift erases back to the mask background —
     * so the decision lives here rather than being repeated at each call site.
     */
    const paintDab = useCallback(
        (x: number, y: number, evt: Pick<MouseEvent, 'buttons' | 'shiftKey'>) => {
            if (!maskContext) return;
            const color = evt.buttons > 1 || evt.shiftKey ? ERASE_COLOR : maskColorRef.current;
            paintMaskDot(maskContext, x, y, cursorSizeRef.current, color);
        },
        [maskContext],
    );
    const paintCursor = useCursorPainter(cursorContext, { size, maskColor, maskOpacity });

    useBrushCursor(cursorCanvasRef, {
        paintCursor,
        getImageCoordinates: zoomPanActions.getImageCoordinates,
        cursorSizeRef,
        isPanning: zoomPanState.isPanning,
        isSpaceKeyDown: zoomPanState.isSpaceKeyDown,
        paintDab,
    });

    useBrushSizeWheel(cursorCanvasRef, {
        enabled: Boolean(onCursorSizeChange),
        paintCursor,
        getImageCoordinates: zoomPanActions.getImageCoordinates,
        cursorSizeRef,
        setCursorSize,
        onCursorSizeChange: notifyCursorSizeChange,
    });

    const handleMouseDown = useCallback(
        (e: ReactMouseEvent<HTMLCanvasElement>) => {
            e.preventDefault();
            if (isPanningRef.current || isSpaceKeyDownRef.current) return;

            const { x, y } = getImageCoordinatesRef.current(e.nativeEvent.clientX, e.nativeEvent.clientY);
            paintDab(x, y, e.nativeEvent);

            setIsDrawing(true);
        },
        [paintDab],
    );

    const handleMouseUp = useCallback(
        (e: ReactMouseEvent<HTMLCanvasElement>) => {
            e.preventDefault();
            // Read through refs: this used to close over a stale `isPanning`, so ending a
            // space-drag pan also ended the stroke and pushed a history entry.
            if (isPanningRef.current || isSpaceKeyDownRef.current) return;

            setIsDrawing(false);
            historyRef.current.saveToHistory();
            reportMask();
        },
        [reportMask],
    );

    useEffect(() => {
        notifyDrawingChange(isDrawing);
    }, [isDrawing, notifyDrawingChange]);

    // Report a mid-stroke mask so long strokes are not silent for their whole duration.
    // A plain timer, not a debounce: this fires once when the stroke starts and is cleared
    // when it ends, so there is no call sequence to coalesce.
    useEffect(() => {
        if (!isDrawing) return;
        const timer = setTimeout(reportMask, MASK_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [isDrawing, reportMask]);

    const undo = useCallback(() => {
        historyRef.current.undo();
        reportMask();
    }, [reportMask]);

    const redo = useCallback(() => {
        historyRef.current.redo();
        reportMask();
    }, [reportMask]);

    const clear = useCallback(() => {
        historyRef.current.clear();
        reportMask();
    }, [reportMask]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (isFormField(e.target)) return;
            if (!isKeyboardInScope(keyboardScopeRef.current, containerRef.current)) return;

            const modifier = e.ctrlKey || e.metaKey;
            if (!modifier) return;

            const zKey = e.key.toLowerCase() === 'z';
            if (zKey && !e.shiftKey) {
                e.preventDefault();
                undo();
            } else if (e.key.toLowerCase() === 'y' || (zKey && e.shiftKey)) {
                e.preventDefault();
                redo();
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [undo, redo]);

    const handleContainerKeyDown = useCallback((e: ReactKeyboardEvent) => {
        // Swallow Space so the page does not scroll under a pan.
        if (e.code === 'Space') e.preventDefault();
    }, []);

    // The canvases call preventDefault on mousedown, which suppresses the focus change a
    // click would normally cause. Container-scoped shortcuts are gated on focus, so without
    // this a user could click the editor and find Ctrl+Z did nothing.
    const handleContainerMouseDown = useCallback(() => {
        if (keyboardScopeRef.current === 'container') containerRef.current?.focus();
    }, []);

    const containerProps = useMemo<MaskEditorContainerProps>(
        () => ({
            ref: containerRef,
            role: 'application',
            tabIndex: 0,
            onKeyDown: handleContainerKeyDown,
            onMouseDown: handleContainerMouseDown,
        }),
        [handleContainerKeyDown, handleContainerMouseDown],
    );

    return useMemo(
        () => ({
            canvasRef,
            clear,
            containerProps,
            containerRef,
            cursorCanvasRef,
            cursorSize: currentCursorSize,
            effectiveScale: zoomPanState.effectiveScale,
            handleMouseDown,
            handleMouseUp,
            historyIndex: historyManager.historyIndex,
            historyLength: historyManager.history.length,
            isDrawing,
            isPanning: zoomPanState.isPanning,
            isZoomKeyDown: zoomPanState.isZoomKeyDown,
            key,
            maskBlendMode,
            maskCanvasRef,
            maskColor,
            maskOpacity,
            redo,
            resetZoom: zoomPanActions.resetZoom,
            scale: zoomPanState.scale,
            setCursorSize,
            setPan: zoomPanActions.setPan,
            setScale: zoomPanActions.setScale,
            size,
            transform: zoomPanState.transform,
            undo,
            zoomIn: zoomPanActions.zoomIn,
            zoomOut: zoomPanActions.zoomOut,
        }),
        [
            clear,
            containerProps,
            currentCursorSize,
            handleMouseDown,
            handleMouseUp,
            historyManager,
            isDrawing,
            key,
            maskBlendMode,
            maskColor,
            maskOpacity,
            redo,
            size,
            undo,
            zoomPanState,
            zoomPanActions,
        ],
    );
};
