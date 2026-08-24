import { useMemo, useRef } from 'react';

/**
 * Acquires the 2D context for a canvas, re-acquiring it whenever the element changes.
 *
 * Keyed on the element rather than a ref, so a canvas that mounts conditionally or is
 * remounted still gets a context — the previous version acquired one at most once and would
 * otherwise keep handing out a context bound to a detached element.
 *
 * `getContext` is safe to call during render: it returns the same context object for the same
 * canvas, so a discarded memo or a StrictMode double-render costs nothing.
 *
 * `willReadFrequently` belongs only on a canvas we actually read back: it opts the surface
 * out of GPU-backed rendering onto the software rasterizer, which is a real cost on a layer
 * that is repainted per pointer move.
 */
export const useCanvas2dContext = (
    canvas: HTMLCanvasElement | undefined,
    options?: CanvasRenderingContext2DSettings,
): CanvasRenderingContext2D | undefined => {
    // Only ever read on first acquisition, so the caller is free to pass a fresh literal.
    const optionsRef = useRef(options);

    return useMemo(() => canvas?.getContext('2d', optionsRef.current) ?? undefined, [canvas]);
};
