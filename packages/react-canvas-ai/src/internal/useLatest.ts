import type { RefObject } from 'react';
import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * Keeps a ref pointed at the latest value without making that value a render input.
 *
 * The assignment happens in a layout effect rather than during render, so a value read
 * back during render is always the previous commit's — every consumer here reads from DOM
 * event handlers or effects, both of which run after layout effects.
 *
 * This is the React 18-compatible stand-in for `useEffectEvent`, which the peer range
 * (`react >=18 <20`) cannot rely on.
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
 */
export const useEventCallback = <A extends unknown[]>(fn?: (...args: A) => void): ((...args: A) => void) => {
    const ref = useLatest(fn);
    return useCallback((...args: A) => ref.current?.(...args), []);
};
