import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZoomPanOptions } from '../src/hooks/useZoomPan';
import { useZoomPan } from '../src/hooks/useZoomPan';

const CONTENT = { x: 100, y: 100 };

let container: HTMLDivElement;

/**
 * jsdom reports a zero-sized box and an empty padding string. `calculateBaseScale` runs
 * `parseFloat` over that padding, so without a real value baseScale comes out NaN.
 */
function mountContainer(width = 200, height = 200) {
    const el = document.createElement('div');
    el.style.padding = '0px';
    document.body.append(el);
    for (const [key, value] of [
        ['clientWidth', width],
        ['clientHeight', height],
    ] as const) {
        Object.defineProperty(el, key, { value, configurable: true });
    }
    el.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0 }) as DOMRect;
    return el;
}

function setup(options: ZoomPanOptions = {}, contentSize = CONTENT) {
    const ref = { current: container } as React.RefObject<HTMLDivElement | null>;
    return renderHook(() => useZoomPan(ref, contentSize, options));
}

/** Advance past the setTimeout(..., 0) that several actions defer their callbacks with. */
function flush() {
    act(() => {
        vi.advanceTimersByTime(10);
    });
}

/** Raise `transform.scale` above 1, which is what actually gates panning. */
function zoomInto(result: { current: readonly [unknown, { zoomIn: () => void }] }) {
    act(() => result.current[1].zoomIn());
    flush();
    act(() => result.current[1].zoomIn());
    flush();
}

beforeEach(() => {
    vi.useFakeTimers();
    container = mountContainer();
});

afterEach(() => {
    container.remove();
});

describe('base scale', () => {
    it('is finite when the container reports a real box', () => {
        const { result } = setup();
        expect(Number.isFinite(result.current[0].baseScale)).toBe(true);
        expect(result.current[0].baseScale).toBe(1);
    });

    it('scales down content larger than the container', () => {
        const { result } = setup({}, { x: 400, y: 400 });
        expect(result.current[0].baseScale).toBe(0.5);
    });

    it('honours initialScale', () => {
        const { result } = setup({ initialScale: 2 });
        expect(result.current[0].scale).toBe(2);
    });
});

describe('zoom actions', () => {
    it('zoomIn steps up and reports the new scale', () => {
        const onScaleChange = vi.fn();
        const { result } = setup({ onScaleChange });

        act(() => result.current[1].zoomIn());
        flush();

        expect(result.current[0].scale).toBeCloseTo(1.2);
        expect(onScaleChange).toHaveBeenCalledWith(expect.closeTo(1.2));
    });

    it('clamps at maxScale and stops reporting once pinned', () => {
        const onScaleChange = vi.fn();
        const { result } = setup({ onScaleChange });

        for (let i = 0; i < 30; i++) act(() => result.current[1].zoomIn());
        flush();
        expect(result.current[0].scale).toBe(4);

        onScaleChange.mockClear();
        act(() => result.current[1].zoomIn());
        flush();
        expect(onScaleChange).not.toHaveBeenCalled();
    });

    it('clamps at minScale', () => {
        const { result } = setup();
        for (let i = 0; i < 30; i++) act(() => result.current[1].zoomOut());
        flush();
        expect(result.current[0].scale).toBe(0.8);
    });

    it('resetZoom returns to 1 and recentres', () => {
        const onScaleChange = vi.fn();
        const onPanChange = vi.fn();
        const { result } = setup({ onScaleChange, onPanChange });

        act(() => result.current[1].zoomIn());
        flush();
        act(() => result.current[1].resetZoom());
        flush();

        expect(result.current[0].scale).toBe(1);
        expect(result.current[0].transform).toEqual({ scale: 1, translateX: 0, translateY: 0 });
        expect(onPanChange).toHaveBeenCalledWith(0, 0);
    });
});

