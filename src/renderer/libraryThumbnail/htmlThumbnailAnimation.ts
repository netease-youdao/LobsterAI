import { HtmlThumbnailLimits } from '../../shared/library/htmlThumbnail';

export interface HtmlThumbnailAnimationTiming {
  names: string;
  durations: string;
  delays: string;
  iterations: string;
}

const splitList = (value: string): string[] => value.split(',').map(item => item.trim());
const parseTime = (value: string): number | null => {
  const match = /^(-?(?:\d+(?:\.\d*)?|\.\d+))(ms|s)$/.exec(value);
  return match ? Number(match[1]) * (match[2] === 's' ? 1_000 : 1) : null;
};

/** A bounded snapshot time, not a claim that every animation/resource has settled. */
export const getHtmlThumbnailAnimationWaitMs = (
  timings: HtmlThumbnailAnimationTiming[],
): number => {
  let longest = 0;
  for (const timing of timings) {
    const names = splitList(timing.names);
    const durations = splitList(timing.durations);
    const delays = splitList(timing.delays);
    const iterations = splitList(timing.iterations);
    names.forEach((name, index) => {
      if (!name || name === 'none') return;
      const count = Number(iterations[index % iterations.length] || '1');
      // Infinite or unresolved timings must never hold up the thumbnail queue.
      if (!Number.isFinite(count) || count <= 0) return;
      const duration = parseTime(durations[index % durations.length] || '0s');
      const delay = parseTime(delays[index % delays.length] || '0s');
      if (duration === null || delay === null || duration < 0) return;
      longest = Math.max(longest, delay + duration * count);
    });
  }
  return longest > 0
    ? Math.min(HtmlThumbnailLimits.AnimationTimeoutMs, longest + HtmlThumbnailLimits.AnimationSettleMs)
    : 0;
};
