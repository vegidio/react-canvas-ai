import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCanvas } from '../../../src/internal/createCanvas';
import { alphaBoundingBox, logitsToAlpha, logitsToMask, pickBestMask } from '../../../src/internal/sam/postprocess';

vi.mock('../../../src/internal/createCanvas');

const makeAlphaImage = (width: number, height: number, alphaAt: Array<[number, number, number?]>): ImageData => {
    const image = new ImageData(width, height);
    for (const [x, y, alpha = 255] of alphaAt) {
        image.data[(y * width + x) * 4 + 3] = alpha;
    }
    return image;
};

describe('logitsToAlpha', () => {
    it('ramps alpha with the logit instead of thresholding it, RGB stays zero', () => {
        // ceil(127 + logit * 128 / 8), clamped: the sub-pixel edge the upscale interpolates.
        const { image } = logitsToAlpha(Float32Array.from([1, -1, 0.5, 0]), 2, 2);

        expect([...image.data]).toEqual([0, 0, 0, 143, 0, 0, 0, 111, 0, 0, 0, 135, 0, 0, 0, 127]);
    });

    it('saturates logits past the ramp', () => {
        const { image } = logitsToAlpha(Float32Array.from([40, -40, 8, -8]), 2, 2);

        expect([image.data[3], image.data[7], image.data[11], image.data[15]]).toEqual([255, 0, 255, 0]);
    });

    /**
     * The half-coverage rule the editor exports by has to split the mask exactly where the
     * model does, or the ramp would quietly grow or shrink every detection by a rim.
     */
    it('crosses half coverage exactly at logit zero', () => {
        const logits = Float32Array.from([0, 1e-3, -1e-3, 0]);
        const { image } = logitsToAlpha(logits, 2, 2);

        expect(image.data[3]).toBeLessThan(128);
        expect(image.data[7]).toBeGreaterThanOrEqual(128);
        expect(image.data[11]).toBeLessThan(128);
    });

    /**
     * The bounds come from this pass rather than a scan of the upscaled result, which is what
     * lets a hover preview skip the full-frame readback entirely.
     */
    it('bounds the coverage in the same pass', () => {
        const { bounds } = logitsToAlpha(Float32Array.from([1, -1, 0.5, 0]), 2, 2);

        expect(bounds).toEqual({ x: 0, y: 0, width: 1, height: 2 });
    });

    it('reports a zero-sized box when nothing is covered', () => {
        const { bounds } = logitsToAlpha(Float32Array.from([-1, -1, 0, 0]), 2, 2);

        expect(bounds).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    });
});

