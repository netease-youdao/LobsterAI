import { canonicalizeMediaModelId, mediaModelDisplayName } from '../mediaModelAliases';

export const MediaType = { Image: 'image', Video: 'video' } as const;
export type MediaType = typeof MediaType[keyof typeof MediaType];
export const MediaSelectionMode = { Auto: 'auto', Image: 'image', Video: 'video', None: 'none' } as const;
export type MediaSelectionMode = typeof MediaSelectionMode[keyof typeof MediaSelectionMode];
export const MediaPreferenceMode = { Inherit: 'inherit', Off: 'off', Selected: 'selected' } as const;
export const MediaSelectionSource = { User: 'user', Default: 'default', Off: 'off' } as const;
export type MediaSelectionSource = typeof MediaSelectionSource[keyof typeof MediaSelectionSource];
export const MediaDefaultsProtocol = {
  SchemaVersion: 1,
  Capability: 'media-default-policy-v1',
  CapabilityHeader: 'X-Lobster-Media-Capabilities',
  Endpoint: '/api/media/default-policy',
  EverySubmission: 'every_submission',
  PreferenceKey: 'media_preferences.v1',
  LegacyKey: 'media_selection',
} as const;

export type MediaPreference =
  | { mode: 'inherit' }
  | { mode: 'off' }
  | { mode: 'selected'; modelId: string; modelName: string };

export interface MediaPreferences {
  schemaVersion: 1;
  revision: number;
  image: MediaPreference;
  video: MediaPreference;
}

export interface MediaDefaultModel {
  enabled: true;
  modelId: string;
  modelName: string;
  params: Record<string, string | number>;
  maxOutputsPerTurn: number;
  confirmation?: string | null;
}

export interface MediaDefaultPolicy {
  schemaVersion: 1;
  policyVersion: string;
  ttlSeconds: number;
  eligible: boolean;
  defaults: Partial<Record<MediaType, MediaDefaultModel>>;
}

export interface MediaSelection {
  mode: MediaSelectionMode;
  modelId?: string;
  modelName?: string;
  imageModelId?: string;
  videoModelId?: string;
  imagePreference?: MediaPreference['mode'];
  videoPreference?: MediaPreference['mode'];
  imageSource?: MediaSelectionSource;
  videoSource?: MediaSelectionSource;
  imageDefault?: MediaDefaultModel;
  videoDefault?: MediaDefaultModel;
  policyVersion?: string;
  preferencesRevision?: number;
}

export interface MediaPreferenceState {
  ownerAccountKey: string;
  preferences: MediaPreferences;
  selection: MediaSelection;
  policyVersion?: string;
}
export interface MediaPreferenceResult {
  success: boolean;
  state?: MediaPreferenceState;
  error?: string;
}

export const mediaPreferenceKey = (owner: string): string => `${MediaDefaultsProtocol.PreferenceKey}:${owner}`;

const object = (value: unknown): Record<string, unknown> | undefined => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
);

export function parseMediaPreference(value: unknown): MediaPreference {
  const entry = object(value);
  if (entry?.mode === MediaPreferenceMode.Inherit || entry?.mode === MediaPreferenceMode.Off) {
    return { mode: entry.mode };
  }
  if (entry?.mode === MediaPreferenceMode.Selected
    && typeof entry.modelId === 'string' && entry.modelId.trim()
    && typeof entry.modelName === 'string') {
    const modelId = canonicalizeMediaModelId(entry.modelId);
    return { mode: MediaPreferenceMode.Selected, modelId, modelName: mediaModelDisplayName(modelId, entry.modelName) };
  }
  throw new Error('Invalid media preference');
}

/** Existing empty or missing per-type entries are conservatively migrated to off. */
export function migrateMediaPreferences(stored: unknown, legacy: unknown): MediaPreferences {
  if (stored != null) {
    const record = object(stored);
    if (record?.schemaVersion !== MediaDefaultsProtocol.SchemaVersion
      || !Number.isSafeInteger(record.revision) || (record.revision as number) < 0) {
      throw new Error('Invalid stored media preferences');
    }
    return { schemaVersion: 1, revision: record.revision as number,
      image: parseMediaPreference(record.image), video: parseMediaPreference(record.video) };
  }
  const mode = legacy == null ? MediaPreferenceMode.Inherit : MediaPreferenceMode.Off;
  const next: MediaPreferences = { schemaVersion: 1, revision: 0, image: { mode }, video: { mode } };
  if (legacy == null) return next;
  const record = object(legacy);
  if (!record) throw new Error('Invalid legacy media preferences');
  for (const type of Object.values(MediaType)) {
    if (record[type] != null) {
      const entry = object(record[type]);
      next[type] = parseMediaPreference({ ...entry, mode: MediaPreferenceMode.Selected });
    }
  }
  return next;
}