describe('panning', () => {
    it('constrains pan to 75% of the content size', () => {
        const { result } = setup({ constrainPan: true });
        act(() => result.current[1].setPan(500, -500));
        expect(result.current[0].transform.translateX).toBe(75);
        expect(result.current[0].transform.translateY).toBe(-75);
    });

    it('passes small offsets through unclamped', () => {
        const { result } = setup({ constrainPan: true });
        act(() => result.current[1].setPan(10, -10));
        expect(result.current[0].transform.translateX).toBe(10);
        expect(result.current[0].transform.translateY).toBe(-10);
    });

    it('does not clamp when constrainPan is false', () => {
        const { result } = setup({ constrainPan: false });
        act(() => result.current[1].setPan(500, -500));
        expect(result.current[0].transform.translateX).toBe(500);
        expect(result.current[0].transform.translateY).toBe(-500);
    });

    it('reports a pan change only when the value moves', () => {
        const onPanChange = vi.fn();
        const { result } = setup({ onPanChange });

        act(() => result.current[1].setPan(10, 10));
        flush();
        onPanChange.mockClear();

        act(() => result.current[1].setPan(10, 10));
        flush();
        expect(onPanChange).not.toHaveBeenCalled();
    });
});

describe('wheel zoom', () => {
    const wheel = (init: WheelEventInit) =>
        new WheelEvent('wheel', { cancelable: true, bubbles: true, clientX: 100, clientY: 100, ...init });

    it('zooms when ctrl is held and prevents the default', () => {
        const { result } = setup();
        const evt = wheel({ deltaY: -100, ctrlKey: true });

        act(() => {
            container.dispatchEvent(evt);
        });

        expect(result.current[0].scale).toBe(2);
        expect(evt.defaultPrevented).toBe(true);
    });

    it('treats meta like ctrl', () => {
        const { result } = setup();
        act(() => {
            container.dispatchEvent(wheel({ deltaY: -100, metaKey: true }));
        });
        expect(result.current[0].scale).toBe(2);
    });

    it('ignores a plain wheel, leaving it for the brush-size handler', () => {
        const { result } = setup();
        const evt = wheel({ deltaY: -100 });

        act(() => {
            container.dispatchEvent(evt);
        });

        expect(result.current[0].scale).toBe(1);
        expect(evt.defaultPrevented).toBe(false);
    });

    it('does nothing when wheel zoom is disabled', () => {
        const { result } = setup({ enableWheelZoom: false });
        act(() => {
            container.dispatchEvent(wheel({ deltaY: -100, ctrlKey: true }));
        });
        expect(result.current[0].scale).toBe(1);
    });

    it('zooms out on a positive delta', () => {
        const { result } = setup();
        act(() => {
            container.dispatchEvent(wheel({ deltaY: 100, ctrlKey: true }));
        });
        expect(result.current[0].scale).toBe(0.8);
    });
});

describe('getImageCoordinates', () => {
    it('maps the container centre to the content centre', () => {
        const { result } = setup();
        expect(result.current[1].getImageCoordinates(100, 100)).toEqual({ x: 50, y: 50 });
    });

    it('returns the origin without a container', () => {
        const ref = { current: null } as React.RefObject<HTMLDivElement | null>;
        const { result } = renderHook(() => useZoomPan(ref, CONTENT));
        expect(result.current[1].getImageCoordinates(0, 0)).toEqual({ x: 0, y: 0 });
    });
});

