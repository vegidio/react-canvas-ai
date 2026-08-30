import type { RefObject } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Point } from './geometry';
import type { Detection } from './sam/engine';
import { drawPreviewSilhouette } from './canvas';
import { CLICK_SLOP_PX, distance, toImageLength } from './geometry';
import { useLatest } from './useLatest';

/**
 * Smallest gap between two speculative detections.
 *
 * A decoder budget, not a feel setting: the first detection after the pointer reaches something
 * the drawing on screen does not answer for fires immediately, so this only decides how fast a
 * *sweep* is allowed to keep asking. A mouse delivers moves every 8-16 ms, so this collapses
 * some sixty detections a second into at most seven — of which all but the newest abort before
 * their decoder pass. Shorter buys nothing, because a decode already costs more than this and
 * the runs would only pile up in the engine's serial queue; much longer and the second object
 * under a moving pointer visibly lags the first.
 *
 * This replaced a 500 ms trailing debounce, which made every preview wait for stillness that a
 * hovering hand rarely supplies.
 */
const AUTO_PREVIEW_INTERVAL_MS = 150;

/** Fraction of the mask's own opacity the preview fill is drawn at. */
const PREVIEW_FILL_SCALE = 0.55;

/** The outline carries the extent, so it stays near-solid however faint the fill is. */
const PREVIEW_OUTLINE_ALPHA = 0.9;

/** Outline thickness in *displayed* pixels, converted to canvas pixels at draw time. */
const PREVIEW_OUTLINE_PX = 2;

/** A detection drawn but not committed, and where it was asked for. */
type PreviewCache = {
    /** Viewport coordinates, for the reason {@link CLICK_SLOP_PX} is measured in them. */
    client: Point;
    detection: Detection;
};

export type AutoPreviewOptions = {
    /** Whether the active mode previews at all: auto-selection is live and `preview` is set. */
    active: boolean;
    size: Point;
    maskColor: string;
    maskOpacity: number;
    /** Displayed size over canvas size, so the outline keeps its thickness on screen. */
    effectiveScale: number;
    getImageCoordinates: (clientX: number, clientY: number) => Point;
    /** Runs the speculative detection. Wired to `useAutoSelect.detect` with `preview: true`. */
    detect: (point: Point, target: Point, signal: AbortSignal) => Promise<Detection | undefined>;
    /** Previews wait for the model: never queue one behind the 14 MB warm-up. */
    isReady: boolean;
    /** A committed detection is in flight; see the re-arm in the timer below. */
    isDetectingRef: RefObject<boolean>;
    isPanning: boolean;
    isSpaceKeyDown: boolean;
};

export type AutoPreviewHandle = {
    /**
     * Hands back the detection a click at `client` may commit directly, and takes it out of the
     * cache in the same call.
     *
     * Single use, because {@link Detection} is: the editor tints `silhouette` in place, so a
     * second consumer of the same surface would be compositing a picture somebody else already
     * mutated.
     */
    take: (client: Point) => Detection | undefined;
    /** Drops the cache and wipes the overlay. Called once a commit has settled. */
    clear: () => void;
    /** Cancels any owed run without disturbing what is already drawn. */
    cancel: () => void;
};

/**
 * Draws the object under the pointer as an uncommitted overlay, so the extent of an
 * auto-selection is visible before the click that makes it.
 *
 * The detection starts on the move itself, not on a timer once the hand goes still — a trailing
 * debounce made every preview wait for a stillness a hovering hand rarely supplies. Every move
 * asks, including one inside the shape already drawn, because SAM answers a point rather than an
 * object and a smaller object inside a bigger silhouette has to stay reachable. The rate limit
 * is the only thing bounding the cost, and the abort in `run` is what keeps it cheap.
 *
 * Lives here rather than in `useBrush`, whose early return is its contract — "a mode without a
 * brush leaves the pointer alone entirely: no outline, no dabs". Hanging this off it would make
 * that comment false and couple throttle and staleness bookkeeping to a `getCoalescedEvents`
 * replay path that a preview has no use for. Two `pointermove` listeners on one element, each
 * returning early for the mode it does not own, reads better than one listener with two modes
 * inside it.
 *
 * It paints on the cursor layer, which the auto mode leaves entirely idle: `MODE_TOOLS` makes
 * `usesBrush` and `usesAutoSelect` mutually exclusive, so the brush outline and the preview can
 * never write to that surface in the same commit.
 */
