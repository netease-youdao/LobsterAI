type MediaPricingTier = {
  resolution?: string;
  costYuan?: number | string;
  credits?: number | string;
  creditsPerSecond?: number | string;
};

export type MediaPricingConfig = {
  billingUnit?: string;
  freeInputImageCount?: number | string;
  inputImageCostYuan?: number | string;
  inputImageCredits?: number | string;
  defaultInputVideoDurationForEstimate?: number | string;
  defaultParams?: Record<string, unknown>;
  tiers?: MediaPricingTier[];
};

const CREDITS_PER_CNY = 100;

const numberValue = (value: unknown): number | undefined => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const stringValues = (value: unknown): string[] => (
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : typeof value === 'string' && value.trim() ? [value] : []
);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const typedMediaItems = (params: Record<string, unknown>): Record<string, unknown>[] => {
  const values: unknown[] = [params.content, params.media];
  if (isRecord(params.providerOptions)) values.push(params.providerOptions.media);
  return values.flatMap(value => (
    Array.isArray(value) ? value.filter(isRecord) : []
  ));
};

const mediaUrl = (item: Record<string, unknown>, key: string): string | undefined => {
  const value = item[key] ?? item.url;
  if (typeof value === 'string' && value.trim()) return value;
  return isRecord(value) && typeof value.url === 'string' && value.url.trim()
    ? value.url
    : undefined;
};

const countInputImages = (params: Record<string, unknown>): number => {
  const images = new Set<string>();
  for (const key of ['images', 'referenceImages', 'imageUrls']) {
    stringValues(params[key]).forEach(value => images.add(value));
  }
  for (const key of ['image', 'imageUrl', 'firstFrame', 'lastFrame']) {
    stringValues(params[key]).forEach(value => images.add(value));
  }
  for (const item of typedMediaItems(params)) {
    const type = typeof item.type === 'string' ? item.type.toLowerCase() : '';
    if (!type.includes('image') && !('image_url' in item)) continue;
    images.add(mediaUrl(item, 'image_url') ?? JSON.stringify(item));
  }
  return images.size;
};

const hasVideoInput = (params: Record<string, unknown>): boolean => (
  ['video', 'videoUrl', 'videos', 'referenceVideos', 'videoUrls']
    .some(key => stringValues(params[key]).length > 0)
  || typedMediaItems(params).some(item => {
    const type = typeof item.type === 'string' ? item.type.toLowerCase() : '';
    return type.includes('video') || 'video_url' in item;
  })
);

const inputVideoSeconds = (pricing: MediaPricingConfig, params: Record<string, unknown>): number => {
  if (!hasVideoInput(params)) return 0;
  for (const key of ['inputVideoDuration', 'referenceVideoDuration', 'inputVideoDurationSeconds']) {
    const value = numberValue(params[key]);
    if (value != null && value >= 0) return value;
  }
  for (const key of ['inputVideoDurations', 'referenceVideoDurations']) {
    if (!Array.isArray(params[key])) continue;
    const values = (params[key] as unknown[])
      .map(numberValue)
      .filter((value): value is number => value != null && value >= 0);
    if (values.length > 0) return values.reduce((sum, value) => sum + value, 0);
  }
  return numberValue(pricing.defaultInputVideoDurationForEstimate) ?? 15;
};

export const calculatePerSecondIoCredits = (
  pricing: MediaPricingConfig | undefined,
  params: Record<string, unknown>,
): number | undefined => {
  if (pricing?.billingUnit !== 'per_second_io') return undefined;

  const resolution = String(params.resolution ?? pricing.defaultParams?.resolution ?? '').toLowerCase();
  const tier = pricing.tiers?.find(item => item.resolution?.toLowerCase() === resolution);
  if (!tier) return undefined;
  const perSecondCredits = numberValue(tier.creditsPerSecond ?? tier.credits)
    ?? ((numberValue(tier.costYuan) ?? 0) * CREDITS_PER_CNY);
  if (perSecondCredits <= 0) return undefined;

  const duration = numberValue(
    params.durationSeconds ?? params.duration ?? pricing.defaultParams?.duration,
  );
  if (duration == null || duration <= 0) return undefined;

  const freeImages = Math.max(0, Math.floor(numberValue(pricing.freeInputImageCount) ?? 0));
  const billableImages = Math.max(0, countInputImages(params) - freeImages);
  const imageCredits = numberValue(pricing.inputImageCredits)
    ?? ((numberValue(pricing.inputImageCostYuan) ?? 0) * CREDITS_PER_CNY);

  return (duration + inputVideoSeconds(pricing, params)) * perSecondCredits
    + billableImages * imageCredits;
};
