import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MaskEditorContextValue } from '../src/components/MaskEditorProvider';
import { MaskEditorProvider, useMaskEditorContext } from '../src/components/MaskEditorProvider';
import { mockImageLoad } from './helpers/image';

const SRC = 'data:image/png;base64,iVBORw0KGgo=';

let restoreImage: () => void;

beforeEach(() => {
    restoreImage = mockImageLoad({ width: 200, height: 200 });
});

afterEach(() => {
    restoreImage();
});

describe('MaskEditorProvider', () => {
    it('renders its children', () => {
        const { getByText } = render(
            <MaskEditorProvider src={SRC} onDrawingChange={vi.fn()}>
                <span>{'child'}</span>
            </MaskEditorProvider>,
        );
        expect(getByText('child')).toBeInTheDocument();
    });

    it('exposes the full editor surface through context', () => {
        let ctx: MaskEditorContextValue | undefined;
        const Probe = () => {
            ctx = useMaskEditorContext();
            return null;
        };

        render(
            <MaskEditorProvider src={SRC} onDrawingChange={vi.fn()}>
                <Probe />
            </MaskEditorProvider>,
        );

        expect(Object.keys(ctx ?? {}).sort()).toEqual(
            [
                'canvasRef',
                'clear',
                'containerRef',
                'cursorCanvasRef',
                'cursorSize',
                'effectiveScale',
                'handleMouseDown',
                'handleMouseUp',
                'history',
                'historyIndex',
                'isDrawing',
                'isPanning',
                'isZoomKeyDown',
                'key',
                'maskBlendMode',
                'maskCanvasRef',
                'maskColor',
                'maskOpacity',
                'redo',
                'resetZoom',
                'scale',
                'setCursorSize',
                'setPan',
                'setScale',
                'size',
                'transform',
                'undo',
                'zoomIn',
                'zoomOut',
            ].sort(),
        );
    });

    it('forwards its props to the underlying hook', () => {
        let ctx: MaskEditorContextValue | undefined;
        const Probe = () => {
            ctx = useMaskEditorContext();
            return null;
        };

        render(
            <MaskEditorProvider src={SRC} cursorSize={42} onDrawingChange={vi.fn()}>
                <Probe />
            </MaskEditorProvider>,
        );

        expect(ctx?.cursorSize).toBe(42);
    });

    it('gives every consumer the same instance', () => {
        let first: MaskEditorContextValue | undefined;
        let second: MaskEditorContextValue | undefined;
        const First = () => {
            first = useMaskEditorContext();
            return null;
        };
        const Second = () => {
            second = useMaskEditorContext();
            return null;
        };

        render(
            <MaskEditorProvider src={SRC} onDrawingChange={vi.fn()}>
                <First />
                <Second />
            </MaskEditorProvider>,
        );

        expect(first).toBeDefined();
        expect(first).toBe(second);
    });

    it('throws when used outside a provider', () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const Bare = () => {
            useMaskEditorContext();
            return null;
        };

        expect(() => render(<Bare />)).toThrow('useMaskEditorContext must be used within a MaskEditorProvider');
        error.mockRestore();
    });
});
