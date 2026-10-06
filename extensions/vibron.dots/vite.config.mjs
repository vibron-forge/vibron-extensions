import { defineConfig } from 'vite'

// The panel is served by the extension's own server (dist/server.js) at the
// route root, from dist/public. A relative base keeps the entry refs
// (`./app.js`) resolving under Vibron's proxy prefix.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist/public',
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        entryFileNames: 'app.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
})
