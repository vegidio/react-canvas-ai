import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSamEngine } from '../../../src/internal/sam/engine';
import { logitsToMask } from '../../../src/internal/sam/postprocess';
import { imageToEncoderInput } from '../../../src/internal/sam/preprocess';
import { loadSessions } from '../../../src/internal/sam/session';

const { FakeTensor } = vi.hoisted(() => {
    class FakeTensor {
        type: string;
        data: unknown;
        dims: number[];
        constructor(type: string, data: unknown, dims: number[]) {
            this.type = type;
            this.data = data;
            this.dims = dims;
        }
    }
    return { FakeTensor };
});

vi.mock('onnxruntime-web', () => ({ Tensor: FakeTensor }));
vi.mock('../../../src/internal/sam/session', () => ({ loadSessions: vi.fn() }));
vi.mock('../../../src/internal/sam/preprocess', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    imageToEncoderInput: vi.fn(),
}));
vi.mock('../../../src/internal/sam/postprocess', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    logitsToMask: vi.fn(),
}));

const CONFIG = { encoderUrl: 'e.onnx', decoderUrl: 'd.onnx' };
const IMAGE = { width: 200, height: 100 } as HTMLImageElement;
const TARGET = { x: 200, y: 100 };

const encoderRun = vi.fn();
const decoderRun = vi.fn();
const encoderRelease = vi.fn(async () => undefined);
const decoderRelease = vi.fn(async () => undefined);

/** The shape `loadSessions` resolves to: both sessions plus the runtime they were made with. */
const makeSessions = (decoderInputNames: string[]) => ({
    ort: { Tensor: FakeTensor },
    encoder: { run: encoderRun, inputNames: ['pixel_values'], release: encoderRelease },
    decoder: { run: decoderRun, inputNames: decoderInputNames, release: decoderRelease },
});

/** What `logitsToMask` hands back: the pixels, their box, and the surface they were drawn on. */
const makeRasterized = (bbox: { x: number; y: number; width: number; height: number }) => ({
    mask: new ImageData(2, 2),
    bbox,
    silhouette: document.createElement('canvas'),
});

/** Fabricates a decoder output: 3 candidate masks of 4×4 logits, plane i filled with i + 1. */
const makeDecoderOutput = (iou: number[]) => {
    const masks = new Float32Array(3 * 4 * 4);
    for (let plane = 0; plane < 3; plane += 1) masks.fill(plane + 1, plane * 16, (plane + 1) * 16);
    return {
        iou_scores: { data: Float32Array.from(iou), dims: [1, 1, 3] },
        pred_masks: { data: masks, dims: [1, 1, 3, 4, 4] },
    };
};

beforeEach(() => {
    encoderRelease.mockClear();
    decoderRelease.mockClear();
    vi.mocked(loadSessions)
        .mockReset()
        .mockResolvedValue(makeSessions(['image_embeddings', 'input_points', 'input_labels']) as never);
    vi.mocked(imageToEncoderInput)
        .mockReset()
        .mockReturnValue({ data: new Float32Array(4), dims: [1, 3, 1024, 1024], resizedSize: [1024, 512] });
    vi.mocked(logitsToMask)
        .mockReset()
        .mockReturnValue(makeRasterized({ x: 0, y: 0, width: 2, height: 2 }));
    encoderRun.mockReset().mockResolvedValue({ image_embeddings: { name: 'emb' } });
    decoderRun.mockReset().mockResolvedValue(makeDecoderOutput([0.1, 0.8, 0.3]));
});

