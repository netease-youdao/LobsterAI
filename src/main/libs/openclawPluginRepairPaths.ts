import fs from 'node:fs';
import path from 'node:path';

// Do not infer ownership just from the final directory name: users can link
// arbitrary custom plugin directories with the same name.
const RUNTIME_THIRD_PARTY_EXTENSIONS_DIR = /[/\\](?:resources[/\\]cfmind|vendor[/\\]openclaw-runtime[/\\][^/\\]+)[/\\]third-party-extensions[/\\]*$/i;

/**
 * The third-party extensions directory bundled with a LobsterAI runtime: a
 * packaged app's `resources/cfmind` or a dev checkout's `vendor/openclaw-runtime/<name>`.
 */
export function isRuntimeThirdPartyExtensionsDir(loadPath: string): boolean {
  return RUNTIME_THIRD_PARTY_EXTENSIONS_DIR.test(loadPath);
}

/**
 * Point `plugins.load.paths` entries for a LobsterAI runtime's extensions at
 * `currentDir`, or drop them when this install has none. Profiles are shared
 * between installs (a dev build, a reinstall elsewhere, a moved macOS app), so
 * an inherited entry may name another install's runtime. Other entries, such
 * as user-linked plugin directories, are kept in place.
 */
export function rebaseRuntimeExtensionLoadPaths(paths: readonly unknown[], currentDir: string | null): unknown[] {
  const rebased: unknown[] = [];
  for (const entry of paths) {
    const owned = typeof entry === 'string' && isRuntimeThirdPartyExtensionsDir(entry);
    const next = owned ? currentDir : entry;
    if (owned && next === null) continue;
    if (currentDir !== null && next === currentDir && rebased.includes(next)) continue;
    rebased.push(next);
  }
  return rebased;
}

/** Recognize only the managed layouts used before a profile/state-directory move. */
export function isPreviousManagedPluginPath(options: {
  stateDir: string;
  installPath: string;
  pluginId: string;
  packageName: string;
}): boolean {
  const paths = path.win32.isAbsolute(options.stateDir) && /^[a-z]:/i.test(options.stateDir)
    ? path.win32 : path.posix;
  if (!paths.isAbsolute(options.installPath)) return false;
  if (options.installPath.split(/[\\/]/).some(part => part === '..' || part === '.')) return false;
  const normalize = (value: string) => paths.normalize(value).split(paths.sep).filter(Boolean);
  const current = normalize(options.stateDir);
  const installed = normalize(options.installPath);
  const equal = (left: string, right: string) => paths === path.win32
    ? left.toLowerCase() === right.toLowerCase() : left === right;
  const stateSuffix = current.slice(-3);
  if (stateSuffix.length !== 3 || !equal(stateSuffix[1], 'openclaw') || !equal(stateSuffix[2], 'state')) return false;
  const packageParts = options.packageName.split('/');
  for (let index = 1; index < installed.length - 3; index += 1) {
    if (!stateSuffix.every((part, offset) => equal(part, installed[index + offset] ?? ''))) continue;
    const relative = installed.slice(index + 3);
    const expected = [
      ['extensions', options.pluginId],
      ['npm', 'node_modules', ...packageParts],
      ['npm', 'projects', relative[2], 'node_modules', ...packageParts],
    ];
    return expected.some(parts => parts.length === relative.length
      && parts.every((part, offset) => equal(part, relative[offset])));
  }
  return false;
}

function isSameOrAncestorPath(directory: string, target: string): boolean {
  const relative = path.relative(directory, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * Probe without following links; permission errors are not evidence of a missing install.
 * The active state directory and its ancestors are not probed: the running profile
 * already resolves through any link there, such as macOS /var or a relocated AppData.
 */
export function isMissingUnaliasedPluginPath(installPath: string, activeStateDir?: string): boolean {
  const resolved = path.resolve(installPath);
  const trustedRoot = activeStateDir ? path.resolve(activeStateDir) : undefined;
  let current = path.parse(resolved).root;
  for (const part of resolved.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    if (trustedRoot && isSameOrAncestorPath(current, trustedRoot)) continue;
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw error;
    }
  }
  return false;
}
