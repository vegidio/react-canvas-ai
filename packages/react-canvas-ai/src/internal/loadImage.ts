export interface LoadImageOptions {
    crossOrigin?: string;
    signal?: AbortSignal;
}

const abortError = (): DOMException => new DOMException('Image load aborted', 'AbortError');

/**
 * Reads a remote image through `fetch` and hands the decoder a data URL instead of the
 * original URL. Doing the transfer ourselves keeps the canvas untainted — and therefore
 * `getImageData`-able for the mask — even when the response omits the CORS headers a direct
 * `img.src` assignment would require.
 */
const fetchAsDataUrl = async (url: string, signal?: AbortSignal): Promise<string> => {
    const response = await fetch(url, signal ? { signal } : {});
    if (!response.ok) throw new Error(`Failed to fetch image: ${response.statusText}`);

    const blob = await response.blob();
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error ?? new Error('Failed to read image blob'));
        reader.readAsDataURL(blob);
    });
};

/**
 * Loads an image, resolving once it has decoded. Aborting via `options.signal` cancels the
 * in-flight fetch and detaches the element's handlers, so a superseded load can never win a
 * race against the one that replaced it.
 */
export async function loadImage(src: string, options: LoadImageOptions = {}): Promise<HTMLImageElement> {
    const { crossOrigin, signal } = options;

    if (!src) throw new Error('No image source provided');
    if (signal?.aborted) throw abortError();

    // Set unconditionally: many image hosts require it even for same-origin requests.
    const img = new window.Image();
    img.crossOrigin = crossOrigin || 'anonymous';

    let resolvedSrc = src;
    if (src.startsWith('http')) {
        try {
            resolvedSrc = await fetchAsDataUrl(src, signal);
        } catch (error) {
            if (signal?.aborted) throw abortError();
            // The fetch route is an optimisation, not a requirement — let the browser try.
            resolvedSrc = src;
            void error;
        }
    }

    if (signal?.aborted) throw abortError();

    return new Promise<HTMLImageElement>((resolve, reject) => {
        const detach = () => {
            img.onload = null;
            img.onerror = null;
        };

        img.onload = () => {
            detach();
            resolve(img);
        };
        img.onerror = () => {
            detach();
            reject(new Error(`Failed to load image: ${src}`));
        };

        signal?.addEventListener(
            'abort',
            () => {
                detach();
                reject(abortError());
            },
            { once: true },
        );

        img.src = resolvedSrc;
    });
}
