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
