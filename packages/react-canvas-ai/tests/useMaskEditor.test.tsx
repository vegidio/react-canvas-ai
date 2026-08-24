import { useState } from 'react';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseMaskEditorProps } from '../src/hooks/useMaskEditor';
import { useMaskEditor } from '../src/hooks/useMaskEditor';
import { installImageMock, SRC, settle } from './helpers/image';

beforeEach(() => {
    vi.useFakeTimers();
});

const remockImage = installImageMock({ width: 2480, height: 1240 });

/**
 * Renders the hook against a real mounted DOM tree, because the hook wires refs to live
 * canvas elements and bails out when they are absent.
 */
const setup = (props: Partial<UseMaskEditorProps> = {}) => {
    const onDrawingChange = vi.fn();
    const captured: { current?: ReturnType<typeof useMaskEditor> } = {};

    const Harness = () => {
        const state = useMaskEditor({ src: SRC, onDrawingChange, ...props } as UseMaskEditorProps);
        captured.current = state;
        return (
            <div {...state.containerProps}>
                <canvas ref={state.canvasRef} />
                <canvas ref={state.maskCanvasRef} />
                <canvas
                    ref={state.cursorCanvasRef}
                    onMouseDown={state.handleMouseDown}
                    onMouseUp={state.handleMouseUp}
                />
            </div>
        );
    };

    const utils = render(<Harness />);
    const state = () => captured.current as ReturnType<typeof useMaskEditor>;
    const cursorCanvas = () => state().cursorCanvasRef.current as HTMLCanvasElement;
    return { ...utils, state, cursorCanvas, onDrawingChange };
};

describe('late-mounting canvases', () => {
    /**
     * A headless consumer is free to render the canvas stack conditionally. Because the hook
     * tracks each element as state rather than reading a ref object once, the 2D context and
     * the brush listeners still arrive when the canvas does — this used to attach at mount
     * against nothing and never retry.
     */
    const setupDeferred = () => {
        const captured: { current?: ReturnType<typeof useMaskEditor> } = {};
        let show: (value: boolean) => void = () => {};

        const Harness = () => {
            const [ready, setReady] = useState(false);
            show = setReady;

            const state = useMaskEditor({ src: SRC, onDrawingChange: vi.fn() });
            captured.current = state;

            return (
                <div {...state.containerProps}>
                    {ready ? (
                        <>
                            <canvas ref={state.canvasRef} />
                            <canvas ref={state.maskCanvasRef} />
                            <canvas
                                ref={state.cursorCanvasRef}
                                onMouseDown={state.handleMouseDown}
                                onMouseUp={state.handleMouseUp}
                            />
                        </>
                    ) : undefined}
                </div>
            );
        };

        const utils = render(<Harness />);
        return { ...utils, state: () => captured.current as ReturnType<typeof useMaskEditor>, show };
    };

    it('wires a canvas that mounts after the first render', async () => {
        const { state, show } = setupDeferred();
        await settle();

        expect(state().cursorCanvasRef.current).toBeNull();

        await act(async () => {
            show(true);
        });
        await settle();

        const cursorCanvas = state().cursorCanvasRef.current as HTMLCanvasElement;
        expect(cursorCanvas).toBeInstanceOf(HTMLCanvasElement);

        // A native mousemove, not the declarative onMouseDown prop: this is the listener
        // `useBrushCursor` attaches imperatively, and painting proves the mask layer also got
        // its 2D context. Both used to be wired once at mount and never again.
        const maskCtx = state().maskCanvasRef.current?.getContext('2d') as CanvasRenderingContext2D;
        const arc = vi.spyOn(maskCtx, 'arc');

        act(() => {
            cursorCanvas.dispatchEvent(
                new MouseEvent('mousemove', { bubbles: true, clientX: 5, clientY: 5, buttons: 1 }),
            );
        });

        expect(arc).toHaveBeenCalled();
    });
});

describe('wiring', () => {
    it('starts with empty size and no drawing in progress', () => {
        const { state } = setup();
        expect(state().isDrawing).toBe(false);
        expect(state().key).toBe(0);
    });

    it('requests contexts optimised for frequent reads', async () => {
        const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
        setup();
        await settle();

        expect(spy).toHaveBeenCalledWith('2d', { willReadFrequently: true });
    });
});

