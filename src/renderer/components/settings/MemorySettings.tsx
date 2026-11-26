import {
  ArrowUturnLeftIcon,
  CheckIcon,
  ChevronDownIcon,
  CodeBracketIcon,
  FolderIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';

import { AgentId } from '../../../shared/agent/constants';
import { CoworkMemoryStatusFilter } from '../../../shared/cowork/constants';
import { coworkService } from '../../services/cowork';
import { i18nService } from '../../services/i18n';
import type { RootState } from '../../store';
import type { CoworkUserMemoryEntry } from '../../types/cowork';
import AgentAvatarIcon from '../agent/AgentAvatarIcon';
import Modal from '../common/Modal';
import ErrorMessage from '../ErrorMessage';
import BrainIcon from '../icons/BrainIcon';
import EditIcon from '../icons/EditIcon';
import {
  buildMemoryAgentOptions,
  filterMemoryEntries,
  formatProjectKeyLabel,
  groupMemoryEntriesBySection,
  isProjectScopedMemory,
  MemoryScopeFilter,
  resolveInitialMemoryAgentId,
} from './memorySettingsHelpers';
import {
  SETTINGS_ACTION_BUTTON_CLASS,
  SettingsCard,
  SettingsItem,
  SettingsSwitch,
} from './SettingsLayout';
import { SETTINGS_DESCRIPTION_TEXT, SETTINGS_META_TEXT } from './settingsTypography';

const UNDO_TOAST_DURATION_MS = 6_000;

interface UndoDeleteSnapshot {
  agentId: string;
  rawContent: string;
  deletedCount: number;
}

interface MemorySettingsProps {
  initialAgentId?: string;
  initialAgentRequestId?: number;
  memoryEnabled: boolean;
  onMemoryEnabledChange: (enabled: boolean) => Promise<boolean>;
  onError: (message: string | null) => void;
  onEntryChanged?: (operation: 'created' | 'updated' | 'deleted', entryCount?: number) => void;
}

const MemorySettings: React.FC<MemorySettingsProps> = ({
  initialAgentId,
  initialAgentRequestId,
  memoryEnabled,
  onMemoryEnabledChange,
  onError,
  onEntryChanged,
}) => {
  const agents = useSelector((state: RootState) => state.agent.agents);

  const agentOptions = useMemo(
    () => buildMemoryAgentOptions(agents, i18nService.t('coworkMemoryMainAgentLabel')),
    [agents],
  );

  const [selectedAgentId, setSelectedAgentId] = useState<string>(() => (
    resolveInitialMemoryAgentId(initialAgentId, agentOptions)
  ));
  const [agentDropdownOpen, setAgentDropdownOpen] = useState(false);
  const [agentCounts, setAgentCounts] = useState<Record<string, number>>({});

  const [entries, setEntries] = useState<CoworkUserMemoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [togglingEnabled, setTogglingEnabled] = useState(false);

  const [query, setQuery] = useState('');
  const [scopeFilter, setScopeFilter] = useState<MemoryScopeFilter>(MemoryScopeFilter.All);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  // Inline create state
  const [isAdding, setIsAdding] = useState(false);
  const [addDraft, setAddDraft] = useState('');
  const [addError, setAddError] = useState<string | null>(null);

  // Inline edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [editError, setEditError] = useState<string | null>(null);

  // Section cleanup confirm state
  const [confirmClearGroupKey, setConfirmClearGroupKey] = useState<string | null>(null);

  // Batch select state
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Undo toast snapshot
  const [undoSnapshot, setUndoSnapshot] = useState<UndoDeleteSnapshot | null>(null);
  const [restoringUndo, setRestoringUndo] = useState(false);
  const undoTimerRef = useRef<number | null>(null);

  // Raw MEMORY.md modal editor state
  const [rawMode, setRawMode] = useState(false);
  const [rawText, setRawText] = useState('');
  const [rawError, setRawError] = useState<string | null>(null);
  const [rawSaving, setRawSaving] = useState(false);

  const dropdownRef = useRef<HTMLDivElement>(null);
  const addTextareaRef = useRef<HTMLTextAreaElement>(null);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);
  const loadSeqRef = useRef(0);

  const activeAgent = useMemo(
    () => agentOptions.find((option) => option.id === selectedAgentId) ?? agentOptions[0],
    [agentOptions, selectedAgentId],
  );

  // Sync external deep-link / AgentSettingsPanel jump
  useEffect(() => {
    if (!initialAgentId) return;
    const resolved = resolveInitialMemoryAgentId(initialAgentId, agentOptions);
    setSelectedAgentId(resolved);
    setExpandedIds(new Set());
    setScopeFilter(MemoryScopeFilter.All);
    setQuery('');
    setIsAdding(false);
    setEditingId(null);
    setBatchMode(false);
    setSelectedIds(new Set());
    setConfirmClearGroupKey(null);
  }, [initialAgentId, initialAgentRequestId, agentOptions]);

  // Fallback to main if selected agent was deleted
  useEffect(() => {
    if (!agentOptions.some((option) => option.id === selectedAgentId)) {
      setSelectedAgentId(AgentId.Main);
    }
  }, [agentOptions, selectedAgentId]);

  // Close agent selector dropdown on outside click
  useEffect(() => {
    if (!agentDropdownOpen) return;
    const handleMouseDown = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setAgentDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [agentDropdownOpen]);

  // Cleanup undo timer on unmount
  useEffect(() => () => {
    if (undoTimerRef.current !== null) {
      window.clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
  }, []);

  const clearUndoSnapshot = useCallback(() => {
    if (undoTimerRef.current !== null) {
      window.clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    setUndoSnapshot(null);
  }, []);

  const showUndoSnapshot = useCallback((snapshot: UndoDeleteSnapshot) => {
    if (undoTimerRef.current !== null) {
      window.clearTimeout(undoTimerRef.current);
    }
    setUndoSnapshot(snapshot);
    undoTimerRef.current = window.setTimeout(() => {
      undoTimerRef.current = null;
      setUndoSnapshot(null);
    }, UNDO_TOAST_DURATION_MS);
  }, []);

  const loadEntries = useCallback(async (agentId: string) => {
    const reqSeq = ++loadSeqRef.current;
    setLoading(true);
    try {
      const activeEntries = await coworkService.listMemoryEntries({
        agentId,
        status: CoworkMemoryStatusFilter.Created,
        includeDeleted: false,
      });
      if (reqSeq !== loadSeqRef.current) return;
      setEntries(activeEntries);
      setAgentCounts((prev) => (
        prev[agentId] === activeEntries.length ? prev : { ...prev, [agentId]: activeEntries.length }
      ));
    } catch (loadError) {
      if (reqSeq !== loadSeqRef.current) return;
      console.error('[MemorySettings] failed to load memory entries:', loadError);
      setEntries([]);
      onError(
        loadError instanceof Error && loadError.message
          ? loadError.message
          : i18nService.t('coworkMemoryLoadFailed'),
      );
    } finally {
      if (reqSeq === loadSeqRef.current) {
        setLoading(false);
      }
    }
  }, [onError]);

  useEffect(() => {
    void loadEntries(selectedAgentId);
  }, [selectedAgentId, loadEntries]);

  // Preload active memory counts for other agents so the dropdown shows badges
  useEffect(() => {
    let cancelled = false;
    const otherIds = agentOptions
      .map((option) => option.id)
      .filter((id) => id !== selectedAgentId);
    if (otherIds.length === 0) return;

    void Promise.all(
      otherIds.map(async (id) => {
        try {
          const stats = await coworkService.getMemoryStats({ agentId: id });
          return [id, stats?.created ?? 0] as const;
        } catch {
          return null;
        }
      }),
    ).then((results) => {
      if (cancelled) return;
      setAgentCounts((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const item of results) {
          if (!item) continue;
          const [id, count] = item;
          if (next[id] !== count) {
            next[id] = count;
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [agentOptions, selectedAgentId]);

  const projectCount = useMemo(
    () => entries.filter((entry) => isProjectScopedMemory(entry)).length,
    [entries],
  );
  const globalCount = entries.length - projectCount;
  const hasProjectEntries = projectCount > 0;

  useEffect(() => {
    if (!hasProjectEntries && scopeFilter !== MemoryScopeFilter.All) {
      setScopeFilter(MemoryScopeFilter.All);
    }
  }, [hasProjectEntries, scopeFilter]);

  const filteredEntries = useMemo(
    () => filterMemoryEntries(entries, { query, scope: scopeFilter }),
    [entries, query, scopeFilter],
  );

  const groupedEntries = useMemo(
    () => groupMemoryEntriesBySection(filteredEntries),
    [filteredEntries],
  );

  // Drop stale selections if filtered list shrinks
  useEffect(() => {
    if (!batchMode) return;
    const validIds = new Set(entries.map((entry) => entry.id));
    setSelectedIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      prev.forEach((id) => {
        if (validIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [batchMode, entries]);

  const handleToggleMemoryEnabled = async () => {
    if (togglingEnabled) return;
    setTogglingEnabled(true);
    onError(null);
    try {
      await onMemoryEnabledChange(!memoryEnabled);
    } finally {
      setTogglingEnabled(false);
    }
  };

  const handleSelectAgent = (nextAgentId: string) => {
    setAgentDropdownOpen(false);
    if (nextAgentId === selectedAgentId) return;
    setSelectedAgentId(nextAgentId);
    setQuery('');
    setScopeFilter(MemoryScopeFilter.All);
    setExpandedIds(new Set());
    setIsAdding(false);
    setAddDraft('');
    setAddError(null);
    setEditingId(null);
    setEditDraft('');
    setEditError(null);
    setBatchMode(false);
    setSelectedIds(new Set());
    setConfirmClearGroupKey(null);
    clearUndoSnapshot();
  };

  const openInlineAdd = () => {
    setBatchMode(false);
    setSelectedIds(new Set());
    setEditingId(null);
    setEditError(null);
    setAddError(null);
    setIsAdding(true);
    requestAnimationFrame(() => {
      addTextareaRef.current?.focus();
    });
  };

  const cancelInlineAdd = () => {
    setIsAdding(false);
    setAddDraft('');
    setAddError(null);
  };

  const handleSaveNewEntry = async () => {
    const trimmed = addDraft.trim();
    if (!trimmed || mutating) return;
    setMutating(true);
    setAddError(null);
    onError(null);
    clearUndoSnapshot();
    try {
      await coworkService.createMemoryEntry({
        agentId: selectedAgentId,
        text: trimmed,
      });
      setIsAdding(false);
      setAddDraft('');
      await loadEntries(selectedAgentId);
      onEntryChanged?.('created', entries.length + 1);
    } catch (saveError) {
      const message = saveError instanceof Error && saveError.message
        ? saveError.message
        : i18nService.t('coworkMemoryCrudSaveFailed');
      setAddError(message);
    } finally {
      setMutating(false);
    }
  };

  const startInlineEdit = (entry: CoworkUserMemoryEntry) => {
    if (batchMode || mutating) return;
    setIsAdding(false);
    setAddError(null);
    setConfirmClearGroupKey(null);
    setEditingId(entry.id);
    setEditDraft(entry.text);
    setEditError(null);
    requestAnimationFrame(() => {
      const textarea = editTextareaRef.current;
      if (textarea) {
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      }
    });
  };

  const cancelInlineEdit = () => {
    setEditingId(null);
    setEditDraft('');
    setEditError(null);
  };

  const handleSaveEditEntry = async () => {
    if (!editingId || mutating) return;
    const trimmed = editDraft.trim();
    if (!trimmed) return;
    setMutating(true);
    setEditError(null);
    onError(null);
    clearUndoSnapshot();
    try {
      await coworkService.updateMemoryEntry({
        agentId: selectedAgentId,
        id: editingId,
        text: trimmed,
      });
      setEditingId(null);
      setEditDraft('');
      await loadEntries(selectedAgentId);
      onEntryChanged?.('updated', entries.length);
    } catch (saveError) {
      const message = saveError instanceof Error && saveError.message
        ? saveError.message
        : i18nService.t('coworkMemoryCrudSaveFailed');
      setEditError(message);
    } finally {
      setMutating(false);
    }
  };

  const performDeleteIds = async (ids: string[]) => {
    const uniqueIds = Array.from(new Set(ids));
    if (uniqueIds.length === 0 || mutating) return;
    setMutating(true);
    onError(null);
    const targetAgentId = selectedAgentId;
    try {
      const rawBefore = await coworkService.readMemoryFileRaw({ agentId: targetAgentId });
      let deletedCount = 0;
      if (uniqueIds.length === 1) {
        await coworkService.deleteMemoryEntry({ agentId: targetAgentId, id: uniqueIds[0] });
        deletedCount = 1;
      } else {
        deletedCount = await coworkService.deleteMemoryEntries({
          agentId: targetAgentId,
          ids: uniqueIds,
        });
      }

      if (editingId && uniqueIds.includes(editingId)) {
        cancelInlineEdit();
      }
      setConfirmClearGroupKey(null);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        uniqueIds.forEach((id) => next.delete(id));
        return next;
      });

      await loadEntries(targetAgentId);
      onEntryChanged?.('deleted', Math.max(0, entries.length - deletedCount));

      if (rawBefore !== null && deletedCount > 0) {
        showUndoSnapshot({
          agentId: targetAgentId,
          rawContent: rawBefore,
          deletedCount,
        });
      }
    } catch (deleteError) {
      onError(
        deleteError instanceof Error && deleteError.message
          ? deleteError.message
          : i18nService.t('coworkMemoryCrudDeleteFailed'),
      );
    } finally {
      setMutating(false);
    }
  };

  const handleUndoDelete = async () => {
    if (!undoSnapshot || restoringUndo) return;
    setRestoringUndo(true);
    onError(null);
    const snapshot = undoSnapshot;
    clearUndoSnapshot();
    try {
      const result = await coworkService.writeMemoryFileRaw(snapshot.rawContent, {
        agentId: snapshot.agentId,
      });
      if (!result.success) {
        onError(result.error || i18nService.t('coworkMemoryUndoFailed'));
        return;
      }
      if (snapshot.agentId === selectedAgentId) {
        await loadEntries(selectedAgentId);
      }
    } catch (undoError) {
      onError(
        undoError instanceof Error && undoError.message
          ? undoError.message
          : i18nService.t('coworkMemoryUndoFailed'),
      );
    } finally {
      setRestoringUndo(false);
    }
  };

  const handleEnterRawMode = async () => {
    onError(null);
    setRawError(null);
    const content = await coworkService.readMemoryFileRaw({ agentId: selectedAgentId });
    if (content === null) {
      onError(i18nService.t('coworkMemoryRawLoadFailed'));
      return;
    }
    setRawText(content);
    setRawMode(true);
  };

  const handleSaveRaw = async () => {
    if (rawSaving) return;
    onError(null);
    setRawError(null);
    setRawSaving(true);
    clearUndoSnapshot();
    try {
      const result = await coworkService.writeMemoryFileRaw(rawText, {
        agentId: selectedAgentId,
      });
      if (!result.success) {
        const message = result.error || i18nService.t('coworkMemoryRawSaveFailed');
        setRawError(message);
        return;
      }
      setRawMode(false);
      setIsAdding(false);
      setEditingId(null);
      setBatchMode(false);
      setSelectedIds(new Set());
      await loadEntries(selectedAgentId);
    } finally {
      setRawSaving(false);
    }
  };

  const toggleExpandedId = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleBatchSelectId = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allFilteredSelected =
    filteredEntries.length > 0
    && filteredEntries.every((entry) => selectedIds.has(entry.id));

  const toggleSelectAllFiltered = () => {
    if (allFilteredSelected) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        filteredEntries.forEach((entry) => next.delete(entry.id));
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        filteredEntries.forEach((entry) => next.add(entry.id));
        return next;
      });
    }
  };

  const exitBatchMode = () => {
    setBatchMode(false);
    setSelectedIds(new Set());
  };

  const isMainAgent = selectedAgentId === AgentId.Main;
  const scopeHintText = isMainAgent
    ? i18nService.t('coworkMemoryScopeHintMain')
    : i18nService.t('coworkMemoryScopeHintExpert').replace('{name}', activeAgent?.name ?? selectedAgentId);

  const hasActiveFilter = query.trim().length > 0 || scopeFilter !== MemoryScopeFilter.All;

  return (
    <div className="relative flex h-full min-h-0 flex-col gap-3.5">
      {/* 1. Global Memory Enable Toggle */}
      <div className="shrink-0">
        <SettingsCard>
          <SettingsItem
            title={i18nService.t('coworkMemoryEnabled')}
            description={i18nService.t('coworkMemoryEnabledHintDsh')}
            control={(
              <SettingsSwitch
                checked={memoryEnabled}
                label={i18nService.t('coworkMemoryEnabled')}
                disabled={togglingEnabled}
                onClick={handleToggleMemoryEnabled}
              />
            )}
          />
        </SettingsCard>
      </div>

      {/* 2. Agent Scope Header & Primary Actions */}
      <div className="shrink-0 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          {/* Agent Switcher */}
          <div className="relative min-w-0" ref={dropdownRef}>
            {agentOptions.length > 1 ? (
              <>
                <button
                  type="button"
                  onClick={() => setAgentDropdownOpen((prev) => !prev)}
                  aria-haspopup="listbox"
                  aria-expanded={agentDropdownOpen}
                  className="inline-flex h-8 max-w-[300px] items-center gap-2 rounded-lg border border-border bg-surface px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
                >
                  <AgentAvatarIcon
                    value={activeAgent?.icon}
                    expertFallback={activeAgent?.expertFallback}
                    className="h-4 w-4"
                    iconClassName="h-3.5 w-3.5"
                  />
                  <span className="truncate">{activeAgent?.name}</span>
                  {activeAgent?.isMain && (
                    <span className="shrink-0 rounded bg-surface-raised px-1.5 py-0.5 text-[10px] font-medium text-secondary">
                      {i18nService.t('coworkMemoryGlobalSharedBadge')}
                    </span>
                  )}
                  <span className="shrink-0 text-[11px] font-normal text-secondary">
                    {entries.length}
                  </span>
                  <ChevronDownIcon
                    className={`h-3.5 w-3.5 shrink-0 text-secondary transition-transform ${
                      agentDropdownOpen ? 'rotate-180' : ''
                    }`}
                  />
                </button>

                {agentDropdownOpen && (
                  <div
                    role="listbox"
                    className="popover-enter absolute left-0 z-30 mt-1.5 max-h-64 w-72 overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-popover"
                  >
                    {agentOptions.map((option) => {
                      const isSelected = option.id === selectedAgentId;
                      const count = agentCounts[option.id];
                      return (
                        <button
                          key={option.id}
                          type="button"
                          role="option"
                          aria-selected={isSelected}
                          onClick={() => handleSelectAgent(option.id)}
                          className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${
                            isSelected
                              ? 'bg-surface-raised text-foreground'
                              : 'text-foreground hover:bg-surface-raised'
                          }`}
                        >
                          <AgentAvatarIcon
                            value={option.icon}
                            expertFallback={option.expertFallback}
                            className="h-5 w-5"
                            iconClassName="h-3.5 w-3.5"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className={`truncate ${isSelected ? 'font-medium' : ''}`}>
                                {option.name}
                              </span>
                              {option.isMain && (
                                <span className="shrink-0 rounded bg-surface-raised px-1.5 py-0.5 text-[10px] font-medium text-secondary">
                                  {i18nService.t('coworkMemoryGlobalSharedBadge')}
                                </span>
                              )}
                            </div>
                          </div>
                          {typeof count === 'number' && (
                            <span className="shrink-0 text-[11px] tabular-nums text-secondary">
                              {count}
                            </span>
                          )}
                          <CheckIcon
                            className={`h-3.5 w-3.5 shrink-0 text-foreground ${
                              isSelected ? 'opacity-100' : 'opacity-0'
                            }`}
                          />
                        </button>
                      );
                    })}
                  </div>
                )}
              </>
            ) : (
              <div className="inline-flex h-8 items-center gap-2 rounded-lg border border-border bg-surface px-2.5 text-xs font-medium text-foreground">
                <AgentAvatarIcon
                  value={activeAgent?.icon}
                  className="h-4 w-4"
                  iconClassName="h-3.5 w-3.5"
                />
                <span>{activeAgent?.name}</span>
                <span className="rounded bg-surface-raised px-1.5 py-0.5 text-[10px] font-medium text-secondary">
                  {i18nService.t('coworkMemoryGlobalSharedBadge')}
                </span>
                <span className="text-[11px] font-normal text-secondary">
                  {entries.length}
                </span>
              </div>
            )}
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-2">
            {entries.length > 0 && !batchMode && (
              <button
                type="button"
                onClick={() => {
                  setIsAdding(false);
                  setEditingId(null);
                  setConfirmClearGroupKey(null);
                  setBatchMode(true);
                }}
                disabled={loading || mutating}
                className={SETTINGS_ACTION_BUTTON_CLASS}
              >
                {i18nService.t('coworkMemoryBatchManage')}
              </button>
            )}
            <button
              type="button"
              onClick={() => { void handleEnterRawMode(); }}
              disabled={loading || mutating}
              className={SETTINGS_ACTION_BUTTON_CLASS}
              title={i18nService.t('coworkMemoryRawHint')}
            >
              <CodeBracketIcon className="h-3.5 w-3.5" />
              {i18nService.t('coworkMemoryRawButton')}
            </button>
            <button
              type="button"
              onClick={openInlineAdd}
              disabled={mutating}
              className="inline-flex h-8 shrink-0 items-center justify-center gap-1 rounded-lg bg-action px-3 text-xs font-medium text-action-foreground transition-colors hover:bg-action-hover active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <PlusIcon className="h-3.5 w-3.5" />
              {i18nService.t('coworkMemoryCrudCreate')}
            </button>
          </div>
        </div>

        {/* Scope explanation */}
        <p className={`px-0.5 ${SETTINGS_DESCRIPTION_TEXT} text-secondary`}>
          {scopeHintText}
        </p>

        {!memoryEnabled && (
          <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            {i18nService.t('coworkMemoryPausedNotice')}
          </div>
        )}
      </div>

      {/* 3. Search & Scope Filter Bar (or Batch Selection Bar) */}
      <div className="shrink-0">
        {batchMode ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface-raised/60 px-3.5 py-2">
            <div className="flex items-center gap-3">
              <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-foreground select-none">
                <input
                  type="checkbox"
                  checked={allFilteredSelected}
                  onChange={toggleSelectAllFiltered}
                  className="h-3.5 w-3.5 rounded border-border accent-primary"
                />
                <span>{i18nService.t('coworkMemorySelectAll')}</span>
              </label>
              <span className="text-xs text-secondary">
                {i18nService
                  .t('coworkMemorySelectedCount')
                  .replace('{count}', String(selectedIds.size))}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={selectedIds.size === 0 || mutating}
                onClick={() => { void performDeleteIds(Array.from(selectedIds)); }}
                className="inline-flex h-7 items-center gap-1 rounded-lg bg-red-500 px-2.5 text-xs font-medium text-white transition-colors hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <TrashIcon className="h-3.5 w-3.5" />
                {i18nService
                  .t('coworkMemoryBatchDeleteButton')
                  .replace('{count}', String(selectedIds.size))}
              </button>
              <button
                type="button"
                onClick={exitBatchMode}
                className="inline-flex h-7 items-center rounded-lg border border-border bg-surface px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised"
              >
                {i18nService.t('coworkMemoryBatchDone')}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[180px] flex-1">
              <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-secondary" />
              <input
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={i18nService.t('coworkMemorySearchPlaceholder')}
                className="h-9 w-full rounded-lg border border-border bg-surface pl-9 pr-8 text-xs text-foreground placeholder:text-secondary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label={i18nService.t('clear')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
                >
                  <XMarkIcon className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {hasProjectEntries && (
              <div className="inline-flex shrink-0 items-center rounded-lg border border-border bg-surface p-0.5 text-xs">
                {(
                  [
                    {
                      key: MemoryScopeFilter.All,
                      label: i18nService.t('coworkMemoryStatusAll'),
                      count: entries.length,
                    },
                    {
                      key: MemoryScopeFilter.Global,
                      label: i18nService.t('coworkMemoryScopeGlobal'),
                      count: globalCount,
                    },
                    {
                      key: MemoryScopeFilter.Project,
                      label: i18nService.t('coworkMemoryScopeProject'),
                      count: projectCount,
                    },
                  ] as const
                ).map((chip) => {
                  const active = scopeFilter === chip.key;
                  return (
                    <button
                      key={chip.key}
                      type="button"
                      onClick={() => setScopeFilter(chip.key)}
                      className={`rounded-md px-2.5 py-1 transition-colors ${
                        active
                          ? 'bg-action text-action-foreground font-medium'
                          : 'text-secondary hover:bg-surface-raised hover:text-foreground'
                      }`}
                    >
                      {chip.label}
                      {chip.count > 0 ? ` (${chip.count})` : ''}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 4. Memory Entries List */}
      <div
        className={`min-h-0 flex-1 overflow-y-auto rounded-xl border border-border bg-surface transition-opacity ${
          !memoryEnabled ? 'opacity-75' : ''
        }`}
      >
        {/* Inline Quick-Add Composer */}
        {isAdding && (
          <div className="border-b border-border bg-surface-raised/40 px-4 py-3">
            <textarea
              ref={addTextareaRef}
              rows={3}
              value={addDraft}
              onChange={(event) => setAddDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  cancelInlineAdd();
                } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  event.stopPropagation();
                  void handleSaveNewEntry();
                }
              }}
              placeholder={i18nService.t('coworkMemoryCrudTextPlaceholder')}
              className="w-full resize-y rounded-lg border border-border bg-surface px-3 py-2 text-[13px] leading-relaxed text-foreground placeholder:text-secondary/70 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
            />
            {addError && (
              <div className="mt-2">
                <ErrorMessage message={addError} onClose={() => setAddError(null)} />
              </div>
            )}
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <span className={`${SETTINGS_META_TEXT} text-secondary`}>
                {i18nService.t('coworkMemoryInlineShortcutHint')}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={cancelInlineAdd}
                  disabled={mutating}
                  className="rounded-lg border border-border bg-surface px-3 py-1 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised disabled:opacity-50"
                >
                  {i18nService.t('cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => { void handleSaveNewEntry(); }}
                  disabled={!addDraft.trim() || mutating}
                  className="rounded-lg bg-action px-3 py-1 text-xs font-medium text-action-foreground transition-colors hover:bg-action-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {i18nService.t('save')}
                </button>
              </div>
            </div>
          </div>
        )}

        {loading && entries.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-secondary">
            {i18nService.t('loading')}
          </div>
        ) : filteredEntries.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-raised text-secondary">
              <BrainIcon className="h-5 w-5" />
            </span>
            <p className="mt-3 text-sm font-medium text-foreground">
              {hasActiveFilter
                ? i18nService.t('coworkMemorySearchNoMatches')
                : i18nService.t('coworkMemoryEmpty')}
            </p>
            <p className="mt-1 max-w-sm text-xs leading-5 text-secondary">
              {hasActiveFilter
                ? i18nService.t('coworkMemorySearchNoMatchesHint')
                : i18nService.t('coworkMemoryEmptyHint')}
            </p>
            {hasActiveFilter ? (
              <button
                type="button"
                onClick={() => {
                  setQuery('');
                  setScopeFilter(MemoryScopeFilter.All);
                }}
                className="mt-4 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised"
              >
                {i18nService.t('coworkMemoryClearFilter')}
              </button>
            ) : !isAdding && (
              <button
                type="button"
                onClick={openInlineAdd}
                className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-action px-3.5 py-1.5 text-xs font-medium text-action-foreground transition-colors hover:bg-action-hover"
              >
                <PlusIcon className="h-3.5 w-3.5" />
                {i18nService.t('coworkMemoryAddFirst')}
              </button>
            )}
          </div>
        ) : (
          <div className="divide-y divide-border">
            {groupedEntries.map((group) => (
              <React.Fragment key={group.key}>
                {group.section && (
                  <div className="flex items-center justify-between gap-2 bg-surface-raised/50 px-3.5 py-2">
                    <div className={`flex min-w-0 items-baseline gap-1.5 ${SETTINGS_META_TEXT} font-medium text-secondary`}>
                      <span className="truncate">{group.section}</span>
                      <span className="shrink-0 font-normal opacity-70">{group.entries.length}</span>
                    </div>
                    {!batchMode && (
                      confirmClearGroupKey === group.key ? (
                        <div className="flex shrink-0 items-center gap-1.5 text-[11px]">
                          <span className="text-secondary">
                            {i18nService
                              .t('coworkMemoryClearSectionConfirm')
                              .replace('{count}', String(group.entries.length))}
                          </span>
                          <button
                            type="button"
                            disabled={mutating}
                            onClick={() => {
                              void performDeleteIds(group.entries.map((item) => item.id));
                            }}
                            className="rounded-md bg-red-500 px-2 py-0.5 font-medium text-white transition-colors hover:bg-red-600 disabled:opacity-50"
                          >
                            {i18nService.t('confirm')}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmClearGroupKey(null)}
                            className="rounded-md border border-border bg-surface px-2 py-0.5 text-foreground transition-colors hover:bg-surface-raised"
                          >
                            {i18nService.t('cancel')}
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmClearGroupKey(group.key)}
                          className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-secondary transition-colors hover:bg-red-500/10 hover:text-red-500"
                        >
                          {i18nService.t('coworkMemoryClearSection')}
                        </button>
                      )
                    )}
                  </div>
                )}

                {group.entries.map((entry) => {
                  const isEditingThis = editingId === entry.id;
                  const isSelected = selectedIds.has(entry.id);
                  const isLongText = entry.text.split('\n').length > 4 || entry.text.length > 260;
                  const isExpanded = expandedIds.has(entry.id);
                  const projectKeys = entry.projectKeys ?? [];
                  const hasMetaRow = projectKeys.length > 0 || Boolean(entry.sourceLabel);

                  if (isEditingThis) {
                    return (
                      <div key={entry.id} className="bg-surface-raised/40 px-4 py-3">
                        <textarea
                          ref={editTextareaRef}
                          rows={Math.min(8, Math.max(3, editDraft.split('\n').length + 1))}
                          value={editDraft}
                          onChange={(event) => setEditDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                              event.preventDefault();
                              event.stopPropagation();
                              cancelInlineEdit();
                            } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                              event.preventDefault();
                              event.stopPropagation();
                              void handleSaveEditEntry();
                            }
                          }}
                          className="w-full resize-y rounded-lg border border-border-input bg-surface px-3 py-2 text-[13px] leading-relaxed text-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/30"
                        />
                        {editError && (
                          <div className="mt-2">
                            <ErrorMessage message={editError} onClose={() => setEditError(null)} />
                          </div>
                        )}
                        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                          <span className={`${SETTINGS_META_TEXT} text-secondary`}>
                            {i18nService.t('coworkMemoryInlineShortcutHint')}
                          </span>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={cancelInlineEdit}
                              disabled={mutating}
                              className="rounded-lg border border-border bg-surface px-3 py-1 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised disabled:opacity-50"
                            >
                              {i18nService.t('cancel')}
                            </button>
                            <button
                              type="button"
                              onClick={() => { void handleSaveEditEntry(); }}
                              disabled={!editDraft.trim() || mutating}
                              className="rounded-lg bg-action px-3 py-1 text-xs font-medium text-action-foreground transition-colors hover:bg-action-hover disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {i18nService.t('save')}
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div
                      key={entry.id}
                      onClick={batchMode ? () => toggleBatchSelectId(entry.id) : undefined}
                      className={`group px-3.5 py-3 transition-colors ${
                        batchMode
                          ? isSelected
                            ? 'cursor-pointer bg-surface-raised/80'
                            : 'cursor-pointer hover:bg-surface-raised/60'
                          : 'hover:bg-surface-raised/50'
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        {batchMode && (
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleBatchSelectId(entry.id)}
                            onClick={(event) => event.stopPropagation()}
                            className="mt-1 h-3.5 w-3.5 shrink-0 rounded border-border accent-primary"
                          />
                        )}

                        <div className="min-w-0 flex-1">
                          <div
                            onDoubleClick={!batchMode ? () => startInlineEdit(entry) : undefined}
                            className={`whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground ${
                              isLongText && !isExpanded ? 'line-clamp-4' : ''
                            }`}
                          >
                            {entry.text}
                          </div>

                          {hasMetaRow && (
                            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                              {projectKeys.map((key) => (
                                <span
                                  key={key}
                                  title={key}
                                  className="inline-flex max-w-[240px] items-center gap-1 rounded-md bg-surface-raised px-1.5 py-0.5 text-[10px] font-medium text-secondary"
                                >
                                  <FolderIcon className="h-3 w-3 shrink-0" />
                                  <span className="truncate">{formatProjectKeyLabel(key)}</span>
                                </span>
                              ))}
                              {entry.sourceLabel && (
                                <span className="inline-flex max-w-[240px] items-center truncate rounded-md bg-surface-raised px-1.5 py-0.5 text-[10px] text-secondary">
                                  {`${i18nService.t('coworkMemorySourcePrefix')}: ${entry.sourceLabel}`}
                                </span>
                              )}
                            </div>
                          )}

                          {isLongText && (
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                toggleExpandedId(entry.id);
                              }}
                              className={`mt-1.5 ${SETTINGS_META_TEXT} text-secondary underline underline-offset-2 transition-colors hover:text-foreground`}
                            >
                              {i18nService.t(isExpanded ? 'coworkMemoryCollapse' : 'coworkMemoryExpand')}
                            </button>
                          )}
                        </div>

                        {!batchMode && (
                          <div className="flex shrink-0 items-center gap-0.5 opacity-45 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                            <button
                              type="button"
                              onClick={() => startInlineEdit(entry)}
                              disabled={mutating}
                              title={i18nService.t('edit')}
                              aria-label={i18nService.t('edit')}
                              className="rounded-md p-1.5 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:opacity-50"
                            >
                              <EditIcon className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => { void performDeleteIds([entry.id]); }}
                              disabled={mutating}
                              title={i18nService.t('delete')}
                              aria-label={i18nService.t('delete')}
                              className="rounded-md p-1.5 text-secondary transition-colors hover:bg-red-500/10 hover:text-red-500 disabled:opacity-50"
                            >
                              <TrashIcon className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </React.Fragment>
            ))}
          </div>
        )}
      </div>

      {/* Undo Delete Bar */}
      {undoSnapshot && (
        <div
          role="status"
          className="flex shrink-0 items-center justify-between gap-3 rounded-xl border border-border bg-surface-raised px-3.5 py-2 text-xs text-foreground shadow-sm"
        >
          <span>
            {i18nService
              .t('coworkMemoryDeletedToast')
              .replace('{count}', String(undoSnapshot.deletedCount))}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => { void handleUndoDelete(); }}
              disabled={restoringUndo}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium text-foreground transition-colors hover:bg-surface-raised disabled:opacity-50"
            >
              <ArrowUturnLeftIcon className="h-3.5 w-3.5" />
              {i18nService.t('coworkMemoryUndo')}
            </button>
            <button
              type="button"
              onClick={clearUndoSnapshot}
              aria-label={i18nService.t('close')}
              className="rounded-md p-1 text-secondary transition-colors hover:bg-surface hover:text-foreground"
            >
              <XMarkIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Raw MEMORY.md Editor Modal */}
      {rawMode && (
        <Modal
          isOpen
          onClose={() => setRawMode(false)}
          onEscape={() => setRawMode(false)}
          overlayClassName="fixed inset-0 z-[60] flex items-center justify-center bg-black/15 p-6 dark:bg-black/50"
          className="flex h-[min(720px,calc(100vh-48px))] w-[min(920px,calc(100vw-48px))] flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-[0_12px_40px_rgba(0,0,0,0.16)]"
        >
          <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border/60 px-5 py-4">
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-foreground">
                {`${i18nService.t('coworkMemoryRawButton')} · ${activeAgent?.name ?? selectedAgentId}`}
              </h2>
              <p className="mt-0.5 text-xs text-secondary">
                {i18nService.t('coworkMemoryRawHint')}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setRawMode(false)}
              title={i18nService.t('close')}
              aria-label={i18nService.t('close')}
              className="rounded-lg p-1.5 text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
            >
              <XMarkIcon className="h-5 w-5" />
            </button>
          </div>
          <textarea
            value={rawText}
            onChange={(event) => setRawText(event.target.value)}
            onKeyDown={(event) => {
              if ((event.key === 's' || event.key === 'S' || event.key === 'Enter') && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void handleSaveRaw();
              }
            }}
            spellCheck={false}
            autoFocus
            className="min-h-0 w-full flex-1 resize-none bg-transparent px-5 py-4 font-mono text-xs leading-relaxed text-foreground focus:outline-none"
          />
          {rawError && (
            <div className="px-5 pb-2">
              <ErrorMessage message={rawError} onClose={() => setRawError(null)} />
            </div>
          )}
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border/60 px-5 py-3">
            <button
              type="button"
              onClick={() => setRawMode(false)}
              className="rounded-lg border border-border px-3.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-raised"
            >
              {i18nService.t('cancel')}
            </button>
            <button
              type="button"
              onClick={() => { void handleSaveRaw(); }}
              disabled={rawSaving}
              className="rounded-lg bg-action px-3.5 py-1.5 text-xs font-medium text-action-foreground transition-colors hover:bg-action-hover active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {rawSaving ? i18nService.t('saving') : i18nService.t('save')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
};

export default MemorySettings;
