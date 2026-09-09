import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

/** Only the application's own default directory may be created implicitly. */
export async function prepareDefaultWorkspace(candidate: string, applicationDefault: string): Promise<{ path: string; name: string }> {
  const requested = path.resolve(candidate);
  if (requested === path.resolve(applicationDefault)) await fs.mkdir(requested, { recursive: true });
  const resolved = await fs.realpath(requested);
  if (!(await fs.stat(resolved)).isDirectory()) throw new Error('Workspace is not a directory');
  await fs.access(resolved, constants.R_OK | constants.W_OK | constants.X_OK);
  return { path: resolved, name: path.basename(resolved) || path.parse(resolved).root };
}
