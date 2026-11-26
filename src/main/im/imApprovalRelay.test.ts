import { EventEmitter } from 'events';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  DSH_APPROVAL_REQUEST_ID_PREFIX,
  DSH_QUESTION_REQUEST_ID_PREFIX,
  DshApprovalPermissionAction,
} from '../../shared/dshEngine/hostConstants';
import { setLanguage } from '../i18n';
import type { PermissionRequest, PermissionResult } from '../libs/agentEngine/types';
import {
  DEFAULT_IM_APPROVAL_TIMEOUT_MS,
  formatImApprovalActionSummary,
  formatImApprovalPrompt,
  ImApprovalDecision,
  ImApprovalRelay,
  parseImApprovalReply,
} from './imApprovalRelay';

class FakeRelayRuntime extends EventEmitter {
  respondToPermission = vi.fn(async (requestId: string, _result: PermissionResult) => {
    this.emit('permissionResolved', 'session-1', requestId);
  });
}

afterEach(() => {
  setLanguage('zh');
  vi.useRealTimers();
});

describe('imApprovalRelay helpers', () => {
  test('parses Chinese and English approval replies', () => {
    expect(parseImApprovalReply('1')).toBe(ImApprovalDecision.AllowOnce);
    expect(parseImApprovalReply('同意！')).toBe(ImApprovalDecision.AllowOnce);
    expect(parseImApprovalReply(' 允许 ')).toBe(ImApprovalDecision.AllowOnce);
    expect(parseImApprovalReply('Yes.')).toBe(ImApprovalDecision.AllowOnce);
    expect(parseImApprovalReply('2')).toBe(ImApprovalDecision.AllowSession);
    expect(parseImApprovalReply('总是允许')).toBe(ImApprovalDecision.AllowSession);
    expect(parseImApprovalReply('always')).toBe(ImApprovalDecision.AllowSession);
    expect(parseImApprovalReply('0')).toBe(ImApprovalDecision.Deny);
    expect(parseImApprovalReply('拒绝')).toBe(ImApprovalDecision.Deny);
    expect(parseImApprovalReply('no!')).toBe(ImApprovalDecision.Deny);
    expect(parseImApprovalReply('取消')).toBe(ImApprovalDecision.Deny);
    expect(parseImApprovalReply('今天天气怎么样')).toBeNull();
    expect(parseImApprovalReply('')).toBeNull();
  });

  test('formats concise mobile approval prompts', () => {
    const req: PermissionRequest = {
      requestId: `${DSH_APPROVAL_REQUEST_ID_PREFIX}1`,
      toolName: 'bash',
      toolInput: {
        command: 'rm -rf ./tmp-cache',
        reason: 'Destructive command requires confirmation (file-delete)',
      },
    };
    const summary = formatImApprovalActionSummary(req);
    expect(summary.action).toBe('bash: rm -rf ./tmp-cache');
    expect(summary.reason).toContain('file-delete');

    const prompt = formatImApprovalPrompt(req, DEFAULT_IM_APPROVAL_TIMEOUT_MS);
    expect(DEFAULT_IM_APPROVAL_TIMEOUT_MS).toBe(300_000);
    expect(prompt).toContain('bash: rm -rf ./tmp-cache');
    expect(prompt).toContain('300');
    expect(prompt).toContain('1 或 同意');
  });
});

