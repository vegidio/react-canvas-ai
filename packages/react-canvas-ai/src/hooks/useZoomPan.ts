import type { RefObject } from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Point, Transform } from '../internal/geometry';
import type { KeyboardScope } from '../internal/keyboard';
import { acquireBodyPanCursor } from '../internal/bodyPanCursor';
import { MaskEditorDefaults } from '../internal/defaults';
import { calculateBaseScale, clampPan, toImageCoordinates } from '../internal/geometry';
import { isFormField, isKeyboardInScope } from '../internal/keyboard';
import { useEventCallback, useLatest } from '../internal/useLatest';

/** How far a single zoomIn/zoomOut step moves the scale. */
const ZOOM_STEP = 0.2;

/** Content size has to move by more than this before the view re-fits itself. */
const REFIT_THRESHOLD = 5;

export type ZoomPanOptions = {
    initialScale?: number;
    minScale?: number;
    maxScale?: number;
    enableWheelZoom?: boolean;
    constrainPan?: boolean;
    keyboardScope?: KeyboardScope;
    onScaleChange?: (scale: number) => void;
    onPanChange?: (x: number, y: number) => void;
};

export type ZoomPanState = {
    scale: number;
    transform: Transform;
    baseScale: number;
    effectiveScale: number;
    isPanning: boolean;
    isSpaceKeyDown: boolean;
    isZoomKeyDown: boolean;
};

export type ZoomPanActions = {
    /**
     * Sets the zoom, clamped to `[minScale, maxScale]`. Moves the transform with it — the raw
     * state dispatch this replaced left them disagreeing.
     */
    setScale: (scale: number) => void;
    resetZoom: () => void;
    setPan: (x: number, y: number) => void;
    getImageCoordinates: (clientX: number, clientY: number) => Point;
    zoomIn: () => void;
    zoomOut: () => void;
};

const CENTERED: Transform = { scale: 1, translateX: 0, translateY: 0 };

