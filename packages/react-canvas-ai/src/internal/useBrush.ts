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
};

/**
 * Builds the brush-outline painter. Stable across renders — the appearance inputs are read
 * through refs so the pointer listeners below never need re-attaching when a colour changes.
 */
export const useCursorPainter = (
    cursorContext: CanvasRenderingContext2D | undefined,
    options: CursorPainterOptions,
): PaintCursor => {
    const optionsRef = useLatest(options);

    return useCallback(
        (x, y, radius) => {
            if (!cursorContext) return;

            const { size, maskColor, maskOpacity } = optionsRef.current;
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
    paintDab: (x: number, y: number, evt: Pick<MouseEvent, 'buttons' | 'shiftKey'>) => void;
};

/** Tracks the pointer over the cursor layer, painting the mask while a button is held. */
export const useBrushCursor = (
    cursorCanvasRef: RefObject<HTMLCanvasElement | null>,
    options: BrushCursorOptions,
): void => {
    const optionsRef = useLatest(options);

    useEffect(() => {
        const cursorCanvas = cursorCanvasRef.current;
        if (!cursorCanvas) return;

        const handleMouseMove = (evt: MouseEvent) => {
            const { paintCursor, getImageCoordinates, cursorSizeRef, isPanning, isSpaceKeyDown, paintDab } =
                optionsRef.current;
            if (isPanning) return;

            const { x, y } = getImageCoordinates(evt.clientX, evt.clientY);
            paintCursor(x, y, cursorSizeRef.current);

            if (evt.buttons > 0 && !isSpaceKeyDown) paintDab(x, y, evt);
        };

        cursorCanvas.addEventListener('mousemove', handleMouseMove);
        return () => cursorCanvas.removeEventListener('mousemove', handleMouseMove);
    }, [cursorCanvasRef]);
};

export type BrushSizeWheelOptions = {
    /** Wheel resizing is only wired up when the consumer asked to hear about it. */
    enabled: boolean;
    paintCursor: PaintCursor;
    getImageCoordinates: (clientX: number, clientY: number) => Point;
    cursorSizeRef: RefObject<number>;
    setCursorSize: (size: number) => void;
    onCursorSizeChange: (size: number) => void;
};

/** Resizes the brush on a plain wheel. Ctrl/meta is the zoom gesture and is left alone. */
export const useBrushSizeWheel = (
    cursorCanvasRef: RefObject<HTMLCanvasElement | null>,
    options: BrushSizeWheelOptions,
): void => {
    const optionsRef = useLatest(options);
    const { enabled } = options;

    useEffect(() => {
        const cursorCanvas = cursorCanvasRef.current;
        if (!enabled || !cursorCanvas) return;

        const handleWheel = (evt: WheelEvent) => {
            if (evt.ctrlKey || evt.metaKey) return;

            const { paintCursor, getImageCoordinates, cursorSizeRef, setCursorSize, onCursorSizeChange } =
                optionsRef.current;

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
    }, [cursorCanvasRef, enabled]);
};
