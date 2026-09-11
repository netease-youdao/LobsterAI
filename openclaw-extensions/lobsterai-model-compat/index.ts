import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import {
  buildAnthropicReplayPolicyForModel,
  buildGoogleGeminiReplayPolicy,
  buildOpenAICompatibleReplayPolicy,
} from 'openclaw/plugin-sdk/provider-model-shared';

import { createMoonshotKimiK3Wrapper } from './moonshotKimiK3';
import {
  hasModelRuntimeProfile,
  LobsterAIModelRuntimeProfile,
  ModelProfileTransportDecision,
  parseModelProfileMap,
  resolveModelProfileTransportDecision,
} from './profileMapping';
import {
  createLobsterAIRequestOptionsWrapper,
  resolveLobsterAIRequestThinkingLevel,
} from './requestOptions';
import { LOBSTERAI_REQUEST_OPTIONS_VERSION } from './requestOptionsProtocol';
import {
  parseThinkingProfileMap,
  resolveOpenClawThinkingProfile,
} from './thinkingProfileMapping';

const PLUGIN_ID = 'lobsterai-model-compat';
const OPENAI_COMPLETIONS_API = 'openai-completions';
const OPENAI_COMPATIBLE_APIS = new Set([
  OPENAI_COMPLETIONS_API,
  'openai-responses',
  'openai-chatgpt-responses',
]);

const register = (api: OpenClawPluginApi): void => {
  const modelProfiles = parseModelProfileMap(api.pluginConfig?.modelProfiles);
  const thinkingProfiles = parseThinkingProfileMap(api.pluginConfig?.thinkingProfiles);
  const isKimiK3Profile = (provider: string, modelId: string): boolean => (
    hasModelRuntimeProfile(
      modelProfiles,
      provider,
      modelId,
      LobsterAIModelRuntimeProfile.MoonshotKimiK3,
    )
  );
  const resolveTransportDecision = (
    provider: string,
    modelId: string,
    modelApi?: string,
  ) => resolveModelProfileTransportDecision({
    modelProfiles,
    provider,
    modelId,
    modelApi,
  });
  const assertSupportedTransport = (
    provider: string,
    modelId: string,
    modelApi?: string,
  ): ReturnType<typeof resolveTransportDecision> => {
    const decision = resolveTransportDecision(provider, modelId, modelApi);
    if (decision.kind === ModelProfileTransportDecision.Reject) {
      throw new Error(
        `Kimi K3 compatibility requires ${decision.expectedApi} for ${provider}/${modelId}; received ${decision.actualApi}`,
      );
    }
    return decision;
  };

  api.registerProvider({
    id: PLUGIN_ID,
    label: 'LobsterAI Model Compatibility',
    hookAliases: ['lobsterai-server'],
    auth: [],
    buildReplayPolicy: (ctx) => {
      const modelApi = ctx.modelApi ?? ctx.model?.api;
      const modelId = ctx.modelId ?? '';
      const decision = assertSupportedTransport(ctx.provider, modelId, modelApi);
      if (decision.kind === ModelProfileTransportDecision.MoonshotKimiK3) {
        return buildOpenAICompatibleReplayPolicy(modelApi, {
          modelId,
          sanitizeToolCallIds: false,
          dropReasoningFromHistory: false,
        });
      }
      if (modelApi && OPENAI_COMPATIBLE_APIS.has(modelApi)) {
        return buildOpenAICompatibleReplayPolicy(modelApi, {
          modelId,
          dropReasoningFromHistory: ctx.model?.reasoning !== true,
        });
      }
      if (modelApi === 'anthropic-messages') {
        return buildAnthropicReplayPolicyForModel(modelId);
      }
      if (modelApi === 'google-generative-ai') {
        return buildGoogleGeminiReplayPolicy();
      }
      return undefined;
    },
    wrapStreamFn: (ctx) => {
      const decision = assertSupportedTransport(ctx.provider, ctx.modelId, ctx.model?.api);
      const baseStreamFn = decision.kind === ModelProfileTransportDecision.Passthrough
        ? ctx.streamFn
        : createMoonshotKimiK3Wrapper(ctx.streamFn);
      const thinkingProfile = thinkingProfiles[`${ctx.provider}/${ctx.modelId}`];
      if (thinkingProfile?.requestOptionsVersion === LOBSTERAI_REQUEST_OPTIONS_VERSION) {
        return createLobsterAIRequestOptionsWrapper(
          baseStreamFn,
          resolveLobsterAIRequestThinkingLevel(thinkingProfile, ctx.thinkingLevel),
        );
      }
      return baseStreamFn;
    },
    resolveThinkingProfile: ({ provider, modelId }) => resolveOpenClawThinkingProfile(
      thinkingProfiles[`${provider}/${modelId}`],
      isKimiK3Profile(provider, modelId),
    ),
    isModernModelRef: ({ provider, modelId }) => (
      isKimiK3Profile(provider, modelId) || undefined
    ),
  });
};

export default {
  id: PLUGIN_ID,
  name: 'LobsterAI Model Compatibility',
  description: 'Applies explicit LobsterAI-managed model runtime profiles.',
  register,
};
