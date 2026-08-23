import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hexToRgb, toMask } from '../src/utils';
import { captureScratchCanvas, makeSeededCanvas } from './helpers/canvas';

describe('toMask', () => {
    // Three pixels: pure black, near-black, and white - each with a distinct alpha so we
    // can prove the caller's buffer is left alone.
    const SEED = [
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
    ];
    const seed = () => makeSeededCanvas(3, 1, SEED);

    let scratch: ReturnType<typeof captureScratchCanvas>;
    beforeEach(() => {
        scratch = captureScratchCanvas();
    });
    afterEach(() => {
        scratch.restore();
    });

    it('returns the data URL of the thresholded copy, not the source canvas', () => {
        const { canvas } = seed();
        expect(toMask(canvas)).toBe('data:image/png;base64,SCRATCH');
    });

    it('binarizes to pure black and white', () => {
        const { canvas } = seed();
        toMask(canvas);

        expect(scratch.exported).toHaveLength(1);
        expect(scratch.exported[0]).toEqual([
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
        const { canvas } = seed();
        toMask(canvas);
        const alphas = scratch.exported[0]?.filter((_, i) => i % 4 === 3);
        expect(alphas).toEqual([255, 255, 255]);
    });

    it("never writes to the caller's canvas", () => {
        const { canvas, ctx, sourcePixels } = seed();
        toMask(canvas);

        expect(ctx.putImageData).not.toHaveBeenCalled();
        expect(sourcePixels()).toEqual(SEED);
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

    it('falls back to the source canvas when the scratch context is unavailable', () => {
        scratch.restore();
        vi.spyOn(document, 'createElement').mockImplementation(
            (() =>
                ({
                    width: 0,
                    height: 0,
                    getContext: () => null,
                }) as unknown as HTMLCanvasElement) as typeof document.createElement,
        );

        const { canvas } = seed();
        expect(toMask(canvas)).toBe('data:image/png;base64,SOURCE');
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
