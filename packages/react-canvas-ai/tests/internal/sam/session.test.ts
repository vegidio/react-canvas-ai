import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchOnnx } from '../../../src/internal/sam/cache';
import { loadSessions } from '../../../src/internal/sam/session';

const { ortEnv, createSession } = vi.hoisted(() => {
    return {
        ortEnv: { wasm: {} as { wasmPaths?: string } },
        createSession: vi.fn(),
    };
});

vi.mock('onnxruntime-web', () => ({
    env: ortEnv,
    InferenceSession: { create: createSession },
}));

vi.mock('../../../src/internal/sam/cache', () => ({
    fetchOnnx: vi.fn(async () => new ArrayBuffer(8)),
}));

const CONFIG = { encoderUrl: 'https://cdn/enc.onnx', decoderUrl: 'https://cdn/dec.onnx' };

const makeSession = (prefix: string) => ({
    inputNames: [`${prefix}_in`],
    outputNames: [`${prefix}_out`],
});

beforeEach(() => {
    ortEnv.wasm = {};
    createSession.mockReset();
    createSession.mockResolvedValueOnce(makeSession('encoder')).mockResolvedValueOnce(makeSession('decoder'));
    vi.mocked(fetchOnnx).mockClear();
});

describe('loadSessions', () => {
    it('fetches both models and creates both sessions with the wasm provider by default', async () => {
        const sessions = await loadSessions(CONFIG);

        expect(fetchOnnx).toHaveBeenCalledWith(CONFIG.encoderUrl, undefined);
        expect(fetchOnnx).toHaveBeenCalledWith(CONFIG.decoderUrl, undefined);
        expect(createSession).toHaveBeenCalledTimes(2);
        expect(createSession).toHaveBeenCalledWith(expect.any(ArrayBuffer), { executionProviders: ['wasm'] });
        expect(sessions.encoder.inputNames).toEqual(['encoder_in']);
        expect(sessions.decoder.inputNames).toEqual(['decoder_in']);
    });

    /**
     * The runtime rides back on the result so the engine does not re-import it at each use
     * site: this is the one place that rewrites the "module not found" failure into an
     * actionable message.
     */
    it('hands the loaded runtime back with the sessions', async () => {
        const sessions = await loadSessions(CONFIG);
        expect(sessions.ort.InferenceSession.create).toBe(createSession);
    });

    it('passes custom execution providers through', async () => {
        await loadSessions({ ...CONFIG, executionProviders: ['webgpu', 'wasm'] });

        expect(createSession).toHaveBeenCalledWith(expect.any(ArrayBuffer), {
            executionProviders: ['webgpu', 'wasm'],
        });
    });

    it('forwards the abort signal to the model fetches', async () => {
        const controller = new AbortController();
        await loadSessions(CONFIG, controller.signal);

        expect(fetchOnnx).toHaveBeenCalledWith(CONFIG.encoderUrl, controller.signal);
    });

    /**
     * Regression: the plugin this was ported from set `wasmPaths` behind a module-level
     * "already set" flag, so every config after the first was silently ignored.
     */
    it('applies wasmPaths per config, last one wins', async () => {
        await loadSessions({ ...CONFIG, wasmPaths: '/first/' });
        expect(ortEnv.wasm.wasmPaths).toBe('/first/');

        createSession.mockResolvedValueOnce(makeSession('encoder')).mockResolvedValueOnce(makeSession('decoder'));
        await loadSessions({ ...CONFIG, wasmPaths: '/second/' });
        expect(ortEnv.wasm.wasmPaths).toBe('/second/');
    });

    it('leaves wasmPaths alone when not configured', async () => {
        ortEnv.wasm.wasmPaths = '/existing/';
        await loadSessions(CONFIG);
        expect(ortEnv.wasm.wasmPaths).toBe('/existing/');
    });

    it('logs tensor names only when debug is on', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});

        await loadSessions(CONFIG);
        expect(info).not.toHaveBeenCalled();

        createSession.mockResolvedValueOnce(makeSession('encoder')).mockResolvedValueOnce(makeSession('decoder'));
        await loadSessions({ ...CONFIG, debug: true });
        expect(info).toHaveBeenCalledWith(
            '[MaskEditor] SAM encoder inputs:',
            '["encoder_in"]',
            'outputs:',
            '["encoder_out"]',
        );
    });
});
