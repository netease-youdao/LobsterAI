import fs from 'fs';
import path from 'path';
import { expect, test } from 'vitest';

const NSIS_SCRIPT_PATH = path.resolve(process.cwd(), 'scripts/nsis-installer.nsh');
const TASKKILL_COMMAND = `nsExec::ExecToLog 'taskkill /IM "\${APP_EXECUTABLE_FILENAME}" /F /T'`;

function getMacroBody(script: string, macroName: string): string | null {
  const escapedName = macroName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`!macro ${escapedName}\\n([\\s\\S]*?)!macroend`);
  const match = script.match(pattern);
  return match?.[1] ?? null;
}

test('nsis script terminates a running app before both install and uninstall', () => {
  const script = fs.readFileSync(NSIS_SCRIPT_PATH, 'utf8');

  const installInitBody = getMacroBody(script, 'customInit');
  const uninstallInitBody = getMacroBody(script, 'customUnInit');

  expect(installInitBody).toBeTruthy();
  expect(installInitBody).toContain(TASKKILL_COMMAND);

  expect(uninstallInitBody).toBeTruthy();
  expect(uninstallInitBody).toContain(TASKKILL_COMMAND);
});
