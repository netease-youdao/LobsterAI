/**
 * Build script for technology-news-search skill.
 *
 * Bundles `rss-parser` (and its transitive deps) into a single CommonJS file
 * so the skill can run without external node_modules or NODE_PATH.
 *
 * Cross-platform: works on macOS, Windows, and Linux.
 */
const esbuild = require('esbuild');
const path = require('path');

esbuild.buildSync({
  stdin: {
    contents: 'module.exports = require("rss-parser");',
    resolveDir: path.resolve(__dirname, '..'),
  },
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: path.resolve(
    __dirname,
    '..',
    'SKILLs/technology-news-search/scripts/vendor/rss-parser.bundle.js'
  ),
  minify: true,
});

console.log('Built rss-parser.bundle.js');
