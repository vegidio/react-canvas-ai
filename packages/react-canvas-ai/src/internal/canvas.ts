import type { Rgb } from '../utils';
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

/** Whether a dab adds coverage or takes it away. */
export type MaskDotMode = 'paint' | 'erase';

/**
 * Stamps a single filled brush dab onto the mask layer.
 *
 * Erasing composites with `destination-out`, subtracting the dab's alpha from what is already
 * there. Painting an opaque "background" colour instead — which is what this used to do — cannot
 * work on a layer drawn over the image at `maskOpacity`: it smears that colour across the photo
 * rather than revealing it, and leaves the pixel indistinguishable from a painted one on export.
 */
export const paintMaskDot = (
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    radius: number,
    color: string,
    mode: MaskDotMode = 'paint',
): void => {
    // Forced on both paths and put back afterwards. The mask context is shared with
    // `applyMaskImage`, whose `drawImage` would erase instead of draw if it inherited
    // `destination-out`, and with whatever a peer component paints into the mask canvas itself.
    const previous = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = mode === 'erase' ? 'destination-out' : 'source-over';

    ctx.beginPath();
    ctx.fillStyle = color;
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();

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
