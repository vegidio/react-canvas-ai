import type { Rgb } from '../utils';
import type { ScratchCanvas } from './createCanvas';
import type { BoundingBox } from './detection';
import type { Point } from './geometry';
import { MASK_THRESHOLD } from '../utils';

/** Shown when the source image reports no usable dimensions. */
export const FALLBACK_SIZE: Point = { x: 300, y: 200 };

/** Below this the editor is too small to paint into. */
const MIN_SIZE = 50;

export type CursorCircleOptions = {
    size: Point;
    x: number;
    y: number;
    radius: number;
    color: string;
    opacity: number;
};

/** Repaints the cursor layer with the brush outline at the given position. */
export const drawCursorCircle = (ctx: CanvasRenderingContext2D, options: CursorCircleOptions): void => {
    const { size, x, y, radius, color, opacity } = options;

    ctx.clearRect(0, 0, size.x, size.y);
    ctx.beginPath();
    ctx.fillStyle = color;
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.globalAlpha = opacity;
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
};

/** Whether painting adds coverage or takes it away. */
export type MaskPaintMode = 'paint' | 'erase';

/**
 * Paints a run of brush positions onto the mask layer as one stroke, joined to the previous run.
 *
 * `from` is where the previous run of this stroke ended, and `undefined` at the start of one.
 * `points` is every position the stroke passed through since — a pointer move delivers several
 * coalesced samples at once, and replaying them is what makes a fast stroke follow the path the
 * hand actually took rather than the chord between two frames.
 *
 * The whole run is a *single* stroked path, which is both why it is cheap and why it is correct.
 * Cheap, because the context state and the composite-operation flip are set once rather than
 * once per sample. Correct, because separate strokes composite their shared endpoints twice,
 * and under `destination-out` subtracting anti-aliased alpha twice leaves a seam running down
 * the middle of every erased track — the same reason this never strokes a segment *and* fills a
 * circle at its end.
 *
 * A lone point with no `from` is the one case that cannot be a line: it is filled as a circle,
 * which is exactly what the round caps and joins reproduce at the ends of every segment, so a
 * press and a sweep lay down the same shape.
 *
 * Erasing composites with `destination-out`, subtracting the stroke's alpha from what is already
 * there. Painting an opaque "background" colour instead — which is what this used to do — cannot
 * work on a layer drawn over the image at `maskOpacity`: it smears that colour across the photo
 * rather than revealing it, and leaves the pixel indistinguishable from a painted one on export.
 */
export const paintMaskStroke = (
    ctx: CanvasRenderingContext2D,
    from: Point | undefined,
    points: readonly Point[],
    radius: number,
    color: string,
    mode: MaskPaintMode = 'paint',
): void => {
    const head = points[0];
    if (!head) return;

    // Forced on both paths and put back afterwards. The mask context is shared with
    // `applyMaskImage`, whose `drawImage` would erase instead of draw if it inherited
    // `destination-out`, and with whatever a peer component paints into the mask canvas itself.
    const previous = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = mode === 'erase' ? 'destination-out' : 'source-over';

    ctx.beginPath();

    if (!from && points.length === 1) {
        ctx.fillStyle = color;
        ctx.arc(head.x, head.y, radius, 0, Math.PI * 2);
        ctx.fill();
    } else {
        // `radius * 2` because the brush radius is the half-width the round caps and joins
        // reproduce at each end, making the swept shape identical to the circular dab.
        ctx.strokeStyle = color;
        ctx.lineWidth = radius * 2;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        const start = from ?? head;
        ctx.moveTo(start.x, start.y);
        for (const point of points) ctx.lineTo(point.x, point.y);
        ctx.stroke();
    }

    ctx.globalCompositeOperation = previous;
};

/**
 * Retints every painted pixel of the mask to `rgb`, leaving alpha untouched.
 *
 * "Painted" is coverage, not colour. Treating a red channel of 255 as background collapsed any
 * `maskColor` with `r === 255` — the default `#ffffff` included — back to white on every
 * retint, fringed anti-aliased stroke edges with white, and rewrote the RGB of pixels that were
 * fully transparent and therefore not part of the mask at all.
 */
export const recolorMask = (ctx: CanvasRenderingContext2D, size: Point, rgb: Rgb): void => {
    const imageData = ctx.getImageData(0, 0, size.x, size.y);
    const data = imageData.data;

    for (let i = 0; i < data.length; i += 4) {
        // No coverage means no colour to retint.
        if (data[i + 3] === 0) continue;

        data[i] = rgb[0];
        data[i + 1] = rgb[1];
        data[i + 2] = rgb[2];
    }

    ctx.putImageData(imageData, 0, 0);
};

