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

export const hexToRgb = (color: string): number[] => {
    const parts = color.replace('#', '').match(/.{1,2}/g);
    if (!parts) return [0, 0, 0];
    return parts.map((part) => Number.parseInt(part, 16));
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
