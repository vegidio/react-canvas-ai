import React from 'react';
import type { Point, Transform } from '../internal/geometry';
import { acquireBodyPanCursor } from '../internal/bodyPanCursor';
import { calculateBaseScale, clampPan, toImageCoordinates } from '../internal/geometry';
import { useEventCallback, useLatest } from '../internal/useLatest';

/** How far a single zoomIn/zoomOut step moves the scale. */
const ZOOM_STEP = 0.2;

/** Content size has to move by more than this before the view re-fits itself. */
const REFIT_THRESHOLD = 5;

/** Where keyboard shortcuts are listened for. See `UseMaskEditorProps.keyboardScope`. */
export type KeyboardScope = 'window' | 'container';

export interface ZoomPanOptions {
    initialScale?: number;
    minScale?: number;
    maxScale?: number;
    enableWheelZoom?: boolean;
    constrainPan?: boolean;
    keyboardScope?: KeyboardScope;
    onScaleChange?: (scale: number) => void;
    onPanChange?: (x: number, y: number) => void;
}

export interface ZoomPanState {
    scale: number;
    transform: Transform;
    baseScale: number;
    effectiveScale: number;
    isPanning: boolean;
    isSpaceKeyDown: boolean;
    isZoomKeyDown: boolean;
}

export interface ZoomPanActions {
    setScale: React.Dispatch<React.SetStateAction<number>>;
    resetZoom: () => void;
    setPan: (x: number, y: number) => void;
    getImageCoordinates: (clientX: number, clientY: number) => Point;
    zoomIn: () => void;
    zoomOut: () => void;
}

const CENTERED: Transform = { scale: 1, translateX: 0, translateY: 0 };

const isFormField = (target: EventTarget | null): boolean => {
    const el = target as HTMLElement | null;
    const tag = el?.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || Boolean(el?.isContentEditable);
};

/**
 * Whether a key press belongs to this editor.
 *
 * Listeners stay on `window` in both modes — `keyup` and `blur` have to fire even after
 * focus has left, or a Space release goes unseen and the editor stays stuck in pan mode.
 * Only `keydown` is filtered. `Node.contains` reports true for the node itself, so the
 * container being the focused element counts as in scope.
 */
export const isKeyboardInScope = (scope: KeyboardScope, container: HTMLElement | null): boolean =>
    scope === 'window' || Boolean(container?.contains(document.activeElement));

