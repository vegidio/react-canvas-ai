import * as React from 'react';

export interface HistoryState {
    imageData: ImageData;
    timestamp: number;
}

export interface UseHistoryReturn {
    history: HistoryState[];
    historyIndex: number;
    saveToHistory: () => void;
    restoreFromHistory: (index: number) => void;
    undo: () => void;
    redo: () => void;
    clear: () => void;
}

interface UseHistoryOptions {
    onUndoRequest?: () => void;
    onRedoRequest?: () => void;
    maxHistorySize?: number;
}

/** The entries and the cursor into them move together, so they are one value. */
interface HistoryStack {
    entries: HistoryState[];
    index: number;
}

const EMPTY: HistoryStack = { entries: [], index: -1 };

export function useHistory(
    context: CanvasRenderingContext2D | null,
    size: { x: number; y: number },
    options: UseHistoryOptions = {},
): UseHistoryReturn {
    const { onUndoRequest, onRedoRequest, maxHistorySize = 50 } = options;

    const [stack, setStack] = React.useState<HistoryStack>(EMPTY);

    // Mirrored eagerly so two saves in the same tick see each other. Holding the entries and
    // the index in separate state, and reading the index from the closure inside a
    // `setHistory` updater, used to let the two drift apart and silently corrupt undo —
    // reachable from a fast double stroke, or a stroke landing alongside an initial mask.
    const stackRef = React.useRef(stack);

    const commit = React.useCallback((next: HistoryStack) => {
        stackRef.current = next;
        setStack(next);
    }, []);

    const saveToHistory = React.useCallback(() => {
        if (!context || size.x === 0 || size.y === 0) return;

        let imageData: ImageData;
        try {
            // Read outside the updater: it is a side effect, and StrictMode invokes updaters twice.
            imageData = context.getImageData(0, 0, size.x, size.y);
        } catch (error) {
            // Avoid crash if the canvas is tainted or not ready.
            console.warn('Failed to save history state:', error);
            return;
        }

        const previous = stackRef.current;
        // Drop any redo branch we are about to diverge from.
        const entries = previous.entries.slice(0, previous.index + 1);
        entries.push({ imageData, timestamp: Date.now() });

        const capped = entries.slice(-maxHistorySize);
        commit({ entries: capped, index: capped.length - 1 });
    }, [context, size, maxHistorySize, commit]);

    const restoreFromHistory = React.useCallback(
        (index: number) => {
            if (!context || size.x === 0 || size.y === 0) return;

            const { entries } = stackRef.current;
            if (index < -1 || index >= entries.length) return;

            if (index === -1) {
                // Stepping back past the first entry means an empty canvas.
                context.clearRect(0, 0, size.x, size.y);
                commit({ entries, index: -1 });
                return;
            }

            const entry = entries[index];
            if (!entry) return;

            context.putImageData(entry.imageData, 0, 0);
            commit({ entries, index });
        },
        [context, size, commit],
    );

    const undo = React.useCallback(() => {
        restoreFromHistory(stackRef.current.index - 1);
        onUndoRequest?.();
    }, [restoreFromHistory, onUndoRequest]);

    const redo = React.useCallback(() => {
        const next = stackRef.current.index + 1;
        if (!stackRef.current.entries[next]) return;

        restoreFromHistory(next);
        onRedoRequest?.();
    }, [restoreFromHistory, onRedoRequest]);

    const clear = React.useCallback(() => {
        if (!context || size.x === 0 || size.y === 0) return;

        context.clearRect(0, 0, size.x, size.y);
        commit({ entries: [], index: -1 });
    }, [context, size, commit]);

    return React.useMemo(
        () => ({
            history: stack.entries,
            historyIndex: stack.index,
            saveToHistory,
            restoreFromHistory,
            undo,
            redo,
            clear,
        }),
        [stack, saveToHistory, restoreFromHistory, undo, redo, clear],
    );
}
