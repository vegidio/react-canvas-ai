import { describe, expect, it, vi } from 'vitest';
import { computeTargetSize, drawCursorCircle, paintMaskDot, recolorMask } from '../../src/internal/canvas';

function makeContext(pixels: number[] = []) {
    const imageData = { data: Uint8ClampedArray.from(pixels), width: 1, height: 1 } as ImageData;
    return {
        imageData,
        ctx: {
            clearRect: vi.fn(),
            beginPath: vi.fn(),
            arc: vi.fn(),
            fill: vi.fn(),
            stroke: vi.fn(),
            getImageData: vi.fn(() => imageData),
            putImageData: vi.fn(),
            fillStyle: '',
            strokeStyle: '',
            lineWidth: 0,
            globalAlpha: 1,
        } as unknown as CanvasRenderingContext2D,
    };
}

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
    it('fills without clearing or stroking, so dabs accumulate', () => {
        const { ctx } = makeContext();
        paintMaskDot(ctx, 3, 4, 7, '#ff0000');

        expect(ctx.clearRect).not.toHaveBeenCalled();
        expect(ctx.stroke).not.toHaveBeenCalled();
        expect(ctx.arc).toHaveBeenCalledWith(3, 4, 7, 0, Math.PI * 2);
        expect(ctx.fillStyle).toBe('#ff0000');
    });
});

describe('recolorMask', () => {
    it('recolours painted pixels and leaves the background white', () => {
        // Pixel 1 is background (r=255), pixel 2 was painted.
        const { ctx, imageData } = makeContext([255, 255, 255, 255, 10, 20, 30, 255]);
        recolorMask(ctx, { x: 2, y: 1 }, [1, 2, 3]);

        expect([...imageData.data]).toEqual([255, 255, 255, 255, 1, 2, 3, 255]);
        expect(ctx.putImageData).toHaveBeenCalledWith(imageData, 0, 0);
    });

    it('leaves the alpha channel alone', () => {
        const { ctx, imageData } = makeContext([0, 0, 0, 128]);
        recolorMask(ctx, { x: 1, y: 1 }, [9, 9, 9]);
        expect(imageData.data[3]).toBe(128);
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
