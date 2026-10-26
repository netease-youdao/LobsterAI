export const SettingsDiagnosticEvent = {
  OpenRequested: 'settings.open_requested', Frame: 'settings.frame',
} as const;
export const SettingsDiagnosticTag = 'SettingsDebug';
const WINDOW_MS = 60000, REQUESTS_PER_WINDOW = 20;

export interface SettingsOpenDiagnostic { readonly sequence: number; readonly startedAt: number }
interface DiagnosticFields {
  event: typeof SettingsDiagnosticEvent[keyof typeof SettingsDiagnosticEvent];
  sequence: number; rendererDateNow: number; durationMs: number;
}
interface DiagnosticDependencies {
  wallNow(): number;
  monotonicNow(): number;
  write(fields: DiagnosticFields): void;
  requestFrame(callback: () => void): number;
  cancelFrame(id: number): void;
}

/** Bounded local timing only: no settings, account, tab, notice or request payloads. */
export function createSettingsOpenDiagnostics(overrides: Partial<DiagnosticDependencies> = {}) {
  const deps: DiagnosticDependencies = {
    wallNow: Date.now,
    monotonicNow: () => performance.now(),
    write: fields => window.electron?.log?.fromRenderer?.('debug', SettingsDiagnosticTag, JSON.stringify(fields)),
    requestFrame: callback => requestAnimationFrame(callback),
    cancelFrame: id => cancelAnimationFrame(id),
    ...overrides,
  };
  let sequence = 0, windowStarted = -Infinity, windowRequests = 0;
  const framed = new WeakSet<SettingsOpenDiagnostic>();
  const valid = (value: number): boolean => Number.isFinite(value) && value >= 0;
  const write = (fields: DiagnosticFields): void => { try { deps.write(fields); } catch { /* Diagnostics never affect opening Settings. */ } };
  return {
    requested(): SettingsOpenDiagnostic | null {
      try {
        const now = deps.monotonicNow(), rendererDateNow = deps.wallNow();
        if (!valid(now) || !valid(rendererDateNow)) return null;
        if (now - windowStarted >= WINDOW_MS) { windowStarted = now; windowRequests = 0; }
        if (windowRequests >= REQUESTS_PER_WINDOW) return null;
        windowRequests++;
        const token = { sequence: ++sequence, startedAt: now };
        write({ event: SettingsDiagnosticEvent.OpenRequested, sequence: token.sequence, rendererDateNow, durationMs: 0 });
        return token;
      } catch { return null; }
    },
    afterCommit(token: SettingsOpenDiagnostic | null): () => void {
      if (!token) return () => {};
      let cancelled = false, id: number | undefined;
      try {
        id = deps.requestFrame(() => {
          if (cancelled || framed.has(token)) return;
          framed.add(token);
          try {
            const now = deps.monotonicNow(), rendererDateNow = deps.wallNow();
            if (!valid(now) || !valid(rendererDateNow) || now < token.startedAt) return;
            // A rAF callback after useEffect is a frame opportunity, not proof of screen paint.
            write({ event: SettingsDiagnosticEvent.Frame, sequence: token.sequence, rendererDateNow, durationMs: now - token.startedAt });
          } catch { /* Timing failure is optional. */ }
        });
      } catch { /* Unavailable frame scheduling must not affect Settings. */ }
      return () => {
        cancelled = true;
        if (id !== undefined) { try { deps.cancelFrame(id); } catch { /* Best-effort cleanup. */ } }
      };
    },
  };
}

export const settingsOpenDiagnostics = createSettingsOpenDiagnostics();
