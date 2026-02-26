/**
 * Safe recursive copy that bypasses fs.cpSync, which can crash (native-level)
 * when source paths contain non-ASCII characters (e.g. Chinese) on Windows
 * with certain Node.js/Electron versions.
 *
 * Uses fs.readdirSync + fs.copyFileSync as building blocks, which are proven
 * to handle non-ASCII paths correctly via libuv's wide-char API wrappers.
 */
import fs from 'fs';
import path from 'path';

export function cpRecursiveSync(
  src: string,
  dest: string,
  opts: { dereference?: boolean; force?: boolean; errorOnExist?: boolean } = {}
): void {
  const { dereference = false, force = false } = opts;
  const stat = dereference ? fs.statSync(src) : fs.lstatSync(src);

  if (stat.isDirectory()) {
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }
    for (const entry of fs.readdirSync(src)) {
      cpRecursiveSync(path.join(src, entry), path.join(dest, entry), opts);
    }
  } else if (stat.isFile()) {
    if (fs.existsSync(dest) && !force) {
      return;
    }
    const destDir = path.dirname(dest);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    fs.copyFileSync(src, dest);
  } else if (stat.isSymbolicLink()) {
    if (fs.existsSync(dest)) {
      if (!force) return;
      fs.unlinkSync(dest);
    }
    const target = fs.readlinkSync(src);
    fs.symlinkSync(target, dest);
  }
}
