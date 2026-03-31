import type { AppConfig } from '../config';
import type {
  CoworkAgentEngine,
  CoworkConfig,
  CoworkConfigUpdate,
  CoworkExecutionMode,
} from '../types/cowork';
import { configService } from './config';
import { coworkService } from './cowork';
import { apiService } from './api';
import { themeService } from './theme';
import { i18nService, type LanguageType } from './i18n';
import { store } from '../store';
import { setAvailableModels, setSelectedModel } from '../store/slices/modelSlice';
import { buildAvailableModelsListFromAppConfig } from './availableModelsFromConfig';

export const TEAM_TEMPLATE_TYPE = 'lobsterai.teamTemplate' as const;
export const TEAM_TEMPLATE_VERSION = 1 as const;

export type TeamTemplateProviderSlice = {
  enabled?: boolean;
  baseUrl?: string;
  apiFormat?: 'anthropic' | 'openai' | 'gemini';
  codingPlanEnabled?: boolean;
  authType?: 'apikey' | 'oauth';
  models?: Array<{ id: string; name: string; supportsImage?: boolean }>;
};

export type TeamTemplatePayloadV1 = {
  type: typeof TEAM_TEMPLATE_TYPE;
  version: typeof TEAM_TEMPLATE_VERSION;
  exportedAt: string;
  meta?: { name?: string };
  ui?: {
    theme?: 'light' | 'dark' | 'system';
    language?: LanguageType;
    useSystemProxy?: boolean;
    shortcuts?: AppConfig['shortcuts'];
  };
  model?: {
    defaultModel: string;
    defaultModelProvider?: string;
  };
  providers?: Record<string, TeamTemplateProviderSlice>;
  cowork?: {
    workingDirectory?: string;
    executionMode?: CoworkExecutionMode;
    agentEngine?: CoworkAgentEngine;
    memoryEnabled?: boolean;
    memoryImplicitUpdateEnabled?: boolean;
    memoryLlmJudgeEnabled?: boolean;
    memoryGuardLevel?: 'strict' | 'standard' | 'relaxed';
    memoryUserMemoriesMaxItems?: number;
  };
  skills?: Array<{ id: string; enabled: boolean }>;
};

export type TeamTemplateApplyOptions = {
  applyUi: boolean;
  applyModel: boolean;
  applyProviders: boolean;
  applyCowork: boolean;
  applySkills: boolean;
  applyWorkingDirectory: boolean;
};

export type TeamTemplateParseResult =
  | { ok: true; payload: TeamTemplatePayloadV1 }
  | { ok: false; error: string };

export function parseTeamTemplateJson(raw: string): TeamTemplateParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalidJson' };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'invalidShape' };
  }
  const p = parsed as Partial<TeamTemplatePayloadV1>;
  if (p.type !== TEAM_TEMPLATE_TYPE) {
    return { ok: false, error: 'wrongType' };
  }
  if (p.version !== TEAM_TEMPLATE_VERSION) {
    return { ok: false, error: 'unsupportedVersion' };
  }
  return { ok: true, payload: p as TeamTemplatePayloadV1 };
}

export function mergeProvidersWithTemplate(
  current: NonNullable<AppConfig['providers']>,
  template: Record<string, TeamTemplateProviderSlice>,
): AppConfig['providers'] {
  const out = { ...current } as Record<string, Record<string, unknown>>;
  for (const [key, slice] of Object.entries(template)) {
    const cur = out[key];
    if (!cur || typeof cur !== 'object') {
      continue;
    }
    const merged = { ...cur };
    if (slice.enabled !== undefined) {
      merged.enabled = slice.enabled;
    }
    if (slice.baseUrl !== undefined && String(slice.baseUrl).trim() !== '') {
      merged.baseUrl = String(slice.baseUrl).trim();
    }
    if (slice.apiFormat === 'anthropic' || slice.apiFormat === 'openai' || slice.apiFormat === 'gemini') {
      merged.apiFormat = slice.apiFormat;
    }
    if (slice.codingPlanEnabled !== undefined) {
      merged.codingPlanEnabled = slice.codingPlanEnabled;
    }
    if (slice.authType === 'apikey' || slice.authType === 'oauth') {
      merged.authType = slice.authType;
    }
    if (slice.models !== undefined && Array.isArray(slice.models) && slice.models.length > 0) {
      merged.models = slice.models.map((m) => ({
        id: String(m.id),
        name: String(m.name),
        supportsImage: Boolean(m.supportsImage),
      }));
    }
    out[key] = merged;
  }
  return out as AppConfig['providers'];
}

