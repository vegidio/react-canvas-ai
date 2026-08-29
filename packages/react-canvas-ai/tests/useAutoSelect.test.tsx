import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutoSelectOptions, DetectedObject } from '../src/hooks/useAutoSelect';
import type { Detection, SamEngine } from '../src/internal/sam/engine';
import { useAutoSelect } from '../src/hooks/useAutoSelect';
import { createSamEngine } from '../src/internal/sam/engine';

vi.mock('../src/internal/sam/engine', () => ({ createSamEngine: vi.fn() }));

const DETECTED: DetectedObject = {
    id: 'sam-1',
    score: 0.9,
    bbox: { x: 0, y: 0, width: 2, height: 2 },
    mask: new ImageData(2, 2),
};

/** The engine resolves the object together with the surface it was rasterized on. */
const DETECTION: Detection = { object: DETECTED, silhouette: document.createElement('canvas') };

const makeEngine = (): SamEngine => ({
    prepare: vi.fn(async () => {}),
    detect: vi.fn(async () => DETECTION),
    dispose: vi.fn(),
});

const CONFIG: AutoSelectOptions = { sam: { encoderUrl: 'e.onnx', decoderUrl: 'd.onnx' } };
const IMAGE = { width: 20, height: 10 } as HTMLImageElement;

let engine: SamEngine;

beforeEach(() => {
    engine = makeEngine();
    vi.mocked(createSamEngine).mockReset().mockReturnValue(engine);
});

