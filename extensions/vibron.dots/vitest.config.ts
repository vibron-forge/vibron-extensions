import { defineConfig } from 'vitest/config'

// Pure modules run in node; the panel wiring test opts into jsdom per file.
export default defineConfig({
  test: {
    root: __dirname,
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
