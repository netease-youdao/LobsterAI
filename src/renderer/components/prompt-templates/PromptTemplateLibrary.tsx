import React, { useCallback, useEffect, useState, useMemo } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '@/store';
import {
  setActiveCategory,
  setSearchQuery,
  openVariableFillModal,
  closeVariableFillModal,
} from '@/store/slices/promptTemplateSlice';
import { i18nService } from '@/services/i18n';
import {
  promptTemplateService,
  isSystemVariable,
  resolveTemplate,
} from '@/services/promptTemplate';
import type { PromptTemplate, CreateTemplateInput } from './types';
import { TemplateCard } from './TemplateCard';
import { TemplateEditor } from './TemplateEditor';
import { VariableFillModal } from './VariableFillModal';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import ComposeIcon from '../icons/ComposeIcon';
import WindowTitleBar from '../window/WindowTitleBar';

interface PromptTemplateLibraryProps {
  isSidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onNewChat: () => void;
  updateBadge?: React.ReactNode;
  onUseTemplate: (resolvedContent: string) => void;
}

type EditorState =
  | { mode: 'closed' }
  | { mode: 'create' }
  | { mode: 'edit'; template: PromptTemplate };

/** Distinguishes whether the variable-fill modal is triggered by "Use" or "Copy". */
type VariableFillIntent = 'use' | 'copy';

