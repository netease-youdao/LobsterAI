import fs from 'node:fs';
import path from 'node:path';

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

/** Probe without following links; permission errors are not evidence of a missing install. */
export function isMissingUnaliasedPluginPath(installPath: string): boolean {
  const resolved = path.resolve(installPath);
  let current = path.parse(resolved).root;
  for (const part of resolved.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
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
