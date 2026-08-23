/**
 * jsdom never loads images: assigning `img.src` does not fire `onload`, and useMaskEditor
 * is entirely gated on that event. This patches the `src` setter so assigning it reports
 * the given dimensions and resolves (or rejects) on a microtask.
 *
 * Returns a restore function.
 */
export interface MockImage {
    width: number;
    height: number;
    fail?: boolean;
    /** Milliseconds to wait before firing, for staging a load race. Default: a microtask. */
    delay?: number;
}

/** Either one response for every source, or a function picking one per source. */
export type MockImageResolver = MockImage | ((src: string) => MockImage);

export function mockImageLoad(opts: MockImageResolver): () => void {
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
}
