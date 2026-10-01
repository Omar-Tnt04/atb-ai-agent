import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  // Never embed local development credentials in an extension distribution.
  envDir: false,
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.VITE_AGENT_AUTH_TOKEN': '""', 'import.meta.env.VITE_AGENT_API_URL': '""' },
  publicDir: false,
  build: {
    outDir: '../widget-injector-extension/dist',
    emptyOutDir: true,
    lib: { entry: 'src/extension.jsx', formats: ['iife'], name: 'ATBWidget', fileName: () => 'widget.js' },
  },
});