describe('image sizing', () => {
    it('scales a large image down within the default bounds', async () => {
        const { state } = setup();
        await settle();
        expect(state().size).toEqual({ x: 1240, y: 620 });
    });

    it('honours an explicit maxWidth', async () => {
        remockImage({ width: 800, height: 600 });
        const { state } = setup({ maxWidth: 400 });
        await settle();
        expect(state().size).toEqual({ x: 400, y: 300 });
    });

    it('clamps tiny images up to a usable size', async () => {
        remockImage({ width: 10, height: 10 });
        const { state } = setup();
        await settle();
        expect(state().size.x).toBeGreaterThanOrEqual(50);
        expect(state().size.y).toBeGreaterThanOrEqual(50);
    });

    it('falls back to a default box for a zero-dimension image', async () => {
        remockImage({ width: 0, height: 0 });
        const { state } = setup();
        await settle();
        expect(state().size).toEqual({ x: 300, y: 200 });
    });

    it('falls back when the image fails to load', async () => {
        remockImage({ width: 400, height: 400, fail: true });
        const { state } = setup();
        await settle();
        expect(state().size).toEqual({ x: 300, y: 200 });
    });

    it('bumps the remount key once the image lands', async () => {
        const { state } = setup();
        await settle();
        expect(state().key).toBeGreaterThan(0);
    });
});

describe('remote sources', () => {
    it('fetches http sources and hands the image a data URL', async () => {
        const blob = new Blob(['x'], { type: 'image/png' });
        const fetchMock = vi.fn(async () => new Response(blob));
        vi.stubGlobal('fetch', fetchMock);

        setup({ src: 'https://example.com/cat.png' });
        await settle();

        // The signal is what lets a superseded load be cancelled mid-flight.
        expect(fetchMock).toHaveBeenCalledWith(
            'https://example.com/cat.png',
            expect.objectContaining({ signal: expect.anything() }),
        );
        vi.unstubAllGlobals();
    });

    it('still loads when the fetch fails', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                throw new Error('offline');
            }),
        );

        const { state } = setup({ src: 'https://example.com/cat.png' });
        await settle();

        expect(state().size.x).toBeGreaterThan(0);
        vi.unstubAllGlobals();
    });
});

describe('cursor size', () => {
    it('initialises from the prop and can be set directly', async () => {
        const { state } = setup({ cursorSize: 25 });
        await settle();
        expect(state().cursorSize).toBe(25);

        act(() => state().setCursorSize(40));
        expect(state().cursorSize).toBe(40);
    });

    it('shrinks on a downward wheel and reports the change', async () => {
        const onCursorSizeChange = vi.fn();
        const { cursorCanvas, state } = setup({ cursorSize: 10, onCursorSizeChange });
        await settle();

        const evt = new WheelEvent('wheel', { deltaY: 100, cancelable: true, bubbles: true });
        act(() => {
            cursorCanvas().dispatchEvent(evt);
        });

        expect(state().cursorSize).toBe(9);
        expect(onCursorSizeChange).toHaveBeenCalledWith(9);
        expect(evt.defaultPrevented).toBe(true);
    });

    it('grows on an upward wheel', async () => {
        const onCursorSizeChange = vi.fn();
        const { cursorCanvas, state } = setup({ cursorSize: 10, onCursorSizeChange });
        await settle();

        act(() => {
            cursorCanvas().dispatchEvent(new WheelEvent('wheel', { deltaY: -100, cancelable: true, bubbles: true }));
        });

        expect(state().cursorSize).toBe(11);
    });

    it('never shrinks below one pixel', async () => {
        const onCursorSizeChange = vi.fn();
        const { cursorCanvas, state } = setup({ cursorSize: 1, onCursorSizeChange });
        await settle();

        act(() => {
            cursorCanvas().dispatchEvent(new WheelEvent('wheel', { deltaY: 100, cancelable: true, bubbles: true }));
        });

        expect(state().cursorSize).toBe(1);
    });

    it('leaves the wheel alone when no size callback is supplied', async () => {
        const { cursorCanvas, state } = setup({ cursorSize: 10 });
        await settle();

        act(() => {
            cursorCanvas().dispatchEvent(new WheelEvent('wheel', { deltaY: 100, cancelable: true, bubbles: true }));
        });

        expect(state().cursorSize).toBe(10);
    });

    it('defers to the zoom handler when ctrl is held', async () => {
        const onCursorSizeChange = vi.fn();
        const { cursorCanvas, state } = setup({ cursorSize: 10, onCursorSizeChange });
        await settle();

        act(() => {
            cursorCanvas().dispatchEvent(
                new WheelEvent('wheel', { deltaY: 100, ctrlKey: true, cancelable: true, bubbles: true }),
            );
        });

        expect(state().cursorSize).toBe(10);
    });
});

