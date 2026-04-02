import React from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '../../store';
import { selectPrompt } from '../../store/slices/quickActionSlice';
import type { LocalizedQuickAction, LocalizedPrompt } from '../../types/quickAction';
import { ArrowRightIcon } from '@heroicons/react/24/outline';

interface PromptPanelProps {
  action: LocalizedQuickAction;
  onPromptSelect: (prompt: string) => void;
}

const PromptPanel: React.FC<PromptPanelProps> = ({ action, onPromptSelect }) => {
  const dispatch = useDispatch();
  const selectedPromptId = useSelector(
    (state: RootState) => state.quickAction.selectedPromptId
  );

  const handlePromptClick = (prompt: LocalizedPrompt) => {
    dispatch(selectPrompt(prompt.id));
    onPromptSelect(prompt.prompt);
  };

  if (!action.prompts || action.prompts.length === 0) {
    return null;
  }

  return (
    <div className="w-full animate-fade-in-up">
      {/* 标题 */}
      <div className="mb-2.5 px-0.5">
        <span className="text-xs font-medium text-secondary">
          {action.label}
        </span>
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
                    ? 'dark:bg-primary-muted bg-primary-muted border-primary/50'
                    : 'bg-surface border-border hover:border-border hover:border-border hover:bg-surface-raised'
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
