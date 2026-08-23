import { createRef } from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MaskEditorCanvasRef } from '../src/components/MaskEditor';
import { MaskEditor } from '../src/components/MaskEditor';
import { mockImageLoad } from './helpers/image';

const SRC = 'data:image/png;base64,iVBORw0KGgo=';

let restoreImage: () => void;

beforeEach(() => {
    restoreImage = mockImageLoad({ width: 400, height: 200 });
});

afterEach(() => {
    restoreImage();
});

function renderEditor(props: Partial<React.ComponentProps<typeof MaskEditor>> = {}) {
    const onDrawingChange = vi.fn();
    const utils = render(<MaskEditor src={SRC} onDrawingChange={onDrawingChange} {...props} />);
    const root = utils.container.querySelector('.react-mask-editor-outer') as HTMLElement;
    return { ...utils, root, onDrawingChange };
}

const canvases = (root: HTMLElement) => ({
    base: root.querySelector('.react-mask-editor-base-canvas') as HTMLCanvasElement,
    mask: root.querySelector('.react-mask-editor-mask-canvas') as HTMLCanvasElement,
    cursor: root.querySelector('.react-mask-editor-cursor-canvas') as HTMLCanvasElement,
});

describe('structure', () => {
    it('renders the layer skeleton with all three canvases', () => {
        const { root, container } = renderEditor();

        expect(root).toBeInTheDocument();
        expect(root.dataset.maskEditorId).toBeTruthy();
        expect(container.querySelectorAll('.react-mask-editor-inner')).toHaveLength(1);
        expect(container.querySelectorAll('.canvas-container')).toHaveLength(1);
        expect(container.querySelectorAll('.all-canvases')).toHaveLength(1);
        expect(container.querySelectorAll('canvas')).toHaveLength(3);
    });

    it('is focusable and swallows Space so the page does not scroll', async () => {
        const { root } = renderEditor();
        expect(root).toHaveAttribute('tabindex', '0');

        const evt = new KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true });
        root.dispatchEvent(evt);
        expect(evt.defaultPrevented).toBe(true);
    });
});

// These rules used to live in maskEditor.less. They are the ones that actually hold the
// layout together, so they are asserted explicitly rather than trusted to the migration.
describe('layout contract (post-stylesheet removal)', () => {
    it('stacks the base canvas absolutely at the origin', () => {
        const { root } = renderEditor();
        const { base } = canvases(root);

        expect(base.style.position).toBe('absolute');
        expect(base.style.top).toBe('0px');
        expect(base.style.left).toBe('0px');
    });

    it('orders the three layers by increasing z-index', () => {
        const { root } = renderEditor();
        const { base, mask, cursor } = canvases(root);

        const z = (el: HTMLElement) => Number(el.style.zIndex);
        expect(z(base)).toBeLessThan(z(mask));
        expect(z(mask)).toBeLessThan(z(cursor));
    });

    it('lets the inner element flex to fill the outer box', () => {
        const { container } = renderEditor();
        const inner = container.querySelector('.react-mask-editor-inner') as HTMLElement;
        expect(inner.style.flex).toBe('1 1 auto');
        expect(inner.style.overflow).toBe('hidden');
    });

    it('keeps the canvas container border-boxed and centred', () => {
        const { container } = renderEditor();
        const box = container.querySelector('.canvas-container') as HTMLElement;
        expect(box.style.boxSizing).toBe('border-box');
        expect(box.style.display).toBe('flex');
        expect(box.style.justifyContent).toBe('center');
        expect(box.style.alignItems).toBe('center');
    });

    it('keeps the compositor hints on the transformed layer', () => {
        const { container } = renderEditor();
        const layer = container.querySelector('.all-canvases') as HTMLElement;
        expect(layer.style.willChange).toBe('transform');
        expect(layer.style.touchAction).toBe('none');
        expect(layer.style.transform).toMatch(/translate\(-50%, -50%\) scale\([\d.]+\) translate\(.*px, .*px\)/);
    });

    it('stacks the outer element as a column and centres it', () => {
        const { root } = renderEditor();
        expect(root.style.flexDirection).toBe('column');
        expect(root.style.margin).toBe('0px auto');
        expect(root.style.position).toBe('relative');
        expect(root.style.overflow).toBe('hidden');
    });
});

describe('props', () => {
    it('reflects maxWidth and maxHeight, and omits them when unset', () => {
        const { root: bounded } = renderEditor({ maxWidth: 800, maxHeight: 600 });
        expect(bounded.style.maxWidth).toBe('800px');
        expect(bounded.style.maxHeight).toBe('600px');
    });

    it('applies mask opacity and blend mode to the mask layer', () => {
        const { root } = renderEditor({ maskOpacity: 0.7, maskBlendMode: 'multiply' });
        const { mask } = canvases(root);
        expect(mask.style.opacity).toBe('0.7');
        expect(mask.style.mixBlendMode).toBe('multiply');
    });

    it('appends className rather than replacing the built-in one', () => {
        const { root } = renderEditor({ className: 'my-editor' });
        expect(root).toHaveClass('react-mask-editor-outer');
        expect(root).toHaveClass('my-editor');
    });

    it('merges the style prop over the built-in layout styles', () => {
        const { root } = renderEditor({ style: { overflow: 'visible', border: '1px solid red' } });
        expect(root.style.overflow).toBe('visible');
        expect(root.style.border).toBe('1px solid red');
        // untouched built-ins survive the merge
        expect(root.style.flexDirection).toBe('column');
    });

    it('renders without a canvasRef', () => {
        expect(() => renderEditor()).not.toThrow();
    });
});

describe('imperative ref', () => {
    it('exposes the documented surface', () => {
        const ref = createRef<MaskEditorCanvasRef>();
        renderEditor({ canvasRef: ref });

        expect(ref.current).not.toBeNull();
        for (const method of ['undo', 'redo', 'clear', 'resetZoom', 'setPan', 'zoomIn', 'zoomOut'] as const) {
            expect(typeof ref.current?.[method]).toBe('function');
        }
    });

    it('resolves maskCanvas to the live mask element', () => {
        const ref = createRef<MaskEditorCanvasRef>();
        const { root } = renderEditor({ canvasRef: ref });

        // Previously this snapshotted `null` at handle-creation time and never updated,
        // because the dep array only listed the (stable) ref object.
        expect(ref.current?.maskCanvas).toBe(canvases(root).mask);
    });

    it('methods are callable without throwing', () => {
        const ref = createRef<MaskEditorCanvasRef>();
        renderEditor({ canvasRef: ref });

        expect(() => {
            ref.current?.zoomIn();
            ref.current?.zoomOut();
            ref.current?.resetZoom();
            ref.current?.setPan(5, 5);
            ref.current?.clear();
            ref.current?.undo();
            ref.current?.redo();
        }).not.toThrow();
    });
});
