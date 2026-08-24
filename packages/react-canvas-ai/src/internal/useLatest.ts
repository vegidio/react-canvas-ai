import type { RefObject } from 'react';
import { useCallback, useEffectEvent, useLayoutEffect, useRef } from 'react';

/**
 * Keeps a ref pointed at the latest value without making that value a render input.
 *
 * The assignment happens in a layout effect rather than during render, so a value read
 * back during render is always the previous commit's — every consumer here reads from DOM
 * event handlers or effects, both of which run after layout effects.
 */
export const useLatest = <T>(value: T): RefObject<T> => {
    const ref = useRef(value);
    useLayoutEffect(() => {
        ref.current = value;
    });
    return ref;
};

/**
 * Wraps a possibly-undefined consumer callback in a stable identity, so passing an inline
 * arrow does not invalidate every dependency array that touches it.
 *
 * The `useCallback` wrapper around `useEffectEvent` is not redundant: an effect event's
 * identity is fresh on every render, and this result is handed out through memoized action
 * objects where a changing identity would re-render every consumer of the context.
 */
export const useEventCallback = <A extends unknown[]>(fn?: (...args: A) => void): ((...args: A) => void) => {
    const onEvent = useEffectEvent((...args: A) => fn?.(...args));
    return useCallback((...args: A) => onEvent(...args), []);
};