describe('useAutoSelect', () => {
    it('stays inert without a config', async () => {
        const { result } = renderHook(() => useAutoSelect({ image: IMAGE, shouldWarm: true }));

        expect(result.current.status).toBe('idle');
        await expect(result.current.detect({ x: 1, y: 1 }, { x: 20, y: 10 })).rejects.toThrow(/autoSelect/);
        expect(createSamEngine).not.toHaveBeenCalled();
    });

    it('does not warm until asked, so paint-only sessions never download the model', () => {
        const { result } = renderHook(() => useAutoSelect({ config: CONFIG, image: IMAGE, shouldWarm: false }));

        expect(result.current.status).toBe('idle');
        expect(createSamEngine).not.toHaveBeenCalled();
    });

    it('warms through loading to ready and reports each transition', async () => {
        const statuses: string[] = [];
        const config = { ...CONFIG, onStatusChange: (status: string) => statuses.push(status) };

        const { result } = renderHook(() => useAutoSelect({ config, image: IMAGE, shouldWarm: true }));

        await waitFor(() => expect(result.current.status).toBe('ready'));
        expect(engine.prepare).toHaveBeenCalledWith(IMAGE, expect.any(AbortSignal));
        expect(statuses).toEqual(['loading', 'ready']);
    });

    it('routes a warm-up failure to onError with status error', async () => {
        const onError = vi.fn();
        vi.mocked(engine.prepare).mockRejectedValue(new Error('download failed'));

        const { result } = renderHook(() =>
            useAutoSelect({ config: { ...CONFIG, onError }, image: IMAGE, shouldWarm: true }),
        );

        await waitFor(() => expect(result.current.status).toBe('error'));
        expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'download failed' }));
    });

    it('detects with the loaded image and the configured minScore', async () => {
        const { result } = renderHook(() =>
            useAutoSelect({ config: { ...CONFIG, minScore: 0.5 }, image: IMAGE, shouldWarm: true }),
        );
        await waitFor(() => expect(result.current.status).toBe('ready'));

        let detected: Detection | undefined;
        await act(async () => {
            detected = await result.current.detect({ x: 5, y: 5 }, { x: 20, y: 10 });
        });

        expect(detected).toBe(DETECTION);
        expect(engine.detect).toHaveBeenCalledWith(IMAGE, { x: 5, y: 5 }, { x: 20, y: 10 }, { minScore: 0.5 });
        expect(result.current.status).toBe('ready');
        expect(result.current.isDetecting).toBe(false);
    });

    it('flags isDetecting while a detection is in flight', async () => {
        let release: (value: Detection) => void = () => {};
        vi.mocked(engine.detect).mockImplementation(() => new Promise((resolve) => (release = resolve)));

        const { result } = renderHook(() => useAutoSelect({ config: CONFIG, image: IMAGE, shouldWarm: true }));
        await waitFor(() => expect(result.current.status).toBe('ready'));

        let pending: Promise<Detection | undefined> = Promise.resolve(undefined);
        act(() => {
            pending = result.current.detect({ x: 1, y: 1 }, { x: 20, y: 10 });
        });

        await waitFor(() => expect(result.current.isDetecting).toBe(true));
        expect(result.current.status).toBe('detecting');

        await act(async () => {
            release(DETECTION);
            await pending;
        });
        expect(result.current.isDetecting).toBe(false);
    });

    it('rejects a failed detection without calling onError, so the caller reports it once', async () => {
        const onError = vi.fn();
        vi.mocked(engine.detect).mockRejectedValue(new Error('inference failed'));

        const { result } = renderHook(() =>
            useAutoSelect({ config: { ...CONFIG, onError }, image: IMAGE, shouldWarm: true }),
        );
        await waitFor(() => expect(result.current.status).toBe('ready'));

        await act(async () => {
            await expect(result.current.detect({ x: 1, y: 1 }, { x: 20, y: 10 })).rejects.toThrow('inference failed');
        });

        expect(result.current.status).toBe('error');
        expect(onError).not.toHaveBeenCalled();
    });

    it('rejects a detection before the image has loaded', async () => {
        const { result } = renderHook(() => useAutoSelect({ config: CONFIG, shouldWarm: true }));

        await expect(result.current.detect({ x: 1, y: 1 }, { x: 20, y: 10 })).rejects.toThrow(/image/);
    });

    it('rebuilds the engine when the model config changes, and only then', async () => {
        const { result, rerender } = renderHook(
            (props: { config: AutoSelectOptions }) =>
                useAutoSelect({ config: props.config, image: IMAGE, shouldWarm: true }),
            {
                initialProps: { config: CONFIG },
            },
        );
        await waitFor(() => expect(result.current.status).toBe('ready'));

        // A new options object with the same model settings keeps the engine.
        rerender({ config: { ...CONFIG, minScore: 0.7 } });
        await waitFor(() => expect(result.current.status).toBe('ready'));
        expect(createSamEngine).toHaveBeenCalledTimes(1);

        const rebuilt = makeEngine();
        vi.mocked(createSamEngine).mockReturnValue(rebuilt);
        rerender({ config: { sam: { encoderUrl: 'other.onnx', decoderUrl: 'd.onnx' } } });

        await waitFor(() => expect(rebuilt.prepare).toHaveBeenCalled());
        expect(engine.dispose).toHaveBeenCalled();
        expect(createSamEngine).toHaveBeenCalledTimes(2);
        expect(createSamEngine).toHaveBeenLastCalledWith({ encoderUrl: 'other.onnx', decoderUrl: 'd.onnx' });
    });

    it('re-encodes when a new image element arrives', async () => {
        const { result, rerender } = renderHook(
            (props: { image: HTMLImageElement }) =>
                useAutoSelect({ config: CONFIG, image: props.image, shouldWarm: true }),
            { initialProps: { image: IMAGE } },
        );
        await waitFor(() => expect(result.current.status).toBe('ready'));

        const nextImage = { width: 30, height: 15 } as HTMLImageElement;
        rerender({ image: nextImage });

        await waitFor(() => expect(engine.prepare).toHaveBeenCalledWith(nextImage, expect.any(AbortSignal)));
    });

    it('disposes the engine on unmount', async () => {
        const { result, unmount } = renderHook(() => useAutoSelect({ config: CONFIG, image: IMAGE, shouldWarm: true }));
        await waitFor(() => expect(result.current.status).toBe('ready'));

        unmount();
        expect(engine.dispose).toHaveBeenCalled();
    });
});
