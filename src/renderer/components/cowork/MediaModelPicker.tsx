import { CheckIcon } from '@heroicons/react/24/outline';
import { canonicalizeMediaModelId, GPT_IMAGE_2_MODEL_ID, mediaModelDisplayName } from '@shared/mediaModelAliases';
import { ProviderName } from '@shared/providers';
import Lottie from 'lottie-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDispatch, useSelector } from 'react-redux';

import { getProviderIcon, ProviderIconId } from '../../providers/uiRegistry';
import { authService } from '../../services/auth';
import { i18nService } from '../../services/i18n';
import { localStore } from '../../services/store';
import { RootState } from '../../store';
import { setMediaModels, setMediaSelection } from '../../store/slices/coworkSlice';
import type { MediaGenerationMode, MediaModel } from '../../types/mediaGeneration';
import MagicIcon from '../icons/MagicIcon';
import mediaGenAnimation from '../icons/MediaGenIcon.json';

interface SavedMediaSelection {
  image?: { modelId: string; modelName: string };
  video?: { modelId: string; modelName: string };
}

const MEDIA_SELECTION_KV_KEY = 'media_selection';

type MediaIconKey = ProviderName | ProviderIconId;

const normalizeMediaModel = (model: MediaModel): MediaModel => {
  const modelId = canonicalizeMediaModelId(model.modelId);
  const displayName = mediaModelDisplayName(modelId, model.displayName);
  if (modelId === model.modelId && displayName === model.displayName) {
    return model;
  }
  return { ...model, modelId, displayName };
};

const normalizeSavedMediaSelectionEntry = (
  entry: { modelId: string; modelName: string } | undefined,
): { modelId: string; modelName: string } | undefined => {
  if (!entry) return undefined;
  const modelId = canonicalizeMediaModelId(entry.modelId);
  return {
    modelId,
    modelName: mediaModelDisplayName(modelId, entry.modelName),
  };
};

const normalizeSavedMediaSelection = (saved: SavedMediaSelection | null | undefined): SavedMediaSelection => {
  const image = normalizeSavedMediaSelectionEntry(saved?.image);
  const video = normalizeSavedMediaSelectionEntry(saved?.video);
  return {
    ...(image ? { image } : {}),
    ...(video ? { video } : {}),
  };
};

const isSameSavedMediaSelection = (
  left: SavedMediaSelection | null | undefined,
  right: SavedMediaSelection,
): boolean => (
  left?.image?.modelId === right.image?.modelId
  && left?.image?.modelName === right.image?.modelName
  && left?.video?.modelId === right.video?.modelId
  && left?.video?.modelName === right.video?.modelName
);

const MEDIA_ICON_HINTS: Array<{ pattern: RegExp; iconKey: MediaIconKey }> = [
  { pattern: /gpt[\s-]*image[\s-]*2|canvas[\s-]*20/i, iconKey: ProviderName.OpenAI },
  { pattern: /nano[\s-]*banana[\s-]*(?:2|pro)|nano[\s-]*banan[\s-]*(?:2|pro)|banana[\s-]*(?:2|pro)/i, iconKey: ProviderIconId.Banana },
  { pattern: /doubao|seedream|豆包/i, iconKey: ProviderIconId.Doubao },
  { pattern: /minimax/i, iconKey: ProviderName.Minimax },
  { pattern: /qwen|qwq|wan2\.7|z-image/i, iconKey: ProviderName.Qwen },
  { pattern: /kling/i, iconKey: ProviderIconId.Kling },
  { pattern: /happyhorse|happy.horse/i, iconKey: ProviderIconId.HappyHorse },
];

interface MediaPricingConfig {
  billingUnit?: string;
  adapterType?: string;
  currency?: string;
  pricingModel?: string;
  usdToCny?: number | string;
  unitLabel?: string;
  upstreamModelId?: string;
  usagePricing?: TokenUsagePricing;
  estimatedUsage?: EstimatedTokenUsage;
  defaultParams?: Record<string, unknown>;
  tiers?: Array<{
    resolution?: string;
    duration?: number;
    audio?: boolean;
    hasVideoInput?: boolean;
    costYuan?: number;
    pricePerMillionTokens?: number;
  }>;
}

interface TokenUsagePricing {
  textInputUsdPerMillion?: number;
  imageInputUsdPerMillion?: number;
  cachedInputUsdPerMillion?: number;
  cachedImageInputUsdPerMillion?: number;
  textOutputUsdPerMillion?: number;
  imageOutputUsdPerMillion?: number;
  thinkingOutputUsdPerMillion?: number;
}

interface EstimatedTokenUsage {
  textInputTokens?: number;
  imageInputTokensPerImage?: number;
  cachedInputTokens?: number;
  cachedImageInputTokens?: number;
  textOutputTokens?: number;
  imageOutputTokensPerImage?: number;
  thinkingOutputTokens?: number;
}