export type BuildTeamTemplateInput = {
  appConfig: AppConfig;
  coworkConfig: CoworkConfig;
  skills: Array<{ id: string; enabled: boolean }>;
  includeWorkingDirectory: boolean;
  metaName?: string;
};

export function buildTeamTemplateExport(input: BuildTeamTemplateInput): TeamTemplatePayloadV1 {
  const { appConfig, coworkConfig, skills, includeWorkingDirectory, metaName } = input;
  const providers: Record<string, TeamTemplateProviderSlice> = {};
  if (appConfig.providers) {
    for (const [key, raw] of Object.entries(appConfig.providers)) {
      const p = raw as Record<string, unknown>;
      providers[key] = {
        enabled: Boolean(p.enabled),
        baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl : '',
        apiFormat: p.apiFormat === 'openai' || p.apiFormat === 'gemini' || p.apiFormat === 'anthropic'
          ? p.apiFormat
          : undefined,
        ...(typeof p.codingPlanEnabled === 'boolean' ? { codingPlanEnabled: p.codingPlanEnabled } : {}),
        ...(p.authType === 'apikey' || p.authType === 'oauth' ? { authType: p.authType } : {}),
        models: Array.isArray(p.models)
          ? (p.models as Array<{ id: string; name: string; supportsImage?: boolean }>).map((m) => ({
            id: m.id,
            name: m.name,
            supportsImage: m.supportsImage ?? false,
          }))
          : undefined,
      };
    }
  }

  return {
    type: TEAM_TEMPLATE_TYPE,
    version: TEAM_TEMPLATE_VERSION,
    exportedAt: new Date().toISOString(),
    ...(metaName?.trim() ? { meta: { name: metaName.trim() } } : {}),
    ui: {
      theme: appConfig.theme,
      language: appConfig.language,
      useSystemProxy: appConfig.useSystemProxy,
      shortcuts: appConfig.shortcuts,
    },
    model: {
      defaultModel: appConfig.model.defaultModel,
      ...(appConfig.model.defaultModelProvider
        ? { defaultModelProvider: appConfig.model.defaultModelProvider }
        : {}),
    },
    providers,
    cowork: {
      ...(includeWorkingDirectory && coworkConfig.workingDirectory
        ? { workingDirectory: coworkConfig.workingDirectory }
        : {}),
      executionMode: coworkConfig.executionMode,
      agentEngine: coworkConfig.agentEngine,
      memoryEnabled: coworkConfig.memoryEnabled,
      memoryImplicitUpdateEnabled: coworkConfig.memoryImplicitUpdateEnabled,
      memoryLlmJudgeEnabled: coworkConfig.memoryLlmJudgeEnabled,
      memoryGuardLevel: coworkConfig.memoryGuardLevel,
      memoryUserMemoriesMaxItems: coworkConfig.memoryUserMemoriesMaxItems,
    },
    skills: skills.map((s) => ({ id: s.id, enabled: s.enabled })),
  };
}

function refreshModelSelectionAfterConfigChange(): void {
  const cfg = configService.getConfig();
  const list = buildAvailableModelsListFromAppConfig(cfg);
  if (list.length === 0) {
    return;
  }
  const prev = store.getState().model.selectedModel;
  store.dispatch(setAvailableModels(list));
  const def = cfg.model.defaultModel;
  const defPk = cfg.model.defaultModelProvider;
  const preferred = list.find((m) => m.id === def && (!defPk || m.providerKey === defPk));
  const stillValid = list.some(
    (m) => m.id === prev.id && m.providerKey === prev.providerKey,
  );
  if (!stillValid && preferred) {
    store.dispatch(setSelectedModel(preferred));
  } else if (!stillValid) {
    store.dispatch(setSelectedModel(list[0]));
  }
}

