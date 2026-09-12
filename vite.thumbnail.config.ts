import path from 'path';
import { defineConfig } from 'vite';

// The library thumbnail page is built separately from the main renderer so its
// chunk graph never shares modules with the application entry chunk. In a
// combined build Rollup keeps dependencies that the app imports statically (for
// example mermaid's markdown helpers) inside the main entry chunk; a lazy
// thumbnail chunk importing them boots the whole app inside the sandboxed
// thumbnail window and throws before the thumbnail can render.
const katexVersion = process.env.npm_package_dependencies_katex?.replace(/^[~^]/, '') || '0.16.0';

export default defineConfig({
  define: {
    // KaTeX ESM bundle references this compile-time constant.
    __VERSION__: JSON.stringify(katexVersion),
  },
  base: './',
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, './src/shared'),
      '@': path.resolve(__dirname, './src/renderer'),
    },
  },
  build: {
    outDir: 'dist',
    // The main renderer build runs first and owns the dist directory.
    emptyOutDir: false,
    sourcemap: true,
    minify: false,
    rollupOptions: {
      input: path.resolve(__dirname, 'library-thumbnail.html'),
    },
  },
});
