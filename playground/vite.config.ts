import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
    plugins: [react()],
    server: {
        port: 3000,
    },
    optimizeDeps: {
        // ORT's wasm loader breaks under Vite's dependency pre-bundling.
        exclude: ['onnxruntime-web'],
    },
});