export const useZoomPan = (
    containerRef: RefObject<HTMLDivElement | null>,
    contentSize: Point,
    options: ZoomPanOptions = {},
): [ZoomPanState, ZoomPanActions] => {
    const {
        initialScale = MaskEditorDefaults.scale,
        minScale = MaskEditorDefaults.minScale,
        maxScale = MaskEditorDefaults.maxScale,
        enableWheelZoom = MaskEditorDefaults.enableWheelZoom,
        constrainPan = MaskEditorDefaults.constrainPan,
        keyboardScope = MaskEditorDefaults.keyboardScope,
        onScaleChange,
        onPanChange,
    } = options;

    // Consumers routinely pass inline arrows for these. Routing them through a stable
    // identity keeps them out of every dependency array below.
    const notifyScaleChange = useEventCallback<[number]>(onScaleChange);
    const notifyPanChange = useEventCallback<[number, number]>(onPanChange);

    const [scale, setScaleState] = useState(initialScale);
    const [transform, setTransform] = useState<Transform>({
        scale: initialScale,
        translateX: 0,
        translateY: 0,
    });
    const [baseScale, setBaseScale] = useState(1);

    const [isPanning, setIsPanning] = useState(false);
    const [isSpaceKeyDown, setIsSpaceKeyDown] = useState(false);
    const [isZoomKeyDown, setIsZoomKeyDown] = useState(false);

    // Mirrors of the state above. Event handlers and observers read these instead of closing
    // over the rendered values, which is what lets their effects attach exactly once.
    // Every write goes through `commitScale`/`commitTransform`, which update the ref eagerly;
    // `useLatest` re-syncs on commit as a backstop.
    const scaleRef = useLatest(scale);
    const transformRef = useLatest(transform);
    const baseScaleRef = useLatest(baseScale);
    const isPanningRef = useRef(false);
    const isSpaceKeyDownRef = useRef(false);
    const isZoomKeyDownRef = useRef(false);

    // Never rendered, so this is deliberately not state: as state it put every pan listener
    // back on the element on every single mousemove.
    const lastMousePositionRef = useRef<Point>({ x: 0, y: 0 });
    const releasePanCursorRef = useRef<(() => void) | undefined>(undefined);
    // Latest un-committed pointer position during a pan, and the frame scheduled to apply it.
    const pendingPanRef = useRef<Point | undefined>(undefined);
    const frameRef = useRef<number | undefined>(undefined);
    // `undefined` until the first successful fit, which is what makes that first fit unconditional.
    const lastContentSizeRef = useRef<Point | undefined>(undefined);

    // Single write paths. Updating the ref eagerly means two actions in the same tick see
    // each other's result, and keeps side effects out of the state updaters entirely.
    const commitScale = useCallback((next: number) => {
        scaleRef.current = next;
        setScaleState(next);
    }, []);

    const commitTransform = useCallback((next: Transform) => {
        transformRef.current = next;
        setTransform(next);
    }, []);

    const setPanning = useCallback((next: boolean) => {
        isPanningRef.current = next;
        setIsPanning(next);
    }, []);

    const effectiveScale = baseScale * scale;

    /**
     * Maps a viewport point into image space against a rect the caller already holds.
     * `getBoundingClientRect` forces a layout read, so anything on a pointer or wheel path
     * should read the rect once and pass it here rather than going through
     * {@link getImageCoordinates}.
     */
    const toImageCoordinatesWithRect = useCallback(
        (clientX: number, clientY: number, rect: DOMRect): Point =>
            toImageCoordinates(clientX, clientY, rect, contentSize, transformRef.current, baseScaleRef.current),
        [contentSize],
    );

    // The container rect is read on every pointer move, but only changes on scroll, resize
    // or a layout shift. Cache it and invalidate on those, rather than forcing a layout read
    // per event.
    const cachedRectRef = useRef<DOMRect | undefined>(undefined);

    const readRect = useCallback((): DOMRect | undefined => {
        const container = containerRef.current;
        if (!container) return undefined;

        cachedRectRef.current ??= container.getBoundingClientRect();
        return cachedRectRef.current;
    }, [containerRef]);

    const invalidateRect = useCallback(() => {
        cachedRectRef.current = undefined;
    }, []);

    useEffect(() => {
        const container = containerRef.current;

        // Capture phase: a scroll in any ancestor moves the container, and scroll events
        // from a nested element do not bubble.
        window.addEventListener('scroll', invalidateRect, true);
        window.addEventListener('resize', invalidateRect);
        // The pointer entering is the gesture boundary: it bounds how long a cached rect can
        // survive, so a layout shift that moved the container without resizing it — which
        // neither the ResizeObserver nor a scroll would catch — cannot go unnoticed across
        // two separate interactions.
        container?.addEventListener('mouseenter', invalidateRect);

        return () => {
            window.removeEventListener('scroll', invalidateRect, true);
            window.removeEventListener('resize', invalidateRect);
            container?.removeEventListener('mouseenter', invalidateRect);
        };
    }, [containerRef, invalidateRect]);

    const getImageCoordinates = useCallback(
        (clientX: number, clientY: number): Point => {
            const rect = readRect();
            if (!rect) return { x: 0, y: 0 };

            return toImageCoordinatesWithRect(clientX, clientY, rect);
        },
        [readRect, toImageCoordinatesWithRect],
    );

    /** Re-fits the content to the container and recentres it. */
    const recalculateBaseScaleAndCenter = useCallback(() => {
        const container = containerRef.current;
        if (!container || contentSize.x === 0 || contentSize.y === 0) return;

        lastContentSizeRef.current = { ...contentSize };

        // Once: each call forces a style recalc via `getComputedStyle`.
        const nextBaseScale = calculateBaseScale(container, contentSize);
        setBaseScale(nextBaseScale);
        baseScaleRef.current = nextBaseScale;
        commitTransform({ ...CENTERED });

        notifyScaleChange(1);
        notifyPanChange(0, 0);
    }, [containerRef, contentSize, commitTransform, notifyScaleChange, notifyPanChange]);

    const recalculateRef = useLatest(recalculateBaseScaleAndCenter);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        // Read through the ref: closing over `recalculate` directly meant that after the
        // first resize the observer kept re-fitting to the *original* content size.
        const observer = new ResizeObserver(() => {
            cachedRectRef.current = undefined;
            lastContentSizeRef.current = undefined;
            recalculateRef.current();
        });

        observer.observe(container);
        return () => observer.disconnect();
    }, [containerRef]);

    useLayoutEffect(() => {
        if (!containerRef.current || contentSize.x === 0 || contentSize.y === 0) return;

        const last = lastContentSizeRef.current;
        const moved =
            !last ||
            Math.abs(last.x - contentSize.x) > REFIT_THRESHOLD ||
            Math.abs(last.y - contentSize.y) > REFIT_THRESHOLD;

        if (moved) recalculateBaseScaleAndCenter();
    }, [containerRef, contentSize, recalculateBaseScaleAndCenter]);

    /** Zooms so the content under the cursor stays under the cursor. */
    const zoomToPoint = useCallback(
        (newScale: number, pointX: number, pointY: number, rect: DOMRect) => {
            const under = toImageCoordinatesWithRect(rect.left + pointX, rect.top + pointY, rect);

            const cursorOffsetX = pointX - rect.width / 2;
            const cursorOffsetY = pointY - rect.height / 2;
            const newCombinedScale = baseScaleRef.current * newScale;

            const translateX = -((under.x - contentSize.x / 2) * newCombinedScale - cursorOffsetX) / newCombinedScale;
            const translateY = -((under.y - contentSize.y / 2) * newCombinedScale - cursorOffsetY) / newCombinedScale;

            commitScale(newScale);
            commitTransform({ scale: newScale, translateX, translateY });

            notifyScaleChange(newScale);
            notifyPanChange(translateX, translateY);
        },
        [contentSize, toImageCoordinatesWithRect, commitScale, commitTransform, notifyScaleChange, notifyPanChange],
    );

    const zoomToPointRef = useLatest(zoomToPoint);
    const keyboardScopeRef = useLatest(keyboardScope);

    useEffect(() => {
        const container = containerRef.current;
        if (!enableWheelZoom || !container) return;

        const handleWheel = (e: WheelEvent) => {
            // A plain wheel belongs to the brush-size handler.
            if (!e.ctrlKey && !e.metaKey) return;
            e.preventDefault();

            const rect = readRect();
            if (!rect) return;

            const current = scaleRef.current;
            const newScale = Math.max(minScale, Math.min(maxScale, current - e.deltaY * 0.01));

            if (newScale !== current) {
                zoomToPointRef.current(newScale, e.clientX - rect.left, e.clientY - rect.top, rect);
            }
        };

        container.addEventListener('wheel', handleWheel, { passive: false });
        return () => container.removeEventListener('wheel', handleWheel);
    }, [containerRef, enableWheelZoom, minScale, maxScale, readRect]);

    /**
     * Steps the zoom. Both the scale and the transform are written synchronously: deferring
     * the transform into a `setTimeout` from inside the `setScale` updater used to let a
     * stale zoom overwrite an intervening `resetZoom`, and double-fired under StrictMode.
     */
    const stepZoom = useCallback(
        (delta: number) => {
            const current = scaleRef.current;
            const newScale = Math.max(minScale, Math.min(maxScale, current + delta));
            if (newScale === current) return;

            commitScale(newScale);
            commitTransform({ ...transformRef.current, scale: newScale });
            notifyScaleChange(newScale);
        },
        [minScale, maxScale, commitScale, commitTransform, notifyScaleChange],
    );

    const setScale = useCallback(
        (next: number) => {
            const clamped = Math.max(minScale, Math.min(maxScale, next));
            if (clamped === scaleRef.current) return;

            commitScale(clamped);
            commitTransform({ ...transformRef.current, scale: clamped });
            notifyScaleChange(clamped);
        },
        [minScale, maxScale, commitScale, commitTransform, notifyScaleChange],
    );

    const zoomIn = useCallback(() => stepZoom(ZOOM_STEP), [stepZoom]);
    const zoomOut = useCallback(() => stepZoom(-ZOOM_STEP), [stepZoom]);

    const resetZoom = useCallback(() => {
        commitScale(1);
        commitTransform({ ...CENTERED });
        notifyScaleChange(1);
        notifyPanChange(0, 0);
    }, [commitScale, commitTransform, notifyScaleChange, notifyPanChange]);

    const setPan = useCallback(
        (x: number, y: number) => {
            const previous = transformRef.current;
            const constrained = clampPan(x, y, contentSize, constrainPan && Boolean(containerRef.current));

            if (previous.translateX === constrained.x && previous.translateY === constrained.y) return;

            commitTransform({ ...previous, translateX: constrained.x, translateY: constrained.y });
            notifyPanChange(constrained.x, constrained.y);
        },
        [containerRef, contentSize, constrainPan, commitTransform, notifyPanChange],
    );

    const releasePanCursor = useCallback(() => {
        releasePanCursorRef.current?.();
        releasePanCursorRef.current = undefined;
    }, []);

    // Let go of the page cursor if we unmount mid-pan.
    useEffect(() => releasePanCursor, [releasePanCursor]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (isFormField(e.target)) return;
            if (!isKeyboardInScope(keyboardScopeRef.current, containerRef.current)) return;

            // Space only grabs the pan cursor once there is something to pan.
            if (e.code === 'Space' && transformRef.current.scale > 1) {
                e.preventDefault();
                if (!isSpaceKeyDownRef.current) {
                    isSpaceKeyDownRef.current = true;
                    setIsSpaceKeyDown(true);
                }
            }

            if ((e.ctrlKey || e.metaKey) && !isZoomKeyDownRef.current) {
                isZoomKeyDownRef.current = true;
                setIsZoomKeyDown(true);
            }
        };

        const handleKeyUp = (e: KeyboardEvent) => {
            if (e.code === 'Space') {
                e.preventDefault();
                isSpaceKeyDownRef.current = false;
                setIsSpaceKeyDown(false);
                setPanning(false);
            }

            if (!e.ctrlKey && !e.metaKey && isZoomKeyDownRef.current) {
                isZoomKeyDownRef.current = false;
                setIsZoomKeyDown(false);
            }
        };

        const handleBlur = () => {
            setPanning(false);
            isSpaceKeyDownRef.current = false;
            setIsSpaceKeyDown(false);
            isZoomKeyDownRef.current = false;
            setIsZoomKeyDown(false);
            // Losing focus mid-pan used to leave the page stuck on `cursor: grabbing`.
            releasePanCursor();
        };

        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('keyup', handleKeyUp);
        window.addEventListener('blur', handleBlur);

        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('keyup', handleKeyUp);
            window.removeEventListener('blur', handleBlur);
        };
    }, [containerRef, setPanning, releasePanCursor]);

    const canPan = transform.scale > 1;

    useEffect(() => {
        const container = containerRef.current;
        if (!container || !canPan) return;

        const handleMouseDown = (e: MouseEvent) => {
            // Middle button, or left button with space held.
            if (e.button !== 1 && !(e.button === 0 && isSpaceKeyDownRef.current)) return;

            e.preventDefault();
            lastMousePositionRef.current = { x: e.clientX, y: e.clientY };
            releasePanCursorRef.current = acquireBodyPanCursor();
            setPanning(true);
        };

        // Pointer devices deliver moves well above display refresh, and every commit here is
        // a React state update plus a full re-render of the editor. Coalescing to one commit
        // per frame drops the redundant renders; the delta is measured from the position at
        // the last commit, so no movement is lost.
        //
        // Only the pan commit is coalesced. The mask-painting path deliberately still paints
        // per event: one dab per frame would leave visible gaps in a fast stroke.
        const flushPan = () => {
            frameRef.current = undefined;

            const pending = pendingPanRef.current;
            if (!pending || !isPanningRef.current) return;
            pendingPanRef.current = undefined;

            const last = lastMousePositionRef.current;
            const current = transformRef.current;
            const deltaX = (pending.x - last.x) / current.scale;
            const deltaY = (pending.y - last.y) / current.scale;

            setPan(current.translateX + deltaX, current.translateY + deltaY);
            lastMousePositionRef.current = pending;
        };

        const handleMouseMove = (e: MouseEvent) => {
            if (!isPanningRef.current) return;
            e.preventDefault();

            pendingPanRef.current = { x: e.clientX, y: e.clientY };
            frameRef.current ??= requestAnimationFrame(flushPan);
        };

        const stopPanning = () => {
            if (!isPanningRef.current) return;
            // Land the last move rather than dropping it on the floor.
            flushPan();
            setPanning(false);
            releasePanCursor();
        };

        container.addEventListener('mousedown', handleMouseDown);
        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', stopPanning);
        container.addEventListener('mouseleave', stopPanning);

        return () => {
            if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
            frameRef.current = undefined;
            pendingPanRef.current = undefined;

            container.removeEventListener('mousedown', handleMouseDown);
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', stopPanning);
            container.removeEventListener('mouseleave', stopPanning);
        };
    }, [containerRef, canPan, setPan, setPanning, releasePanCursor]);

    // Nothing to pan once we are back to fit-to-container.
    useEffect(() => {
        if (!canPan) setPan(0, 0);
    }, [canPan, setPan]);

    const state = useMemo<ZoomPanState>(
        () => ({ scale, transform, baseScale, effectiveScale, isPanning, isSpaceKeyDown, isZoomKeyDown }),
        [scale, transform, baseScale, effectiveScale, isPanning, isSpaceKeyDown, isZoomKeyDown],
    );

    const actions = useMemo<ZoomPanActions>(
        () => ({ setScale, resetZoom, setPan, getImageCoordinates, zoomIn, zoomOut }),
        [setScale, resetZoom, setPan, getImageCoordinates, zoomIn, zoomOut],
    );

    // No memo around the tuple: it is destructured at the call site, so its identity is
    // never observed.
    return [state, actions];
};
