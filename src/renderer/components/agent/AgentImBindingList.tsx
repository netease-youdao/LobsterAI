import { ArrowTopRightOnSquareIcon, ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import { AgentId, AgentUiEvent } from '@shared/agent';
import { RetainedImPlatform } from '@shared/dshEngine/hostConstants';
import { PlatformRegistry } from '@shared/platform';
import React, { useState } from 'react';

import type { AgentImChannel, AgentImPlatform } from '../../services/agentImBindings';
import { i18nService } from '../../services/i18n';
import { getAgentDisplayNameById } from '../../utils/agentDisplay';

interface AgentCandidate {
  id: string;
  name: string;
}

interface AgentImBindingListProps {
  platforms: AgentImPlatform[];
  boundKeys: ReadonlySet<string>;
  agents: AgentCandidate[];
  agentId?: string | null;
  onToggleBinding: (key: string) => void;
  onBeforeOpenImSettings?: () => void;
}

const AgentImBindingList: React.FC<AgentImBindingListProps> = ({
  platforms,
  boundKeys,
  agents,
  agentId,
  onToggleBinding,
  onBeforeOpenImSettings,
}) => {
  const [showUnconfigured, setShowUnconfigured] = useState(false);
  const configuredPlatforms = platforms.filter(({ channels }) => channels.length > 0);
  const unconfiguredPlatforms = platforms.filter(({ channels }) => channels.length === 0);

  const handleOpenImSettings = () => {
    onBeforeOpenImSettings?.();
    window.dispatchEvent(new CustomEvent(AgentUiEvent.OpenImSettings));
  };

  const renderChannel = (platform: RetainedImPlatform, channel: AgentImChannel) => {
    const single = platform === RetainedImPlatform.Weixin;
    const isBound = boundKeys.has(channel.key);
    const owner = channel.configuredAgentId || AgentId.Main;
    const canToggle = agentId !== AgentId.Main || owner !== AgentId.Main;
    const name = channel.name ?? i18nService.t(platform);
    const otherAgentName = !isBound && channel.configuredAgentId && owner !== agentId
      ? getAgentDisplayNameById(owner, agents)
      : null;
    return (
      <button
        key={channel.key}
        type="button"
        role="switch"
        aria-checked={isBound}
        aria-label={name}
        disabled={!canToggle}
        onClick={() => onToggleBinding(channel.key)}
        className={`flex w-full items-center justify-between text-left transition-colors enabled:cursor-pointer enabled:hover:bg-surface-raised/70 ${
          single ? 'rounded-lg border border-border px-3 py-2.5' : 'px-3 py-2 pl-10'
        }`}
      >
        <span className="flex min-w-0 items-center gap-2">
          {single
            ? <img src={PlatformRegistry.logo(platform)} alt="" className="h-5 w-5 rounded object-contain" />
            : <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-green-500" />}
          <span className="truncate text-sm text-foreground">{name}</span>
          {otherAgentName && (
            <span className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-600 dark:text-amber-400">
              {i18nService.t('agentIMBoundToOther').replace('{agent}', otherAgentName)}
            </span>
          )}
        </span>
        <span className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
          isBound ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'
        }`}>
          <span className={`absolute left-0 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
            isBound ? 'translate-x-4' : 'translate-x-0.5'
          }`} />
        </span>
      </button>
    );
  };


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
          {configuredPlatforms.map(({ platform, channels }) => (
            platform === RetainedImPlatform.Weixin
              ? renderChannel(platform, channels[0])
              : (
                <div key={platform} className="overflow-hidden rounded-lg border border-border">
                  <div className="flex items-center gap-2.5 bg-surface-raised/60 px-3 py-2">
                    <img src={PlatformRegistry.logo(platform)} alt="" className="h-5 w-5 rounded object-contain" />
                    <span className="text-xs font-semibold text-foreground">{i18nService.t(platform)}</span>
                  </div>
                  <div className="divide-y divide-border-subtle">
                    {channels.map(channel => renderChannel(platform, channel))}
                  </div>
                </div>
              )
          ))}
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
              {unconfiguredPlatforms.map(({ platform }) => {
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
