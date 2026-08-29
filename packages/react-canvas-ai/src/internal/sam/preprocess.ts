import type { Point } from '../geometry';
import { createCanvas } from './createCanvas';

/** The square input frame SAM's vision encoder expects. */
export const SAM_INPUT_SIZE = 1024;

// The ImageNet channel statistics SlimSAM was trained with, in RGB order.
const MEAN = [123.675, 116.28, 103.53] as const;
const STD = [58.395, 57.12, 57.375] as const;

export type PreprocessedImage = {
    /** Float32 tensor data, CHW layout (3 × 1024 × 1024). */
    data: Float32Array;
    /** Tensor dims: `[1, 3, 1024, 1024]`. */
    dims: readonly [number, number, number, number];
    /** Size of the image after resize, before padding, `[width, height]`. */
    resizedSize: [number, number];
};

/**
 * Normalizes RGBA pixels of the padded 1024×1024 frame into a CHW float tensor. Pure so the
 * per-channel arithmetic is testable without a canvas.
 */
export const normalizeToTensor = (pixels: Uint8ClampedArray): Float32Array => {
    const plane = SAM_INPUT_SIZE * SAM_INPUT_SIZE;
    const data = new Float32Array(3 * plane);

    for (let i = 0, offset = 0; i < plane; i += 1, offset += 4) {
        data[i] = (pixels[offset] - MEAN[0]) / STD[0];
        data[plane + i] = (pixels[offset + 1] - MEAN[1]) / STD[1];
        data[2 * plane + i] = (pixels[offset + 2] - MEAN[2]) / STD[2];
    }

    return data;
};

/**
 * Zeroes the letterbox padding in a CHW tensor, in place.
 *
 * The reference SAM pipeline pads with the pixel mean *before* normalization, which is zero
 * after it. Normalizing the transparent padding like image content instead — which is what the
 * plugin this was ported from did — shifted it to ≈ −2.1 per channel, feeding the encoder a
 * dark band it treated as part of the scene.
 */
export const zeroPadding = (data: Float32Array, resizedW: number, resizedH: number): void => {
    const plane = SAM_INPUT_SIZE * SAM_INPUT_SIZE;

    for (let channel = 0; channel < 3; channel += 1) {
        const base = channel * plane;

        for (let y = 0; y < SAM_INPUT_SIZE; y += 1) {
            const row = base + y * SAM_INPUT_SIZE;
            // Rows below the resized image are all padding; rows inside it pad from the right edge.
            const startX = y < resizedH ? resizedW : 0;
            if (startX < SAM_INPUT_SIZE) data.fill(0, row + startX, row + SAM_INPUT_SIZE);
        }
    }
};

/**
 * Letterboxes the decoded image into the 1024×1024 input frame and normalizes it into the
 * encoder's tensor layout.
 *
 * Takes the editor's already-decoded element directly: the plugin this was ported from accepted
 * a URL and re-fetched and re-decoded the image with a hard-coded `crossOrigin='anonymous'` —
 * a second download, and a CORS policy the host does not necessarily share. The editor's loader
 * already routed the source through a blob URL, so this element is guaranteed readable.
 */
export const imageToEncoderInput = (image: HTMLImageElement): PreprocessedImage => {
    const origW = image.width || image.naturalWidth;
    const origH = image.height || image.naturalHeight;

    const scale = SAM_INPUT_SIZE / Math.max(origW, origH);
    const resizedW = Math.max(1, Math.round(origW * scale));
    const resizedH = Math.max(1, Math.round(origH * scale));

    const canvas = createCanvas(SAM_INPUT_SIZE, SAM_INPUT_SIZE);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to acquire a 2D context for SAM preprocessing.');

    ctx.drawImage(image, 0, 0, resizedW, resizedH);
    const pixels = ctx.getImageData(0, 0, SAM_INPUT_SIZE, SAM_INPUT_SIZE).data;

    const data = normalizeToTensor(pixels);
    zeroPadding(data, resizedW, resizedH);

    return { data, dims: [1, 3, SAM_INPUT_SIZE, SAM_INPUT_SIZE], resizedSize: [resizedW, resizedH] };
};

/**
 * Maps a point in editor-canvas pixels to the 1024-padded input frame the decoder prompts in.
 *
 * Normalized by the canvas size, not the bitmap's natural size: the editor fits large images
 * down to `maxWidth`/`maxHeight`, so clicks arrive in canvas pixels. Dividing by the natural
 * size — which is what the plugin this was ported from did — landed the prompt short of the
 * cursor by exactly the fit ratio.
 */
export const imagePointToInputSpace = (
    point: Point,
    target: Point,
    resizedSize: readonly [number, number],
): [number, number] => {
    return [(point.x / target.x) * resizedSize[0], (point.y / target.y) * resizedSize[1]];
};
