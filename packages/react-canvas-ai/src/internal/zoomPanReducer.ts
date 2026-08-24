import type { Transform } from './geometry';

/**
 * The zoom/pan state, with `transform.scale` as the single home of the zoom.
 *
 * A separate `scale` field used to shadow it, kept in step by hand at four write sites. They
 * disagreed in practice: the mount fit wrote the transform without touching the shadow, so an
 * `initialScale` above 1 rendered zoomed but reported nothing to pan.
 */
export type ZoomPanInternalState = {
    transform: Transform;
    baseScale: number;
    isPanning: boolean;
    isSpaceKeyDown: boolean;
    isZoomKeyDown: boolean;
};

/**
 * Every write to the state above.
 *
 * Deliberately dumb: clamping, `clampPan`, `calculateBaseScale` and every consumer
 * notification stay with the caller. The reducer has to be pure, because it is run eagerly
 * against a mirror ref *and* again by React — a second time on an eager bailout, a third under
 * StrictMode. Side effects in a state updater are exactly the bug that regressed here before.
 */
export type ZoomPanAction =
    /** Re-fit to the container. `baseScale` is measured by the caller. */
    | { type: 'fit'; baseScale: number }
    /** Caller has already clamped to `[minScale, maxScale]`. */
    | { type: 'scale'; scale: number }
    | { type: 'zoomToPoint'; scale: number; translateX: number; translateY: number }
    /** Caller has already run `clampPan`. */
    | { type: 'pan'; translateX: number; translateY: number }
    | { type: 'reset' }
    | { type: 'panning'; value: boolean }
    | { type: 'spaceKey'; value: boolean }
    | { type: 'zoomKey'; value: boolean }
    /** The window lost focus: drop every transient input flag at once. */
    | { type: 'blur' };

const CENTERED: Transform = { scale: 1, translateX: 0, translateY: 0 };

const sameTransform = (a: Transform, b: Transform): boolean =>
    a.scale === b.scale && a.translateX === b.translateX && a.translateY === b.translateY;

/**
 * Writes a transform, returning `state` untouched when nothing actually moved. That identity
 * check is the "nothing changed" guard the individual actions used to each repeat.
 */
const withTransform = (state: ZoomPanInternalState, next: Transform): ZoomPanInternalState =>
    sameTransform(state.transform, next) ? state : { ...state, transform: next };

/**
 * Writes a transform whose scale may have changed, zeroing the pan when the result is no
 * longer zoomed in — below fit-to-container there is nothing to pan.
 *
 * Only scale writes go through this. An explicit `setPan` is honoured at any scale, which is
 * what the effect this replaced did: it fired on a `canPan` transition, not on every write.
 */
const withScaledTransform = (state: ZoomPanInternalState, next: Transform): ZoomPanInternalState =>
    withTransform(state, next.scale > 1 ? next : { scale: next.scale, translateX: 0, translateY: 0 });

export const zoomPanReducer = (state: ZoomPanInternalState, action: ZoomPanAction): ZoomPanInternalState => {
    switch (action.type) {
        case 'fit': {
            // The zoom the user chose survives a re-fit; only the offset is recentred. Resetting
            // it here would silently discard their zoom on any container resize.
            const next = withScaledTransform(state, { ...state.transform, translateX: 0, translateY: 0 });
            return next.baseScale === action.baseScale ? next : { ...next, baseScale: action.baseScale };
        }
        case 'scale':
            return withScaledTransform(state, { ...state.transform, scale: action.scale });
        case 'zoomToPoint':
            return withScaledTransform(state, {
                scale: action.scale,
                translateX: action.translateX,
                translateY: action.translateY,
            });
        case 'reset':
            return withScaledTransform(state, { ...CENTERED });
        case 'pan':
            return withTransform(state, {
                ...state.transform,
                translateX: action.translateX,
                translateY: action.translateY,
            });
        case 'panning':
            return state.isPanning === action.value ? state : { ...state, isPanning: action.value };
        case 'spaceKey':
            return state.isSpaceKeyDown === action.value ? state : { ...state, isSpaceKeyDown: action.value };
        case 'zoomKey':
            return state.isZoomKeyDown === action.value ? state : { ...state, isZoomKeyDown: action.value };
        case 'blur':
            return !state.isPanning && !state.isSpaceKeyDown && !state.isZoomKeyDown
                ? state
                : { ...state, isPanning: false, isSpaceKeyDown: false, isZoomKeyDown: false };
    }
};

export const createZoomPanState = (initialScale: number): ZoomPanInternalState => ({
    transform: { scale: initialScale, translateX: 0, translateY: 0 },
    baseScale: 1,
    isPanning: false,
    isSpaceKeyDown: false,
    isZoomKeyDown: false,
});
