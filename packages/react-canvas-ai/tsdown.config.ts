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
    deps: { neverBundle: ['react', 'react-dom', 'react/jsx-runtime'] },
    exports: true,
    publint: true,
});
