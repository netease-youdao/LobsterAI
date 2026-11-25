import {
  ArrowRightIcon,
  ChatBubbleLeftRightIcon,
  Cog6ToothIcon,
  DocumentMagnifyingGlassIcon,
} from '@heroicons/react/24/outline';
import { AgentSource, parseAgentAvatarImageUrl } from '@shared/agent';
import React, { useMemo } from 'react';

import { getAgentOnboardingMeta } from '../../services/agentOnboarding';
import { i18nService } from '../../services/i18n';
import { getAgentDisplayName, usesManagedPresetAvatar } from '../../utils/agentDisplay';
import AgentAvatarIcon from '../agent/AgentAvatarIcon';
import AgentAvatarPicker, { AgentAvatarPickerVariant } from '../agent/AgentAvatarPicker';
import {
  buildAgentInterviewPrompt,
  buildFolderScanSetupPrompt,
  shouldShowAgentQuickSetup,
} from '../agent/agentPersonaHelpers';
import Tooltip, { TooltipPosition } from '../ui/Tooltip';

interface AgentHomeHeroAgent {
  id: string;
  name: string;
  systemPrompt?: string;
  identity?: string;
  icon: string;
  iconCustomized?: boolean;
  workingDirectory: string;
  source: AgentSource;
  presetId?: string;
  skillIds: string[];
}

interface AgentHomeHeroProps {
  agent: AgentHomeHeroAgent;
  effectiveWorkingDirectory?: string;
  metaRevision?: number;
  onOpenSettings: () => void;
  onChangeIcon?: (icon: string) => void | Promise<void>;
  onUsePrompt: (prompt: string) => void;
}