describe('ImApprovalRelay', () => {
  test('relays approval to IM and resolves allow-once, allow-session, and deny replies', async () => {
    const runtime = new FakeRelayRuntime();
    const sendReply = vi.fn(async () => ({ delivered: true }));
    const relay = new ImApprovalRelay({ runtime, sendReply, timeoutMs: 60_000 });

    const queueKey = 'weixin:default:o9cq@im.wechat:main';
    relay.registerActiveRoute({
      sessionId: 'session-1',
      queueKey,
      platform: 'weixin',
      instanceId: 'default',
      chatId: 'o9cq@im.wechat',
      chatType: 'direct',
      requesterSenderId: 'o9cq@im.wechat',
      replyContext: { contextToken: 'ctx-1' },
    });

    const req1: PermissionRequest = {
      requestId: `${DSH_APPROVAL_REQUEST_ID_PREFIX}10`,
      toolName: 'bash',
      toolInput: { command: 'git push', approvalScopeKey: 'shell:git-push' },
    };
    runtime.emit('permissionRequest', 'session-1', req1);

    expect(relay.hasPendingApproval(queueKey)).toBe(true);
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'weixin',
      chatId: 'o9cq@im.wechat',
      replyContext: { contextToken: 'ctx-1' },
    }));

    // Unrecognized reply sends a reminder and keeps approval pending.
    const invalidResult = await relay.tryHandleInboundReply(queueKey, {
      text: '等一下',
      senderId: 'o9cq@im.wechat',
      replyContext: { contextToken: 'ctx-2' },
    });
    expect(invalidResult.handled).toBe(true);
    expect(invalidResult.decision).toBeUndefined();
    expect(invalidResult.updatedReplyContext).toEqual({ contextToken: 'ctx-2' });
    expect(relay.hasPendingApproval(queueKey)).toBe(true);
    expect(runtime.respondToPermission).not.toHaveBeenCalled();

    // Valid allow-session reply resolves with AllowSession scope and refreshed contextToken.
    const allowSessionResult = await relay.tryHandleInboundReply(queueKey, {
      text: '2',
      senderId: 'o9cq@im.wechat',
      replyContext: { contextToken: 'ctx-3' },
    });
    expect(allowSessionResult.handled).toBe(true);
    expect(allowSessionResult.decision).toBe(ImApprovalDecision.AllowSession);
    expect(allowSessionResult.updatedReplyContext).toEqual({ contextToken: 'ctx-3' });
    expect(relay.hasPendingApproval(queueKey)).toBe(false);
    expect(runtime.respondToPermission).toHaveBeenCalledWith(
      `${DSH_APPROVAL_REQUEST_ID_PREFIX}10`,
      {
        behavior: 'allow',
        updatedPermissions: [
          {
            type: DshApprovalPermissionAction.AllowSession,
            scope: 'shell:git-push',
          },
        ],
      },
    );

    // Second approval in the same turn uses refreshed ctx-3 and handles deny.
    const req2: PermissionRequest = {
      requestId: `${DSH_APPROVAL_REQUEST_ID_PREFIX}11`,
      toolName: 'write_file',
      toolInput: { filePath: '/etc/hosts' },
    };
    runtime.emit('permissionRequest', 'session-1', req2);
    expect(sendReply).toHaveBeenLastCalledWith(expect.objectContaining({
      replyContext: { contextToken: 'ctx-3' },
    }));

    const denyResult = await relay.tryHandleInboundReply(queueKey, {
      text: '拒绝',
      senderId: 'o9cq@im.wechat',
      replyContext: { contextToken: 'ctx-4' },
    });
    expect(denyResult.decision).toBe(ImApprovalDecision.Deny);
    expect(runtime.respondToPermission).toHaveBeenLastCalledWith(
      `${DSH_APPROVAL_REQUEST_ID_PREFIX}11`,
      expect.objectContaining({ behavior: 'deny' }),
    );

    relay.dispose();
  });

  test('notifies IM when resolved on desktop and auto-denies on timeout', async () => {
    vi.useFakeTimers();
    const runtime = new FakeRelayRuntime();
    const sendReply = vi.fn(async () => ({ delivered: true }));
    const relay = new ImApprovalRelay({ runtime, sendReply, timeoutMs: 5_000 });

    const queueKey = 'weixin:default:o9cq@im.wechat:main';
    relay.registerActiveRoute({
      sessionId: 'session-1',
      queueKey,
      platform: 'weixin',
      instanceId: 'default',
      chatId: 'o9cq@im.wechat',
      chatType: 'direct',
    });

    // 1. Resolved externally on desktop
    runtime.emit('permissionRequest', 'session-1', {
      requestId: `${DSH_APPROVAL_REQUEST_ID_PREFIX}20`,
      toolName: 'bash',
      toolInput: { command: 'rm foo.txt' },
    });
    expect(relay.hasPendingApproval(queueKey)).toBe(true);
    runtime.emit('permissionResolved', 'session-1', `${DSH_APPROVAL_REQUEST_ID_PREFIX}20`);
    expect(relay.hasPendingApproval(queueKey)).toBe(false);
    expect(sendReply).toHaveBeenLastCalledWith(expect.objectContaining({
      text: 'ℹ️ 该操作已在电脑端处理。',
    }));

    // 2. Unanswered approval times out fail-closed
    runtime.emit('permissionRequest', 'session-1', {
      requestId: `${DSH_APPROVAL_REQUEST_ID_PREFIX}21`,
      toolName: 'bash',
      toolInput: { command: 'rm bar.txt' },
    });
    vi.advanceTimersByTime(5_000);
    expect(relay.hasPendingApproval(queueKey)).toBe(false);
    expect(runtime.respondToPermission).toHaveBeenCalledWith(
      `${DSH_APPROVAL_REQUEST_ID_PREFIX}21`,
      expect.objectContaining({ behavior: 'deny' }),
    );
    expect(sendReply).toHaveBeenLastCalledWith(expect.objectContaining({
      text: '⏱️ 确认已超时，本次操作已自动拒绝。',
    }));

    relay.dispose();
  });

  test('ignores question requests and rejects unauthorized group senders', async () => {
    const runtime = new FakeRelayRuntime();
    const sendReply = vi.fn(async () => ({ delivered: true }));
    const relay = new ImApprovalRelay({ runtime, sendReply, timeoutMs: 30_000 });

    const queueKey = 'feishu:bot-1:oc_group:main';
    relay.registerActiveRoute({
      sessionId: 'session-1',
      queueKey,
      platform: 'feishu',
      instanceId: 'bot-1',
      chatId: 'oc_group',
      chatType: 'group',
      requesterSenderId: 'ou_alice',
    });

    // Question requests are not relayed as binary approvals.
    runtime.emit('permissionRequest', 'session-1', {
      requestId: `${DSH_QUESTION_REQUEST_ID_PREFIX}1`,
      toolName: 'AskUserQuestion',
      toolInput: {},
    });
    expect(relay.hasPendingApproval(queueKey)).toBe(false);
    expect(sendReply).not.toHaveBeenCalled();

    runtime.emit('permissionRequest', 'session-1', {
      requestId: `${DSH_APPROVAL_REQUEST_ID_PREFIX}30`,
      toolName: 'bash',
      toolInput: { command: 'rm file.txt' },
    });
    expect(relay.hasPendingApproval(queueKey)).toBe(true);

    // Another group member cannot approve Alice's request.
    const bobResult = await relay.tryHandleInboundReply(queueKey, {
      text: '1',
      senderId: 'ou_bob',
      chatType: 'group',
    });
    expect(bobResult).toEqual({ handled: false, ignoredUnauthorizedSender: true });
    expect(relay.hasPendingApproval(queueKey)).toBe(true);
    expect(runtime.respondToPermission).not.toHaveBeenCalled();

    // Alice approves her own request.
    const aliceResult = await relay.tryHandleInboundReply(queueKey, {
      text: '同意',
      senderId: 'ou_alice',
      chatType: 'group',
    });
    expect(aliceResult.handled).toBe(true);
    expect(aliceResult.decision).toBe(ImApprovalDecision.AllowOnce);
    expect(runtime.respondToPermission).toHaveBeenCalledWith(
      `${DSH_APPROVAL_REQUEST_ID_PREFIX}30`,
      { behavior: 'allow' },
    );

    relay.dispose();
  });
});
