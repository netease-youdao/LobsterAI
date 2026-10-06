import path from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, './src/shared'),
      '@': path.resolve(__dirname, './src/renderer'),
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    // I/O-heavy suites (sqlite fixtures, tar archives) can exceed the 5s
    // default on loaded CI runners; 20s keeps hung tests detectable.
    testTimeout: 20000,
  },
});
