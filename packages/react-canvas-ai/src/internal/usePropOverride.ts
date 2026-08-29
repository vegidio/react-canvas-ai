import { useState } from 'react';

/**
 * A quasi-controlled value: the prop wins whenever it changes, and the setter wins in between.
 * Passing `undefined` leaves the value entirely to the setter, starting from `initial`.
 *
 * The reconciliation happens during render rather than in an effect: as an effect, every prop
 * change first committed the stale value and only then re-rendered with the new one.
 */
export const usePropOverride = <T>(prop: T | undefined, initial: T): [T, (value: T) => void] => {
    const [value, setValue] = useState<T>(prop ?? initial);
    const [appliedProp, setAppliedProp] = useState(prop);

    if (appliedProp !== prop) {
        setAppliedProp(prop);
        if (prop !== undefined) setValue(prop);
    }

    return [value, setValue];
};
