import type { CSSProperties, ReactElement, Ref } from 'react';
import { useId, useImperativeHandle, useMemo } from 'react';
import type { MaskEditorCanvasRef, UseMaskEditorProps } from '../hooks/useMaskEditor';
import { useMaskEditor } from '../hooks/useMaskEditor';
import { useLatest } from '../internal/useLatest';
import { maskEditorLayerStyles } from './MaskEditorLayers';

export type { MaskEditorCanvasRef };

export type MaskEditorProps = UseMaskEditorProps & {
    /**
     * The editor's imperative handle. React 19 passes `ref` as an ordinary prop, so this is
     * the standard spelling that DevTools and `ComponentProps` inference recognise — it was
     * `canvasRef` while the package still supported React 18.
     */
    ref?: Ref<MaskEditorCanvasRef>;
    /** Appended to the root element's own class name. */
    className?: string;
    /** Merged over the root element's built-in layout styles. */
    style?: CSSProperties;
};

// This component ships no stylesheet: every rule it needs is applied inline, so consumers
// can `import { MaskEditor }` and be done. The class names below are kept purely as
// styling hooks for consumers who want to reach in and override something.
const outerStyle: CSSProperties = {
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

const innerStyle: CSSProperties = {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
    overflow: 'hidden',
    flex: '1 1 auto',
    width: '100%',
    height: '100%',
};

const containerStyle: CSSProperties = {
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

export const MaskEditor = ({ ref, className, style, ...hookProps }: MaskEditorProps): ReactElement => {
    const {
        canvasRef,
        clear,
        cursorCanvasRef,
        cursorSize,
        handleMouseDown,
        handleMouseUp,
        key,
        maskBlendMode,
        maskCanvasRef,
        maskColor,
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

    // Mirrored so the style getters below can stay live without listing these values as
    // dependencies of the handle: `cursorSize` changes on every wheel tick while the user
    // resizes the brush, and rebuilding `ref.current` that often would break any consumer
    // holding on to the object it was handed.
    const styleRef = useLatest({ maskColor, maskOpacity, maskBlendMode, cursorSize });

    // Expose API via ref if provided
    useImperativeHandle(
        ref,
        () => ({
            get maskCanvas() {
                return maskCanvasRef.current ?? undefined;
            },
            get maskColor() {
                return styleRef.current.maskColor;
            },
            get maskOpacity() {
                return styleRef.current.maskOpacity;
            },
            get maskBlendMode() {
                return styleRef.current.maskBlendMode;
            },
            get cursorSize() {
                return styleRef.current.cursorSize;
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

    const canvasLayerStyle = useMemo<CSSProperties>(() => {
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
    const uniqueId = useId();

    return (
        <div
            className={className ? `react-mask-editor-outer ${className}` : 'react-mask-editor-outer'}
            data-mask-editor-id={uniqueId}
            style={{
                ...outerStyle,
                maxWidth: hookProps.maxWidth ? `${hookProps.maxWidth}px` : undefined,
                maxHeight: hookProps.maxHeight ? `${hookProps.maxHeight}px` : undefined,
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