const CREDITS_PER_CNY = 100;
const DEFAULT_USD_TO_CNY = 7;
const BANANA_2_MODEL_ID = 'banana-2';
const BANANA_PRO_MODEL_ID = 'banana-pro';
const BANANA_2_ESTIMATE_KEYS = new Set([
  BANANA_2_MODEL_ID,
  'banana2',
  'banana 2',
  'nano banana 2',
  'g3.1-flash-image-preview',
  'gemini-3.1-flash-image',
  'gemini-3.1-flash-image-preview',
]);
const BANANA_PRO_ESTIMATE_KEYS = new Set([
  BANANA_PRO_MODEL_ID,
  'banana pro',
  'nanobanana pro',
  'nano banana pro',
  'gemini3proimage',
  'g3-pro-image-preview',
  'gemini-3-pro-image',
  'gemini-3-pro-image-preview',
]);

interface ClientEstimateUsagePart {
  tokens: number;
  creditsPerMillion: number;
  zhLabel: string;
  enLabel: string;
}

interface ClientEstimateConfig {
  credits: number;
  discountLabel?: string;
  inputImageCount: number;
  outputImageCount: number;
  usageParts: ClientEstimateUsagePart[];
}

const CLIENT_ESTIMATE_CONFIGS: Record<string, ClientEstimateConfig> = {
  [GPT_IMAGE_2_MODEL_ID]: {
    credits: 30,
    discountLabel: '6折',
    inputImageCount: 1,
    outputImageCount: 1,
    usageParts: [
      { tokens: 83, creditsPerMillion: 2100, zhLabel: '文本 token', enLabel: 'text tokens' },
      { tokens: 1050, creditsPerMillion: 5600, zhLabel: '图片输入 token', enLabel: 'image-input tokens' },
      { tokens: 1900, creditsPerMillion: 12600, zhLabel: '图片输出 token', enLabel: 'image-output tokens' },
    ],
  },
  [BANANA_2_MODEL_ID]: {
    credits: 49,
    inputImageCount: 0,
    outputImageCount: 1,
    usageParts: [
      { tokens: 60, creditsPerMillion: 350, zhLabel: '文本 token', enLabel: 'text tokens' },
      { tokens: 1120, creditsPerMillion: 42000, zhLabel: '图片输出 token', enLabel: 'image-output tokens' },
      { tokens: 922, creditsPerMillion: 2100, zhLabel: '思考输出 token', enLabel: 'thinking-output tokens' },
    ],
  },
  [BANANA_PRO_MODEL_ID]: {
    credits: 94,
    inputImageCount: 0,
    outputImageCount: 1,
    usageParts: [
      { tokens: 60, creditsPerMillion: 1400, zhLabel: '文本 token', enLabel: 'text tokens' },
      { tokens: 1120, creditsPerMillion: 84000, zhLabel: '图片输出 token', enLabel: 'image-output tokens' },
    ],
  },
};

const TOKEN_PRICING_FIELDS: Array<{ key: keyof TokenUsagePricing; labelKey: string }> = [
  { key: 'textInputUsdPerMillion', labelKey: 'mediaTokenPricingTextInput' },
  { key: 'imageInputUsdPerMillion', labelKey: 'mediaTokenPricingImageInput' },
  { key: 'cachedInputUsdPerMillion', labelKey: 'mediaTokenPricingCachedInput' },
  { key: 'cachedImageInputUsdPerMillion', labelKey: 'mediaTokenPricingCachedImageInput' },
  { key: 'textOutputUsdPerMillion', labelKey: 'mediaTokenPricingTextOutput' },
  { key: 'imageOutputUsdPerMillion', labelKey: 'mediaTokenPricingImageOutput' },
  { key: 'thinkingOutputUsdPerMillion', labelKey: 'mediaTokenPricingThinkingOutput' },
];

const toFiniteNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

const countArrayParam = (value: unknown): number => Array.isArray(value) ? value.length : 0;

const getPricingConfig = (model: MediaModel): MediaPricingConfig | undefined => {
  if (!model.pricing || typeof model.pricing !== 'object') return undefined;
  return model.pricing as MediaPricingConfig;
};

const isTokenBillingModel = (model: MediaModel): boolean => {
  return getPricingConfig(model)?.billingUnit === 'per_token';
};

