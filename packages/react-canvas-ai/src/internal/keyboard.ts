/** Where keyboard shortcuts are listened for. See `UseMaskEditorProps.keyboardScope`. */
export type KeyboardScope = 'window' | 'container';

/**
 * Whether a key press landed in a typing surface, where our shortcuts must stay out of
 * the way.
 */
export const isFormField = (target: EventTarget | null): boolean => {
    // `instanceof` rather than a cast: an `EventTarget` is just as likely to be `window` or
    // `document`, neither of which has a `tagName` to read.
    if (!(target instanceof HTMLElement)) return false;
    return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
};

/**
 * Whether a key press belongs to this editor.
 *
 * Listeners stay on `window` in both modes — `keyup` and `blur` have to fire even after
 * focus has left, or a Space release goes unseen and the editor stays stuck in pan mode.
 * Only `keydown` is filtered. `Node.contains` reports true for the node itself, so the
 * container being the focused element counts as in scope.
 */
export const isKeyboardInScope = (scope: KeyboardScope, container: HTMLElement | null): boolean =>
    scope === 'window' || Boolean(container?.contains(document.activeElement));
