import { enqueueRemoteLog } from './remoteLogSink';

const TAG = 'SettingsDebug';
const EVENT = { Requested: 'settings.open_requested', Frame: 'settings.frame' } as const;
const LIMIT = { Characters: 512, Records: 40, WindowMs: 60000, DurationMs: 86400000, EpochMs: 8640000000000000 } as const;
interface Options { wallNow?: () => number; monotonicNow?: () => number; enqueue?: typeof enqueueRemoteLog }

/** Consume this fixed renderer tag even on invalid input; never fall back to synchronous logging. */
export function createSettingsOpenLog(options: Options = {}) {
  const wallNow = options.wallNow ?? Date.now, monotonicNow = options.monotonicNow ?? (() => performance.now());
  const enqueue = options.enqueue ?? enqueueRemoteLog;
  let windowStarted = -Infinity, records = 0;
  const epoch = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= LIMIT.EpochMs;
  return (tag: unknown, message: unknown): boolean => {
    if (tag !== TAG) return false;
    try {
      const mainReceivedDateNow = wallNow(), now = monotonicNow();
      if (!epoch(mainReceivedDateNow) || !Number.isFinite(now) || now < 0) return true;
      if (now - windowStarted >= LIMIT.WindowMs) { windowStarted = now; records = 0; }
      if (records >= LIMIT.Records || typeof message !== 'string' || message.length > LIMIT.Characters) return true;
      const fields: unknown = JSON.parse(message);
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return true;
      const { event, sequence, rendererDateNow, durationMs } = fields as Record<string, unknown>;
      if (event !== EVENT.Requested && event !== EVENT.Frame
        || typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1
        || !epoch(rendererDateNow) || typeof durationMs !== 'number' || !Number.isFinite(durationMs)
        || durationMs < 0 || durationMs > LIMIT.DurationMs || event === EVENT.Requested && durationMs !== 0) return true;
      records++;
      enqueue('debug', '[Renderer][SettingsDebug]', { event, sequence, rendererDateNow,
        durationMs: Math.round(durationMs * 100) / 100, mainReceivedDateNow });
    } catch { /* Diagnostic parsing, clocks and persistence must never affect Settings or invoke console. */ }
    return true;
  };
}

export const logSettingsOpenFromRenderer = createSettingsOpenLog();
