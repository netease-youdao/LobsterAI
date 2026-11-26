import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import { defineConfig, type Plugin } from 'vite';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';

// https://vitejs.dev/config/
// PORT lets tooling (e.g. browser preview) assign a free port; electron:dev
// pins 5175 via the --port CLI flag, which overrides server.port anyway.
const devPort = Number(process.env.PORT ?? '') || 5175;
// Keep production and development dependency transforms aligned with Electron.
// The Word layout engine initializes HarfBuzz with top-level await.
const rendererTarget = 'es2022';
const katexVersion = process.env.npm_package_dependencies_katex?.replace(/^[~^]/, '') || '0.16.0';
const pdfJsAssetRoot = path.resolve(__dirname, 'node_modules/pdfjs-dist');
const pdfJsPublicPath = '/pdfjs/';
const pdfJsAssetDirs = [
  { route: `${pdfJsPublicPath}cmaps/`, source: path.join(pdfJsAssetRoot, 'cmaps'), output: 'cmaps' },
  { route: `${pdfJsPublicPath}standard_fonts/`, source: path.join(pdfJsAssetRoot, 'standard_fonts'), output: 'standard_fonts' },
];

function servePdfJsAsset(
  reqUrl: string | undefined,
  res: import('http').ServerResponse,
  next: () => void,
): void {
  if (!reqUrl) {
    next();
    return;
  }

  const pathname = new URL(reqUrl, 'http://localhost').pathname;
  const assetDir = pdfJsAssetDirs.find(dir => pathname.startsWith(dir.route));
  if (!assetDir) {
    next();
    return;
  }

  const relativePath = decodeURIComponent(pathname.slice(assetDir.route.length));
  const assetPath = path.resolve(assetDir.source, relativePath);
  if (!assetPath.startsWith(assetDir.source + path.sep)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  if (!fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile()) {
    res.statusCode = 404;
    res.end('Not found');
    return;
  }

  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  fs.createReadStream(assetPath).pipe(res);
}

function pdfJsStaticAssetsPlugin(): Plugin {
  return {
    name: 'pdfjs-static-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        servePdfJsAsset(req.url, res, next);
      });
    },
    writeBundle(outputOptions) {
      const outputDir = outputOptions.dir || path.resolve(__dirname, 'dist');
      const targetRoot = path.resolve(outputDir, `.${pdfJsPublicPath}`);
      for (const assetDir of pdfJsAssetDirs) {
        const targetDir = path.join(targetRoot, assetDir.output);
        fs.rmSync(targetDir, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(targetDir), { recursive: true });
        fs.cpSync(assetDir.source, targetDir, { recursive: true });
      }
    },
  };
}

function silkWasmAssetPlugin(): Plugin {
  const silkWasmSource = path.resolve(__dirname, 'node_modules/silk-wasm/lib/silk.wasm');
  return {
    name: 'silk-wasm-asset',
    writeBundle(outputOptions) {
      if (!fs.existsSync(silkWasmSource)) return;
      const outputDir = outputOptions.dir || path.resolve(__dirname, 'dist-electron');
      fs.mkdirSync(outputDir, { recursive: true });
      fs.copyFileSync(silkWasmSource, path.join(outputDir, 'silk.wasm'));
    },
  };
}

