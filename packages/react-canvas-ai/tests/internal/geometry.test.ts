import { describe, expect, it } from 'vitest';
import { calculateBaseScale, clampPan, toImageCoordinates } from '../../src/internal/geometry';

const rect = (width: number, height: number): DOMRect =>
    ({ left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0 }) as DOMRect;

const makeContainer = (width: number, height: number, padding = '0px') => {
    const el = document.createElement('div');
    el.style.padding = padding;
    document.body.append(el);
    Object.defineProperty(el, 'clientWidth', { value: width, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: height, configurable: true });
    return el;
};

describe('calculateBaseScale', () => {
    it('leaves content smaller than the container at natural size', () => {
        expect(calculateBaseScale(makeContainer(400, 400), { x: 100, y: 100 })).toBe(1);
    });

    it('scales down to the tighter of the two axes', () => {
        expect(calculateBaseScale(makeContainer(400, 200), { x: 400, y: 400 })).toBe(0.5);
    });

    it('subtracts padding from the available box', () => {
        expect(calculateBaseScale(makeContainer(400, 400, '50px'), { x: 600, y: 600 })).toBe(0.5);
    });

    it('returns 1 for zero-sized content rather than dividing by zero', () => {
        expect(calculateBaseScale(makeContainer(400, 400), { x: 0, y: 0 })).toBe(1);
        expect(calculateBaseScale(makeContainer(400, 400), { x: 100, y: 0 })).toBe(1);
    });
});

describe('toImageCoordinates', () => {
    const identity = { scale: 1, translateX: 0, translateY: 0 };

    it('maps the container centre to the content centre', () => {
        expect(toImageCoordinates(100, 100, rect(200, 200), { x: 100, y: 100 }, identity, 1)).toEqual({ x: 50, y: 50 });
    });

    it('accounts for the base scale', () => {
        expect(toImageCoordinates(200, 200, rect(200, 200), { x: 400, y: 400 }, identity, 0.5)).toEqual({
            x: 400,
            y: 400,
        });
    });

    it('undoes the user translate', () => {
        const transform = { scale: 1, translateX: 10, translateY: -10 };
        expect(toImageCoordinates(100, 100, rect(200, 200), { x: 100, y: 100 }, transform, 1)).toEqual({
            x: 40,
            y: 60,
        });
    });
});

describe('clampPan', () => {
    const content = { x: 100, y: 100 };

    it('limits movement to 75% of the content size', () => {
        expect(clampPan(500, -500, content, true)).toEqual({ x: 75, y: -75 });
    });

    it('passes small offsets through untouched', () => {
        expect(clampPan(10, -10, content, true)).toEqual({ x: 10, y: -10 });
    });

    it('does nothing when constraints are off', () => {
        expect(clampPan(500, -500, content, false)).toEqual({ x: 500, y: -500 });
    });
});
