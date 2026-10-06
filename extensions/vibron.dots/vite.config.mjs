import { defineConfig } from 'vite'

// The panel is served by Vibron's extension proxy at /ext/<token>/ while the
// build ships under dist/. A relative base keeps runtime URLs resolving against
// each file's real location; the entry refs in dist/index.html are rewritten
// to dist/ by scripts/postbuild.mjs.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
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
