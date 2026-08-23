export type LoadImageOptions = {
    crossOrigin?: string;
    signal?: AbortSignal;
};

const abortError = (): DOMException => new DOMException('Image load aborted', 'AbortError');

/**
 * Reads a remote image through `fetch` and hands the decoder a blob URL instead of the
 * original URL. Doing the transfer ourselves keeps the canvas untainted — and therefore
 * `getImageData`-able for the mask — even when the response omits the CORS headers a direct
 * `img.src` assignment would require.
 *
 * A blob URL rather than a data URL: base64 inflates the payload by a third and would
 * materialise the whole image as a JS string before the decoder ever sees it. The caller
 * owns revoking the returned URL.
 */
const fetchAsObjectUrl = async (url: string, signal?: AbortSignal): Promise<string> => {
    const response = await fetch(url, signal ? { signal } : {});
    if (!response.ok) throw new Error(`Failed to fetch image: ${response.statusText}`);

    return URL.createObjectURL(await response.blob());
};

/**
 * Loads an image, resolving once it has decoded. Aborting via `options.signal` cancels the
 * in-flight fetch and detaches the element's handlers, so a superseded load can never win a
 * race against the one that replaced it.
 */
export const loadImage = async (src: string, options: LoadImageOptions = {}): Promise<HTMLImageElement> => {
    const { crossOrigin, signal } = options;

    if (!src) throw new Error('No image source provided');
    if (signal?.aborted) throw abortError();

    // Set unconditionally: many image hosts require it even for same-origin requests.
    const img = new window.Image();
    img.crossOrigin = crossOrigin || 'anonymous';

    let resolvedSrc = src;
    let objectUrl: string | undefined;
    if (src.startsWith('http')) {
        try {
            objectUrl = await fetchAsObjectUrl(src, signal);
            resolvedSrc = objectUrl;
        } catch (error) {
            if (signal?.aborted) throw abortError();
            // The fetch route is an optimisation, not a requirement — let the browser try.
            resolvedSrc = src;
            void error;
        }
    }

    if (signal?.aborted) {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        throw abortError();
    }

    return new Promise<HTMLImageElement>((resolve, reject) => {
        // Revoke on every exit: once the image has decoded, the browser holds its own
        // reference to the bitmap, so keeping the URL alive only leaks the blob.
        const detach = () => {
            img.onload = null;
            img.onerror = null;
            if (objectUrl) {
                URL.revokeObjectURL(objectUrl);
                objectUrl = undefined;
            }
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
};
