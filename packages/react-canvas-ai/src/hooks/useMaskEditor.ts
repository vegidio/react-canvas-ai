import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, RefCallback, RefObject } from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MaskDotMode } from '../internal/canvas';
import type { DetectedObject } from '../internal/detection';
import type { Point, Transform } from '../internal/geometry';
import type { KeyboardScope } from '../internal/keyboard';
import type { MaskEditorMode } from '../internal/modes';
import type { ElementHandle } from '../internal/useElementRef';
import type { AutoSelectOptions, AutoSelectStatus } from './useAutoSelect';
import { applyDetectedMask, applyMaskImage, paintMaskStroke, recolorMask } from '../internal/canvas';
import { MaskEditorDefaults } from '../internal/defaults';
import { clampToSize } from '../internal/geometry';
import { isFormField, isKeyboardInScope } from '../internal/keyboard';
import { loadImage } from '../internal/loadImage';
import { MODE_TOOLS } from '../internal/modes';
import { toError } from '../internal/toError';
import { useBrushCursor, useBrushSizeWheel, useCursorPainter } from '../internal/useBrush';
import { useCanvas2dContext } from '../internal/useCanvas2dContext';
import { useElementRef } from '../internal/useElementRef';
import { useEventCallback, useLatest } from '../internal/useLatest';
import { usePropOverride } from '../internal/usePropOverride';
import { hexToRgb, toMask } from '../utils';
import { useAutoSelect } from './useAutoSelect';
import { useHistory } from './useHistory';
import { useImageLoader } from './useImageLoader';
import { useZoomPan } from './useZoomPan';

export type { MaskEditorMode } from '../internal/modes';
export { MaskEditorDefaults } from '../internal/defaults';

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

    /**
     * Enables the AI auto-selection mode: in `'auto'` mode a click runs SlimSAM locally in
     * the browser and commits the object's silhouette to the mask, undoable and reported
     * through `onMaskChange` like any stroke. When absent the editor is paint-only and
     * `mode` is forced to `'paint'`.
     */
    autoSelect?: AutoSelectOptions;
    /** Current interaction mode. Reconciled like `cursorSize`: the prop wins when it changes. */
    mode?: MaskEditorMode;
    /** Called when the mode changes through `setMode` (the prop's own changes are not echoed). */
    onModeChange?: (mode: MaskEditorMode) => void;
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
    /**
     * A callback ref, not a ref object: the zoom/pan wiring has to be told when the container
     * attaches. Spread `containerProps` rather than attaching `containerRef` by hand —
     * `containerRef` is an output, and attaching it instead leaves the editor unable to fit,
     * zoom or pan.
     */
    ref: RefCallback<HTMLDivElement>;
    role: 'application';
    tabIndex: 0;
    onKeyDown: (e: ReactKeyboardEvent) => void;
    onMouseDown: () => void;
};

export type UseMaskEditorReturn = {
    canvasRef: ElementHandle<HTMLCanvasElement>;
    /** Spread onto the element wrapping the canvas stack. See {@link MaskEditorContainerProps}. */
    containerProps: MaskEditorContainerProps;
    clear: () => void;
    cursorCanvasRef: ElementHandle<HTMLCanvasElement>;
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
    maskCanvasRef: ElementHandle<HTMLCanvasElement>;
    maskColor: string;
    maskOpacity: number;
    redo: () => void;
    /** Sets the brush size in image pixels. */
    setCursorSize: (size: number) => void;
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
    /** The active interaction mode; always `'paint'` when `autoSelect` is not configured. */
    mode: MaskEditorMode;
    /** Sets the mode. `'auto'` without `autoSelect` configured warns and is ignored. */
    setMode: (mode: MaskEditorMode) => void;
    /** Lifecycle of the auto-selection backend; a constant `'idle'` when not configured. */
    autoSelectStatus: AutoSelectStatus;
    /** True while an auto-selection is in flight, whichever way it was started. */
    isDetecting: boolean;
    /**
     * The programmatic twin of a click in auto mode: detects the object at `point` (canvas
     * pixels) and commits it to the mask — undoable, reported through `onMaskChange` — then
     * resolves with the detection, or `undefined` when nothing scored above `minScore`.
     * Rejects when `autoSelect` is not configured or the image has not loaded; unlike a
     * click, failures are the caller's to handle and are not routed to `autoSelect.onError`.
     */
    selectAt: (point: { x: number; y: number }) => Promise<DetectedObject | undefined>;
};