export function useZoomPan(
    containerRef: React.RefObject<HTMLDivElement | null>,
    contentSize: Point,
    options: ZoomPanOptions = {},
): [ZoomPanState, ZoomPanActions] {
    const {
        initialScale = 1,
        minScale = 0.8,
        maxScale = 4,
        enableWheelZoom = true,
        constrainPan = true,
        keyboardScope = 'window',
        onScaleChange,
        onPanChange,
    } = options;

    // Consumers routinely pass inline arrows for these. Routing them through a stable
    // identity keeps them out of every dependency array below.
    const notifyScaleChange = useEventCallback<[number]>(onScaleChange);
    const notifyPanChange = useEventCallback<[number, number]>(onPanChange);

    const [scale, setScale] = React.useState(initialScale);
    const [transform, setTransform] = React.useState<Transform>({
        scale: initialScale,
        translateX: 0,
        translateY: 0,
    });
    const [baseScale, setBaseScale] = React.useState(1);

    const [isPanning, setIsPanning] = React.useState(false);
    const [isSpaceKeyDown, setIsSpaceKeyDown] = React.useState(false);
    const [isZoomKeyDown, setIsZoomKeyDown] = React.useState(false);

    // Mirrors of the state above. Event handlers and observers read these instead of closing
    // over the rendered values, which is what lets their effects attach exactly once.
    const scaleRef = React.useRef(scale);
    const transformRef = React.useRef(transform);
    const baseScaleRef = React.useRef(baseScale);
    const isPanningRef = React.useRef(false);
    const isSpaceKeyDownRef = React.useRef(false);
    const isZoomKeyDownRef = React.useRef(false);

    // Never rendered, so this is deliberately not state: as state it put every pan listener
    // back on the element on every single mousemove.
    const lastMousePositionRef = React.useRef<Point>({ x: 0, y: 0 });
    const releasePanCursorRef = React.useRef<(() => void) | null>(null);
    const lastContentSizeRef = React.useRef<Point>({ x: 0, y: 0 });
    const isInitialRender = React.useRef(true);

    // `setScale` is handed to consumers raw, so the ref has to survive a write that did not
    // go through `commitScale`.
    React.useLayoutEffect(() => {
        scaleRef.current = scale;
        transformRef.current = transform;
        baseScaleRef.current = baseScale;
    });

    // Single write paths. Updating the ref eagerly means two actions in the same tick see
    // each other's result, and keeps side effects out of the state updaters entirely.
    const commitScale = React.useCallback((next: number) => {
        scaleRef.current = next;
        setScale(next);
    }, []);

    const commitTransform = React.useCallback((next: Transform) => {
        transformRef.current = next;
        setTransform(next);
    }, []);

    const setPanning = React.useCallback((next: boolean) => {
        isPanningRef.current = next;
        setIsPanning(next);
    }, []);

    const effectiveScale = baseScale * scale;

    const getImageCoordinates = React.useCallback(
        (clientX: number, clientY: number): Point => {
            const container = containerRef.current;
            if (!container) return { x: 0, y: 0 };

            return toImageCoordinates(
                clientX,
                clientY,
                container.getBoundingClientRect(),
                contentSize,
                transformRef.current,
                baseScaleRef.current,
            );
        },
        [containerRef, contentSize],
    );

    /** Re-fits the content to the container and recentres it. */
    const recalculateBaseScaleAndCenter = React.useCallback(() => {
        const container = containerRef.current;
        if (!container || contentSize.x === 0 || contentSize.y === 0) return;

        lastContentSizeRef.current = { ...contentSize };

        setBaseScale(calculateBaseScale(container, contentSize));
        baseScaleRef.current = calculateBaseScale(container, contentSize);
        commitTransform({ ...CENTERED });

        isInitialRender.current = false;

        notifyScaleChange(1);
        notifyPanChange(0, 0);
    }, [containerRef, contentSize, commitTransform, notifyScaleChange, notifyPanChange]);

    const recalculateRef = useLatest(recalculateBaseScaleAndCenter);

    React.useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        // Read through the ref: closing over `recalculate` directly meant that after the
        // first resize the observer kept re-fitting to the *original* content size.
        const observer = new ResizeObserver(() => {
            isInitialRender.current = true;
            recalculateRef.current();
        });

        observer.observe(container);
        return () => observer.disconnect();
    }, [containerRef, recalculateRef]);

    React.useLayoutEffect(() => {
        if (!containerRef.current || contentSize.x === 0 || contentSize.y === 0) return;

        const last = lastContentSizeRef.current;
        const moved =
            Math.abs(last.x - contentSize.x) > REFIT_THRESHOLD || Math.abs(last.y - contentSize.y) > REFIT_THRESHOLD;

        if (isInitialRender.current || moved) recalculateBaseScaleAndCenter();
    }, [containerRef, contentSize, recalculateBaseScaleAndCenter]);

    /** Zooms so the content under the cursor stays under the cursor. */
    const zoomToPoint = React.useCallback(
        (newScale: number, pointX: number, pointY: number) => {
            const container = containerRef.current;
            if (!container) return;

            const rect = container.getBoundingClientRect();
            const under = getImageCoordinates(rect.left + pointX, rect.top + pointY);

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
        [
            containerRef,
            contentSize,
            getImageCoordinates,
            commitScale,
            commitTransform,
            notifyScaleChange,
            notifyPanChange,
        ],
    );

    const zoomToPointRef = useLatest(zoomToPoint);
    const keyboardScopeRef = useLatest(keyboardScope);

    React.useEffect(() => {
        const container = containerRef.current;
        if (!enableWheelZoom || !container) return;

        const handleWheel = (e: WheelEvent) => {
            // A plain wheel belongs to the brush-size handler.
            if (!e.ctrlKey && !e.metaKey) return;
            e.preventDefault();

            const rect = container.getBoundingClientRect();
            const current = scaleRef.current;
            const newScale = Math.max(minScale, Math.min(maxScale, current - e.deltaY * 0.01));

            if (newScale !== current) {
                zoomToPointRef.current(newScale, e.clientX - rect.left, e.clientY - rect.top);
            }
        };

        container.addEventListener('wheel', handleWheel, { passive: false });
        return () => container.removeEventListener('wheel', handleWheel);
    }, [containerRef, enableWheelZoom, minScale, maxScale, zoomToPointRef]);

    /**
     * Steps the zoom. Both the scale and the transform are written synchronously: deferring
     * the transform into a `setTimeout` from inside the `setScale` updater used to let a
     * stale zoom overwrite an intervening `resetZoom`, and double-fired under StrictMode.
     */
    const stepZoom = React.useCallback(
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

    const zoomIn = React.useCallback(() => stepZoom(ZOOM_STEP), [stepZoom]);
    const zoomOut = React.useCallback(() => stepZoom(-ZOOM_STEP), [stepZoom]);

    const resetZoom = React.useCallback(() => {
        commitScale(1);
        commitTransform({ ...CENTERED });
        notifyScaleChange(1);
        notifyPanChange(0, 0);
    }, [commitScale, commitTransform, notifyScaleChange, notifyPanChange]);

    const setPan = React.useCallback(
        (x: number, y: number) => {
            const previous = transformRef.current;
            const constrained = clampPan(x, y, contentSize, constrainPan && Boolean(containerRef.current));

            if (previous.translateX === constrained.x && previous.translateY === constrained.y) return;

            commitTransform({ ...previous, translateX: constrained.x, translateY: constrained.y });
            notifyPanChange(constrained.x, constrained.y);
        },
        [containerRef, contentSize, constrainPan, commitTransform, notifyPanChange],
    );

    const releasePanCursor = React.useCallback(() => {
        releasePanCursorRef.current?.();
        releasePanCursorRef.current = null;
    }, []);

    // Let go of the page cursor if we unmount mid-pan.
    React.useEffect(() => releasePanCursor, [releasePanCursor]);

    React.useEffect(() => {
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
    }, [containerRef, keyboardScopeRef, setPanning, releasePanCursor]);

    const canPan = transform.scale > 1;

    React.useEffect(() => {
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

        const handleMouseMove = (e: MouseEvent) => {
            if (!isPanningRef.current) return;
            e.preventDefault();

            const last = lastMousePositionRef.current;
            const current = transformRef.current;
            const deltaX = (e.clientX - last.x) / current.scale;
            const deltaY = (e.clientY - last.y) / current.scale;

            setPan(current.translateX + deltaX, current.translateY + deltaY);
            lastMousePositionRef.current = { x: e.clientX, y: e.clientY };
        };

        const stopPanning = () => {
            if (!isPanningRef.current) return;
            setPanning(false);
            releasePanCursor();
        };

        container.addEventListener('mousedown', handleMouseDown);
        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', stopPanning);
        container.addEventListener('mouseleave', stopPanning);

        return () => {
            container.removeEventListener('mousedown', handleMouseDown);
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', stopPanning);
            container.removeEventListener('mouseleave', stopPanning);
        };
    }, [containerRef, canPan, setPan, setPanning, releasePanCursor]);

    // Nothing to pan once we are back to fit-to-container.
    React.useEffect(() => {
        if (!canPan) setPan(0, 0);
    }, [canPan, setPan]);

    const state = React.useMemo<ZoomPanState>(
        () => ({ scale, transform, baseScale, effectiveScale, isPanning, isSpaceKeyDown, isZoomKeyDown }),
        [scale, transform, baseScale, effectiveScale, isPanning, isSpaceKeyDown, isZoomKeyDown],
    );

    const actions = React.useMemo<ZoomPanActions>(
        () => ({ setScale, resetZoom, setPan, getImageCoordinates, zoomIn, zoomOut }),
        [resetZoom, setPan, getImageCoordinates, zoomIn, zoomOut],
    );

    return React.useMemo<[ZoomPanState, ZoomPanActions]>(() => [state, actions], [state, actions]);
}
