import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadImage } from '../../src/internal/loadImage';
import { mockImageLoad } from '../helpers/image';

let restore: (() => void) | undefined;

afterEach(() => {
    restore?.();
    restore = undefined;
});

const stubFetch = (ok = true) =>
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok,
        statusText: ok ? 'OK' : 'Not Found',
        blob: async () => new Blob(['x'], { type: 'image/png' }),
    } as Response);

describe('loadImage', () => {
    it('rejects an empty source', async () => {
        await expect(loadImage('')).rejects.toThrow('No image source provided');
    });

    it('loads a data URL directly without fetching', async () => {
        restore = mockImageLoad({ width: 40, height: 20 });
        const fetchSpy = stubFetch();

        const img = await loadImage('data:image/png;base64,AAA');

        expect(img.naturalWidth).toBe(40);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('routes remote sources through fetch to avoid tainting the canvas', async () => {
        restore = mockImageLoad({ width: 10, height: 10 });
        const fetchSpy = stubFetch();

        await loadImage('https://example.com/a.png');

        expect(fetchSpy).toHaveBeenCalledWith('https://example.com/a.png', expect.anything());
    });

    it('hands the decoder a blob URL rather than a base64 data URL', async () => {
        restore = mockImageLoad({ width: 10, height: 10 });
        stubFetch();
        const created = vi.spyOn(URL, 'createObjectURL');

        const img = await loadImage('https://example.com/a.png');

        expect(created).toHaveBeenCalledTimes(1);
        expect(img.src).toBe(created.mock.results[0]?.value);
        expect(img.src.startsWith('blob:')).toBe(true);
    });

    it('revokes the blob URL once the image has decoded', async () => {
        restore = mockImageLoad({ width: 10, height: 10 });
        stubFetch();
        const created = vi.spyOn(URL, 'createObjectURL');
        const revoked = vi.spyOn(URL, 'revokeObjectURL');

        await loadImage('https://example.com/a.png');

        expect(revoked).toHaveBeenCalledWith(created.mock.results[0]?.value);
    });

    it('revokes the blob URL when the load fails', async () => {
        restore = mockImageLoad({ width: 10, height: 10, fail: true });
        stubFetch();
        const created = vi.spyOn(URL, 'createObjectURL');
        const revoked = vi.spyOn(URL, 'revokeObjectURL');

        await expect(loadImage('https://example.com/a.png')).rejects.toThrow('Failed to load image');
        expect(revoked).toHaveBeenCalledWith(created.mock.results[0]?.value);
    });

    it('falls back to a direct load when the fetch fails', async () => {
        restore = mockImageLoad({ width: 10, height: 10 });
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

        await expect(loadImage('https://example.com/a.png')).resolves.toBeInstanceOf(HTMLImageElement);
    });

    it('applies the requested crossOrigin, defaulting to anonymous', async () => {
        restore = mockImageLoad({ width: 10, height: 10 });

        await expect(loadImage('local.png')).resolves.toHaveProperty('crossOrigin', 'anonymous');
        await expect(loadImage('local.png', { crossOrigin: 'use-credentials' })).resolves.toHaveProperty(
            'crossOrigin',
            'use-credentials',
        );
    });

    it('rejects when the image fails to decode', async () => {
        restore = mockImageLoad({ width: 10, height: 10, fail: true });
        await expect(loadImage('broken.png')).rejects.toThrow('Failed to load image');
    });

    it('rejects immediately when the signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(loadImage('local.png', { signal: controller.signal })).rejects.toThrow('aborted');
    });

    it('rejects a pending decode when the signal aborts', async () => {
        // No mockImageLoad here: `src` never fires, so the promise stays pending until abort.
        const controller = new AbortController();
        const pending = loadImage('local.png', { signal: controller.signal });
        controller.abort();
        await expect(pending).rejects.toThrow('aborted');
    });
});
