/**
 * Cache Storage bucket holding the fetched ONNX model files. Deliberately free of any
 * onnxruntime reference: `clearSamCache` is exported from the public barrel, and importing
 * anything heavier from here would drag the whole SAM chunk into the main bundle.
 */
const CACHE_NAME = 'react-canvas-ai-sam-v1';

/**
 * Fetches an ONNX model, serving from Cache Storage when possible so the ~14 MB download
 * happens once per browser rather than once per visit.
 *
 * Only the cache *access* is guarded: Cache Storage can be unavailable (private mode, storage
 * permissions) and that must fall through to the network — but a failed network fetch throws.
 * Wrapping the fetch in the same guard, which is what the plugin this was ported from did,
 * swallowed a genuine 404 and silently retried the same broken URL a second time.
 */
export const fetchOnnx = async (url: string, signal?: AbortSignal): Promise<ArrayBuffer> => {
    const cached = await readCachedModel(url);
    if (cached) return cached;

    const response = await fetch(url, signal ? { signal } : undefined);
    if (!response.ok) {
        throw new Error(`SAM model fetch failed: ${response.status} ${response.statusText} ${url}`);
    }

    // Persisting is best-effort and gets its own guard: a quota or private-mode failure on
    // `put` must not discard the response we already paid to download. The clone is taken
    // before `arrayBuffer()` consumes the body.
    try {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(url, response.clone());
    } catch {
        // Nothing to do — the next visit downloads again.
    }

    return await response.arrayBuffer();
};

const readCachedModel = async (url: string): Promise<ArrayBuffer | undefined> => {
    if (typeof caches === 'undefined') return undefined;

    try {
        const cache = await caches.open(CACHE_NAME);
        const match = await cache.match(url);
        return match ? await match.arrayBuffer() : undefined;
    } catch {
        return undefined;
    }
};

/**
 * Deletes the persistent SAM model cache, forcing the next detection to re-download the ONNX
 * files. Useful while iterating on model URLs in development.
 */
export const clearSamCache = async (): Promise<void> => {
    if (typeof caches === 'undefined') return;
    await caches.delete(CACHE_NAME);
};
