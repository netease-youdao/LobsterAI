import { ArrowTopRightOnSquareIcon, ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import { AgentUiEvent } from '@shared/agent';
import type { Platform } from '@shared/platform';
import { PlatformRegistry } from '@shared/platform';
import React, { useMemo, useState } from 'react';

import { i18nService } from '../../services/i18n';
import type {
  DingTalkInstanceConfig,
  DiscordInstanceConfig,
  FeishuInstanceConfig,
  IMGatewayConfig,
  NimInstanceConfig,
  PopoInstanceConfig,
  QQInstanceConfig,
  TelegramInstanceConfig,
  WecomInstanceConfig,
} from '../../types/im';
import { getAgentDisplayNameById } from '../../utils/agentDisplay';
import { getVisibleIMPlatforms } from '../../utils/regionFilter';

type MultiInstancePlatform = 'dingtalk' | 'feishu' | 'qq' | 'wecom' | 'nim' | 'telegram' | 'discord' | 'popo';
type MultiInstanceConfig =
  | DingTalkInstanceConfig
  | FeishuInstanceConfig
  | QQInstanceConfig
  | WecomInstanceConfig
  | NimInstanceConfig
  | TelegramInstanceConfig
  | DiscordInstanceConfig
  | PopoInstanceConfig;

const MULTI_INSTANCE_PLATFORMS: readonly MultiInstancePlatform[] = [
  'dingtalk',
  'feishu',
  'qq',
  'wecom',
  'nim',
  'telegram',
  'discord',
  'popo',
];

const isMultiInstancePlatform = (platform: Platform): platform is MultiInstancePlatform =>
  MULTI_INSTANCE_PLATFORMS.includes(platform as MultiInstancePlatform);

interface AgentCandidate {
  id: string;
  name: string;
}

interface AgentImBindingListProps {
  imConfig: IMGatewayConfig | null;
  boundKeys: ReadonlySet<string>;
  agents: readonly AgentCandidate[];
  agentId?: string | null;
  isMainAgent?: boolean;
  onToggleBinding: (key: string) => void;
  onBeforeOpenImSettings?: () => void;
}

const renderToggle = (isOn: boolean) => (
  <div
    className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
      isOn ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'
    }`}
  >
    <div
      className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
        isOn ? 'translate-x-4' : 'translate-x-0.5'
      }`}
    />
  </div>
);

const getEnabledInstancesForPlatform = (
  imConfig: IMGatewayConfig | null,
  platform: MultiInstancePlatform,
): MultiInstanceConfig[] => {
  if (!imConfig) return [];
  const cfg = imConfig[platform];
  const instances = cfg?.instances;
  if (!Array.isArray(instances)) return [];
  return instances.filter((inst: MultiInstanceConfig) => inst.enabled);
};

const isPlatformConfiguredInConfig = (
  imConfig: IMGatewayConfig | null,
  platform: Platform,
): boolean => {
  if (!imConfig) return false;
  if (isMultiInstancePlatform(platform)) {
    return getEnabledInstancesForPlatform(imConfig, platform).length > 0;
  }
  if (platform === 'email') {
    return Array.isArray(imConfig.email?.instances) && imConfig.email.instances.length > 0;
  }
  const cfg = imConfig[platform as keyof typeof imConfig];
  if (!cfg || typeof cfg !== 'object') return false;
  return 'enabled' in cfg && (cfg as { enabled: boolean }).enabled === true;
};

