import { useEffect, useMemo, useState } from 'react';
import type { Point } from '../internal/geometry';
import { computeTargetSize, FALLBACK_SIZE } from '../internal/canvas';
import { loadImage } from '../internal/loadImage';

export type UseImageLoaderReturn = {
    /** The decoded image, or `undefined` while loading and after a failure. */
    image?: HTMLImageElement;
    /** Canvas dimensions for this image, fitted to the configured bounds. */
    size: Point;
    /** Bumped whenever a new image lands, so the base canvas can be remounted. */
    key: number;
};

/**
 * Owns the `src` -> decoded image -> canvas size pipeline.
 *
 * Only the load is an effect. The size is a pure function of the image and the configured
 * bounds, so it is derived during render — as a second effect, changing `maxWidth`/`maxHeight`
 * rendered once at the old size before correcting itself. Deriving also keeps the original
 * reason the two were split: a bounds change re-fits the image already in hand rather than
 * refetching it.
 */
export const useImageLoader = (
    src: string,
    maxWidth: number,
    maxHeight: number,
    crossOrigin?: string,
): UseImageLoaderReturn => {
    const [image, setImage] = useState<HTMLImageElement | undefined>(undefined);
    const [failed, setFailed] = useState(false);
    const [key, setKey] = useState(0);

    useEffect(() => {
        if (!src) return;

        // Without this, a superseded load could still resolve and overwrite the image that
        // replaced it — the previous cleanup was an empty function.
        const controller = new AbortController();
        let cancelled = false;

        loadImage(src, { crossOrigin, signal: controller.signal })
            .then((loaded) => {
                if (cancelled) return;
                setImage(loaded);
                setFailed(false);
                setKey((previous) => previous + 1);
            })
            .catch(() => {
                if (cancelled) return;
                // Keep the editor visible so the failure is obvious in place.
                setImage(undefined);
                setFailed(true);
            });

        return () => {
            cancelled = true;
            controller.abort();
        };
    }, [src, crossOrigin]);

    const size = useMemo<Point>(() => {
        if (image) return computeTargetSize(image, maxWidth, maxHeight);
        return failed ? { ...FALLBACK_SIZE } : { x: 0, y: 0 };
    }, [image, failed, maxWidth, maxHeight]);

    return useMemo(() => ({ image, size, key }), [image, size, key]);
};
