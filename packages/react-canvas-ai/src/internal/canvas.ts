import type { Rgb } from '../utils';
import type { Point } from './geometry';

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

/** Stamps a single filled brush dab onto the mask layer. */
export const paintMaskDot = (
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    radius: number,
    color: string,
): void => {
    ctx.beginPath();
    ctx.fillStyle = color;
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
};

/**
 * Repaints every non-background pixel of the mask in `rgb`. Background is identified by a
 * red channel of 255, which is what the white fill the mask starts from leaves behind.
 */
export const recolorMask = (ctx: CanvasRenderingContext2D, size: Point, rgb: Rgb): void => {
    const imageData = ctx.getImageData(0, 0, size.x, size.y);
    const data = imageData.data;

    for (let i = 0; i < data.length; i += 4) {
        const isBackground = data[i] === 255;
        data[i] = isBackground ? 255 : rgb[0];
        data[i + 1] = isBackground ? 255 : rgb[1];
        data[i + 2] = isBackground ? 255 : rgb[2];
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