describe('createSamEngine', () => {
    it('detects the best-IoU mask and returns it with its score', async () => {
        const engine = createSamEngine(CONFIG);
        const detected = await engine.detect(IMAGE, { x: 100, y: 50 }, TARGET);

        // Float32Array storage rounds 0.8 to the nearest representable float.
        expect(detected?.object.score).toBeCloseTo(0.8, 5);
        expect(detected?.object.id).toMatch(/^sam-/);
        expect(detected?.object.bbox).toEqual({ x: 0, y: 0, width: 2, height: 2 });
        // The surface travels with the object so compositing need not rebuild it from `mask`.
        expect(detected?.silhouette).toBeDefined();

        // The logits slice handed to postprocess must be the winning plane (index 1).
        const [logits, shape, resized, targetW, targetH] = vi.mocked(logitsToMask).mock.calls[0];
        expect(logits[0]).toBe(2);
        expect(shape).toEqual([4, 4]);
        expect(resized).toEqual([1024, 512]);
        expect(targetW).toBe(200);
        expect(targetH).toBe(100);
    });

    it('prompts in input space, normalized by the canvas size', async () => {
        const engine = createSamEngine(CONFIG);
        await engine.detect(IMAGE, { x: 100, y: 50 }, TARGET);

        const inputs = decoderRun.mock.calls[0][0] as Record<string, InstanceType<typeof FakeTensor>>;
        const points = inputs.input_points;
        expect([...(points.data as Float32Array)]).toEqual([512, 256]);
        expect(points.dims).toEqual([1, 1, 1, 2]);
        expect([...(inputs.input_labels.data as BigInt64Array)]).toEqual([1n]);
    });

    it('encodes once per image element and again for a new element', async () => {
        const engine = createSamEngine(CONFIG);
        await engine.prepare(IMAGE);
        await engine.detect(IMAGE, { x: 1, y: 1 }, TARGET);
        expect(encoderRun).toHaveBeenCalledTimes(1);

        await engine.detect({ ...IMAGE } as HTMLImageElement, { x: 1, y: 1 }, TARGET);
        expect(encoderRun).toHaveBeenCalledTimes(2);
    });

    it('rejects detections below minScore without rasterizing', async () => {
        const engine = createSamEngine(CONFIG);
        const detected = await engine.detect(IMAGE, { x: 1, y: 1 }, TARGET, { minScore: 0.9 });

        expect(detected).toBeUndefined();
        expect(logitsToMask).not.toHaveBeenCalled();
    });

    it('treats an empty mask as no detection', async () => {
        vi.mocked(logitsToMask).mockReturnValue(makeRasterized({ x: 0, y: 0, width: 0, height: 0 }));

        const engine = createSamEngine(CONFIG);
        await expect(engine.detect(IMAGE, { x: 1, y: 1 }, TARGET)).resolves.toBeUndefined();
    });

    it('feeds the decoder only the inputs its export declares', async () => {
        encoderRun.mockResolvedValue({
            image_embeddings: { name: 'emb' },
            image_positional_embeddings: { name: 'pos' },
        });

        const engine = createSamEngine(CONFIG);
        await engine.detect(IMAGE, { x: 1, y: 1 }, TARGET);

        // The session above does not declare image_positional_embeddings, so it is filtered out
        // even though the encoder produced one.
        expect(Object.keys(decoderRun.mock.calls[0][0])).toEqual(['image_embeddings', 'input_points', 'input_labels']);
    });

    it('passes positional embeddings through when the decoder wants them', async () => {
        vi.mocked(loadSessions).mockResolvedValue(
            makeSessions(['image_embeddings', 'image_positional_embeddings', 'input_points', 'input_labels']) as never,
        );
        encoderRun.mockResolvedValue({
            image_embeddings: { name: 'emb' },
            image_positional_embeddings: { name: 'pos' },
        });

        const engine = createSamEngine(CONFIG);
        await engine.detect(IMAGE, { x: 1, y: 1 }, TARGET);

        expect(Object.keys(decoderRun.mock.calls[0][0])).toContain('image_positional_embeddings');
    });

    it('names the encoder outputs when no embeddings tensor is found', async () => {
        encoderRun.mockResolvedValue({ something_else: {} });

        const engine = createSamEngine(CONFIG);
        await expect(engine.prepare(IMAGE)).rejects.toThrow(/something_else/);
    });

    it('names the decoder outputs when they are not the expected tensors', async () => {
        decoderRun.mockResolvedValue({ mystery: {} });

        const engine = createSamEngine(CONFIG);
        await expect(engine.detect(IMAGE, { x: 1, y: 1 }, TARGET)).rejects.toThrow(/mystery/);
    });

    it('drops sessions and embedding on dispose', async () => {
        const engine = createSamEngine(CONFIG);
        await engine.prepare(IMAGE);
        engine.dispose();
        await engine.prepare(IMAGE);

        expect(loadSessions).toHaveBeenCalledTimes(2);
        expect(encoderRun).toHaveBeenCalledTimes(2);
    });

    /**
     * Dropping the reference is not enough: an `InferenceSession` owns WASM-heap allocations
     * that JS garbage collection cannot reclaim, so every dispose without this leaked two
     * models' worth of memory for the lifetime of the page.
     */
    it('releases both sessions on dispose', async () => {
        const engine = createSamEngine(CONFIG);
        await engine.prepare(IMAGE);
        engine.dispose();
        await vi.waitFor(() => {
            expect(encoderRelease).toHaveBeenCalledTimes(1);
            expect(decoderRelease).toHaveBeenCalledTimes(1);
        });
    });

    it('survives disposing before the load has resolved', async () => {
        vi.mocked(loadSessions).mockReturnValue(new Promise(() => {}) as never);

        const engine = createSamEngine(CONFIG);
        void engine.prepare(IMAGE).catch(() => {});
        expect(() => engine.dispose()).not.toThrow();
    });

    it('retries a failed session load instead of caching the rejection', async () => {
        vi.mocked(loadSessions).mockRejectedValueOnce(new Error('network down'));

        const engine = createSamEngine(CONFIG);
        await expect(engine.prepare(IMAGE)).rejects.toThrow('network down');
        await expect(engine.prepare(IMAGE)).resolves.toBeUndefined();
    });
});

