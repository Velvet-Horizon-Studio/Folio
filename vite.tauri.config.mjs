import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Renderer build for the Tauri app (src-tauri/). The Electron build uses
// electron.vite.config.mjs; both build the same src/renderer.
export default defineConfig({
  root: resolve('src/renderer'),
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src')
    }
  },
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { outDir: resolve('out-tauri'), emptyOutDir: true }
})