export const useAutoPreview = (
    cursorCanvas: HTMLCanvasElement | undefined,
    cursorContext: CanvasRenderingContext2D | undefined,
    options: AutoPreviewOptions,
): { handle: AutoPreviewHandle; isPreviewing: boolean } => {
    const optionsRef = useLatest(options);
    const { active, maskColor, maskOpacity, size } = options;

    const [isPreviewing, setIsPreviewing] = useState(false);

    /** A deferred run is owed. Its presence is also what stops a leading fire racing a trailing one. */
    const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const cacheRef = useRef<PreviewCache | undefined>(undefined);
    const abortRef = useRef<AbortController | undefined>(undefined);

    /**
     * When the last speculative detection started. `Date.now` rather than `performance.now`:
     * the rate limit has to advance under `vi.advanceTimersByTime`, and `Date` is the one clock
     * every fake-timer configuration mocks. A wall-clock jump costs one extra or one deferred
     * preview, which is not worth the coupling.
     */
    const lastRunAtRef = useRef(0);

    /**
     * Where the mouse is, updated on every qualifying move — including the ones the hit test
     * suppresses. A trailing run has to fire for where the pointer *is*, not for the position
     * that armed it an interval ago, or a sweep would keep previewing objects already left.
     */
    const pointerRef = useRef<Point | undefined>(undefined);

    /**
     * Bumped by everything that invalidates a request in flight. One monotonic counter with one
     * check site — read once when a detection resolves, before it reaches the cache or the
     * canvas — rather than a condition per invalidation reason, which is how such a list drifts
     * out of agreement with itself.
     */
    const seqRef = useRef(0);

    // Colour and opacity are arguments rather than further reads off `optionsRef`, so that the
    // recolour effect below depends on the values it actually paints with: as ref reads they
    // became trigger-only dependencies, which is a shape this codebase's lint does not allow and
    // has no precedent for suppressing.
    const paint = useCallback(
        (detection: Detection, color: string, opacity: number) => {
            if (!cursorContext) return;

            const { size: target, effectiveScale } = optionsRef.current;

            drawPreviewSilhouette(cursorContext, {
                size: target,
                silhouette: detection.silhouette,
                color,
                fillOpacity: opacity * PREVIEW_FILL_SCALE,
                outlineOpacity: PREVIEW_OUTLINE_ALPHA,
                // The layer is displayed under a CSS scale, so a 2 canvas-px ring vanishes when
                // zoomed out. Read at draw time only: a zoom change does not re-thicken a ring
                // already on screen, the next preview does.
                outlineWidth: toImageLength(PREVIEW_OUTLINE_PX, effectiveScale),
                rect: detection.paintRect,
            });
        },
        [cursorContext],
    );

    const cancel = useCallback(() => {
        if (timerRef.current !== undefined) clearTimeout(timerRef.current);
        timerRef.current = undefined;
        abortRef.current?.abort();
        abortRef.current = undefined;
        seqRef.current += 1;
    }, []);

    const clear = useCallback(() => {
        cancel();
        cacheRef.current = undefined;
        // The canvas's own dimensions, matching `useCursorPainter`: the two hooks share this
        // layer, and `size` state lags the element by a commit on an image swap.
        if (cursorContext) cursorContext.clearRect(0, 0, cursorContext.canvas.width, cursorContext.canvas.height);
        setIsPreviewing(false);
    }, [cancel, cursorContext]);

    const take = useCallback((client: Point): Detection | undefined => {
        const cached = cacheRef.current;
        if (!cached) return undefined;

        if (distance(client, cached.client) > CLICK_SLOP_PX) return undefined;

        cacheRef.current = undefined;
        return cached.detection;
    }, []);

    const handle = useMemo<AutoPreviewHandle>(() => ({ take, clear, cancel }), [take, clear, cancel]);

    // The listener is keyed on the element alone; everything it reads comes through `optionsRef`,
    // so a colour, zoom or mode change never detaches and reattaches it.
    useEffect(() => {
        if (!cursorCanvas) return;

        const run = (clientX: number, clientY: number) => {
            const current = optionsRef.current;

            lastRunAtRef.current = Date.now();
            seqRef.current += 1;
            const seq = seqRef.current;

            // Aborted, not merely replaced. `engine.detect` re-checks the signal after the
            // inference queue hands over its slot, so a superseded run skips its decoder pass
            // entirely — but only if somebody actually aborts it. Overwriting the reference,
            // which is what this did, left that run to pay full price for a result the staleness
            // check below then threw away. Rare behind a debounce; routine once a move onto
            // something new fires on the spot.
            abortRef.current?.abort();

            const controller = new AbortController();
            abortRef.current = controller;

            const point = current.getImageCoordinates(clientX, clientY);

            current
                .detect(point, current.size, controller.signal)
                .then((detection) => {
                    // The one staleness check, and it is enough: nothing is awaited after it,
                    // so no invalidation can slip in between here and the paint below.
                    if (seq !== seqRef.current || !detection) return;

                    cacheRef.current = { client: { x: clientX, y: clientY }, detection };
                    paint(detection, current.maskColor, current.maskOpacity);
                    setIsPreviewing(true);
                })
                .catch(() => {
                    // Swallowed on purpose. A preview is speculative, so a failure is not the
                    // user's problem and must not reach `onError` — the next click reports it
                    // for real if the model is genuinely broken.
                });
        };

        /**
         * Whether a preview may run at all, as one predicate rather than a subset per call site.
         * Every gate that is about *this hook having no business drawing* lives here, so a new
         * one is added once instead of being fitted into whichever sites happen to need it.
         */
        const canPreview = (): boolean => {
            const current = optionsRef.current;
            return current.active && !current.isPanning && !current.isSpaceKeyDown && current.isReady;
        };

        /**
         * Whether a run should wait rather than be abandoned. Deliberately not folded into
         * {@link canPreview}: a committed detection in flight is a reason to try again shortly,
         * not a reason there is nothing to preview.
         */
        const shouldDefer = (): boolean => optionsRef.current.isDetectingRef.current;

        /** The deferred run: fires for wherever the pointer has settled, not where it was armed. */
        const fire = () => {
            timerRef.current = undefined;

            const client = pointerRef.current;
            if (!client) return;

            // Re-checked on firing, not only when armed: an interval is still long enough for
            // the mode to change, a pan to start or the model to fall over underneath it.
            if (!canPreview()) return;

            if (shouldDefer()) {
                // Re-armed rather than dropped: a preview started here would land after the
                // click's own commit and preview the thing that was just committed. Arming
                // again means a pointer at rest still gets its preview once the click
                // finishes, instead of needing a twitch to wake it up.
                timerRef.current = setTimeout(fire, AUTO_PREVIEW_INTERVAL_MS);
                return;
            }

            run(client.x, client.y);
        };

        const requestRun = (client: Point) => {
            const elapsed = Date.now() - lastRunAtRef.current;

            // The leading edge, and the point of the whole design: the detection starts on the
            // move itself rather than on a timer, so a pointer arriving somewhere new does not
            // wait to be noticed. `timerRef` is checked because a deferred run already owns the
            // next slot, and letting both fire would detect twice for one rest position.
            const canFireNow = timerRef.current === undefined && elapsed >= AUTO_PREVIEW_INTERVAL_MS && !shouldDefer();

            if (canFireNow) {
                run(client.x, client.y);
                return;
            }

            // Deferred, never dropped. Too soon, or the model is busy with a real click: either
            // way the pointer has moved since the last answer, so a run is owed.
            if (timerRef.current === undefined) {
                timerRef.current = setTimeout(fire, Math.max(AUTO_PREVIEW_INTERVAL_MS - elapsed, 0));
            }
        };

        const handlePointerMove = (evt: PointerEvent) => {
            // Mouse only, matching the brush: a preview under a finger would sit beneath the
            // hand that asked for it, and a stylus hover is a separate gesture to design for.
            if (evt.pointerType !== 'mouse') return;

            // Gated here as well as in `fire`: without it, a pointer wandering over a cold or
            // errored model would arm and drop a timer once per interval, forever.
            if (!canPreview()) return;

            const client = { x: evt.clientX, y: evt.clientY };
            pointerRef.current = client;

            // Every move asks — including one landing inside the shape already drawn, because
            // SAM answers a point rather than an object and a smaller object nested in a bigger
            // silhouette has to stay reachable.
            //
            // The exception is a move that has not actually gone anywhere. Within the slop, a
            // click would commit the cached detection unchanged, so re-detecting can only
            // reproduce the silhouette already on screen — and a hand resting on a mouse jitters
            // enough to buy a decoder pass every interval, forever, each one queued ahead of the
            // real click the user is about to make. Gated on the cache *existing*, so a point
            // whose detection came back empty or failed is still retried.
            const cached = cacheRef.current;
            if (cached && distance(client, cached.client) <= CLICK_SLOP_PX) return;

            requestRun(client);
        };

        const handlePointerLeave = () => {
            clear();
        };

        const handlePointerDown = () => {
            // The drawing stays up. On a cache hit the commit lands in this same tick, so
            // wiping here would only buy a one-frame blink; on a miss the silhouette is better
            // feedback than a hole while the real detection runs. `endAutoClick` clears it once
            // the commit settles.
            cancel();
        };

        cursorCanvas.addEventListener('pointermove', handlePointerMove);
        cursorCanvas.addEventListener('pointerleave', handlePointerLeave);
        cursorCanvas.addEventListener('pointerdown', handlePointerDown);

        return () => {
            cursorCanvas.removeEventListener('pointermove', handlePointerMove);
            cursorCanvas.removeEventListener('pointerleave', handlePointerLeave);
            cursorCanvas.removeEventListener('pointerdown', handlePointerDown);
        };
    }, [cursorCanvas, paint, clear, cancel]);

    // Owns the overlay's whole lifetime, the way `useCursorPainter` owns the brush outline's.
    // This is the transition that needs it: leaving auto mode does *not* run the painter's own
    // clear (its `active` becomes true, not false), so without this the last silhouette would
    // sit on the layer until some paint-mode move happened to `clearRect` over it.
    useEffect(() => {
        if (active) return;
        clear();
    }, [active, clear]);

    // A new image or a resize blanks the canvas anyway — the layout effect in `useMaskEditor`
    // reassigns `width`/`height` — so this is about the cache, which would otherwise let a click
    // commit a silhouette measured against an image that is no longer on screen.
    const sizedForRef = useRef(size);
    useEffect(() => {
        if (sizedForRef.current.x === size.x && sizedForRef.current.y === size.y) return;

        sizedForRef.current = size;
        cacheRef.current = undefined;
        setIsPreviewing(false);
    }, [size]);

    // Repainted rather than dropped: the detection is still true, only its colour is stale, and
    // a fresh decoder pass is a lot to pay for a recolour the compositor does for free.
    useEffect(() => {
        const cached = cacheRef.current;
        if (!cached || !active) return;

        paint(cached.detection, maskColor, maskOpacity);
    }, [maskColor, maskOpacity, active, paint]);

    useEffect(() => cancel, [cancel]);

    return { handle, isPreviewing };
};