describe('keyboard state', () => {
    it('ignores Space until the view is zoomed in', () => {
        const { result } = setup();
        act(() => {
            window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
        });
        expect(result.current[0].isSpaceKeyDown).toBe(false);
    });

    it('tracks Space once zoomed in', () => {
        const { result } = setup();
        zoomInto(result);

        act(() => {
            window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
        });
        expect(result.current[0].isSpaceKeyDown).toBe(true);

        act(() => {
            window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' }));
        });
        expect(result.current[0].isSpaceKeyDown).toBe(false);
    });

    it('tracks the zoom modifier', () => {
        const { result } = setup();
        act(() => {
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true }));
        });
        expect(result.current[0].isZoomKeyDown).toBe(true);

        act(() => {
            window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control' }));
        });
        expect(result.current[0].isZoomKeyDown).toBe(false);
    });

    it('ignores keys typed into form fields', () => {
        const { result } = setup();
        zoomInto(result);
        const input = document.createElement('input');
        document.body.append(input);
        input.focus();

        act(() => {
            input.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
        });

        expect(result.current[0].isSpaceKeyDown).toBe(false);
        input.remove();
    });
});

describe('body cursor handover', () => {
    it('restores the page cursor when focus is lost mid-pan', () => {
        document.body.style.cursor = 'crosshair';
        const { result } = setup();
        zoomInto(result);

        act(() => {
            window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
        });
        act(() => {
            container.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
        });
        expect(result.current[0].isPanning).toBe(true);
        expect(document.body.style.cursor).toBe('grabbing');

        act(() => {
            window.dispatchEvent(new Event('blur'));
        });

        expect(result.current[0].isPanning).toBe(false);
        // Regression guard: this used to leave the page stuck on `grabbing`.
        expect(document.body.style.cursor).toBe('crosshair');
        document.body.style.cursor = '';
    });

    it('pans with the middle mouse button and restores on mouseup', () => {
        const { result } = setup();
        zoomInto(result);

        act(() => {
            container.dispatchEvent(new MouseEvent('mousedown', { button: 1, bubbles: true }));
        });
        expect(result.current[0].isPanning).toBe(true);

        act(() => {
            window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        });
        expect(result.current[0].isPanning).toBe(false);
        expect(document.body.style.cursor).toBe('');
    });

    it('does not start panning while the view is not zoomed', () => {
        const { result } = setup();
        act(() => {
            container.dispatchEvent(new MouseEvent('mousedown', { button: 1, bubbles: true }));
        });
        expect(result.current[0].isPanning).toBe(false);
    });
});

describe('write ordering', () => {
    // Regression guard: zoomIn used to defer its setTransform into a setTimeout(0), so a
    // reset issued before that timer fired was overwritten by the stale zoom.
    it('lets a resetZoom override a preceding zoomIn', () => {
        const { result } = setup();

        act(() => result.current[1].zoomIn());
        act(() => result.current[1].resetZoom());
        flush();

        expect(result.current[0].scale).toBe(1);
        expect(result.current[0].transform.scale).toBe(1);
    });

    it('reports effectiveScale from the current commit, not the previous one', () => {
        const { result } = setup();

        act(() => result.current[1].zoomIn());

        // No flush: the refs used to lag a commit behind, so the CSS transform rendered one
        // step stale after every zoom.
        expect(result.current[0].effectiveScale).toBeCloseTo(result.current[0].baseScale * 1.2);
    });
});

describe('multi-instance body cursor', () => {
    it('restores the page cursor only once the last editor releases it', () => {
        document.body.style.cursor = 'crosshair';

        const first = setup();
        const second = setup();
        zoomInto(first.result);
        zoomInto(second.result);

        act(() => {
            window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
        });
        act(() => {
            container.dispatchEvent(new MouseEvent('mousedown', { button: 1, bubbles: true }));
        });

        expect(first.result.current[0].isPanning).toBe(true);
        expect(second.result.current[0].isPanning).toBe(true);
        expect(document.body.style.cursor).toBe('grabbing');

        // Regression guard: the saved cursor used to live in a module global, so the second
        // instance recorded `grabbing` as the original and restored that on release.
        first.unmount();
        expect(document.body.style.cursor).toBe('grabbing');

        second.unmount();
        expect(document.body.style.cursor).toBe('crosshair');

        document.body.style.cursor = '';
    });
});

