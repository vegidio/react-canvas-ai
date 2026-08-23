import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useHistory } from '../src/hooks/useHistory';

const SIZE = { x: 10, y: 10 };

/** A minimal 2d context stub whose snapshots are distinguishable by id. */
function makeContext() {
    let next = 0;
    return {
        getImageData: vi.fn(() => ({ id: next++ }) as unknown as ImageData),
        putImageData: vi.fn(),
        clearRect: vi.fn(),
    } as unknown as CanvasRenderingContext2D & {
        getImageData: ReturnType<typeof vi.fn>;
        putImageData: ReturnType<typeof vi.fn>;
        clearRect: ReturnType<typeof vi.fn>;
    };
}

let ctx: ReturnType<typeof makeContext>;
beforeEach(() => {
    ctx = makeContext();
});

describe('useHistory', () => {
    it('starts empty', () => {
        const { result } = renderHook(() => useHistory(ctx, SIZE));
        expect(result.current.history).toEqual([]);
        expect(result.current.historyIndex).toBe(-1);
    });

    it('records a snapshot of the full canvas', () => {
        const { result } = renderHook(() => useHistory(ctx, SIZE));
        act(() => result.current.saveToHistory());

        expect(ctx.getImageData).toHaveBeenCalledWith(0, 0, 10, 10);
        expect(result.current.history).toHaveLength(1);
        expect(result.current.historyIndex).toBe(0);
    });

    it('records nothing without a context', () => {
        const { result } = renderHook(() => useHistory(null, SIZE));
        act(() => result.current.saveToHistory());
        expect(result.current.history).toEqual([]);
    });

    it('records nothing for a zero-size canvas', () => {
        const { result } = renderHook(() => useHistory(ctx, { x: 0, y: 0 }));
        act(() => result.current.saveToHistory());
        expect(ctx.getImageData).not.toHaveBeenCalled();
        expect(result.current.history).toEqual([]);
    });

    it('undo restores the previous snapshot and notifies', () => {
        const onUndoRequest = vi.fn();
        const { result } = renderHook(() => useHistory(ctx, SIZE, { onUndoRequest }));

        act(() => result.current.saveToHistory());
        act(() => result.current.saveToHistory());
        act(() => result.current.undo());

        expect(result.current.historyIndex).toBe(0);
        expect(ctx.putImageData).toHaveBeenCalledWith(result.current.history[0]?.imageData, 0, 0);
        expect(onUndoRequest).toHaveBeenCalledTimes(1);
    });

    it('undo past the first entry clears instead of restoring', () => {
        const { result } = renderHook(() => useHistory(ctx, SIZE));

        act(() => result.current.saveToHistory());
        act(() => result.current.undo());

        expect(result.current.historyIndex).toBe(-1);
        expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 10, 10);
        expect(ctx.putImageData).not.toHaveBeenCalled();
    });

    it('redo with nothing ahead does not notify', () => {
        const onRedoRequest = vi.fn();
        const { result } = renderHook(() => useHistory(ctx, SIZE, { onRedoRequest }));

        act(() => result.current.saveToHistory());
        act(() => result.current.redo());

        expect(onRedoRequest).not.toHaveBeenCalled();
        expect(ctx.putImageData).not.toHaveBeenCalled();
    });

    it('undo then redo returns to the later state', () => {
        const onRedoRequest = vi.fn();
        const { result } = renderHook(() => useHistory(ctx, SIZE, { onRedoRequest }));

        act(() => result.current.saveToHistory());
        act(() => result.current.saveToHistory());
        act(() => result.current.undo());
        act(() => result.current.redo());

        expect(result.current.historyIndex).toBe(1);
        expect(onRedoRequest).toHaveBeenCalledTimes(1);
    });

    it('discards the redo branch when saving after an undo', () => {
        const { result } = renderHook(() => useHistory(ctx, SIZE));

        act(() => result.current.saveToHistory());
        act(() => result.current.saveToHistory());
        act(() => result.current.saveToHistory());
        act(() => result.current.undo());
        act(() => result.current.saveToHistory());

        expect(result.current.history).toHaveLength(3);
        expect(result.current.historyIndex).toBe(2);
    });

    it('caps the stack at maxHistorySize', () => {
        const { result } = renderHook(() => useHistory(ctx, SIZE, { maxHistorySize: 3 }));

        for (let i = 0; i < 5; i++) act(() => result.current.saveToHistory());

        expect(result.current.history).toHaveLength(3);
        expect(result.current.historyIndex).toBe(2);
    });

    it('defaults the cap to 50 entries', () => {
        const { result } = renderHook(() => useHistory(ctx, SIZE));

        for (let i = 0; i < 60; i++) act(() => result.current.saveToHistory());

        expect(result.current.history).toHaveLength(50);
        expect(result.current.historyIndex).toBe(49);
    });

    it('ignores out-of-range restore indices', () => {
        const { result } = renderHook(() => useHistory(ctx, SIZE));
        act(() => result.current.saveToHistory());
        ctx.putImageData.mockClear();

        act(() => result.current.restoreFromHistory(-2));
        act(() => result.current.restoreFromHistory(result.current.history.length));

        expect(ctx.putImageData).not.toHaveBeenCalled();
    });

    it('clear() empties the stack and wipes the canvas', () => {
        const { result } = renderHook(() => useHistory(ctx, SIZE));
        act(() => result.current.saveToHistory());
        act(() => result.current.clear());

        expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 10, 10);
        expect(result.current.history).toEqual([]);
        expect(result.current.historyIndex).toBe(-1);
    });

    it('survives a failing getImageData', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        ctx.getImageData.mockImplementation(() => {
            throw new Error('tainted canvas');
        });

        const { result } = renderHook(() => useHistory(ctx, SIZE));
        expect(() => act(() => result.current.saveToHistory())).not.toThrow();

        expect(warn).toHaveBeenCalledWith('Failed to save history state:', expect.any(Error));
        expect(result.current.history).toEqual([]);
    });
});

describe('same-tick saves', () => {
    it('coalesces two saves issued before a re-render', () => {
        const { result } = renderHook(() => useHistory(ctx, SIZE));

        // Regression guard: the index was advanced by a separate updater that read the
        // pre-render value, so the second save overwrote the first and left index at 1
        // pointing into a one-entry array.
        act(() => {
            result.current.saveToHistory();
            result.current.saveToHistory();
        });

        expect(result.current.history).toHaveLength(2);
        expect(result.current.historyIndex).toBe(1);
    });

    it('keeps undo consistent after a same-tick double save', () => {
        const { result } = renderHook(() => useHistory(ctx, SIZE));

        act(() => {
            result.current.saveToHistory();
            result.current.saveToHistory();
        });
        act(() => result.current.undo());

        expect(result.current.historyIndex).toBe(0);
        expect(ctx.putImageData).toHaveBeenCalledWith(result.current.history[0]?.imageData, 0, 0);
    });
});
