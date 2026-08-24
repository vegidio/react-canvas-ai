/**
 * Every default the editor applies, in one place.
 *
 * `useZoomPan` reads the zoom/pan entries from here rather than restating them as
 * destructuring defaults: two copies could drift, and the only symptom would be a silently
 * different default when the hook is used standalone.
 *
 * `as const` because this object is re-exported publicly: without it a consumer could write
 * `MaskEditorDefaults.cursorSize = 99` and change the defaults for every editor in the
 * process. The literal types it produces are what the `as MaskBlendMode` / `as KeyboardScope`
 * casts used to supply by hand; a typo in either now fails where the value is used as a
 * destructuring default for its typed prop.
 */
export const MaskEditorDefaults = {
    cursorSize: 10,
    maskOpacity: 0.4,
    maskColor: '#ffffff',
    maskBlendMode: 'normal',
    maxWidth: 1240,
    maxHeight: 1240,
    scale: 1,
    minScale: 0.8,
    maxScale: 4,
    enableWheelZoom: true,
    constrainPan: true,
    keyboardScope: 'window',
} as const;
