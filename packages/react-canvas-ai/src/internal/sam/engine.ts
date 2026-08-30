import type { Tensor } from 'onnxruntime-web';
import type { SamConfig } from '../../hooks/useAutoSelect';
import type { ScratchCanvas } from '../createCanvas';
import type { BoundingBox, DetectedObject } from '../detection';
import type { Point } from '../geometry';
import { logitsToMask, pickBestMask } from './postprocess';
import { imagePointToInputSpace, imageToEncoderInput } from './preprocess';
import { loadSessions, type SamSessions } from './session';

export type DetectOptions = {
    /** Detections scoring below this are rejected and `detect` resolves `undefined`. */
    minScore?: number;
    /**
     * Abandons the detection instead of running the decoder, for callers whose result has
     * already been superseded — the hover preview, whose pointer has moved on. Checked after
     * the run queue below hands over its slot as well as before, because that wait is where a
     * speculative detection spends most of its life and the decoder pass is the whole cost.
     *
     * It cannot cancel a run that has started: ONNX Runtime offers no such thing.
     */
    signal?: AbortSignal;
};

/**
 * One detection: the shape handed to consumers, plus the surface it was rasterized on.
 *
 * They travel together because they are the same picture in two forms. `object` is the
 * documented output; `silhouette` is what the editor draws, saving a full-frame copy in each
 * direction over putting those pixels back onto a canvas.
 *
 * Single-use: the editor tints the surface in place. `object.mask` and `object.bbox` are read
 * from it lazily and so may be materialized after that tint, which is why `mask`'s contract has
 * always been alpha-only — `source-in` replaces RGB and leaves coverage untouched, so both
 * values are the same ones an eager read would have produced.
 */
export type Detection = {
    object: DetectedObject;
    silhouette: ScratchCanvas;
    /**
     * A box containing the silhouette, for callers that only need somewhere to draw. Measured
     * on the low-res mask, so it is conservative rather than tight — `object.bbox` is exact,
     * and costs a full-frame read to learn.
     */
    paintRect: BoundingBox;
};

/**
 * The SAM inference pipeline behind auto-selection. This module is loaded through a dynamic
 * `import()` only — it is the boundary that keeps `onnxruntime-web` and the pipeline code out
 * of the main bundle for consumers who never configure `autoSelect`.
 */
export type SamEngine = {
    /** Loads the sessions and encodes `image`, so the first click doesn't pay for both. */
    prepare: (image: HTMLImageElement, signal?: AbortSignal) => Promise<void>;
    /**
     * Detects the object at `point` (in canvas pixels), returning a silhouette sized to
     * `target`. Resolves `undefined` when the mask is empty or scores below `minScore`.
     */
    detect: (
        image: HTMLImageElement,
        point: Point,
        target: Point,
        options?: DetectOptions,
    ) => Promise<Detection | undefined>;
    dispose: () => void;
};

type Embedding = {
    image_embeddings: Tensor;
    image_positional_embeddings?: Tensor;
    resizedSize: [number, number];
};

