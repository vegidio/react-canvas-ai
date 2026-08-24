import type { Mock } from 'vitest';
import { describe, expect, it, vi } from 'vitest';
import {
    applyMaskImage,
    computeTargetSize,
    drawCursorCircle,
    paintMaskDot,
    recolorMask,
} from '../../src/internal/canvas';
import { toMask } from '../../src/utils';
import { captureScratchCanvas, makeSeededCanvas } from '../helpers/canvas';

const makeContext = (pixels: number[] = []) => {
    const imageData = { data: Uint8ClampedArray.from(pixels), width: 1, height: 1 } as ImageData;
    return {
        imageData,
        ctx: {
            clearRect: vi.fn(),
            beginPath: vi.fn(),
            arc: vi.fn(),
            fill: vi.fn(),
            stroke: vi.fn(),
            drawImage: vi.fn(),
            getImageData: vi.fn(() => imageData),
            putImageData: vi.fn(),
            fillStyle: '',
            strokeStyle: '',
            lineWidth: 0,
            globalAlpha: 1,
            globalCompositeOperation: 'source-over',
        } as unknown as CanvasRenderingContext2D,
    };
};

const asImage = (width: number, height: number, natural = { width, height }) =>
    ({ width, height, naturalWidth: natural.width, naturalHeight: natural.height }) as HTMLImageElement;

describe('drawCursorCircle', () => {
    it('clears the layer before stamping the outline', () => {
        const { ctx } = makeContext();
        drawCursorCircle(ctx, { size: { x: 20, y: 10 }, x: 5, y: 6, radius: 4, color: '#abcdef', opacity: 0.5 });

        expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 20, 10);
        expect(ctx.arc).toHaveBeenCalledWith(5, 6, 4, 0, Math.PI * 2);
        expect(ctx.fillStyle).toBe('#abcdef');
        expect(ctx.globalAlpha).toBe(0.5);
        expect(ctx.fill).toHaveBeenCalled();
        expect(ctx.stroke).toHaveBeenCalled();
    });
});

describe('paintMaskDot', () => {
    /**
     * The composite mode has to be in force *at fill time*, not merely assigned at some point
     * during the call — which is all that reading it afterwards would prove.
     */
    const modeAtFill = (ctx: CanvasRenderingContext2D) => {
        const seen: string[] = [];
        (ctx.fill as unknown as Mock).mockImplementation(() => seen.push(ctx.globalCompositeOperation));
        return seen;
    };

    it('fills without clearing or stroking, so dabs accumulate', () => {
        const { ctx } = makeContext();
        paintMaskDot(ctx, 3, 4, 7, '#ff0000');

        expect(ctx.clearRect).not.toHaveBeenCalled();
        expect(ctx.stroke).not.toHaveBeenCalled();
        expect(ctx.arc).toHaveBeenCalledWith(3, 4, 7, 0, Math.PI * 2);
        expect(ctx.fillStyle).toBe('#ff0000');
    });

    it('erases by removing coverage instead of painting a colour over it', () => {
        const { ctx } = makeContext();
        const seen = modeAtFill(ctx);

        paintMaskDot(ctx, 1, 2, 3, '#ff0000', 'erase');

        expect(seen).toEqual(['destination-out']);
    });

    it('paints with source-over even if the caller left another mode in place', () => {
        const { ctx } = makeContext();
        ctx.globalCompositeOperation = 'xor';
        const seen = modeAtFill(ctx);

        paintMaskDot(ctx, 1, 2, 3, '#ff0000');

        expect(seen).toEqual(['source-over']);
    });

    it('restores the composite mode the caller had set', () => {
        const { ctx } = makeContext();
        ctx.globalCompositeOperation = 'multiply';
        paintMaskDot(ctx, 1, 2, 3, '#ff0000', 'erase');

        // A leaked `destination-out` would make the next `drawImage` — the initial-mask
        // conversion — erase the canvas instead of filling it.
        expect(ctx.globalCompositeOperation).toBe('multiply');
    });
});

describe('recolorMask', () => {
    it('retints every covered pixel whatever colour it already was', () => {
        // A red channel of 255 used to mean "background", so the default white mask could never
        // be recoloured and every colour with r=255 collapsed back to white.
        const { ctx, imageData } = makeContext([255, 255, 255, 255, 10, 20, 30, 255]);
        recolorMask(ctx, { x: 2, y: 1 }, [1, 2, 3]);

        expect([...imageData.data]).toEqual([1, 2, 3, 255, 1, 2, 3, 255]);
        expect(ctx.putImageData).toHaveBeenCalledWith(imageData, 0, 0);
    });

    it('leaves fully transparent pixels untouched', () => {
        // Nothing was painted here, so there is no colour to retint.
        const { ctx, imageData } = makeContext([9, 9, 9, 0]);
        recolorMask(ctx, { x: 1, y: 1 }, [1, 2, 3]);

        expect([...imageData.data]).toEqual([9, 9, 9, 0]);
    });

    it('retints anti-aliased edges without touching their alpha', () => {
        // The old white test fringed exactly here: a half-covered edge pixel was forced to white.
        const { ctx, imageData } = makeContext([0, 0, 0, 128]);
        recolorMask(ctx, { x: 1, y: 1 }, [9, 8, 7]);

        expect([...imageData.data]).toEqual([9, 8, 7, 128]);
    });
});

