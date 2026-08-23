import type { CSSProperties, FC } from 'react';
import { useMaskEditorContext } from './MaskEditorProvider';

/**
 * The three stacked canvases the editor draws into, in the right order with the right
 * pointer and blend behaviour.
 *
 * Exported because the package otherwise offered nothing between "the whole `MaskEditor`"
 * and "three bare refs" — so every headless consumer re-derived this layout, and quietly
 * lost whatever it forgot (mask opacity and blend mode being the easy ones to miss).
 *
 * Reads from `MaskEditorProvider`. Inside `MaskEditor` the equivalent state is passed
 * directly, so the shared piece is {@link maskEditorLayerStyles} below.
 */

// The layers are stacked absolutely on top of each other. Without this they collapse into
// normal flow and the editor renders as three images in a column.
const layerStyle: CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    display: 'block',
};

export type MaskEditorLayerState = {
    size: { x: number; y: number };
    maskOpacity: number;
    maskBlendMode: CSSProperties['mixBlendMode'];
    /** Cursor to show over the interactive layer. */
    cursor: CSSProperties['cursor'];
};

/** The inline styles for each layer, so a custom layout can reuse them verbatim. */
export const maskEditorLayerStyles = (
    state: MaskEditorLayerState,
): {
    base: CSSProperties;
    mask: CSSProperties;
    cursor: CSSProperties;
} => {
    const { size, maskOpacity, maskBlendMode, cursor } = state;
    const box = { width: size.x, height: size.y };

    return {
        base: { ...layerStyle, ...box, zIndex: 1 },
        mask: {
            ...layerStyle,
            ...box,
            opacity: maskOpacity,
            mixBlendMode: maskBlendMode,
            // The cursor layer above owns pointer input for the whole stack.
            pointerEvents: 'none',
            zIndex: 2,
        },
        cursor: { ...layerStyle, ...box, cursor, zIndex: 3 },
    };
};

export type MaskEditorLayersProps = {
    /** Remounts the base canvas when a new image lands. */
    baseKey?: number;
    cursor?: CSSProperties['cursor'];
};

/** Renders the canvas stack from `MaskEditorProvider`'s context. */
export const MaskEditorLayers: FC<MaskEditorLayersProps> = ({ baseKey, cursor = 'default' }) => {
    const {
        canvasRef,
        maskCanvasRef,
        cursorCanvasRef,
        size,
        maskOpacity,
        maskBlendMode,
        handleMouseDown,
        handleMouseUp,
    } = useMaskEditorContext();

    const styles = maskEditorLayerStyles({ size, maskOpacity, maskBlendMode, cursor });

    return (
        <>
            <canvas
                key={baseKey}
                ref={canvasRef}
                width={size.x}
                height={size.y}
                style={styles.base}
                className='react-mask-editor-base-canvas'
            />
            <canvas
                ref={maskCanvasRef}
                width={size.x}
                height={size.y}
                style={styles.mask}
                className='react-mask-editor-mask-canvas'
            />
            <canvas
                ref={cursorCanvasRef}
                width={size.x}
                height={size.y}
                onMouseUp={handleMouseUp}
                onMouseDown={handleMouseDown}
                style={styles.cursor}
                className='react-mask-editor-cursor-canvas'
            />
        </>
    );
};
