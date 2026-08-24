import type { RefCallback, RefObject } from 'react';
import { useRef, useState } from 'react';

/**
 * A ref that is both callable and readable.
 *
 * React invokes it on attach and detach, which is the only way a hook can learn that its
 * element arrived; `.current` still reads that element for anyone holding the ref directly,
 * so `<canvas ref={maskCanvasRef} />` and `maskCanvasRef.current` both keep working.
 */
export type ElementHandle<T extends Element> = RefCallback<T> & RefObject<T | null>;

/**
 * Tracks the attached element as state, so consumers can depend on it.
 *
 * A plain `useRef` cannot do this: mutating `.current` notifies nobody, so an effect keyed on
 * the ref object attaches once against whatever happened to be mounted and never notices an
 * element that arrives late or gets replaced.
 */
export const useElementRef = <T extends Element>(): [ElementHandle<T>, T | undefined] => {
    const [element, setElement] = useState<T | undefined>(undefined);
    // Lazily built once and held in a ref rather than a memo: a new identity here would make
    // React detach and reattach the element on every render.
    const handleRef = useRef<ElementHandle<T> | undefined>(undefined);

    if (!handleRef.current) {
        const handle = ((node: T | null) => {
            handle.current = node;
            setElement(node ?? undefined);
        }) as ElementHandle<T>;

        handle.current = null;
        handleRef.current = handle;
    }

    return [handleRef.current, element];
};
