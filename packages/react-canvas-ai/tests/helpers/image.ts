/**
 * jsdom never loads images: assigning `img.src` does not fire `onload`, and useMaskEditor
 * is entirely gated on that event. This patches the `src` setter so assigning it reports
 * the given dimensions and resolves (or rejects) on a microtask.
 *
 * Returns a restore function.
 */
export function mockImageLoad(opts: { width: number; height: number; fail?: boolean }): () => void {
    const original = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');

    Object.defineProperty(HTMLImageElement.prototype, 'src', {
        configurable: true,
        get(this: HTMLImageElement & { _src?: string }) {
            return this._src ?? '';
        },
        set(this: HTMLImageElement & { _src?: string }, value: string) {
            this._src = value;
            for (const [key, val] of [
                ['naturalWidth', opts.width],
                ['naturalHeight', opts.height],
                ['width', opts.width],
                ['height', opts.height],
            ] as const) {
                Object.defineProperty(this, key, { value: val, configurable: true });
            }
            queueMicrotask(() => {
                if (opts.fail) this.onerror?.(new Event('error'));
                else this.onload?.(new Event('load'));
            });
        },
    });

    return () => {
        if (original) Object.defineProperty(HTMLImageElement.prototype, 'src', original);
    };
}
