import { LOBSTERAI_REQUEST_OPTIONS_VERSION } from './requestOptionsProtocol';

export const LobsterAIThinkingLevel = {
  Off: 'off',
  Minimal: 'minimal',
  Low: 'low',
  Medium: 'medium',
  High: 'high',
  XHigh: 'xhigh',
  Max: 'max',
} as const;

export type LobsterAIThinkingLevel =
  typeof LobsterAIThinkingLevel[keyof typeof LobsterAIThinkingLevel];

export const LobsterAIOpenClawThinkingLevel = {
  Off: 'off',
  Minimal: 'minimal',
  Low: 'low',
  Medium: 'medium',
  High: 'high',
  XHigh: 'xhigh',
} as const;

export type LobsterAIOpenClawThinkingLevel =
  typeof LobsterAIOpenClawThinkingLevel[keyof typeof LobsterAIOpenClawThinkingLevel];

export type LobsterAIThinkingOption = {
  level: LobsterAIThinkingLevel;
  openclawLevel: LobsterAIOpenClawThinkingLevel;
};

export type LobsterAIThinkingProfile = {
  options: LobsterAIThinkingOption[];
  defaultLevel: LobsterAIThinkingLevel;
  requestOptionsVersion?: typeof LOBSTERAI_REQUEST_OPTIONS_VERSION;
};

export type LobsterAIThinkingProfileMap = Record<string, LobsterAIThinkingProfile>;

export type LobsterAIOpenClawThinkingProfile = {
  levels: Array<{ id: string; label: string }>;
  defaultLevel: string;
  preserveWhenCatalogReasoningFalse: true;
};

const LEVELS = new Set<string>(Object.values(LobsterAIThinkingLevel));
const OPENCLAW_LEVELS = new Set<string>(Object.values(LobsterAIOpenClawThinkingLevel));

const isRecord = (value: unknown): value is Record<string, unknown> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
);

const isModelRef = (value: string): boolean => {
  const separatorIndex = value.indexOf('/');
  return separatorIndex > 0
    && separatorIndex < value.length - 1
    && !/\s/.test(value);
};

const parseThinkingProfile = (value: unknown): LobsterAIThinkingProfile | undefined => {
  if (!isRecord(value) || !Array.isArray(value.options) || value.options.length === 0) {
    return undefined;
  }
  const options: LobsterAIThinkingOption[] = [];
  const seenLevels = new Set<string>();
  const seenOpenClawLevels = new Set<string>();
  for (const rawOption of value.options) {
    if (!isRecord(rawOption)) {
      return undefined;
    }
    const { level, openclawLevel } = rawOption;
    if (
      typeof level !== 'string'
      || !LEVELS.has(level)
      || seenLevels.has(level)
      || typeof openclawLevel !== 'string'
      || !OPENCLAW_LEVELS.has(openclawLevel)
      || seenOpenClawLevels.has(openclawLevel)
      || (level === LobsterAIThinkingLevel.Off)
        !== (openclawLevel === LobsterAIOpenClawThinkingLevel.Off)
    ) {
      return undefined;
    }
    seenLevels.add(level);
    seenOpenClawLevels.add(openclawLevel);
    options.push({
      level: level as LobsterAIThinkingLevel,
      openclawLevel: openclawLevel as LobsterAIOpenClawThinkingLevel,
    });
  }
  if (options.length === 1 && options[0]?.level === LobsterAIThinkingLevel.Off) {
    return undefined;
  }
  if (typeof value.defaultLevel !== 'string' || !seenLevels.has(value.defaultLevel)) {
    return undefined;
  }
  return {
    options,
    defaultLevel: value.defaultLevel as LobsterAIThinkingLevel,
    ...(value.requestOptionsVersion === LOBSTERAI_REQUEST_OPTIONS_VERSION
      ? { requestOptionsVersion: LOBSTERAI_REQUEST_OPTIONS_VERSION }
      : {}),
  };
};

export const parseThinkingProfileMap = (value: unknown): LobsterAIThinkingProfileMap => {
  if (!isRecord(value)) return {};
  const result: LobsterAIThinkingProfileMap = {};
  for (const [modelRef, rawProfile] of Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right))) {
    const profile = parseThinkingProfile(rawProfile);
    if (isModelRef(modelRef) && profile) {
      result[modelRef] = profile;
    }
  }
  return result;
};

export const resolveOpenClawThinkingProfile = (
  profile: LobsterAIThinkingProfile | undefined,
  hasKimiK3RuntimeProfile: boolean,
): LobsterAIOpenClawThinkingProfile | undefined => {
  if (profile) {
    const defaultOpenClawLevel = profile.options.find(
      option => option.level === profile.defaultLevel,
    )?.openclawLevel;
    if (!defaultOpenClawLevel) return undefined;
    return {
      levels: profile.options.map(option => ({
        id: option.openclawLevel,
        label: option.level,
      })),
      defaultLevel: defaultOpenClawLevel,
      preserveWhenCatalogReasoningFalse: true,
    };
  }
  if (!hasKimiK3RuntimeProfile) return undefined;
  return {
    levels: [{ id: 'max', label: 'max' }],
    defaultLevel: 'max',
    preserveWhenCatalogReasoningFalse: true,
  };
};
