import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCanvas } from '../../../src/internal/createCanvas';
import {
    imagePointToInputSpace,
    imageToEncoderInput,
    normalizeToTensor,
    SAM_INPUT_SIZE,
} from '../../../src/internal/sam/preprocess';

vi.mock('../../../src/internal/createCanvas');

const PLANE = SAM_INPUT_SIZE * SAM_INPUT_SIZE;

describe('normalizeToTensor', () => {
    it('applies the per-channel ImageNet statistics in CHW layout', () => {
        const pixels = new Uint8ClampedArray(4);
        pixels[0] = 255; // R of pixel 0
        pixels[1] = 0; // G
        pixels[2] = 128; // B

        const data = normalizeToTensor(pixels, 1, 1);
        expect(data).toHaveLength(3 * PLANE);
        expect(data[0]).toBeCloseTo((255 - 123.675) / 58.395, 5);
        expect(data[PLANE]).toBeCloseTo((0 - 116.28) / 57.12, 5);
        expect(data[2 * PLANE]).toBeCloseTo((128 - 103.53) / 57.375, 5);
    });

    it('writes each source row at the padded frame stride, not the source width', () => {
        const width = 2;
        const height = 2;
        const pixels = new Uint8ClampedArray(width * height * 4);
        // Only the second row is non-black, so its landing offset is unambiguous.
        pixels[8] = 255;
        pixels[12] = 255;

        const data = normalizeToTensor(pixels, width, height);

        expect(data[SAM_INPUT_SIZE]).toBeCloseTo((255 - 123.675) / 58.395, 5);
        expect(data[SAM_INPUT_SIZE + 1]).toBeCloseTo((255 - 123.675) / 58.395, 5);
        // The row's own second slot in a naive width-strided write — must be untouched.
        expect(data[2]).toBe(0);
    });

    /**
     * Regression: the plugin this was ported from normalized the transparent padding like image
     * content, shifting it to ≈ −2.1 per channel instead of the mean-equivalent zero. The
     * padding is now simply never written, so the buffer's own zero fill is the answer.
     */
    it('leaves the letterbox padding at zero in every channel', () => {
        const resizedW = 512;
        const resizedH = 256;
        const pixels = new Uint8ClampedArray(resizedW * resizedH * 4).fill(255);

        const data = normalizeToTensor(pixels, resizedW, resizedH);

        for (let channel = 0; channel < 3; channel += 1) {
            const base = channel * PLANE;
            // Inside the image: the last pixel of the last image row is normalized content.
            expect(data[base + (resizedH - 1) * SAM_INPUT_SIZE + (resizedW - 1)]).not.toBe(0);
            // Right padding of an image row, from the first padded column to the frame edge.
            expect(data[base + (resizedH - 1) * SAM_INPUT_SIZE + resizedW]).toBe(0);
            expect(data[base + (resizedH - 1) * SAM_INPUT_SIZE + SAM_INPUT_SIZE - 1]).toBe(0);
            // Rows below the image are padding across their full width.
            expect(data[base + resizedH * SAM_INPUT_SIZE]).toBe(0);
            expect(data[base + (SAM_INPUT_SIZE - 1) * SAM_INPUT_SIZE + 3]).toBe(0);
        }
    });

    it('fills the whole frame for a square image, leaving no padding', () => {
        const pixels = new Uint8ClampedArray(PLANE * 4).fill(255);
        const data = normalizeToTensor(pixels, SAM_INPUT_SIZE, SAM_INPUT_SIZE);

        expect(data[0]).not.toBe(0);
        expect(data[3 * PLANE - 1]).not.toBe(0);
    });
});

describe('imagePointToInputSpace', () => {
    /**
     * Regression: the plugin this was ported from divided by the bitmap's natural size, but
     * clicks arrive in editor-canvas pixels — off by the fit ratio whenever the editor
     * downscaled the image.
     */
    it('normalizes by the canvas size, not the natural size', () => {
        const [x, y] = imagePointToInputSpace({ x: 100, y: 50 }, { x: 200, y: 100 }, [1024, 512]);
        expect(x).toBe(512);
        expect(y).toBe(256);
    });
});

describe('imageToEncoderInput', () => {
    const drawImage = vi.fn();
    const getImageData = vi.fn();

    beforeEach(() => {
        drawImage.mockReset();
        getImageData.mockReset().mockImplementation((_x: number, _y: number, w: number, h: number) => ({
            data: new Uint8ClampedArray(w * h * 4).fill(255),
        }));
        vi.mocked(createCanvas).mockReturnValue({
            getContext: vi.fn(() => ({ drawImage, getImageData })),
        } as unknown as HTMLCanvasElement);
    });

    it('letterboxes to the long side and reports the resized size', () => {
        const image = { width: 2048, height: 1024, naturalWidth: 2048, naturalHeight: 1024 } as HTMLImageElement;

        const pre = imageToEncoderInput(image);
        // The scratch surface is the resized image, not the padded frame: drawing, reading back
        // and normalizing the padding was work whose only result was overwritten with zeroes.
        expect(createCanvas).toHaveBeenCalledWith(1024, 512);
        expect(drawImage).toHaveBeenCalledWith(image, 0, 0, 1024, 512);
        expect(getImageData).toHaveBeenCalledWith(0, 0, 1024, 512);
        expect(pre.resizedSize).toEqual([1024, 512]);
        expect(pre.dims).toEqual([1, 3, SAM_INPUT_SIZE, SAM_INPUT_SIZE]);
    });

    it('normalizes the image region and leaves the padding at zero', () => {
        const image = { width: 2048, height: 1024, naturalWidth: 2048, naturalHeight: 1024 } as HTMLImageElement;

        const { data } = imageToEncoderInput(image);
        expect(data).toHaveLength(3 * PLANE);
        // Inside the resized image: white pixels, normalized.
        expect(data[0]).toBeCloseTo((255 - 123.675) / 58.395, 5);
        // Below it: letterbox padding, never written.
        expect(data[512 * SAM_INPUT_SIZE]).toBe(0);
    });

    it('throws when no 2D context is available', () => {
        vi.mocked(createCanvas).mockReturnValue({
            getContext: vi.fn(() => null),
        } as unknown as HTMLCanvasElement);

        const image = { width: 10, height: 10, naturalWidth: 10, naturalHeight: 10 } as HTMLImageElement;
        expect(() => imageToEncoderInput(image)).toThrow(/2D context/);
    });
});