describe('brush cursor', () => {
    /** Spies on the drawing primitives of the mask and cursor layers of a mounted harness. */
    const layers = (state: () => ReturnType<typeof useMaskEditor>) => {
        const maskCtx = state().maskCanvasRef.current?.getContext('2d') as CanvasRenderingContext2D;
        const cursorCtx = state().cursorCanvasRef.current?.getContext('2d') as CanvasRenderingContext2D;
        return { mask: vi.spyOn(maskCtx, 'arc'), cursor: vi.spyOn(cursorCtx, 'arc') };
    };

    const move = (el: HTMLElement, init: MouseEventInit = {}) =>
        act(() => {
            el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 5, clientY: 5, ...init }));
        });

    it('repaints the brush outline as the pointer moves, without painting the mask', async () => {
        const { cursorCanvas, state } = setup();
        await settle();
        const arc = layers(state);

        move(cursorCanvas());

        expect(arc.cursor).toHaveBeenCalled();
        expect(arc.mask).not.toHaveBeenCalled();
    });

    it('paints the mask while a button is held', async () => {
        const { cursorCanvas, state } = setup();
        await settle();
        const arc = layers(state);

        move(cursorCanvas(), { buttons: 1 });

        expect(arc.mask).toHaveBeenCalled();
    });

    it('paints nothing while a pan is in progress', async () => {
        const { cursorCanvas, state } = setup();
        await settle();

        // zoomIn rather than setScale: only zoomIn moves `transform.scale`, which is what
        // actually gates the Space pan modifier.
        act(() => {
            state().zoomIn();
        });
        act(() => {
            window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
        });
        const arc = layers(state);

        move(cursorCanvas(), { buttons: 1 });

        // Space is held, so the stroke must not land even though a button is down.
        expect(arc.mask).not.toHaveBeenCalled();
    });
});

describe('drawing', () => {
    const mouse = (el: HTMLElement, type: 'mousedown' | 'mouseup', init: MouseEventInit = {}) =>
        act(() => {
            el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, buttons: 1, ...init }));
        });

    it('flags drawing on mouse down and clears it on mouse up', async () => {
        const { cursorCanvas, state, onDrawingChange } = setup();
        await settle();

        // Reported from the handlers, so mounting alone says nothing: this used to fire a
        // spurious `false` from an effect before the user had touched the canvas.
        expect(onDrawingChange).not.toHaveBeenCalled();

        mouse(cursorCanvas(), 'mousedown');
        expect(state().isDrawing).toBe(true);
        expect(onDrawingChange).toHaveBeenCalledTimes(1);
        expect(onDrawingChange).toHaveBeenLastCalledWith(true);

        mouse(cursorCanvas(), 'mouseup');
        expect(state().isDrawing).toBe(false);
        expect(onDrawingChange).toHaveBeenCalledTimes(2);
        expect(onDrawingChange).toHaveBeenLastCalledWith(false);
    });

    it('reports the mask after a stroke finishes', async () => {
        const onMaskChange = vi.fn();
        const { cursorCanvas } = setup({ onMaskChange });
        await settle();

        mouse(cursorCanvas(), 'mousedown');
        mouse(cursorCanvas(), 'mouseup');
        await settle();

        expect(onMaskChange).toHaveBeenCalled();
    });
});

describe('history actions', () => {
    it('clear, undo and redo each report a mask change', async () => {
        const onMaskChange = vi.fn();
        const { state } = setup({ onMaskChange });
        await settle();

        onMaskChange.mockClear();
        act(() => state().clear());
        expect(onMaskChange).toHaveBeenCalledTimes(1);

        onMaskChange.mockClear();
        act(() => state().undo());
        expect(onMaskChange).toHaveBeenCalledTimes(1);

        onMaskChange.mockClear();
        act(() => state().redo());
        expect(onMaskChange).toHaveBeenCalledTimes(1);
    });

    it('does not throw when no mask callback is supplied', async () => {
        const { state } = setup();
        await settle();

        expect(() => {
            act(() => state().clear());
            act(() => state().undo());
            act(() => state().redo());
        }).not.toThrow();
    });
});

