import { SubagentCollaborationMode } from '@shared/agent';
import React from 'react';

import { i18nService } from '../../services/i18n';
import { getAgentDisplayName } from '../../utils/agentDisplay';

interface CollaborationAgentCandidate {
  id: string;
  name: string;
  description?: string;
}

interface AgentCollaborationSettingsProps {
  mode: SubagentCollaborationMode;
  allowAgentIds: string[];
  candidates: CollaborationAgentCandidate[];
  onChangeMode: (mode: SubagentCollaborationMode) => void;
  onToggleAllowAgent: (agentId: string) => void;
}

const MODE_OPTIONS: Array<{
  value: SubagentCollaborationMode;
  titleKey: string;
  hintKey: string;
}> = [
  {
    value: SubagentCollaborationMode.All,
    titleKey: 'agentSubagentsModeAll',
    hintKey: 'agentSubagentsModeAllHint',
  },
  {
    value: SubagentCollaborationMode.Allowlist,
    titleKey: 'agentSubagentsModeAllowlist',
    hintKey: 'agentSubagentsModeAllowlistHint',
  },
  {
    value: SubagentCollaborationMode.Disabled,
    titleKey: 'agentSubagentsModeDisabled',
    hintKey: 'agentSubagentsModeDisabledHint',
  },
];

const AgentCollaborationSettings: React.FC<AgentCollaborationSettingsProps> = ({
  mode,
  allowAgentIds,
  candidates,
  onChangeMode,
  onToggleAllowAgent,
}) => (
  <div className="h-full overflow-y-auto">
    <div className="mb-4">
      <div className="text-sm font-semibold text-foreground">
        {i18nService.t('agentSubagentsTitle')}
      </div>
      <p className="mt-1 text-xs leading-5 text-secondary">
        {i18nService.t('agentSubagentsHint')}
      </p>
    </div>

    <div className="mb-4 space-y-2" role="radiogroup" aria-label={i18nService.t('agentSubagentsTitle')}>
      {MODE_OPTIONS.map((option) => {
        const selected = mode === option.value;
        return (
          <label
            key={option.value}
            className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3.5 py-2.5 transition-colors ${
              selected
                ? 'border-primary/60 bg-primary/5'
                : 'border-border hover:bg-surface-raised'
            }`}
          >
            <input
              type="radio"
              name="subagent-collaboration-mode"
              checked={selected}
              onChange={() => onChangeMode(option.value)}
              className="mt-0.5 h-4 w-4 shrink-0 border-border text-primary focus:ring-primary"
            />
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">
                {i18nService.t(option.titleKey)}
              </div>
              <p className="mt-0.5 text-xs leading-5 text-secondary">
                {i18nService.t(option.hintKey)}
              </p>
            </div>
          </label>
        );
      })}
    </div>

    {mode === SubagentCollaborationMode.Allowlist && (
      candidates.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-secondary">
          {i18nService.t('agentSubagentsEmpty')}
        </div>
      ) : (
        <div className="space-y-1">
          {allowAgentIds.length === 0 && (
            <p className="mb-2 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-secondary">
              {i18nService.t('agentSubagentsAllowlistEmptyHint')}
            </p>
          )}
          {candidates.map((candidate) => {
            const checked = allowAgentIds.includes(candidate.id);
            const displayName = getAgentDisplayName(candidate);
            return (
              <label
                key={candidate.id}
                className="flex cursor-pointer items-center justify-between gap-4 rounded-lg px-3 py-2.5 transition-colors hover:bg-surface-raised"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-raised text-sm">
                    <span className="font-medium text-secondary">
                      {displayName.slice(0, 1).toUpperCase()}
                    </span>
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-foreground">
                      {displayName}
                    </div>
                    <div className="truncate text-xs text-secondary">
                      {candidate.description?.trim() || candidate.id}
                    </div>
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggleAllowAgent(candidate.id)}
                  className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
                  aria-label={displayName}
                />
              </label>
            );
          })}
        </div>
      )
    )}
  </div>
);

export default AgentCollaborationSettings;
