import { describe, expect, it, vi } from 'vitest';
import { loadSessions } from '../../../src/internal/sam/session';

// A separate file because vi.mock factories are per-module: here the runtime import itself
// fails, standing in for a consumer who never installed the optional peer dependency.
vi.mock('onnxruntime-web', () => {
    throw new Error("Cannot find module 'onnxruntime-web'");
});

describe('loadSessions without onnxruntime-web', () => {
    it('rewrites the module-not-found error into an install hint', async () => {
        await expect(loadSessions({ encoderUrl: 'e', decoderUrl: 'd' })).rejects.toThrow(/install `onnxruntime-web`/);
    });
});