export function parseMediaDefaultPolicy(value: unknown): MediaDefaultPolicy | undefined {
  const data = object(value);
  const defaults = object(data?.defaults);
  if (data?.schemaVersion !== 1 || typeof data.policyVersion !== 'string'
    || !data.policyVersion.trim() || data.policyVersion.length > 128
    || typeof data.eligible !== 'boolean' || !Number.isInteger(data.ttlSeconds)
    || (data.ttlSeconds as number) < 60 || (data.ttlSeconds as number) > 3600 || !defaults) return undefined;
  const result: MediaDefaultPolicy = { schemaVersion: 1, policyVersion: data.policyVersion,
    eligible: data.eligible, ttlSeconds: data.ttlSeconds as number, defaults: {} };
  for (const type of Object.values(MediaType)) {
    if (defaults[type] == null) continue;
    const entry = object(defaults[type]);
    const params = object(entry?.params);
    if (!entry || entry.enabled !== true || typeof entry.modelId !== 'string' || !entry.modelId.trim()
      || typeof entry.modelName !== 'string' || entry.maxOutputsPerTurn !== 1 || !params) return undefined;
    if (type === MediaType.Image) {
      if (typeof params.size !== 'string' || params.n !== 1
        || Object.keys(params).some(key => !['size', 'n'].includes(key))) return undefined;
    } else if (entry.confirmation !== MediaDefaultsProtocol.EverySubmission
      || typeof params.resolution !== 'string' || !Number.isInteger(params.durationSeconds)
      || (params.durationSeconds as number) < 1 || (params.durationSeconds as number) > 15
      || Object.keys(params).some(key => !['resolution', 'durationSeconds'].includes(key))) return undefined;
    result.defaults[type] = {
      enabled: true, modelId: canonicalizeMediaModelId(entry.modelId), modelName: entry.modelName,
      params: { ...params } as Record<string, string | number>, maxOutputsPerTurn: 1,
      ...(type === MediaType.Video ? { confirmation: MediaDefaultsProtocol.EverySubmission } : {}),
    };
  }
  return result;
}

export function resolveMediaPreferences(preferences: MediaPreferences, policy?: MediaDefaultPolicy): MediaSelection {
  const selection: MediaSelection = { mode: MediaSelectionMode.None, preferencesRevision: preferences.revision };
  for (const type of Object.values(MediaType)) {
    const preference = preferences[type];
    selection[type === MediaType.Image ? 'imagePreference' : 'videoPreference'] = preference.mode;
    const configured = policy?.eligible ? policy.defaults[type] : undefined;
    const picked = preference.mode === MediaPreferenceMode.Selected ? preference
      : preference.mode === MediaPreferenceMode.Inherit ? configured : undefined;
    const source = preference.mode === MediaPreferenceMode.Selected ? MediaSelectionSource.User
      : picked ? MediaSelectionSource.Default : MediaSelectionSource.Off;
    selection[type === MediaType.Image ? 'imageSource' : 'videoSource'] = source;
    if (!picked) continue;
    selection[type === MediaType.Image ? 'imageModelId' : 'videoModelId'] = picked.modelId;
    selection.modelId ??= picked.modelId;
    selection.modelName ??= picked.modelName;
    if (source === MediaSelectionSource.Default && configured) {
      selection.policyVersion = policy?.policyVersion;
      // Each turn gets its own snapshot, also shared by its descendant tool calls.
      selection[type === MediaType.Image ? 'imageDefault' : 'videoDefault'] = {
        ...configured, params: { ...configured.params },
      };
    }
  }
  selection.mode = selection.imageModelId && selection.videoModelId ? MediaSelectionMode.Auto
    : selection.imageModelId ? MediaSelectionMode.Image
      : selection.videoModelId ? MediaSelectionMode.Video : MediaSelectionMode.None;
  return selection;
}