/**
 * Rasterizes a saved black-and-white mask into the representation the editor paints in: light,
 * opaque pixels become `rgb` at full alpha and everything else becomes fully transparent.
 *
 * That is what makes `onMaskChange` -> `initialMask` a lossless round trip, and what lets
 * {@link recolorMask} treat a loaded mask exactly like hand-painted strokes. Drawing the PNG
 * straight onto the layer — over a white fill, no less — left it opaque wherever nothing was
 * masked: a full-canvas wash over the image, and an export reporting every pixel as masked.
 *
 * Drawn onto the mask surface itself rather than through a scratch canvas: the point of the call
 * is to replace what is there, `size` is already the surface's size so `drawImage` does the
 * scaling, and the read-back and write-back happen inside one task, so no intermediate state can
 * reach the screen. There is no compositing shortcut — `source-in` and friends discriminate on
 * alpha, and the source PNG is uniformly opaque, so turning luminance into alpha needs either a
 * pixel pass or an SVG `feColorMatrix` filter, which is not portable.
 */
export const applyMaskImage = (ctx: CanvasRenderingContext2D, size: Point, img: HTMLImageElement, rgb: Rgb): void => {
    ctx.clearRect(0, 0, size.x, size.y);
    ctx.drawImage(img, 0, 0, size.x, size.y);

    const imageData = ctx.getImageData(0, 0, size.x, size.y);
    const data = imageData.data;

    for (let i = 0; i < data.length; i += 4) {
        // The contract is a black-and-white PNG, so the three channels agree and a plain mean is
        // the luminance. Alpha is tested too, so a mask saved with transparency where it should
        // have had black does not come back fully masked.
        const luma = (data[i] + data[i + 1] + data[i + 2]) / 3;
        const painted = data[i + 3] >= MASK_THRESHOLD && luma >= MASK_THRESHOLD;

        data[i] = painted ? rgb[0] : 0;
        data[i + 1] = painted ? rgb[1] : 0;
        data[i + 2] = painted ? rgb[2] : 0;
        data[i + 3] = painted ? 255 : 0;
    }

    ctx.putImageData(imageData, 0, 0);
};

/**
 * Replaces a silhouette's RGB with `color`, leaving its coverage untouched. Returns whether
 * the surface could be tinted at all.
 *
 * Running this twice is a no-op the second time, which is what lets a hover preview tint a
 * silhouette to draw it and the click that commits that same silhouette tint it again. Under
 * an opaque full-rect fill, `source-in` is `Ao = As x Ad` with `As = 1`: alpha is read and
 * never written, and the colour comes from the fill rather than from whatever was there. So
 * there is no accumulation, no rounding drift across repeats, and a `maskColor` changed
 * between the two passes still lands exactly.
 */
export const tintSilhouette = (silhouette: ScratchCanvas, color: string): boolean => {
    const ctx = silhouette.getContext('2d');
    if (!ctx) return false;

    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, silhouette.width, silhouette.height);
    return true;
};

/**
 * Composites a detected object's silhouette onto the mask layer, upholding the same coverage
 * invariant the brush does: painting lands `color` at the silhouette's alpha, erasing subtracts
 * that alpha. The silhouette's own RGB is ignored — `source-in` replaces it with the editor's
 * live colour, so a detected mask retints, exports and undoes exactly like hand-painted
 * strokes. The plugin this replaces took a separate style object instead, which meant every
 * consumer had to pass `maskColor` twice and keep the two in agreement.
 *
 * Takes the surface the detection was rasterized on and tints it in place, through
 * {@link tintSilhouette}. The `ImageData` handed to consumers was read off it beforehand, so
 * nothing observes the tint. Copying those pixels onto a scratch canvas first — which is what
 * this did — was a full-frame `putImageData` and a second allocation per click, to rebuild a
 * canvas the pipeline had already produced.
 *
 * The composite operation is saved and restored for the same reason {@link paintMaskStroke} does
 * it: the mask context is shared, and leaving `destination-out` in force would turn the next
 * peer draw into an erase.
 */
export const applyDetectedMask = (
    ctx: CanvasRenderingContext2D,
    size: Point,
    silhouette: ScratchCanvas,
    color: string,
    mode: MaskPaintMode = 'paint',
): void => {
    if (!tintSilhouette(silhouette, color)) return;

    const previous = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = mode === 'erase' ? 'destination-out' : 'source-over';
    ctx.drawImage(silhouette, 0, 0, size.x, size.y);
    ctx.globalCompositeOperation = previous;
};

/**
 * The eight neighbours of a pixel. Four would leave gaps at the diagonals of a grown
 * silhouette, which read as a dotted outline along every slanted edge.
 */
