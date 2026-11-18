import { CheckIcon } from '@heroicons/react/24/outline';
import React from 'react';

import MarkdownContent from '../MarkdownContent';
import type { ActivityPlan, ParsedTodoItem, TodoStatus } from './messageDisplayUtils';

const getStatusCheckboxClass = (status: TodoStatus): string => {
  switch (status) {
    case 'completed':
      return 'bg-green-500/10 border-green-500 text-green-500';
    case 'in_progress':
      return 'bg-transparent border-blue-500';
    case 'pending':
    case 'unknown':
    default:
      return 'bg-transparent border-border';
  }
};

/** A checklist of plan or todo items, each with its status box. */
export const TodoWriteInputView: React.FC<{ items: ParsedTodoItem[] }> = ({ items }) => (
  <div className="space-y-2">
    {items.map((item, index) => (
      <div
        key={`todo-item-${index}`}
        className="flex items-start gap-2"
      >
        <span className={`mt-0.5 h-4 w-4 rounded-[4px] border flex-shrink-0 inline-flex items-center justify-center ${getStatusCheckboxClass(item.status)}`}>
          {item.status === 'completed' && <CheckIcon className="h-3 w-3 stroke-[2.5]" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className={`text-xs whitespace-pre-wrap break-words leading-5 ${
            item.status === 'completed'
              ? 'text-muted'
              : 'text-foreground'
          }`}>
            {item.primaryText}
          </div>
        </div>
      </div>
    ))}
  </div>
);

/** A published plan in full: its checklist, then its note. */
export const ActivityPlanDetail: React.FC<{
  plan: ActivityPlan;
  mapDisplayText?: (value: string) => string;
}> = ({ plan, mapDisplayText }) => (
  <div className="space-y-3">
    {plan.steps.length > 0 && <TodoWriteInputView items={plan.steps} />}
    {plan.markdown && (
      <MarkdownContent
        content={mapDisplayText ? mapDisplayText(plan.markdown) : plan.markdown}
        className="!text-xs !leading-5 [&_p]:!my-0 [&_p]:!text-secondary"
      />
    )}
  </div>
);
