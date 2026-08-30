export type Point = {
    x: number;
    y: number;
};

export type Transform = {
    scale: number;
    translateX: number;
    translateY: number;
};

/**
 * How far the content may be dragged from centre, as a fraction of its own size.
 */
const PAN_LIMIT_RATIO = 0.75;

/**
 * Fits the content inside the container's padding box. Content is only ever scaled *down*,
 * never up, so a small image keeps its natural size.
 */
export const calculateBaseScale = (container: HTMLElement, contentSize: Point): number => {
    if (contentSize.x === 0 || contentSize.y === 0) return 1;

    const computedStyle = window.getComputedStyle(container);
    const paddingHorizontal = parseFloat(computedStyle.paddingLeft) + parseFloat(computedStyle.paddingRight);
    const paddingVertical = parseFloat(computedStyle.paddingTop) + parseFloat(computedStyle.paddingBottom);

    const availableWidth = container.clientWidth - paddingHorizontal;
    const availableHeight = container.clientHeight - paddingVertical;

    return Math.min(1, availableWidth / contentSize.x, availableHeight / contentSize.y);
};

/**
 * Inverts the CSS transform applied to the canvas stack, mapping a viewport coordinate back
 * to a pixel coordinate in the source image.
 */
export const toImageCoordinates = (
    clientX: number,
    clientY: number,
    rect: DOMRect,
    contentSize: Point,
    transform: Transform,
    baseScale: number,
): Point => {
    const combinedScale = transform.scale * baseScale;

    const fromCenterX = clientX - rect.left - rect.width / 2;
    const fromCenterY = clientY - rect.top - rect.height / 2;

    const withoutUserTranslateX = fromCenterX - transform.translateX * combinedScale;
    const withoutUserTranslateY = fromCenterY - transform.translateY * combinedScale;

    return {
        x: withoutUserTranslateX / combinedScale + contentSize.x / 2,
        y: withoutUserTranslateY / combinedScale + contentSize.y / 2,
    };
};

/**
 * Keeps the content from being dragged entirely out of view.
 */
export const clampPan = (x: number, y: number, contentSize: Point, constrain: boolean): Point => {
    if (!constrain) return { x, y };

    const maxPanX = contentSize.x * PAN_LIMIT_RATIO;
    const maxPanY = contentSize.y * PAN_LIMIT_RATIO;

    return {
        x: Math.max(Math.min(x, maxPanX), -maxPanX),
        y: Math.max(Math.min(y, maxPanY), -maxPanY),
    };
};

/**
 * Clamps a point to the last addressable pixel of a surface. The zoom/pan inversion can land a
 * hair outside the canvas at the edges, and consumers downstream index pixels with the result.
 */
export const clampToSize = (point: Point, size: Point): Point => ({
    x: Math.min(Math.max(point.x, 0), Math.max(size.x - 1, 0)),
    y: Math.min(Math.max(point.y, 0), Math.max(size.y - 1, 0)),
});

/**
 * Viewport travel under which a press still counts as a click, and under which a hover
 * preview still answers for the point that was clicked.
 *
 * Viewport pixels, deliberately: image coordinates stretch with the zoom, which would turn a
 * fixed slop into a zoom-dependent one. One constant rather than one per caller, because past
 * the distance at which a press stops being a click we can no longer claim the shape on screen
 * is the one the user was aiming at — the two rules have to move together or a press can count
 * as a click while the preview it was aimed at is refused.
 */
export const CLICK_SLOP_PX: number = 4;

/** Straight-line distance between two points, in whatever space they share. */
export const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Converts a length in *displayed* pixels to canvas pixels, for decorations that should keep
 * their thickness on screen as the zoom changes.
 *
 * The floor on `effectiveScale` is what survives the window before the first fit, when
 * `baseScale` is still its placeholder; the result is clamped to a visible minimum because a
 * sub-pixel ring rounds away to nothing.
 */
export const toImageLength = (displayPx: number, effectiveScale: number): number =>
    Math.max(1, Math.round(displayPx / Math.max(effectiveScale, 0.01)));
