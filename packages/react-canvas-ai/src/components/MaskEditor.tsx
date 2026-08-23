import React from 'react';
import type { MaskEditorCanvasRef, UseMaskEditorProps } from '../hooks/useMaskEditor';
import { useMaskEditor } from '../hooks/useMaskEditor';

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

// The three canvases are stacked absolutely on top of each other. Without these the
// layers collapse into normal flow and the editor renders as three stacked images.
const layerStyle: React.CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    display: 'block',
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
        containerRef,
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

    // Determine the appropriate cursor based on current state
    const containerCursorStyle = React.useMemo(() => {
        if (isPanning) {
            return 'grabbing';
        }
        if (isZoomKeyDown) {
            return 'zoom-in';
        }
        return 'default';
    }, [isPanning, isZoomKeyDown]);

    const handleKeyDown = React.useCallback((e: React.KeyboardEvent) => {
        if (e.code === 'Space') {
            e.preventDefault();
        }
    }, []);

    // Add a debug ID to see if component rendered when image is missing
    const uniqueId = React.useMemo(() => Math.random().toString(36).substring(2, 9), []);

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
            role='application'
            // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard-driven canvas surface; must be focusable to intercept Space before the page scrolls
            tabIndex={0}
            onKeyDown={handleKeyDown}
        >
            <div className='react-mask-editor-inner' ref={containerRef} style={innerStyle}>
                <div className='canvas-container' style={containerStyle}>
                    <div className='all-canvases' style={canvasLayerStyle}>
                        <canvas
                            key={key}
                            ref={canvasRef}
                            style={{ ...layerStyle, width: size.x, height: size.y, zIndex: 1 }}
                            width={size.x}
                            height={size.y}
                            className='react-mask-editor-base-canvas'
                        />
                        <canvas
                            ref={maskCanvasRef}
                            width={size.x}
                            height={size.y}
                            style={{
                                ...layerStyle,
                                width: size.x,
                                height: size.y,
                                opacity: maskOpacity,
                                mixBlendMode: maskBlendMode,
                                pointerEvents: 'none',
                                zIndex: 2,
                            }}
                            className='react-mask-editor-mask-canvas'
                        />
                        <canvas
                            ref={cursorCanvasRef}
                            width={size.x}
                            height={size.y}
                            onMouseUp={handleMouseUp}
                            onMouseDown={handleMouseDown}
                            style={{
                                ...layerStyle,
                                width: size.x,
                                height: size.y,
                                cursor: containerCursorStyle,
                                zIndex: 3,
                            }}
                            className='react-mask-editor-cursor-canvas'
                        />
                    </div>
                </div>
            </div>
        </div>
    );
};
