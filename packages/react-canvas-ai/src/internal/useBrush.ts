import type { RefObject } from 'react';
import { useCallback, useEffect } from 'react';
import type { Point } from './geometry';
import { drawCursorCircle } from './canvas';
import { useLatest } from './useLatest';

/** The brush outline sits slightly above the mask opacity so it stays visible over it. */
const CURSOR_OPACITY_BOOST = 0.1;

/** Repaints the cursor layer with the brush outline at a point, in image coordinates. */
export type PaintCursor = (x: number, y: number, radius: number) => void;

export type CursorPainterOptions = {
    size: Point;
    maskColor: string;
    maskOpacity: number;
    /** Whether the current mode uses the brush. An inactive brush paints nothing. */
    active: boolean;
};

/**
 * Builds the brush-outline painter, and owns the outline's whole lifetime: it paints while the
 * brush is active and clears the layer when it stops being active. Keeping the clear here
 * rather than in the editor is what lets a mode without a brush be declared rather than
 * special-cased — otherwise the circle painted before the switch sits on the layer until the
 * next paint-mode move.
 *
 * The painter itself is stable across renders — the appearance inputs are read through refs so
 * the pointer listeners below never need re-attaching when a colour changes.
 */
export const useCursorPainter = (
    cursorContext: CanvasRenderingContext2D | undefined,
    options: CursorPainterOptions,
): PaintCursor => {
    const optionsRef = useLatest(options);
    const { active } = options;

    useEffect(() => {
        if (active || !cursorContext) return;
        cursorContext.clearRect(0, 0, cursorContext.canvas.width, cursorContext.canvas.height);
    }, [active, cursorContext]);

    return useCallback(
        (x, y, radius) => {
            if (!cursorContext) return;

            const { size, maskColor, maskOpacity, active: isActive } = optionsRef.current;
            if (!isActive) return;

            drawCursorCircle(cursorContext, {
                size,
                x,
                y,
                radius,
                color: maskColor,
                opacity: maskOpacity + CURSOR_OPACITY_BOOST,
            });
        },
        [cursorContext],
    );
};

export type BrushCursorOptions = {
    paintCursor: PaintCursor;
    getImageCoordinates: (clientX: number, clientY: number) => Point;
    /** Shared with {@link useBrushSizeWheel}, which writes it eagerly. */
    cursorSizeRef: RefObject<number>;
    isPanning: boolean;
    isSpaceKeyDown: boolean;
    /**
     * Whether the active mode uses the brush. A capability rather than the mode itself, so a
     * new mode declares what it does instead of being enumerated here; a ref rather than the
     * value, so mode flips never re-attach the native listener.
     */
    isBrushActiveRef: RefObject<boolean>;
    paintDab: (x: number, y: number, evt: Pick<MouseEvent, 'buttons' | 'shiftKey'>) => void;
};

/**
 * Tracks the pointer over the cursor layer, painting the mask while a button is held.
 *
 * Keyed on the element, so a cursor layer that mounts conditionally still gets its listener —
 * keyed on a ref object this attached once at mount and never noticed a later arrival.
 *
 * `pointermove` rather than `mousemove`, for `getCoalescedEvents`: the browser merges several
 * real pointer positions into each delivered move event, and reading only the last one throws
 * away the shape of a fast stroke — most visibly on a loaded CPU, where the merging is heaviest.
 * Every buffered sample is replayed in order so the stroke follows the path the hand actually
 * took rather than the chord between two frames.
 */
