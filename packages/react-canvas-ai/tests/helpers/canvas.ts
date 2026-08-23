import { vi } from 'vitest';

/**
 * vitest-canvas-mock records calls but never rasterizes: `getImageData` always returns a
 * zeroed buffer and `toDataURL` a fixed stub. Testing `toMask` through it would therefore
 * pass vacuously. This builds a canvas whose pixel buffer we control.
 *
 * `getImageData` hands back a fresh copy each call, as a real canvas does — the returned
 * buffer is a snapshot, not a view, so writing to it must not touch the source. `pixels`
 * stays readable through `sourcePixels()` so a test can prove exactly that.
 */
export const makeSeededCanvas = (width: number, height: number, pixels: number[]) => {
    const source = Uint8ClampedArray.from(pixels);

    const ctx = {
        getImageData: vi.fn(
            () =>
                ({
                    data: Uint8ClampedArray.from(source),
                    width,
                    height,
                    colorSpace: 'srgb',
                }) as ImageData,
        ),
        putImageData: vi.fn(),
    };

    const canvas = {
        width,
        height,
        getContext: vi.fn(() => ctx),
        toDataURL: vi.fn(() => 'data:image/png;base64,SOURCE'),
    } as unknown as HTMLCanvasElement;

    return { canvas, ctx, sourcePixels: () => [...source] };
};

/**
 * Intercepts the off-screen canvas `toMask` builds to threshold into, so a test can read
 * the pixels that were actually exported. Returns a restore function.
 */
export const captureScratchCanvas = () => {
    const exported: number[][] = [];
    const original = document.createElement.bind(document);

    const scratchCtx = {
        putImageData: vi.fn((imageData: ImageData) => {
            exported.push([...imageData.data]);
        }),
    };

    const spy = vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
        if (tag !== 'canvas') return original(tag);
        return {
            width: 0,
            height: 0,
            getContext: vi.fn(() => scratchCtx),
            toDataURL: vi.fn(() => 'data:image/png;base64,SCRATCH'),
        } as unknown as HTMLCanvasElement;
    }) as typeof document.createElement);

    return { exported, scratchCtx, restore: () => spy.mockRestore() };
};

/**
 * The three layers of a rendered `MaskEditor`, by class name rather than document order —
 * an index-based lookup breaks silently the day a fourth layer is added.
 */
export const canvases = (
    root: HTMLElement,
): {
    base: HTMLCanvasElement;
    mask: HTMLCanvasElement;
    cursor: HTMLCanvasElement;
} => {
    return {
        base: root.querySelector('.react-mask-editor-base-canvas') as HTMLCanvasElement,
        mask: root.querySelector('.react-mask-editor-mask-canvas') as HTMLCanvasElement,
        cursor: root.querySelector('.react-mask-editor-cursor-canvas') as HTMLCanvasElement,
    };
};