const AgentHomeHero: React.FC<AgentHomeHeroProps> = ({
  agent,
  metaRevision = 0,
  onOpenSettings,
  onChangeIcon,
  onUsePrompt,
}) => {
  const displayName = getAgentDisplayName(agent);
  const language: 'zh' | 'en' = i18nService.getLanguage() === 'en' ? 'en' : 'zh';
  const explicitFolder = agent.workingDirectory.trim();
  const isManagedPresetAvatar = usesManagedPresetAvatar(agent);
  const hasImageAvatar = Boolean(parseAgentAvatarImageUrl(agent.icon)) || isManagedPresetAvatar;

  const onboardingMeta = useMemo(
    () => (metaRevision >= 0 ? getAgentOnboardingMeta(agent.id) : null),
    [agent.id, metaRevision],
  );
  const starterPrompts = onboardingMeta?.starterPrompts ?? [];
  const showQuickSetup = shouldShowAgentQuickSetup({
    source: agent.source,
    systemPrompt: agent.systemPrompt,
    identity: agent.identity,
    starterPromptCount: starterPrompts.length,
  });

  const handleInterviewClick = () => {
    onUsePrompt(buildAgentInterviewPrompt({
      agentName: displayName,
      // Only include an explicitly bound folder — never leak the fallback default
      // working directory into the prompt, as many agents share that folder.
      workingDirectory: explicitFolder || undefined,
      language,
    }));
  };

  const handleScanFolderClick = () => {
    if (!explicitFolder) return;
    onUsePrompt(buildFolderScanSetupPrompt({
      agentName: displayName,
      workingDirectory: explicitFolder,
      language,
    }));
  };

  return (
    <div className="flex w-full flex-col items-center text-center animate-fade-in-up">
      {/* Avatar & Identity */}
      {onChangeIcon ? (
        <AgentAvatarPicker
          key={agent.id}
          value={agent.icon}
          onChange={(nextIcon) => {
            void onChangeIcon(nextIcon);
          }}
          expertFallback={isManagedPresetAvatar}
          variant={AgentAvatarPickerVariant.Hero}
          tooltip={i18nService.t('agentHomeChangeIconTooltip')}
          ariaLabel={i18nService.t('agentHomeChangeIconTooltip')}
        />
      ) : (
        <AgentAvatarIcon
          value={agent.icon}
          expertFallback={isManagedPresetAvatar}
          className={hasImageAvatar
            ? 'h-14 w-14'
            : 'h-14 w-14 border border-border/70 bg-surface shadow-[0_2px_8px_rgba(0,0,0,0.04)]'}
          iconClassName="h-7 w-7"
        />
      )}
      <div className="mt-3.5 flex max-w-xl items-center justify-center gap-1.5">
        <span aria-hidden="true" className="h-7 w-7 shrink-0" />
        <h2 className="min-w-0 truncate text-[24px] font-semibold leading-tight tracking-[-0.015em] text-foreground">
          {displayName}
        </h2>
        <Tooltip content={i18nService.t('agentHomeSettingsButton')} position={TooltipPosition.Top}>
          <button
            type="button"
            onClick={onOpenSettings}
            aria-label={i18nService.t('agentHomeSettingsButton')}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-secondary/55 transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <Cog6ToothIcon className="h-4 w-4" />
          </button>
        </Tooltip>
      </div>
      {agent.skillIds.length > 0 && (
        <button
          type="button"
          onClick={onOpenSettings}
          className="mt-2.5 inline-flex items-center rounded-md px-2 py-0.5 text-xs text-secondary/80 transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <span>
            {i18nService.t('agentHomeSelectedSkills').replace('{count}', String(agent.skillIds.length))}
          </span>
        </button>
      )}

      {/* AI-Generated Starter Prompts (when present) */}
      {starterPrompts.length > 0 && (
        <div className="mt-8 w-full text-left">
          <div className="mb-2.5 px-0.5 text-xs font-medium text-secondary">
            {i18nService.t('agentHomeStarterTitle')}
          </div>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {starterPrompts.map((prompt, index) => (
              <button
                key={index}
                type="button"
                onClick={() => onUsePrompt(prompt)}
                className="group flex items-start justify-between gap-3 rounded-xl border border-border/80 bg-surface px-4 py-3 text-left transition-all duration-150 hover:border-border hover:bg-surface-raised/45 hover:shadow-[0_4px_14px_rgba(0,0,0,0.04)] active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <span className="line-clamp-2 text-[13px] leading-5 text-foreground">
                  {prompt}
                </span>
                <ArrowRightIcon
                  aria-hidden="true"
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 text-secondary/45 transition-all duration-150 group-hover:translate-x-0.5 group-hover:text-foreground"
                />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Conversational Setup Cards (Unconfigured Custom Agents Only) */}
      {showQuickSetup && (
        <div className="mt-8 w-full text-left">
          <div className="mb-2.5 px-0.5 text-xs font-medium text-secondary">
            {i18nService.t('agentHomeQuickSetupTitle')}
          </div>
          <div className={`grid grid-cols-1 gap-3 ${explicitFolder ? 'sm:grid-cols-2' : ''}`}>
            <button
              type="button"
              onClick={handleInterviewClick}
              className="group flex items-start gap-3 rounded-xl border border-border/80 bg-surface px-4 py-3.5 text-left transition-all duration-150 hover:border-border hover:bg-surface-raised/45 hover:shadow-[0_4px_14px_rgba(0,0,0,0.04)] active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              <ChatBubbleLeftRightIcon
                aria-hidden="true"
                className="mt-0.5 h-[18px] w-[18px] shrink-0 text-secondary transition-colors group-hover:text-foreground"
              />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium leading-5 text-foreground">
                  {i18nService.t('agentHomeInterviewChipTitle')}
                </div>
                <p className="mt-0.5 text-xs leading-5 text-secondary">
                  {i18nService.t('agentHomeInterviewChipDesc')}
                </p>
              </div>
              <ArrowRightIcon
                aria-hidden="true"
                className="mt-1 h-3.5 w-3.5 shrink-0 text-secondary/45 transition-all duration-150 group-hover:translate-x-0.5 group-hover:text-foreground"
              />
            </button>

            {explicitFolder && (
              <button
                type="button"
                onClick={handleScanFolderClick}
                className="group flex items-start gap-3 rounded-xl border border-border/80 bg-surface px-4 py-3.5 text-left transition-all duration-150 hover:border-border hover:bg-surface-raised/45 hover:shadow-[0_4px_14px_rgba(0,0,0,0.04)] active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <DocumentMagnifyingGlassIcon
                  aria-hidden="true"
                  className="mt-0.5 h-[18px] w-[18px] shrink-0 text-secondary transition-colors group-hover:text-foreground"
                />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium leading-5 text-foreground">
                    {i18nService.t('agentHomeScanFolderChipTitle')}
                  </div>
                  <p className="mt-0.5 text-xs leading-5 text-secondary">
                    {i18nService.t('agentHomeScanFolderChipDesc')}
                  </p>
                </div>
                <ArrowRightIcon
                  aria-hidden="true"
                  className="mt-1 h-3.5 w-3.5 shrink-0 text-secondary/45 transition-all duration-150 group-hover:translate-x-0.5 group-hover:text-foreground"
                />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default AgentHomeHero;
