import type { ScratchCanvas } from '../createCanvas';
import type { BoundingBox } from '../detection';
import { MASK_THRESHOLD } from '../../utils';
import { createCanvas } from '../createCanvas';
import { SAM_INPUT_SIZE } from './preprocess';

/** Positive logits are the object; the model's own decision boundary, not a tunable. */
const LOGIT_THRESHOLD = 0;

/**
 * How far {@link RasterizedMask.paintRect} is grown beyond the scaled low-res bounds.
 *
 * The box is measured on the 256px silhouette and then stretched, so a covered low-res pixel
 * becomes a block several target pixels wide, and the smoothed upscale spills a little further
 * still. A draw region only has to *contain* the shape, so the slack is free — a rect that is
 * a few pixels too big costs nothing, one a pixel too small clips the outline.
 */
const PAINT_RECT_SLACK_PX = 2;

const EMPTY_BOX: BoundingBox = { x: 0, y: 0, width: 0, height: 0 };

/** A thresholded low-res silhouette, with the box bounding its coverage. */
export type AlphaRaster = {
    image: ImageData;
    /** Zero-sized when nothing is covered. */
    bounds: BoundingBox;
};

/**
 * Thresholds low-res mask logits into an alpha-only `ImageData`, measuring the coverage bounds
 * in the same pass. Pure so the thresholding is testable without a canvas; RGB stays zero
 * because the editor tints the silhouette itself.
 *
 * The bounds come from here rather than from a second scan of the upscaled result because this
 * loop is 256x256 — some 24x cheaper than the full-resolution one, and it needs no canvas
 * readback at all. They are what tells {@link logitsToMask} whether the mask is empty and
 * roughly where it sits, neither of which is worth a full-frame `getImageData` to learn.
 */
export const logitsToAlpha = (logits: Float32Array, width: number, height: number): AlphaRaster => {
    const image = new ImageData(width, height);

    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const covered = logits[y * width + x] > LOGIT_THRESHOLD;
            if (!covered) continue;

            image.data[(y * width + x) * 4 + 3] = 255;

            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
        }
    }

    const bounds: BoundingBox =
        maxX < 0 ? { ...EMPTY_BOX } : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };

    return { image, bounds };
};

/**
 * Scans an alpha silhouette for its bounding box. A zero-sized box means the mask is empty.
 *
 * Coverage is judged by {@link MASK_THRESHOLD}, the same half-coverage rule `toMask` exports
 * by, so a detected object's box cannot disagree with the mask the editor writes out.
 *
 * Nested loops rather than one pass with `% width`: the row and column are already the loop
 * counters, and the flat form ran an integer divide and modulo for every covered pixel of a
 * full-resolution mask.
 */
export const alphaBoundingBox = (mask: ImageData): BoundingBox => {
    const { data, width, height } = mask;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < height; y += 1) {
        let alpha = y * width * 4 + 3;

        for (let x = 0; x < width; x += 1, alpha += 4) {
            if (data[alpha] < MASK_THRESHOLD) continue;

            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
        }
    }

    if (maxX < 0) return { ...EMPTY_BOX };
    return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
};

/**
 * A rasterized detection: the surface it was drawn on, cheap facts measured on the low-res
 * mask, and deferred access to the full-resolution pixels.
 *
 * {@link RasterizedMask.readMask} and {@link RasterizedMask.readBbox} are deferred because the
 * hover preview reads neither. It draws `silhouette` and throws the rest away, so making the
 * full-frame `getImageData` — several megabytes, plus a synchronous readback that flushes the
 * `drawImage` that produced it — unconditional meant paying for the documented output of a
 * detection nobody asked for, several times a second. Both memoize, so a committed detection
 * pays exactly once and gets the same values it always did.
 */
