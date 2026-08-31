import type { ScratchCanvas } from '../createCanvas';
import type { BoundingBox } from '../detection';
import { MASK_THRESHOLD } from '../../utils';
import { createCanvas } from '../createCanvas';
import { SAM_INPUT_SIZE } from './preprocess';

/** Positive logits are the object; the model's own decision boundary, not a tunable. */
const LOGIT_THRESHOLD = 0;

/**
 * Half-width, in logits, of the band the alpha ramp spends its 256 levels on. Anything further
 * from the decision boundary than this saturates to fully covered or fully clear.
 *
 * This is what carries the model's sub-pixel edge through an 8-bit canvas. The logits are a
 * smooth field sampled on a 256px grid, and the true edge crosses *between* samples; binarizing
 * them here — which is what this did — throws that away and pins the boundary to the low-res
 * grid, so the upscale can only stretch a staircase into a bigger, blurrier staircase. Encoding
 * the field instead lets the upscale interpolate it, and the half-alpha contour of the result
 * lands where the logits actually cross zero. It is also what SAM's own postprocessing does:
 * interpolate the low-res logits to full resolution, *then* threshold.
 *
 * The width is a trade. Too narrow and the samples either side of an edge both saturate, which
 * is binarization again; too wide and logits far from any edge stop saturating, washing faint
 * coverage across the whole frame. Eight logits keeps a couple of samples on the ramp for the
 * edge gradients SlimSAM actually produces, while a pixel a source pixel or so clear of the
 * boundary is already hard 0 or 255.
 */
const LOGIT_RAMP = 8;

/** Alpha per logit, so ±{@link LOGIT_RAMP} lands exactly on the ends of the 0-255 range. */
const ALPHA_PER_LOGIT = 128 / LOGIT_RAMP;

/**
 * How wide, in target pixels, the upscaled edge is sharpened back down to.
 *
 * The ramp is measured in logits, so how far it spreads once stretched depends on the gradient
 * the model produced and on the scale factor — for a large image it can smear an edge over the
 * best part of ten pixels, which reads as a glow rather than a selection. Rescaling the ramp
 * about the half-alpha point narrows it without moving it, so the contour stays exactly where
 * the interpolation put it and only the anti-aliased rim tightens. About a pixel and a half is
 * what the brush's own round caps lay down.
 */
const EDGE_SOFTNESS_PX = 1.5;

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

/** Whichever 2D context {@link createCanvas} handed back, element or offscreen. */
type ScratchContext2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** A thresholded low-res silhouette, with the box bounding its coverage. */
export type AlphaRaster = {
    image: ImageData;
    /** Zero-sized when nothing is covered. */
    bounds: BoundingBox;
};

