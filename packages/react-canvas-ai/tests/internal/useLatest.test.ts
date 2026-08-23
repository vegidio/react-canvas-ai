import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useEventCallback, useLatest } from '../../src/internal/useLatest';

describe('useLatest', () => {
    it('tracks the newest value across rerenders', () => {
        const { result, rerender } = renderHook(({ value }) => useLatest(value), {
            initialProps: { value: 1 },
        });

        expect(result.current.current).toBe(1);
        rerender({ value: 2 });
        expect(result.current.current).toBe(2);
    });

    it('keeps a stable ref identity', () => {
        const { result, rerender } = renderHook(({ value }) => useLatest(value), {
            initialProps: { value: 1 },
        });

        const first = result.current;
        rerender({ value: 2 });
        expect(result.current).toBe(first);
    });
});

describe('useEventCallback', () => {
    it('stays identity-stable while calling through to the newest function', () => {
        const first = vi.fn();
        const second = vi.fn();

        const { result, rerender } = renderHook(({ fn }) => useEventCallback(fn), {
            initialProps: { fn: first as (...args: [number]) => void },
        });

        const stable = result.current;
        act(() => result.current(1));
        expect(first).toHaveBeenCalledWith(1);

        rerender({ fn: second as (...args: [number]) => void });
        expect(result.current).toBe(stable);

        act(() => result.current(2));
        expect(second).toHaveBeenCalledWith(2);
        expect(first).toHaveBeenCalledTimes(1);
    });

    it('is a no-op when no callback is supplied', () => {
        const { result } = renderHook(() => useEventCallback<[number]>(undefined));
        expect(() => result.current(1)).not.toThrow();
    });
});
