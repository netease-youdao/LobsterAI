import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { OPENCLAW_DESKTOP_GATEWAY_CAPS } from '../../../shared/cowork/approval';
import type { ApprovalPersistence } from './approvalDecisionService';
import { describeExecApproval, describePluginApproval } from './openclawApprovalAdapters';
import { parseApprovalResolvedPayload, parseExecApprovalRequestedPayload } from './openclawApprovalBridge';
import { OpenClawApprovalController } from './openclawApprovalController';
const dirs: string[] = []; const controllers: OpenClawApprovalController[] = [];
afterEach(() => { for (const c of controllers.splice(0)) c.dispose(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); vi.useRealTimers(); });
const pluginRequest = { pluginId: 'codex', title: 'Codex app-server network approval', description: 'Network: https://example.com', severity: 'warning',
  toolName: 'codex_network_approval', toolCallId: 'tool-1', allowedDecisions: ['allow-once', 'deny'], sessionKey: 'agent:main:desktop:s', agentId: 'main' };
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-adapter-')); dirs.push(dir);
  const data = new Map<string, unknown>();
  const storage: ApprovalPersistence = { get: <T>(key: string) => data.has(key) ? structuredClone(data.get(key)) as T : null,
    put: (key, value) => { data.set(key, structuredClone(value)); }, entries: <T>(prefix: string) => [...data].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) as T })),
    transaction: fn => fn() };
  const request = vi.fn(); const emitRequest = vi.fn(); const emitResolved = vi.fn(); const emitState = vi.fn();
  const controller = new OpenClawApprovalController({ persistence: storage, getBinding: () => ({ runId: 'run', identity: { owner: null, agent: 'main' } }),
    getWorkspace: () => ({ cwd: dir, name: '测试工作区' }), getGatewayClient: () => ({ request }), resolveSessionId: () => 's',
    isSessionActive: () => false, sessionExists: () => true, isSessionInStopCooldown: () => false, isManualStopSuppressed: () => false,
    continueSession: vi.fn(async () => {}), emitPermissionRequest: emitRequest, emitPermissionResolved: emitResolved,
    emitPermissionState: emitState, emitError: vi.fn() }); controllers.push(controller);
  controller.setGatewayContract({ version: '2026.8.1', bootId: 'boot', methods: ['approval.get', 'approval.resolve', 'exec.approval.list', 'plugin.approval.list'] });
  controller.configureDualApproval({ enabled: true, projectionSupported: true });
  const payload = (kind: 'exec' | 'plugin') => ({ id: kind === 'plugin' ? 'plugin:11111111-1111-4111-8111-111111111111' : '11111111-1111-4111-8111-111111111111',
    request: kind === 'plugin' ? pluginRequest : { command: 'rm -rf -- report.txt', cwd: dir, sessionKey: 'agent:main:desktop:s' }, createdAtMs: Date.now() - 100, expiresAtMs: Date.now() + 60000 });
  return { controller, request, emitRequest, emitResolved, emitState, payload, dir };
}
describe('pinned OpenClaw approval producers', () => {
  it('advertises tool events and an approval recipient on the desktop Gateway connection', () => {
    expect(OPENCLAW_DESKTOP_GATEWAY_CAPS).toContain('tool-events');
    expect(OPENCLAW_DESKTOP_GATEWAY_CAPS).toContain('approvals');
  });
  it('preserves the real expiration and exact resolved decision', () => {
    expect(parseExecApprovalRequestedPayload({ id: 'p', request: { command: 'rm a', sessionKey: 's' }, createdAtMs: 50, expiresAtMs: 80 })).toMatchObject({ createdAtMs: 50, expiresAtMs: 80 });
    expect(parseApprovalResolvedPayload({ id: 'p', decision: 'deny', ts: 70, request: { command: 'rm a' } })).toMatchObject({ requestId: 'p', decision: 'deny', ts: 70 });
  });
  it.each(['exec', 'plugin'] as const)('routes a real %s producer through the public projection and unified applied ACK', async kind => {
    const f = fixture(); const p = f.payload(kind);
    f.request.mockResolvedValue({ applied: true, approval: { id: p.id, createdAtMs: p.createdAtMs, expiresAtMs: p.expiresAtMs,
      presentation: { kind }, status: 'allowed', decision: 'allow-once', resolvedAtMs: Date.now(), source: { sessionKey: p.request.sessionKey } } });
    if (kind === 'exec') f.controller.handleExecApprovalRequested(p); else f.controller.handlePluginApprovalRequested(p);
    const state = f.controller.getPermissionState(p.id)!;
    expect(state.remoteAllowed).toBe(true); expect(state.expiresAt).toBe(new Date(p.expiresAtMs).toISOString());
    const result = await f.controller.respondToPermissionConfirmed(p.id, { behavior: 'allow' }, { submissionId: 'mobile-1', source: 'mobile',
      expectedVersion: state.approvalVersion, operationDigest: state.operationDigest, beforeDispatch: () => {} });
    expect(result.kind).toBe('confirmed');
    expect(f.request).toHaveBeenCalledWith('approval.resolve', { id: p.id, kind, decision: 'allow-once' }, { timeoutMs: 5000 });
    expect(f.emitResolved).toHaveBeenCalledExactlyOnceWith('s', p.id);
  });
  it('automatic exec policy does not also create a manual pending request', async () => {
    const f = fixture(); const p = f.payload('exec'); p.request.command = 'pwd';
    f.request.mockResolvedValue({ applied: true, approval: { id: p.id, createdAtMs: p.createdAtMs, expiresAtMs: p.expiresAtMs, presentation: { kind: 'exec' },
      status: 'allowed', decision: 'allow-always', resolvedAtMs: Date.now(), source: { sessionKey: p.request.sessionKey } } });
    f.controller.handleExecApprovalRequested(p);
    await Promise.resolve(); await Promise.resolve();
    expect(f.emitRequest).not.toHaveBeenCalled();
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.controller.getPermissionState(p.id)?.status).toBe('approved');
  });
  it('rejects arbitrary remoteSafe hints, truncated descriptions and unknown plugins', () => {
    expect(describePluginApproval({ ...pluginRequest, pluginId: 'random', remoteSafe: true, publicSummary: 'Safe' }).remoteSafe).toBe(false);
    expect(describePluginApproval({ ...pluginRequest, description: 'Network: https://example.com...' }).remoteSafe).toBe(false);
    expect(describePluginApproval({ ...pluginRequest, description: 'Network: https://example.com\nCommand: curl secret' }).remoteSafe).toBe(false);
    expect(describePluginApproval({ ...pluginRequest, allowedDecisions: ['allow-always', 'deny'] }).remoteSafe).toBe(false);
  });
  it('keeps complex shell and symlink escape deletions local', () => {
    const f = fixture(); const workspace = { cwd: f.dir, name: '工作区' };
    for (const command of ['rm $(cat targets)', 'rm *.txt', 'rm ../secret', 'rm .', 'rm a; echo b', 'sh script.sh', 'rm "a b"']) {
      expect(describeExecApproval({ command, cwd: f.dir }, workspace).remoteSafe).toBe(false);
    }
    fs.symlinkSync(os.tmpdir(), path.join(f.dir, 'escape'));
    expect(describeExecApproval({ command: 'rm escape/secret', cwd: f.dir }, workspace).remoteSafe).toBe(false);
    expect(describeExecApproval({ command: 'rm a', cwd: f.dir, env: { API_KEY: 'secret' } }, workspace).remoteSafe).toBe(false);
  });
  it('missing gateway deadline remains local without inventing a timeout', () => {
    const f = fixture(); const p = f.payload('plugin');
    f.controller.handlePluginApprovalRequested({ id: p.id, request: p.request });
    expect(f.controller.getPermissionState(p.id)).toMatchObject({ expiresAt: null, remoteAllowed: false });
  });
});