describe('keyboard shortcuts', () => {
    const press = (init: KeyboardEventInit) =>
        act(() => {
            window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
        });

    it('undoes on ctrl+z and redoes on ctrl+y', async () => {
        const onMaskChange = vi.fn();
        setup({ onMaskChange });
        await settle();

        onMaskChange.mockClear();
        press({ key: 'z', ctrlKey: true });
        expect(onMaskChange).toHaveBeenCalled();

        onMaskChange.mockClear();
        press({ key: 'y', ctrlKey: true });
        expect(onMaskChange).toHaveBeenCalled();
    });

    it('accepts the macOS meta variant', async () => {
        const onMaskChange = vi.fn();
        setup({ onMaskChange });
        await settle();

        onMaskChange.mockClear();
        press({ key: 'z', metaKey: true });
        expect(onMaskChange).toHaveBeenCalled();
    });

    it('treats ctrl+shift+z as redo, not undo', async () => {
        const onMaskChange = vi.fn();
        setup({ onMaskChange });
        await settle();

        onMaskChange.mockClear();
        press({ key: 'z', ctrlKey: true, shiftKey: true });
        expect(onMaskChange).toHaveBeenCalled();
    });

    it('ignores shortcuts typed into form fields', async () => {
        const onMaskChange = vi.fn();
        setup({ onMaskChange });
        await settle();

        const input = document.createElement('input');
        document.body.append(input);
        onMaskChange.mockClear();

        act(() => {
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
        });

        expect(onMaskChange).not.toHaveBeenCalled();
        input.remove();
    });

    it('stops listening once unmounted', async () => {
        const onMaskChange = vi.fn();
        const { unmount } = setup({ onMaskChange });
        await settle();

        unmount();
        onMaskChange.mockClear();
        press({ key: 'z', ctrlKey: true });

        expect(onMaskChange).not.toHaveBeenCalled();
    });
});

describe('initialMask', () => {
    it('paints the supplied mask onto the mask layer', async () => {
        const drawImage = vi.spyOn(CanvasRenderingContext2D.prototype, 'drawImage');
        setup({ initialMask: SRC });
        await settle();

        expect(drawImage).toHaveBeenCalled();
    });

    it('does not repaint an unchanged mask on re-render', async () => {
        const drawImage = vi.spyOn(CanvasRenderingContext2D.prototype, 'drawImage');
        const { rerender } = setup({ initialMask: SRC });
        await settle();

        const before = drawImage.mock.calls.length;
        rerender(<div />);
        await settle();

        expect(drawImage.mock.calls.length).toBe(before);
    });

    it('survives a mask that fails to load', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        remockImage({ width: 100, height: 100, fail: true });

        expect(() => setup({ initialMask: SRC })).not.toThrow();
        await settle();
        error.mockRestore();
    });
});

describe('unmount safety', () => {
    it('cancels the pending debounced mask report', async () => {
        const onMaskChange = vi.fn();
        const { unmount } = setup({ onMaskChange });
        await settle();

        unmount();
        onMaskChange.mockClear();
        await act(async () => {
            vi.advanceTimersByTime(1000);
        });

        expect(onMaskChange).not.toHaveBeenCalled();
    });
});

describe('mask colour', () => {
    it('recolours existing strokes when the colour changes', async () => {
        const putImageData = vi.spyOn(CanvasRenderingContext2D.prototype, 'putImageData');

        const Harness = ({ maskColor }: { maskColor: string }) => {
            const state = useMaskEditor({ src: SRC, maskColor, onDrawingChange: vi.fn() });
            return (
                <div {...state.containerProps}>
                    <canvas ref={state.canvasRef} />
                    <canvas ref={state.maskCanvasRef} />
                    <canvas ref={state.cursorCanvasRef} />
                </div>
            );
        };

        const { rerender } = render(<Harness maskColor='#ff0000' />);
        await settle();

        putImageData.mockClear();
        rerender(<Harness maskColor='#00ff00' />);
        await settle();

        expect(putImageData).toHaveBeenCalled();
    });
});

describe('changing src', () => {
    it('keeps the newest image when two loads overlap', async () => {
        // The superseded load resolves *after* the one that replaced it.
        remockImage((src) =>
            src.includes('big') ? { width: 2480, height: 1240, delay: 100 } : { width: 400, height: 400 },
        );

        const Harness = ({ src }: { src: string }) => {
            const state = useMaskEditor({ src, onDrawingChange: vi.fn() });
            sizes.push(state.size);
            return (
                <div {...state.containerProps}>
                    <canvas ref={state.canvasRef} />
                    <canvas ref={state.maskCanvasRef} />
                    <canvas ref={state.cursorCanvasRef} />
                </div>
            );
        };
        const sizes: { x: number; y: number }[] = [];

        const { rerender } = render(<Harness src='big.png' />);
        // Swap before the first load can settle.
        rerender(<Harness src='small.png' />);
        await settle();

        // Regression guard: the load effect used to have an empty cleanup, so the superseded
        // image could resolve last and win.
        expect(sizes[sizes.length - 1]).toEqual({ x: 400, y: 400 });
    });
});
