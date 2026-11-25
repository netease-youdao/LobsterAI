import type { AgentSource } from '@shared/agent';
import React from 'react';

import { i18nService } from '../../services/i18n';
import { getAgentDisplayName, usesManagedPresetAvatar } from '../../utils/agentDisplay';
import AgentAvatarIcon from './AgentAvatarIcon';

export interface CollaborationAgentCandidate {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  iconCustomized?: boolean;
  source?: AgentSource;
  presetId?: string;
}

interface AgentCollaborationSettingsProps {
  allowAgentIds: string[];
  candidates: CollaborationAgentCandidate[];
  onToggleAllowAgent: (agentId: string) => void;
}

const AgentCollaborationSettings: React.FC<AgentCollaborationSettingsProps> = ({
  allowAgentIds,
  candidates,
  onToggleAllowAgent,
}) => {
  if (candidates.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border px-4 py-5 text-center text-xs text-secondary">
        {i18nService.t('agentSubagentsEmpty')}
      </div>
    );
  }

  const hasSelectedCandidate = candidates.some(candidate => allowAgentIds.includes(candidate.id));

  return (
    <div className="space-y-0.5">
      {!hasSelectedCandidate && (
        <p className="px-2.5 pt-1 pb-1.5 text-xs leading-5 text-secondary">
          {i18nService.t('agentSubagentsAllowlistEmptyHint')}
        </p>
      )}
      {candidates.map((candidate) => {
        const checked = allowAgentIds.includes(candidate.id);
        const displayName = getAgentDisplayName(candidate);
        return (
          <label
            key={candidate.id}
            className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2.5 py-2 transition-colors ${
              checked
                ? 'bg-surface shadow-subtle ring-1 ring-inset ring-border/70'
                : 'hover:bg-surface-raised/70'
            }`}
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <AgentAvatarIcon
                value={candidate.icon}
                expertFallback={usesManagedPresetAvatar(candidate)}
                className="h-7 w-7 bg-surface-raised"
                iconClassName="h-4 w-4"
              />
              <div className="min-w-0">
                <div className="truncate text-xs font-medium text-foreground">
                  {displayName}
                </div>
                <div className="truncate text-[11px] text-secondary">
                  {candidate.description?.trim() || candidate.id}
                </div>
              </div>
            </div>
            <input
              type="checkbox"
              checked={checked}
              onChange={() => onToggleAllowAgent(candidate.id)}
              className="h-4 w-4 shrink-0 rounded border-border accent-foreground"
              aria-label={displayName}
            />
          </label>
        );
      })}
    </div>
  );
};

export default AgentCollaborationSettings;