describe('alphaBoundingBox', () => {
    it('finds the tight box around covered pixels', () => {
        const image = makeAlphaImage(4, 4, [
            [1, 1],
            [2, 2],
        ]);
        expect(alphaBoundingBox(image)).toEqual({ x: 1, y: 1, width: 2, height: 2 });
    });

    it('reports a zero-sized box for an empty mask', () => {
        expect(alphaBoundingBox(new ImageData(4, 4))).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    });

    it('ignores alpha below half coverage', () => {
        const image = makeAlphaImage(4, 4, [[0, 0, 127]]);
        expect(alphaBoundingBox(image)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    });
});

describe('pickBestMask', () => {
    it('returns the index with the highest IoU', () => {
        expect(pickBestMask(Float32Array.from([0.2, 0.9, 0.5]), 3)).toBe(1);
    });

    it('reads only the first numMasks entries', () => {
        expect(pickBestMask(Float32Array.from([0.2, 0.3, 0.99]), 2)).toBe(1);
    });
});

describe('logitsToMask', () => {
    const logitCtx = { putImageData: vi.fn() };
    const targetCtx = {
        imageSmoothingEnabled: false,
        drawImage: vi.fn(),
        getImageData: vi.fn(),
        putImageData: vi.fn(),
    };
    let logitCanvas: HTMLCanvasElement;
    let targetCanvas: HTMLCanvasElement;

    beforeEach(() => {
        logitCtx.putImageData.mockReset();
        targetCtx.drawImage.mockReset();
        targetCtx.putImageData.mockReset();
        targetCtx.getImageData.mockReset().mockReturnValue(makeAlphaImage(8, 4, [[2, 1]]));

        logitCanvas = { getContext: vi.fn(() => logitCtx) } as unknown as HTMLCanvasElement;
        targetCanvas = { getContext: vi.fn(() => targetCtx) } as unknown as HTMLCanvasElement;
        vi.mocked(createCanvas).mockReset().mockReturnValueOnce(logitCanvas).mockReturnValueOnce(targetCanvas);
    });

    /**
     * The low-res mask covers the padded 1024 frame; only the unpadded subregion may be
     * sampled, or the letterbox leaks into the right/bottom of non-square masks.
     */
    it('stretches only the unpadded subregion to the target size', () => {
        logitsToMask(new Float32Array(256 * 256), [256, 256], [1024, 512], 800, 400);

        // srcW = 256 * 1024 / 1024, srcH = 256 * 512 / 1024.
        expect(targetCtx.drawImage).toHaveBeenCalledWith(logitCanvas, 0, 0, 256, 128, 0, 0, 800, 400);
        expect(targetCtx.imageSmoothingEnabled).toBe(true);
    });

    it('rasterizes the ramped logits before scaling', () => {
        const logits = new Float32Array(256 * 256);
        logits[0] = 2;
        logitsToMask(logits, [256, 256], [1024, 1024], 8, 4);

        const [image] = logitCtx.putImageData.mock.calls[0] as [ImageData];
        expect(image.data[3]).toBe(159);
        expect(image.data[7]).toBe(127);
    });

    /**
     * Both are deferred: a hover preview draws the silhouette and reads neither, so making the
     * full-frame readback unconditional charged every speculative detection for output nobody
     * asked for. The values are the ones an eager read would have produced.
     */
    it('reads the mask and its bounding box on demand, not up front', () => {
        const rasterized = logitsToMask(new Float32Array(256 * 256), [256, 256], [1024, 512], 8, 4);

        expect(targetCtx.getImageData).not.toHaveBeenCalled();

        expect(rasterized.readMask().width).toBe(8);
        expect(rasterized.readBbox()).toEqual({ x: 2, y: 1, width: 1, height: 1 });
    });

    it('reads the pixels once however often they are asked for', () => {
        const rasterized = logitsToMask(new Float32Array(256 * 256), [256, 256], [1024, 512], 8, 4);

        rasterized.readMask();
        rasterized.readBbox();
        rasterized.readMask();

        expect(targetCtx.getImageData).toHaveBeenCalledTimes(1);
    });

    /**
     * Judged on the low-res mask, so emptiness costs no readback — the one fact `engine.detect`
     * needs before it can decide whether there is a detection at all.
     */
    it('reports an all-negative mask as empty, without reading a pixel back', () => {
        const { isEmpty } = logitsToMask(new Float32Array(256 * 256), [256, 256], [1024, 512], 8, 4);

        expect(isEmpty).toBe(true);
        expect(targetCtx.getImageData).not.toHaveBeenCalled();
    });

    it('reports a mask with any coverage as non-empty', () => {
        const logits = new Float32Array(256 * 256);
        logits[0] = 2;

        expect(logitsToMask(logits, [256, 256], [1024, 512], 8, 4).isEmpty).toBe(false);
    });

    /**
     * The rim is the point of the ramp, but stretched by the upscale it spreads over many
     * pixels and reads as a glow. Rescaling it about half coverage tightens it in place: 127
     * and 128 stay either side of the threshold, so the contour itself cannot move.
     */
    it('narrows the anti-aliased rim without moving the contour', () => {
        const logits = new Float32Array(256 * 256);
        logits[0] = 2;
        targetCtx.getImageData.mockReturnValue(
            makeAlphaImage(4, 1, [
                [0, 0, 127],
                [1, 0, 128],
                [2, 0, 100],
                [3, 0, 255],
            ]),
        );

        logitsToMask(logits, [256, 256], [1024, 1024], 2048, 2048);

        // gain = scale 8 / 1.5px, applied about 127.5.
        const [image, x, y] = targetCtx.putImageData.mock.calls[0] as [ImageData, number, number];
        expect([image.data[3], image.data[7], image.data[11], image.data[15]]).toEqual([125, 130, 0, 255]);
        expect([x, y]).toEqual([0, 0]);
    });

    it('leaves the rim alone when the mask is scaled down', () => {
        const logits = new Float32Array(256 * 256);
        logits[0] = 2;

        logitsToMask(logits, [256, 256], [1024, 1024], 64, 64);

        expect(targetCtx.putImageData).not.toHaveBeenCalled();
    });

    /** A draw region, so it only has to *contain* the shape — generous is fine, short is not. */
    it('hands back a paint rect that contains the silhouette', () => {
        const logits = new Float32Array(256 * 256);
        logits[0] = 2;

        const { paintRect } = logitsToMask(logits, [256, 256], [1024, 1024], 256, 256);

        expect(paintRect.x).toBe(0);
        expect(paintRect.y).toBe(0);
        expect(paintRect.width).toBeGreaterThanOrEqual(1);
        expect(paintRect.height).toBeGreaterThanOrEqual(1);
    });

    it('reports an empty paint rect for an empty mask', () => {
        const { paintRect } = logitsToMask(new Float32Array(256 * 256), [256, 256], [1024, 512], 8, 4);

        expect(paintRect).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    });

    /**
     * The pixels and the surface they were read off are the same picture. Handing both back
     * lets the editor composite from the canvas while consumers still get the `ImageData`,
     * instead of putting those pixels onto a second canvas to draw them.
     */
    it('hands back the surface the silhouette was rasterized on', () => {
        const { silhouette } = logitsToMask(new Float32Array(256 * 256), [256, 256], [1024, 512], 8, 4);

        expect(silhouette).toBe(targetCanvas);
    });

    it('throws when a 2D context is unavailable', () => {
        vi.mocked(createCanvas)
            .mockReset()
            .mockReturnValue({ getContext: vi.fn(() => null) } as unknown as HTMLCanvasElement);

        expect(() => logitsToMask(new Float32Array(4), [2, 2], [1024, 1024], 8, 4)).toThrow(/2D context/);
    });
});
