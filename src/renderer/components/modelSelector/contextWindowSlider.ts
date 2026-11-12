import { parseContextWindowOptions } from '../../../shared/providers/modelContextWindow';

export interface ContextWindowSliderStop {
  tokens: number;
  selection: number | null;
}

export const formatContextWindow = (tokens: number): string => tokens >= 1_000_000
  ? `${tokens / 1_000_000}M` : `${tokens / 1_000}K`;

export function buildContextWindowSliderStops(options: number[], defaultWindow?: number): ContextWindowSliderStop[] {
  const stops: ContextWindowSliderStop[] = (parseContextWindowOptions(options) ?? [])
    .map(tokens => ({ tokens, selection: tokens }));
  if (defaultWindow && Number.isInteger(defaultWindow) && defaultWindow > 0
    && !stops.some(stop => stop.tokens === defaultWindow)) {
    // A current default outside the fixed choices remains reachable as follow-default,
    // rather than inventing a new fixed budget the server has not granted.
    stops.push({ tokens: defaultWindow, selection: null });
  }
  return stops.sort((a, b) => a.tokens - b.tokens);
}

export function contextWindowSliderIndex(stops: ContextWindowSliderStop[], override: number | null, defaultWindow?: number): number {
  return Math.max(0, stops.findIndex(stop => stop.tokens === (override ?? defaultWindow)));
}