const getNormalizedClientEstimateKeys = (model: MediaModel): string[] => {
  const pricing = getPricingConfig(model);
  return [
    model.modelId,
    canonicalizeMediaModelId(model.modelId),
    model.displayName,
    pricing?.adapterType,
    pricing?.pricingModel,
    pricing?.upstreamModelId,
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    .map(value => value.trim().toLowerCase());
};

const getClientEstimateConfig = (model: MediaModel): ClientEstimateConfig | undefined => {
  const estimateKeys = getNormalizedClientEstimateKeys(model);
  if (estimateKeys.includes(GPT_IMAGE_2_MODEL_ID)) return CLIENT_ESTIMATE_CONFIGS[GPT_IMAGE_2_MODEL_ID];
  if (estimateKeys.some(key => BANANA_2_ESTIMATE_KEYS.has(key))) return CLIENT_ESTIMATE_CONFIGS[BANANA_2_MODEL_ID];
  if (estimateKeys.some(key => BANANA_PRO_ESTIMATE_KEYS.has(key))) return CLIENT_ESTIMATE_CONFIGS[BANANA_PRO_MODEL_ID];
  return undefined;
};

const getCreditsPerUsd = (pricing?: MediaPricingConfig): number => {
  const usdToCny = toFiniteNumber(pricing?.usdToCny) ?? DEFAULT_USD_TO_CNY;
  return usdToCny * CREDITS_PER_CNY;
};

const usageCostCredits = (tokens: number | undefined, usdPerMillion: number | undefined, creditsPerUsd: number): number => {
  if (!tokens || !usdPerMillion) return 0;
  return tokens * usdPerMillion / 1_000_000 * creditsPerUsd;
};

const getDefaultOutputImageCount = (defaultParams?: Record<string, unknown>): number => {
  const count = toFiniteNumber(defaultParams?.n) ?? toFiniteNumber(defaultParams?.count) ?? 1;
  return Math.max(1, Math.floor(count));
};

const getDefaultInputImageCount = (defaultParams?: Record<string, unknown>): number => {
  if (!defaultParams) return 0;
  return countArrayParam(defaultParams.images)
    + countArrayParam(defaultParams.referenceImages)
    + countArrayParam(defaultParams.imageUrls);
};

const calculateEstimatedTokenCredits = (model: MediaModel): number | undefined => {
  const pricing = getPricingConfig(model);
  const usagePricing = pricing?.usagePricing;
  const estimatedUsage = pricing?.estimatedUsage;
  if (!usagePricing || !estimatedUsage) return undefined;

  const defaultParams = pricing?.defaultParams;
  const creditsPerUsd = getCreditsPerUsd(pricing);
  const outputImages = getDefaultOutputImageCount(defaultParams);
  const inputImages = getDefaultInputImageCount(defaultParams);

  const credits =
    usageCostCredits(estimatedUsage.textInputTokens, usagePricing.textInputUsdPerMillion, creditsPerUsd)
    + usageCostCredits(
      inputImages * (estimatedUsage.imageInputTokensPerImage ?? 0),
      usagePricing.imageInputUsdPerMillion,
      creditsPerUsd,
    )
    + usageCostCredits(estimatedUsage.cachedInputTokens, usagePricing.cachedInputUsdPerMillion, creditsPerUsd)
    + usageCostCredits(
      estimatedUsage.cachedImageInputTokens,
      usagePricing.cachedImageInputUsdPerMillion,
      creditsPerUsd,
    )
    + usageCostCredits(estimatedUsage.textOutputTokens, usagePricing.textOutputUsdPerMillion, creditsPerUsd)
    + usageCostCredits(
      outputImages * (estimatedUsage.imageOutputTokensPerImage ?? 0),
      usagePricing.imageOutputUsdPerMillion,
      creditsPerUsd,
    )
    + usageCostCredits(estimatedUsage.thinkingOutputTokens, usagePricing.thinkingOutputUsdPerMillion, creditsPerUsd);

  return credits > 0 ? credits : undefined;
};

const getEstimatedRequestCredits = (model: MediaModel): number | undefined => {
  const clientEstimate = getClientEstimateConfig(model);
  if (clientEstimate) return clientEstimate.credits;
  if (!isTokenBillingModel(model)) return undefined;
  const unitCredits = toFiniteNumber(model.unitCredits);
  if (unitCredits && unitCredits > 0) return unitCredits;
  return calculateEstimatedTokenCredits(model);
};

const formatCreditAmount = (credits: number): string => {
  if (Number.isInteger(credits)) return credits.toString();
  return credits.toFixed(2).replace(/\.?0+$/, '');
};

const formatEstimatedCredits = (credits: number): string => {
  return Math.max(1, Math.round(credits)).toString();
};

const getModelPriceLabel = (model: MediaModel): string | null => {
  if (model.mediaType !== 'image') return null;
  if (isTokenBillingModel(model)) {
    const estimatedCredits = getEstimatedRequestCredits(model);
    if (!estimatedCredits) return null;
    return `≈${formatEstimatedCredits(estimatedCredits)} ${i18nService.t('authCreditsUnit')}/${model.unitLabel || '次'}`;
  }
  const unitCredits = toFiniteNumber(model.unitCredits);
  if (!unitCredits || unitCredits <= 0) return null;
  return `x${formatCreditAmount(unitCredits)} ${i18nService.t('authCreditsUnit')}/${model.unitLabel || '张'}`;
};

const getModelDiscountLabel = (model: MediaModel): string | null => {
  return getClientEstimateConfig(model)?.discountLabel ?? null;
};

const normalizeModelDescription = (description?: string): string | undefined => {
  if (!description) return undefined;
  const normalized = description.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').trim();
  return normalized || undefined;
};

const getTokenPricingRows = (model: MediaModel): Array<{ label: string; creditsPerMillion: number }> => {
  const pricing = getPricingConfig(model);
  if (pricing?.billingUnit !== 'per_token' || !pricing.usagePricing) return [];
  const creditsPerUsd = getCreditsPerUsd(pricing);
  return TOKEN_PRICING_FIELDS
    .map(({ key, labelKey }) => {
      const usdPerMillion = toFiniteNumber(pricing.usagePricing?.[key]);
      if (!usdPerMillion || usdPerMillion <= 0) return null;
      return {
        label: i18nService.t(labelKey),
        creditsPerMillion: usdPerMillion * creditsPerUsd,
      };
    })
    .filter((row): row is { label: string; creditsPerMillion: number } => row !== null);
};

const formatChineseEstimateScope = (config: ClientEstimateConfig): string => {
  const parts: string[] = [];
  if (config.inputImageCount > 0) parts.push(`${config.inputImageCount} 张输入图`);
  if (config.outputImageCount > 0) parts.push(`${config.outputImageCount} 张输出图`);
  return parts.length > 0 ? `按 ${parts.join('和 ')}估算` : '按默认参数估算';
};

const formatEnglishImageCount = (count: number, label: string): string => {
  return `${count} ${label} image${count === 1 ? '' : 's'}`;
};

const formatEnglishEstimateScope = (config: ClientEstimateConfig): string => {
  const parts: string[] = [];
  if (config.inputImageCount > 0) parts.push(formatEnglishImageCount(config.inputImageCount, 'input'));
  if (config.outputImageCount > 0) parts.push(formatEnglishImageCount(config.outputImageCount, 'output'));
  return parts.length > 0 ? `assumes ${parts.join(' and ')}` : 'assumes default parameters';
};

const getTokenBillingEstimateNotes = (model: MediaModel): string[] => {
  const clientEstimate = getClientEstimateConfig(model);
  if (!clientEstimate) {
    return [i18nService.t('mediaTokenBillingEstimateNote')];
  }

  const creditsUnit = i18nService.t('authCreditsUnit');
  const formula = clientEstimate.usageParts
    .map(part => `${formatCreditAmount(part.tokens)}×${formatCreditAmount(part.creditsPerMillion)}/1M`)
    .join(' + ');

  if (i18nService.getLanguage() === 'zh') {
    const usage = clientEstimate.usageParts
      .map(part => `${formatCreditAmount(part.tokens)} ${part.zhLabel}`)
      .join('、');
    return [
      `预估计算：${formatChineseEstimateScope(clientEstimate)}，约 ${usage}：${formula} ≈ ${formatEstimatedCredits(clientEstimate.credits)} ${creditsUnit}。`,
      '实际扣费按本次输入和输出 token 计算，输入图片数量、尺寸、输出复杂度不同，会与预估存在差异。',
    ];
  }

  const usage = clientEstimate.usageParts
    .map(part => `${formatCreditAmount(part.tokens)} ${part.enLabel}`)
    .join(', ');
  return [
    `Estimate: ${formatEnglishEstimateScope(clientEstimate)}, about ${usage}: ${formula} ≈ ${formatEstimatedCredits(clientEstimate.credits)} ${creditsUnit}.`,
    'Actual billing is calculated from the request input and output tokens. Image count, size, and output complexity can make actual cost differ from the estimate.',
  ];
};

const resolveMediaModelIcon = (model: MediaModel): React.ReactNode => {
  const text = `${model.displayName} ${model.modelId}`;
  const hint = MEDIA_ICON_HINTS.find(({ pattern }) => pattern.test(text));
  return getProviderIcon(hint?.iconKey ?? ProviderName.Custom);
};

interface MediaModelPickerProps {
  draftKey: string;
  disabled?: boolean;
}

const MediaModelPicker: React.FC<MediaModelPickerProps> = ({ draftKey, disabled }) => {
  const dispatch = useDispatch();
  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'image' | 'video'>('image');
  const [isLoading, setIsLoading] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [hoveredModel, setHoveredModel] = useState<MediaModel | null>(null);
  const [hoverCardStyle, setHoverCardStyle] = useState<React.CSSProperties>({});
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isLoggedIn = useSelector((state: RootState) => state.auth.isLoggedIn);
  const authQuota = useSelector((state: RootState) => state.auth.quota);
  const canUseMediaGeneration = isLoggedIn && (authQuota?.subscriptionStatus === 'active' || authQuota?.hasPaidCredits === true);

  const mediaModels = useSelector((state: RootState) => state.cowork.mediaModels);
  const selection = useSelector((state: RootState) => state.cowork.mediaSelection[draftKey]);

  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  const fetchModels = useCallback(async () => {
    const hasCachedModels = mediaModels.image.length > 0 || mediaModels.video.length > 0;
    if (!hasCachedModels) {
      setIsLoading(true);
    }
    try {
      const [imageResult, videoResult] = await Promise.all([
        window.electron.media.getModels('image'),
        window.electron.media.getModels('video'),
      ]);
      if (!imageResult.success) console.warn('[MediaModelPicker] image models fetch failed:', imageResult.error);
      if (!videoResult.success) console.warn('[MediaModelPicker] video models fetch failed:', videoResult.error);
      const imageModels = ((imageResult.models || []) as MediaModel[]).map(normalizeMediaModel);
      const videoModels = ((videoResult.models || []) as MediaModel[]).map(normalizeMediaModel);
      dispatch(setMediaModels({
        image: imageModels,
        video: videoModels,
      }));
      const currentSelection = selectionRef.current;
      if (!currentSelection || currentSelection.mode === 'none') {
        const rawSaved = await localStore.getItem<SavedMediaSelection>(MEDIA_SELECTION_KV_KEY);
        const saved = normalizeSavedMediaSelection(rawSaved);
        if (!isSameSavedMediaSelection(rawSaved, saved)) {
          localStore.setItem(MEDIA_SELECTION_KV_KEY, saved);
        }
        const imageEntry = saved?.image;
        const videoEntry = saved?.video;
        const imageValid = imageEntry && imageModels.some(m => m.modelId === imageEntry.modelId);
        const videoValid = videoEntry && videoModels.some(m => m.modelId === videoEntry.modelId);

        if (imageValid && videoValid) {
          dispatch(setMediaSelection({
            draftKey,
            selection: {
              mode: 'auto',
              modelId: imageEntry.modelId,
              modelName: imageEntry.modelName,
              imageModelId: imageEntry.modelId,
              videoModelId: videoEntry!.modelId,
            },
          }));
        } else if (imageValid) {
          dispatch(setMediaSelection({
            draftKey,
            selection: { mode: 'image', modelId: imageEntry.modelId, modelName: imageEntry.modelName },
          }));
        } else if (videoValid) {
          dispatch(setMediaSelection({
            draftKey,
            selection: { mode: 'video', modelId: videoEntry!.modelId, modelName: videoEntry!.modelName },
          }));
          setActiveTab('video');
        }
      }
    } catch (err) {
      console.error('[MediaModelPicker] Failed to fetch models:', err);
    } finally {
      setIsLoading(false);
    }
  }, [dispatch, draftKey, mediaModels.image.length, mediaModels.video.length]);

  useEffect(() => {
    if (isOpen && canUseMediaGeneration) {
      fetchModels();
    }
  }, [isOpen, canUseMediaGeneration, fetchModels]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
          buttonRef.current && !buttonRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  useEffect(() => {
    if (selection && selection.mode !== 'none') return;

    let cancelled = false;
    (async () => {
      const rawSaved = await localStore.getItem<SavedMediaSelection>(MEDIA_SELECTION_KV_KEY);
      const saved = normalizeSavedMediaSelection(rawSaved);
      if (!isSameSavedMediaSelection(rawSaved, saved)) {
        localStore.setItem(MEDIA_SELECTION_KV_KEY, saved);
      }
      if (cancelled) return;
      const imageEntry = saved?.image;
      const videoEntry = saved?.video;
      if (imageEntry && videoEntry) {
        dispatch(setMediaSelection({
          draftKey,
          selection: {
            mode: 'auto',
            modelId: imageEntry.modelId,
            modelName: imageEntry.modelName,
            imageModelId: imageEntry.modelId,
            videoModelId: videoEntry.modelId,
          },
        }));
      } else if (imageEntry) {
        dispatch(setMediaSelection({
          draftKey,
          selection: { mode: 'image', modelId: imageEntry.modelId, modelName: imageEntry.modelName },
        }));
      } else if (videoEntry) {
        dispatch(setMediaSelection({
          draftKey,
          selection: { mode: 'video', modelId: videoEntry.modelId, modelName: videoEntry.modelName },
        }));
        setActiveTab('video');
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, dispatch]);

  const handleSelect = async (mode: MediaGenerationMode, model?: MediaModel) => {
    const saved = normalizeSavedMediaSelection(await localStore.getItem<SavedMediaSelection>(MEDIA_SELECTION_KV_KEY));
    const currentModelId = mode === 'image'
      ? canonicalizeMediaModelId(selection?.imageModelId ?? (selection?.mode === 'image' ? selection?.modelId : undefined))
      : canonicalizeMediaModelId(selection?.videoModelId ?? (selection?.mode === 'video' ? selection?.modelId : undefined));
    const isDeselect = model && currentModelId === model.modelId;

    if (isDeselect) {
      delete saved[mode as 'image' | 'video'];
    } else if (model) {
      saved[mode as 'image' | 'video'] = { modelId: model.modelId, modelName: model.displayName };
    }
    localStore.setItem(MEDIA_SELECTION_KV_KEY, saved);

    const hasImage = !!saved.image;
    const hasVideo = !!saved.video;

    if (hasImage && hasVideo) {
      dispatch(setMediaSelection({
        draftKey,
        selection: {
          mode: 'auto',
          modelId: saved[mode as 'image' | 'video']?.modelId,
          modelName: saved[mode as 'image' | 'video']?.modelName,
          imageModelId: saved.image!.modelId,
          videoModelId: saved.video!.modelId,
        },
      }));
    } else if (hasImage) {
      dispatch(setMediaSelection({
        draftKey,
        selection: { mode: 'image', modelId: saved.image!.modelId, modelName: saved.image!.modelName },
      }));
    } else if (hasVideo) {
      dispatch(setMediaSelection({
        draftKey,
        selection: { mode: 'video', modelId: saved.video!.modelId, modelName: saved.video!.modelName },
      }));
    } else {
      dispatch(setMediaSelection({ draftKey, selection: { mode: 'none' } }));
    }
  };

  const handleLogin = async () => {
    setIsOpen(false);
    await authService.login();
  };

  const handleSubscribe = async () => {
    setIsOpen(false);
    const { getPortalPricingUrl } = await import('../../services/endpoints');
    await window.electron.shell.openExternal(getPortalPricingUrl());
  };

  const handleModelHover = (model: MediaModel, event: React.MouseEvent<HTMLButtonElement>) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    const itemRect = event.currentTarget.getBoundingClientRect();
    hoverTimerRef.current = setTimeout(() => {
      const desc = normalizeModelDescription(model.description || model.capabilities || model.pricingDescription);
      const hasPricingDetails = Boolean(getModelPriceLabel(model)) || getTokenPricingRows(model).length > 0;
      if (!desc && !hasPricingDetails) {
        setHoveredModel(null);
        return;
      }
      const dropdownEl = dropdownRef.current;
      if (!dropdownEl) return;
      const dropdownRect = dropdownEl.getBoundingClientRect();
      const spaceRight = window.innerWidth - dropdownRect.right;
      const cardWidth = 280;
      const style: React.CSSProperties = {
        position: 'fixed',
        zIndex: 10001,
      };
      const cardHeight = 300;
      if (itemRect.top + cardHeight > window.innerHeight) {
        style.bottom = 8;
      } else {
        style.top = itemRect.top;
      }
      if (spaceRight >= cardWidth + 8) {
        style.left = dropdownRect.right + 8;
      } else {
        style.right = window.innerWidth - dropdownRect.left + 8;
      }
      setHoverCardStyle(style);
      setHoveredModel(model);
    }, 200);
  };

  const handleModelHoverEnd = () => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setHoveredModel(null);
  };

  useEffect(() => {
    if (!isOpen) setHoveredModel(null);
  }, [isOpen]);

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    };
  }, []);

  const renderHoverCard = () => {
    if (!hoveredModel) return null;
    const desc = normalizeModelDescription(hoveredModel.description || hoveredModel.capabilities || hoveredModel.pricingDescription);
    const unitLabel = hoveredModel.unitLabel || (hoveredModel.mediaType === 'image' ? '张' : '个');
    const pricing = getPricingConfig(hoveredModel);
    const discountLabel = getModelDiscountLabel(hoveredModel);
    const tiers = pricing?.tiers;
    const billingUnit = pricing?.billingUnit;
    const tokenPricingRows = getTokenPricingRows(hoveredModel);
    const tokenBillingEstimateNotes = getTokenBillingEstimateNotes(hoveredModel);

    const formatTierLabel = (tier: { resolution?: string; duration?: number; audio?: boolean; hasVideoInput?: boolean }) => {
      const parts: string[] = [];
      if (tier.resolution) parts.push(tier.resolution);
      if (tier.duration) parts.push(`${tier.duration}秒`);
      if (tier.audio) parts.push('有声音');
      if (tier.hasVideoInput === true) parts.push('含视频输入');
      if (tier.hasVideoInput === false) parts.push('不含视频输入');
      return parts.join(' ') || '-';
    };

    const tierCredits = (tier: { costYuan?: number; pricePerMillionTokens?: number }) => {
      if (tier.pricePerMillionTokens != null) return Math.round(tier.pricePerMillionTokens * 100);
      if (tier.costYuan != null) return Math.round(tier.costYuan * 100);
      return 0;
    };

    const tierUnitSuffix = billingUnit === 'per_second' ? '秒'
      : billingUnit === 'per_video' ? '个'
      : billingUnit === 'per_token' ? '百万tokens'
      : unitLabel;

    const hasVideoInputTiers = tiers && tiers.some(t => t.hasVideoInput !== undefined);
    const tierRows = (() => {
      if (!tiers || tiers.length <= 1) return null;
      if (!hasVideoInputTiers) return null;
      const resolutions = [...new Set(tiers.map(t => t.resolution).filter(Boolean))] as string[];
      return resolutions.map(res => {
        const withVideo = tiers.find(t => t.resolution === res && t.hasVideoInput === true);
        const withoutVideo = tiers.find(t => t.resolution === res && t.hasVideoInput === false);
        return { resolution: res, withVideo, withoutVideo };
      });
    })();

    const card = (
      <div style={hoverCardStyle} className="w-[280px] rounded-xl border border-border bg-surface shadow-popover p-3 pointer-events-none">
        <div className="flex min-w-0 items-center gap-1.5 text-[13px] font-semibold text-foreground leading-5">
          <span className="min-w-0 truncate">{hoveredModel.displayName}</span>
          {discountLabel && (
            <span className="shrink-0 rounded bg-red-500/10 px-1 py-0.5 text-[9px] font-medium leading-3 text-red-500">
              {discountLabel}
            </span>
          )}
        </div>
        {desc && (
          <div className="mt-1 whitespace-pre-line text-[11px] text-secondary leading-4">
            {desc}
          </div>
        )}
        {tokenPricingRows.length > 0 ? (
          <>
            <table className="mt-2 w-full text-[10px] text-secondary border-collapse">
              <thead>
                <tr className="border-b border-border/50">
                  <th className="text-left font-medium py-0.5 pr-2">{i18nService.t('mediaTierSpecLabel')}</th>
                  <th className="text-right font-medium py-0.5">
                    {i18nService.t('authCreditsUnit')}/{i18nService.t('mediaMillionTokensUnit')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {tokenPricingRows.map((row) => (
                  <tr key={row.label}>
                    <td className="py-0.5 pr-2">{row.label}</td>
                    <td className="text-right py-0.5">{formatCreditAmount(row.creditsPerMillion)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-1.5 space-y-1 text-[9px] leading-3 text-tertiary">
              {tokenBillingEstimateNotes.map((note, index) => (
                <div key={index}>{note}</div>
              ))}
            </div>
          </>
        ) : tiers && tiers.length > 1 ? (
          tierRows ? (
            <table className="mt-2 w-full text-[10px] text-secondary border-collapse">
              <thead>
                <tr className="border-b border-border/50">
                  <th className="text-left font-medium py-0.5 pr-1"></th>
                  <th className="text-right font-medium py-0.5 px-1">含视频输入</th>
                  <th className="text-right font-medium py-0.5">不含视频输入</th>
                </tr>
              </thead>
              <tbody>
                {tierRows.map((row) => (
                  <tr key={row.resolution}>
                    <td className="py-0.5 pr-1">{row.resolution}</td>
                    <td className="text-right py-0.5 px-1">{row.withVideo ? tierCredits(row.withVideo) : '-'}</td>
                    <td className="text-right py-0.5">{row.withoutVideo ? tierCredits(row.withoutVideo) : '-'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border/50">
                  <td colSpan={3} className="text-right pt-0.5 text-[9px] text-tertiary">
                    {i18nService.t('authCreditsUnit')}/{tierUnitSuffix}
                  </td>
                </tr>
              </tfoot>
            </table>
          ) : (
            <table className="mt-2 w-full text-[10px] text-secondary border-collapse">
              <thead>
                <tr className="border-b border-border/50">
                  <th className="text-left font-medium py-0.5 pr-2">{i18nService.t('mediaTierSpecLabel')}</th>
                  <th className="text-right font-medium py-0.5">{i18nService.t('authCreditsUnit')}/{tierUnitSuffix}</th>
                </tr>
              </thead>
              <tbody>
                {tiers.map((tier, i) => (
                  <tr key={i}>
                    <td className="py-0.5 pr-2">{formatTierLabel(tier)}</td>
                    <td className="text-right py-0.5">{tierCredits(tier)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : hoveredModel.unitCredits != null && hoveredModel.unitCredits > 0 ? (
          <div className="mt-2 text-[11px] text-secondary">
            ({i18nService.t('modelCostMultiplierLabel')} {hoveredModel.unitCredits} {i18nService.t('authCreditsUnit')}/{unitLabel})
          </div>
        ) : null}
      </div>
    );
    return createPortal(card, document.body);
  };

  const currentModels = activeTab === 'image' ? mediaModels.image : mediaModels.video;

  const triggerIcon = (
    <MagicIcon className="h-5 w-5" />
  );

  const renderPromptPanel = (title: string, desc: string, btnLabel: string, onBtn: () => void, secondaryLabel?: string, onSecondary?: () => void) => (
    <div className="px-4 py-5">
      <div className="flex justify-center mb-3">
        <Lottie
          animationData={mediaGenAnimation}
          loop={false}
          autoplay={true}
          style={{ width: 80, height: 80 }}
          key={Date.now()}
        />
      </div>
      <div className="text-[13px] font-medium text-foreground text-center">{title}</div>
      <div className="text-[12px] text-secondary mt-1 text-center">{desc}</div>
      <button
        type="button"
        onClick={onBtn}
        className="mt-3 w-full rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-white hover:bg-primary/90 transition-colors"
      >
        {btnLabel}
      </button>
      {secondaryLabel && onSecondary && (
        <div
          onClick={onSecondary}
          className="mt-2 text-center text-[12px] text-secondary hover:text-foreground cursor-pointer transition-colors"
        >
          {secondaryLabel}
        </div>
      )}
    </div>
  );

  const renderDropdownContent = () => {
    if (!isLoggedIn) {
      return renderPromptPanel(
        i18nService.t('mediaLoginTitle'),
        i18nService.t('mediaLoginDesc'),
        i18nService.t('mediaLoginBtn'),
        handleLogin,
        i18nService.t('mediaLearnMore'),
        handleSubscribe,
      );
    }

    if (!canUseMediaGeneration) {
      return renderPromptPanel(
        i18nService.t('mediaSubscribeTitle'),
        i18nService.t('mediaSubscribeDesc'),
        i18nService.t('mediaSubscribeBtn'),
        handleSubscribe,
      );
    }

  const handleTabSwitch = (tab: 'image' | 'video') => {
    setActiveTab(tab);
  };

    return (
      <>
        {/* Tabs */}
        <div className="border-b border-border/60 p-2">
          <div className="flex rounded-lg bg-surface-raised p-0.5" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'image'}
              onClick={() => handleTabSwitch('image')}
              className={`min-w-0 flex-1 rounded-md px-2 py-1.5 text-center text-[12px] font-medium leading-4 transition-colors ${
                activeTab === 'image'
                  ? 'bg-surface text-foreground shadow-sm'
                  : 'text-secondary hover:text-foreground'
              }`}
            >
              <span className="truncate">{i18nService.t('mediaImage')}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'video'}
              onClick={() => handleTabSwitch('video')}
              className={`min-w-0 flex-1 rounded-md px-2 py-1.5 text-center text-[12px] font-medium leading-4 transition-colors ${
                activeTab === 'video'
                  ? 'bg-surface text-foreground shadow-sm'
                  : 'text-secondary hover:text-foreground'
              }`}
            >
              <span className="truncate">{i18nService.t('mediaVideo')}</span>
            </button>
          </div>
        </div>

        {/* Model List */}
        <div className="max-h-72 overflow-y-auto py-1">
          {isLoading ? (
            <div className="px-2 py-3 text-center text-xs text-secondary">
              {i18nService.t('mediaLoadingModels')}
            </div>
          ) : currentModels.length === 0 ? (
            <div className="px-2 py-3 text-center text-xs text-secondary">
              {i18nService.t('mediaNoModels')}
            </div>
          ) : (
            currentModels.map((model) => {
              const isSelected = activeTab === 'image'
                ? (canonicalizeMediaModelId(selection?.imageModelId) === model.modelId
                  || (selection?.mode === 'image' && canonicalizeMediaModelId(selection?.modelId) === model.modelId))
                : (canonicalizeMediaModelId(selection?.videoModelId) === model.modelId
                  || (selection?.mode === 'video' && canonicalizeMediaModelId(selection?.modelId) === model.modelId));
              const priceLabel = getModelPriceLabel(model);
              const discountLabel = getModelDiscountLabel(model);
              return (
                <button
                  key={model.modelId}
                  type="button"
                  onClick={() => handleSelect(activeTab, model)}
                  onMouseEnter={(e) => handleModelHover(model, e)}
                  onMouseLeave={handleModelHoverEnd}
                  className={`flex w-full items-center gap-2.5 rounded px-2 py-2 text-left text-xs transition-colors hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover ${isSelected ? 'dark:bg-claude-darkSurfaceHover/50 bg-claude-surfaceHover/50' : ''}`}
                >
                  <span className="shrink-0 h-4 w-4 [&_svg]:h-4 [&_svg]:w-4">{resolveMediaModelIcon(model)}</span>
                  <span className="min-w-0 truncate text-[13px] font-normal leading-5">{model.displayName}</span>
                  {activeTab === 'image' && priceLabel && (
                    <span className="shrink-0 text-[11px] text-secondary whitespace-nowrap">
                      {priceLabel}
                    </span>
                  )}
                  {activeTab === 'image' && discountLabel && (
                    <span className="shrink-0 rounded bg-red-500/10 px-1 py-0.5 text-[9px] font-medium leading-3 text-red-500">
                      {discountLabel}
                    </span>
                  )}
                  <span className="flex-1" />
                  {isSelected && (
                    <CheckIcon className="h-4 w-4 shrink-0 text-emerald-500" />
                  )}
                </button>
              );
            })
          )}
        </div>
      </>
    );
  };

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        onClick={() => setIsOpen(!isOpen)}
        className={`flex h-[34px] w-[34px] items-center justify-center rounded-lg transition-colors ${
          selection && selection.mode !== 'none'
            ? 'text-foreground hover:bg-surface-raised'
            : 'text-secondary hover:bg-surface-raised hover:text-foreground/80'
        } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
      >
        {triggerIcon}
      </button>

      {isOpen && (
        <div
          ref={dropdownRef}
          className="absolute bottom-full left-0 z-50 mb-1 w-60 rounded-xl border border-border bg-surface shadow-popover overflow-hidden"
        >
          {renderDropdownContent()}
        </div>
      )}
      {renderHoverCard()}
    </div>
  );
};

export default MediaModelPicker;
