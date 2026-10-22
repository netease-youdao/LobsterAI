/** Display estimates from the model catalogue; settlement remains server-owned. */
export const VideoBillingUnit = {
  Video: 'per_video', Second: 'per_second', SecondIo: 'per_second_io', Token: 'per_token',
} as const;

type Values = Record<string, unknown>;
const record = (value: unknown): Values =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Values : {};
const number = (value: unknown): number | undefined => {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};
const hasValue = (value: unknown): boolean => Array.isArray(value) ? value.length > 0 : Boolean(value);
const CREDITS_PER_YUAN = 100;
const VIDEO_PIXELS: Record<string, number> = { '480p': 854 * 480, '720p': 1280 * 720, '1080p': 1920 * 1080 };
const credits = (value: Values): number | undefined =>
  number(value.credits ?? value.creditsPerSecond) ?? (number(value.costYuan) === undefined ? undefined : Number(value.costYuan) * CREDITS_PER_YUAN);

export function estimateVideoCredits(pricingValue: unknown, params: Values): number | undefined {
  const pricing = record(pricingValue);
  const defaults = record(pricing.defaultParams);
  const spec = record(pricing.parameterSpec);
  const duration = number(params.durationSeconds ?? params.duration ?? defaults.duration ?? record(spec.duration).default);
  const resolution = String(params.resolution ?? defaults.resolution ?? record(spec.resolution).default ?? '').toLowerCase();
  // Auto duration, provider-specific overrides and unknown input-video lengths
  // cannot yield a reliable total. Keep the catalogue rate/unknown-cost copy.
  if (!duration || !Number.isInteger(duration) || !resolution || Object.keys(record(params.providerOptions)).length) return undefined;
  const durationSpec = record(spec.duration);
  const minimum = number(durationSpec.min);
  const maximum = number(durationSpec.max);
  if ((minimum !== undefined && duration < minimum) || (maximum !== undefined && duration > maximum)
    || (Array.isArray(durationSpec.values) && !durationSpec.values.some(value => number(value) === duration))) return undefined;
  const hasVideo = ['videos', 'video', 'referenceVideos', 'videoUrls', 'referenceVideo', 'videoUrl', 'hasVideoInput'].some(key => hasValue(params[key]));
  const media = Array.isArray(params.media) ? params.media : [];
  if (hasVideo || media.length || hasValue(params.content)) return undefined;
  const hasImages = ['images', 'image', 'firstFrame', 'lastFrame', 'referenceImages'].some(key => hasValue(params[key]));
  const audio = params.audio ?? defaults.audio ?? record(spec.audio).default ?? false;
  const tiers = Array.isArray(pricing.tiers) ? pricing.tiers.map(record) : [];
  const matches = tiers.filter(tier => (
    (tier.resolution === undefined || String(tier.resolution).toLowerCase() === resolution)
    && (tier.duration === undefined || number(tier.duration) === duration)
    && (tier.audio === undefined || tier.audio === audio)
    && (tier.reference === undefined || tier.reference === hasImages)
    && (tier.hasVideoInput === undefined || tier.hasVideoInput === false)
  ));
  // Do not silently choose the cheapest or first of ambiguous pricing tiers.
  if (tiers.length && matches.length !== 1) return undefined;
  const tier = matches[0] ?? pricing;
  const rate = credits(tier);
  let estimate: number | undefined;
  switch (pricing.billingUnit) {
    case VideoBillingUnit.Video:
      estimate = rate;
      break;
    case VideoBillingUnit.Second:
      estimate = rate === undefined ? undefined : rate * duration;
      break;
    case VideoBillingUnit.SecondIo:
      // Input-image/video charging needs measured inputs, not an invented count.
      estimate = hasImages || rate === undefined ? undefined : rate * duration;
      break;
    case VideoBillingUnit.Token: {
      const pixels = VIDEO_PIXELS[resolution];
      const fps = number(pricing.defaultFps);
      const tokenRate = number(tier.pricePerMillionTokens);
      if (!pixels || !fps || tokenRate === undefined || pricing.usagePricing) return undefined;
      // Same output-token estimate as the server's catalogue pricing contract.
      estimate = Math.ceil(duration * pixels * fps / 1024) * tokenRate * CREDITS_PER_YUAN / 1_000_000;
      break;
    }
    default: return undefined;
  }
  return estimate !== undefined && Number.isFinite(estimate) ? Math.ceil(estimate * 100) / 100 : undefined;
}