export type RasterizedMask = {
    silhouette: ScratchCanvas;
    /** Whether the low-res mask had no coverage at all. */
    isEmpty: boolean;
    /**
     * Target-space box that *contains* the silhouette, for callers that only need somewhere to
     * draw. Measured on the low-res mask and grown, so it is conservative rather than tight —
     * {@link RasterizedMask.readBbox} is the exact one.
     */
    paintRect: BoundingBox;
    /** The full-resolution pixels, read on first call. */
    readMask: () => ImageData;
    /** The exact box, measured on the full-resolution pixels. */
    readBbox: () => BoundingBox;
};

/**
 * Converts SAM's low-res mask logits (256×256 representing the 1024×1024 padded input frame)
 * into a full-resolution alpha-only silhouette at the editor canvas's dimensions.
 *
 * The low-res mask covers the *padded* frame, so only the top-left subregion corresponding to
 * the unpadded, resized image is sampled, then stretched to the target dimensions. Without
 * this, the padding on the right/bottom of non-square images leaks into the output.
 *
 * The editor composites from `silhouette` directly: it is the same image, already on a canvas,
 * and putting the pixels back onto a second canvas to draw them was a full-frame copy in each
 * direction for a picture the pipeline had in the right form all along.
 */
export const logitsToMask = (
    logits: Float32Array,
    logitsShape: readonly [number, number],
    resizedSize: readonly [number, number],
    targetWidth: number,
    targetHeight: number,
): RasterizedMask => {
    const [logitsH, logitsW] = logitsShape;
    const [resizedW, resizedH] = resizedSize;

    const srcW = Math.max(1, Math.round((logitsW * resizedW) / SAM_INPUT_SIZE));
    const srcH = Math.max(1, Math.round((logitsH * resizedH) / SAM_INPUT_SIZE));

    const logitCanvas = createCanvas(logitsW, logitsH);
    const logitCtx = logitCanvas.getContext('2d');
    if (!logitCtx) throw new Error('Failed to acquire a 2D context for mask upscaling.');

    const { image, bounds } = logitsToAlpha(logits, logitsW, logitsH);
    logitCtx.putImageData(image, 0, 0);

    const targetCanvas = createCanvas(targetWidth, targetHeight);
    const targetCtx = targetCanvas.getContext('2d');
    if (!targetCtx) throw new Error('Failed to acquire a 2D context for the target mask.');

    // Smoothing on: the 256px silhouette is stretched several times over, and nearest-neighbour
    // edges turn into staircases the brush never produces.
    targetCtx.imageSmoothingEnabled = true;
    targetCtx.drawImage(logitCanvas as CanvasImageSource, 0, 0, srcW, srcH, 0, 0, targetWidth, targetHeight);

    let mask: ImageData | undefined;
    const readMask = (): ImageData => (mask ??= targetCtx.getImageData(0, 0, targetWidth, targetHeight));

    let bbox: BoundingBox | undefined;
    const readBbox = (): BoundingBox => (bbox ??= alphaBoundingBox(readMask()));

    return {
        silhouette: targetCanvas,
        isEmpty: bounds.width === 0 || bounds.height === 0,
        paintRect: scaleBounds(bounds, targetWidth / srcW, targetHeight / srcH, targetWidth, targetHeight),
        readMask,
        readBbox,
    };
};

/** Stretches a low-res box into target space, grown by the slack and clipped to the surface. */
const scaleBounds = (
    bounds: BoundingBox,
    scaleX: number,
    scaleY: number,
    targetWidth: number,
    targetHeight: number,
): BoundingBox => {
    if (bounds.width === 0 || bounds.height === 0) return { ...EMPTY_BOX };

    const left = Math.max(0, Math.floor(bounds.x * scaleX) - PAINT_RECT_SLACK_PX);
    const top = Math.max(0, Math.floor(bounds.y * scaleY) - PAINT_RECT_SLACK_PX);
    const right = Math.min(targetWidth, Math.ceil((bounds.x + bounds.width) * scaleX) + PAINT_RECT_SLACK_PX);
    const bottom = Math.min(targetHeight, Math.ceil((bounds.y + bounds.height) * scaleY) + PAINT_RECT_SLACK_PX);

    return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
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
