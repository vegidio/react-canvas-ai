import { MaskEditorLayers, MaskEditorProvider, useMaskEditorContext } from 'react-canvas-ai';
import cat from './assets/images/cat.jpg';

// Canvas and controls as separate components using the context.
const MaskEditorCanvas = () => {
    // MaskEditorLayers rather than three hand-rolled canvases: the stacking, z-order,
    // pointer-events and blend-mode contract lives in the package, so this example cannot
    // drift out of sync with it.
    // `containerProps` has to be spread onto the element wrapping the stack: it carries the
    // ref the zoom/pan wiring attaches to, plus the focus and keyboard behaviour. Without it
    // the editor never measures itself, so wheel zoom and panning do nothing and every brush
    // dab lands at image coordinate (0, 0).
    const { size, containerProps } = useMaskEditorContext();
    return (
        <div {...containerProps} style={{ position: 'relative', width: size.x, height: size.y }}>
            <MaskEditorLayers />
        </div>
    );
};

const MaskEditorControls = () => {
    const { undo, redo, clear, historyIndex } = useMaskEditorContext();
    return (
        <div style={{ marginTop: 16 }}>
            <button type='button' onClick={undo}>
                Undo
            </button>
            <button type='button' onClick={redo}>
                Redo
            </button>
            <button type='button' onClick={clear}>
                Clear
            </button>
            <span style={{ marginLeft: 8, color: '#888' }}>History: {historyIndex + 1}</span>
        </div>
    );
};

const MaskEditorProviderExample = () => {
    return (
        <MaskEditorProvider src={cat} onDrawingChange={() => {}}>
            <h2>MaskEditorProvider Example</h2>
            <MaskEditorCanvas />
            <MaskEditorControls />
        </MaskEditorProvider>
    );
};

export default MaskEditorProviderExample;
