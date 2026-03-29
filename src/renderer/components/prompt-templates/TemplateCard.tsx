import React from 'react';
import { i18nService } from '../../services/i18n';
import type { PromptTemplate } from './types';

interface TemplateCardProps {
  template: PromptTemplate;
  onUse: (template: PromptTemplate) => void;
  onCopy: (template: PromptTemplate) => void;
  onEdit: (template: PromptTemplate) => void;
  onDelete: (template: PromptTemplate) => void;
  onToggleStar: (template: PromptTemplate) => void;
}

export const TemplateCard: React.FC<TemplateCardProps> = ({
  template,
  onUse,
  onCopy,
  onEdit,
  onDelete,
  onToggleStar,
}) => {
  return (
    <div data-testid="template-card" className="group relative bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between gap-2 mb-2">
        <h3 className="text-sm font-semibold dark:text-claude-darkText text-claude-text truncate flex-1">
          {template.title}
        </h3>
        <button
          type="button"
          onClick={() => onToggleStar(template)}
          className={`flex-shrink-0 p-0.5 rounded transition-colors ${
            template.isStarred
              ? 'text-yellow-400'
              : 'text-gray-300 dark:text-gray-600 hover:text-yellow-400'
          }`}
          aria-label={template.isStarred
            ? i18nService.t('promptTemplates.unstar')
            : i18nService.t('promptTemplates.star')}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill={template.isStarred ? 'currentColor' : 'none'}
            stroke="currentColor"
            strokeWidth={template.isStarred ? '0' : '1.5'}
            className="h-4 w-4"
          >
            <path
              fillRule="evenodd"
              d="M10.868 2.884c-.321-.772-1.415-.772-1.736 0l-1.83 4.401-4.753.381c-.833.067-1.171 1.107-.536 1.651l3.62 3.102-1.106 4.637c-.194.813.691 1.456 1.405 1.02L10 15.591l4.069 2.485c.713.436 1.598-.207 1.404-1.02l-1.106-4.637 3.62-3.102c.635-.544.297-1.584-.536-1.65l-4.752-.382-1.831-4.401Z"
              clipRule="evenodd"
            />
          </svg>
        </button>
      </div>

      {template.description && (
        <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary truncate mb-2">
          {template.description}
        </p>
      )}

      <div className="flex items-center gap-2 mb-3">
        {template.category && (
          <span className="px-2 py-0.5 rounded-full text-xs bg-claude-accent/10 text-claude-accent font-medium">
            {template.category}
          </span>
        )}
        {template.usedCount > 0 && (
          <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('promptTemplates.usedCount').replace('{count}', String(template.usedCount))}
          </span>
        )}
      </div>

      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
        <button
          type="button"
          onClick={() => onUse(template)}
          className="flex-1 inline-flex items-center justify-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-claude-accent text-white hover:bg-claude-accentHover transition-colors"
        >
          {i18nService.t('promptTemplates.use')}
        </button>
        <button
          type="button"
          onClick={() => onCopy(template)}
          className="p-1.5 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          aria-label={i18nService.t('promptTemplates.copy')}
          title={i18nService.t('promptTemplates.copy')}
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
            <path d="M7 3.5A1.5 1.5 0 018.5 2h3.879a1.5 1.5 0 011.06.44l3.122 3.12A1.5 1.5 0 0117 6.622V12.5a1.5 1.5 0 01-1.5 1.5h-1v-3.379a3 3 0 00-.879-2.121L10.5 5.379A3 3 0 008.379 4.5H7v-1z" />
            <path d="M4.5 6A1.5 1.5 0 003 7.5v9A1.5 1.5 0 004.5 18h7a1.5 1.5 0 001.5-1.5v-5.879a1.5 1.5 0 00-.44-1.06L9.44 6.439A1.5 1.5 0 008.378 6H4.5z" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => onEdit(template)}
          className="p-1.5 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          aria-label={i18nService.t('promptTemplates.edit')}
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
            <path d="M5.433 13.917l1.262-3.155A4 4 0 017.58 9.42l6.92-6.918a2.121 2.121 0 013 3l-6.92 6.918c-.383.383-.84.685-1.343.886l-3.154 1.262a.5.5 0 01-.65-.65z" />
            <path d="M3.5 5.75c0-.69.56-1.25 1.25-1.25H10A.75.75 0 0010 3H4.75A2.75 2.75 0 002 5.75v9.5A2.75 2.75 0 004.75 18h9.5A2.75 2.75 0 0017 15.25V10a.75.75 0 00-1.5 0v5.25c0 .69-.56 1.25-1.25 1.25h-9.5c-.69 0-1.25-.56-1.25-1.25v-9.5z" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => onDelete(template)}
          className="p-1.5 rounded-lg text-gray-500 dark:text-gray-400 hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-500 dark:hover:text-red-400 transition-colors"
          aria-label={i18nService.t('promptTemplates.delete')}
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
            <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.52.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" clipRule="evenodd" />
          </svg>
        </button>
      </div>
    </div>
  );
};
