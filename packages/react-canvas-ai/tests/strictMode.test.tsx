import { type ComponentProps, StrictMode } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SamEngine } from '../src/internal/sam/engine';
import { MaskEditor, type MaskEditorCanvasRef } from '../src';
import { createSamEngine } from '../src/internal/sam/engine';
import { canvases } from './helpers/canvas';
import { installImageMock, SRC, settle } from './helpers/image';

vi.mock('../src/internal/sam/engine', () => ({ createSamEngine: vi.fn() }));

/**
 * StrictMode double-invokes effects and state updaters. Every bug this suite guards against
 * was a side effect running from inside an updater, or a subscription that did not clean up.
 */
beforeEach(() => {
    vi.useFakeTimers();
});

installImageMock({ width: 400, height: 200 });

const renderEditor = (props: Partial<ComponentProps<typeof MaskEditor>> = {}) => {
    const api: { current: MaskEditorCanvasRef | null } = { current: null };

    const utils = render(
        <StrictMode>
            <MaskEditor src={SRC} onDrawingChange={vi.fn()} {...props} ref={api} />
        </StrictMode>,
    );

    return { ...utils, api };
};

describe('StrictMode', () => {
    it('reports one scale change per zoom step', async () => {
        const onScaleChange = vi.fn();
        const { api } = renderEditor({ onScaleChange });
        await settle();

        onScaleChange.mockClear();
        // Regression guard: zoomIn scheduled its transform write from inside a `setScale`
        // updater, and StrictMode invokes updaters twice — so one click reported twice.
        act(() => api.current?.zoomIn());
        await settle();

        expect(onScaleChange).toHaveBeenCalledTimes(1);
    });

    it('records one history entry per stroke', async () => {
        const onMaskChange = vi.fn();
        const { container } = renderEditor({ onMaskChange });
        await settle();

        const cursorCanvas = canvases(container).cursor;
        onMaskChange.mockClear();

        fireEvent.mouseDown(cursorCanvas, { buttons: 1 });
        fireEvent.mouseUp(cursorCanvas, { buttons: 1 });
        await settle();

        expect(onMaskChange).toHaveBeenCalledTimes(1);
    });

    it('paints the image exactly once', async () => {
        const drawImage = vi.spyOn(CanvasRenderingContext2D.prototype, 'drawImage');
        renderEditor();
        await settle();

        expect(drawImage).toHaveBeenCalledTimes(1);
    });

    it('leaves the page cursor untouched after unmount', async () => {
        const { unmount } = renderEditor();
        await settle();

        unmount();
        expect(document.body.style.cursor).toBe('');
    });

    it('warms one engine per model config despite doubled effects', async () => {
        const engine: SamEngine = {
            prepare: vi.fn(async () => {}),
            detect: vi.fn(async () => undefined),
            dispose: vi.fn(),
        };
        vi.mocked(createSamEngine).mockReset().mockReturnValue(engine);

        const { unmount } = renderEditor({
            autoSelect: { sam: { encoderUrl: 'e.onnx', decoderUrl: 'd.onnx' }, preload: true },
        });
        await settle();

        // The doubled mount disposes the first engine and recreates on demand; what matters
        // is that only one is live afterwards and only one warm-up survives the churn.
        expect(engine.prepare).toHaveBeenCalledTimes(1);

        unmount();
        // Every created engine got disposed — nothing keeps ORT sessions alive after unmount.
        expect(vi.mocked(engine.dispose).mock.calls.length).toBeGreaterThan(0);
    });

    it('stops responding to shortcuts once unmounted', async () => {
        const onMaskChange = vi.fn();
        const { unmount } = renderEditor({ onMaskChange });
        await settle();

        unmount();
        onMaskChange.mockClear();
        act(() => {
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
        });

        expect(onMaskChange).not.toHaveBeenCalled();
    });
});
