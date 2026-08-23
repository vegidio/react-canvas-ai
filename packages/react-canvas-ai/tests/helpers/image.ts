import { act } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

/**
 * jsdom never loads images: assigning `img.src` does not fire `onload`, and useMaskEditor
 * is entirely gated on that event. This patches the `src` setter so assigning it reports
 * the given dimensions and resolves (or rejects) on a microtask.
 *
 * Returns a restore function.
 */
export type MockImage = {
    width: number;
    height: number;
    fail?: boolean;
    /** Milliseconds to wait before firing, for staging a load race. Default: a microtask. */
    delay?: number;
};

/** Either one response for every source, or a function picking one per source. */
export type MockImageResolver = MockImage | ((src: string) => MockImage);

/** A 1x1 PNG. Any test that only needs *a* source uses this one. */
export const SRC = 'data:image/png;base64,iVBORw0KGgo=';

export const mockImageLoad = (opts: MockImageResolver): (() => void) => {
    const original = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    const resolve = (src: string): MockImage => (typeof opts === 'function' ? opts(src) : opts);

    Object.defineProperty(HTMLImageElement.prototype, 'src', {
        configurable: true,
        get(this: HTMLImageElement & { _src?: string }) {
            return this._src ?? '';
        },
        set(this: HTMLImageElement & { _src?: string }, value: string) {
            this._src = value;
            const config = resolve(value);
            for (const [key, val] of [
                ['naturalWidth', config.width],
                ['naturalHeight', config.height],
                ['width', config.width],
                ['height', config.height],
            ] as const) {
                Object.defineProperty(this, key, { value: val, configurable: true });
            }
            const fire = () => {
                if (config.fail) this.onerror?.(new Event('error'));
                else this.onload?.(new Event('load'));
            };
            if (config.delay) setTimeout(fire, config.delay);
            else queueMicrotask(fire);
        },
    });

    return () => {
        if (original) Object.defineProperty(HTMLImageElement.prototype, 'src', original);
    };
};

/**
 * Installs the image mock for a whole suite, restoring it afterwards, and returns a
 * `remock` for the tests that need different dimensions or a failure part-way through.
 *
 * Every editor suite needs this same beforeEach/afterEach pair; keeping it here stops each
 * one hand-rolling its own `let restoreImage` bookkeeping.
 */
export const installImageMock = (defaults: MockImageResolver): ((opts: MockImageResolver) => void) => {
    let restore: () => void = () => {};

    beforeEach(() => {
        restore = mockImageLoad(defaults);
    });

    afterEach(() => {
        restore();
    });

    return (opts: MockImageResolver) => {
        restore();
        restore = mockImageLoad(opts);
    };
};

/**
 * Lets the image `onload` microtask and the hook's deferred timers settle.
 *
 * Several turns: the remote-source path chains fetch -> blob -> FileReader before it ever
 * assigns img.src, so a single microtask flush is not enough. Requires fake timers.
 */
export const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) {
        await act(async () => {
            await Promise.resolve();
            vi.advanceTimersByTime(200);
        });
    }
};
