import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearSamCache, fetchOnnx } from '../../../src/internal/sam/cache';

const BUCKET = 'react-canvas-ai-sam-v1';
const URL = 'https://cdn.example.com/model.onnx';

const makeResponse = (ok = true, buffer = new ArrayBuffer(8)) => {
    const response = {
        ok,
        status: ok ? 200 : 404,
        statusText: ok ? 'OK' : 'Not Found',
        clone: vi.fn(),
        arrayBuffer: vi.fn(async () => buffer),
    };
    response.clone.mockReturnValue({ ...response });
    return response;
};

const makeCacheStorage = (match?: { arrayBuffer: () => Promise<ArrayBuffer> }) => {
    const cache = {
        match: vi.fn(async () => match),
        put: vi.fn(async () => undefined),
    };
    const storage = {
        open: vi.fn(async () => cache),
        delete: vi.fn(async () => true),
    };
    return { cache, storage };
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('fetchOnnx', () => {
    it('serves a cached model without touching the network', async () => {
        const buffer = new ArrayBuffer(4);
        const { cache, storage } = makeCacheStorage({ arrayBuffer: async () => buffer });
        const fetchMock = vi.fn();
        vi.stubGlobal('caches', storage);
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchOnnx(URL)).resolves.toBe(buffer);
        expect(cache.match).toHaveBeenCalledWith(URL);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('fetches on a cache miss and persists the response', async () => {
        const buffer = new ArrayBuffer(4);
        const { cache, storage } = makeCacheStorage(undefined);
        const response = makeResponse(true, buffer);
        const fetchMock = vi.fn(async () => response);
        vi.stubGlobal('caches', storage);
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchOnnx(URL)).resolves.toBe(buffer);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(cache.put).toHaveBeenCalledWith(URL, expect.anything());
        // The clone is what gets persisted, so consuming the body afterwards still works.
        expect(response.clone).toHaveBeenCalled();
    });

    it('falls through to the network when Cache Storage is unavailable', async () => {
        const buffer = new ArrayBuffer(4);
        const response = makeResponse(true, buffer);
        const fetchMock = vi.fn(async () => response);
        vi.stubGlobal('caches', undefined);
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchOnnx(URL)).resolves.toBe(buffer);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('falls through to the network when opening the cache throws', async () => {
        const buffer = new ArrayBuffer(4);
        const response = makeResponse(true, buffer);
        const fetchMock = vi.fn(async () => response);
        vi.stubGlobal('caches', {
            open: vi.fn(async () => {
                throw new Error('storage denied');
            }),
        });
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchOnnx(URL)).resolves.toBe(buffer);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    /**
     * Regression: the plugin this was ported from wrapped the whole cache-and-fetch flow in one
     * try/catch, so a genuine 404 was swallowed and the same broken URL fetched a second time.
     */
    it('throws on a failed fetch without retrying', async () => {
        const { storage } = makeCacheStorage(undefined);
        const fetchMock = vi.fn(async () => makeResponse(false));
        vi.stubGlobal('caches', storage);
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchOnnx(URL)).rejects.toThrow(/404/);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('still returns the buffer when persisting it fails', async () => {
        const buffer = new ArrayBuffer(4);
        const { cache, storage } = makeCacheStorage(undefined);
        cache.put.mockRejectedValue(new Error('quota exceeded'));
        const fetchMock = vi.fn(async () => makeResponse(true, buffer));
        vi.stubGlobal('caches', storage);
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchOnnx(URL)).resolves.toBe(buffer);
    });

    it('forwards the abort signal to fetch', async () => {
        const { storage } = makeCacheStorage(undefined);
        const fetchMock = vi.fn(async () => makeResponse());
        vi.stubGlobal('caches', storage);
        vi.stubGlobal('fetch', fetchMock);

        const controller = new AbortController();
        await fetchOnnx(URL, controller.signal);
        expect(fetchMock).toHaveBeenCalledWith(URL, { signal: controller.signal });
    });
});

describe('clearSamCache', () => {
    it('deletes the model bucket', async () => {
        const { storage } = makeCacheStorage();
        vi.stubGlobal('caches', storage);

        await clearSamCache();
        expect(storage.delete).toHaveBeenCalledWith(BUCKET);
    });

    it('is a no-op without Cache Storage', async () => {
        vi.stubGlobal('caches', undefined);
        await expect(clearSamCache()).resolves.toBeUndefined();
    });
});
