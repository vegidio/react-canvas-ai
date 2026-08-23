import type { MaskBlendMode } from '../hooks/useMaskEditor';
import type { KeyboardScope } from './keyboard';

/**
 * Every default the editor applies, in one place.
 *
 * `useZoomPan` reads the zoom/pan entries from here rather than restating them as
 * destructuring defaults: two copies could drift, and the only symptom would be a silently
 * different default when the hook is used standalone.
 */
export const MaskEditorDefaults = {
    cursorSize: 10,
    maskOpacity: 0.4,
    maskColor: '#ffffff',
    maskBlendMode: 'normal' as MaskBlendMode,
    maxWidth: 1240,
    maxHeight: 1240,
    scale: 1,
    minScale: 0.8,
    maxScale: 4,
    enableWheelZoom: true,
    constrainPan: true,
    keyboardScope: 'window' as KeyboardScope,
};
