/**
 * The shapes auto-selection produces. A leaf module rather than part of `hooks/useAutoSelect`:
 * `internal/canvas.ts` and `internal/sam/postprocess.ts` both need them, and importing them
 * upward from the hook closed a type cycle through the top of the package.
 */

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
