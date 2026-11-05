import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Vite owns the browser bundle; Wrangler owns the Worker bundle and bindings.
export default defineConfig(({mode}) => ({
  plugins: mode === 'test' ? [] : [react(), tailwindcss()],
  build: {outDir: 'dist/client'},
}));
