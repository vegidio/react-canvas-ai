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
 * Load and fit are separate effects so that changing `maxWidth`/`maxHeight` re-fits the
 * image already in hand rather than refetching it.
 */
export const useImageLoader = (
    src: string,
    maxWidth: number,
    maxHeight: number,
    crossOrigin?: string,
): UseImageLoaderReturn => {
    const [image, setImage] = useState<HTMLImageElement | undefined>(undefined);
    const [size, setSize] = useState<Point>({ x: 0, y: 0 });
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
                setKey((previous) => previous + 1);
            })
            .catch(() => {
                if (cancelled) return;
                // Keep the editor visible so the failure is obvious in place.
                setImage(undefined);
                setSize({ ...FALLBACK_SIZE });
            });

        return () => {
            cancelled = true;
            controller.abort();
        };
    }, [src, crossOrigin]);

    useEffect(() => {
        if (!image) return;
        setSize(computeTargetSize(image, maxWidth, maxHeight));
    }, [image, maxWidth, maxHeight]);

    return useMemo(() => ({ image, size, key }), [image, size, key]);
};
