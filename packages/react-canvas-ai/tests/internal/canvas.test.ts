import type { Mock } from 'vitest';
import { describe, expect, it, vi } from 'vitest';
import {
    applyDetectedMask,
    applyMaskImage,
    computeTargetSize,
    drawCursorCircle,
    drawPreviewSilhouette,
    paintMaskStroke,
    recolorMask,
    tintSilhouette,
} from '../../src/internal/canvas';
import { createCanvas } from '../../src/internal/createCanvas';
import { toMask } from '../../src/utils';
import { captureScratchCanvas, makeSeededCanvas } from '../helpers/canvas';

vi.mock('../../src/internal/createCanvas');

const makeContext = (pixels: number[] = []) => {
    const imageData = { data: Uint8ClampedArray.from(pixels), width: 1, height: 1 } as ImageData;
    return {
        imageData,
        ctx: {
            clearRect: vi.fn(),
            beginPath: vi.fn(),
            arc: vi.fn(),
            moveTo: vi.fn(),
            lineTo: vi.fn(),
            fill: vi.fn(),
            stroke: vi.fn(),
            drawImage: vi.fn(),
            save: vi.fn(),
            restore: vi.fn(),
            getImageData: vi.fn(() => imageData),
            putImageData: vi.fn(),
            fillStyle: '',
            strokeStyle: '',
            lineWidth: 0,
            lineCap: 'butt',
            lineJoin: 'miter',
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

describe('paintMaskStroke', () => {
    /**
     * The composite mode has to be in force *at draw time*, not merely assigned at some point
     * during the call — which is all that reading it afterwards would prove.
     */
    const modeAtDraw = (ctx: CanvasRenderingContext2D, call: 'fill' | 'stroke') => {
        const seen: string[] = [];
        (ctx[call] as unknown as Mock).mockImplementation(() => seen.push(ctx.globalCompositeOperation));
        return seen;
    };

    describe('starting a stroke', () => {
        it('fills a dab without clearing or stroking, so dabs accumulate', () => {
            const { ctx } = makeContext();
            paintMaskStroke(ctx, undefined, { x: 3, y: 4 }, 7, '#ff0000');

            expect(ctx.clearRect).not.toHaveBeenCalled();
            expect(ctx.stroke).not.toHaveBeenCalled();
            expect(ctx.arc).toHaveBeenCalledWith(3, 4, 7, 0, Math.PI * 2);
            expect(ctx.fillStyle).toBe('#ff0000');
        });

        it('erases by removing coverage instead of painting a colour over it', () => {
            const { ctx } = makeContext();
            const seen = modeAtDraw(ctx, 'fill');

            paintMaskStroke(ctx, undefined, { x: 1, y: 2 }, 3, '#ff0000', 'erase');

            expect(seen).toEqual(['destination-out']);
        });

        it('paints with source-over even if the caller left another mode in place', () => {
            const { ctx } = makeContext();
            ctx.globalCompositeOperation = 'xor';
            const seen = modeAtDraw(ctx, 'fill');

            paintMaskStroke(ctx, undefined, { x: 1, y: 2 }, 3, '#ff0000');

            expect(seen).toEqual(['source-over']);
        });

        it('restores the composite mode the caller had set', () => {
            const { ctx } = makeContext();
            ctx.globalCompositeOperation = 'multiply';
            paintMaskStroke(ctx, undefined, { x: 1, y: 2 }, 3, '#ff0000', 'erase');

            // A leaked `destination-out` would make the next `drawImage` — the initial-mask
            // conversion — erase the canvas instead of filling it.
            expect(ctx.globalCompositeOperation).toBe('multiply');
        });
    });

    describe('continuing a stroke', () => {
        it('joins the previous dab to the new one, so fast moves are not a row of dots', () => {
            const { ctx } = makeContext();
            paintMaskStroke(ctx, { x: 10, y: 20 }, { x: 90, y: 140 }, 6, '#ff0000');

            expect(ctx.moveTo).toHaveBeenCalledWith(10, 20);
            expect(ctx.lineTo).toHaveBeenCalledWith(90, 140);
            expect(ctx.stroke).toHaveBeenCalled();
        });

        it('strokes at the brush diameter with round ends, reproducing the dab at each end', () => {
            const { ctx } = makeContext();
            paintMaskStroke(ctx, { x: 0, y: 0 }, { x: 5, y: 5 }, 6, '#00ff00');

            expect(ctx.lineWidth).toBe(12);
            expect(ctx.lineCap).toBe('round');
            expect(ctx.lineJoin).toBe('round');
            expect(ctx.strokeStyle).toBe('#00ff00');
        });

        /**
         * Stroking the segment *and* filling a circle at its end would composite the overlap
         * twice, which under `destination-out` subtracts anti-aliased alpha twice and leaves a
         * seam running down the middle of every erased track.
         */
        it('draws the segment once, without also filling a dab at the end', () => {
            const { ctx } = makeContext();
            paintMaskStroke(ctx, { x: 0, y: 0 }, { x: 5, y: 5 }, 6, '#ff0000');

            expect(ctx.fill).not.toHaveBeenCalled();
            expect(ctx.arc).not.toHaveBeenCalled();
            expect(ctx.stroke).toHaveBeenCalledTimes(1);
        });

        it('erases along the segment and restores the composite mode the caller had set', () => {
            const { ctx } = makeContext();
            ctx.globalCompositeOperation = 'multiply';
            const seen = modeAtDraw(ctx, 'stroke');

            paintMaskStroke(ctx, { x: 0, y: 0 }, { x: 5, y: 5 }, 3, '#ff0000', 'erase');

            expect(seen).toEqual(['destination-out']);
            expect(ctx.globalCompositeOperation).toBe('multiply');
        });

        it('opens a fresh path, so a segment cannot inherit the last one', () => {
            const { ctx } = makeContext();
            paintMaskStroke(ctx, { x: 0, y: 0 }, { x: 5, y: 5 }, 3, '#ff0000');

            expect(ctx.beginPath).toHaveBeenCalledTimes(1);
            expect(ctx.clearRect).not.toHaveBeenCalled();
        });
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

describe('applyDetectedMask', () => {
    const setup = () => {
        const silhouetteCtx = {
            fillRect: vi.fn(),
            putImageData: vi.fn(),
            fillStyle: '',
            globalCompositeOperation: 'source-over',
        };
        const silhouette = {
            width: 2,
            height: 2,
            getContext: vi.fn(() => silhouetteCtx),
        } as unknown as HTMLCanvasElement;

        vi.mocked(createCanvas).mockClear();
        const { ctx } = makeContext();
        return { ctx, silhouette, silhouetteCtx };
    };

    it('tints the silhouette with the live colour, discriminating on alpha', () => {
        const { ctx, silhouette, silhouetteCtx } = setup();

        // `source-in` has to be in force when the tint lands, not merely at some point.
        const opAtFill: string[] = [];
        silhouetteCtx.fillRect.mockImplementation(() => opAtFill.push(silhouetteCtx.globalCompositeOperation));

        applyDetectedMask(ctx, { x: 8, y: 4 }, silhouette, '#ff0000');

        expect(silhouetteCtx.fillStyle).toBe('#ff0000');
        expect(silhouetteCtx.fillRect).toHaveBeenCalledWith(0, 0, 2, 2);
        expect(opAtFill).toEqual(['source-in']);
    });

    /**
     * The surface arrives already rasterized. Copying its pixels onto a second canvas — which
     * is what this did, by way of the detection's `ImageData` — was a full-frame round trip
     * and an extra allocation per click, to rebuild something the pipeline had just produced.
     */
    it('tints in place rather than copying onto a scratch canvas', () => {
        const { ctx, silhouette, silhouetteCtx } = setup();

        applyDetectedMask(ctx, { x: 8, y: 4 }, silhouette, '#ff0000');

        expect(createCanvas).not.toHaveBeenCalled();
        expect(silhouetteCtx.putImageData).not.toHaveBeenCalled();
    });

    it('scales the silhouette to the editor canvas size', () => {
        const { ctx, silhouette } = setup();
        applyDetectedMask(ctx, { x: 8, y: 4 }, silhouette, '#ffffff');

        expect(ctx.drawImage).toHaveBeenCalledWith(silhouette, 0, 0, 8, 4);
    });

    it('paints with source-over and restores the composite mode the caller had set', () => {
        const { ctx, silhouette } = setup();
        ctx.globalCompositeOperation = 'multiply';

        const opAtDraw: string[] = [];
        (ctx.drawImage as Mock).mockImplementation(() => opAtDraw.push(ctx.globalCompositeOperation));

        applyDetectedMask(ctx, { x: 8, y: 4 }, silhouette, '#ffffff');

        expect(opAtDraw).toEqual(['source-over']);
        expect(ctx.globalCompositeOperation).toBe('multiply');
    });

    it('erases by subtracting the silhouette coverage', () => {
        const { ctx, silhouette } = setup();

        const opAtDraw: string[] = [];
        (ctx.drawImage as Mock).mockImplementation(() => opAtDraw.push(ctx.globalCompositeOperation));

        applyDetectedMask(ctx, { x: 8, y: 4 }, silhouette, '#ffffff', 'erase');

        expect(opAtDraw).toEqual(['destination-out']);
        expect(ctx.globalCompositeOperation).toBe('source-over');
    });

    it('bails when the silhouette yields no context', () => {
        const { ctx } = setup();
        const silhouette = { width: 2, height: 2, getContext: vi.fn(() => null) } as unknown as HTMLCanvasElement;

        applyDetectedMask(ctx, { x: 8, y: 4 }, silhouette, '#ffffff');
        expect(ctx.drawImage).not.toHaveBeenCalled();
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

describe('tintSilhouette', () => {
    const makeSilhouette = () => {
        const ctx = {
            fillRect: vi.fn(),
            fillStyle: '',
            globalCompositeOperation: 'source-over',
        };
        return {
            ctx,
            silhouette: { width: 2, height: 2, getContext: vi.fn(() => ctx) } as unknown as HTMLCanvasElement,
        };
    };

    it('reports failure rather than throwing when the surface has no context', () => {
        const silhouette = { width: 2, height: 2, getContext: () => undefined } as unknown as HTMLCanvasElement;
        expect(tintSilhouette(silhouette, '#ff0000')).toBe(false);
    });

    /**
     * The whole reason a hover preview may draw a silhouette and the click that commits it may
     * then tint the same surface again. `source-in` under an opaque fill reads alpha and never
     * writes it, so the second pass is a no-op and a colour changed between the two still lands.
     */
    it('is idempotent, and a later colour still wins', () => {
        const { ctx, silhouette } = makeSilhouette();

        const opAtFill: string[] = [];
        ctx.fillRect.mockImplementation(() => opAtFill.push(ctx.globalCompositeOperation));

        expect(tintSilhouette(silhouette, '#ff0000')).toBe(true);
        expect(tintSilhouette(silhouette, '#ff0000')).toBe(true);
        expect(ctx.fillStyle).toBe('#ff0000');

        tintSilhouette(silhouette, '#00ff00');
        expect(ctx.fillStyle).toBe('#00ff00');
        expect(opAtFill).toEqual(['source-in', 'source-in', 'source-in']);
    });
});

describe('drawPreviewSilhouette', () => {
    const setup = () => {
        const silhouetteCtx = { fillRect: vi.fn(), fillStyle: '', globalCompositeOperation: 'source-over' };
        const silhouette = {
            width: 2,
            height: 2,
            getContext: vi.fn(() => silhouetteCtx),
        } as unknown as HTMLCanvasElement;
        const { ctx } = makeContext();
        return { ctx, silhouette, silhouetteCtx };
    };

    const OPTIONS = {
        size: { x: 8, y: 4 },
        color: '#ff0000',
        fillOpacity: 0.2,
        outlineOpacity: 0.9,
        outlineWidth: 2,
    };

    it('does nothing when the silhouette has no context', () => {
        const silhouette = { width: 2, height: 2, getContext: () => undefined } as unknown as HTMLCanvasElement;
        const { ctx } = makeContext();

        drawPreviewSilhouette(ctx, { ...OPTIONS, silhouette });

        expect(ctx.clearRect).not.toHaveBeenCalled();
        expect(ctx.drawImage).not.toHaveBeenCalled();
    });

    it('clears the layer before drawing, so previews replace rather than accumulate', () => {
        const { ctx, silhouette } = setup();

        drawPreviewSilhouette(ctx, { ...OPTIONS, silhouette });

        expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 8, 4);
    });

    /** Eight offset stamps grow the shape, one punch-out leaves the ring, one lays the fill. */
    it('builds the ring by compositing: eight stamps, a punch-out, then the fill underneath', () => {
        const { ctx, silhouette } = setup();

        const calls: { op: string; alpha: number; dx: number; dy: number }[] = [];
        (ctx.drawImage as Mock).mockImplementation((_img: unknown, dx: number, dy: number) => {
            calls.push({ op: ctx.globalCompositeOperation, alpha: ctx.globalAlpha, dx, dy });
        });

        drawPreviewSilhouette(ctx, { ...OPTIONS, silhouette });

        // Eight to grow the shape, one to punch the original back out, one for the fill.
        expect(calls).toHaveLength(10);

        const stamps = calls.slice(0, 8);
        expect(stamps.every((c) => c.op === 'source-over' && c.alpha === 0.9)).toBe(true);
        // Grown by `outlineWidth` in all eight directions, diagonals included — four would
        // leave gaps that read as a dotted outline along every slanted edge.
        expect(stamps.map((c) => `${c.dx},${c.dy}`).sort()).toEqual(
            ['-2,-2', '-2,0', '-2,2', '0,-2', '0,2', '2,-2', '2,0', '2,2'].sort(),
        );

        expect(calls[8]).toEqual({ op: 'destination-out', alpha: 1, dx: 0, dy: 0 });
        expect(calls[9]).toEqual({ op: 'destination-over', alpha: 0.2, dx: 0, dy: 0 });
    });

    /**
     * The fill goes *under* the ring. Stacked over it the two alphas would add up and the rim
     * would read as solid coverage, which is the one thing a preview must never look like.
     */
    it('punches the original back out and lays the fill beneath the ring', () => {
        const { ctx, silhouette } = setup();

        const ops: string[] = [];
        (ctx.drawImage as Mock).mockImplementation(() => ops.push(ctx.globalCompositeOperation));

        drawPreviewSilhouette(ctx, { ...OPTIONS, silhouette });

        expect(ops.slice(7)).toEqual(['source-over', 'destination-out', 'destination-over']);
    });

    /**
     * Unlike `drawCursorCircle`, which leaves its alpha and composite mode set: after a switch
     * back to paint mode the brush outline is the next thing drawn on this layer, and it sets
     * neither back to a known value first.
     */
    it('restores the context state it borrowed', () => {
        const { ctx, silhouette } = setup();

        drawPreviewSilhouette(ctx, { ...OPTIONS, silhouette });

        expect(ctx.save).toHaveBeenCalledOnce();
        expect(ctx.restore).toHaveBeenCalledOnce();
    });

    it('tints the silhouette in the live mask colour', () => {
        const { ctx, silhouette, silhouetteCtx } = setup();

        drawPreviewSilhouette(ctx, { ...OPTIONS, silhouette, color: '#00ff00' });

        expect(silhouetteCtx.fillStyle).toBe('#00ff00');
    });
});