const OUTLINE_OFFSETS: readonly (readonly [number, number])[] = [
    [-1, -1],
    [0, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
];

export type PreviewSilhouetteOptions = {
    size: Point;
    silhouette: ScratchCanvas;
    color: string;
    /** Below the mask layer's own opacity, so a preview can never be read as a commit. */
    fillOpacity: number;
    outlineOpacity: number;
    /** How far the outline is grown, in canvas pixels. */
    outlineWidth: number;
    /**
     * A box known to contain the silhouette, from `Detection.paintRect`. Only a bound on where
     * the compositing has to happen — it may be generous, and nothing is read from it.
     */
    rect: BoundingBox;
};

/**
 * Paints an uncommitted detection onto the cursor layer: the silhouette tinted in the mask
 * colour at a reduced alpha, ringed by a solid outline so the *extent* of the selection stays
 * legible even where a faint fill washes out over a busy photo.
 *
 * The ring is built by compositing rather than traced. The silhouette is stamped `outlineWidth`
 * px out in eight directions to grow it, then the un-offset silhouette is punched back out with
 * `destination-out`, leaving the difference — nine `drawImage` calls the compositor does on its
 * own, plus a tenth for the fill, against a JS pass over every pixel of a full-frame alpha
 * buffer for a marching-squares trace, which would additionally need a vector representation
 * before it could be stroked at all. `logitsToMask` hands over an alpha-only surface already at
 * `size`, so there is nothing to rescale and no colour channel to work around.
 *
 * All eight offsets are needed. Only the four diagonals looks equivalent — their union is a
 * square — but for a feature thinner than `outlineWidth` it is not: nothing in that set covers
 * the straight `(±outlineWidth, 0)` shift, so the ring breaks up along horizontal edges.
 *
 * Those ten composites run inside a clip to `rect`, which is what keeps a hover affordable: the
 * silhouette is typically a small part of the frame, and unclipped this blended the whole canvas
 * ten times over for every preview. The clear stays full-frame deliberately — it is one cheap op
 * against ten expensive ones, and clearing everything means no caller has to remember where the
 * previous preview was drawn.
 *
 * The fill goes on last, *under* the ring. Stacked over it, the two alphas would add up and
 * make the rim read as solid coverage — the one thing a preview must never look like.
 */
export const drawPreviewSilhouette = (ctx: CanvasRenderingContext2D, options: PreviewSilhouetteOptions): void => {
    const { size, silhouette, color, fillOpacity, outlineOpacity, outlineWidth, rect } = options;
    if (!tintSilhouette(silhouette, color)) return;

    ctx.clearRect(0, 0, size.x, size.y);
    if (rect.width === 0 || rect.height === 0) return;

    // Saved and restored, unlike `drawCursorCircle`: on a switch back to paint mode the brush
    // outline is the next thing drawn here, and it sets neither `globalCompositeOperation` nor
    // its own alpha back to a known value first. The clip is released by the same `restore`.
    ctx.save();

    // Grown by the outline, or the stamps that build the ring would be clipped away at the very
    // edge of the shape they are supposed to be ringing.
    ctx.beginPath();
    ctx.rect(
        rect.x - outlineWidth,
        rect.y - outlineWidth,
        rect.width + outlineWidth * 2,
        rect.height + outlineWidth * 2,
    );
    ctx.clip();

    ctx.globalAlpha = outlineOpacity;
    for (const [dx, dy] of OUTLINE_OFFSETS) {
        ctx.drawImage(silhouette, dx * outlineWidth, dy * outlineWidth, size.x, size.y);
    }

    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = 1;
    ctx.drawImage(silhouette, 0, 0, size.x, size.y);

    ctx.globalCompositeOperation = 'destination-over';
    ctx.globalAlpha = fillOpacity;
    ctx.drawImage(silhouette, 0, 0, size.x, size.y);

    ctx.restore();
};

/**
 * Picks the canvas size for a loaded image: scaled down to fit the configured bounds while
 * preserving aspect ratio, and never smaller than {@link MIN_SIZE}.
 */
export const computeTargetSize = (img: HTMLImageElement, maxWidth: number, maxHeight: number): Point => {
    const sourceWidth = img.width || img.naturalWidth;
    const sourceHeight = img.height || img.naturalHeight;

    if (!sourceWidth || !sourceHeight) return { ...FALLBACK_SIZE };

    let x = sourceWidth;
    let y = sourceHeight;

    if (x > maxWidth || y > maxHeight) {
        const ratio = Math.min(maxWidth / x, maxHeight / y);
        x = Math.round(x * ratio);
        y = Math.round(y * ratio);
    }

    return { x: Math.max(x, MIN_SIZE), y: Math.max(y, MIN_SIZE) };
};
