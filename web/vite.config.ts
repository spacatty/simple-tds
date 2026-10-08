import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The Go binary embeds ../internal/web/ui/dist. Everything is relative because
// the panel is served at "/" on ip:port and under "/<admin-path>/" on domains.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: '../internal/web/ui/dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
      '/preview': 'http://localhost:8080',
    },
  },
})
