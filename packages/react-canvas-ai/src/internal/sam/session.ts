import type { InferenceSession } from 'onnxruntime-web';
import type { SamConfig } from '../../hooks/useAutoSelect';
import { fetchOnnx } from './cache';

export type SamSessions = {
    encoder: InferenceSession;
    decoder: InferenceSession;
    encoderInputNames: readonly string[];
    decoderInputNames: readonly string[];
};

/**
 * Loads `onnxruntime-web` and creates both SAM inference sessions.
 *
 * The runtime is imported dynamically and the failure rewritten: `onnxruntime-web` is an
 * optional peer dependency, so the raw "module not found" error would otherwise surface to a
 * consumer with no hint that installing it is the fix.
 */
export const loadSessions = async (config: SamConfig, signal?: AbortSignal): Promise<SamSessions> => {
    let ort: typeof import('onnxruntime-web');

    try {
        ort = await import('onnxruntime-web');
    } catch (cause) {
        throw new Error('react-canvas-ai: install `onnxruntime-web` to use auto-selection.', {
            cause: cause instanceof Error ? cause : undefined,
        });
    }

    // `ort.env` is process-global, so this is last-config-wins by design. Guarding it behind a
    // module-level "already set" flag — which is what the plugin this was ported from did —
    // silently ignored every config after the first.
    if (config.wasmPaths) ort.env.wasm.wasmPaths = config.wasmPaths;

    const executionProviders = config.executionProviders ?? ['wasm'];
    const sessionOptions: InferenceSession.SessionOptions = { executionProviders };

    const [encoderBuf, decoderBuf] = await Promise.all([
        fetchOnnx(config.encoderUrl, signal),
        fetchOnnx(config.decoderUrl, signal),
    ]);

    const [encoder, decoder] = await Promise.all([
        ort.InferenceSession.create(encoderBuf, sessionOptions),
        ort.InferenceSession.create(decoderBuf, sessionOptions),
    ]);

    if (config.debug) {
        console.info(
            '[MaskEditor] SAM encoder inputs:',
            JSON.stringify(encoder.inputNames),
            'outputs:',
            JSON.stringify(encoder.outputNames),
        );
        console.info(
            '[MaskEditor] SAM decoder inputs:',
            JSON.stringify(decoder.inputNames),
            'outputs:',
            JSON.stringify(decoder.outputNames),
        );
    }

    return {
        encoder,
        decoder,
        encoderInputNames: encoder.inputNames,
        decoderInputNames: decoder.inputNames,
    };
};