export const useBrushCursor = (cursorCanvas: HTMLCanvasElement | undefined, options: BrushCursorOptions): void => {
    const optionsRef = useLatest(options);

    useEffect(() => {
        if (!cursorCanvas) return;

        const handlePointerMove = (evt: PointerEvent) => {
            const {
                paintCursor,
                getImageCoordinates,
                cursorSizeRef,
                isPanning,
                isSpaceKeyDown,
                isBrushActiveRef,
                paintDab,
            } = optionsRef.current;

            // Mouse only, so touch and stylus keep behaving exactly as they did under
            // `mousemove`. Painting with a finger is a separate feature: it needs its own
            // `touch-action` on the layer, or a drag meant to scroll the page paints instead.
            if (evt.pointerType !== 'mouse') return;
            if (isPanning) return;

            // A mode without a brush leaves the pointer alone entirely: no outline, no dabs.
            if (!isBrushActiveRef.current) return;

            const { x, y } = getImageCoordinates(evt.clientX, evt.clientY);

            // Once, from the final position: the outline is a transient overlay that clears
            // itself on every paint, so drawing it per sample would only overdraw.
            paintCursor(x, y, cursorSizeRef.current);

            if (evt.buttons === 0 || isSpaceKeyDown) return;

            // Optional call, not optional chaining for tidiness: iOS Safari omits the method
            // in some contexts, and the event itself is the one sample we know we have.
            const samples = evt.getCoalescedEvents?.() ?? [];

            if (samples.length === 0) {
                paintDab(x, y, evt);
                return;
            }

            // In order, and each through `getImageCoordinates`: the samples carry viewport
            // coordinates, and the mask is painted in image space. The gesture is read off the
            // delivered event rather than each sample, so a shift pressed part-way through a
            // buffered batch splits the stroke once, at the batch, instead of mid-batch.
            for (const sample of samples) {
                const point = getImageCoordinates(sample.clientX, sample.clientY);
                paintDab(point.x, point.y, evt);
            }
        };

        cursorCanvas.addEventListener('pointermove', handlePointerMove);
        return () => cursorCanvas.removeEventListener('pointermove', handlePointerMove);
    }, [cursorCanvas]);
};

export type BrushSizeWheelOptions = {
    /** Wheel resizing is only wired up when the consumer asked to hear about it. */
    enabled: boolean;
    paintCursor: PaintCursor;
    getImageCoordinates: (clientX: number, clientY: number) => Point;
    cursorSizeRef: RefObject<number>;
    /** See {@link BrushCursorOptions.isBrushActiveRef}. */
    isBrushActiveRef: RefObject<boolean>;
    setCursorSize: (size: number) => void;
    onCursorSizeChange: (size: number) => void;
};

/** Resizes the brush on a plain wheel. Ctrl/meta is the zoom gesture and is left alone. */
export const useBrushSizeWheel = (
    cursorCanvas: HTMLCanvasElement | undefined,
    options: BrushSizeWheelOptions,
): void => {
    const optionsRef = useLatest(options);

    useEffect(() => {
        if (!cursorCanvas) return;

        const handleWheel = (evt: WheelEvent) => {
            const {
                enabled,
                paintCursor,
                getImageCoordinates,
                cursorSizeRef,
                isBrushActiveRef,
                setCursorSize,
                onCursorSizeChange,
            } = optionsRef.current;

            // Gated here rather than around the listener, so toggling the prop does not
            // detach and reattach. Returning before `preventDefault` leaves the event to
            // propagate exactly as it did when no listener was registered at all.
            if (!enabled) return;
            if (evt.ctrlKey || evt.metaKey) return;

            // No brush in this mode: resizing it would be an invisible state mutation the
            // user only discovers back in a mode that paints.
            if (!isBrushActiveRef.current) return;

            const { x, y } = getImageCoordinates(evt.clientX, evt.clientY);
            const newSize = Math.max(1, cursorSizeRef.current + (evt.deltaY > 0 ? -1 : 1));

            // Written eagerly so a move landing before React commits already paints the new
            // size, and so a second wheel tick in the same tick sees the first.
            cursorSizeRef.current = newSize;
            setCursorSize(newSize);
            onCursorSizeChange(newSize);
            paintCursor(x, y, newSize);

            evt.stopPropagation();
            evt.preventDefault();
        };

        cursorCanvas.addEventListener('wheel', handleWheel, { passive: false });
        return () => cursorCanvas.removeEventListener('wheel', handleWheel);
    }, [cursorCanvas]);
};
