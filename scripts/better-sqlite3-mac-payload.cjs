'use strict';

const fs = require('fs');
const path = require('path');
const { Arch } = require('builder-util');

const REVIEWED_SQLITE_VERSION = '13.0.3';
const MAC_NATIVE_TARGETS = new Map([[Arch.arm64, 'darwin-arm64'], [Arch.x64, 'darwin-x64']]);
const SQLITE_MAC_EXCLUSIONS = [
  '!node_modules/better-sqlite3/{deps,src}{,/**/*}',
  '!node_modules/better-sqlite3/prebuilds/!(darwin-${arch}).node',
];
const appliedExclusions = new WeakMap();

/** Filter before ASAR construction so its index agrees with app.asar.unpacked. */
function configureBetterSqlite3MacPayload(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const options = context.packager.platformSpecificBuildOptions;
  const previous = appliedExclusions.get(options);
  const configured = options.files == null ? [] : Array.isArray(options.files) ? options.files : [options.files];
  const retained = configured.filter(pattern => !previous?.has(pattern));
  const universal = context.arch === Arch.universal
    || context.packager.info.options?.targets?.get(context.packager.platform)?.has(Arch.universal);
  const nativeTarget = universal ? null : MAC_NATIVE_TARGETS.get(context.arch);
  let exclusions = [];

  if (nativeTarget) {
    const root = path.join(context.packager.info.appDir, 'node_modules', 'better-sqlite3');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (manifest.name !== 'better-sqlite3' || manifest.version !== REVIEWED_SQLITE_VERSION) {
      console.warn(`[better-sqlite3-mac-payload] Keeping unreviewed better-sqlite3 ${manifest.version} payload. Review the exclusions after upgrading.`);
    } else {
      if (manifest.gypfile !== false || manifest.main !== 'lib/index.js') {
        throw new Error('[better-sqlite3-mac-payload] Unexpected SQLite package layout. Review the payload policy.');
      }
      for (const relative of ['lib/index.js', 'lib/binding.js', `prebuilds/${nativeTarget}.node`]) {
        const file = path.join(root, relative);
        if (!fs.existsSync(file) || !fs.statSync(file).isFile() || fs.statSync(file).size === 0) {
          throw new Error(`[better-sqlite3-mac-payload] Missing SQLite runtime file: ${relative}. Reinstall dependencies before packaging.`);
        }
      }
      exclusions = SQLITE_MAC_EXCLUSIONS;
      console.log(`[better-sqlite3-mac-payload] Keeping ${nativeTarget}.node and runtime JavaScript; excluding other prebuilds and SQLite build sources.`);
    }
  }

  const added = new Set(exclusions.filter(pattern => !retained.includes(pattern)));
  if (added.size) {
    // electron-builder normalizes root filters into FileSets. Restore their
    // equivalent string form so platform exclusions join that same matcher.
    // A separate, exclusion-only root matcher implicitly includes **/*.
    const config = context.packager.config;
    if (Array.isArray(config.files)) {
      config.files = config.files.flatMap(fileSet => (
        typeof fileSet !== 'string' && fileSet.from == null && fileSet.to == null && Array.isArray(fileSet.filter)
          ? fileSet.filter : [fileSet]
      ));
    }
  }
  if (added.size || previous?.size) options.files = [...retained, ...added];
  appliedExclusions.set(options, added);
}

module.exports = { configureBetterSqlite3MacPayload };
