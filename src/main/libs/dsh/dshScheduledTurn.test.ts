import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  DeliveryMode,
  PayloadKind,
  RunDeliveryStatus,
  SessionTarget,
  WakeMode,
} from '../../../scheduledTask/constants';
import type { ScheduledTask } from '../../../scheduledTask/types';
import {
  deliverScheduledTaskWebhook,
  executeDshScheduledTask,
  runScheduledTurn,
} from './dshScheduledTurn';

class Runtime extends EventEmitter {
  startSession = vi.fn().mockResolvedValue(undefined);
  stopSession = vi.fn((sessionId: string) => {
    this.emit('sessionStopped', sessionId);
  });
}

const activeServers: http.Server[] = [];

async function startLocalServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<string> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      handler(req, res, Buffer.concat(chunks).toString('utf8'));
    });
  });
  activeServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  while (activeServers.length > 0) {
    const server = activeServers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('the schedule stop button cancels the exact submitted turn and removes both sets of listeners', async () => {
  const runtime = new Runtime();
  const abort = new AbortController();
  const result = runScheduledTurn(runtime, 'scheduled', 'main', 'Summary', abort.signal);
  runtime.emit('complete', 'unrelated');
  abort.abort();
  await expect(result).resolves.toBe(true);
  expect(runtime.stopSession.mock.calls).toEqual([['scheduled']]);
  expect(runtime.eventNames()).toEqual([]);
  await expect(runScheduledTurn(runtime, 'early', 'main', 'Never submit', abort.signal)).resolves.toBe(true);
  expect(runtime.startSession).toHaveBeenCalledOnce();
});

test('chat-side stop closes its run without waiting for a completion event', async () => {
  const runtime = new Runtime();
  const abort = new AbortController();
  const result = runScheduledTurn(runtime, 'scheduled', 'main', 'Summary', abort.signal);
  runtime.emit('sessionStopped', 'scheduled');
  await expect(result).resolves.toBe(true);
  abort.abort();
  expect(runtime.stopSession).not.toHaveBeenCalled();
  expect(runtime.eventNames()).toEqual([]);
});

test('normal completion and errors keep their existing outcomes', async () => {
  const runtime = new Runtime();
  const signal = new AbortController().signal;
  const completed = runScheduledTurn(runtime, 'ok', 'main', 'Summary', signal);
  runtime.emit('complete', 'ok');
  await expect(completed).resolves.toBe(false);
  const failed = runScheduledTurn(runtime, 'bad', 'main', 'Summary', signal);
  runtime.emit('error', 'bad', 'Gateway disconnected');
  await expect(failed).rejects.toThrow('Gateway disconnected');
  expect(runtime.eventNames()).toEqual([]);
});

test('timeoutSeconds cancels a hung turn via stopSession and rejects with a timeout error', async () => {
  const runtime = new Runtime();
  const signal = new AbortController().signal;
  const result = runScheduledTurn(runtime, 'hung-session', 'main', 'Hang forever', signal, {
    timeoutSeconds: 0.05,
  });

  await expect(result).rejects.toThrow(/timed out after 0\.05s/);
  expect(runtime.stopSession).toHaveBeenCalledWith('hung-session');
  expect(runtime.eventNames()).toEqual([]);
});

describe('deliverScheduledTaskWebhook', () => {
  test('POSTs JSON payload to a real local HTTP server and succeeds on 2xx', async () => {
    let receivedMethod = '';
    let receivedContentType = '';
    let receivedBody: Record<string, unknown> | null = null;
    const baseUrl = await startLocalServer((req, res, body) => {
      receivedMethod = req.method ?? '';
      receivedContentType = String(req.headers['content-type'] ?? '');
      receivedBody = JSON.parse(body) as Record<string, unknown>;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });

    await deliverScheduledTaskWebhook(`${baseUrl}/hook`, {
      taskId: 'task-1',
      taskName: 'Daily Report',
      sessionId: 'cw-1',
      summary: 'All systems healthy.',
      text: 'All systems healthy.',
      completedAt: '2026-11-22T00:00:00.000Z',
    });

    expect(receivedMethod).toBe('POST');
    expect(receivedContentType).toContain('application/json');
    expect(receivedBody).toEqual({
      taskId: 'task-1',
      taskName: 'Daily Report',
      sessionId: 'cw-1',
      summary: 'All systems healthy.',
      text: 'All systems healthy.',
      completedAt: '2026-11-22T00:00:00.000Z',
    });
  });

  test('captures non-2xx status, timeout, and missing/invalid URLs cleanly', async () => {
    const errorUrl = await startLocalServer((_req, res) => {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('upstream gateway failed');
    });
    await expect(
      deliverScheduledTaskWebhook(`${errorUrl}/fail`, {
        taskId: 't', taskName: 'n', sessionId: 's', summary: '', text: 'ok', completedAt: '',
      }),
    ).rejects.toThrow(/HTTP 502: upstream gateway failed/);

    const slowUrl = await startLocalServer((_req, _res) => {
      // Intentionally never respond so timeout triggers.
    });
    await expect(
      deliverScheduledTaskWebhook(
        `${slowUrl}/hang`,
        { taskId: 't', taskName: 'n', sessionId: 's', summary: '', text: 'ok', completedAt: '' },
        { timeoutMs: 50 },
      ),
    ).rejects.toThrow(/timed out after 50ms/);

    await expect(
      deliverScheduledTaskWebhook('', {
        taskId: 't', taskName: 'n', sessionId: 's', summary: '', text: 'ok', completedAt: '',
      }),
    ).rejects.toThrow(/URL is missing/);

    await expect(
      deliverScheduledTaskWebhook('file:///etc/passwd', {
        taskId: 't', taskName: 'n', sessionId: 's', summary: '', text: 'ok', completedAt: '',
      }),
    ).rejects.toThrow(/http or https/);
  });
});

describe('executeDshScheduledTask', () => {
  function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
    return {
      id: 'task-exec-1',
      name: 'Nightly Check',
      description: '',
      enabled: true,
      schedule: { kind: 'at', at: '2026-11-22T09:00:00.000Z' },
      sessionTarget: SessionTarget.Isolated,
      wakeMode: WakeMode.Now,
      payload: {
        kind: PayloadKind.AgentTurn,
        message: 'Check status',
        model: 'openai/gpt-4o-mini',
        timeoutSeconds: 30,
      },
      delivery: { mode: DeliveryMode.None },
      agentId: 'agent-ops',
      sessionKey: null,
      state: {
        nextRunAtMs: null,
        lastRunAtMs: null,
        lastStatus: null,
        lastError: null,
        lastDurationMs: null,
        runningAtMs: null,
        consecutiveErrors: 0,
      },
      createdAt: '2026-11-22T00:00:00.000Z',
      updatedAt: '2026-11-22T00:00:00.000Z',
      ...overrides,
    };
  }

  test('delivers only the requested run from the shared task conversation', async () => {
    const receivedPayloads: Array<Record<string, unknown>> = [];
    const webhookBase = await startLocalServer((_req, res, body) => {
      receivedPayloads.push(JSON.parse(body) as Record<string, unknown>);
      res.writeHead(200);
      res.end('ok');
    });

    const runtime = new Runtime();
    runtime.startSession.mockImplementation(async (sessionId: string) => {
      queueMicrotask(() => runtime.emit('complete', sessionId));
    });

    const prepareScheduledTaskSession = vi.fn(() => 'cw-sched-1');
    const getScheduledRunSummary = vi.fn(() => 'Service healthy.');
    const task = makeTask({
      delivery: { mode: DeliveryMode.Webhook, to: `${webhookBase}/notify` },
    });

    const result = await executeDshScheduledTask(
      {
        hostManager: { isReady: () => true, start: vi.fn(async () => undefined) },
        runtimeAdapter: runtime,
        coworkStore: {
          prepareScheduledTaskSession,
          getScheduledRunSummary,
        },
        getDefaultCwd: () => '/tmp/ops',
      },
      task,
      new AbortController().signal,
      'run-1',
    );

    expect(prepareScheduledTaskSession).toHaveBeenCalledWith({
      taskId: task.id, agentId: 'agent-ops', title: '[定时] Nightly Check',
      cwd: '/tmp/ops', modelOverride: 'openai/gpt-4o-mini',
    });
    expect(runtime.startSession).toHaveBeenCalledWith('cw-sched-1', 'Check status', {
      agentId: 'agent-ops', autoApprove: true, requestId: 'run-1',
    });
    expect(getScheduledRunSummary).toHaveBeenCalledWith('cw-sched-1', 'run-1');
    expect(result).toEqual({
      sessionId: 'cw-sched-1',
      summary: 'Service healthy.',
      deliveryStatus: RunDeliveryStatus.Delivered,
      deliveryError: null,
    });
    expect(receivedPayloads).toHaveLength(1);
    expect(receivedPayloads[0]).toMatchObject({
      taskId: 'task-exec-1',
      taskName: 'Nightly Check',
      sessionId: 'cw-sched-1',
      summary: 'Service healthy.',
    });
  });

  test('uses the task working directory even when the default workspace changes', async () => {
    const workingDirectory = tmpdir();
    const runtime = new Runtime();
    runtime.startSession.mockImplementation(async (sessionId: string) => {
      queueMicrotask(() => runtime.emit('complete', sessionId));
    });
    const prepareScheduledTaskSession = vi.fn(() => 'cw-bound');
    const getDefaultCwd = vi.fn(() => join(tmpdir(), 'different-workspace'));
    const task = makeTask({
      payload: { kind: PayloadKind.AgentTurn, message: 'Read project notes', workingDirectory },
    });

    await executeDshScheduledTask(
      {
        hostManager: { isReady: () => true, start: vi.fn(async () => undefined) },
        runtimeAdapter: runtime,
        coworkStore: { prepareScheduledTaskSession, getScheduledRunSummary: () => '' },
        getDefaultCwd,
      },
      task,
      new AbortController().signal,
      'run-2',
    );

    expect(prepareScheduledTaskSession).toHaveBeenCalledWith({
      taskId: task.id, agentId: 'agent-ops', title: '[定时] Nightly Check',
      cwd: workingDirectory, modelOverride: undefined,
    });
    expect(getDefaultCwd).not.toHaveBeenCalled();
  });

  test('fails before starting a turn when the bound workspace is missing, relative, or obstructed by a file', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'lobsterai-sched-cwd-'));
    const regularFile = join(tempDir, 'not-a-dir');
    writeFileSync(regularFile, 'plain file', 'utf8');
    try {
      const invalidPaths = [
        join(tmpdir(), `lobsterai-missing-${randomUUID()}`),
        'relative/project/path',
        regularFile,
        join(regularFile, 'nested-child'),
      ];

      for (const badPath of invalidPaths) {
        const runtime = new Runtime();
        const prepareScheduledTaskSession = vi.fn(() => 'cw-missing');
        const getDefaultCwd = vi.fn(() => tmpdir());
        const task = makeTask({
          payload: {
            kind: PayloadKind.AgentTurn,
            message: 'Read project notes',
            workingDirectory: badPath,
          },
        });

        await expect(
          executeDshScheduledTask(
            {
              hostManager: { isReady: () => true, start: vi.fn(async () => undefined) },
              runtimeAdapter: runtime,
              coworkStore: { prepareScheduledTaskSession, getScheduledRunSummary: () => '' },
              getDefaultCwd,
            },
            task,
            new AbortController().signal,
            'run-3',
          ),
        ).rejects.toThrow(`Scheduled task working directory is unavailable: ${badPath}`);

        expect(prepareScheduledTaskSession).not.toHaveBeenCalled();
        expect(getDefaultCwd).not.toHaveBeenCalled();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('enforces timeoutSeconds and preserves sessionId on timeout failure', async () => {
    const runtime = new Runtime();
    const task = makeTask({
      payload: {
        kind: PayloadKind.AgentTurn,
        message: 'Take too long',
        timeoutSeconds: 0.05,
      },
    });

    const result = await executeDshScheduledTask(
      {
        hostManager: { isReady: () => true, start: vi.fn(async () => undefined) },
        runtimeAdapter: runtime,
        coworkStore: {
          prepareScheduledTaskSession: () => 'cw-timeout-1',
          getScheduledRunSummary: () => '',
        },
        getDefaultCwd: () => '/tmp/ops',
      },
      task,
      new AbortController().signal,
      'run-4',
    );

    expect(runtime.stopSession).toHaveBeenCalledWith('cw-timeout-1');
    expect(result).toEqual({
      sessionId: 'cw-timeout-1',
      error: 'Scheduled task timed out after 0.05s',
      deliveryStatus: RunDeliveryStatus.NotRequested,
    });
  });
});
