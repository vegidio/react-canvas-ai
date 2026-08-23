import '@testing-library/jest-dom/vitest';
import 'vitest-canvas-mock';

import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// jsdom does not implement ResizeObserver, and useZoomPan constructs one unconditionally.
// Without this stub every test that mounts the editor throws on render.
class ResizeObserverStub implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
}
// Assigned directly rather than via vi.stubGlobal: tests that call vi.unstubAllGlobals()
// would otherwise strip this out and break every later test that mounts the editor.
globalThis.ResizeObserver = ResizeObserverStub;

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
});