export async function applyTeamTemplate(
  payload: TeamTemplatePayloadV1,
  options: TeamTemplateApplyOptions,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    if (options.applyCowork && payload.cowork) {
      const c = payload.cowork;
      const update: CoworkConfigUpdate = {};
      if (options.applyWorkingDirectory && c.workingDirectory !== undefined && c.workingDirectory !== '') {
        update.workingDirectory = c.workingDirectory;
      }
      if (c.executionMode !== undefined) {
        update.executionMode = c.executionMode;
      }
      if (c.agentEngine !== undefined) {
        update.agentEngine = c.agentEngine;
      }
      if (c.memoryEnabled !== undefined) {
        update.memoryEnabled = c.memoryEnabled;
      }
      if (c.memoryImplicitUpdateEnabled !== undefined) {
        update.memoryImplicitUpdateEnabled = c.memoryImplicitUpdateEnabled;
      }
      if (c.memoryLlmJudgeEnabled !== undefined) {
        update.memoryLlmJudgeEnabled = c.memoryLlmJudgeEnabled;
      }
      if (c.memoryGuardLevel !== undefined) {
        update.memoryGuardLevel = c.memoryGuardLevel;
      }
      if (c.memoryUserMemoriesMaxItems !== undefined) {
        update.memoryUserMemoriesMaxItems = c.memoryUserMemoriesMaxItems;
      }
      if (Object.keys(update).length > 0) {
        const ok = await coworkService.updateConfig(update);
        if (!ok) {
          return { ok: false, error: 'coworkApplyFailed' };
        }
      }
    }

    const cfg = configService.getConfig();
    const appPatch: Partial<AppConfig> = {};

    if (options.applyUi && payload.ui) {
      if (payload.ui.theme === 'light' || payload.ui.theme === 'dark' || payload.ui.theme === 'system') {
        appPatch.theme = payload.ui.theme;
      }
      if (payload.ui.language === 'zh' || payload.ui.language === 'en') {
        appPatch.language = payload.ui.language;
      }
      if (typeof payload.ui.useSystemProxy === 'boolean') {
        appPatch.useSystemProxy = payload.ui.useSystemProxy;
      }
      if (payload.ui.shortcuts && typeof payload.ui.shortcuts === 'object') {
        appPatch.shortcuts = { ...cfg.shortcuts, ...payload.ui.shortcuts };
      }
    }

    if (options.applyProviders && payload.providers && cfg.providers) {
      appPatch.providers = mergeProvidersWithTemplate(cfg.providers, payload.providers);
    }

    if (options.applyModel && payload.model && payload.model.defaultModel) {
      const prov = appPatch.providers ?? cfg.providers;
      const list = buildAvailableModelsListFromAppConfig({
        ...cfg,
        providers: prov,
      });
      const def = payload.model.defaultModel;
      const defPk = payload.model.defaultModelProvider;
      const valid = list.some((m) => m.id === def && (!defPk || m.providerKey === defPk));
      if (valid) {
        appPatch.model = {
          ...cfg.model,
          defaultModel: def,
          defaultModelProvider: defPk,
        };
      }
    }

    if (Object.keys(appPatch).length > 0) {
      await configService.updateConfig(appPatch);
    }

    if (options.applyUi && payload.ui && (payload.ui.theme === 'light' || payload.ui.theme === 'dark' || payload.ui.theme === 'system')) {
      themeService.setTheme(payload.ui.theme);
    }
    if (options.applyUi && (payload.ui?.language === 'zh' || payload.ui?.language === 'en')) {
      i18nService.setLanguage(payload.ui.language, { persist: false });
    }

    const nextCfg = configService.getConfig();
    apiService.setConfig({
      apiKey: nextCfg.api.key,
      baseUrl: nextCfg.api.baseUrl,
    });

    if (options.applySkills && payload.skills?.length && window.electron?.skills?.setEnabled) {
      for (const s of payload.skills) {
        if (!s.id) {
          continue;
        }
        const r = await window.electron.skills.setEnabled({ id: s.id, enabled: s.enabled });
        if (!r.success) {
          console.warn('[TeamTemplate] skill setEnabled skipped for', s.id, r.error);
        }
      }
    }

    refreshModelSelectionAfterConfigChange();

    window.dispatchEvent(new CustomEvent('lobsterai:teamTemplateApplied'));
    return { ok: true };
  } catch (e) {
    console.error('[TeamTemplate] apply failed:', e);
    return { ok: false, error: 'applyException' };
  }
}