export const createSamEngine = (config: SamConfig): SamEngine => {
    let sessionsPromise: Promise<SamSessions> | undefined;

    // The encode, held as its promise rather than as its result: an awaited settled promise
    // hands back its value for free, so the promise is the cache and there is no second pair of
    // variables to keep in step with it. Storing only the finished embedding meant two callers
    // arriving together — the warm-up and a detection that did not wait for it — each ran a
    // full encoder pass over the same image. Nothing made that likely until hover previews
    // started detecting without being asked to.
    //
    // Keyed on the element's identity: the editor's loader produces a fresh element per `src`,
    // so a new image invalidates the embedding without any explicit escape hatch. The plugin
    // this was ported from keyed on a caller-supplied `source` value and needed a public
    // `invalidateEmbedding()` for the cases where the identity lied.
    let embeddingPromise: Promise<Embedding> | undefined;
    let embeddingKey: HTMLImageElement | undefined;

    // The download's own lifetime, which is the load's — not the image's. Threading a caller's
    // per-image signal down to `fetch` instead aborted a 14 MB download every time `src`
    // changed, before Cache Storage had been written, so the next warm-up started from zero.
    // Recreated per load, so `dispose` cancelling one does not poison the next.
    let loadAbort: AbortController | undefined;

    // One inference at a time, per engine. `InferenceSession.run` is only safe to call serially:
    // the JSEP build drives Emscripten's Asyncify, which cannot be re-entered, and the plain
    // wasm build simply occupies the main thread for the duration, so there was never any
    // concurrency to win. Nothing needed this before hover previews, because nothing ran a
    // decode while another was still going.
    let inferenceQueue: Promise<unknown> = Promise.resolve();

    const runExclusive = <T>(task: () => Promise<T>): Promise<T> => {
        const result = inferenceQueue.then(task);

        // The queue advances through a continuation that swallows, so one failed run cannot
        // reject every run queued behind it. The caller still sees its own rejection, through
        // `result` — which is a different promise from the one the queue holds.
        inferenceQueue = result.then(
            () => {},
            () => {},
        );

        return result;
    };

    const getSessions = (): Promise<SamSessions> => {
        // A failed load is not cached: the next call retries rather than replaying the error
        // forever (a transient network failure would otherwise brick the engine).
        if (!sessionsPromise) {
            const controller = new AbortController();
            loadAbort = controller;
            sessionsPromise = loadSessions(config, controller.signal).catch((error: unknown) => {
                sessionsPromise = undefined;
                throw error;
            });
        }
        return sessionsPromise;
    };

    const encodeImage = async (image: HTMLImageElement): Promise<Embedding> => {
        // Started, not awaited: the download is network-bound and the preprocessing is a
        // straight CPU pass over the pixels, so the first warm-up pays their max rather than
        // their sum. The no-op catch keeps a throw from `imageToEncoderInput` — which would
        // leave the promise unawaited — from surfacing as an unhandled rejection.
        const pending = getSessions();
        pending.catch(() => {});

        const pre = imageToEncoderInput(image);
        const sessions = await pending;

        const pixelValues = new sessions.ort.Tensor('float32', pre.data, [...pre.dims]);
        const inputName = sessions.encoder.inputNames[0] ?? 'pixel_values';
        const encoderOutput = await runExclusive(() => sessions.encoder.run({ [inputName]: pixelValues }));

        const image_embeddings = findTensor(encoderOutput, ['image_embeddings', 'last_hidden_state', 'image_features']);
        if (!image_embeddings) {
            throw new Error(
                `SAM encoder did not return an image_embeddings tensor. Got outputs: ${Object.keys(encoderOutput).join(', ')}`,
            );
        }

        const image_positional_embeddings = findTensor(encoderOutput, ['image_positional_embeddings', 'pe_layer']);

        const next: Embedding = { image_embeddings, resizedSize: pre.resizedSize };
        if (image_positional_embeddings) next.image_positional_embeddings = image_positional_embeddings;

        return next;
    };

    /**
     * The image embedding, encoding it at most once no matter how many callers ask at once.
     *
     * `signal` is checked per caller rather than threaded into the shared encode, which is the
     * whole point of sharing it: an aborted warm-up must abandon its own `prepare`, not reject
     * the detection that joined the same encode and still wants the answer. The trade is that
     * an abort arriving mid-encode no longer skips the encoder pass — a run ONNX Runtime gives
     * us no way to cancel anyway, and whose result is cached for the next caller regardless.
     */
    const ensureEmbedding = async (image: HTMLImageElement, signal?: AbortSignal): Promise<Embedding> => {
        if (!embeddingPromise || embeddingKey !== image) {
            // Checked before starting, not only after awaiting: a caller who has already given
            // up must not kick off a 14 MB encode that nothing is waiting for. A caller joining
            // an encode already in flight skips this — the run is happening regardless, and its
            // result is cached for whoever comes next.
            if (signal?.aborted) throw new Error('SAM image encoding was aborted.');

            embeddingKey = image;
            // A failed encode is not cached, for the reason `getSessions` does not cache a
            // failed load: the next click retries instead of replaying the error forever.
            embeddingPromise = encodeImage(image).catch((error: unknown) => {
                if (embeddingKey === image) {
                    embeddingPromise = undefined;
                    embeddingKey = undefined;
                }
                throw error;
            });
        }

        const result = await embeddingPromise;
        if (signal?.aborted) throw new Error('SAM image encoding was aborted.');
        return result;
    };

    return {
        prepare: async (image, signal) => {
            await ensureEmbedding(image, signal);
        },
        detect: async (image, point, target, options) => {
            const signal = options?.signal;
            if (signal?.aborted) return undefined;

            const emb = await ensureEmbedding(image, signal);
            const sessions = await getSessions();
            const { ort } = sessions;

            const [inputX, inputY] = imagePointToInputSpace(point, target, emb.resizedSize);
            const input_points = new ort.Tensor('float32', Float32Array.from([inputX, inputY]), [1, 1, 1, 2]);
            const input_labels = new ort.Tensor('int64', BigInt64Array.from([1n]), [1, 1, 1]);

            const decoderInputs: Record<string, Tensor> = {
                image_embeddings: emb.image_embeddings,
                input_points,
                input_labels,
            };
            if (emb.image_positional_embeddings) {
                decoderInputs.image_positional_embeddings = emb.image_positional_embeddings;
            }

            // Different SAM exports want different input sets; feeding one an extra tensor is an
            // error, so only the names the session declares are passed.
            const filtered: Record<string, Tensor> = {};
            for (const name of sessions.decoder.inputNames) {
                const match = decoderInputs[name];
                if (match) filtered[name] = match;
            }

            // Checked inside the queued task, not before it. A speculative detection spends
            // almost all of its life waiting for whatever run is already going, so testing the
            // signal on the way into the queue tests it at the one moment it cannot yet have
            // been set — by the time the slot is free the pointer has usually moved on, and the
            // decoder pass is the entire cost worth avoiding.
            const decoderOutput = await runExclusive(async () => {
                if (signal?.aborted) return undefined;
                return sessions.decoder.run(filtered);
            });
            if (!decoderOutput) return undefined;
            const iouTensor = findTensor(decoderOutput, ['iou_scores', 'iou_predictions']);
            const masksTensor = findTensor(decoderOutput, ['pred_masks', 'masks', 'low_res_masks']);

            if (!iouTensor || !masksTensor) {
                throw new Error(`SAM decoder returned unexpected outputs: ${Object.keys(decoderOutput).join(', ')}`);
            }

            const iouData = iouTensor.data as Float32Array;
            const masksData = masksTensor.data as Float32Array;
            const maskDims = masksTensor.dims;

            const numMasks = maskDims[maskDims.length - 3] ?? 3;
            const maskH = maskDims[maskDims.length - 2] ?? 256;
            const maskW = maskDims[maskDims.length - 1] ?? 256;

            const bestIdx = pickBestMask(iouData, numMasks);
            const bestScore = iouData[bestIdx] ?? 0;
            if (bestScore < (options?.minScore ?? 0)) return undefined;

            const maskStart = bestIdx * maskH * maskW;
            const bestLogits = masksData.subarray(maskStart, maskStart + maskH * maskW);

            const rasterized = logitsToMask(bestLogits, [maskH, maskW], emb.resizedSize, target.x, target.y);

            // Judged on the low-res mask, which is the one pass that has already happened. The
            // full-resolution box says the same thing about emptiness and costs a megabyte-scale
            // readback to ask, which a speculative detection should never pay.
            if (rasterized.isEmpty) return undefined;

            const object: DetectedObject = {
                id: `sam-${Date.now()}`,
                score: bestScore,
                // Accessors, so a hover preview — which reads neither — pays for neither.
                get bbox() {
                    return rasterized.readBbox();
                },
                get mask() {
                    return rasterized.readMask();
                },
            };

            return { object, silhouette: rasterized.silhouette, paintRect: rasterized.paintRect };
        },
        dispose: () => {
            // Dropping the reference is all that is needed: the run itself is uncancellable and
            // its result is now unreachable. It has to go, or a `detect` after `dispose` would
            // await a promise whose sessions have since been released.
            embeddingPromise = undefined;
            embeddingKey = undefined;

            // Dropping the reference is not enough: an `InferenceSession` owns WASM-heap
            // allocations — the deserialized graph and the runtime's arena — that JS garbage
            // collection cannot reclaim. Only `release()` frees them, so without this every
            // config change and every unmount leaked two models' worth of memory.
            const pending = sessionsPromise;
            sessionsPromise = undefined;
            loadAbort?.abort();
            loadAbort = undefined;

            void pending
                ?.then((s) => Promise.all([s.encoder.release(), s.decoder.release()]))
                .catch(() => {
                    // A load that never finished has nothing to release.
                });
        },
    };
};

const findTensor = (output: Record<string, Tensor>, candidateNames: readonly string[]): Tensor | undefined => {
    for (const name of candidateNames) {
        const tensor = output[name];
        if (tensor) return tensor;
    }

    return undefined;
};
