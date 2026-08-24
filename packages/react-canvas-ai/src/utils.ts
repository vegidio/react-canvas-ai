/**
 * Half coverage. Painting and erasing both leave anti-aliased rims, and the exported mask is
 * 1-bit, so a partly covered pixel has to be called one way or the other: at or above half it
 * is masked, below it is not.
 *
 * The alternative — any coverage at all counts — is not symmetric with erasing. It would grow
 * every stroke by the width of its rim, leave a masked halo behind every erase that no amount
 * of erasing could remove, and creep outwards a little on each `onMaskChange` -> `initialMask`
 * round trip. At half, that round trip is a fixed point.
 */
export const MASK_THRESHOLD = 128;

/**
 * Flattens the mask canvas to a pure black-and-white mask and returns it as a PNG data URL.
 *
 * Coverage decides, not colour: the editor paints in `maskColor` at full alpha and erases back
 * to fully transparent, so a pixel with at least {@link MASK_THRESHOLD} alpha exports white and
 * everything else exports black. Classifying by RGB — which is what this did — exported
 * `maskColor: '#000000'` as if nothing had been painted at all, and could not tell an erased
 * pixel from a painted one, because erasing used to paint an opaque colour of its own.
 *
 * The thresholding happens on a scratch canvas rather than in place. Mutating the live
 * surface and putting the original pixels back would cost two extra full-buffer writes per
 * call — on every mouseup, undo, redo and clear — and leaves a window where the canvas on
 * screen holds the wrong pixels.
 */
export const toMask = (canvas: HTMLCanvasElement): string => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas.toDataURL();

    const { width, height } = canvas;
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;

    for (let i = 0; i < data.length; i += 4) {
        const pixelColor = data[i + 3] >= MASK_THRESHOLD ? 255 : 0;
        data[i] = pixelColor;
        data[i + 1] = pixelColor;
        data[i + 2] = pixelColor;
        data[i + 3] = 255;
    }

    const scratch = document.createElement('canvas');
    scratch.width = width;
    scratch.height = height;

    const scratchCtx = scratch.getContext('2d');
    // Without a scratch context there is nothing to export from; the caller's canvas is
    // still untouched, so fall back to its unmodified contents.
    if (!scratchCtx) return canvas.toDataURL();

    scratchCtx.putImageData(imageData, 0, 0);
    return scratch.toDataURL();
};

/** An `[r, g, b]` triple, each channel 0-255. */
export type Rgb = [number, number, number];

const BLACK: Rgb = [0, 0, 0];

/**
 * Parses a CSS hex colour, accepting both `#rgb` shorthand and full `#rrggbb`, with or
 * without the leading hash. Anything else falls back to black rather than propagating
 * `NaN` channels into `putImageData`.
 */
export const hexToRgb = (color: string): Rgb => {
    const hex = color.replace('#', '').toLowerCase();
    if (!/^[0-9a-f]+$/.test(hex)) return [...BLACK];

    // Shorthand expands per nibble: `#0a0` is `#00aa00`, not `#0a0` truncated.
    const full = hex.length === 3 ? [...hex].map((nibble) => nibble + nibble).join('') : hex;
    if (full.length !== 6) return [...BLACK];

    return [
        Number.parseInt(full.slice(0, 2), 16),
        Number.parseInt(full.slice(2, 4), 16),
        Number.parseInt(full.slice(4, 6), 16),
    ];
};
