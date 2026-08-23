import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'jsdom',
        setupFiles: ['./tests/setup.ts'],
        include: ['tests/**/*.test.{ts,tsx}'],
        // vitest-canvas-mock ships CJS; without inlining it, jsdom resolution fails.
        server: { deps: { inline: ['vitest-canvas-mock'] } },
        coverage: {
            provider: 'v8',
            reporter: ['text', 'lcov'],
            // Vitest 4 requires an explicit include, or the report covers nothing.
            include: ['src/**/*.{ts,tsx}'],
            exclude: ['src/index.ts'],
            thresholds: { lines: 85, functions: 90, branches: 75, statements: 85 },
        },
    },
});
