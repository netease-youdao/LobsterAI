import React, { useState } from 'react';
import { i18nService } from '../../services/i18n';
import { isSystemVariable, resolveTemplate } from '../../services/promptTemplate';
import type { PromptTemplate, TemplateVariable } from './types';

interface VariableFillModalProps {
  template: PromptTemplate;
  onConfirm: (resolvedContent: string) => void;
  onCancel: () => void;
  /** Controls confirm button label: 'use' shows "Confirm & Insert", 'copy' shows "Confirm & Copy". */
  intent?: 'use' | 'copy';
}

type FilledValues = Record<string, string>;

const userVariables = (variables: TemplateVariable[]): TemplateVariable[] =>
  variables.filter((v) => !isSystemVariable(v.name));

export const VariableFillModal: React.FC<VariableFillModalProps> = ({
  template,
  onConfirm,
  onCancel,
  intent = 'use',
}) => {
  const vars = userVariables(template.variables);

  const [values, setValues] = useState<FilledValues>(() =>
    Object.fromEntries(vars.map((v) => [v.name, v.defaultValue ?? '']))
  );

  const setValue = (name: string, value: string) =>
    setValues((prev) => ({ ...prev, [name]: value }));

  const handleConfirm = () => {
    const resolved = resolveTemplate(template.content, values);
    onConfirm(resolved);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md mx-4 dark:bg-claude-darkSurface bg-claude-surface rounded-2xl shadow-xl overflow-hidden flex flex-col max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b dark:border-claude-darkBorder border-claude-border shrink-0">
          <h2 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
            {i18nService.t('promptTemplates.variableFill.title')}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            className="p-1.5 rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('promptTemplates.variableFill.subtitle').replace('{title}', template.title)}
          </p>

          {vars.map((variable) => (
            <div key={variable.name}>
              <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary uppercase tracking-wider mb-1">
                {variable.label && variable.label.trim()
                  ? variable.label
                  : variable.name}
              </label>
              {variable.type === 'select' && variable.options && variable.options.length > 0 ? (
                <select
                  value={values[variable.name] ?? ''}
                  onChange={(e) => setValue(variable.name, e.target.value)}
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-claude-accent/50"
                >
                  {!values[variable.name] && (
                    <option value="">
                      {i18nService.t('promptTemplates.variableFill.selectPlaceholder')}
                    </option>
                  )}
                  {variable.options.map((opt) => (
                    <option key={opt} value={opt}>
                      {opt}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={values[variable.name] ?? ''}
                  onChange={(e) => setValue(variable.name, e.target.value)}
                  placeholder={variable.defaultValue || variable.name}
                  className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-claude-accent/50"
                />
              )}
            </div>
          ))}
        </div>

        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t dark:border-claude-darkBorder border-claude-border shrink-0">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
          >
            {i18nService.t('cancel')}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-claude-accent hover:bg-claude-accentHover text-white transition-colors"
          >
            {intent === 'copy'
              ? i18nService.t('promptTemplates.variableFill.copyConfirm')
              : i18nService.t('promptTemplates.variableFill.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
};
