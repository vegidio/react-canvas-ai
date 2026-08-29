/** Coerces an unknown rejection value into an `Error`, so callbacks always receive one. */
export const toError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));
