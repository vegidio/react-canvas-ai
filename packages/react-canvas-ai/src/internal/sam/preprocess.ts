import type { Point } from '../geometry';
import { createCanvas } from '../createCanvas';

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
 * Normalizes the `width` × `height` RGBA pixels of the resized image into the encoder's CHW
 * float tensor, scattered into the top-left of the 1024×1024 frame with a `SAM_INPUT_SIZE`
 * row stride. Pure so the per-channel arithmetic is testable without a canvas.
 *
 * The letterbox padding is left at the `Float32Array`'s own zero fill, which is what the
 * reference SAM pipeline produces: it pads with the pixel mean *before* normalization, and
 * that is zero after it. Normalizing the padding like image content and zeroing it in a
 * second pass — which is what this used to do — walked the padding region twice, and
 * normalizing it like image content without that second pass shifts it to ≈ −2.1 per
 * channel, feeding the encoder a dark band it treats as part of the scene.
 */
export const normalizeToTensor = (pixels: Uint8ClampedArray, width: number, height: number): Float32Array => {
    const plane = SAM_INPUT_SIZE * SAM_INPUT_SIZE;
    const data = new Float32Array(3 * plane);

    for (let y = 0; y < height; y += 1) {
        const rowStart = y * SAM_INPUT_SIZE;
        let offset = y * width * 4;

        for (let x = 0; x < width; x += 1, offset += 4) {
            const i = rowStart + x;
            data[i] = (pixels[offset] - MEAN[0]) / STD[0];
            data[plane + i] = (pixels[offset + 1] - MEAN[1]) / STD[1];
            data[2 * plane + i] = (pixels[offset + 2] - MEAN[2]) / STD[2];
        }
    }

    return data;
};

/**
 * Letterboxes the decoded image into the 1024×1024 input frame and normalizes it into the
 * encoder's tensor layout.
 *
 * The scratch canvas is the size of the *resized* image, not the padded frame: the padding
 * carries no information, so drawing, reading back and normalizing it was work whose only
 * result was overwritten with zeroes.
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

    const canvas = createCanvas(resizedW, resizedH);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to acquire a 2D context for SAM preprocessing.');

    ctx.drawImage(image, 0, 0, resizedW, resizedH);
    const pixels = ctx.getImageData(0, 0, resizedW, resizedH).data;

    const data = normalizeToTensor(pixels, resizedW, resizedH);

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
