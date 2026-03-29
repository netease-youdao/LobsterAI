import React, { useState, useEffect, useCallback } from 'react';
import { i18nService } from '../../services/i18n';
import { extractVariableNames, isSystemVariable } from '../../services/promptTemplate';
import type { PromptTemplate, TemplateVariable, CreateTemplateInput } from './types';

interface TemplateEditorProps {
  template?: PromptTemplate;
  onSave: (input: CreateTemplateInput) => void;
  onCancel: () => void;
  existingCategories: string[];
}

const defaultVariable = (name: string): TemplateVariable => ({
  name,
  type: 'text',
  label: '',
  defaultValue: '',
  options: [],
});

export const TemplateEditor: React.FC<TemplateEditorProps> = ({
  template,
  onSave,
  onCancel,
  existingCategories,
}) => {
  const [title, setTitle] = useState(template?.title ?? '');
  const [content, setContent] = useState(template?.content ?? '');
  const [description, setDescription] = useState(template?.description ?? '');
  const [category, setCategory] = useState(template?.category ?? '');
  const [variables, setVariables] = useState<TemplateVariable[]>(template?.variables ?? []);

  const syncVariables = useCallback((newContent: string) => {
    const names = extractVariableNames(newContent).filter((n) => !isSystemVariable(n));
    setVariables((prev) => {
      const prevMap = new Map(prev.map((v) => [v.name, v]));
      return names.map((name) => prevMap.get(name) ?? defaultVariable(name));
    });
  }, []);

  useEffect(() => {
    syncVariables(content);
  }, [content, syncVariables]);

  const handleSave = () => {
    onSave({ title, content, description: description || undefined, category: category || undefined, variables });
  };

  const updateVariable = (index: number, patch: Partial<TemplateVariable>) => {
    setVariables((prev) => prev.map((v, i) => (i === index ? { ...v, ...patch } : v)));
  };

  const isValid = title.trim().length > 0 && content.trim().length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-2xl mx-4 dark:bg-claude-darkSurface bg-claude-surface rounded-2xl shadow-xl overflow-hidden flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b dark:border-claude-darkBorder border-claude-border shrink-0">
          <h2 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
            {template
              ? i18nService.t('promptTemplates.editTitle')
              : i18nService.t('promptTemplates.createTitle')}
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
          <div>
            <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary uppercase tracking-wider mb-1">
              {i18nService.t('promptTemplates.fieldTitle')}
              <span className="text-red-500 ml-0.5">*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={i18nService.t('promptTemplates.fieldTitlePlaceholder')}
              className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-claude-accent/50"
            />
          </div>

          <div>
            <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary uppercase tracking-wider mb-1">
              {i18nService.t('promptTemplates.fieldContent')}
              <span className="text-red-500 ml-0.5">*</span>
            </label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={i18nService.t('promptTemplates.fieldContentPlaceholder')}
              rows={6}
              className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-claude-accent/50 resize-y font-mono"
            />
          </div>

          <div>
            <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary uppercase tracking-wider mb-1">
              {i18nService.t('promptTemplates.fieldDescription')}
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={i18nService.t('promptTemplates.fieldDescriptionPlaceholder')}
              className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-claude-accent/50"
            />
          </div>

          <div>
            <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary uppercase tracking-wider mb-1">
              {i18nService.t('promptTemplates.fieldCategory')}
            </label>
            <input
              type="text"
              list="template-categories"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder={i18nService.t('promptTemplates.fieldCategoryPlaceholder')}
              className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-claude-accent/50"
            />
            <datalist id="template-categories">
              {existingCategories.map((cat) => (
                <option key={cat} value={cat} />
              ))}
            </datalist>
          </div>

          {variables.length > 0 && (
            <div>
              <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary uppercase tracking-wider mb-2">
                {i18nService.t('promptTemplates.fieldVariables')}
              </label>
              <div className="space-y-3">
                {variables.map((variable, index) => (
                  <div key={variable.name} className="border border-gray-200 dark:border-gray-700 rounded-lg p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <code className="text-xs font-mono bg-gray-100 dark:bg-gray-900 px-2 py-0.5 rounded text-claude-accent">
                        {`{{${variable.name}}}`}
                      </code>
                      <select
                        value={variable.type}
                        onChange={(e) => updateVariable(index, { type: e.target.value as 'text' | 'select' })}
                        className="ml-auto border border-gray-300 dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-xs"
                      >
                        <option value="text">{i18nService.t('promptTemplates.varTypeText')}</option>
                        <option value="select">{i18nService.t('promptTemplates.varTypeSelect')}</option>
                      </select>
                    </div>
                    <input
                      type="text"
                      value={variable.label ?? ''}
                      onChange={(e) => updateVariable(index, { label: e.target.value })}
                      placeholder={i18nService.t('promptTemplates.varLabelPlaceholder')}
                      className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-xs"
                    />
                    <input
                      type="text"
                      value={variable.defaultValue ?? ''}
                      onChange={(e) => updateVariable(index, { defaultValue: e.target.value })}
                      placeholder={i18nService.t('promptTemplates.varDefaultPlaceholder')}
                      className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-xs"
                    />
                    {variable.type === 'select' && (
                      <textarea
                        value={(variable.options ?? []).join('\n')}
                        onChange={(e) => updateVariable(index, { options: e.target.value.split('\n').filter(Boolean) })}
                        placeholder={i18nService.t('promptTemplates.varOptionsPlaceholder')}
                        rows={3}
                        className="w-full border border-gray-300 dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-xs resize-none"
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
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
            onClick={handleSave}
            disabled={!isValid}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-claude-accent hover:bg-claude-accentHover text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {i18nService.t('save')}
          </button>
        </div>
      </div>
    </div>
  );
};
