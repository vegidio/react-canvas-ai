import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef } from 'react';
import type { Point, Transform } from '../internal/geometry';
import type { KeyboardScope } from '../internal/keyboard';
import type { ZoomPanAction } from '../internal/zoomPanReducer';
import { acquireBodyPanCursor } from '../internal/bodyPanCursor';
import { MaskEditorDefaults } from '../internal/defaults';
import { calculateBaseScale, clampPan, toImageCoordinates } from '../internal/geometry';
import { isFormField, isKeyboardInScope } from '../internal/keyboard';
import { useEventCallback, useLatest } from '../internal/useLatest';
import { createZoomPanState, zoomPanReducer } from '../internal/zoomPanReducer';

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
    /** Sets the zoom, clamped to `[minScale, maxScale]`. */
    setScale: (scale: number) => void;
    resetZoom: () => void;
    setPan: (x: number, y: number) => void;
    getImageCoordinates: (clientX: number, clientY: number) => Point;
    zoomIn: () => void;
    zoomOut: () => void;
};

/**
 * Installs the hook on the container. Returns the detach cleanup, so it is usable directly as
 * a React 19 ref callback.
 *
 * The hook has to own the element rather than be handed a ref object: a ref object notifies
 * nobody, so every element-scoped listener attached once at mount against whatever happened to
 * be there and could never notice a container that arrived late or was replaced.
 */
export type ZoomPanAttach = (node: HTMLDivElement) => () => void;

