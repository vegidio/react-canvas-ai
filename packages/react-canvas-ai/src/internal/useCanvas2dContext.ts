import React from 'react';

/**
 * Acquires the 2D context for a canvas once it has mounted, as state so consumers re-render
 * when it becomes available.
 *
 * `willReadFrequently` belongs only on a canvas we actually read back: it opts the surface
 * out of GPU-backed rendering onto the software rasterizer, which is a real cost on a layer
 * that is repainted per pointer move.
 */
export function useCanvas2dContext(
    ref: React.RefObject<HTMLCanvasElement | null>,
    options?: CanvasRenderingContext2DSettings,
): CanvasRenderingContext2D | null {
    const [context, setContext] = React.useState<CanvasRenderingContext2D | null>(null);
    const optionsRef = React.useRef(options);

    React.useLayoutEffect(() => {
        if (ref.current && !context) setContext(ref.current.getContext('2d', optionsRef.current));
    }, [ref, context]);

    return context;
}
