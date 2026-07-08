import React from 'react';

import { i18nService } from '@/services/i18n';
import type { SubagentSessionSummary } from '@/types/cowork';

import {
  COWORK_DETAIL_CONTENT_CLASS,
  COWORK_DETAIL_GUTTER_CLASS,
} from './messageDisplayUtils';

interface SubagentTurnLinksProps {
  subagents: SubagentSessionSummary[];
  variant?: 'turn' | 'tool';
  onSelectSubagent: (subagent: SubagentSessionSummary) => void;
}

const getDisplayName = (subagent: SubagentSessionSummary): string => (
  subagent.label?.trim()
    || subagent.agentId?.trim()
    || i18nService.t('subagentUnnamed')
);

const SubagentTurnLinks: React.FC<SubagentTurnLinksProps> = ({
  subagents,
  variant = 'turn',
  onSelectSubagent,
}) => {
  if (subagents.length === 0) return null;

  const links = (
    <div className="flex flex-wrap items-center gap-2">
      {subagents.map(subagent => (
        <button
          key={subagent.id}
          type="button"
          onClick={() => onSelectSubagent(subagent)}
          className="inline-flex h-8 max-w-full items-center gap-2 rounded-full border border-border bg-background px-3 text-sm text-secondary shadow-sm transition-colors hover:border-primary/40 hover:text-foreground"
          aria-label={getDisplayName(subagent)}
        >
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${
              subagent.status === 'running'
                ? 'animate-pulse bg-blue-500'
                : subagent.status === 'error'
                  ? 'bg-red-500'
                  : 'bg-green-500'
            }`}
          />
          <span className="truncate">{getDisplayName(subagent)}</span>
        </button>
      ))}
    </div>
  );

  if (variant === 'tool') {
    return links;
  }

  return (
    <div className={`mt-2 ${COWORK_DETAIL_GUTTER_CLASS}`}>
      <div className={COWORK_DETAIL_CONTENT_CLASS}>
        {links}
      </div>
    </div>
  );
};

export default SubagentTurnLinks;