describe('pan listener stability', () => {
    it('accumulates a drag without re-registering its listeners on every move', () => {
        const { result } = setup({ constrainPan: false });
        zoomInto(result);

        act(() => {
            container.dispatchEvent(new MouseEvent('mousedown', { button: 1, bubbles: true, clientX: 0, clientY: 0 }));
        });

        const addSpy = vi.spyOn(window, 'addEventListener');

        for (let i = 1; i <= 5; i++) {
            act(() => {
                window.dispatchEvent(new MouseEvent('mousemove', { clientX: i * 10, clientY: 0 }));
            });
        }

        // transform.scale is 1.4 after zoomInto, so each 10px step moves 10 / 1.4 image px.
        expect(result.current[0].transform.translateX).toBeCloseTo(50 / 1.4);
        expect(addSpy.mock.calls.filter(([type]) => type === 'mousemove')).toHaveLength(0);

        act(() => {
            window.dispatchEvent(new MouseEvent('mouseup'));
        });
    });
});

describe('container resize', () => {
    it('re-fits against the current content size, not the one it mounted with', () => {
        const original = globalThis.ResizeObserver;
        let fire: (() => void) | undefined;

        globalThis.ResizeObserver = class implements ResizeObserver {
            constructor(callback: ResizeObserverCallback) {
                fire = () => callback([], this);
            }
            observe(): void {}
            unobserve(): void {}
            disconnect(): void {}
        };

        try {
            const ref = { current: container } as React.RefObject<HTMLDivElement | null>;
            const { result, rerender } = renderHook(({ content }) => useZoomPan(ref, content), {
                initialProps: { content: { x: 100, y: 100 } },
            });
            expect(result.current[0].baseScale).toBe(1);

            rerender({ content: { x: 400, y: 400 } });
            expect(result.current[0].baseScale).toBe(0.5);

            // Shrink the container, then let the observer fire. The callback used to close
            // over the mount-time content size, so it re-fitted to 100x100 and reported 1.
            Object.defineProperty(container, 'clientWidth', { value: 100, configurable: true });
            Object.defineProperty(container, 'clientHeight', { value: 100, configurable: true });
            act(() => fire?.());

            expect(result.current[0].baseScale).toBe(0.25);
        } finally {
            globalThis.ResizeObserver = original;
        }
    });
});

describe('keyboardScope', () => {
    /** A focusable stand-in for the container the editor renders. */
    function focusableContainer() {
        container.tabIndex = 0;
        return container;
    }

    it('responds to Space from anywhere on the page by default', () => {
        const { result } = setup();
        zoomInto(result);

        act(() => {
            window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
        });
        expect(result.current[0].isSpaceKeyDown).toBe(true);
    });

    it("ignores Space while focus is outside the editor in 'container' mode", () => {
        const { result } = setup({ keyboardScope: 'container' });
        zoomInto(result);

        const outside = document.createElement('button');
        document.body.append(outside);
        outside.focus();

        act(() => {
            window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
        });

        expect(result.current[0].isSpaceKeyDown).toBe(false);
        outside.remove();
    });

    it("responds to Space once the container holds focus in 'container' mode", () => {
        const { result } = setup({ keyboardScope: 'container' });
        zoomInto(result);

        // `Node.contains` is true for the node itself, so focusing the container counts.
        focusableContainer().focus();

        act(() => {
            window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
        });
        expect(result.current[0].isSpaceKeyDown).toBe(true);
    });

    it('still releases Space after focus has left, so panning cannot stick', () => {
        const { result } = setup({ keyboardScope: 'container' });
        zoomInto(result);
        focusableContainer().focus();

        act(() => {
            window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
        });
        expect(result.current[0].isSpaceKeyDown).toBe(true);

        // keyup stays unscoped on purpose: a release seen after focus moved must still land.
        const outside = document.createElement('button');
        document.body.append(outside);
        outside.focus();

        act(() => {
            window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space' }));
        });

        expect(result.current[0].isSpaceKeyDown).toBe(false);
        outside.remove();
    });
});
