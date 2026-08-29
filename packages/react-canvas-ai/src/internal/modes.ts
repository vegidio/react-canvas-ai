/**
 * The editor's interaction mode. `'paint'` is the freehand brush; `'auto'` turns clicks into
 * SAM segmentations — click to add the object under the cursor to the mask, shift-click or
 * right-click to subtract it. Meaningless without `autoSelect` configured: the editor forces
 * `'paint'` then.
 */
export type MaskEditorMode = 'paint' | 'auto';

/** What a mode does to the pointer, as data rather than as a branch per call site. */
export type ModeTool = {
    /** Container cursor while this mode is idle. */
    cursor: string;
    /** Container cursor while the mode is busy; falls back to {@link ModeTool.cursor}. */
    busyCursor?: string;
    /** Whether the freehand brush — outline, dabs, wheel resize — is live in this mode. */
    usesBrush: boolean;
    /** Whether entering this mode should warm the auto-selection backend. */
    usesAutoSelect: boolean;
};

/**
 * The presentation half of each mode's behaviour. Auto-selection used to be threaded through
 * the editor as a `mode === 'auto'` check at every site that cared; as a table, adding a mode
 * is one entry here plus one in the pointer-handler table in `useMaskEditor`, and the
 * exhaustive `Record` makes forgetting either a compile error.
 */
export const MODE_TOOLS: Record<MaskEditorMode, ModeTool> = {
    paint: { cursor: 'default', usesBrush: true, usesAutoSelect: false },
    auto: { cursor: 'crosshair', busyCursor: 'progress', usesBrush: false, usesAutoSelect: true },
};
