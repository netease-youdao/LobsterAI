import { ChevronRightIcon } from '@heroicons/react/24/outline';
import React, { useId, useState } from 'react';

import { i18nService } from '../../services/i18n';
import type { Model } from '../../store/slices/modelSlice';
import { groupModelChoices, type ModelChoice } from './modelGroups';

interface Props {
  models: Model[];
  query: string;
  isSelected: (model: Model) => boolean;
  renderModel: (model: Model, label?: string) => React.ReactNode;
  renderIcon: (model: Model) => React.ReactNode;
}

/** Presentation only: selecting a route uses the original model and thinking controls. */
export default function GroupedModelList({
  models,
  query,
  isSelected,
  renderModel,
  renderIcon,
}: Props) {
  const groups = groupModelChoices(models, query);
  const id = useId();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const searching = query.trim().length > 0;
  const isExpanded = (key: string, selected: boolean) => searching || (expanded[key] ?? selected);
  const toggle = (key: string, open: boolean) =>
    setExpanded(current => ({ ...current, [key]: !open }));

  const renderChoice = (choice: ModelChoice, index: string) => {
    if (choice.routes.length === 1) return renderModel(choice.routes[0]);
    const selected = choice.routes.some(isSelected);
    const open = isExpanded(choice.key, selected);
    const contentId = `${id}-routes-${index}`;
    return (
      <div key={choice.key}>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => toggle(choice.key, open)}
          className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] hover:bg-surface-raised ${selected ? 'text-primary' : 'text-foreground'}`}
        >
          <span className="min-w-0 flex-1 truncate">{choice.name}</span>
          <span className="shrink-0 text-[11px] text-secondary">
            {i18nService
              .t('modelSelectorRouteCount')
              .replace('{count}', String(choice.routes.length))}
          </span>
          <ChevronRightIcon
            className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
          />
        </button>
        {open && (
          <div id={contentId} className="ml-3 border-l border-border/60">
            {choice.routes.map((route, routeIndex) =>
              renderModel(
                route,
                i18nService
                  .t('modelSelectorRouteNumber')
                  .replace('{number}', String(routeIndex + 1)),
              ),
            )}
          </div>
        )}
      </div>
    );
  };

  return groups.map((group, groupIndex) => {
    if (group.choices.length === 1)
      return (
        <React.Fragment key={group.name}>
          {renderChoice(group.choices[0], String(groupIndex))}
        </React.Fragment>
      );
    const key = `family:${group.name}`;
    const selected = group.choices.some(choice => choice.routes.some(isSelected));
    const open = isExpanded(key, selected);
    const contentId = `${id}-family-${groupIndex}`;
    return (
      <div key={group.name} className="px-1.5 py-0.5">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => toggle(key, open)}
          className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-[13px] hover:bg-surface-raised ${selected ? 'text-primary' : 'text-foreground'}`}
        >
          <span className="flex h-5 w-5 shrink-0 items-center justify-center">
            {renderIcon(group.choices[0].routes[0])}
          </span>
          <span className="min-w-0 flex-1 truncate font-medium">{group.name}</span>
          <span className="text-[11px] text-secondary">{group.choices.length}</span>
          {selected && <span className="h-1.5 w-1.5 rounded-full bg-primary" />}
          <ChevronRightIcon
            className={`h-3.5 w-3.5 shrink-0 text-secondary transition-transform ${open ? 'rotate-90' : ''}`}
          />
        </button>
        {open && (
          <div id={contentId} className="ml-3 border-l border-border/60 pl-1">
            {group.choices.map((choice, index) => renderChoice(choice, `${groupIndex}-${index}`))}
          </div>
        )}
      </div>
    );
  });
}
