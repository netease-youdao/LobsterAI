import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSettingsOpenDiagnostics, SettingsDiagnosticEvent, SettingsDiagnosticTag } from './settingsOpenDiagnostics';

afterEach(() => vi.unstubAllGlobals());

function fixture() {
  let wall = 100000, monotonic = 100, nextFrame = 0;
  const callbacks = new Map<number, () => void>();
  const write = vi.fn(), cancelFrame = vi.fn((id: number) => callbacks.delete(id));
  const diagnostics = createSettingsOpenDiagnostics({ wallNow: () => wall, monotonicNow: () => monotonic, write,
    requestFrame: callback => { callbacks.set(++nextFrame, callback); return nextFrame; }, cancelFrame });
  return { diagnostics, write, callbacks, cancelFrame,
    clock: (nextWall: number, nextMonotonic: number) => { wall = nextWall; monotonic = nextMonotonic; },
    frame: () => { for (const callback of [...callbacks.values()]) callback(); },
  };
}

describe('Settings opening diagnostics', () => {
  it('records only a sequential request and one post-effect frame opportunity using monotonic elapsed time', () => {
    const f = fixture(), token = f.diagnostics.requested();
    expect(f.write).toHaveBeenLastCalledWith({ event: SettingsDiagnosticEvent.OpenRequested, sequence: 1, rendererDateNow: 100000, durationMs: 0 });
    f.diagnostics.afterCommit(token);
    f.clock(99900, 137.5); f.frame(); f.frame();
    expect(f.write).toHaveBeenCalledTimes(2);
    expect(f.write).toHaveBeenLastCalledWith({ event: SettingsDiagnosticEvent.Frame, sequence: 1, rendererDateNow: 99900, durationMs: 37.5 });
    expect(f.diagnostics.requested()?.sequence).toBe(2);
    expect(Object.keys(f.write.mock.calls[1][0]).sort()).toEqual(['durationMs', 'event', 'rendererDateNow', 'sequence']);
  });

  it('cancels frame callbacks on effect cleanup even if an already queued callback is invoked', () => {
    const f = fixture(), token = f.diagnostics.requested();
    const cancel = f.diagnostics.afterCommit(token), callback = [...f.callbacks.values()][0];
    cancel(); callback();
    expect(f.cancelFrame).toHaveBeenCalledWith(1);
    expect(f.write).toHaveBeenCalledTimes(1);
    // React may set the effect up again after cleanup; only the live callback is reported.
    f.diagnostics.afterCommit(token); f.clock(100020, 120); f.frame();
    expect(f.write).toHaveBeenCalledTimes(2);
  });

  it('caps requests at twenty per minute and emits at most two fixed records per opening', () => {
    const f = fixture();
    for (let i = 0; i < 50; i++) f.diagnostics.afterCommit(f.diagnostics.requested());
    f.frame();
    expect(f.write).toHaveBeenCalledTimes(40);
    expect(f.diagnostics.requested()).toBeNull();
    f.clock(160000, 60100);
    expect(f.diagnostics.requested()?.sequence).toBe(21);
  });

  it('contains broken clocks, logging and frame scheduling without throwing into the UI', () => {
    expect(createSettingsOpenDiagnostics({ monotonicNow: () => Number.NaN }).requested()).toBeNull();
    const failure = (): never => { throw new Error('Optional diagnostic unavailable'); };
    const diagnostics = createSettingsOpenDiagnostics({ write: failure, requestFrame: failure });
    const token = diagnostics.requested();
    expect(token).not.toBeNull();
    expect(() => diagnostics.afterCommit(token)()).not.toThrow();
    expect(() => diagnostics.afterCommit(null)()).not.toThrow();
    expect(createSettingsOpenDiagnostics({ wallNow: failure }).requested()).toBeNull();
  });

  it('uses the existing renderer log bridge with a fixed tag and a small JSON envelope', () => {
    const fromRenderer = vi.fn();
    vi.stubGlobal('window', { electron: { log: { fromRenderer } } });
    const diagnostics = createSettingsOpenDiagnostics({ wallNow: () => 100000, monotonicNow: () => 10 });
    diagnostics.requested();
    expect(fromRenderer).toHaveBeenCalledOnce();
    const [level, tag, message] = fromRenderer.mock.calls[0];
    expect(level).toBe('debug'); expect(tag).toBe(SettingsDiagnosticTag);
    expect(JSON.parse(message)).toEqual({ event: SettingsDiagnosticEvent.OpenRequested, sequence: 1, rendererDateNow: 100000, durationMs: 0 });
    expect(Buffer.byteLength(message)).toBeLessThan(256);
  });
});
