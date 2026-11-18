import { execFile } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { extractIcon } from '../shellApps';
import { getCompanionSelectionApps } from './selectionApps';

vi.mock('../shellApps', () => ({ extractIcon: vi.fn() }));
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  const run = vi.fn();
  Object.assign(run, { [promisify.custom]: run });
  return { execFile: run };
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  vi.mocked(extractIcon).mockResolvedValue('data:image/png;base64,icon');
});
afterEach(() => vi.restoreAllMocks());

describe('selection excluded app details', () => {
  test('resolves display names and icons and keeps missing apps removable', async () => {
    vi.mocked(execFile).mockResolvedValue({ stdout: JSON.stringify([
      { id: 'com.openai.codex', name: 'Codex', path: '/Applications/Codex.app' },
      { id: 'com.deleted.writer' },
    ]) } as never);
    expect(await getCompanionSelectionApps(['com.openai.codex', 'com.deleted.writer', 'com.openai.codex'])).toEqual([
      { id: 'com.openai.codex', name: 'Codex', icon: 'data:image/png;base64,icon' },
      { id: 'com.deleted.writer', name: 'Writer' },
    ]);
    expect(extractIcon).toHaveBeenCalledWith({ name: 'Codex', path: '/Applications/Codex.app', isDefault: false });
    expect(vi.mocked(execFile).mock.calls[0][1]?.at(-1)).toBe(JSON.stringify(['com.openai.codex', 'com.deleted.writer']));
  });

  test('metadata and icon errors do not prevent removing an exclusion', async () => {
    vi.mocked(execFile).mockResolvedValue({ stdout: '[{"id":"com.openai.codex","name":"Codex","path":"/removed.app"}]' } as never);
    vi.mocked(extractIcon).mockRejectedValue(new Error('file removed'));
    expect(await getCompanionSelectionApps(['com.openai.codex'])).toEqual([{ id: 'com.openai.codex', name: 'Codex' }]);
    vi.mocked(execFile).mockResolvedValue({ stdout: 'invalid-json' } as never);
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    expect(await getCompanionSelectionApps(['com.openai.codex'])).toEqual([{ id: 'com.openai.codex', name: 'Codex' }]);
  });

  test('passes Windows identifiers as data and handles a single app result', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.mocked(execFile).mockResolvedValue({ stdout: '\uFEFF[{"id":"Code.exe","name":"Visual Studio Code","path":"C:\\\\Code.exe"}]' } as never);
    const result = await getCompanionSelectionApps(['Code.exe']);
    expect(result[0]).toMatchObject({ id: 'Code.exe', name: 'Visual Studio Code' });
    const [command, args, options] = vi.mocked(execFile).mock.calls[0];
    expect(command).toBe('powershell.exe');
    expect(args?.join(' ')).toContain('HKCU:\\Software\\Microsoft');
    expect(args?.join(' ')).not.toContain('Code.exe');
    expect((options as { env: NodeJS.ProcessEnv }).env.LOBSTER_SELECTION_APP_IDS).toBe(Buffer.from('["Code.exe"]').toString('base64'));
  });

  test('empty lists and unsupported platforms need no OS queries', async () => {
    expect(await getCompanionSelectionApps([])).toEqual([]);
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    expect(await getCompanionSelectionApps(['writer.exe'])).toEqual([{ id: 'writer.exe', name: 'Writer' }]);
    expect(execFile).not.toHaveBeenCalled();
  });
});
