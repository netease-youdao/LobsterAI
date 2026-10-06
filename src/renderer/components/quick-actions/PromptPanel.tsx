import { ArrowRightIcon } from '@heroicons/react/24/outline';
import React from 'react';
import { useDispatch, useSelector } from 'react-redux';

import { i18nService } from '../../services/i18n';
import { RootState } from '../../store';
import { selectPrompt } from '../../store/slices/quickActionSlice';
import type { LocalizedPrompt, LocalizedQuickAction } from '../../types/quickAction';
import XMarkIcon from '../icons/XMarkIcon';

interface PromptPanelProps {
  action: LocalizedQuickAction;
  onPromptSelect: (prompt: string, promptId: string) => void;
  onClose?: () => void;
}

const PromptPanel: React.FC<PromptPanelProps> = ({ action, onPromptSelect, onClose }) => {
  const dispatch = useDispatch();
  const selectedPromptId = useSelector(
    (state: RootState) => state.quickAction.selectedPromptId
  );

  const handlePromptClick = (prompt: LocalizedPrompt) => {
    dispatch(selectPrompt(prompt.id));
    onPromptSelect(prompt.prompt, prompt.id);
  };

  if (!action.prompts || action.prompts.length === 0) {
    return null;
  }

  return (
    <div data-skin-prompt-panel="true" className="w-full animate-fade-in-up">
      {/* 标题 */}
      <div className="mb-2.5 flex items-center justify-between px-0.5">
        <span className="text-xs font-medium text-secondary">
          {action.label}
        </span>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label={i18nService.t('coworkQuickActionCollapse')}
            title={i18nService.t('coworkQuickActionCollapse')}
            className="flex h-5 w-5 items-center justify-center rounded-md text-secondary transition-colors duration-150 hover:bg-surface-raised hover:text-foreground"
          >
            <XMarkIcon className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* 提示词卡片网格 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {action.prompts.map((prompt) => {
          const isPromptSelected = selectedPromptId === prompt.id;

          return (
            <button
              key={prompt.id}
              type="button"
              onClick={() => handlePromptClick(prompt)}
              className={`
                group relative flex flex-col items-start gap-1.5 px-3.5 py-3 rounded-lg
                border text-left transition-all duration-200
                ${
                  isPromptSelected
                    ? 'dark:bg-primary-muted bg-primary-muted border-[color-mix(in_srgb,var(--lobster-primary)_50%,transparent)]'
                    : 'bg-surface border-border hover:border-primary/30 hover:bg-surface-raised'
                }
              `}
            >
              {/* 标题 */}
              <div className="flex items-center justify-between w-full">
                <span className={`text-sm font-medium ${isPromptSelected ? 'text-primary' : 'text-foreground'}`}>
                  {prompt.label}
                </span>
                <ArrowRightIcon
                  className={`
                    w-3.5 h-3.5 transition-all duration-200
                    ${
                      isPromptSelected
                        ? 'text-primary translate-x-0 opacity-100'
                        : 'text-secondary -translate-x-1 opacity-0 group-hover:translate-x-0 group-hover:opacity-100'
                    }
                  `}
                />
              </div>

              {/* 描述 */}
              {prompt.description && (
                <p className="text-xs text-secondary line-clamp-2">
                  {prompt.description}
                </p>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default PromptPanel;
