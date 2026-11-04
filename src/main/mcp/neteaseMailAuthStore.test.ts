import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { NeteaseMailAuthStoreOperation, NeteaseMailFailure } from '../../shared/neteaseMail/constants';
import { createNeteaseMailAuthStore, prepareNeteaseMailAuthStore } from './neteaseMailAuthStore';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn }));
const context = { runtimeRoot: '/test/runtime', stateDir: '/test/profile/state', electronNodeRuntimePath: '/test/electron' };
let child: EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };
let input: string;
beforeEach(() => {
  input = '';
  child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
  child.stdin.on('data', chunk => { input += chunk.toString(); });
  spawn.mockReset().mockReturnValue(child);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

test('initialization uses the isolated worker and waits for its successful completion', async () => {
  const pending = createNeteaseMailAuthStore(context).initialize();
  expect(JSON.parse(input)).toEqual({ operation: NeteaseMailAuthStoreOperation.Initialize });
  expect(spawn.mock.calls[0][2]).toMatchObject({ windowsHide: true, env: {
    ELECTRON_RUN_AS_NODE: '1', OPENCLAW_STATE_DIR: context.stateDir, OPENCLAW_AGENT_DIR: '',
  } });
  child.stdout.write('NETEASE_MAIL_STATUS:{"connected":false}\n');
  child.emit('close', 0);
  await expect(pending).resolves.toBeUndefined();
});

test('a failed initialization is surfaced without forwarding worker diagnostics', async () => {
  const pending = createNeteaseMailAuthStore(context).initialize();
  child.stderr.write('private credential detail');
  child.emit('close', 1);
  await expect(pending).rejects.toMatchObject({ code: NeteaseMailFailure.StorageFailed });
});

test('unconfigured or uninstalled mail integration does not add a startup worker', async () => {
  vi.stubEnv('LOBSTER_NETEASE_MAIL_CLIENT_ID', '');
  await prepareNeteaseMailAuthStore(context, false);
  vi.stubEnv('LOBSTER_NETEASE_MAIL_CLIENT_ID', 'test-client');
  vi.spyOn(fs, 'existsSync').mockReturnValue(false);
  await prepareNeteaseMailAuthStore(context, false);
  expect(spawn).not.toHaveBeenCalled();
});
