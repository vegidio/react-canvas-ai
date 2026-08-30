import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DetectedObject } from '../internal/detection';
import type { Point } from '../internal/geometry';
import type { Detection, DetectOptions, SamEngine } from '../internal/sam/engine';
import { toError } from '../internal/toError';
import { useEventCallback, useLatest } from '../internal/useLatest';

export type { BoundingBox, DetectedObject } from '../internal/detection';

/** Configuration for the bundled SAM (SlimSAM-77) backend. */
export type SamConfig = {
    /** URL of the quantized vision encoder ONNX file. */
    encoderUrl: string;
    /** URL of the quantized combined prompt_encoder + mask_decoder ONNX file. */
    decoderUrl: string;
    /** Optional override for `ort.env.wasm.wasmPaths`. Set only when provided. */
    wasmPaths?: string;
    /**
     * ONNX Runtime execution providers, in preference order. Defaults to `['wasm']` because
     * `onnxruntime-web@1.24`'s WebGPU EP produces corrupt output for the INT8-quantized
     * SlimSAM-77 export (some ops fall back to CPU and the EP boundary mangles quantized
     * activations).
     */
    executionProviders?: ('webgpu' | 'wasm')[];
    /**
     * Logs encoder/decoder input and output tensor names to `console.info` on the first model
     * load. Useful when validating a new ONNX export or debugging "decoder returned unexpected
     * outputs" errors. Off by default.
     */
    debug?: boolean;
};

/** Lifecycle state of the auto-selection backend. */
export type AutoSelectStatus = 'idle' | 'loading' | 'ready' | 'detecting' | 'error';

/**
 * The backend's standing state, with `'detecting'` left out: that one is not a state the
 * engine settles into but a count of calls in flight, and modelling it as a fifth state meant
 * writing the lifecycle down twice and reconciling the two by hand.
 */
type EnginePhase = 'idle' | 'loading' | 'ready' | 'error';

/** Options for the editor's AI auto-selection mode. */
export type AutoSelectOptions = {
    /** SlimSAM model configuration. Required — auto-selection is SAM-only. */
    sam: SamConfig;
    /**
     * Warms the sessions and image embedding as soon as the image decodes, instead of on the
     * first switch to `'auto'` mode. Off by default so paint-only sessions never pay for the
     * model download.
     */
    preload?: boolean;
    /** Detections scoring below this are discarded — the click paints nothing. */
    minScore?: number;
    /**
     * Draws the object under the cursor as an uncommitted overlay while the pointer moves over
     * the image in `'auto'` mode, so the extent of a selection is visible before it is made.
     * A click commits what is shown; nothing else does.
     *
     * The overlay appears on the move itself rather than after a pause, and every position is
     * detected — including one inside the shape already drawn, so a smaller object nested in a
     * larger selection stays reachable.
     *
     * Off by default: every hover that settles costs a decoder pass, and a consumer who only
     * wants click-to-segment should not pay for one.
     */
    preview?: boolean;
    /** Called after a detection has been committed to the mask canvas. */
    onObjectDetected?: (object: DetectedObject) => void;
    /** Called when the model load or a detection fails. */
    onError?: (error: Error) => void;
    /**
     * Lifecycle notifications, for consumers of the `MaskEditor` component. Hook and provider
     * consumers can read `autoSelectStatus` from the return value instead.
     */
    onStatusChange?: (status: AutoSelectStatus) => void;
};

export type UseAutoSelectOptions = {
    /** The editor's `autoSelect` prop; `undefined` keeps the hook inert. */
    config?: AutoSelectOptions;
    /** The decoded image from the editor's loader — never refetched or redecoded here. */
    image?: HTMLImageElement;
    /** True once the editor wants the model warm: `preload`, or auto mode was entered. */
    shouldWarm: boolean;
};

/** Per-call options for {@link UseAutoSelectReturn.detect}. */
export type DetectRequest = {
    /**
     * Marks a speculative detection — one the hover preview asked for, that the user did not.
     * It stays out of `pending` and leaves `phase` alone, so a hover cannot flip `status` to
     * `'detecting'`, cannot swap the container cursor to `progress`, and — the one that
     * actually bites — cannot make the editor's one-at-a-time guard drop the very click the
     * preview was preparing the user to make.
     */
    preview?: boolean;
    /** Abandons the detection before the decoder, for a preview the pointer has moved past. */
    signal?: AbortSignal;
};

export type UseAutoSelectReturn = {
    status: AutoSelectStatus;
    isDetecting: boolean;
    /**
     * Runs a detection at `point` (canvas pixels), silhouette sized to `target`. Resolves
     * `undefined` for an empty, below-`minScore` or aborted result. Rejections are the
     * caller's to route — only warm-up failures reach `onError` from here, or a failed
     * detection would be reported twice.
     *
     * Resolves the {@link Detection} pair rather than the bare object: the editor composites
     * from the surface and hands `object` on to consumers.
     */
    detect: (point: Point, target: Point, request?: DetectRequest) => Promise<Detection | undefined>;
};

/**
 * The engine is rebuilt when any of these change; everything else on the options object can
 * change freely without throwing away sessions and embedding.
 */
const samConfigKey = (sam: SamConfig): string =>
    JSON.stringify([sam.encoderUrl, sam.decoderUrl, sam.wasmPaths, sam.executionProviders, sam.debug]);

