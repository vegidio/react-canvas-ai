import { useState } from 'react';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutoSelectOptions, DetectedObject } from '../src/hooks/useAutoSelect';
import type { MaskEditorMode, UseMaskEditorProps } from '../src/hooks/useMaskEditor';
import type { Detection, SamEngine } from '../src/internal/sam/engine';
import { useMaskEditor } from '../src/hooks/useMaskEditor';
import { applyDetectedMask } from '../src/internal/canvas';
import { createSamEngine } from '../src/internal/sam/engine';
import { installImageMock, SRC, settle } from './helpers/image';

vi.mock('../src/internal/sam/engine', () => ({ createSamEngine: vi.fn() }));
// The compositor is unit-tested on its own; mocking it here keeps these tests about the
// wiring — what got committed, with which mode and colour.
vi.mock('../src/internal/canvas', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    applyDetectedMask: vi.fn(),
}));

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

/**
 * The brush listens on `pointermove` so it can replay `getCoalescedEvents`, so the tests have to
 * speak the same event. `coalesced`, when given, is the buffered samples the browser merged into
 * this one delivery — the positions a fast stroke has to be reconstructed from.
 */
const move = (el: HTMLElement, init: PointerEventInit = {}, coalesced?: { clientX: number; clientY: number }[]) =>
    act(() => {
        const evt = new PointerEvent('pointermove', {
            bubbles: true,
            pointerType: 'mouse',
            clientX: 5,
            clientY: 5,
            ...init,
        });

        if (coalesced) {
            Object.defineProperty(evt, 'getCoalescedEvents', { value: () => coalesced });
        }

        el.dispatchEvent(evt);
    });

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

        // A native pointermove, not the declarative onMouseDown prop: this is the listener
        // `useBrushCursor` attaches imperatively, and painting proves the mask layer also got
        // its 2D context. Both used to be wired once at mount and never again.
        const maskCtx = state().maskCanvasRef.current?.getContext('2d') as CanvasRenderingContext2D;
        const arc = vi.spyOn(maskCtx, 'arc');

        act(() => {
            cursorCanvas.dispatchEvent(
                new PointerEvent('pointermove', {
                    bubbles: true,
                    pointerType: 'mouse',
                    clientX: 5,
                    clientY: 5,
                    buttons: 1,
                }),
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
    it('ignores touch and stylus, which have their own scrolling behaviour', async () => {
        const { cursorCanvas, state } = setup();
        await settle();
        const arc = layers(state);

        move(cursorCanvas(), { pointerType: 'touch', buttons: 1 });

        expect(arc.mask).not.toHaveBeenCalled();
        expect(arc.cursor).not.toHaveBeenCalled();
    });
});

/**
 * Move events are delivered at most once a frame, so a stroke faster than a brush width per
 * frame used to land as a row of disconnected dots. Two things keep it continuous: consecutive
 * dabs are joined into a segment, and every position the browser buffered into one delivery is
 * replayed rather than only the last.
 */
describe('stroke continuity', () => {
    /**
     * Spies on the mask layer's path calls: `arc` is an isolated dab, `lineTo` a join.
     *
     * Cleared on install, because `vitest-canvas-mock` already supplies these as mocks and
     * `spyOn` hands back the existing one — history and all. Without the reset, a spy taken
     * part-way through a test would count the dabs that came before it.
     */
    const strokes = (state: () => ReturnType<typeof useMaskEditor>) => {
        const maskCtx = state().maskCanvasRef.current?.getContext('2d') as CanvasRenderingContext2D;
        const spies = {
            arc: vi.spyOn(maskCtx, 'arc'),
            moveTo: vi.spyOn(maskCtx, 'moveTo'),
            lineTo: vi.spyOn(maskCtx, 'lineTo'),
        };

        for (const spy of Object.values(spies)) spy.mockClear();
        return spies;
    };

    const press = (el: HTMLElement, init: MouseEventInit = {}) =>
        act(() => {
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, buttons: 1, ...init }));
        });

    const release = (el: HTMLElement) =>
        act(() => {
            el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        });

    it('joins consecutive positions into a segment instead of stamping separate dots', async () => {
        const { cursorCanvas, state } = setup();
        await settle();
        const path = strokes(state);

        press(cursorCanvas(), { clientX: 10, clientY: 10 });
        move(cursorCanvas(), { clientX: 200, clientY: 160, buttons: 1 });

        // The press is the isolated dab that opens the stroke; the move is joined to it.
        expect(path.arc).toHaveBeenCalledTimes(1);
        expect(path.moveTo).toHaveBeenCalledTimes(1);
        expect(path.lineTo).toHaveBeenCalledTimes(1);
    });

    it('replays every position the browser buffered into one delivery', async () => {
        const { cursorCanvas, state } = setup();
        await settle();
        const path = strokes(state);

        press(cursorCanvas(), { clientX: 10, clientY: 10 });
        move(cursorCanvas(), { clientX: 200, clientY: 160, buttons: 1 }, [
            { clientX: 60, clientY: 50 },
            { clientX: 130, clientY: 110 },
            { clientX: 200, clientY: 160 },
        ]);

        // One segment per sample, not one for the whole delivery: the chord between two frames
        // is not the path the hand took.
        expect(path.lineTo).toHaveBeenCalledTimes(3);
    });

    it('starts a fresh stroke on a press, rather than joining to where the last one ended', async () => {
        const { cursorCanvas, state } = setup();
        await settle();

        press(cursorCanvas(), { clientX: 10, clientY: 10 });
        move(cursorCanvas(), { clientX: 40, clientY: 40, buttons: 1 });
        release(cursorCanvas());

        const path = strokes(state);
        press(cursorCanvas(), { clientX: 300, clientY: 220 });

        // A join here would rule a line clear across the mask from the previous stroke's end.
        expect(path.arc).toHaveBeenCalledTimes(1);
        expect(path.lineTo).not.toHaveBeenCalled();
    });

    /**
     * The cursor layer only hears a release that happens over it. A press that started on a
     * toolbar and dragged in arrives as a move with a button already held, and joining that to
     * a dab left over from an earlier stroke would rule a line across the mask.
     */
    it('drops the last dab when the button is released outside the canvas', async () => {
        const { cursorCanvas, state } = setup();
        await settle();

        press(cursorCanvas(), { clientX: 10, clientY: 10 });
        move(cursorCanvas(), { clientX: 40, clientY: 40, buttons: 1 });

        act(() => {
            window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        });

        const path = strokes(state);
        move(cursorCanvas(), { clientX: 300, clientY: 220, buttons: 1 });

        expect(path.arc).toHaveBeenCalledTimes(1);
        expect(path.lineTo).not.toHaveBeenCalled();
    });

    /**
     * iOS Safari omits `getCoalescedEvents` in some contexts — the omission that forced the
     * first attempt at this upstream to be reverted. The delivered event is then the one
     * sample there is, and the stroke still has to land.
     */
    it('falls back to the delivered position where coalesced events are unavailable', async () => {
        const { cursorCanvas, state } = setup();
        await settle();
        const path = strokes(state);

        press(cursorCanvas(), { clientX: 10, clientY: 10 });
        act(() => {
            const evt = new PointerEvent('pointermove', {
                bubbles: true,
                pointerType: 'mouse',
                clientX: 200,
                clientY: 160,
                buttons: 1,
            });
            Object.defineProperty(evt, 'getCoalescedEvents', { value: undefined });
            cursorCanvas().dispatchEvent(evt);
        });

        expect(path.lineTo).toHaveBeenCalledTimes(1);
    });

    it('breaks the join when shift flips the stroke from painting to erasing', async () => {
        const { cursorCanvas, state } = setup();
        await settle();

        press(cursorCanvas(), { clientX: 10, clientY: 10 });
        move(cursorCanvas(), { clientX: 40, clientY: 40, buttons: 1 });

        const path = strokes(state);
        move(cursorCanvas(), { clientX: 80, clientY: 70, buttons: 1, shiftKey: true });

        // A connector drawn in the new mode across ground covered in the old one is not what
        // the hand asked for, so the erase half opens with its own dab.
        expect(path.arc).toHaveBeenCalledTimes(1);
        expect(path.lineTo).not.toHaveBeenCalled();
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
    it('converts the loaded mask instead of blitting it over a white fill', async () => {
        const fillRect = vi.spyOn(CanvasRenderingContext2D.prototype, 'fillRect');
        const putImageData = vi.spyOn(CanvasRenderingContext2D.prototype, 'putImageData');
        remockImage({ width: 100, height: 100 });

        setup({ initialMask: SRC });
        await settle();

        // The white fill is what made a loaded mask read back as masked everywhere, and made a
        // later colour change tint the regions that were *not* masked.
        expect(fillRect).not.toHaveBeenCalled();
        expect(putImageData).toHaveBeenCalled();
    });

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

describe('erasing', () => {
    /**
     * The composite mode in force at each mask fill. Read after the fact it would always say
     * `source-over`, because `paintMaskDot` restores what it found.
     */
    const modesAtFill = (state: () => ReturnType<typeof useMaskEditor>) => {
        const ctx = state().maskCanvasRef.current?.getContext('2d') as CanvasRenderingContext2D;
        const seen: string[] = [];
        vi.spyOn(ctx, 'fill').mockImplementation(() => seen.push(ctx.globalCompositeOperation));
        return { ctx, seen };
    };

    it('paints with source-over on a plain drag', async () => {
        const { cursorCanvas, state } = setup();
        await settle();
        const { seen } = modesAtFill(state);

        move(cursorCanvas(), { buttons: 1 });

        expect(seen).toEqual(['source-over']);
    });

    it('erases while shift is held', async () => {
        const { cursorCanvas, state } = setup();
        await settle();
        const { ctx, seen } = modesAtFill(state);

        move(cursorCanvas(), { buttons: 1, shiftKey: true });

        // This used to paint opaque white, which smeared white over the image at `maskOpacity`
        // instead of revealing it, and still exported as masked.
        expect(seen).toEqual(['destination-out']);
        expect(ctx.globalCompositeOperation).toBe('source-over');
    });

    it('erases with the secondary mouse button', async () => {
        const { cursorCanvas, state } = setup();
        await settle();
        const { seen } = modesAtFill(state);

        move(cursorCanvas(), { buttons: 2 });

        expect(seen).toEqual(['destination-out']);
    });
});

describe('mask colour', () => {
    it('does not walk the mask at mount', async () => {
        // `appliedMaskColorRef` started as `undefined`, so every mount ran a full
        // getImageData/putImageData pass over a canvas that was still blank.
        const putImageData = vi.spyOn(CanvasRenderingContext2D.prototype, 'putImageData');

        setup({ maskColor: '#ff0000' });
        await settle();

        expect(putImageData).not.toHaveBeenCalled();
    });

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

describe('auto-selection', () => {
    const AUTO: AutoSelectOptions = { sam: { encoderUrl: 'e.onnx', decoderUrl: 'd.onnx' } };

    const DETECTED: DetectedObject = {
        id: 'sam-1',
        score: 0.9,
        bbox: { x: 0, y: 0, width: 2, height: 2 },
        mask: new ImageData(2, 2),
    };

    // The editor composites from the surface the detection was rasterized on, and hands
    // `DETECTED` itself to consumers — the assertions below pin both halves.
    const SILHOUETTE = document.createElement('canvas');
    const DETECTION: Detection = { object: DETECTED, silhouette: SILHOUETTE };

    let engine: SamEngine;

    beforeEach(() => {
        engine = {
            prepare: vi.fn(async () => {}),
            detect: vi.fn(async () => DETECTION),
            dispose: vi.fn(),
        };
        // `restoreAllMocks` in the shared teardown only touches spies, so the module
        // mocks keep their call history unless reset here.
        vi.mocked(createSamEngine).mockReset().mockReturnValue(engine);
        vi.mocked(applyDetectedMask).mockReset();
    });

    const mouse = (el: HTMLElement, type: 'mousedown' | 'mouseup', init: MouseEventInit = {}) =>
        act(() => {
            el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
        });

    const click = async (el: HTMLElement, init: MouseEventInit = {}) => {
        mouse(el, 'mousedown', init);
        mouse(el, 'mouseup', init);
        await settle();
    };

    it('forces paint mode and warns when autoSelect is not configured', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { state } = setup();
        await settle();

        expect(state().mode).toBe('paint');
        expect(state().autoSelectStatus).toBe('idle');

        act(() => state().setMode('auto'));
        expect(state().mode).toBe('paint');
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('autoSelect'));
    });

    it('enters auto mode through setMode and notifies once per change', async () => {
        const onModeChange = vi.fn();
        const { state } = setup({ autoSelect: AUTO, onModeChange });
        await settle();

        act(() => state().setMode('auto'));
        expect(state().mode).toBe('auto');
        expect(onModeChange).toHaveBeenCalledTimes(1);
        expect(onModeChange).toHaveBeenCalledWith('auto');

        act(() => state().setMode('auto'));
        expect(onModeChange).toHaveBeenCalledTimes(1);
    });

    it('follows the mode prop when it changes', async () => {
        const captured: { current?: ReturnType<typeof useMaskEditor> } = {};
        let setModeProp: (mode: MaskEditorMode) => void = () => {};

        const Harness = () => {
            const [modeProp, set] = useState<MaskEditorMode>('paint');
            setModeProp = set;
            const state = useMaskEditor({ src: SRC, onDrawingChange: vi.fn(), autoSelect: AUTO, mode: modeProp });
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

        render(<Harness />);
        await settle();

        act(() => setModeProp('auto'));
        expect(captured.current?.mode).toBe('auto');
    });

    it('warms the model on the first entry into auto mode and keeps it warm after leaving', async () => {
        const { state } = setup({ autoSelect: AUTO });
        await settle();
        expect(createSamEngine).not.toHaveBeenCalled();

        act(() => state().setMode('auto'));
        await settle();
        expect(engine.prepare).toHaveBeenCalledTimes(1);

        // Toggling back must not tear the model down — re-entering auto would otherwise
        // re-download and re-encode every time.
        act(() => state().setMode('paint'));
        await settle();
        expect(engine.dispose).not.toHaveBeenCalled();
    });

    it('warms as soon as the image decodes when preload is on', async () => {
        setup({ autoSelect: { ...AUTO, preload: true } });
        await settle();

        expect(engine.prepare).toHaveBeenCalled();
    });

    it('suppresses brush dabs and drawing state in auto mode', async () => {
        const { state, cursorCanvas, onDrawingChange } = setup({ autoSelect: AUTO });
        await settle();
        act(() => state().setMode('auto'));

        const maskCtx = state().maskCanvasRef.current?.getContext('2d') as CanvasRenderingContext2D;
        const arc = vi.spyOn(maskCtx, 'arc');

        act(() => {
            cursorCanvas().dispatchEvent(
                new PointerEvent('pointermove', {
                    bubbles: true,
                    pointerType: 'mouse',
                    clientX: 5,
                    clientY: 5,
                    buttons: 1,
                }),
            );
        });
        mouse(cursorCanvas(), 'mousedown', { buttons: 1 });

        expect(arc).not.toHaveBeenCalled();
        expect(state().isDrawing).toBe(false);
        expect(onDrawingChange).not.toHaveBeenCalled();
    });

    it('commits a click through history and reports the mask', async () => {
        const onMaskChange = vi.fn();
        const onObjectDetected = vi.fn();
        const { state, cursorCanvas } = setup({ autoSelect: { ...AUTO, onObjectDetected }, onMaskChange });
        await settle();
        act(() => state().setMode('auto'));
        await settle();
        onMaskChange.mockClear();

        await click(cursorCanvas(), { clientX: 5, clientY: 5 });

        expect(engine.detect).toHaveBeenCalledTimes(1);
        expect(applyDetectedMask).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            SILHOUETTE,
            '#ffffff',
            'paint',
        );
        expect(state().historyLength).toBe(1);
        expect(state().historyIndex).toBe(0);
        expect(onMaskChange).toHaveBeenCalled();
        expect(onObjectDetected).toHaveBeenCalledWith(DETECTED);
    });

    it('subtracts the detected object on shift-click', async () => {
        const { state, cursorCanvas } = setup({ autoSelect: AUTO });
        await settle();
        act(() => state().setMode('auto'));
        await settle();

        await click(cursorCanvas(), { clientX: 5, clientY: 5, shiftKey: true });

        expect(applyDetectedMask).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            SILHOUETTE,
            '#ffffff',
            'erase',
        );
    });

    it('subtracts on a right-click too, matching paint-mode erase', async () => {
        const { state, cursorCanvas } = setup({ autoSelect: AUTO });
        await settle();
        act(() => state().setMode('auto'));
        await settle();

        await click(cursorCanvas(), { clientX: 5, clientY: 5, button: 2 });

        expect(applyDetectedMask).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            SILHOUETTE,
            '#ffffff',
            'erase',
        );
    });

    it('treats a press that travelled past the slop as a drag, not a click', async () => {
        const { state, cursorCanvas } = setup({ autoSelect: AUTO });
        await settle();
        act(() => state().setMode('auto'));
        await settle();

        mouse(cursorCanvas(), 'mousedown', { clientX: 5, clientY: 5 });
        mouse(cursorCanvas(), 'mouseup', { clientX: 50, clientY: 50 });
        await settle();

        expect(engine.detect).not.toHaveBeenCalled();
    });

    it('ignores clicks while a detection is in flight', async () => {
        let release: (value: Detection) => void = () => {};
        vi.mocked(engine.detect).mockImplementation(() => new Promise((resolve) => (release = resolve)));

        const { state, cursorCanvas } = setup({ autoSelect: AUTO });
        await settle();
        act(() => state().setMode('auto'));
        await settle();

        await click(cursorCanvas(), { clientX: 5, clientY: 5 });
        await click(cursorCanvas(), { clientX: 6, clientY: 6 });
        expect(engine.detect).toHaveBeenCalledTimes(1);

        await act(async () => release(DETECTION));
    });

    it('routes a failed click detection to onError', async () => {
        const onError = vi.fn();
        vi.mocked(engine.detect).mockRejectedValue(new Error('inference failed'));

        const { state, cursorCanvas } = setup({ autoSelect: { ...AUTO, onError } });
        await settle();
        act(() => state().setMode('auto'));
        await settle();

        await click(cursorCanvas(), { clientX: 5, clientY: 5 });

        expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'inference failed' }));
        expect(applyDetectedMask).not.toHaveBeenCalled();
    });

    it('selectAt commits like a click and resolves with the detection', async () => {
        const onMaskChange = vi.fn();
        const { state } = setup({ autoSelect: AUTO, onMaskChange });
        await settle();
        onMaskChange.mockClear();

        let detected: DetectedObject | undefined;
        await act(async () => {
            detected = await state().selectAt({ x: 3, y: 4 });
        });

        expect(detected).toBe(DETECTED);
        expect(engine.detect).toHaveBeenCalledWith(
            expect.anything(),
            { x: 3, y: 4 },
            expect.anything(),
            expect.anything(),
        );
        expect(state().historyLength).toBe(1);
        expect(onMaskChange).toHaveBeenCalled();
    });

    it('selectAt rejects when autoSelect is not configured', async () => {
        const { state } = setup();
        await settle();

        await expect(state().selectAt({ x: 1, y: 1 })).rejects.toThrow(/autoSelect/);
    });

    it('undoes an auto selection like a stroke', async () => {
        const { state, cursorCanvas } = setup({ autoSelect: AUTO });
        await settle();
        act(() => state().setMode('auto'));
        await settle();

        await click(cursorCanvas(), { clientX: 5, clientY: 5 });
        expect(state().historyIndex).toBe(0);

        act(() => state().undo());
        expect(state().historyIndex).toBe(-1);
    });
});
