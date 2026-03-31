import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { i18nService } from '../../services/i18n';
import { useSelectionToolbarConfig } from './useSelectionToolbarConfig';
import {
  DEFAULT_ACTIONS,
  CUSTOM_ACTION_TEMPLATES,
  validatePromptTemplate,
} from './selectionActions';
import type { ActionConfig, SelectionToolbarConfig } from './types';

const BUILTIN_LABEL_KEYS: Record<string, string> = {
  copy: 'selectionToolbarCopy',
  quote: 'selectionToolbarQuote',
  explain: 'selectionToolbarExplain',
  translate: 'selectionToolbarTranslate',
  ask: 'selectionToolbarAsk',
};

const ICON_PICKER_OPTIONS = ['📝', '✨', '🔍', '⚡', '💡', '📋', '🎯', '🔧', '💬', '📊', '🌐', '🎨'];

interface EditingAction {
  id: string;
  label: string;
  icon: string;
  prompt: string;
}

const SelectionToolbarSettings: React.FC = () => {
  const { config, setConfig, resetToDefault, loading } = useSelectionToolbarConfig();
  const [editingAction, setEditingAction] = useState<EditingAction | null>(null);
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const [editError, setEditError] = useState('');
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showIconPicker, setShowIconPicker] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const templatePickerRef = useRef<HTMLDivElement>(null);
  const iconPickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showTemplatePicker && !showIconPicker) return;
    const handler = (e: MouseEvent) => {
      if (showTemplatePicker && templatePickerRef.current && !templatePickerRef.current.contains(e.target as Node)) {
        setShowTemplatePicker(false);
      }
      if (showIconPicker && iconPickerRef.current && !iconPickerRef.current.contains(e.target as Node)) {
        setShowIconPicker(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showTemplatePicker, showIconPicker]);

  const actionConfigs = useMemo(() => config.actions ?? DEFAULT_ACTIONS, [config.actions]);

  const updateConfig = useCallback((newActions: ActionConfig[]) => {
    const newConfig: SelectionToolbarConfig = { version: 1, actions: newActions };
    setConfig(newConfig);
  }, [setConfig]);

  const toggleAction = useCallback((id: string) => {
    const updated = actionConfigs.map(a =>
      a.id === id ? { ...a, enabled: !a.enabled } : a
    );
    updateConfig(updated);
  }, [actionConfigs, updateConfig]);

  const moveAction = useCallback((id: string, direction: 'up' | 'down') => {
    const sorted = [...actionConfigs].sort((a, b) => a.order - b.order);
    const idx = sorted.findIndex(a => a.id === id);
    if (idx < 0) return;
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= sorted.length) return;

    const updated = sorted.map((a, i) => {
      if (i === idx) return { ...a, order: swapIdx };
      if (i === swapIdx) return { ...a, order: idx };
      return { ...a, order: i };
    });
    updateConfig(updated);
  }, [actionConfigs, updateConfig]);

  const confirmDeleteAction = useCallback((id: string) => {
    const updated = actionConfigs.filter(a => a.id !== id);
    updateConfig(updated);
    setDeletingId(null);
  }, [actionConfigs, updateConfig]);

  const handleAddFromTemplate = (templateIndex: number) => {
    const template = CUSTOM_ACTION_TEMPLATES[templateIndex];
    setEditingAction({
      id: '',
      label: i18nService.t(template.labelKey),
      icon: template.icon,
      prompt: i18nService.t(template.promptKey),
    });
    setShowTemplatePicker(false);
    setEditError('');
  };

  const handleSaveAction = () => {
    if (!editingAction) return;

    if (!editingAction.label.trim()) {
      setEditError(i18nService.t('selectionToolbarNameRequired'));
      return;
    }

    const validation = validatePromptTemplate(editingAction.prompt);
    if (!validation.valid) {
      setEditError(validation.error ?? '');
      return;
    }

    const isNew = editingAction.id === '';
    if (isNew) {
      const maxOrder = actionConfigs.length === 0
        ? -1
        : Math.max(...actionConfigs.map(a => a.order));
      const newAction: ActionConfig = {
        id: crypto.randomUUID(),
        type: 'custom',
        enabled: true,
        order: maxOrder + 1,
        label: editingAction.label,
        icon: editingAction.icon,
        prompt: editingAction.prompt,
      };
      updateConfig([...actionConfigs, newAction]);
    } else {
      const updated = actionConfigs.map(a =>
        a.id === editingAction.id
          ? { ...a, label: editingAction.label, icon: editingAction.icon, prompt: editingAction.prompt }
          : a
      );
      updateConfig(updated);
    }
    setEditingAction(null);
    setEditError('');
  };

  const handleReset = () => {
    resetToDefault();
    setShowResetConfirm(false);
    setEditingAction(null);
    setDeletingId(null);
  };

  const sortedActions = useMemo(() =>
    [...actionConfigs].sort((a, b) => a.order - b.order),
    [actionConfigs]
  );

  if (loading) return null;

  return (
    <div>
      <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-1">
        {i18nService.t('selectionToolbarSettings')}
      </h4>
      <p className="text-xs dark:text-claude-darkSecondaryText text-claude-secondaryText mb-4">
        {i18nService.t('selectionToolbarSettingsDesc')}
      </p>

      {/* Unified Action List */}
      <div className="mb-4">
        <h5 className="text-xs font-medium dark:text-claude-darkSecondaryText text-claude-secondaryText mb-2">
          {i18nService.t('selectionToolbarActionList')}
        </h5>
        <div className="space-y-2">
          {sortedActions.map((action) => (
            <div key={action.id} className="flex items-center justify-between py-1">
              <div className="flex items-center gap-1.5 min-w-0">
                {action.type === 'builtin' ? (
                  <>
                    <span className="text-sm dark:text-claude-darkText text-claude-text">
                      {i18nService.t(BUILTIN_LABEL_KEYS[action.id] ?? action.id)}
                    </span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-claude-accent/10 text-claude-accent font-medium leading-none">
                      {i18nService.t('selectionToolbarBuiltinBadge')}
                    </span>
                  </>
                ) : (
                  <span className="text-sm dark:text-claude-darkText text-claude-text truncate">
                    {action.icon} {action.label}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <button
                  type="button"
                  onClick={() => moveAction(action.id, 'up')}
                  disabled={sortedActions.findIndex(a => a.id === action.id) === 0}
                  className="text-xs px-1.5 py-0.5 rounded dark:text-claude-darkSecondaryText text-claude-secondaryText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover disabled:opacity-30 disabled:cursor-not-allowed"
                  title={i18nService.t('selectionToolbarMoveUp')}
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => moveAction(action.id, 'down')}
                  disabled={sortedActions.findIndex(a => a.id === action.id) === sortedActions.length - 1}
                  className="text-xs px-1.5 py-0.5 rounded dark:text-claude-darkSecondaryText text-claude-secondaryText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover disabled:opacity-30 disabled:cursor-not-allowed"
                  title={i18nService.t('selectionToolbarMoveDown')}
                >
                  ↓
                </button>
                <button
                  type="button"
                  role="switch"
                  aria-checked={action.enabled}
                  onClick={() => toggleAction(action.id)}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
                    action.enabled
                      ? 'bg-claude-accent'
                      : 'bg-gray-300 dark:bg-gray-600'
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      action.enabled ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
                {action.type === 'custom' && (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingAction({
                          id: action.id,
                          label: action.label ?? '',
                          icon: action.icon ?? '⚡',
                          prompt: action.prompt ?? '',
                        });
                        setEditError('');
                      }}
                      className="text-xs px-2 py-1 rounded dark:text-claude-darkSecondaryText text-claude-secondaryText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
                    >
                      {i18nService.t('selectionToolbarEditAction')}
                    </button>
                    {deletingId === action.id ? (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => confirmDeleteAction(action.id)}
                          className="text-xs px-2 py-1 rounded-md bg-red-500 text-white hover:bg-red-600"
                        >
                          {i18nService.t('selectionToolbarDeleteAction')}
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeletingId(null)}
                          className="text-xs px-2 py-1 rounded-md border border-claude-border dark:border-claude-darkBorder dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
                        >
                          {i18nService.t('selectionToolbarCancel')}
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setDeletingId(action.id)}
                        className="text-xs px-2 py-1 rounded text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20"
                      >
                        {i18nService.t('selectionToolbarDeleteAction')}
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Add Custom Action (Template Picker) */}
        <div className="relative mt-3" ref={templatePickerRef}>
          <button
            type="button"
            onClick={() => setShowTemplatePicker(!showTemplatePicker)}
            className="text-xs px-3 py-1.5 rounded-md border border-claude-border dark:border-claude-darkBorder dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
          >
            + {i18nService.t('selectionToolbarAddCustom')}
          </button>
          {showTemplatePicker && (
            <div className="absolute left-0 top-full mt-1 z-50 bg-white dark:bg-claude-darkSurface border border-claude-border dark:border-claude-darkBorder rounded-lg shadow-lg py-1 min-w-[200px]">
              <div className="px-3 py-1.5 text-xs font-medium dark:text-claude-darkSecondaryText text-claude-secondaryText">
                {i18nService.t('selectionToolbarSelectTemplate')}
              </div>
              {CUSTOM_ACTION_TEMPLATES.map((template, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => handleAddFromTemplate(idx)}
                  className="w-full text-left px-3 py-1.5 text-sm dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
                >
                  {template.icon} {i18nService.t(template.labelKey)}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Edit Form */}
      {editingAction && (
        <div className="mb-4 p-3 rounded-lg border border-claude-border dark:border-claude-darkBorder bg-claude-surface dark:bg-claude-darkSurface">
          <h5 className="text-xs font-medium dark:text-claude-darkText text-claude-text mb-3">
            {editingAction.id === '' ? i18nService.t('selectionToolbarAddCustom') : i18nService.t('selectionToolbarEditAction')}
          </h5>

          {/* Name */}
          <div className="mb-3">
            <label className="block text-xs dark:text-claude-darkSecondaryText text-claude-secondaryText mb-1">
              {i18nService.t('selectionToolbarActionName')}
            </label>
            <input
              type="text"
              value={editingAction.label}
              onChange={(e) => {
                setEditingAction({ ...editingAction, label: e.target.value });
                setEditError('');
              }}
              className="w-full px-2 py-1.5 text-sm rounded-md border border-claude-border dark:border-claude-darkBorder bg-white dark:bg-claude-darkBg dark:text-claude-darkText text-claude-text focus:outline-none focus:ring-1 focus:ring-claude-accent"
            />
          </div>

          {/* Icon */}
          <div className="mb-3">
            <label className="block text-xs dark:text-claude-darkSecondaryText text-claude-secondaryText mb-1">
              {i18nService.t('selectionToolbarActionIcon')}
            </label>
            <div className="relative" ref={iconPickerRef}>
              <button
                type="button"
                onClick={() => setShowIconPicker(!showIconPicker)}
                className="px-3 py-1.5 text-sm rounded-md border border-claude-border dark:border-claude-darkBorder bg-white dark:bg-claude-darkBg hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
              >
                {editingAction.icon}
              </button>
              {showIconPicker && (
                <div className="absolute left-0 top-full mt-1 z-50 bg-white dark:bg-claude-darkSurface border border-claude-border dark:border-claude-darkBorder rounded-lg shadow-lg p-2 grid grid-cols-6 gap-1">
                  {ICON_PICKER_OPTIONS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => {
                        setEditingAction({ ...editingAction, icon: emoji });
                        setShowIconPicker(false);
                      }}
                      className={`w-8 h-8 flex items-center justify-center rounded hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover ${
                        editingAction.icon === emoji ? 'bg-claude-surfaceHover dark:bg-claude-darkSurfaceHover ring-1 ring-claude-accent' : ''
                      }`}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Prompt */}
          <div className="mb-3">
            <label className="block text-xs dark:text-claude-darkSecondaryText text-claude-secondaryText mb-1">
              {i18nService.t('selectionToolbarActionPrompt')}
            </label>
            <textarea
              value={editingAction.prompt}
              onChange={(e) => {
                setEditingAction({ ...editingAction, prompt: e.target.value });
                setEditError('');
              }}
              placeholder={i18nService.t('selectionToolbarPromptPlaceholder')}
              rows={4}
              className="w-full px-2 py-1.5 text-sm rounded-md border border-claude-border dark:border-claude-darkBorder bg-white dark:bg-claude-darkBg dark:text-claude-darkText text-claude-text focus:outline-none focus:ring-1 focus:ring-claude-accent resize-y"
            />
          </div>

          {editError && (
            <p className="text-xs text-red-500 mb-2">{editError}</p>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleSaveAction}
              className="text-xs px-3 py-1.5 rounded-md bg-claude-accent text-white hover:opacity-90"
            >
              {i18nService.t('selectionToolbarSave')}
            </button>
            <button
              type="button"
              onClick={() => { setEditingAction(null); setEditError(''); }}
              className="text-xs px-3 py-1.5 rounded-md border border-claude-border dark:border-claude-darkBorder dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
            >
              {i18nService.t('selectionToolbarCancel')}
            </button>
          </div>
        </div>
      )}

      {/* Reset Button */}
      <div className="pt-2 border-t border-claude-border dark:border-claude-darkBorder">
        {showResetConfirm ? (
          <div className="flex items-center gap-2">
            <span className="text-xs dark:text-claude-darkSecondaryText text-claude-secondaryText">
              {i18nService.t('selectionToolbarResetConfirm')}
            </span>
            <button
              type="button"
              onClick={handleReset}
              className="text-xs px-2 py-1 rounded-md bg-red-500 text-white hover:bg-red-600"
            >
              {i18nService.t('selectionToolbarResetDefault')}
            </button>
            <button
              type="button"
              onClick={() => setShowResetConfirm(false)}
              className="text-xs px-2 py-1 rounded-md border border-claude-border dark:border-claude-darkBorder dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
            >
              {i18nService.t('selectionToolbarCancel')}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowResetConfirm(true)}
            className="text-xs dark:text-claude-darkSecondaryText text-claude-secondaryText hover:text-claude-text dark:hover:text-claude-darkText"
          >
            {i18nService.t('selectionToolbarResetDefault')}
          </button>
        )}
      </div>
    </div>
  );
};

export default SelectionToolbarSettings;