export default defineConfig(({ command }) => {
  const productionMinify = command === 'build' ? 'esbuild' : false;
  return {
  define: {
    // KaTeX ESM bundle references this compile-time constant.
    __VERSION__: JSON.stringify(katexVersion),
  },
  plugins: [
    react(),
    pdfJsStaticAssetsPlugin(),
    electron([
      {
        // 主进程入口文件
        entry: 'src/main/main.ts',
        vite: {
          plugins: [silkWasmAssetPlugin()],
          resolve: {
            // Force Node/CJS entries for audio WASM decoders:
            // - silk-wasm CJS avoids Vite rewriting `new URL("silk.wasm", import.meta.url)`
            //   into a `data:` URI (which Node's fs.readFileSync cannot open).
            // - @eshaz/web-worker Node CJS avoids its browser field evaluating
            //   global `Worker` at module top level in Electron's main process.
            alias: {
              'silk-wasm': path.resolve(__dirname, 'node_modules/silk-wasm/lib/index.cjs'),
              '@eshaz/web-worker': path.resolve(__dirname, 'node_modules/@eshaz/web-worker/cjs/node.js'),
            },
          },
          build: {
            sourcemap: true,
            outDir: 'dist-electron',
            minify: productionMinify,
            rollupOptions: {
              external: (id) => {
                const staticExternals = ['better-sqlite3', 'discord.js', 'zlib-sync', '@discordjs/opus', 'bufferutil', 'utf-8-validate', 'playwright-core'];
                return staticExternals.includes(id);
              },
              output: {
                // Keep CJS format (default), but load via ESM loader.mjs
                inlineDynamicImports: true,
              },
            },
          },
        },
        // package.json starts Electron after all preload and main output files stabilize.
        onstart() {},
      },
      {
        // 预加载脚本入口文件
        entry: 'src/main/preload.ts',
        vite: {
          build: {
            sourcemap: true,
            outDir: 'dist-electron',
            minify: productionMinify,
          },
        },
        onstart() {},
      },
      {
        entry: 'src/main/appQuitConfirmationPreload.ts',
        vite: {
          build: {
            sourcemap: true,
            outDir: 'dist-electron',
            minify: productionMinify,
          },
        },
        onstart() {},
      },
      {
        entry: 'src/main/office/word/wordPanelPreload.ts',
        vite: { build: { sourcemap: true, outDir: 'dist-electron', minify: productionMinify } },
        onstart() {},
      },
      {
        // Sandboxed webview preload used only for browser annotations.
        entry: 'src/main/browserAnnotationPreload.ts',
        vite: {
          build: {
            sourcemap: true,
            outDir: 'dist-electron',
            minify: productionMinify,
          },
        },
        onstart() {},
      },
      {
        // Sandboxed preload used only by the isolated saved-credential login view.
        entry: 'src/main/browserCredentials/agentBrowserCredentialPreload.ts',
        vite: {
          build: {
            sourcemap: true,
            outDir: 'dist-electron',
            minify: productionMinify,
          },
        },
        onstart() {},
      },
      {
        // Sandboxed preload that observes manual login submissions without exposing secrets to pages.
        entry: 'src/main/browserCredentials/manualCredentialCapturePreload.ts',
        vite: {
          build: {
            sourcemap: true,
            outDir: 'dist-electron',
            minify: productionMinify,
          },
        },
        onstart() {},
      },
    ]),
    renderer(),
    {
      name: 'word-panel-dev-refresh',
      apply: 'serve',
      transformIndexHtml(html, context) {
        if (context.path !== '/word-panel.html') return;
        // Vite injects an inline React Refresh preamble and uses a loopback WebSocket in development.
        return html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
          .replace("connect-src 'self'", "connect-src 'self' ws://localhost:* ws://127.0.0.1:*");
      },
    },
  ],
  base: process.env.NODE_ENV === 'development' ? '/' : './',
  // The syntax-highlighting worker loads grammars on demand; ES module workers allow that code splitting.
  worker: {
    format: 'es',
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, './src/shared'),
      '@': path.resolve(__dirname, './src/renderer'),
    },
  },
  build: {
    target: rendererTarget,
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    minify: productionMinify,
    rollupOptions: {
      // library-thumbnail.html is built by vite.thumbnail.config.ts so the
      // sandboxed thumbnail page never shares chunks with the app entry.
      input: {
        main: path.resolve(__dirname, 'index.html'),
        wordPanel: path.resolve(__dirname, 'word-panel.html'),
        desktopCompanion: path.resolve(__dirname, 'desktop-companion.html'),
        companionComposer: path.resolve(__dirname, 'companion-composer.html'),
        companionScreenshot: path.resolve(__dirname, 'companion-screenshot.html'),
      },
    },
  },
  server: {
    port: devPort,
    strictPort: true,
    host: true,
    // Vite marks pre-bundled deps `immutable` under a `?v=` hash that can repeat
    // across re-optimizations with different chunk files. Electron's HTTP cache
    // (shared by every checkout and launch) never revalidates those, so the
    // renderer imports chunks this server no longer has (404) and never mounts.
    // server.headers is applied after Vite's own Cache-Control; with no-cache
    // each load revalidates against the ETag and gets a 304 when unchanged.
    headers: {
      'Cache-Control': 'no-cache',
    },
    hmr: {
      port: devPort,
    },
    watch: {
      usePolling: false,
      // Ignore vendor/ to prevent dev reload when plugins are installed into
      // vendor/openclaw-runtime/.../third-party-extensions/
      // Skip temporary trees (which may contain circular junctions) and Electron output.
      // Anchor artifacts/ (repo-root scratch output) so src/renderer/components/artifacts/ still
      // hot-reloads; chokidar never matches relative globs, and a directory path covers its subtree.
      ignored: [
        '**/vendor/**',
        '**/.work/**',
        path.resolve(__dirname, 'artifacts'),
        '**/dist-electron/**',
      ],
    },
  },
  optimizeDeps: {
    exclude: ['electron'],
    esbuildOptions: {
      target: rendererTarget,
      define: {
        __VERSION__: JSON.stringify(katexVersion),
      },
    },
  },
  clearScreen: false,
  };
});
