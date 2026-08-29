import type { Tensor } from 'onnxruntime-web';
import type { DetectedObject, SamConfig } from '../../hooks/useAutoSelect';
import type { Point } from '../geometry';
import { logitsToMask, pickBestMask } from './postprocess';
import { imagePointToInputSpace, imageToEncoderInput } from './preprocess';
import { loadSessions, type SamSessions } from './session';

export type DetectOptions = {
    /** Detections scoring below this are rejected and `detect` resolves `undefined`. */
    minScore?: number;
    signal?: AbortSignal;
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
    ) => Promise<DetectedObject | undefined>;
    dispose: () => void;
};

type Embedding = {
    image_embeddings: Tensor;
    image_positional_embeddings?: Tensor;
    resizedSize: [number, number];
};

export const createSamEngine = (config: SamConfig): SamEngine => {
    let sessionsPromise: Promise<SamSessions> | undefined;
    let embedding: Embedding | undefined;
    // Keyed on the element's identity: the editor's loader produces a fresh element per `src`,
    // so a new image invalidates the embedding without any explicit escape hatch. The plugin
    // this was ported from keyed on a caller-supplied `source` value and needed a public
    // `invalidateEmbedding()` for the cases where the identity lied.
    let embeddingKey: HTMLImageElement | undefined;

    const getSessions = (signal?: AbortSignal): Promise<SamSessions> => {
        // A failed load is not cached: the next call retries rather than replaying the error
        // forever (a transient network failure would otherwise brick the engine).
        if (!sessionsPromise) {
            sessionsPromise = loadSessions(config, signal).catch((error: unknown) => {
                sessionsPromise = undefined;
                throw error;
            });
        }
        return sessionsPromise;
    };

    const ensureEmbedding = async (image: HTMLImageElement, signal?: AbortSignal): Promise<Embedding> => {
        if (embedding && embeddingKey === image) return embedding;

        const sessions = await getSessions(signal);
        const ort = await import('onnxruntime-web');
        const pre = imageToEncoderInput(image);
        const pixelValues = new ort.Tensor('float32', pre.data, [...pre.dims]);
        const inputName = sessions.encoderInputNames[0] ?? 'pixel_values';
        const encoderOutput = await sessions.encoder.run({ [inputName]: pixelValues });

        const image_embeddings = findTensor(encoderOutput, ['image_embeddings', 'last_hidden_state', 'image_features']);
        if (!image_embeddings) {
            throw new Error(
                `SAM encoder did not return an image_embeddings tensor. Got outputs: ${Object.keys(encoderOutput).join(', ')}`,
            );
        }

        const image_positional_embeddings = findTensor(encoderOutput, ['image_positional_embeddings', 'pe_layer']);

        const next: Embedding = { image_embeddings, resizedSize: pre.resizedSize };
        if (image_positional_embeddings) next.image_positional_embeddings = image_positional_embeddings;

        embedding = next;
        embeddingKey = image;
        return embedding;
    };

    return {
        prepare: async (image, signal) => {
            await ensureEmbedding(image, signal);
        },
        detect: async (image, point, target, options) => {
            const sessions = await getSessions(options?.signal);
            const emb = await ensureEmbedding(image, options?.signal);
            const ort = await import('onnxruntime-web');

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
            for (const name of sessions.decoderInputNames) {
                const match = decoderInputs[name];
                if (match) filtered[name] = match;
            }

            const decoderOutput = await sessions.decoder.run(filtered);
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

            const { mask, bbox } = logitsToMask(bestLogits, [maskH, maskW], emb.resizedSize, target.x, target.y);
            if (bbox.width === 0 || bbox.height === 0) return undefined;

            return { id: `sam-${Date.now()}`, score: bestScore, bbox, mask };
        },
        dispose: () => {
            embedding = undefined;
            embeddingKey = undefined;
            sessionsPromise = undefined;
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
