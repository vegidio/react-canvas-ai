/**
 * While panning we take over the page cursor and disable text selection, restoring exactly
 * what the host page had rather than clobbering it with a hardcoded default.
 *
 * Ownership is refcounted across editor instances. A per-instance snapshot would let a
 * second editor record `grabbing` as "the original" and restore that when it releases, so
 * the original values are captured only on the 0 -> 1 transition and restored only on 1 -> 0.
 */
let holders = 0;
let savedCursor = '';
let savedUserSelect = '';

/**
 * Takes the page cursor for a pan. Returns an idempotent release function — calling it more
 * than once, or after a blur has already released, is a no-op.
 */
export function acquireBodyPanCursor(): () => void {
    if (holders === 0) {
        savedCursor = document.body.style.cursor;
        savedUserSelect = document.body.style.userSelect;
        document.body.style.cursor = 'grabbing';
        document.body.style.userSelect = 'none';
    }
    holders += 1;

    let released = false;
    return () => {
        if (released) return;
        released = true;
        holders -= 1;
        if (holders === 0) {
            document.body.style.cursor = savedCursor;
            document.body.style.userSelect = savedUserSelect;
        }
    };
}
