'use strict';

const fs = require('node:fs');
const path = require('node:path');

const OPENCLAW_AGENT_DB_BUNDLE_BANNER = '// LobsterAI: shared agent database modules v1\n';

function hasOpenClawAgentDbBundlePolicy(bundlePath) {
  const prefix = Buffer.alloc(512);
  const fd = fs.openSync(bundlePath, 'r');
  try {
    const bytes = fs.readSync(fd, prefix, 0, prefix.length, 0);
    // esbuild preserves entry.js's hashbang ahead of its injected banner.
    const header = prefix.toString('utf8', 0, bytes).replace(/^#![^\n]*\n/, '');
    return header.startsWith(OPENCLAW_AGENT_DB_BUNDLE_BANNER);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Lazy runtime/plugin imports load the original dist modules. Keep agent DB
 * lifecycle modules external so the gateway uses those same cached handles and
 * leases, instead of a second copy embedded in gateway-bundle.mjs.
 */
function createOpenClawAgentDbBundlePlugin(runtimeDir) {
  // vendor/openclaw-runtime/current can be a symlink/junction; esbuild resolves
  // source paths to their real location before invoking onResolve.
  const distDir = fs.realpathSync(path.resolve(runtimeDir, 'dist'));
  return {
    name: 'openclaw-shared-agent-db',
    setup(build) {
      build.onResolve({ filter: /(?:^|[/\\])openclaw-agent-db(?:-[\w-]+)?\.js$/ }, args => {
        if (!args.path.startsWith('.') && !path.isAbsolute(args.path)) return;
        const candidate = path.resolve(args.resolveDir, args.path);
        if (!fs.existsSync(candidate)) return;
        const resolved = fs.realpathSync(candidate);
        if (path.dirname(resolved) !== distDir) return;
        // The bundle is emitted at the runtime root. Keep this relocatable for
        // packaged apps; an absolute build-machine path cannot be shipped.
        return { path: `./dist/${path.basename(resolved)}`, external: true };
      });
    },
  };
}

module.exports = {
  OPENCLAW_AGENT_DB_BUNDLE_BANNER,
  createOpenClawAgentDbBundlePlugin,
  hasOpenClawAgentDbBundlePolicy,
};
