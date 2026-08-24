import { describe, expect, it } from 'vitest';
import type { ZoomPanAction } from '../../src/internal/zoomPanReducer';
import { createZoomPanState, zoomPanReducer } from '../../src/internal/zoomPanReducer';

const base = createZoomPanState(1);
const apply = (actions: ZoomPanAction[], from = base) => actions.reduce(zoomPanReducer, from);

describe('createZoomPanState', () => {
    it('seeds the transform from the initial scale', () => {
        expect(createZoomPanState(2).transform).toEqual({ scale: 2, translateX: 0, translateY: 0 });
    });
});

describe('identity', () => {
    it('returns the same object when nothing moved', () => {
        expect(zoomPanReducer(base, { type: 'scale', scale: 1 })).toBe(base);
        expect(zoomPanReducer(base, { type: 'pan', translateX: 0, translateY: 0 })).toBe(base);
        expect(zoomPanReducer(base, { type: 'reset' })).toBe(base);
        expect(zoomPanReducer(base, { type: 'panning', value: false })).toBe(base);
        expect(zoomPanReducer(base, { type: 'blur' })).toBe(base);
        expect(zoomPanReducer(base, { type: 'fit', baseScale: 1 })).toBe(base);
    });

    it('allocates only when something changed', () => {
        expect(zoomPanReducer(base, { type: 'scale', scale: 2 })).not.toBe(base);
        expect(zoomPanReducer(base, { type: 'fit', baseScale: 0.5 })).not.toBe(base);
    });
});

describe('scale writes own the pan', () => {
    const zoomed = apply([
        { type: 'scale', scale: 2 },
        { type: 'pan', translateX: 30, translateY: -20 },
    ]);

    it('keeps the pan while zoomed in', () => {
        expect(zoomed.transform).toEqual({ scale: 2, translateX: 30, translateY: -20 });
    });

    it('zeroes the pan when a scale write lands back at fit', () => {
        expect(zoomPanReducer(zoomed, { type: 'scale', scale: 1 }).transform).toEqual({
            scale: 1,
            translateX: 0,
            translateY: 0,
        });
    });

    it('zeroes the pan on reset', () => {
        expect(zoomPanReducer(zoomed, { type: 'reset' }).transform).toEqual({
            scale: 1,
            translateX: 0,
            translateY: 0,
        });
    });

    it('leaves an explicit pan alone at scale 1, as the effect it replaced did', () => {
        expect(zoomPanReducer(base, { type: 'pan', translateX: 500, translateY: -500 }).transform).toEqual({
            scale: 1,
            translateX: 500,
            translateY: -500,
        });
    });
});

describe('fit', () => {
    it('recentres the pan but preserves the zoom', () => {
        const next = zoomPanReducer(zoomPanReducer(base, { type: 'scale', scale: 3 }), {
            type: 'fit',
            baseScale: 0.4,
        });

        expect(next.transform).toEqual({ scale: 3, translateX: 0, translateY: 0 });
        expect(next.baseScale).toBe(0.4);
    });

    it('keeps an initial scale above 1 pannable', () => {
        const next = zoomPanReducer(createZoomPanState(2), { type: 'fit', baseScale: 0.5 });
        expect(next.transform.scale).toBe(2);
    });
});

describe('input flags', () => {
    it('clears every transient flag on blur in one write', () => {
        const held = apply([
            { type: 'panning', value: true },
            { type: 'spaceKey', value: true },
            { type: 'zoomKey', value: true },
        ]);

        expect(zoomPanReducer(held, { type: 'blur' })).toMatchObject({
            isPanning: false,
            isSpaceKeyDown: false,
            isZoomKeyDown: false,
        });
    });

    it('leaves the transform untouched', () => {
        const held = zoomPanReducer(base, { type: 'spaceKey', value: true });
        expect(held.transform).toBe(base.transform);
    });
});

describe('purity', () => {
    it('never mutates the state it is given', () => {
        const before = JSON.stringify(base);
        const actions: ZoomPanAction[] = [
            { type: 'fit', baseScale: 0.3 },
            { type: 'scale', scale: 2 },
            { type: 'zoomToPoint', scale: 3, translateX: 5, translateY: 6 },
            { type: 'pan', translateX: 1, translateY: 2 },
            { type: 'panning', value: true },
            { type: 'blur' },
            { type: 'reset' },
        ];

        for (const action of actions) zoomPanReducer(base, action);
        expect(JSON.stringify(base)).toBe(before);
    });

    it('is replayable: the eager chain and a re-run agree', () => {
        // This is what `commit` relies on — it folds actions onto a mirror ref while React
        // folds the same actions onto the committed state.
        const actions: ZoomPanAction[] = [
            { type: 'fit', baseScale: 0.5 },
            { type: 'scale', scale: 2.5 },
            { type: 'pan', translateX: 12, translateY: -8 },
            { type: 'panning', value: true },
            { type: 'zoomToPoint', scale: 1.5, translateX: 3, translateY: 4 },
        ];

        expect(apply(actions)).toEqual(apply(actions));
    });
});