const AgentImBindingList: React.FC<AgentImBindingListProps> = ({
  imConfig,
  boundKeys,
  agents,
  agentId = null,
  isMainAgent = false,
  onToggleBinding,
  onBeforeOpenImSettings,
}) => {
  const [showUnconfigured, setShowUnconfigured] = useState(false);

  const { configuredPlatforms, unconfiguredPlatforms } = useMemo(() => {
    const visible = getVisibleIMPlatforms(i18nService.getLanguage()) as readonly string[];
    const platforms = PlatformRegistry.platforms.filter(platform => visible.includes(platform));
    const configured: Platform[] = [];
    const unconfigured: Platform[] = [];
    for (const platform of platforms) {
      if (isPlatformConfiguredInConfig(imConfig, platform)) {
        configured.push(platform);
      } else {
        unconfigured.push(platform);
      }
    }
    return { configuredPlatforms: configured, unconfiguredPlatforms: unconfigured };
  }, [imConfig]);

  const getAgentName = (aid: string): string | null =>
    getAgentDisplayNameById(aid, agents as AgentCandidate[]);

  const handleOpenImSettings = () => {
    onBeforeOpenImSettings?.();
    window.dispatchEvent(new CustomEvent(AgentUiEvent.OpenImSettings));
  };

  const bindings = imConfig?.settings?.platformAgentBindings || {};

  return (
    <div className="space-y-3">
      {configuredPlatforms.length === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3.5 py-2.5">
          <p className="text-xs leading-5 text-secondary">
            {i18nService.t('agentSettingsImNoConfigured')}
          </p>
          <button
            type="button"
            onClick={handleOpenImSettings}
            className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-foreground hover:opacity-75 transition-opacity"
          >
            {i18nService.t('agentSettingsImOpenGlobalSettings')}
            <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5 text-secondary" />
          </button>
        </div>
      ) : (
        <div className="space-y-1.5">
          {configuredPlatforms.map((platform) => {
            const logo = PlatformRegistry.logo(platform);

            if (isMultiInstancePlatform(platform)) {
              const enabledInstances = getEnabledInstancesForPlatform(imConfig, platform);
              return (
                <div key={platform} className="overflow-hidden rounded-lg border border-border">
                  <div className="flex items-center gap-2.5 bg-surface-raised/60 px-3 py-2">
                    <img src={logo} alt={i18nService.t(platform)} className="h-5 w-5 rounded object-contain" />
                    <span className="text-xs font-semibold text-foreground">
                      {i18nService.t(platform)}
                    </span>
                  </div>
                  {enabledInstances.map((inst, idx) => {
                    const bindingKey = `${platform}:${inst.instanceId}`;
                    const otherAgentId = bindings[bindingKey];
                    const claimingForMain = isMainAgent && boundKeys.has(bindingKey);
                    const boundToOther = Boolean(
                      otherAgentId
                      && otherAgentId !== agentId
                      && !claimingForMain
                      && !boundKeys.has(bindingKey),
                    );
                    const canToggle = !isMainAgent || boundToOther || claimingForMain;
                    const isBound = isMainAgent ? claimingForMain || !boundToOther : boundKeys.has(bindingKey);
                    const otherAgentName = boundToOther ? getAgentName(otherAgentId ?? '') : null;

                    return (
                      <div
                        key={inst.instanceId}
                        onClick={() => canToggle && onToggleBinding(bindingKey)}
                        className={`flex items-center justify-between px-3 py-2 pl-10 transition-colors ${
                          idx < enabledInstances.length - 1 ? 'border-b border-border-subtle' : ''
                        } ${canToggle ? 'cursor-pointer hover:bg-surface-raised/70' : ''}`}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-green-500" />
                          <span className="truncate text-sm text-foreground">{inst.instanceName}</span>
                          {boundToOther && otherAgentName && (
                            <span className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-600 dark:text-amber-400">
                              {(i18nService.t('agentIMBoundToOther') || '→ {agent}').replace('{agent}', otherAgentName)}
                            </span>
                          )}
                        </div>
                        {renderToggle(isBound)}
                      </div>
                    );
                  })}
                </div>
              );
            }

            const otherAgentId = bindings[platform];
            const claimingForMain = isMainAgent && boundKeys.has(platform);
            const boundToOther = Boolean(
              otherAgentId
              && otherAgentId !== agentId
              && !claimingForMain
              && !boundKeys.has(platform),
            );
            const canToggle = !isMainAgent || boundToOther || claimingForMain;
            const isBound = isMainAgent ? claimingForMain || !boundToOther : boundKeys.has(platform);
            const otherAgentName = boundToOther ? getAgentName(otherAgentId ?? '') : null;

            return (
              <div
                key={platform}
                onClick={() => canToggle && onToggleBinding(platform)}
                className={`flex items-center justify-between rounded-lg border border-border px-3 py-2.5 transition-colors ${
                  canToggle ? 'cursor-pointer hover:bg-surface-raised/70' : ''
                }`}
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <img src={logo} alt={i18nService.t(platform)} className="h-5 w-5 rounded object-contain" />
                  <span className="truncate text-sm font-medium text-foreground">
                    {i18nService.t(platform)}
                  </span>
                  {boundToOther && otherAgentName && (
                    <span className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-600 dark:text-amber-400">
                      {(i18nService.t('agentIMBoundToOther') || '→ {agent}').replace('{agent}', otherAgentName)}
                    </span>
                  )}
                </div>
                {renderToggle(isBound)}
              </div>
            );
          })}
        </div>
      )}

      {unconfiguredPlatforms.length > 0 && (
        <div className="pt-1">
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setShowUnconfigured(prev => !prev)}
              className="inline-flex items-center gap-1 text-xs text-secondary hover:text-foreground transition-colors"
            >
              {showUnconfigured ? (
                <ChevronDownIcon className="h-3.5 w-3.5" />
              ) : (
                <ChevronRightIcon className="h-3.5 w-3.5" />
              )}
              {i18nService.t('agentSettingsImUnconfiguredToggle').replace('{count}', String(unconfiguredPlatforms.length))}
            </button>
            {configuredPlatforms.length > 0 && (
              <button
                type="button"
                onClick={handleOpenImSettings}
                className="inline-flex items-center gap-1 text-xs text-secondary hover:text-foreground transition-colors"
              >
                {i18nService.t('agentSettingsImOpenGlobalSettings')}
                <ArrowTopRightOnSquareIcon className="h-3 w-3" />
              </button>
            )}
          </div>

          {showUnconfigured && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {unconfiguredPlatforms.map((platform) => {
                const logo = PlatformRegistry.logo(platform);
                return (
                  <button
                    key={platform}
                    type="button"
                    onClick={handleOpenImSettings}
                    title={i18nService.t('agentIMNotConfiguredHint')}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border/70 bg-surface-raised/40 px-2.5 py-1 text-xs text-secondary transition-colors hover:border-border hover:text-foreground"
                  >
                    <img src={logo} alt={i18nService.t(platform)} className="h-3.5 w-3.5 rounded object-contain opacity-70" />
                    <span>{i18nService.t(platform)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default AgentImBindingList;
