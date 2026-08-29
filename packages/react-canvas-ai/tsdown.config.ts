import { defineConfig } from 'tsdown';

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    platform: 'neutral',
    target: 'es2022',
    sourcemap: true,
    clean: true,
    // TypeScript 7 cannot emit declarations yet, so these come from oxc. tsdown picks
    // that generator automatically because `isolatedDeclarations` is on in tsconfig.
    dts: { sourcemap: true },
    // `onnxruntime-web` is an optional peer reached only through a dynamic import; listing it
    // is belt-and-braces (peers are auto-external) and documents that it must stay external.
    deps: { neverBundle: ['react', 'react-dom', 'react/jsx-runtime', 'onnxruntime-web'] },
    // The exports map is hand-maintained: there is one entry, it never changes, and an
    // explicit "types" condition per format is clearer than relying on file adjacency.
    exports: false,
    publint: true,
});
