/**
 * Flattens a canvas to a pure black-and-white mask and returns it as a PNG data URL.
 *
 * Only *fully* black pixels stay black; everything else becomes white. The canvas is
 * restored to its original pixels before returning, so this is safe to call on a live
 * editing surface.
 */
export const toMask = (canvas: HTMLCanvasElement): string => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas.toDataURL();

    const size = {
        x: canvas.width,
        y: canvas.height,
    };

    const imageData = ctx.getImageData(0, 0, size.x, size.y);
    const origData = Uint8ClampedArray.from(imageData.data);

    for (let i = 0; i < imageData.data.length; i += 4) {
        const isBlack = imageData.data[i] === 0 && imageData.data[i + 1] === 0 && imageData.data[i + 2] === 0;
        const pixelColor = isBlack ? 0 : 255;
        imageData.data[i] = pixelColor;
        imageData.data[i + 1] = pixelColor;
        imageData.data[i + 2] = pixelColor;
        imageData.data[i + 3] = 255;
    }
    ctx.putImageData(imageData, 0, 0);

    const dataUrl = canvas.toDataURL();

    // Put the original pixels back so the caller's canvas is left untouched.
    imageData.data.set(origData);
    ctx.putImageData(imageData, 0, 0);

    return dataUrl;
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

export function simpleDebounce<T extends (...args: never[]) => void>(fn: T, wait: number): T & { cancel: () => void } {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const debounced = (...args: Parameters<T>) => {
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(() => fn(...args), wait);
    };
    debounced.cancel = () => {
        if (timeout) clearTimeout(timeout);
        timeout = null;
    };
    return debounced as T & { cancel: () => void };
}
