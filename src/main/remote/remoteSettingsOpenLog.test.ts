import { describe, expect, it, vi } from 'vitest';

import { type enqueueRemoteLog } from './remoteLogSink';
import { createSettingsOpenLog } from './remoteSettingsOpenLog';

const requested = { event: 'settings.open_requested', sequence: 1, rendererDateNow: 1793000000000, durationMs: 0 };
function fixture() {
  let wall = 1793000000035, monotonic = 0;
  const enqueue = vi.fn<typeof enqueueRemoteLog>();
  const consume = createSettingsOpenLog({ wallNow: () => wall, monotonicNow: () => monotonic, enqueue });
  return { consume, enqueue, clock: (nextWall: number, nextMonotonic: number) => { wall = nextWall; monotonic = nextMonotonic; } };
}

describe('Settings renderer logs use the bounded asynchronous sink', () => {
  it('keeps only fixed metadata and the full main receipt epoch without passing renderer content to the sink', () => {
    const f = fixture();
    expect(f.consume('SettingsDebug', JSON.stringify({ ...requested, token: 'private-token', path: '/private/path', notice: 'private-notice' }))).toBe(true);
    expect(f.enqueue).toHaveBeenLastCalledWith('debug', '[Renderer][SettingsDebug]', { ...requested, mainReceivedDateNow: 1793000000035 });
    expect(JSON.stringify(f.enqueue.mock.calls)).not.toContain('private');
    f.clock(1793000000060, 25);
    expect(f.consume('SettingsDebug', JSON.stringify({ ...requested, event: 'settings.frame', durationMs: 25.125 }))).toBe(true);
    expect(f.enqueue).toHaveBeenLastCalledWith('debug', '[Renderer][SettingsDebug]', {
      ...requested, event: 'settings.frame', durationMs: 25.13, mainReceivedDateNow: 1793000000060,
    });
  });

  it('always consumes its fixed tag after invalid JSON, oversized input or invalid fields so none can fall back to console', () => {
    const f = fixture(), values: unknown[] = [undefined, {}, 'bad JSON', ' '.repeat(513), '[]', 'null',
      JSON.stringify({ ...requested, event: 'private.event' }), JSON.stringify({ ...requested, sequence: 0 }),
      JSON.stringify({ ...requested, sequence: Number.MAX_SAFE_INTEGER + 1 }), JSON.stringify({ ...requested, rendererDateNow: -1 }),
      JSON.stringify({ ...requested, rendererDateNow: 8640000000000001 }), JSON.stringify({ ...requested, durationMs: 1 }),
      JSON.stringify({ ...requested, event: 'settings.frame', durationMs: -1 }),
      JSON.stringify({ ...requested, event: 'settings.frame', durationMs: 86400001 }),
      JSON.stringify({ ...requested, event: 'settings.frame', durationMs: null })];
    const legacy = vi.fn();
    for (const message of values) { if (!f.consume('SettingsDebug', message)) legacy(message); }
    expect(f.enqueue).not.toHaveBeenCalled(); expect(legacy).not.toHaveBeenCalled();
    for (const tag of ['SettingsDebug.extra', 'Settings Debug', '', undefined]) expect(f.consume(tag, JSON.stringify(requested))).toBe(false);
    expect(f.enqueue).not.toHaveBeenCalled();
  });

  it('caps the entire main-process stream at forty records per monotonic minute despite wall-clock changes', () => {
    const f = fixture(), message = JSON.stringify(requested);
    for (let index = 0; index < 50; index++) expect(f.consume('SettingsDebug', message)).toBe(true);
    expect(f.enqueue).toHaveBeenCalledTimes(40);
    f.clock(1793009999999, 59999); expect(f.consume('SettingsDebug', message)).toBe(true);
    expect(f.enqueue).toHaveBeenCalledTimes(40);
    f.clock(1792999999999, 60000); expect(f.consume('SettingsDebug', message)).toBe(true);
    expect(f.enqueue).toHaveBeenCalledTimes(41);
    expect(f.enqueue.mock.calls.at(-1)?.[2]).toMatchObject({ mainReceivedDateNow: 1792999999999 });
  });

  it('swallows sink and clock failures while keeping the fixed tag consumed and the bounded failure budget', () => {
    const failure = (): never => { throw new Error('optional diagnostic failure'); };
    const enqueue = vi.fn<typeof enqueueRemoteLog>(failure);
    const consume = createSettingsOpenLog({ wallNow: () => 1793000000000, monotonicNow: () => 0, enqueue });
    for (let index = 0; index < 50; index++) expect(consume('SettingsDebug', JSON.stringify(requested))).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(40);
    const cases = [{ wallNow: failure }, { monotonicNow: failure }, { monotonicNow: () => NaN },
      { wallNow: () => Infinity }, { wallNow: () => -1 }];
    for (const options of cases) {
      const write = vi.fn();
      expect(createSettingsOpenLog({ ...options, enqueue: write })('SettingsDebug', JSON.stringify(requested))).toBe(true);
      expect(write).not.toHaveBeenCalled();
    }
  });
});
