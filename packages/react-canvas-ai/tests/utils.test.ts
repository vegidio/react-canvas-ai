import { describe, expect, it, vi } from 'vitest';
import { hexToRgb, simpleDebounce, toMask } from '../src/utils';
import { makeSeededCanvas } from './helpers/canvas';

describe('toMask', () => {
    // Three pixels: pure black, near-black, and white - each with a distinct alpha so we
    // can prove the original buffer is restored byte for byte.
    const seed = () =>
        makeSeededCanvas(3, 1, [
            0,
            0,
            0,
            10, // pure black
            1,
            0,
            0,
            255, // near-black
            255,
            255,
            255,
            128, // white
        ]);

    it('returns the data URL produced by the canvas', () => {
        const { canvas } = seed();
        expect(toMask(canvas)).toBe('data:image/png;base64,STUB');
    });

    it('binarizes to pure black and white at export time', () => {
        const { canvas, snapshots } = seed();
        toMask(canvas);

        expect(snapshots).toHaveLength(1);
        expect(snapshots[0]).toEqual([
            0,
            0,
            0,
            255, // pure black stays black
            255,
            255,
            255,
            255, // near-black becomes white - only exact black survives
            255,
            255,
            255,
            255,
        ]);
    });

    it('forces alpha to fully opaque on every pixel', () => {
        const { canvas, snapshots } = seed();
        toMask(canvas);
        const alphas = snapshots[0]?.filter((_, i) => i % 4 === 3);
        expect(alphas).toEqual([255, 255, 255]);
    });

    it('restores the original pixels after exporting', () => {
        const { canvas, imageData } = seed();
        toMask(canvas);
        expect([...imageData.data]).toEqual([0, 0, 0, 10, 1, 0, 0, 255, 255, 255, 255, 128]);
    });

    it('writes the canvas twice: binarized, then restored', () => {
        const { canvas, ctx } = seed();
        toMask(canvas);
        expect(ctx.putImageData).toHaveBeenCalledTimes(2);
        for (const call of ctx.putImageData.mock.calls) {
            expect(call.slice(1)).toEqual([0, 0]);
        }
    });

    it('reads the full canvas area', () => {
        const { canvas, ctx } = seed();
        toMask(canvas);
        expect(canvas.getContext).toHaveBeenCalledWith('2d');
        expect(ctx.getImageData).toHaveBeenCalledWith(0, 0, 3, 1);
    });

    it('handles a zero-size canvas without throwing', () => {
        const { canvas } = makeSeededCanvas(0, 0, []);
        expect(() => toMask(canvas)).not.toThrow();
    });

    it('does not throw when a 2d context is unavailable', () => {
        // Previously this dereferenced a null context and crashed - a live bug, not just
        // a type complaint.
        const canvas = {
            width: 1,
            height: 1,
            getContext: vi.fn(() => null),
            toDataURL: vi.fn(() => 'data:image/png;base64,NOCTX'),
        } as unknown as HTMLCanvasElement;

        expect(toMask(canvas)).toBe('data:image/png;base64,NOCTX');
    });
});

describe('hexToRgb', () => {
    it.each([
        ['#ffffff', [255, 255, 255]],
        ['#000000', [0, 0, 0]],
        ['#c3c3c3', [195, 195, 195]],
    ])('parses %s', (input, expected) => {
        expect(hexToRgb(input)).toEqual(expected);
    });

    it('does not require a leading hash', () => {
        expect(hexToRgb('ffffff')).toEqual([255, 255, 255]);
    });

    // Regression guard: chunking into pairs used to read '#fff' as ['ff', 'f'], so
    // shorthand white was painted as orange.
    it('expands three-digit shorthand per nibble', () => {
        expect(hexToRgb('#fff')).toEqual([255, 255, 255]);
        expect(hexToRgb('#0a0')).toEqual([0, 170, 0]);
    });

    // Regression guard: non-hex input used to produce NaN channels, which clamp silently
    // to 0 once written into an ImageData buffer.
    it('falls back to black for non-hex input', () => {
        expect(hexToRgb('#GGGGGG')).toEqual([0, 0, 0]);
    });

    it('falls back to black for a wrong-length hex string', () => {
        expect(hexToRgb('#ffff')).toEqual([0, 0, 0]);
    });

    it('falls back to black when nothing matches', () => {
        expect(hexToRgb('')).toEqual([0, 0, 0]);
    });
});

describe('simpleDebounce', () => {
    it('does not fire before the delay elapses', () => {
        vi.useFakeTimers();
        const fn = vi.fn();
        simpleDebounce(fn, 300)();

        vi.advanceTimersByTime(299);
        expect(fn).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('coalesces rapid calls and keeps the last arguments', () => {
        vi.useFakeTimers();
        const fn = vi.fn((_value: string) => {});
        const debounced = simpleDebounce(fn, 300);

        debounced('a');
        debounced('b');
        debounced('c');
        vi.advanceTimersByTime(300);

        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn).toHaveBeenCalledWith('c');
    });

    it('restarts the timer on every call', () => {
        vi.useFakeTimers();
        const fn = vi.fn();
        const debounced = simpleDebounce(fn, 300);

        debounced();
        vi.advanceTimersByTime(299);
        debounced();
        vi.advanceTimersByTime(299);
        expect(fn).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('cancel() prevents a pending call', () => {
        vi.useFakeTimers();
        const fn = vi.fn();
        const debounced = simpleDebounce(fn, 300);

        debounced();
        debounced.cancel();
        vi.advanceTimersByTime(1000);
        expect(fn).not.toHaveBeenCalled();
    });

    it('cancel() after firing is a no-op', () => {
        vi.useFakeTimers();
        const fn = vi.fn();
        const debounced = simpleDebounce(fn, 300);

        debounced();
        vi.advanceTimersByTime(300);
        expect(() => debounced.cancel()).not.toThrow();
        vi.advanceTimersByTime(1000);
        expect(fn).toHaveBeenCalledTimes(1);
    });
});
