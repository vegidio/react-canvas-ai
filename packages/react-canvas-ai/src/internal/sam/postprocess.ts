import type { BoundingBox } from '../../hooks/useAutoSelect';
import { createCanvas } from './createCanvas';
import { SAM_INPUT_SIZE } from './preprocess';

/** Positive logits are the object; the model's own decision boundary, not a tunable. */
const LOGIT_THRESHOLD = 0;

/** Alpha at or above this counts as covered when scanning for the bounding box. */
const BBOX_ALPHA_THRESHOLD = 128;

/**
 * Thresholds low-res mask logits into an alpha-only `ImageData`. Pure so the thresholding is
 * testable without a canvas; RGB stays zero because the editor tints the silhouette itself.
 */
export const logitsToAlpha = (logits: Float32Array, width: number, height: number): ImageData => {
    const image = new ImageData(width, height);

    for (let i = 0; i < width * height; i += 1) {
        image.data[i * 4 + 3] = logits[i] > LOGIT_THRESHOLD ? 255 : 0;
    }

    return image;
};

/**
 * Scans an alpha silhouette for its bounding box. A zero-sized box means the mask is empty.
 */
export const alphaBoundingBox = (mask: ImageData): BoundingBox => {
    const { data, width, height } = mask;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    for (let i = 3, p = 0; i < data.length; i += 4, p += 1) {
        if (data[i] >= BBOX_ALPHA_THRESHOLD) {
            const x = p % width;
            const y = (p / width) | 0;

            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
        }
    }

    if (maxX < 0) return { x: 0, y: 0, width: 0, height: 0 };
    return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
};

/**
 * Converts SAM's low-res mask logits (256×256 representing the 1024×1024 padded input frame)
 * into a full-resolution alpha-only `ImageData` at the editor canvas's dimensions.
 *
 * The low-res mask covers the *padded* frame, so only the top-left subregion corresponding to
 * the unpadded, resized image is sampled, then stretched to the target dimensions. Without
 * this, the padding on the right/bottom of non-square images leaks into the output.
 */
export const logitsToMask = (
    logits: Float32Array,
    logitsShape: readonly [number, number],
    resizedSize: readonly [number, number],
    targetWidth: number,
    targetHeight: number,
): { mask: ImageData; bbox: BoundingBox } => {
    const [logitsH, logitsW] = logitsShape;
    const [resizedW, resizedH] = resizedSize;

    const srcW = Math.max(1, Math.round((logitsW * resizedW) / SAM_INPUT_SIZE));
    const srcH = Math.max(1, Math.round((logitsH * resizedH) / SAM_INPUT_SIZE));

    const logitCanvas = createCanvas(logitsW, logitsH);
    const logitCtx = logitCanvas.getContext('2d');
    if (!logitCtx) throw new Error('Failed to acquire a 2D context for mask upscaling.');

    logitCtx.putImageData(logitsToAlpha(logits, logitsW, logitsH), 0, 0);

    const targetCanvas = createCanvas(targetWidth, targetHeight);
    const targetCtx = targetCanvas.getContext('2d');
    if (!targetCtx) throw new Error('Failed to acquire a 2D context for the target mask.');

    // Smoothing on: the 256px silhouette is stretched several times over, and nearest-neighbour
    // edges turn into staircases the brush never produces.
    targetCtx.imageSmoothingEnabled = true;
    targetCtx.drawImage(logitCanvas as CanvasImageSource, 0, 0, srcW, srcH, 0, 0, targetWidth, targetHeight);

    const mask = targetCtx.getImageData(0, 0, targetWidth, targetHeight);
    return { mask, bbox: alphaBoundingBox(mask) };
};

/** Picks the mask index with the highest IoU score. */
export const pickBestMask = (iouScores: Float32Array, numMasks: number): number => {
    let bestIdx = 0;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let i = 0; i < numMasks; i += 1) {
        const score = iouScores[i] ?? Number.NEGATIVE_INFINITY;

        if (score > bestScore) {
            bestScore = score;
            bestIdx = i;
        }
    }

    return bestIdx;
};
