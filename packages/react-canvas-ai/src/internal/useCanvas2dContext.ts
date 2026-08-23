import type { RefObject } from 'react';
import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Acquires the 2D context for a canvas once it has mounted, as state so consumers re-render
 * when it becomes available.
 *
 * `willReadFrequently` belongs only on a canvas we actually read back: it opts the surface
 * out of GPU-backed rendering onto the software rasterizer, which is a real cost on a layer
 * that is repainted per pointer move.
 */
export const useCanvas2dContext = (
    ref: RefObject<HTMLCanvasElement | null>,
    options?: CanvasRenderingContext2DSettings,
): CanvasRenderingContext2D | undefined => {
    const [context, setContext] = useState<CanvasRenderingContext2D | undefined>(undefined);
    const optionsRef = useRef(options);

    useLayoutEffect(() => {
        if (ref.current && !context) setContext(ref.current.getContext('2d', optionsRef.current) ?? undefined);
    }, [ref, context]);

    return context;
};