export const PromptTemplateLibrary: React.FC<PromptTemplateLibraryProps> = ({
  isSidebarCollapsed,
  onToggleSidebar,
  onNewChat,
  updateBadge,
  onUseTemplate,
}) => {
  const dispatch = useDispatch();
  const isMac = window.electron.platform === 'darwin';

  const templates = useSelector((state: RootState) => state.promptTemplate.templates);
  const categories = useSelector((state: RootState) => state.promptTemplate.categories);
  const activeCategory = useSelector((state: RootState) => state.promptTemplate.activeCategory);
  const searchQuery = useSelector((state: RootState) => state.promptTemplate.searchQuery);
  const variableFillModal = useSelector((state: RootState) => state.promptTemplate.variableFillModal);

  const [editorState, setEditorState] = useState<EditorState>({ mode: 'closed' });
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteConfirmTemplate, setDeleteConfirmTemplate] = useState<PromptTemplate | null>(null);
  const [variableFillIntent, setVariableFillIntent] = useState<VariableFillIntent>('use');
  const [tipsOpen, setTipsOpen] = useState(() => {
    try {
      return !localStorage.getItem('promptTemplates.tipsRead');
    } catch {
      return true;
    }
  });

  const handleTipsToggle = useCallback(() => {
    setTipsOpen((prev) => {
      const next = !prev;
      if (!prev) {
        try {
          localStorage.setItem('promptTemplates.tipsRead', '1');
        } catch { /* ignore */ }
      }
      return next;
    });
  }, []);

  const showToast = useCallback((message: string) => {
    window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
  }, []);

  useEffect(() => {
    promptTemplateService.loadTemplates();
  }, []);

  const filtered = useMemo(() => {
    let list = templates;
    if (activeCategory) {
      list = list.filter((t) => t.category === activeCategory);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      list = list.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          (t.description ?? '').toLowerCase().includes(q) ||
          (t.category ?? '').toLowerCase().includes(q)
      );
    }
    return [...list].sort((a, b) => {
      if (a.isStarred !== b.isStarred) return a.isStarred ? -1 : 1;
      return b.usedCount - a.usedCount;
    });
  }, [templates, activeCategory, searchQuery]);

  const modalTemplate = useMemo(() => {
    if (!variableFillModal.isOpen || !variableFillModal.templateId) return null;
    return templates.find((t) => t.id === variableFillModal.templateId) ?? null;
  }, [variableFillModal, templates]);

  const handleUse = useCallback((template: PromptTemplate) => {
    const hasUserVars = template.variables.some((v) => !isSystemVariable(v.name));
    if (hasUserVars) {
      setVariableFillIntent('use');
      dispatch(openVariableFillModal(template.id));
    } else {
      const resolved = resolveTemplate(template.content, {});
      promptTemplateService.incrementUsedCount(template.id);
      onUseTemplate(resolved);
    }
  }, [dispatch, onUseTemplate]);

  const copyToClipboard = useCallback(async (text: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for environments where Web Clipboard API is unavailable
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      showToast(i18nService.t('promptTemplates.copySuccess'));
    } catch {
      showToast(i18nService.t('promptTemplates.copyError'));
    }
  }, [showToast]);

  const handleCopy = useCallback((template: PromptTemplate) => {
    const hasUserVars = template.variables.some((v) => !isSystemVariable(v.name));
    if (hasUserVars) {
      setVariableFillIntent('copy');
      dispatch(openVariableFillModal(template.id));
    } else {
      const resolved = resolveTemplate(template.content, {});
      copyToClipboard(resolved);
    }
  }, [dispatch, copyToClipboard]);

  const handleVariableFillConfirm = useCallback((resolvedContent: string) => {
    if (variableFillModal.templateId && variableFillIntent === 'use') {
      promptTemplateService.incrementUsedCount(variableFillModal.templateId);
    }
    dispatch(closeVariableFillModal());
    if (variableFillIntent === 'copy') {
      copyToClipboard(resolvedContent);
    } else {
      onUseTemplate(resolvedContent);
    }
  }, [dispatch, onUseTemplate, copyToClipboard, variableFillModal.templateId, variableFillIntent]);

  const handleSave = useCallback(async (input: CreateTemplateInput) => {
    try {
      if (editorState.mode === 'edit') {
        await promptTemplateService.update(editorState.template.id, input);
      } else {
        await promptTemplateService.create(input);
      }
      setEditorState({ mode: 'closed' });
    } catch (error) {
      showToast(i18nService.t('promptTemplates.saveError'));
      console.error('[PromptTemplates] save failed:', error);
    }
  }, [editorState, showToast]);

  const handleDeleteRequest = useCallback((template: PromptTemplate) => {
    setDeleteConfirmTemplate(template);
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteConfirmTemplate) return;
    setDeleteConfirmTemplate(null);
    setDeletingId(deleteConfirmTemplate.id);
    try {
      await promptTemplateService.delete(deleteConfirmTemplate.id);
    } catch (error) {
      showToast(i18nService.t('promptTemplates.deleteError'));
      console.error('[PromptTemplates] delete failed:', error);
    } finally {
      setDeletingId(null);
    }
  }, [deleteConfirmTemplate, showToast]);

  const handleToggleStar = useCallback(async (template: PromptTemplate) => {
    await promptTemplateService.update(template.id, { isStarred: !template.isStarred });
  }, []);

  const isEmpty = templates.length === 0;
  const isSearchEmpty = !isEmpty && filtered.length === 0;

  return (
    <div className="flex-1 flex flex-col dark:bg-claude-darkBg bg-claude-bg h-full">
      <div className="draggable flex h-12 items-center justify-between px-4 border-b dark:border-claude-darkBorder border-claude-border shrink-0">
        <div className="flex items-center space-x-3 h-8">
          {isSidebarCollapsed && (
            <div className={`non-draggable flex items-center gap-1 ${isMac ? 'pl-[68px]' : ''}`}>
              <button
                type="button"
                onClick={onToggleSidebar}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
              >
                <SidebarToggleIcon className="h-4 w-4" isCollapsed={true} />
              </button>
              <button
                type="button"
                onClick={onNewChat}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
              >
                <ComposeIcon className="h-4 w-4" />
              </button>
              {updateBadge}
            </div>
          )}
          <h1 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
            {i18nService.t('promptTemplates.title')}
          </h1>
        </div>
        <div className="non-draggable flex items-center gap-2">
          <button
            type="button"
            onClick={() => setEditorState({ mode: 'create' })}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg bg-claude-accent text-white hover:bg-claude-accentHover transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
              <path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" />
            </svg>
            {i18nService.t('promptTemplates.createNew')}
          </button>
          <WindowTitleBar inline />
        </div>
      </div>

      <div className="px-4 pt-3 pb-2 shrink-0 space-y-2">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => dispatch(setSearchQuery(e.target.value))}
          placeholder={i18nService.t('promptTemplates.searchPlaceholder')}
          className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-none focus:ring-2 focus:ring-claude-accent/50"
        />

        {categories.length > 0 && (
          <div className="flex items-center gap-2 overflow-x-auto [scrollbar-width:none] pb-1">
            <button
              type="button"
              onClick={() => dispatch(setActiveCategory(null))}
              className={`px-3 py-1 rounded-full text-sm whitespace-nowrap font-medium transition-colors ${
                activeCategory === null
                  ? 'bg-claude-accent text-white'
                  : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
              }`}
            >
              {i18nService.t('promptTemplates.categoryAll')}
            </button>
            {categories.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => dispatch(setActiveCategory(cat))}
                className={`px-3 py-1 rounded-full text-sm whitespace-nowrap font-medium transition-colors ${
                  activeCategory === cat
                    ? 'bg-claude-accent text-white'
                    : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Collapsible usage guide — only show when templates exist */}
      {!isEmpty && (
      <div className="px-4 pb-2 shrink-0">
        <button
          type="button"
          onClick={handleTipsToggle}
          className="flex items-center gap-1.5 text-xs font-medium text-claude-accent hover:underline"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className={`h-3.5 w-3.5 transition-transform ${tipsOpen ? 'rotate-90' : ''}`}
          >
            <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
          </svg>
          {i18nService.t('promptTemplates.tips.title')}
        </button>
        {tipsOpen && (
          <div className="mt-2 p-3 rounded-lg bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 text-xs space-y-3">
            <div>
              <p className="font-medium dark:text-claude-darkText text-claude-text mb-0.5">
                {i18nService.t('promptTemplates.tips.variableSyntax')}
              </p>
              <p className="dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('promptTemplates.tips.variableSyntaxDesc')}
              </p>
            </div>
            <div>
              <p className="font-medium dark:text-claude-darkText text-claude-text mb-0.5">
                {i18nService.t('promptTemplates.tips.systemVariables')}
              </p>
              <p className="dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('promptTemplates.tips.systemVariablesDesc')}
              </p>
            </div>
            <div>
              <p className="font-medium dark:text-claude-darkText text-claude-text mb-0.5">
                {i18nService.t('promptTemplates.tips.variableTypes')}
              </p>
              <p className="dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('promptTemplates.tips.variableTypesDesc')}
              </p>
            </div>
            <div>
              <p className="font-medium dark:text-claude-darkText text-claude-text mb-0.5">
                {i18nService.t('promptTemplates.tips.useVsCopy')}
              </p>
              <p className="dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('promptTemplates.tips.useVsCopyDesc')}
              </p>
            </div>
          </div>
        )}
      </div>
      )}

      <div className="flex-1 overflow-y-auto min-h-0 [scrollbar-gutter:stable] px-4 pb-4">
        {isEmpty && (
          <div className="flex flex-col items-center justify-center h-full text-center py-16 gap-3">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-12 w-12 dark:text-claude-darkTextSecondary text-claude-textSecondary opacity-40">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
            </svg>
            <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('promptTemplates.emptyState')}
            </p>
            <button
              type="button"
              onClick={() => setEditorState({ mode: 'create' })}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-claude-accent text-white hover:bg-claude-accentHover transition-colors"
            >
              {i18nService.t('promptTemplates.createFirst')}
            </button>
          </div>
        )}

        {isSearchEmpty && (
          <div className="flex flex-col items-center justify-center h-full text-center py-16 gap-2">
            <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('promptTemplates.noResults')}
            </p>
          </div>
        )}

        {filtered.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
            {filtered.map((template) => (
              <div key={template.id} className={deletingId === template.id ? 'opacity-50 pointer-events-none' : ''}>
                <TemplateCard
                  template={template}
                  onUse={handleUse}
                  onCopy={handleCopy}
                  onEdit={(t) => setEditorState({ mode: 'edit', template: t })}
                  onDelete={handleDeleteRequest}
                  onToggleStar={handleToggleStar}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {editorState.mode !== 'closed' && (
        <TemplateEditor
          template={editorState.mode === 'edit' ? editorState.template : undefined}
          onSave={handleSave}
          onCancel={() => setEditorState({ mode: 'closed' })}
          existingCategories={categories}
        />
      )}

      {variableFillModal.isOpen && modalTemplate && (
        <VariableFillModal
          template={modalTemplate}
          onConfirm={handleVariableFillConfirm}
          onCancel={() => dispatch(closeVariableFillModal())}
          intent={variableFillIntent}
        />
      )}

      {deleteConfirmTemplate && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setDeleteConfirmTemplate(null)}
        >
          <div
            className="w-full max-w-sm mx-4 dark:bg-claude-darkSurface bg-claude-surface rounded-2xl shadow-xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4">
              <h2 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
                {i18nService.t('promptTemplates.delete')}
              </h2>
            </div>
            <div className="px-5 pb-4">
              <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('promptTemplates.deleteConfirm').replace('{title}', deleteConfirmTemplate.title)}
              </p>
            </div>
            <div className="flex items-center justify-end gap-3 px-5 py-4 border-t dark:border-claude-darkBorder border-claude-border">
              <button
                type="button"
                onClick={() => setDeleteConfirmTemplate(null)}
                className="px-4 py-2 text-sm font-medium rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
              >
                {i18nService.t('cancel')}
              </button>
              <button
                type="button"
                onClick={handleDeleteConfirm}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-red-500 hover:bg-red-600 text-white transition-colors"
              >
                {i18nService.t('promptTemplates.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