/**
 * The imperative surface exposed through `MaskEditor`'s `canvasRef`.
 *
 * Derived from the hook's return rather than restated, so adding a method is one edit
 * instead of three that have to agree.
 *
 * `maskColor`, `maskOpacity`, `maskBlendMode` and `cursorSize` are live reads of the style
 * the editor is currently painting with, including changes the editor makes to itself (the
 * brush size responds to the wheel). They are here for peer components that paint into
 * `maskCanvas` directly — without them such a plugin can only match the editor's look by
 * having the consumer pass the same style props a second time.
 */
export type MaskEditorCanvasRef = Pick<
    UseMaskEditorReturn,
    | 'undo'
    | 'redo'
    | 'clear'
    | 'resetZoom'
    | 'setPan'
    | 'setScale'
    | 'zoomIn'
    | 'zoomOut'
    | 'setMode'
    | 'selectAt'
    | 'maskColor'
    | 'maskOpacity'
    | 'maskBlendMode'
    | 'cursorSize'
    | 'mode'
    | 'autoSelectStatus'
> & {
    maskCanvas?: HTMLCanvasElement;
};

/** How long the mask report waits for the stroke to settle. */
const MASK_DEBOUNCE_MS = 300;

/**
 * Pointer travel (in viewport px) under which an auto-mode press still counts as a click.
 * Anything farther is a drag — a middle-button pan that started on the canvas, or a slip —
 * and segmenting at its end would surprise.
 */
const AUTO_CLICK_SLOP_PX = 4;

/**
 * The gesture that takes coverage away rather than adding it: the secondary button, or shift.
 * One definition, because the brush reads it off a live `buttons` bitmask and auto-selection
 * off the `button` recorded at mousedown, and the two silently drifting would mean shift-click
 * erasing in one mode and painting in the other.
 */
const isEraseGesture = (evt: { buttons?: number; button?: number; shiftKey: boolean }): boolean =>
    evt.shiftKey || (evt.buttons !== undefined ? evt.buttons > 1 : evt.button === 2);

/** What a mode does with a press and a release on the canvas. */
type ModeHandlers = {
    onDown: (e: ReactMouseEvent<HTMLCanvasElement>) => void;
    onUp: (e: ReactMouseEvent<HTMLCanvasElement>) => void;
};

