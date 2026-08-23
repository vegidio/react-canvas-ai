import { afterEach, describe, expect, it } from 'vitest';
import { acquireBodyPanCursor } from '../../src/internal/bodyPanCursor';

afterEach(() => {
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
});

describe('acquireBodyPanCursor', () => {
    it('takes the cursor and restores the page value on release', () => {
        document.body.style.cursor = 'crosshair';
        const release = acquireBodyPanCursor();

        expect(document.body.style.cursor).toBe('grabbing');
        expect(document.body.style.userSelect).toBe('none');

        release();
        expect(document.body.style.cursor).toBe('crosshair');
    });

    it('is idempotent, so a blur and a mouseup can both release', () => {
        document.body.style.cursor = 'crosshair';
        const release = acquireBodyPanCursor();

        release();
        document.body.style.cursor = 'text';
        release();

        // The second call must not restore a second time over an unrelated later value.
        expect(document.body.style.cursor).toBe('text');
    });

    it('restores the original only once the last holder releases', () => {
        document.body.style.cursor = 'crosshair';
        const releaseFirst = acquireBodyPanCursor();
        // Regression guard: a second instance must not snapshot `grabbing` as the original.
        const releaseSecond = acquireBodyPanCursor();

        releaseFirst();
        expect(document.body.style.cursor).toBe('grabbing');

        releaseSecond();
        expect(document.body.style.cursor).toBe('crosshair');
    });
});
