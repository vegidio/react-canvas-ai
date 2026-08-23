import * as React from 'react';

export interface HistoryState {
    imageData: ImageData;
}

export interface UseHistoryReturn {
    history: HistoryState[];
    historyIndex: number;
    saveToHistory: () => void;
    undo: () => void;
    redo: () => void;
    clear: () => void;
}

interface UseHistoryOptions {
    onUndoRequest?: () => void;
    onRedoRequest?: () => void;
    /**
     * Budget for retained undo states, in bytes.
     *
     * Entries are full uncompressed RGBA buffers, so a count-based cap scales with canvas
     * area: 50 states of a 1602x900 canvas is ~288 MB, and a 4096px canvas reaches into the
     * gigabytes. Capping on total bytes keeps the ceiling flat and lets a small canvas keep
     * proportionally more history.
     *
     * At least one entry is always retained, however large the canvas.
     */
    maxHistoryBytes?: number;
}

/** The entries and the cursor into them move together, so they are one value. */
interface HistoryStack {
    entries: HistoryState[];
    index: number;
}

const EMPTY: HistoryStack = { entries: [], index: -1 };

/** ~64 MB: about 45 states of a 1280x720 mask, or 11 of a 2560x1440 one. */
const DEFAULT_MAX_HISTORY_BYTES = 64 * 1024 * 1024;

/**
 * Drops the oldest entries until the stack fits the byte budget, always keeping the newest.
 */
function capToBudget(entries: HistoryState[], maxBytes: number): HistoryState[] {
    let total = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (!entry) continue;

        total += entry.imageData.data.byteLength;
        // `i === entries.length - 1` keeps the newest state even if it alone blows the budget:
        // dropping it would make the save a no-op and break undo entirely.
        if (total > maxBytes && i !== entries.length - 1) return entries.slice(i + 1);
    }
    return entries;
}

export function useHistory(
    context: CanvasRenderingContext2D | null,
    size: { x: number; y: number },
    options: UseHistoryOptions = {},
): UseHistoryReturn {
    const { onUndoRequest, onRedoRequest, maxHistoryBytes = DEFAULT_MAX_HISTORY_BYTES } = options;

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
        entries.push({ imageData });

        const capped = capToBudget(entries, maxHistoryBytes);
        commit({ entries: capped, index: capped.length - 1 });
    }, [context, size, maxHistoryBytes, commit]);

    /** Internal: `undo`/`redo` are the surface. Exposing this leaked a bounds contract. */
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
            undo,
            redo,
            clear,
        }),
        [stack, saveToHistory, undo, redo, clear],
    );
}