export const useMaskEditor = (props: UseMaskEditorProps): UseMaskEditorReturn => {
    const {
        src,
        crossOrigin,
        maxWidth = MaskEditorDefaults.maxWidth,
        maxHeight = MaskEditorDefaults.maxHeight,
        cursorSize: cursorSizeProp = MaskEditorDefaults.cursorSize,
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
        autoSelect,
        mode: modeProp,
        onModeChange,
    } = props;

    // Only the mask and cursor layers have hooks subscribing to their element; the base canvas
    // is painted through its handle, so its element state is deliberately unused. All three stay
    // the same shape so consumers attach them identically.
    const [canvasRef] = useElementRef<HTMLCanvasElement>();
    const [maskCanvasRef, maskCanvas] = useElementRef<HTMLCanvasElement>();
    const [cursorCanvasRef, cursorCanvas] = useElementRef<HTMLCanvasElement>();
    const containerRef = useRef<HTMLDivElement>(null);
    const initialMaskAppliedRef = useRef<string | undefined>(undefined);

    // Only the mask layer is ever read back (history snapshots, recolouring, `toMask`), so it
    // is the only one that wants `willReadFrequently`. The cursor layer is repainted on every
    // pointer move and must stay on the GPU path.
    const maskContext = useCanvas2dContext(maskCanvas, { willReadFrequently: true });
    const cursorContext = useCanvas2dContext(cursorCanvas);

    const [isDrawing, setIsDrawing] = useState(false);

    // `cursorSize` and `mode` are both quasi-controlled — the prop wins when it changes, the
    // setter wins in between — so they share one hook rather than one copy of the dance each.
    const [currentCursorSize, setCursorSize] = usePropOverride(cursorSizeProp, MaskEditorDefaults.cursorSize);
    const [modeState, setModeState] = usePropOverride<MaskEditorMode>(modeProp, 'paint');

    // The boolean, not the object: `autoSelect` is typically an inline literal whose identity
    // changes every render, which would defeat the return memo below (and with it every
    // context consumer's render bail-out).
    const hasAutoSelect = Boolean(autoSelect);

    // Derived, not clamped in state: dropping `autoSelect` snaps the editor back to painting,
    // and configuring it later resumes whatever mode was last requested.
    const mode: MaskEditorMode = hasAutoSelect ? modeState : 'paint';

    // What the active mode does to the pointer, as data. Every site that used to ask
    // `mode === 'auto'` asks the descriptor instead, so a third mode is one table entry.
    const tool = MODE_TOOLS[mode];

    // Latched rather than derived from `mode`: leaving auto mode must not tear the warm model
    // down, or every toggle back would re-download and re-encode.
    const [hasEnteredAuto, setHasEnteredAuto] = useState(false);
    if (tool.usesAutoSelect && !hasEnteredAuto) setHasEnteredAuto(true);

    const { image, size, key } = useImageLoader(src, maxWidth, maxHeight, crossOrigin);

    const autoSelection = useAutoSelect({
        config: autoSelect,
        image,
        // `useAutoSelect` is already inert without a config, and `hasEnteredAuto` can only
        // latch while `autoSelect` is configured, so re-checking it here would be a third guard.
        shouldWarm: Boolean(autoSelect?.preload || hasEnteredAuto),
    });

    const [zoomPanState, zoomPanActions, attachZoomPan] = useZoomPan(size, {
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
    const modeRef = useLatest(mode);
    const isBrushActiveRef = useLatest(tool.usesBrush);
    const sizeRef = useLatest(size);
    const hasAutoSelectRef = useLatest(hasAutoSelect);
    const isDetectingRef = useLatest(autoSelection.isDetecting);
    const detectRef = useLatest(autoSelection.detect);

    const notifyCursorSizeChange = useEventCallback<[number]>(onCursorSizeChange);
    const notifyDrawingChange = useEventCallback<[boolean]>(onDrawingChange);
    const notifyModeChange = useEventCallback<[MaskEditorMode]>(onModeChange);
    const notifyObjectDetected = useEventCallback<[DetectedObject]>(autoSelect?.onObjectDetected);
    const notifyAutoSelectError = useEventCallback<[Error]>(autoSelect?.onError);

    const setMode = useCallback(
        (next: MaskEditorMode) => {
            if (next === 'auto' && !hasAutoSelectRef.current) {
                console.warn("[MaskEditor] setMode('auto') ignored: no `autoSelect` is configured.");
                return;
            }
            if (modeRef.current === next) return;

            setModeState(next);
            notifyModeChange(next);
        },
        [notifyModeChange],
    );

    /** Reports the current mask, skipping the pixel work when nobody is listening. */
    const reportMask = useCallback(() => {
        if (!maskCanvas || !onMaskChangeRef.current) return;

        try {
            onMaskChangeRef.current(toMask(maskCanvas));
        } catch (error) {
            console.error('[MaskEditor] onMaskChange callback threw:', error);
        }
    }, [maskCanvas]);

    /**
     * Sizes the three layers and paints the image.
     *
     * A layout effect rather than a timer: the base canvas carries `key`, so it is a brand
     * new element by the time a deferred draw would have run. React attaches refs before
     * layout effects, so this always sees the element that is actually mounted.
     */
    useLayoutEffect(() => {
        if (size.x === 0 || size.y === 0) return;

        // Read through the handles rather than depending on the element state: the base canvas
        // carries `key`, so on a new image React swaps the element in the same commit. Refs are
        // attached before layout effects, so `.current` is already the canvas that is actually
        // mounted — whereas the state lags a render, which painted the outgoing element first.
        for (const layer of [canvasRef, maskCanvasRef, cursorCanvasRef]) {
            const element = layer.current;
            if (!element) continue;
            element.width = size.x;
            element.height = size.y;
        }

        const base = canvasRef.current;
        if (!image || !base) return;

        const ctx = base.getContext('2d');
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
                if (controller.signal.aborted || !maskCanvas) return;

                // Converted, not blitted. `maskColorRef` rather than a `maskColor` dependency, so
                // a colour change mid-load does not restart the load; the recolour effect has
                // already committed that same colour, so the two cannot disagree, and any later
                // change retints these pixels exactly like painted ones.
                applyMaskImage(maskContext, size, img, hexToRgb(maskColorRef.current));

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
    }, [initialMask, maskContext, maskCanvas, size, reportMask]);

    // Recolour existing strokes when the mask colour changes. Seeded with the mount-time colour
    // because the canvas starts empty and there is nothing to recolour: starting this at
    // `undefined` meant `recolorMask` walked every pixel of a blank surface once per mount,
    // which is exactly what the comment here used to claim it prevented.
    const appliedMaskColorRef = useRef(maskColor);
    useEffect(() => {
        if (!maskContext || size.x === 0 || size.y === 0) return;
        if (appliedMaskColorRef.current === maskColor) return;

        appliedMaskColorRef.current = maskColor;
        recolorMask(maskContext, size, hexToRgb(maskColor));
    }, [maskContext, maskColor, size]);

    // Where the last dab of the current stroke landed, so the next one can be joined to it.
    // Image coordinates, matching what the brush paints in, and the mode alongside because a
    // paint dab and an erase dab must never be joined to each other.
    const lastDabRef = useRef<{ point: Point; mode: MaskDotMode } | undefined>(undefined);

    /**
     * Paints one brush dab for a pointer event, joined to the previous dab of the same stroke.
     * Both the freehand move handler and mousedown paint identically, so the decision lives here
     * rather than being repeated at each call site. Whether the brush runs at all is the mode
     * descriptor's business, checked once by each of the two entry points rather than a third
     * time here.
     *
     * The join is broken when the gesture flips, because `isEraseGesture` is evaluated per dab:
     * shift pressed mid-stroke switches a stroke from adding coverage to taking it away, and a
     * connector drawn in the new mode across ground covered in the old one is not what the hand
     * asked for.
     */
    const paintDab = useCallback(
        (x: number, y: number, evt: Pick<MouseEvent, 'buttons' | 'shiftKey'>) => {
            if (!maskContext) return;

            const dabMode: MaskDotMode = isEraseGesture(evt) ? 'erase' : 'paint';
            const last = lastDabRef.current;
            const from = last && last.mode === dabMode ? last.point : undefined;
            const to = { x, y };

            paintMaskStroke(maskContext, from, to, cursorSizeRef.current, maskColorRef.current, dabMode);
            lastDabRef.current = { point: to, mode: dabMode };
        },
        [maskContext],
    );

    // `active` rather than an effect out here: the painter owns clearing the outline when the
    // brush goes away, so the mode that has no brush declares that once instead of the editor
    // remembering to tidy up after it.
    const paintCursor = useCursorPainter(cursorContext, {
        size,
        maskColor,
        maskOpacity,
        active: tool.usesBrush,
    });

    useBrushCursor(cursorCanvas, {
        paintCursor,
        getImageCoordinates: zoomPanActions.getImageCoordinates,
        cursorSizeRef,
        isPanning: zoomPanState.isPanning,
        isSpaceKeyDown: zoomPanState.isSpaceKeyDown,
        isBrushActiveRef,
        paintDab,
    });

    useBrushSizeWheel(cursorCanvas, {
        enabled: Boolean(onCursorSizeChange),
        paintCursor,
        getImageCoordinates: zoomPanActions.getImageCoordinates,
        cursorSizeRef,
        isBrushActiveRef,
        setCursorSize,
        onCursorSizeChange: notifyCursorSizeChange,
    });

    /**
     * Detects at `point` and commits the silhouette through the same path a stroke ends with:
     * composite in the live mask colour, snapshot history, report the mask. That is the whole
     * reason auto-selection lives inside the editor — as an external plugin it painted behind
     * the editor's back, so its selections were invisible to undo and `onMaskChange`.
     *
     * Rejections propagate: the click path reports them to `autoSelect.onError` (nobody else
     * can hear a click fail), while `selectAt` callers get the rejection itself.
     */
    const runAutoSelect = useCallback(
        async (point: Point, dabMode: 'paint' | 'erase'): Promise<DetectedObject | undefined> => {
            const target = sizeRef.current;
            const detection = await detectRef.current(clampToSize(point, target), target);
            if (!detection) return undefined;

            if (!maskContext) throw new Error('[MaskEditor] The mask canvas is not ready.');
            applyDetectedMask(maskContext, sizeRef.current, detection.silhouette, maskColorRef.current, dabMode);
            historyRef.current.saveToHistory();
            reportMask();

            // After the commit, so the handler observes the mask it was told about.
            notifyObjectDetected(detection.object);
            return detection.object;
        },
        [maskContext, reportMask, notifyObjectDetected],
    );

    const selectAt = useCallback(
        (point: { x: number; y: number }): Promise<DetectedObject | undefined> => runAutoSelect(point, 'paint'),
        [runAutoSelect],
    );

    // Where an auto-mode press started, so mouseup can tell a click from a drag. Viewport
    // coordinates, deliberately: image coordinates stretch with the zoom, which would turn
    // the fixed slop into a zoom-dependent one.
    const autoClickStartRef = useRef<{ x: number; y: number; button: number; shiftKey: boolean } | undefined>(
        undefined,
    );

    const beginStroke = useCallback(
        (e: ReactMouseEvent<HTMLCanvasElement>) => {
            const { x, y } = getImageCoordinatesRef.current(e.nativeEvent.clientX, e.nativeEvent.clientY);

            // Before the dab, not after: a press starts a fresh stroke, and joining it to
            // wherever the last one ended would rule a line across the whole canvas.
            lastDabRef.current = undefined;
            paintDab(x, y, e.nativeEvent);

            setIsDrawing(true);
            notifyDrawingChange(true);
        },
        [paintDab, notifyDrawingChange],
    );

    const endStroke = useCallback(() => {
        lastDabRef.current = undefined;
        setIsDrawing(false);
        notifyDrawingChange(false);
        historyRef.current.saveToHistory();
        reportMask();
    }, [reportMask, notifyDrawingChange]);

    // No dab and no `isDrawing`: drawing is a brush notion, and flagging it here would fire
    // `onDrawingChange` for something that is not a stroke.
    const beginAutoClick = useCallback((e: ReactMouseEvent<HTMLCanvasElement>) => {
        autoClickStartRef.current = {
            x: e.nativeEvent.clientX,
            y: e.nativeEvent.clientY,
            button: e.nativeEvent.button,
            shiftKey: e.nativeEvent.shiftKey,
        };
    }, []);

    const endAutoClick = useCallback(
        (e: ReactMouseEvent<HTMLCanvasElement>) => {
            const start = autoClickStartRef.current;
            autoClickStartRef.current = undefined;
            if (!start) return;

            const travel = Math.hypot(e.nativeEvent.clientX - start.x, e.nativeEvent.clientY - start.y);
            if (travel > AUTO_CLICK_SLOP_PX) return;

            // One at a time: a queue of clicks against a busy model would replay stale
            // intentions seconds later.
            if (isDetectingRef.current) return;

            const point = getImageCoordinatesRef.current(start.x, start.y);
            runAutoSelect(point, isEraseGesture(start) ? 'erase' : 'paint').catch((error: unknown) => {
                notifyAutoSelectError(toError(error));
            });
        },
        [runAutoSelect, notifyAutoSelectError],
    );

    // The pointer half of each mode's behaviour, alongside the presentation half in
    // `MODE_TOOLS`. Both are exhaustive `Record`s over `MaskEditorMode`, so a new mode is a
    // compile error until it says what it does — which is what the scattered `mode === 'auto'`
    // checks this replaced could never enforce.
    const tools = useMemo<Record<MaskEditorMode, ModeHandlers>>(
        () => ({
            paint: { onDown: beginStroke, onUp: endStroke },
            auto: { onDown: beginAutoClick, onUp: endAutoClick },
        }),
        [beginStroke, endStroke, beginAutoClick, endAutoClick],
    );
    const toolsRef = useLatest(tools);

    const handleMouseDown = useCallback((e: ReactMouseEvent<HTMLCanvasElement>) => {
        e.preventDefault();
        if (isPanningRef.current || isSpaceKeyDownRef.current) return;
        toolsRef.current[modeRef.current].onDown(e);
    }, []);

    const handleMouseUp = useCallback((e: ReactMouseEvent<HTMLCanvasElement>) => {
        e.preventDefault();
        // Read through refs: this used to close over a stale `isPanning`, so ending a
        // space-drag pan also ended the stroke and pushed a history entry.
        if (isPanningRef.current || isSpaceKeyDownRef.current) return;
        toolsRef.current[modeRef.current].onUp(e);
    }, []);

    // A release outside the canvas never reaches the cursor layer's own `mouseup`, so the last
    // dab would survive the stroke. The next move with a button already held — a press that
    // started on a toolbar and dragged in — would then be joined to it, ruling a line across the
    // mask from wherever the previous stroke happened to end.
    useEffect(() => {
        const handleWindowMouseUp = () => {
            lastDabRef.current = undefined;
        };

        window.addEventListener('mouseup', handleWindowMouseUp);
        return () => window.removeEventListener('mouseup', handleWindowMouseUp);
    }, []);

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

    const setContainer = useCallback<RefCallback<HTMLDivElement>>(
        (node) => {
            containerRef.current = node;
            // Unreachable in React 19, which stops passing `null` once a ref callback returns a
            // cleanup — but `RefCallback` still types the parameter as nullable for React 18.
            if (!node) return;

            const detachZoomPan = attachZoomPan(node);

            // Detaching is where the mirror gets cleared, precisely because the `null` call
            // never comes; without this the ref would keep a detached node alive.
            return () => {
                detachZoomPan();
                containerRef.current = null;
            };
        },
        [attachZoomPan],
    );

    const containerProps = useMemo<MaskEditorContainerProps>(
        () => ({
            ref: setContainer,
            role: 'application',
            tabIndex: 0,
            onKeyDown: handleContainerKeyDown,
            onMouseDown: handleContainerMouseDown,
        }),
        [setContainer, handleContainerKeyDown, handleContainerMouseDown],
    );

    return useMemo(
        () => ({
            autoSelectStatus: hasAutoSelect ? autoSelection.status : 'idle',
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
            isDetecting: autoSelection.isDetecting,
            isDrawing,
            isPanning: zoomPanState.isPanning,
            isZoomKeyDown: zoomPanState.isZoomKeyDown,
            key,
            maskBlendMode,
            maskCanvasRef,
            maskColor,
            maskOpacity,
            mode,
            redo,
            resetZoom: zoomPanActions.resetZoom,
            scale: zoomPanState.scale,
            selectAt,
            setCursorSize,
            setMode,
            setPan: zoomPanActions.setPan,
            setScale: zoomPanActions.setScale,
            size,
            transform: zoomPanState.transform,
            undo,
            zoomIn: zoomPanActions.zoomIn,
            zoomOut: zoomPanActions.zoomOut,
        }),
        [
            hasAutoSelect,
            autoSelection,
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
            mode,
            redo,
            selectAt,
            setMode,
            size,
            undo,
            zoomPanState,
            zoomPanActions,
        ],
    );
};
