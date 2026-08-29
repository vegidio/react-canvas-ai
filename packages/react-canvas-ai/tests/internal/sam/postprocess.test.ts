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
    it('marks strictly positive logits as covered, RGB stays zero', () => {
        const image = logitsToAlpha(Float32Array.from([1, -1, 0.5, 0]), 2, 2);

        expect([...image.data]).toEqual([0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 0, 0]);
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
    };
    let logitCanvas: HTMLCanvasElement;
    let targetCanvas: HTMLCanvasElement;

    beforeEach(() => {
        logitCtx.putImageData.mockReset();
        targetCtx.drawImage.mockReset();
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

    it('rasterizes the thresholded logits before scaling', () => {
        const logits = new Float32Array(256 * 256);
        logits[0] = 2;
        logitsToMask(logits, [256, 256], [1024, 1024], 8, 4);

        const [image] = logitCtx.putImageData.mock.calls[0] as [ImageData];
        expect(image.data[3]).toBe(255);
        expect(image.data[7]).toBe(0);
    });

    it('returns the scaled mask with its bounding box', () => {
        const { mask, bbox } = logitsToMask(new Float32Array(256 * 256), [256, 256], [1024, 512], 8, 4);

        expect(mask.width).toBe(8);
        expect(bbox).toEqual({ x: 2, y: 1, width: 1, height: 1 });
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
