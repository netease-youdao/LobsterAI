import { CheckCircleIcon, ChevronDownIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { useId, useState } from 'react';

import { CompanionSelectionAction } from '../../../shared/desktopCompanion/selectionActions';
import type { CompanionSelectionTaskContext } from '../../../shared/desktopCompanion/selectionTaskContext';
import { i18nService } from '../../services/i18n';
import CompanionMarkdown from './CompanionMarkdown';
import { COMPANION_TOOLBAR_PRESENTATION } from './selectionToolbarPresentation';

const t = (key: string) => i18nService.t(key);

export default function SelectionTaskContextCard({ context, onRemove }: {
  context: CompanionSelectionTaskContext;
  onRemove: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const { icon: Icon, labelKey } = COMPANION_TOOLBAR_PRESENTATION[context.action];
  return (
    <section className="px-3 pt-3" aria-label={t('desktopCompanionTaskContextAttached')}>
      <div className="overflow-hidden rounded-xl border border-border-subtle bg-surface-raised/60">
        <div className="flex items-start gap-1 p-3">
          <button
            type="button"
            className="group min-w-0 flex-1 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => setExpanded(value => !value)}
          >
            <span className="flex min-w-0 items-center gap-1.5 text-xs">
              <Icon className="h-4 w-4 shrink-0 text-secondary" aria-hidden="true" />
              <span className="truncate font-medium text-foreground">{t(labelKey)}</span>
              <span className="ml-auto flex shrink-0 items-center gap-1 text-secondary">
                <CheckCircleIcon className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                {t('desktopCompanionTaskContextAttached')}
              </span>
            </span>
            {!expanded && <span className="mt-2 line-clamp-2 break-words text-sm leading-5 text-secondary [overflow-wrap:anywhere]">{context.sourceText}</span>}
            <span className="mt-2 flex items-center gap-1 text-xs text-muted group-hover:text-foreground">
              {t(expanded ? 'desktopCompanionTaskContextCollapse' : 'desktopCompanionTaskContextExpand')}
              <ChevronDownIcon className={`h-3 w-3 transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
            </span>
          </button>
          <button
            type="button"
            className="-mr-1 -mt-1 rounded-md p-1 text-muted hover:bg-surface-raised hover:text-foreground focus-visible:outline-primary"
            title={t('desktopCompanionTaskContextRemove')}
            aria-label={t('desktopCompanionTaskContextRemove')}
            onClick={onRemove}
          ><XMarkIcon className="h-4 w-4" aria-hidden="true" /></button>
        </div>
        {expanded && (
          <div id={detailsId} className="max-h-44 space-y-4 overflow-y-auto overscroll-contain border-t border-border-subtle px-3 py-3 text-sm [overflow-wrap:anywhere]">
            <div>
              <p className="mb-1 text-xs font-medium text-muted">{t('desktopToolsInput')}</p>
              <p className="whitespace-pre-wrap text-secondary">{context.sourceText}</p>
            </div>
            {context.turns.map((turn, index) => (
              <div key={index}>
                <p className="mb-1 text-xs font-medium text-muted">
                  {t(turn.role === 'user' ? 'desktopCompanionTaskContextQuestion'
                    : index === 0 && context.action === CompanionSelectionAction.Translate ? 'desktopToolsTranslation' : 'desktopToolsReply')}
                </p>
                {turn.role === 'user' ? <p className="whitespace-pre-wrap text-secondary">{turn.content}</p> : (
                  <div className="prose prose-sm max-w-none text-secondary [&_pre]:overflow-x-auto [&_table]:block [&_table]:overflow-x-auto">
                    <CompanionMarkdown text={turn.content} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