export const useZoomPan = (
    contentSize: Point,
    options: ZoomPanOptions = {},
): [ZoomPanState, ZoomPanActions, ZoomPanAttach] => {
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

    // Written by `attach` below. Reading the element through a ref rather than taking it as a
    // value keeps `readRect`, `setPan` and `getImageCoordinates` on stable identities.
    const elementRef = useRef<HTMLDivElement | null>(null);

    const [internal, dispatch] = useReducer(zoomPanReducer, initialScale, createZoomPanState);

    // One mirror for the whole state, read by every event handler and observer below so their
    // effects can attach exactly once instead of closing over rendered values.
    const stateRef = useRef(internal);

    /**
     * The single write path. Runs the reducer eagerly against the mirror before dispatching,
     * because two actions in the same tick must each see the other's result — `flushPan` then
     * `stopPanning`, or `zoomIn` then `resetZoom` — and React does not apply a dispatch until
     * it re-renders.
     *
     * Notifications live here rather than in the reducer: React re-runs the reducer on an
     * eager bailout and again under StrictMode, so it has to stay pure.
     */
    const commit = useCallback(
        (action: ZoomPanAction) => {
            const previous = stateRef.current;
            const next = zoomPanReducer(previous, action);
            // The reducer returns the same object when nothing moved, which is the guard each
            // action used to repeat by hand. Bail before React even schedules a render.
            if (next === previous) return;

            stateRef.current = next;
            dispatch(action);

            if (next.transform.scale !== previous.transform.scale) notifyScaleChange(next.transform.scale);
            if (
                next.transform.translateX !== previous.transform.translateX ||
                next.transform.translateY !== previous.transform.translateY
            ) {
                notifyPanChange(next.transform.translateX, next.transform.translateY);
            }
        },
        [notifyScaleChange, notifyPanChange],
    );

    // Backstop only: `commit` has already written the mirror. This re-syncs it to whatever
    // React actually committed.
    useLayoutEffect(() => {
        stateRef.current = internal;
    });

    // Never rendered, so this is deliberately not state: as state it put every pan listener
    // back on the element on every single mousemove.
    const lastMousePositionRef = useRef<Point>({ x: 0, y: 0 });
    const releasePanCursorRef = useRef<(() => void) | undefined>(undefined);
    // Latest un-committed pointer position during a pan, and the frame scheduled to apply it.
    const pendingPanRef = useRef<Point | undefined>(undefined);
    const frameRef = useRef<number | undefined>(undefined);
    // `undefined` until the first successful fit, which is what makes that first fit unconditional.
    const lastContentSizeRef = useRef<Point | undefined>(undefined);

    /**
     * Maps a viewport point into image space against a rect the caller already holds.
     * `getBoundingClientRect` forces a layout read, so anything on a pointer or wheel path
     * should read the rect once and pass it here rather than going through
     * {@link getImageCoordinates}.
     */
    const toImageCoordinatesWithRect = useCallback(
        (clientX: number, clientY: number, rect: DOMRect): Point => {
            const { transform, baseScale } = stateRef.current;
            return toImageCoordinates(clientX, clientY, rect, contentSize, transform, baseScale);
        },
        [contentSize],
    );

    // The container rect is read on every pointer move, but only changes on scroll, resize
    // or a layout shift. Cache it and invalidate on those, rather than forcing a layout read
    // per event.
    const cachedRectRef = useRef<DOMRect | undefined>(undefined);

    const readRect = useCallback((): DOMRect | undefined => {
        const container = elementRef.current;
        if (!container) return undefined;

        cachedRectRef.current ??= container.getBoundingClientRect();
        return cachedRectRef.current;
    }, []);

    const invalidateRect = useCallback(() => {
        cachedRectRef.current = undefined;
    }, []);

    useEffect(() => {
        // Capture phase: a scroll in any ancestor moves the container, and scroll events
        // from a nested element do not bubble.
        window.addEventListener('scroll', invalidateRect, true);
        window.addEventListener('resize', invalidateRect);

        return () => {
            window.removeEventListener('scroll', invalidateRect, true);
            window.removeEventListener('resize', invalidateRect);
        };
    }, [invalidateRect]);

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
        const container = elementRef.current;
        if (!container || contentSize.x === 0 || contentSize.y === 0) return;

        lastContentSizeRef.current = { ...contentSize };

        // Once: each call forces a style recalc via `getComputedStyle`.
        commit({ type: 'fit', baseScale: calculateBaseScale(container, contentSize) });
    }, [contentSize, commit]);

    const recalculateRef = useLatest(recalculateBaseScaleAndCenter);

    useLayoutEffect(() => {
        if (!elementRef.current || contentSize.x === 0 || contentSize.y === 0) return;

        const last = lastContentSizeRef.current;
        const moved =
            !last ||
            Math.abs(last.x - contentSize.x) > REFIT_THRESHOLD ||
            Math.abs(last.y - contentSize.y) > REFIT_THRESHOLD;

        if (moved) recalculateBaseScaleAndCenter();
    }, [contentSize, recalculateBaseScaleAndCenter]);

    /** Zooms so the content under the cursor stays under the cursor. */
    const zoomToPoint = useCallback(
        (newScale: number, pointX: number, pointY: number, rect: DOMRect) => {
            const under = toImageCoordinatesWithRect(rect.left + pointX, rect.top + pointY, rect);

            const cursorOffsetX = pointX - rect.width / 2;
            const cursorOffsetY = pointY - rect.height / 2;
            const newCombinedScale = stateRef.current.baseScale * newScale;

            const translateX = -((under.x - contentSize.x / 2) * newCombinedScale - cursorOffsetX) / newCombinedScale;
            const translateY = -((under.y - contentSize.y / 2) * newCombinedScale - cursorOffsetY) / newCombinedScale;

            commit({ type: 'zoomToPoint', scale: newScale, translateX, translateY });
        },
        [contentSize, toImageCoordinatesWithRect, commit],
    );

    const zoomToPointRef = useLatest(zoomToPoint);
    const keyboardScopeRef = useLatest(keyboardScope);

    // Read through a ref so changing any of them does not re-register the listener, which
    // would mean detaching and reattaching the container.
    const wheelConfigRef = useLatest({ enableWheelZoom, minScale, maxScale });

    const handleWheel = useCallback(
        (e: WheelEvent) => {
            const { enableWheelZoom: enabled, minScale: min, maxScale: max } = wheelConfigRef.current;
            if (!enabled) return;

            // A plain wheel belongs to the brush-size handler.
            if (!e.ctrlKey && !e.metaKey) return;
            e.preventDefault();

            const rect = readRect();
            if (!rect) return;

            const current = stateRef.current.transform.scale;
            const newScale = Math.max(min, Math.min(max, current - e.deltaY * 0.01));

            if (newScale !== current) {
                zoomToPointRef.current(newScale, e.clientX - rect.left, e.clientY - rect.top, rect);
            }
        },
        [readRect],
    );

    const setScale = useCallback(
        (next: number) => {
            commit({ type: 'scale', scale: Math.max(minScale, Math.min(maxScale, next)) });
        },
        [minScale, maxScale, commit],
    );

    const stepZoom = useCallback(
        (delta: number) => {
            setScale(stateRef.current.transform.scale + delta);
        },
        [setScale],
    );

    const zoomIn = useCallback(() => stepZoom(ZOOM_STEP), [stepZoom]);
    const zoomOut = useCallback(() => stepZoom(-ZOOM_STEP), [stepZoom]);

    const resetZoom = useCallback(() => commit({ type: 'reset' }), [commit]);

    const setPan = useCallback(
        (x: number, y: number) => {
            const constrained = clampPan(x, y, contentSize, constrainPan && Boolean(elementRef.current));
            commit({ type: 'pan', translateX: constrained.x, translateY: constrained.y });
        },
        [contentSize, constrainPan, commit],
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
            if (!isKeyboardInScope(keyboardScopeRef.current, elementRef.current)) return;

            // Space only grabs the pan cursor once there is something to pan.
            if (e.code === 'Space' && stateRef.current.transform.scale > 1) {
                e.preventDefault();
                commit({ type: 'spaceKey', value: true });
            }

            if (e.ctrlKey || e.metaKey) commit({ type: 'zoomKey', value: true });
        };

        const handleKeyUp = (e: KeyboardEvent) => {
            if (e.code === 'Space') {
                e.preventDefault();
                commit({ type: 'spaceKey', value: false });
                commit({ type: 'panning', value: false });
            }

            if (!e.ctrlKey && !e.metaKey) commit({ type: 'zoomKey', value: false });
        };

        const handleBlur = () => {
            commit({ type: 'blur' });
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
    }, [commit, releasePanCursor]);

    const setPanRef = useLatest(setPan);

    const handlePanMouseDown = useCallback(
        (e: MouseEvent) => {
            // Nothing to pan at fit-to-container. Checked here rather than around the listener
            // so a zoom crossing 1 does not re-register anything on the element.
            const { transform, isSpaceKeyDown } = stateRef.current;
            if (transform.scale <= 1) return;

            // Middle button, or left button with space held.
            if (e.button !== 1 && !(e.button === 0 && isSpaceKeyDown)) return;

            e.preventDefault();
            lastMousePositionRef.current = { x: e.clientX, y: e.clientY };
            releasePanCursorRef.current = acquireBodyPanCursor();
            commit({ type: 'panning', value: true });
        },
        [commit],
    );

    // Pointer devices deliver moves well above display refresh, and every commit here is
    // a React state update plus a full re-render of the editor. Coalescing to one commit
    // per frame drops the redundant renders; the delta is measured from the position at
    // the last commit, so no movement is lost.
    //
    // Only the pan commit is coalesced. The mask-painting path deliberately still paints
    // per event: one dab per frame would leave visible gaps in a fast stroke.
    const flushPan = useCallback(() => {
        frameRef.current = undefined;

        const pending = pendingPanRef.current;
        if (!pending || !stateRef.current.isPanning) return;
        pendingPanRef.current = undefined;

        const last = lastMousePositionRef.current;
        const current = stateRef.current.transform;
        const deltaX = (pending.x - last.x) / current.scale;
        const deltaY = (pending.y - last.y) / current.scale;

        setPanRef.current(current.translateX + deltaX, current.translateY + deltaY);
        lastMousePositionRef.current = pending;
    }, []);

    const handlePanMouseMove = useCallback(
        (e: MouseEvent) => {
            if (!stateRef.current.isPanning) return;
            e.preventDefault();

            pendingPanRef.current = { x: e.clientX, y: e.clientY };
            frameRef.current ??= requestAnimationFrame(flushPan);
        },
        [flushPan],
    );

    const stopPanning = useCallback(() => {
        if (!stateRef.current.isPanning) return;
        // Land the last move rather than dropping it on the floor.
        flushPan();
        commit({ type: 'panning', value: false });
        releasePanCursor();
    }, [flushPan, commit, releasePanCursor]);

    // Window-scoped, so they belong to the hook's lifetime rather than the element's. The
    // pending frame is hook state too, which is why its cleanup lives here.
    useEffect(() => {
        window.addEventListener('mousemove', handlePanMouseMove);
        window.addEventListener('mouseup', stopPanning);

        return () => {
            window.removeEventListener('mousemove', handlePanMouseMove);
            window.removeEventListener('mouseup', stopPanning);

            if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
            frameRef.current = undefined;
            pendingPanRef.current = undefined;
        };
    }, [handlePanMouseMove, stopPanning]);

    /**
     * Everything that has to be bound to the container itself.
     *
     * Stable, so React attaches once and detaches only when the element really goes away.
     * Anything unstable reachable from here would make React tear the element's wiring down
     * and rebuild it on every render, re-running the ResizeObserver's initial fit each time.
     */
    const attach = useCallback<ZoomPanAttach>(
        (node) => {
            elementRef.current = node;

            // A brand new element invalidates everything measured against the old one, and the
            // fit has to happen here: React attaches refs before layout effects, so this is the
            // earliest point the container's real size is knowable.
            cachedRectRef.current = undefined;
            lastContentSizeRef.current = undefined;
            recalculateRef.current();

            // Read through the ref: closing over `recalculate` directly meant that after the
            // first resize the observer kept re-fitting to the *original* content size.
            const observer = new ResizeObserver(() => {
                cachedRectRef.current = undefined;
                lastContentSizeRef.current = undefined;
                recalculateRef.current();
            });
            observer.observe(node);

            // The pointer entering is the gesture boundary: it bounds how long a cached rect can
            // survive, so a layout shift that moved the container without resizing it — which
            // neither the ResizeObserver nor a scroll would catch — cannot go unnoticed across
            // two separate interactions.
            node.addEventListener('mouseenter', invalidateRect);
            node.addEventListener('wheel', handleWheel, { passive: false });
            node.addEventListener('mousedown', handlePanMouseDown);
            node.addEventListener('mouseleave', stopPanning);

            return () => {
                // Losing the element mid-pan must not strand the page on `cursor: grabbing`.
                stopPanning();

                observer.disconnect();
                node.removeEventListener('mouseenter', invalidateRect);
                node.removeEventListener('wheel', handleWheel);
                node.removeEventListener('mousedown', handlePanMouseDown);
                node.removeEventListener('mouseleave', stopPanning);

                cachedRectRef.current = undefined;
                elementRef.current = null;
            };
        },
        [invalidateRect, handleWheel, handlePanMouseDown, stopPanning],
    );

    const state = useMemo<ZoomPanState>(
        () => ({
            scale: internal.transform.scale,
            transform: internal.transform,
            baseScale: internal.baseScale,
            effectiveScale: internal.baseScale * internal.transform.scale,
            isPanning: internal.isPanning,
            isSpaceKeyDown: internal.isSpaceKeyDown,
            isZoomKeyDown: internal.isZoomKeyDown,
        }),
        [internal],
    );

    const actions = useMemo<ZoomPanActions>(
        () => ({ setScale, resetZoom, setPan, getImageCoordinates, zoomIn, zoomOut }),
        [setScale, resetZoom, setPan, getImageCoordinates, zoomIn, zoomOut],
    );

    // No memo around the tuple: it is destructured at the call site, so its identity is
    // never observed.
    return [state, actions, attach];
};
