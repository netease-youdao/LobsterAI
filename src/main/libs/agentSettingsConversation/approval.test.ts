import { describe, expect, test } from 'vitest';

import { registerSettingsApproval, settingsApprovalDigest, settingsChangePreview, trustedSettingsApproval } from './approval';

describe('settings approval proof', () => {
  test('rejects plugin claims without a host-prepared operation and binds exact displayed content', () => {
    const request = { pluginId: 'lobster-agent-settings', toolName: 'lobsterai_agent_settings', sessionKey: 'agent:main:lobsterai:s', toolCallId: 't', agentId: 'main', title: 'Review', description: 'exact', allowedDecisions: ['allow-once', 'deny'] };
    expect(trustedSettingsApproval(request)).toBeNull();
    let current = true;
    const remove = registerSettingsApproval({ ...request, digest: 'a'.repeat(64), isCurrent: () => current });
    try {
      expect(trustedSettingsApproval(request)?.digest).toBe('a'.repeat(64));
      expect(trustedSettingsApproval({ ...request, description: 'different' })).toBeNull();
      expect(trustedSettingsApproval({ ...request, allowedDecisions: ['allow-always', 'deny'] })).toBeNull();
      current = false;
      expect(trustedSettingsApproval(request)).toBeNull();
    } finally { remove(); }
    expect(trustedSettingsApproval(request)).toBeNull();
  });
  test('preview shows the real removed and inserted content without truncation', () => {
    expect(settingsChangePreview('name: Alice\nkeep', 'name: Bob\nkeep')).toBe('− "Alice"\n+ "Bob"');
    expect(() => settingsChangePreview('x'.repeat(2000), '')).toThrow('LOCAL_ACTION_REQUIRED');
  });
  test('digest changes when source or revision changes', () => {
    const intent = { operationId: 'op', commandId: 'cmd', runId: 'run', toolCallId: 'tool', agentId: 'main', section: 'memory', expectedRevision: 'r1', proposedDigest: 'a'.repeat(64), changeKind: 'append', bindingId: 'b', bindingVersion: '1', accountEpoch: '1', dataSpaceId: 'space', dataGeneration: '1', deviceId: 'pc' };
    expect(settingsApprovalDigest(intent)).not.toBe(settingsApprovalDigest({ ...intent, commandId: 'other' }));
    expect(settingsApprovalDigest(intent)).not.toBe(settingsApprovalDigest({ ...intent, expectedRevision: 'r2' }));
  });
});