/**
 * Owns the SAM engine lifecycle for `useMaskEditor`: lazy loading of the inference chunk,
 * warm-up, status, and teardown.
 *
 * The `await import('../internal/sam/engine')` below is the only runtime edge into the SAM
 * code — everything else imports it as types only — which is what keeps `onnxruntime-web`
 * and the pipeline out of the main bundle for paint-only consumers.
 */
export const useAutoSelect = (options: UseAutoSelectOptions): UseAutoSelectReturn => {
    const { config, image, shouldWarm } = options;

    const [phase, setPhase] = useState<EnginePhase>('idle');
    // Counted rather than a boolean: `selectAt` can overlap a click, and the first one to
    // finish must not clear the flag while the other is still running.
    const [pending, setPending] = useState(0);

    // Both derived from the one pair above, so the two can never describe different moments —
    // as separate state they could, and did: overlapping detections published `'ready'` while
    // `isDetecting` was still true.
    const isDetecting = pending > 0;
    const status: AutoSelectStatus = isDetecting ? 'detecting' : phase;

    const samKey = config ? samConfigKey(config.sam) : undefined;

    const configRef = useLatest(config);
    const imageRef = useLatest(image);
    const engineRef = useRef<{ key: string; engine: SamEngine } | undefined>(undefined);
    const warmAbortRef = useRef<AbortController | undefined>(undefined);

    const notifyStatusChange = useEventCallback<[AutoSelectStatus]>(config?.onStatusChange);
    const notifyError = useEventCallback<[Error]>(config?.onError);

    // Mirrors committed status changes to the component-consumer callback. An effect rather
    // than calls next to each `setPhase`: those run inside async continuations where a stale
    // closure could report transitions out of order.
    const lastNotifiedRef = useRef<AutoSelectStatus>('idle');
    useEffect(() => {
        if (lastNotifiedRef.current === status) return;
        lastNotifiedRef.current = status;
        notifyStatusChange(status);
    }, [status, notifyStatusChange]);

    const ensureEngine = useCallback(async (): Promise<SamEngine> => {
        const current = configRef.current;
        if (!current) throw new Error('[MaskEditor] Auto-selection needs `autoSelect` to be configured.');

        const key = samConfigKey(current.sam);
        const existing = engineRef.current;
        if (existing?.key === key) return existing.engine;
        existing?.engine.dispose();
        engineRef.current = undefined;

        const { createSamEngine } = await import('../internal/sam/engine');

        // Another call may have finished creating the same engine while the import was in
        // flight; keeping the winner avoids two engines racing over one key.
        const raced = engineRef.current as { key: string; engine: SamEngine } | undefined;
        if (raced?.key === key) return raced.engine;

        const engine = createSamEngine(current.sam);
        engineRef.current = { key, engine };
        return engine;
    }, []);

    // Warm-up: sessions plus image embedding, so the first click pays for neither. Keyed on
    // the config signature and the image element itself — a new `src` decodes to a new
    // element, which is what re-encodes the embedding with no manual invalidation step.
    useEffect(() => {
        if (!samKey || !image || !shouldWarm) return;

        const controller = new AbortController();
        warmAbortRef.current?.abort();
        warmAbortRef.current = controller;

        setPhase('loading');
        ensureEngine()
            .then((engine) => engine.prepare(image, controller.signal))
            .then(() => {
                if (!controller.signal.aborted) setPhase('ready');
            })
            .catch((error: unknown) => {
                if (controller.signal.aborted) return;
                setPhase('error');
                notifyError(toError(error));
            });

        return () => controller.abort();
    }, [samKey, image, shouldWarm, ensureEngine, notifyError]);

    // Unmount teardown. StrictMode's double invoke just disposes an engine that the next
    // warm-up or detection recreates on demand.
    useEffect(() => {
        return () => {
            warmAbortRef.current?.abort();
            engineRef.current?.engine.dispose();
            engineRef.current = undefined;
        };
    }, []);

    const detect = useCallback(
        async (point: Point, target: Point, request?: DetectRequest): Promise<Detection | undefined> => {
            const current = configRef.current;
            if (!current) throw new Error('[MaskEditor] Auto-selection needs `autoSelect` to be configured.');

            const img = imageRef.current;
            if (!img) throw new Error('[MaskEditor] Auto-selection needs the image to finish loading.');

            // A preview publishes nothing at all: not the count, and not the phase either way.
            // The count is what the editor's click guard reads, and the phase is what consumers
            // render — neither should move for work the user never asked for.
            const isPreview = request?.preview === true;
            if (!isPreview) setPending((count) => count + 1);

            try {
                const engine = await ensureEngine();
                const detectOptions: DetectOptions = { minScore: current.minScore };
                if (request?.signal) detectOptions.signal = request.signal;

                const detected = await engine.detect(img, point, target, detectOptions);
                if (!isPreview) setPhase('ready');
                return detected;
            } catch (error) {
                // Parking the editor in `'error'` — the banner, `onStatusChange('error')`, the
                // lot — because a throwaway decode nobody asked for lost a race would report a
                // broken model that the very next click segments with perfectly well.
                if (!isPreview) setPhase('error');
                throw toError(error);
            } finally {
                if (!isPreview) setPending((count) => count - 1);
            }
        },
        [ensureEngine],
    );

    return useMemo(() => ({ status, isDetecting, detect }), [status, isDetecting, detect]);
};
