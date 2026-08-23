import { vi } from 'vitest';

/**
 * vitest-canvas-mock records calls but never rasterizes: `getImageData` always returns a
 * zeroed buffer and `toDataURL` a fixed stub. Testing `toMask` through it would therefore
 * pass vacuously. This builds a canvas whose pixel buffer we control, and which snapshots
 * that buffer at the moment `toDataURL` is called, so we can assert both the binarized
 * output and the restoration afterwards.
 */
export function makeSeededCanvas(width: number, height: number, pixels: number[]) {
    const imageData = {
        data: Uint8ClampedArray.from(pixels),
        width,
        height,
        colorSpace: 'srgb',
    } as ImageData;

    /** Buffer contents captured each time the canvas was exported. */
    const snapshots: number[][] = [];

    const ctx = {
        getImageData: vi.fn(() => imageData),
        putImageData: vi.fn(),
    };

    const canvas = {
        width,
        height,
        getContext: vi.fn(() => ctx),
        toDataURL: vi.fn(() => {
            snapshots.push([...imageData.data]);
            return 'data:image/png;base64,STUB';
        }),
    } as unknown as HTMLCanvasElement;

    return { canvas, ctx, imageData, snapshots };
}

/**
 * The three layers of a rendered `MaskEditor`, by class name rather than document order —
 * an index-based lookup breaks silently the day a fourth layer is added.
 */
export function canvases(root: HTMLElement): {
    base: HTMLCanvasElement;
    mask: HTMLCanvasElement;
    cursor: HTMLCanvasElement;
} {
    return {
        base: root.querySelector('.react-mask-editor-base-canvas') as HTMLCanvasElement,
        mask: root.querySelector('.react-mask-editor-mask-canvas') as HTMLCanvasElement,
        cursor: root.querySelector('.react-mask-editor-cursor-canvas') as HTMLCanvasElement,
    };
}