describe('applyMaskImage', () => {
    const img = {} as HTMLImageElement;

    it('turns light pixels into the mask colour and everything else into nothing', () => {
        // white | black | light grey | dark grey, as `drawImage` would have left them.
        const seed = [255, 255, 255, 255, 0, 0, 0, 255, 200, 200, 200, 255, 40, 40, 40, 255];
        const { ctx, imageData } = makeContext(seed);

        applyMaskImage(ctx, { x: 4, y: 1 }, img, [10, 20, 30]);

        expect([...imageData.data]).toEqual([10, 20, 30, 255, 0, 0, 0, 0, 10, 20, 30, 255, 0, 0, 0, 0]);
        expect(ctx.putImageData).toHaveBeenCalledWith(imageData, 0, 0);
    });

    it('splits at half coverage', () => {
        const alphaAt = (value: number) => {
            const { ctx, imageData } = makeContext([value, value, value, 255]);
            applyMaskImage(ctx, { x: 1, y: 1 }, img, [1, 2, 3]);
            return imageData.data[3];
        };

        expect(alphaAt(128)).toBe(255);
        expect(alphaAt(127)).toBe(0);
    });

    it('treats a transparent pixel as unmasked even when it is white', () => {
        const { ctx, imageData } = makeContext([255, 255, 255, 0]);
        applyMaskImage(ctx, { x: 1, y: 1 }, img, [1, 2, 3]);

        expect([...imageData.data]).toEqual([0, 0, 0, 0]);
    });

    it('clears before drawing, so an earlier mask cannot show through', () => {
        const { ctx } = makeContext([0, 0, 0, 0]);
        applyMaskImage(ctx, { x: 1, y: 1 }, img, [1, 2, 3]);

        expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 1, 1);
        expect(ctx.drawImage).toHaveBeenCalledWith(img, 0, 0, 1, 1);
        expect((ctx.clearRect as Mock).mock.invocationCallOrder[0]).toBeLessThan(
            (ctx.drawImage as Mock).mock.invocationCallOrder[0],
        );
    });
});

describe('mask round trip', () => {
    it('reloads its own export unchanged', () => {
        const scratch = captureScratchCanvas();
        // painted | untouched | rim above half | rim below half
        const seed = [10, 20, 30, 255, 0, 0, 0, 0, 10, 20, 30, 200, 10, 20, 30, 60];
        const { canvas } = makeSeededCanvas(4, 1, seed);

        toMask(canvas);
        const exported = scratch.exported[0] as number[];
        scratch.restore();

        expect(exported).toEqual([255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255]);

        const { ctx, imageData } = makeContext(exported);
        applyMaskImage(ctx, { x: 4, y: 1 }, {} as HTMLImageElement, [10, 20, 30]);

        // Back in the painting representation — mask colour at full alpha, or nothing at all —
        // which is what lets `recolorMask` treat a loaded mask like a hand-painted stroke. At any
        // threshold below half this would not be a fixed point: each round trip would grow every
        // stroke by its own anti-aliased rim.
        expect([...imageData.data]).toEqual([10, 20, 30, 255, 0, 0, 0, 0, 10, 20, 30, 255, 0, 0, 0, 0]);
    });
});

describe('computeTargetSize', () => {
    it('leaves an in-bounds image alone', () => {
        expect(computeTargetSize(asImage(800, 600), 1240, 1240)).toEqual({ x: 800, y: 600 });
    });

    it('scales down preserving aspect ratio', () => {
        expect(computeTargetSize(asImage(2480, 1240), 1240, 1240)).toEqual({ x: 1240, y: 620 });
    });

    it('clamps tiny images up to a usable size', () => {
        expect(computeTargetSize(asImage(10, 10), 1240, 1240)).toEqual({ x: 50, y: 50 });
    });

    it('recovers dimensions from the natural size', () => {
        expect(computeTargetSize(asImage(0, 0, { width: 400, height: 300 }), 1240, 1240)).toEqual({ x: 400, y: 300 });
    });

    it('falls back to a visible box when nothing reports a size', () => {
        expect(computeTargetSize(asImage(0, 0, { width: 0, height: 0 }), 1240, 1240)).toEqual({ x: 300, y: 200 });
    });
});
