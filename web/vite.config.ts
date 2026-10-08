import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Only the environment is needed from Node, so its typings are not installed.
declare const process: { env: Record<string, string | undefined> }

// The Go binary embeds ../internal/web/ui/dist. Everything is relative because
// the panel is served at "/" on ip:port and under "/<admin-path>/" on domains.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: '../internal/web/ui/dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
    // Flags stay separate files instead of being inlined into the script.
    assetsInlineLimit: 0,
  },
  // `npm run dev` serves the panel with hot reload and forwards API calls to
  // the server started by dev/run.sh (see dev/env for its ports).
  server: {
    port: 5173,
    proxy: {
      '/api': process.env.TDS_DEV_PANEL || 'http://127.0.0.1:18080',
      '/preview': process.env.TDS_DEV_PANEL || 'http://127.0.0.1:18080',
    },
  },
})
