import { StrictMode } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MaskEditorCanvasRef } from '../src/components/MaskEditor';
import { MaskEditor } from '../src/components/MaskEditor';
import { mockImageLoad } from './helpers/image';

/**
 * StrictMode double-invokes effects and state updaters. Every bug this suite guards against
 * was a side effect running from inside an updater, or a subscription that did not clean up.
 */
const SRC = 'data:image/png;base64,iVBORw0KGgo=';

let restoreImage: () => void;

beforeEach(() => {
    vi.useFakeTimers();
    restoreImage = mockImageLoad({ width: 400, height: 200 });
});

afterEach(() => {
    restoreImage();
});

async function settle() {
    for (let i = 0; i < 5; i++) {
        await act(async () => {
            await Promise.resolve();
            vi.advanceTimersByTime(200);
        });
    }
}

function renderEditor(props: Partial<React.ComponentProps<typeof MaskEditor>> = {}) {
    const api: { current: MaskEditorCanvasRef | null } = { current: null };

    const utils = render(
        <StrictMode>
            <MaskEditor src={SRC} onDrawingChange={vi.fn()} {...props} canvasRef={api} />
        </StrictMode>,
    );

    return { ...utils, api };
}

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

        const cursorCanvas = container.querySelector('.react-mask-editor-cursor-canvas') as HTMLCanvasElement;
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
