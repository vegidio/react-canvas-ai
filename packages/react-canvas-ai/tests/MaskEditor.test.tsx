import { type ComponentProps, createRef } from 'react';
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MaskEditor, type MaskEditorCanvasRef, MaskEditorDefaults } from '../src';
import { canvases } from './helpers/canvas';
import { installImageMock, SRC } from './helpers/image';

installImageMock({ width: 400, height: 200 });

const renderEditor = (props: Partial<ComponentProps<typeof MaskEditor>> = {}) => {
    const onDrawingChange = vi.fn();
    const utils = render(<MaskEditor src={SRC} onDrawingChange={onDrawingChange} {...props} />);
    const root = utils.container.querySelector('.react-mask-editor-outer') as HTMLElement;
    return { ...utils, root, onDrawingChange };
};

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

    // The focusable element is the inner container, not the outer wrapper: container-scoped
    // shortcuts test `container.contains(document.activeElement)`, and the wrapper is an
    // ancestor of the container rather than part of it.
    it('makes the container focusable and swallows Space so the page does not scroll', () => {
        const { container } = renderEditor();
        const inner = container.querySelector('.react-mask-editor-inner') as HTMLElement;
        expect(inner).toHaveAttribute('tabindex', '0');
        expect(inner).toHaveAttribute('role', 'application');

        const evt = new KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true });
        inner.dispatchEvent(evt);
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

    it('renders without a ref', () => {
        expect(() => renderEditor()).not.toThrow();
    });
});

describe('imperative ref', () => {
    it('exposes the documented surface', () => {
        const ref = createRef<MaskEditorCanvasRef>();
        renderEditor({ ref });

        expect(ref.current).not.toBeNull();
        for (const method of ['undo', 'redo', 'clear', 'resetZoom', 'setPan', 'zoomIn', 'zoomOut'] as const) {
            expect(typeof ref.current?.[method]).toBe('function');
        }
    });

    // Peer components that paint into `maskCanvas` themselves need the editor's current
    // painting style to match it; before this they had to be handed the same props twice.
    it('reports the active style, defaulting to MaskEditorDefaults', () => {
        const ref = createRef<MaskEditorCanvasRef>();
        renderEditor({ ref });

        expect(ref.current?.maskColor).toBe(MaskEditorDefaults.maskColor);
        expect(ref.current?.maskOpacity).toBe(MaskEditorDefaults.maskOpacity);
        expect(ref.current?.maskBlendMode).toBe(MaskEditorDefaults.maskBlendMode);
        expect(ref.current?.cursorSize).toBe(MaskEditorDefaults.cursorSize);
    });

    it('tracks style prop changes without remounting', () => {
        const ref = createRef<MaskEditorCanvasRef>();
        const { rerender } = renderEditor({ ref });

        rerender(
            <MaskEditor
                src={SRC}
                onDrawingChange={vi.fn()}
                ref={ref}
                maskColor='#ff0000'
                maskOpacity={0.9}
                maskBlendMode='multiply'
                cursorSize={42}
            />,
        );

        expect(ref.current?.maskColor).toBe('#ff0000');
        expect(ref.current?.maskOpacity).toBe(0.9);
        expect(ref.current?.maskBlendMode).toBe('multiply');
        expect(ref.current?.cursorSize).toBe(42);
    });

    // The style members are getters over a mirror rather than values baked into the handle's
    // dependency array, so a style change must not hand the consumer a fresh object — the
    // brush size alone changes on every wheel tick.
    it('keeps the handle identity stable across style changes', () => {
        const ref = createRef<MaskEditorCanvasRef>();
        const { rerender } = renderEditor({ ref });
        const handle = ref.current;

        rerender(<MaskEditor src={SRC} onDrawingChange={vi.fn()} ref={ref} maskColor='#00ff00' cursorSize={7} />);

        expect(ref.current).toBe(handle);
        expect(ref.current?.maskColor).toBe('#00ff00');
        expect(ref.current?.cursorSize).toBe(7);
    });

    it('resolves maskCanvas to the live mask element', () => {
        const ref = createRef<MaskEditorCanvasRef>();
        const { root } = renderEditor({ ref });

        // Previously this snapshotted `null` at handle-creation time and never updated,
        // because the dep array only listed the (stable) ref object.
        expect(ref.current?.maskCanvas).toBe(canvases(root).mask);
    });

    it('methods are callable without throwing', () => {
        const ref = createRef<MaskEditorCanvasRef>();
        renderEditor({ ref });

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

describe('keyboardScope', () => {
    const ctrlZ = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));

    const innerOf = (el: HTMLElement) => el.querySelector('.react-mask-editor-inner') as HTMLElement;

    const renderPair = (props: Partial<ComponentProps<typeof MaskEditor>> = {}) => {
        const first = vi.fn();
        const second = vi.fn();
        const utils = render(
            <>
                <MaskEditor src={SRC} onDrawingChange={vi.fn()} onUndoRequest={first} {...props} />
                <MaskEditor src={SRC} onDrawingChange={vi.fn()} onUndoRequest={second} {...props} />
            </>,
        );
        const editors = utils.container.querySelectorAll('.react-mask-editor-outer');
        return { first, second, editors: [...editors] as HTMLElement[] };
    };

    it('lets both editors answer one shortcut by default', () => {
        const { first, second } = renderPair();

        ctrlZ();

        // This is why the opt-in exists: page-level undo is right for one editor and wrong
        // for two, so the default stays and the fix is opt-in.
        expect(first).toHaveBeenCalledTimes(1);
        expect(second).toHaveBeenCalledTimes(1);
    });

    it("routes the shortcut to the focused editor only in 'container' mode", () => {
        const { first, second, editors } = renderPair({ keyboardScope: 'container' });

        innerOf(editors[1]).focus();
        ctrlZ();

        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledTimes(1);
    });

    it("ignores the shortcut when neither editor has focus in 'container' mode", () => {
        const { first, second } = renderPair({ keyboardScope: 'container' });

        ctrlZ();

        expect(first).not.toHaveBeenCalled();
        expect(second).not.toHaveBeenCalled();
    });

    it("focuses the container on mousedown in 'container' mode", () => {
        const { container } = renderEditor({ keyboardScope: 'container' });
        const inner = container.querySelector('.react-mask-editor-inner') as HTMLElement;

        // The canvases preventDefault on mousedown, which suppresses the focus a click would
        // otherwise give — so the shortcut would never be in scope without this.
        fireEvent.mouseDown(inner);
        expect(document.activeElement).toBe(inner);
    });

    it('leaves focus alone on mousedown under the default scope', () => {
        const { container } = renderEditor();
        const inner = container.querySelector('.react-mask-editor-inner') as HTMLElement;

        fireEvent.mouseDown(inner);
        expect(document.activeElement).not.toBe(inner);
    });
});
