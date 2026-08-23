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
