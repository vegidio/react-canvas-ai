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
