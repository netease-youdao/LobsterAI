/**
 * Windows Explorer context-menu integration.
 *
 * Registers / unregisters a "Open with LobsterAI" entry under
 *   HKCU\Software\Classes\Directory\shell\LobsterAI
 * (current-user hive — no admin privileges required).
 *
 * The entry passes the selected folder path via the
 *   --open-directory=<path>
 * command-line argument so that main.ts can pick it up on startup
 * or via the second-instance event.
 */

import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Registry key root (current-user, no elevation required). */
const REG_BASE = 'HKCU\\Software\\Classes\\Directory\\shell\\LobsterAI';
const REG_COMMAND = `${REG_BASE}\\command`;

/**
 * Run `reg.exe` with the given arguments.
 * Throws on non-zero exit code.
 */
async function reg(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('reg', args, {
    windowsHide: true,
    encoding: 'utf8',
  });
  return stdout;
}

/**
 * Register the Windows Explorer right-click menu entry.
 *
 * @param exePath  Absolute path to the application executable.
 * @param menuLabel  Display text shown in the context menu.
 */
export async function registerContextMenu(exePath: string, menuLabel: string): Promise<void> {
  // Normalise slashes — Windows registry expects backslashes in icon path
  const exeNorm = path.normalize(exePath);

  // Create the shell key with display name
  await reg('add', REG_BASE, '/ve', '/d', menuLabel, '/f');

  // Set icon to the exe itself (first icon resource)
  await reg('add', REG_BASE, '/v', 'Icon', '/d', `"${exeNorm}"`, '/f');

  // Set the command: exe --open-directory="%V"
  // %V is the selected folder path provided by Explorer.
  const command = `"${exeNorm}" --open-directory="%V"`;
  await reg('add', REG_COMMAND, '/ve', '/d', command, '/f');
}

/**
 * Remove the Windows Explorer right-click menu entry.
 * Silently succeeds if the key does not exist.
 */
export async function unregisterContextMenu(): Promise<void> {
  try {
    await reg('delete', REG_BASE, '/f');
  } catch {
    // Key may not exist — treat as success.
  }
}

/**
 * Return true if the context-menu entry currently exists in the registry.
 */
export async function isContextMenuRegistered(): Promise<boolean> {
  try {
    await reg('query', REG_COMMAND, '/ve');
    return true;
  } catch {
    return false;
  }
}