describe('createSamEngine concurrency', () => {
    /**
     * Lets every pending microtask run. `await Promise.resolve()` advances only one tick, and
     * `detect` awaits the embedding and the sessions before it ever reaches the decoder.
     */
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

    /** A promise plus the handles to settle it from the test. */
    const deferred = <T>() => {
        let resolve!: (value: T) => void;
        const promise = new Promise<T>((r) => {
            resolve = r;
        });
        return { promise, resolve };
    };

    /**
     * `InferenceSession.run` is only safe to call serially: the JSEP build drives Emscripten's
     * Asyncify, which cannot be re-entered, and the plain wasm build simply occupies the main
     * thread. Nothing ran two at once until hover previews started detecting alongside clicks.
     */
    it('never has two decoder runs outstanding at the same time', async () => {
        const first = deferred<unknown>();
        const second = deferred<unknown>();
        let outstanding = 0;
        let peak = 0;

        decoderRun.mockReset().mockImplementation(() => {
            outstanding += 1;
            peak = Math.max(peak, outstanding);
            const pending = decoderRun.mock.calls.length === 1 ? first.promise : second.promise;
            return pending.then((value) => {
                outstanding -= 1;
                return value;
            });
        });

        const engine = createSamEngine(CONFIG);
        await engine.prepare(IMAGE);

        const a = engine.detect(IMAGE, { x: 1, y: 1 }, TARGET);
        const b = engine.detect(IMAGE, { x: 2, y: 2 }, TARGET);
        await flush();

        // The second is still queued behind the first, not running alongside it.
        expect(decoderRun).toHaveBeenCalledTimes(1);

        first.resolve(makeDecoderOutput([0.1, 0.8, 0.3]));
        await a;
        expect(decoderRun).toHaveBeenCalledTimes(2);

        second.resolve(makeDecoderOutput([0.1, 0.8, 0.3]));
        await b;
        expect(peak).toBe(1);
    });

    /** One failed run must not reject everything queued behind it. */
    it('keeps serving the queue after a run rejects', async () => {
        decoderRun
            .mockReset()
            .mockRejectedValueOnce(new Error('decoder exploded'))
            .mockResolvedValue(makeDecoderOutput([0.1, 0.8, 0.3]));

        const engine = createSamEngine(CONFIG);
        await engine.prepare(IMAGE);

        const failed = engine.detect(IMAGE, { x: 1, y: 1 }, TARGET);
        const next = engine.detect(IMAGE, { x: 2, y: 2 }, TARGET);

        await expect(failed).rejects.toThrow('decoder exploded');
        await expect(next).resolves.toBeDefined();
    });

    /**
     * Only the settled embedding was checked before, so a detection arriving while the warm-up
     * was still encoding ran a second full encoder pass over the very same image. A hover
     * preview lands in that window every time the model is still warming.
     */
    it('encodes once when a detection joins an encode already in flight', async () => {
        const gate = deferred<unknown>();
        encoderRun.mockReset().mockImplementation(() => gate.promise);

        const engine = createSamEngine(CONFIG);
        const warm = engine.prepare(IMAGE);
        const detecting = engine.detect(IMAGE, { x: 1, y: 1 }, TARGET);
        await flush();

        gate.resolve({ image_embeddings: { name: 'emb' } });
        await warm;
        await detecting;

        expect(encoderRun).toHaveBeenCalledTimes(1);
    });

    /**
     * Per caller, not baked into the shared encode: an aborted warm-up must abandon its own
     * `prepare`, not reject the detection that joined the same encode and still wants the answer.
     */
    it('does not let an aborted warm-up reject the detection sharing its encode', async () => {
        const gate = deferred<unknown>();
        encoderRun.mockReset().mockImplementation(() => gate.promise);

        const engine = createSamEngine(CONFIG);
        const controller = new AbortController();
        const warm = engine.prepare(IMAGE, controller.signal);
        const detecting = engine.detect(IMAGE, { x: 1, y: 1 }, TARGET);
        await flush();

        controller.abort();
        gate.resolve({ image_embeddings: { name: 'emb' } });

        await expect(warm).rejects.toThrow('aborted');
        await expect(detecting).resolves.toBeDefined();
    });

    it('retries the encode after a failed one rather than caching the error', async () => {
        encoderRun
            .mockReset()
            .mockRejectedValueOnce(new Error('encoder exploded'))
            .mockResolvedValue({ image_embeddings: { name: 'emb' } });

        const engine = createSamEngine(CONFIG);
        await expect(engine.detect(IMAGE, { x: 1, y: 1 }, TARGET)).rejects.toThrow('encoder exploded');
        await expect(engine.detect(IMAGE, { x: 1, y: 1 }, TARGET)).resolves.toBeDefined();
    });

    it('abandons an aborted detection without running the decoder', async () => {
        const engine = createSamEngine(CONFIG);
        await engine.prepare(IMAGE);
        decoderRun.mockClear();

        const controller = new AbortController();
        controller.abort();

        await expect(engine.detect(IMAGE, { x: 1, y: 1 }, TARGET, { signal: controller.signal })).resolves.toBe(
            undefined,
        );
        expect(decoderRun).not.toHaveBeenCalled();
    });

    /** Aborted while queued behind another run: the decoder pass is the whole cost to avoid. */
    it('abandons a detection aborted while it waits for its turn', async () => {
        const gate = deferred<unknown>();
        decoderRun.mockReset().mockImplementationOnce(() => gate.promise);

        const engine = createSamEngine(CONFIG);
        await engine.prepare(IMAGE);

        const blocker = engine.detect(IMAGE, { x: 1, y: 1 }, TARGET);
        const controller = new AbortController();
        const queued = engine.detect(IMAGE, { x: 2, y: 2 }, TARGET, { signal: controller.signal });
        await flush();

        controller.abort();
        gate.resolve(makeDecoderOutput([0.1, 0.8, 0.3]));

        await blocker;
        await expect(queued).resolves.toBe(undefined);
        expect(decoderRun).toHaveBeenCalledTimes(1);
    });
});
