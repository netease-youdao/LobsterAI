import {
  type MediaDefaultPolicy,
  MediaDefaultsProtocol,
  mediaPreferenceKey,
  MediaPreferenceMode,
  type MediaPreferences,
  type MediaPreferenceState,
  type MediaSelection,
  MediaSelectionMode,
  MediaSelectionSource,
  MediaType,
  migrateMediaPreferences,
  parseMediaDefaultPolicy,
  parseMediaPreference,
  resolveMediaPreferences,
} from '../shared/media/defaultPolicy';
import { isMediaAccountScopeCurrent, type MediaAccountScope } from './mediaAccountIsolation';

interface Dependencies {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
  remove: (key: string) => void;
  scope: () => MediaAccountScope | null;
  entitled: () => boolean;
  server: () => string;
  fetch: (url: string, options: RequestInit) => Promise<Response>;
  now?: () => number;
}

export class MediaDefaultPolicyManager {
  private readonly cache = new Map<string, { expires: number; policy?: MediaDefaultPolicy }>();
  private readonly pending = new Map<string, Promise<MediaDefaultPolicy | undefined>>();

  constructor(private readonly deps: Dependencies) {}

  private assertScope(scope: MediaAccountScope): void {
    if (!isMediaAccountScopeCurrent(scope, this.deps.scope())) throw new Error('Media account changed');
  }

  private read(owner: string): MediaPreferences {
    const key = mediaPreferenceKey(owner);
    const stored = this.deps.get(key);
    const scopedLegacy = this.deps.get(`${MediaDefaultsProtocol.LegacyKey}:${owner}`);
    const legacy = stored == null && scopedLegacy == null ? this.deps.get(MediaDefaultsProtocol.LegacyKey) : scopedLegacy;
    const preferences = migrateMediaPreferences(stored, legacy);
    if (stored == null) {
      this.deps.set(key, preferences);
      if (scopedLegacy == null && legacy != null) {
        // Preserve an old-client mirror before consuming the unscoped legacy value.
        this.deps.set(`${MediaDefaultsProtocol.LegacyKey}:${owner}`, legacy);
        this.deps.remove(MediaDefaultsProtocol.LegacyKey);
      }
    }
    return preferences;
  }

  private async policy(scope: MediaAccountScope): Promise<MediaDefaultPolicy | undefined> {
    if (!this.deps.entitled()) return undefined;
    const server = this.deps.server();
    const key = `${scope.ownerAccountKey}:${scope.accountGeneration}:${server}`;
    const now = this.deps.now ?? Date.now;
    const cached = this.cache.get(key);
    if (cached && cached.expires > now()) return cached.policy;
    const pending = this.pending.get(key);
    if (pending) return pending;
    const load = (async () => {
      let policy: MediaDefaultPolicy | undefined;
      try {
        const response = await this.deps.fetch(server + MediaDefaultsProtocol.Endpoint, {
          headers: { [MediaDefaultsProtocol.CapabilityHeader]: MediaDefaultsProtocol.Capability },
          signal: AbortSignal.timeout(8_000),
        });
        if (response.ok) {
          const body = await response.json() as { code?: number; data?: unknown };
          if (body.code === 0) policy = parseMediaDefaultPolicy(body.data);
        }
      } catch (error) {
        console.warn('[MediaDefaults] Policy fetch failed; automatic defaults unavailable.', error);
      }
      this.assertScope(scope);
      if (this.deps.server() !== server) throw new Error('Media server changed');
      // Never execute an expired default when an old server or a refresh fails.
      if (this.cache.size > 16) this.cache.clear();
      this.cache.set(key, { expires: now() + (policy?.ttlSeconds ?? 60) * 1_000, policy });
      return policy;
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, load);
    return load;
  }

  async state(owner: string): Promise<MediaPreferenceState> {
    const scope = this.deps.scope();
    if (!scope || scope.ownerAccountKey !== owner) throw new Error('Media account changed');
    // Read before network access: a storage error must never look like a fresh account.
    this.read(owner);
    const policy = await this.policy(scope);
    this.assertScope(scope);
    const preferences = this.read(owner); // A click during the fetch wins.
    return { ownerAccountKey: owner, preferences,
      selection: this.deps.entitled() ? resolveMediaPreferences(preferences, policy) : {
        mode: MediaSelectionMode.None, preferencesRevision: preferences.revision,
        imagePreference: preferences.image.mode, videoPreference: preferences.video.mode,
      },
      policyVersion: policy?.policyVersion };
  }

  async update(owner: string, type: MediaType, value: unknown): Promise<MediaPreferenceState> {
    const scope = this.deps.scope();
    if (!scope || scope.ownerAccountKey !== owner) throw new Error('Media account changed');
    if (type !== MediaType.Image && type !== MediaType.Video) throw new Error('Invalid media type');
    const preference = parseMediaPreference(value);
    const previous = this.read(owner);
    const preferences = { ...previous, revision: previous.revision + 1, [type]: preference };
    this.deps.set(mediaPreferenceKey(owner), preferences);
    // A downgraded client must not mistake system defaults for an explicit selection.
    const legacy: Record<string, unknown> = {};
    for (const kind of Object.values(MediaType)) {
      const entry = preferences[kind];
      if (entry.mode === MediaPreferenceMode.Selected) legacy[kind] = { modelId: entry.modelId, modelName: entry.modelName };
    }
    this.deps.set(`${MediaDefaultsProtocol.LegacyKey}:${owner}`, legacy);
    return this.state(owner);
  }

  async turn(input: { selection?: MediaSelection; isPlan: boolean; explicitSkillIds?: string[]; inheritedSkillIds?: string[] }): Promise<MediaSelection> {
    if (input.isPlan || !this.deps.entitled()) return { mode: MediaSelectionMode.None };
    const scope = this.deps.scope();
    if (!scope) return { mode: MediaSelectionMode.None };
    let selection: MediaSelection;
    if (input.selection && input.selection.preferencesRevision === undefined) {
      // Preserve explicit per-turn choices from existing callers (including an off sentinel).
      selection = { ...input.selection, imageDefault: undefined, videoDefault: undefined };
    } else {
      try {
        selection = (await this.state(scope.ownerAccountKey)).selection;
      } catch (error) {
        this.assertScope(scope);
        console.warn('[MediaDefaults] Preferences unavailable; media disabled for this turn.', error);
        return { mode: MediaSelectionMode.None };
      }
    }
    this.assertScope(scope);
    // Only direct skill selection overrides defaults; an expert's available skills do not.
    const skills = (input.explicitSkillIds ?? []).filter(id => !input.inheritedSkillIds?.includes(id));
    if ((skills.includes('seedream') && selection.imageSource === MediaSelectionSource.Default)
      || (skills.includes('seedance') && selection.videoSource === MediaSelectionSource.Default)) {
      const state = await this.state(scope.ownerAccountKey);
      const preferences = { ...state.preferences };
      if (skills.includes('seedream')) preferences.image = { mode: MediaPreferenceMode.Off };
      if (skills.includes('seedance')) preferences.video = { mode: MediaPreferenceMode.Off };
      selection = resolveMediaPreferences(preferences, await this.policy(scope));
      this.assertScope(scope);
    }
    return selection;
  }
}
