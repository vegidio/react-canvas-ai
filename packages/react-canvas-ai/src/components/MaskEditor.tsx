import React from 'react';
import type { MaskEditorCanvasRef, UseMaskEditorProps } from '../hooks/useMaskEditor';
import { useMaskEditor } from '../hooks/useMaskEditor';
import { maskEditorLayerStyles } from './MaskEditorLayers';

export type { MaskEditorCanvasRef };

export interface MaskEditorProps extends UseMaskEditorProps {
    canvasRef?: React.Ref<MaskEditorCanvasRef>;
    /** Appended to the root element's own class name. */
    className?: string;
    /** Merged over the root element's built-in layout styles. */
    style?: React.CSSProperties;
}

// This component ships no stylesheet: every rule it needs is applied inline, so consumers
// can `import { MaskEditor }` and be done. The class names below are kept purely as
// styling hooks for consumers who want to reach in and override something.
const outerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'flex-start',
    alignItems: 'stretch',
    position: 'relative',
    overflow: 'hidden',
    margin: '0 auto',
    minHeight: 300,
    width: '100%',
    height: '100%',
};

const innerStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
    overflow: 'hidden',
    flex: '1 1 auto',
    width: '100%',
    height: '100%',
};

const containerStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
    boxSizing: 'border-box',
    width: '100%',
    height: '100%',
    maxWidth: '100%',
    maxHeight: '100%',
    minHeight: 200,
    overflow: 'hidden',
};

export const MaskEditor: React.FC<MaskEditorProps> = (props) => {
    const { canvasRef: externalMaskCanvasRef, className, style, ...hookProps } = props;

    const {
        canvasRef,
        clear,
        cursorCanvasRef,
        handleMouseDown,
        handleMouseUp,
        key,
        maskBlendMode,
        maskCanvasRef,
        maskOpacity,
        redo,
        size,
        undo,
        transform,
        containerProps,
        resetZoom,
        isPanning,
        isZoomKeyDown,
        setPan,
        effectiveScale,
        zoomIn,
        zoomOut,
    } = useMaskEditor(hookProps);

    // Expose API via ref if provided
    React.useImperativeHandle(
        externalMaskCanvasRef,
        () => ({
            get maskCanvas() {
                return maskCanvasRef.current;
            },
            undo,
            redo,
            clear,
            resetZoom,
            setPan,
            zoomIn,
            zoomOut,
        }),
        [maskCanvasRef, undo, redo, clear, resetZoom, setPan, zoomIn, zoomOut],
    );

    const canvasLayerStyle = React.useMemo<React.CSSProperties>(() => {
        return {
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: `translate(-50%, -50%) scale(${effectiveScale}) translate(${transform.translateX}px, ${transform.translateY}px)`,
            transformOrigin: 'center',
            transition: isPanning ? 'none' : 'transform 0.15s ease-out',
            width: size.x,
            height: size.y,
            display: 'block',
            // Keep the layer on its own compositor surface so panning does not repaint.
            willChange: 'transform',
            touchAction: 'none',
            transformStyle: 'preserve-3d',
            backfaceVisibility: 'hidden',
        };
    }, [transform, effectiveScale, isPanning, size]);

    const containerCursorStyle = isPanning ? 'grabbing' : isZoomKeyDown ? 'zoom-in' : 'default';

    // Shared with the exported `MaskEditorLayers`, so a headless consumer and this component
    // cannot drift apart on the stacking contract.
    const layerStyles = maskEditorLayerStyles({
        size,
        maskOpacity,
        maskBlendMode,
        cursor: containerCursorStyle,
    });

    // Stable across server and client renders; Math.random() here was a hydration mismatch.
    const uniqueId = React.useId();

    return (
        <div
            className={className ? `react-mask-editor-outer ${className}` : 'react-mask-editor-outer'}
            data-mask-editor-id={uniqueId}
            style={{
                ...outerStyle,
                maxWidth: props.maxWidth ? `${props.maxWidth}px` : undefined,
                maxHeight: props.maxHeight ? `${props.maxHeight}px` : undefined,
                ...style,
            }}
        >
            <div className='react-mask-editor-inner' style={innerStyle} {...containerProps}>
                <div className='canvas-container' style={containerStyle}>
                    <div className='all-canvases' style={canvasLayerStyle}>
                        <canvas
                            key={key}
                            ref={canvasRef}
                            width={size.x}
                            height={size.y}
                            style={layerStyles.base}
                            className='react-mask-editor-base-canvas'
                        />
                        <canvas
                            ref={maskCanvasRef}
                            width={size.x}
                            height={size.y}
                            style={layerStyles.mask}
                            className='react-mask-editor-mask-canvas'
                        />
                        <canvas
                            ref={cursorCanvasRef}
                            width={size.x}
                            height={size.y}
                            onMouseUp={handleMouseUp}
                            onMouseDown={handleMouseDown}
                            style={layerStyles.cursor}
                            className='react-mask-editor-cursor-canvas'
                        />
                    </div>
                </div>
            </div>
        </div>
    );
};
