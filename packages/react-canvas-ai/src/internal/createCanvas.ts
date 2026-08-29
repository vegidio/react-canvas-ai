/**
 * Returns an `OffscreenCanvas` when available, falling back to a detached element. The SAM
 * pre/postprocess scratch surfaces never need to be in the DOM, and `OffscreenCanvas` avoids
 * the layout bookkeeping a detached element still carries.
 */
export type ScratchCanvas = HTMLCanvasElement | OffscreenCanvas;

export const createCanvas = (width: number, height: number): ScratchCanvas => {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
};
