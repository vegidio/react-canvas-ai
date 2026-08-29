import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Point } from '../internal/geometry';
import type { SamEngine } from '../internal/sam/engine';
import { useEventCallback, useLatest } from '../internal/useLatest';

/** A bounding box in canvas-pixel coordinates. */
export type BoundingBox = {
    x: number;
    y: number;
    width: number;
    height: number;
};

/**
 * A single object detected in the source image.
 *
 * `mask` is an alpha-only silhouette sized to the editor's canvas: non-zero alpha marks the
 * object, the RGB channels are ignored. The editor tints it with the live `maskColor` before
 * compositing, so a detected mask is pixel-identical to a hand-painted one.
 */
export type DetectedObject = {
    id: string;
    /** The model's confidence for this mask, nominally 0-1. */
    score: number;
    bbox: BoundingBox;
    mask: ImageData;
};

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

export type UseAutoSelectReturn = {
    status: AutoSelectStatus;
    isDetecting: boolean;
    /**
     * Runs a detection at `point` (canvas pixels), silhouette sized to `target`. Resolves
     * `undefined` for an empty or below-`minScore` result. Rejections are the caller's to
     * route — only warm-up failures reach `onError` from here, or a failed detection would
     * be reported twice.
     */
    detect: (point: Point, target: Point) => Promise<DetectedObject | undefined>;
};

/**
 * The engine is rebuilt when any of these change; everything else on the options object can
 * change freely without throwing away sessions and embedding.
 */
const samConfigKey = (sam: SamConfig): string =>
    JSON.stringify([sam.encoderUrl, sam.decoderUrl, sam.wasmPaths, sam.executionProviders, sam.debug]);

const toError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

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

    const [status, setStatus] = useState<AutoSelectStatus>('idle');
    const [isDetecting, setIsDetecting] = useState(false);

    const samKey = config ? samConfigKey(config.sam) : undefined;

    const configRef = useLatest(config);
    const imageRef = useLatest(image);
    const engineRef = useRef<{ key: string; engine: SamEngine } | undefined>(undefined);
    const warmAbortRef = useRef<AbortController | undefined>(undefined);
    // Counted rather than a boolean: `selectAt` can overlap a click, and the first one to
    // finish must not clear the flag while the other is still running.
    const pendingRef = useRef(0);

    const notifyStatusChange = useEventCallback<[AutoSelectStatus]>(config?.onStatusChange);
    const notifyError = useEventCallback<[Error]>(config?.onError);

    // Mirrors committed status changes to the component-consumer callback. An effect rather
    // than calls next to each `setStatus`: those run inside async continuations where a stale
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

        setStatus('loading');
        ensureEngine()
            .then((engine) => engine.prepare(image, controller.signal))
            .then(() => {
                if (!controller.signal.aborted) setStatus('ready');
            })
            .catch((error: unknown) => {
                if (controller.signal.aborted) return;
                setStatus('error');
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
        async (point: Point, target: Point): Promise<DetectedObject | undefined> => {
            const current = configRef.current;
            if (!current) throw new Error('[MaskEditor] Auto-selection needs `autoSelect` to be configured.');

            const img = imageRef.current;
            if (!img) throw new Error('[MaskEditor] Auto-selection needs the image to finish loading.');

            pendingRef.current += 1;
            setIsDetecting(true);
            setStatus('detecting');

            try {
                const engine = await ensureEngine();
                const detected = await engine.detect(img, point, target, { minScore: current.minScore });
                setStatus('ready');
                return detected;
            } catch (error) {
                setStatus('error');
                throw toError(error);
            } finally {
                pendingRef.current -= 1;
                if (pendingRef.current === 0) setIsDetecting(false);
            }
        },
        [ensureEngine],
    );

    return useMemo(() => ({ status, isDetecting, detect }), [status, isDetecting, detect]);
};
