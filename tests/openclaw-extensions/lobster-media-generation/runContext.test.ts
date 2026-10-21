import { expect, test, vi } from 'vitest';

import { MediaRunContexts, MediaRunLifecycle } from '../../../openclaw-extensions/lobster-media-generation/runContext';

const sessionKey = 'agent:main:feishu:direct:user-1';
const context = { sessionKey, runId: 'run-1' };

test('tool execution waits for the run owner to be captured', async () => {
  let acknowledge!: (result: { isError?: boolean }) => void;
  const send = vi.fn(() => new Promise<{ isError?: boolean }>(resolve => { acknowledge = resolve; }));
  const runs = new MediaRunContexts(send);
  const beginning = runs.begin(context);
  let bound = false;
  const binding = runs.bindTool({ ...context, toolCallId: 'call-1' }).then(value => { bound = value; });
  await Promise.resolve();
  expect(bound).toBe(false);
  acknowledge({});
  await Promise.all([beginning, binding]);
  expect(bound).toBe(true);
  expect(runs.forTool(sessionKey, 'call-1')).toEqual({ runId: context.runId });
});

test('a failed binding cannot retry under a later account', async () => {
  const send = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({});
  const runs = new MediaRunContexts(send);
  await runs.begin(context);
  await runs.begin(context);
  expect(send).toHaveBeenCalledTimes(1);
  expect(await runs.bindTool({ ...context, toolCallId: 'call-1' })).toBe(false);
  expect(() => runs.forTool(sessionKey, 'call-1')).toThrow();
});

test('overlapping runs retain separate tool bindings and cleanup', async () => {
  const send = vi.fn(async () => ({}));
  const runs = new MediaRunContexts(send);
  const other = { ...context, runId: 'run-2' };
  await runs.begin(context);
  await runs.begin(other);
  expect(await runs.bindTool({ ...context, toolCallId: 'call-1' })).toBe(true);
  expect(await runs.bindTool({ ...other, toolCallId: 'call-1' })).toBe(false);
  expect(await runs.bindTool({ ...other, toolCallId: 'call-2' })).toBe(true);
  await runs.end(context);
  expect(() => runs.forTool(sessionKey, 'call-1')).toThrow();
  expect(runs.forTool(sessionKey, 'call-2')).toEqual({ runId: other.runId });
  expect(send).toHaveBeenLastCalledWith({
    tool: MediaRunLifecycle.Tool, args: { action: MediaRunLifecycle.End },
    context: { ...context, toolCallId: context.runId },
  });
});

test('end arriving during begin releases the account only after begin finishes', async () => {
  let acknowledge!: (result: object) => void;
  const send = vi.fn().mockImplementationOnce(() => new Promise(resolve => { acknowledge = resolve; }))
    .mockResolvedValue({});
  const runs = new MediaRunContexts(send);
  const beginning = runs.begin(context);
  const ending = runs.end(context);
  expect(send).toHaveBeenCalledTimes(1);
  acknowledge({});
  await Promise.all([beginning, ending]);
  expect(send).toHaveBeenCalledTimes(2);
  expect(await runs.bindTool({ ...context, toolCallId: 'late-call' })).toBe(false);
});

test('desktop IPC remains compatible while a job bound to a desktop session gets a native scope', async () => {
  const send = vi.fn(async () => ({}));
  const runs = new MediaRunContexts(send);
  const desktop = { sessionKey: 'agent:main:lobsterai:local-session', runId: 'desktop-run' };
  await runs.begin(desktop);
  expect(send).not.toHaveBeenCalled();
  expect(await runs.bindTool({ ...desktop, toolCallId: 'desktop-call' })).toBe(true);
  expect(runs.forTool(desktop.sessionKey, 'desktop-call')).toEqual({});
  const scheduled = { ...desktop, runId: 'cron-run', jobId: 'job-1' };
  await runs.begin(scheduled);
  expect(await runs.bindTool({ ...scheduled, toolCallId: 'cron-call' })).toBe(true);
  expect(runs.forTool(scheduled.sessionKey, 'cron-call')).toEqual({ runId: scheduled.runId });
});

test('desktop continuation of an IM conversation preserves the IPC media selection', async () => {
  const send = vi.fn(async () => ({}));
  const runs = new MediaRunContexts(send);
  await runs.begin({ ...context, messageProvider: 'webchat' });
  expect(await runs.bindTool({ ...context, toolCallId: 'desktop-call' })).toBe(true);
  expect(runs.forTool(sessionKey, 'desktop-call')).toEqual({});
  await runs.end(context);
  expect(send).not.toHaveBeenCalled();
});