/**
 * Ramps low-res mask logits into an alpha-only `ImageData`, measuring the coverage bounds in
 * the same pass. Pure so the mapping is testable without a canvas; RGB stays zero because the
 * editor tints the silhouette itself.
 *
 * Alpha is a linear ramp over ±{@link LOGIT_RAMP} rather than a hard 0/255 threshold, which is
 * what lets the upscale reconstruct the edge instead of magnifying the grid it was sampled on —
 * see {@link LOGIT_RAMP}. Coverage is unchanged by that: the ramp is built so `alpha >=
 * MASK_THRESHOLD` and `logit > LOGIT_THRESHOLD` are the same predicate for every value, zero
 * included, so everything downstream still splits the mask exactly where the model does.
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
            const index = y * width + x;
            const logit = logits[index];

            // `ceil` about 127, not `round` about 128: it puts the step from 127 to 128 exactly
            // at logit 0, so the half-coverage rule the rest of the editor exports by agrees
            // with the model's own boundary rather than sitting half a level off it.
            const ramped = Math.ceil(127 + logit * ALPHA_PER_LOGIT);
            image.data[index * 4 + 3] = ramped < 0 ? 0 : ramped > 255 ? 255 : ramped;

            if (logit <= LOGIT_THRESHOLD) continue;

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
    // edges turn into staircases the brush never produces. With the ramp above carrying the
    // logits rather than a binary silhouette, this interpolation is what actually reconstructs
    // the edge — it is the `F.interpolate(..., 'bilinear')` of SAM's own postprocessing, and
    // the contour it draws through the half-alpha level is sub-pixel accurate.
    targetCtx.imageSmoothingEnabled = true;
    targetCtx.drawImage(logitCanvas as CanvasImageSource, 0, 0, srcW, srcH, 0, 0, targetWidth, targetHeight);

    const scaleX = targetWidth / srcW;
    const scaleY = targetHeight / srcH;
    const paintRect = scaleBounds(bounds, scaleX, scaleY, targetWidth, targetHeight);

    sharpenEdges(targetCtx, paintRect, (scaleX + scaleY) / 2 / EDGE_SOFTNESS_PX);

    let mask: ImageData | undefined;
    const readMask = (): ImageData => (mask ??= targetCtx.getImageData(0, 0, targetWidth, targetHeight));

    let bbox: BoundingBox | undefined;
    const readBbox = (): BoundingBox => (bbox ??= alphaBoundingBox(readMask()));

    return {
        silhouette: targetCanvas,
        isEmpty: bounds.width === 0 || bounds.height === 0,
        paintRect,
        readMask,
        readBbox,
    };
};

/**
 * Narrows the anti-aliased rim of an upscaled mask to about {@link EDGE_SOFTNESS_PX}, by
 * rescaling alpha about the half-coverage level inside `rect`.
 *
 * The pivot is what makes this safe: 127 and 128 are fixed points of the rescale, so no pixel
 * can cross the coverage threshold and the contour the interpolation produced does not move.
 * Only the width of the ramp around it changes — the edge stays exactly where it was and stops
 * being a gradient several pixels deep.
 *
 * Bounded by `rect`, so the cost is the object's own area rather than the frame's: a hover
 * preview over a small object touches a few thousand pixels, and outside the box the ramp has
 * long since saturated, so there is nothing there to rescale anyway. Skipped entirely when the
 * mask is being scaled down, where the rim is already at most a pixel or so wide.
 */
const sharpenEdges = (ctx: ScratchContext2D, rect: BoundingBox, gain: number): void => {
    if (gain <= 1 || rect.width === 0 || rect.height === 0) return;

    const image = ctx.getImageData(rect.x, rect.y, rect.width, rect.height);
    const { data } = image;

    for (let i = 3; i < data.length; i += 4) {
        const alpha = data[i];
        // The saturated interior and exterior are most of the box and cannot move; only the
        // rim between them has anything to rescale.
        if (alpha === 0 || alpha === 255) continue;

        const scaled = 127.5 + (alpha - 127.5) * gain;
        data[i] = scaled < 0 ? 0 : scaled > 255 ? 255 : Math.round(scaled);
    }

    ctx.putImageData(image, rect.x, rect.y);
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

    // `bounds` only covers pixels the model calls the object, but the ramp reaches roughly a
    // source pixel past them, and that partial coverage is the anti-aliased rim. A box measured
    // on the coverage alone would clip it — and it is exactly the part this change exists to
    // produce — so the rim is added to the slack rather than left to it.
    const marginX = Math.ceil(scaleX) + PAINT_RECT_SLACK_PX;
    const marginY = Math.ceil(scaleY) + PAINT_RECT_SLACK_PX;

    const left = Math.max(0, Math.floor(bounds.x * scaleX) - marginX);
    const top = Math.max(0, Math.floor(bounds.y * scaleY) - marginY);
    const right = Math.min(targetWidth, Math.ceil((bounds.x + bounds.width) * scaleX) + marginX);
    const bottom = Math.min(targetHeight, Math.ceil((bounds.y + bounds.height) * scaleY) + marginY);

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
