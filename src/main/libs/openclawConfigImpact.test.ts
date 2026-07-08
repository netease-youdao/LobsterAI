import { describe, expect, test } from 'vitest';

import { ProviderAuthType, ProviderName } from '../../shared/providers';
import {
  classifyAppConfigChange,
  classifyCoworkConfigChange,
  classifyImOpenClawConfigChange,
  classifyPluginConfigChange,
  createStableConfigFingerprint,
  mergeImpactDecision,
  OpenClawConfigImpact,
  OpenClawConfigImpactReason,
  OpenClawPluginChangeAction,
  removeImpactDecisionReasons,
} from './openclawConfigImpact';

describe('OpenClaw config impact classification', () => {
  test('classifies theme, language, and shortcuts changes as none', () => {
    const result = classifyAppConfigChange(
      {
        theme: 'light',
        language: 'zh',
        shortcuts: { settings: 'Ctrl+,' },
      },
      {
        theme: 'dark',
        language: 'en',
        shortcuts: { settings: 'Ctrl+Alt+,' },
      },
    );

    expect(result).toEqual({
      impact: OpenClawConfigImpact.None,
      reasons: [],
    });
  });

  test('classifies provider baseUrl, apiFormat, and model changes as sync', () => {
    const result = classifyAppConfigChange(
      {
        providers: {
          openai: {
            enabled: true,
            apiKey: 'sk-old',
            baseUrl: 'https://old.example/v1',
            apiFormat: 'openai',
            models: [{ id: 'gpt-5', name: 'GPT-5' }],
          },
        },
      },
      {
        providers: {
          openai: {
            enabled: true,
            apiKey: 'sk-old',
            baseUrl: 'https://new.example/v1',
            apiFormat: 'anthropic',
            models: [{ id: 'gpt-5.1', name: 'GPT-5.1', supportsImage: true }],
          },
        },
      },
    );

    expect(result.impact).toBe(OpenClawConfigImpact.Sync);
    expect(result.reasons).toEqual([OpenClawConfigImpactReason.AppProviderConfig]);
  });

  test('classifies provider apiKey and OAuth token changes as restart', () => {
    const result = classifyAppConfigChange(
      {
        providers: {
          minimax: {
            enabled: true,
            apiKey: 'sk-old',
            oauthAccessToken: 'oauth-old',
          },
        },
      },
      {
        providers: {
          minimax: {
            enabled: true,
            apiKey: 'sk-new',
            oauthAccessToken: 'oauth-new',
          },
        },
      },
    );

    expect(result.impact).toBe(OpenClawConfigImpact.Restart);
    expect(result.reasons).toEqual([OpenClawConfigImpactReason.AppProviderSecret]);
  });

  test('ignores GitHub Copilot short token changes', () => {
    const result = classifyAppConfigChange(
      {
        providers: {
          [ProviderName.Copilot]: {
            enabled: true,
            authType: ProviderAuthType.OAuth,
            apiKey: 'copilot-old',
            baseUrl: 'https://api.githubcopilot.com',
          },
        },
      },
      {
        providers: {
          [ProviderName.Copilot]: {
            enabled: true,
            authType: ProviderAuthType.OAuth,
            apiKey: 'copilot-new',
            baseUrl: 'https://api.githubcopilot.com',
          },
        },
      },
    );

    expect(result).toEqual({
      impact: OpenClawConfigImpact.None,
      reasons: [],
    });
  });

  test('does not treat blank provider secrets as restart-only changes', () => {
    const result = classifyAppConfigChange(
      {
        providers: {
          custom_0: {
            enabled: false,
            apiKey: '',
            baseUrl: 'https://example.com/v1',
          },
        },
      },
      {
        providers: {},
      },
    );

    expect(result.impact).toBe(OpenClawConfigImpact.Sync);
    expect(result.reasons).toEqual([OpenClawConfigImpactReason.AppProviderConfig]);
  });

  test('classifies useSystemProxy changes as restart', () => {
    const result = classifyAppConfigChange(
      { useSystemProxy: false },
      { useSystemProxy: true },
    );

    expect(result).toEqual({
      impact: OpenClawConfigImpact.Restart,
      reasons: [OpenClawConfigImpactReason.AppUseSystemProxy],
    });
  });

  test('classifies skipMissedJobs changes as sync', () => {
    const result = classifyCoworkConfigChange(
      { skipMissedJobs: true },
      { skipMissedJobs: false },
    );

    expect(result).toEqual({
      impact: OpenClawConfigImpact.Sync,
      reasons: [OpenClawConfigImpactReason.CoworkOpenClawConfig],
    });
  });

  test('classifies OpenClaw heartbeat changes as sync', () => {
    const result = classifyCoworkConfigChange(
      { openClawHeartbeatEnabled: true },
      { openClawHeartbeatEnabled: false },
    );

    expect(result).toEqual({
      impact: OpenClawConfigImpact.Sync,
      reasons: [OpenClawConfigImpactReason.CoworkOpenClawConfig],
    });
  });

  test('classifies dreaming changes as restart', () => {
    const result = classifyCoworkConfigChange(
      { dreamingEnabled: false, dreamingFrequency: '0 3 * * *' },
      { dreamingEnabled: true, dreamingFrequency: '0 4 * * *' },
    );

    expect(result).toEqual({
      impact: OpenClawConfigImpact.Restart,
      reasons: [OpenClawConfigImpactReason.CoworkDreamingConfig],
    });
  });

  test('lets dreaming restart take precedence over cowork sync changes', () => {
    const result = classifyCoworkConfigChange(
      {
        skipMissedJobs: true,
        dreamingEnabled: false,
      },
      {
        skipMissedJobs: false,
        dreamingEnabled: true,
      },
    );

    expect(result).toEqual({
      impact: OpenClawConfigImpact.Restart,
      reasons: [
        OpenClawConfigImpactReason.CoworkOpenClawConfig,
        OpenClawConfigImpactReason.CoworkDreamingConfig,
      ],
    });
  });

  test('classifies non-OpenClaw cowork memory policy changes as none', () => {
    const result = classifyCoworkConfigChange(
      { memoryEnabled: true, memoryLlmJudgeEnabled: true },
      { memoryEnabled: false, memoryLlmJudgeEnabled: false },
    );

    expect(result).toEqual({
      impact: OpenClawConfigImpact.None,
      reasons: [],
    });
  });

  test('classifies IM fingerprint changes as restart and identical fingerprints as none', () => {
    const previous = createStableConfigFingerprint({ telegram: { enabled: false } });
    const next = createStableConfigFingerprint({ telegram: { enabled: true } });

    expect(classifyImOpenClawConfigChange(previous, previous).impact).toBe(OpenClawConfigImpact.None);
    expect(classifyImOpenClawConfigChange(previous, next)).toEqual({
      impact: OpenClawConfigImpact.Restart,
      reasons: [OpenClawConfigImpactReason.ImConfig],
    });
  });

  test('classifies forced IM sync as restart even without fingerprint diff', () => {
    const fingerprint = createStableConfigFingerprint({ weixin: { accountId: 'wxid' } });

    expect(classifyImOpenClawConfigChange(fingerprint, fingerprint, { forceRestart: true })).toEqual({
      impact: OpenClawConfigImpact.Restart,
      reasons: [OpenClawConfigImpactReason.ImForceRestart],
    });
  });

  test('classifies plugin install, uninstall, toggle, and config changes as restart', () => {
    expect(classifyPluginConfigChange(OpenClawPluginChangeAction.Install).impact)
      .toBe(OpenClawConfigImpact.Restart);
    expect(classifyPluginConfigChange(OpenClawPluginChangeAction.Uninstall).impact)
      .toBe(OpenClawConfigImpact.Restart);
    expect(classifyPluginConfigChange(OpenClawPluginChangeAction.Toggle).impact)
      .toBe(OpenClawConfigImpact.Restart);
    expect(classifyPluginConfigChange(OpenClawPluginChangeAction.Config).impact)
      .toBe(OpenClawConfigImpact.Restart);
  });

  test('merges decisions with restart taking precedence over sync and none', () => {
    const result = mergeImpactDecision(
      { impact: OpenClawConfigImpact.None, reasons: [] },
      { impact: OpenClawConfigImpact.Sync, reasons: [OpenClawConfigImpactReason.AppProviderConfig] },
      { impact: OpenClawConfigImpact.Restart, reasons: [OpenClawConfigImpactReason.AppProviderSecret] },
    );

    expect(result).toEqual({
      impact: OpenClawConfigImpact.Restart,
      reasons: [
        OpenClawConfigImpactReason.AppProviderConfig,
        OpenClawConfigImpactReason.AppProviderSecret,
      ],
    });
  });

  test('removes proxy restart reason while preserving provider sync action', () => {
    const source = mergeImpactDecision(
      { impact: OpenClawConfigImpact.Restart, reasons: [OpenClawConfigImpactReason.AppUseSystemProxy] },
      { impact: OpenClawConfigImpact.Sync, reasons: [OpenClawConfigImpactReason.AppProviderConfig] },
    );

    expect(removeImpactDecisionReasons(source, [OpenClawConfigImpactReason.AppUseSystemProxy])).toEqual({
      impact: OpenClawConfigImpact.Sync,
      reasons: [OpenClawConfigImpactReason.AppProviderConfig],
    });
  });
});
