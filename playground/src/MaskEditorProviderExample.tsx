import { MaskEditorLayers, MaskEditorProvider, useMaskEditorContext } from 'react-canvas-ai';
import cat from './assets/images/cat.jpg';

// Canvas and controls as separate components using the context.
function MaskEditorCanvas() {
    // MaskEditorLayers rather than three hand-rolled canvases: the stacking, z-order,
    // pointer-events and blend-mode contract lives in the package, so this example cannot
    // drift out of sync with it.
    const { size } = useMaskEditorContext();
    return (
        <div style={{ position: 'relative', width: size.x, height: size.y }}>
            <MaskEditorLayers />
        </div>
    );
}

function MaskEditorControls() {
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
}

export default function MaskEditorProviderExample() {
    return (
        <MaskEditorProvider src={cat} onDrawingChange={() => {}}>
            <h2>MaskEditorProvider Example</h2>
            <MaskEditorCanvas />
            <MaskEditorControls />
        </MaskEditorProvider>
    );
}
