import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { readMailAuthorization } from '../../../openclaw-extensions/netease-mail/authorization';
import { NeteaseMailDefaultScopes, NeteaseMailScope, NeteaseMailTool } from '../../shared/neteaseMail/constants';
import { getNeteaseMailNativeTools, getNeteaseMailRequestedScopes, getNeteaseMailScopes } from '../../shared/neteaseMail/scopes';
import { clearNeteaseMailAuthorization, readNeteaseMailAuthorization, saveNeteaseMailAuthorization } from './neteaseMailAuthorizationState';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

test('desktop metadata is readable by the deployed plugin and invalidated on disconnect', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-grant-'));
  directories.push(dir);
  saveNeteaseMailAuthorization(dir, { clientId: 'client', authorizationId: 'first', scope: NeteaseMailDefaultScopes.join(' ') });
  expect(readMailAuthorization(dir, 'client')).toEqual(readNeteaseMailAuthorization(dir, 'client'));
  expect(readMailAuthorization(dir, 'another-client')).toBeUndefined();
  saveNeteaseMailAuthorization(dir, { clientId: 'client', authorizationId: 'second', scope: NeteaseMailScope.Read });
  expect(readMailAuthorization(dir, 'client')).toMatchObject({ id: 'second', scopes: [NeteaseMailScope.Read] });
  clearNeteaseMailAuthorization(dir);
  expect(readMailAuthorization(dir, 'client')).toBeUndefined();
});

test('legacy credentials stay read-only, deletion is opt-in and raw protected tools are never exposed', () => {
  expect(getNeteaseMailScopes()).toEqual([NeteaseMailScope.Read]);
  expect(getNeteaseMailRequestedScopes()).not.toContain(NeteaseMailScope.Delete);
  expect(getNeteaseMailRequestedScopes(true)).toContain(NeteaseMailScope.Delete);
  const tools = getNeteaseMailNativeTools(Object.values(NeteaseMailScope));
  expect(tools).toContain(NeteaseMailTool.CreateDraft);
  expect(tools).toContain(NeteaseMailTool.UpdateDraft);
  for (const tool of [NeteaseMailTool.SendMessage, NeteaseMailTool.ReplyMessage, NeteaseMailTool.ForwardMessage, NeteaseMailTool.TrashMessage]) expect(tools).not.toContain(tool);
});
