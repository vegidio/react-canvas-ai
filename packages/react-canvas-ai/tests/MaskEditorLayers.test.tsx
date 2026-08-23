import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MaskEditorLayers, maskEditorLayerStyles } from '../src/components/MaskEditorLayers';
import { MaskEditorProvider } from '../src/components/MaskEditorProvider';
import { canvases } from './helpers/canvas';
import { installImageMock, SRC } from './helpers/image';

installImageMock({ width: 400, height: 200 });

const renderLayers = (props: Partial<React.ComponentProps<typeof MaskEditorProvider>> = {}) =>
    render(
        <MaskEditorProvider src={SRC} onDrawingChange={vi.fn()} {...props}>
            <MaskEditorLayers />
        </MaskEditorProvider>,
    );

describe('MaskEditorLayers', () => {
    it('renders all three layers with the class hooks consumers style against', () => {
        const { container } = renderLayers();
        const { base, mask, cursor } = canvases(container);

        expect(base).toBeInTheDocument();
        expect(mask).toBeInTheDocument();
        expect(cursor).toBeInTheDocument();
    });

    it('carries the mask opacity and blend mode a hand-rolled stack tends to drop', () => {
        // This is the drift the export exists to prevent: the playground's own headless
        // example had lost both before the layers became a shared component.
        const { container } = renderLayers({ maskOpacity: 0.25, maskBlendMode: 'multiply' });
        const { mask } = canvases(container);

        expect(mask.style.opacity).toBe('0.25');
        expect(mask.style.mixBlendMode).toBe('multiply');
    });

    it('leaves pointer input to the cursor layer', () => {
        const { container } = renderLayers();
        const { mask } = canvases(container);

        expect(mask.style.pointerEvents).toBe('none');
    });
});

describe('maskEditorLayerStyles', () => {
    it('stacks the layers back to front', () => {
        const styles = maskEditorLayerStyles({
            size: { x: 10, y: 20 },
            maskOpacity: 0.5,
            maskBlendMode: 'normal',
            cursor: 'grabbing',
        });

        expect([styles.base.zIndex, styles.mask.zIndex, styles.cursor.zIndex]).toEqual([1, 2, 3]);
        expect(styles.cursor.cursor).toBe('grabbing');
        for (const style of [styles.base, styles.mask, styles.cursor]) {
            expect(style).toMatchObject({ position: 'absolute', width: 10, height: 20 });
        }
    });
});
