import { test, expect, describe } from 'vitest';
import { mapGatewayRun, mapGatewayTaskState } from './cronJobService';
import { DeliveryMode, GatewayStatus, TaskStatus } from './constants';

describe('mapGatewayRun', () => {
  const baseEntry = {
    ts: 1700000000000,
    jobId: 'job-1',
    status: GatewayStatus.Ok,
    sessionId: 'sess-1',
    runAtMs: 1699999990000,
    durationMs: 10000,
    summary: 'All good',
  };

  test('maps ok status to success', () => {
    const run = mapGatewayRun(baseEntry);
    expect(run.status).toBe(TaskStatus.Success);
    expect(run.error).toBeNull();
  });

  test('maps error status to error', () => {
    const run = mapGatewayRun({
      ...baseEntry,
      status: GatewayStatus.Error,
      error: 'something broke',
    });
    expect(run.status).toBe(TaskStatus.Error);
    expect(run.error).toBe('something broke');
  });

  test('maps running action to running', () => {
    const run = mapGatewayRun({ ...baseEntry, action: 'started' });
    expect(run.status).toBe(TaskStatus.Running);
  });

  test('suppresses delivery-only error to success', () => {
    const run = mapGatewayRun({
      ...baseEntry,
      status: GatewayStatus.Error,
      error: '⚠️ ✉️ Message failed',
      deliveryStatus: 'not-delivered',
      deliveryError: '⚠️ ✉️ Message failed',
      summary: 'Agent produced a valid summary',
    });
    expect(run.status).toBe(TaskStatus.Success);
    expect(run.error).toBeNull();
  });

  test('does not suppress error when error differs from deliveryError', () => {
    const run = mapGatewayRun({
      ...baseEntry,
      status: GatewayStatus.Error,
      error: 'agent crashed',
      deliveryStatus: 'not-delivered',
      deliveryError: '⚠️ ✉️ Message failed',
    });
    expect(run.status).toBe(TaskStatus.Error);
    expect(run.error).toBe('agent crashed');
  });

  test('does not suppress error when no deliveryError is present', () => {
    const run = mapGatewayRun({
      ...baseEntry,
      status: GatewayStatus.Error,
      error: 'timeout',
    });
    expect(run.status).toBe(TaskStatus.Error);
    expect(run.error).toBe('timeout');
  });
});

describe('mapGatewayTaskState', () => {
  test('maps ok status to success', () => {
    const state = mapGatewayTaskState(
      { lastRunStatus: GatewayStatus.Ok, lastRunAtMs: 1700000000000 },
    );
    expect(state.lastStatus).toBe(TaskStatus.Success);
    expect(state.lastError).toBeNull();
  });

  test('maps error status to error', () => {
    const state = mapGatewayTaskState(
      { lastRunStatus: GatewayStatus.Error, lastError: 'fail' },
    );
    expect(state.lastStatus).toBe(TaskStatus.Error);
    expect(state.lastError).toBe('fail');
  });

  test('maps running state', () => {
    const state = mapGatewayTaskState(
      { runningAtMs: Date.now(), lastRunStatus: GatewayStatus.Ok },
    );
    expect(state.lastStatus).toBe(TaskStatus.Running);
  });

  test('suppresses delivery-only error when delivery mode is none', () => {
    const state = mapGatewayTaskState(
      {
        lastRunStatus: GatewayStatus.Error,
        lastError: '⚠️ ✉️ Message failed',
        lastDeliveryStatus: 'not-delivered',
        lastDeliveryError: '⚠️ ✉️ Message failed',
      },
      DeliveryMode.None,
    );
    expect(state.lastStatus).toBe(TaskStatus.Success);
    expect(state.lastError).toBeNull();
  });

  test('does not suppress delivery error when delivery mode is announce', () => {
    const state = mapGatewayTaskState(
      {
        lastRunStatus: GatewayStatus.Error,
        lastError: '⚠️ ✉️ Message failed',
        lastDeliveryStatus: 'not-delivered',
        lastDeliveryError: '⚠️ ✉️ Message failed',
      },
      DeliveryMode.Announce,
    );
    expect(state.lastStatus).toBe(TaskStatus.Error);
    expect(state.lastError).toBe('⚠️ ✉️ Message failed');
  });

  test('does not suppress non-delivery errors even for mode none', () => {
    const state = mapGatewayTaskState(
      {
        lastRunStatus: GatewayStatus.Error,
        lastError: 'agent timeout',
      },
      DeliveryMode.None,
    );
    expect(state.lastStatus).toBe(TaskStatus.Error);
    expect(state.lastError).toBe('agent timeout');
  });
});
