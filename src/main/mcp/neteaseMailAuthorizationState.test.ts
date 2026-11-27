import { expect, test } from 'vitest';

import { NeteaseMailScope, NeteaseMailTool } from '../../shared/neteaseMail/constants';
import { getNeteaseMailNativeTools, getNeteaseMailRequestedScopes, getNeteaseMailScopes } from '../../shared/neteaseMail/scopes';

test('legacy credentials stay read-only, deletion is opt-in and raw protected tools are never exposed', () => {
  expect(getNeteaseMailScopes()).toEqual([NeteaseMailScope.Read]);
  expect(getNeteaseMailRequestedScopes()).not.toContain(NeteaseMailScope.Delete);
  expect(getNeteaseMailRequestedScopes(true)).toContain(NeteaseMailScope.Delete);
  const tools = getNeteaseMailNativeTools(Object.values(NeteaseMailScope));
  expect(tools).toContain(NeteaseMailTool.CreateDraft);
  expect(tools).toContain(NeteaseMailTool.UpdateDraft);
  expect(tools).toContain(NeteaseMailTool.UpdateMessageReadState);
  expect(tools).toContain(NeteaseMailTool.UpdateMessageFlagState);
  expect(tools).toHaveLength(12);
  for (const tool of [NeteaseMailTool.SendMessage, NeteaseMailTool.ReplyMessage, NeteaseMailTool.ForwardMessage, NeteaseMailTool.TrashMessage]) expect(tools).not.toContain(tool);
});

test('message read and flag updates require compose access, independent of read/send/delete access', () => {
  const updates = [NeteaseMailTool.UpdateMessageReadState, NeteaseMailTool.UpdateMessageFlagState];
  expect(getNeteaseMailNativeTools([NeteaseMailScope.Compose])).toEqual(expect.arrayContaining(updates));
  for (const scopes of [[], [NeteaseMailScope.Read], [NeteaseMailScope.Send, NeteaseMailScope.Delete]]) {
    for (const tool of updates) expect(getNeteaseMailNativeTools(scopes)).not.toContain(tool);
  }
});
