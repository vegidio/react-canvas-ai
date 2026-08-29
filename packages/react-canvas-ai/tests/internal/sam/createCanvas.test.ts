import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvas } from '../../../src/internal/sam/createCanvas';

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('createCanvas', () => {
    it('prefers OffscreenCanvas when the platform provides one', () => {
        class OffscreenCanvasStub {
            width: number;
            height: number;
            constructor(width: number, height: number) {
                this.width = width;
                this.height = height;
            }
        }
        vi.stubGlobal('OffscreenCanvas', OffscreenCanvasStub);

        const canvas = createCanvas(64, 32);
        expect(canvas).toBeInstanceOf(OffscreenCanvasStub);
        expect(canvas.width).toBe(64);
        expect(canvas.height).toBe(32);
    });

    it('falls back to a detached element otherwise', () => {
        vi.stubGlobal('OffscreenCanvas', undefined);

        const canvas = createCanvas(64, 32) as HTMLCanvasElement;
        expect(canvas.tagName).toBe('CANVAS');
        expect(canvas.width).toBe(64);
        expect(canvas.height).toBe(32);
        // Detached on purpose: nothing about preprocessing needs the DOM.
        expect(canvas.isConnected).toBe(false);
    });
});
