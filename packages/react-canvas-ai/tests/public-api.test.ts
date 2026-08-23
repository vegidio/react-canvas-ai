import { describe, expect, it } from 'vitest';
import * as api from '../src/index';

describe('public API', () => {
    // Guards against an accidental export drop during a refactor of the barrel file.
    it('exports exactly the documented surface', () => {
        expect(Object.keys(api).sort()).toEqual([
            'MaskEditor',
            'MaskEditorDefaults',
            'MaskEditorProvider',
            'toMask',
            'useMaskEditor',
            'useMaskEditorContext',
        ]);
    });

    it('pins the default options', () => {
        expect(api.MaskEditorDefaults).toEqual({
            cursorSize: 10,
            maskOpacity: 0.4,
            maskColor: '#ffffff',
            maskBlendMode: 'normal',
            scale: 1,
            minScale: 0.8,
            maxScale: 4,
            enableWheelZoom: true,
            constrainPan: true,
            keyboardScope: 'window',
        });
    });
});
