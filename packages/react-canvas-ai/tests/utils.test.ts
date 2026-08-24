import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hexToRgb, toMask } from '../src/utils';
import { captureScratchCanvas, makeSeededCanvas } from './helpers/canvas';

describe('toMask', () => {
    // A painted pixel in an arbitrary mask colour, a pixel erased back to nothing, and an
    // anti-aliased rim either side of half coverage. The distinct alphas also let us prove the
    // caller's buffer is left alone.
    const SEED = [
        10,
        20,
        30,
        255, // painted
        255,
        255,
        255,
        0, // erased - white RGB left behind, but no coverage
        10,
        20,
        30,
        200, // rim, mostly covered
        10,
        20,
        30,
        60, // rim, barely covered
    ];
    const seed = () => makeSeededCanvas(4, 1, SEED);

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

    it('binarizes by coverage, not by colour', () => {
        const { canvas } = seed();
        toMask(canvas);

        // This used to key off RGB, so `maskColor: '#000000'` exported as if nothing had been
        // painted, and an erased pixel — opaque white, back then — exported as painted.
        expect(scratch.exported).toHaveLength(1);
        expect(scratch.exported[0]).toEqual([
            255,
            255,
            255,
            255, // painted, whatever colour it was painted in
            0,
            0,
            0,
            255, // erased, however it was left coloured
            255,
            255,
            255,
            255, // rim at or above half coverage counts as masked
            0,
            0,
            0,
            255,
        ]);
    });

    it('exports a black stroke as masked', () => {
        // `maskColor: '#000000'` was indistinguishable from an untouched pixel under the old
        // RGB test, so a black mask exported as entirely blank.
        const { canvas } = makeSeededCanvas(1, 1, [0, 0, 0, 255]);
        toMask(canvas);

        expect(scratch.exported[0]).toEqual([255, 255, 255, 255]);
    });

    it('forces alpha to fully opaque on every pixel', () => {
        const { canvas } = seed();
        toMask(canvas);
        const alphas = scratch.exported[0]?.filter((_, i) => i % 4 === 3);
        expect(alphas).toEqual([255, 255, 255, 255]);
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
        expect(ctx.getImageData).toHaveBeenCalledWith(0, 0, 4, 1);
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
