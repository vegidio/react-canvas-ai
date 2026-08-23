import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useHistory } from '../src/hooks/useHistory';

const SIZE = { x: 10, y: 10 };

/** Bytes each stubbed snapshot reports, so a byte budget can be expressed in whole entries. */
const ENTRY_BYTES = 64;

/**
 * A minimal 2d context stub whose snapshots are distinguishable by id, and which reports a
 * fixed byte size so the history byte cap can be exercised.
 */
const makeContext = () => {
    let next = 0;
    return {
        getImageData: vi.fn(() => ({ id: next++, data: new Uint8ClampedArray(ENTRY_BYTES) }) as unknown as ImageData),
        putImageData: vi.fn(),
        clearRect: vi.fn(),
    } as unknown as CanvasRenderingContext2D & {
        getImageData: ReturnType<typeof vi.fn>;
        putImageData: ReturnType<typeof vi.fn>;
        clearRect: ReturnType<typeof vi.fn>;
    };
};

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
        const { result } = renderHook(() => useHistory(undefined, SIZE));
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

    it('drops the oldest entries once the byte budget is exceeded', () => {
        const { result } = renderHook(() => useHistory(ctx, SIZE, { maxHistoryBytes: ENTRY_BYTES * 3 }));

        for (let i = 0; i < 5; i++) act(() => result.current.saveToHistory());

        expect(result.current.history).toHaveLength(3);
        expect(result.current.historyIndex).toBe(2);
    });

    it('keeps the newest state even when it alone exceeds the budget', () => {
        // Otherwise a canvas larger than the budget would make every save a no-op, which
        // would break undo outright rather than just limiting how far back it goes.
        const { result } = renderHook(() => useHistory(ctx, SIZE, { maxHistoryBytes: 1 }));

        act(() => result.current.saveToHistory());
        act(() => result.current.saveToHistory());

        expect(result.current.history).toHaveLength(1);
        expect(result.current.historyIndex).toBe(0);
    });

    it('scales the retained count to the entry size rather than a fixed number', () => {
        const small = renderHook(() => useHistory(ctx, SIZE, { maxHistoryBytes: ENTRY_BYTES * 10 }));
        for (let i = 0; i < 20; i++) act(() => small.result.current.saveToHistory());

        expect(small.result.current.history).toHaveLength(10);
    });

    it('stops at the ends of the stack instead of running off them', () => {
        const { result } = renderHook(() => useHistory(ctx, SIZE));
        act(() => result.current.saveToHistory());

        // Back past the only entry lands on the empty canvas, at index -1.
        act(() => result.current.undo());
        expect(result.current.historyIndex).toBe(-1);

        ctx.putImageData.mockClear();

        // A second undo would be index -2, and a redo past the end index 1: both out of
        // range, so neither may restore anything.
        act(() => result.current.undo());
        act(() => result.current.redo());
        act(() => result.current.redo());

        expect(ctx.putImageData).toHaveBeenCalledTimes(1); // only the in-range redo
        expect(result.current.historyIndex).toBe(0);
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
