import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState, AppDispatch } from '../../store';
import { removeWorkflowRun, clearWorkflowRuns } from '../../store/slices/workflowSlice';
import { MagnifyingGlassIcon, XMarkIcon, CheckCircleIcon, XCircleIcon, ArrowPathIcon, TrashIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { CoworkSessionSummary } from '../../types/cowork';
import CoworkSessionList from './CoworkSessionList';

interface CoworkSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  sessions: CoworkSessionSummary[];
  currentSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onTogglePin: (sessionId: string, pinned: boolean) => void;
  onRenameSession: (sessionId: string, title: string) => void;
}


const CoworkSearchModal: React.FC<CoworkSearchModalProps> = ({
  isOpen,
  onClose,
  sessions,
  currentSessionId,
  onSelectSession,
  onDeleteSession,
  onTogglePin,
  onRenameSession,
}) => {
  const dispatch = useDispatch<AppDispatch>();
  const workflowRuns = useSelector((state: RootState) => state.workflow.workflowRuns);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'chat' | 'workflow'>('chat');
  const searchInputRef = useRef<HTMLInputElement>(null);

  const filteredSessions = useMemo(() => {
    const regularSessions = (sessions || []).filter(session => session && session.title && !session.title.startsWith('[Workflow]'));
    const trimmedQuery = searchQuery.trim().toLowerCase();
    if (!trimmedQuery) return regularSessions;
    return regularSessions.filter((session) => session.title.toLowerCase().includes(trimmedQuery));
  }, [sessions, searchQuery]);

  const filteredWorkflowRuns = useMemo(() => {
    const trimmedQuery = searchQuery.trim().toLowerCase();
    if (!trimmedQuery) return workflowRuns;
    return workflowRuns.filter((run) => run.title.toLowerCase().includes(trimmedQuery));
  }, [workflowRuns, searchQuery]);

  const handleDeleteAllWorkflowRuns = () => {
    if (filteredWorkflowRuns.length === 0) return;
    const confirmed = window.confirm(
      `Delete all ${filteredWorkflowRuns.length} workflow runs?`
    );
    if (confirmed) {
      dispatch(clearWorkflowRuns());
    }
  };

  // Reset state when modal closes
  const handleClose = () => {
    setActiveTab('chat');
    onClose();
  };

  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      });
      return;
    }
    setSearchQuery('');
    setActiveTab('chat');
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        handleClose();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen]);

  const handleSelectSession = async (sessionId: string) => {
    await onSelectSession(sessionId);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center modal-backdrop p-6"
      onClick={onClose}
    >
      <div
        className="modal-content w-full max-w-2xl mt-10 rounded-2xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-modal overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label={i18nService.t('search')}
        onClick={(event) => event.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-1 px-4 pt-3 pb-2 border-b-0">
          <h2 className="text-base font-semibold dark:text-claude-darkText text-claude-text pl-2">
            {i18nService.t('search')}
          </h2>
          <div className="flex-1" />
          <button
            type="button"
            onClick={handleClose}
            className="p-2 rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
            aria-label={i18nService.t('close')}
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        {/* Search Input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b dark:border-claude-darkBorder border-claude-border">
          <div className="relative flex-1">
            <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
            <input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={i18nService.t('searchConversations')}
              className="w-full pl-9 pr-3 py-2 text-sm rounded-lg dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text dark:placeholder-claude-darkTextSecondary placeholder-claude-textSecondary border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-2 focus:ring-claude-accent"
            />
          </div>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-1 px-4 py-2 border-b dark:border-claude-darkBorder border-claude-border">
          <button
            type="button"
            onClick={() => setActiveTab('chat')}
            className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${activeTab === 'chat'
              ? 'dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text'
              : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText'
              }`}
          >
            Chat History
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('workflow')}
            className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${activeTab === 'workflow'
              ? 'dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text'
              : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText'
              }`}
          >
            Workflow Runs {workflowRuns.length > 0 && `(${workflowRuns.length})`}
          </button>
        </div>

        {/* Content */}
        <div className="px-3 py-3 max-h-[60vh] overflow-y-auto">
          {activeTab === 'chat' ? (
            filteredSessions.length === 0 ? (
              <div className="py-10 text-center text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('searchNoResults')}
              </div>
            ) : (
              <CoworkSessionList
                sessions={filteredSessions}
                currentSessionId={currentSessionId}
                onSelectSession={handleSelectSession}
                onDeleteSession={onDeleteSession}
                onTogglePin={onTogglePin}
                onRenameSession={onRenameSession}
              />
            )
          ) : (
            /* Workflow Runs Tab */
            <div>
              {/* Delete All toolbar */}
              {filteredWorkflowRuns.length > 0 && (
                <div className="flex items-center justify-end pb-3 mb-3 border-b dark:border-claude-darkBorder border-claude-border">
                  <button
                    type="button"
                    onClick={handleDeleteAllWorkflowRuns}
                    className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-lg text-red-500 hover:bg-red-500/10 transition-colors"
                    title="Delete all"
                  >
                    <TrashIcon className="w-3.5 h-3.5" />
                    Delete All
                  </button>
                </div>
              )}

              {/* Workflow runs list */}
              {filteredWorkflowRuns.length === 0 ? (
                <div className="py-10 text-center text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {searchQuery ? i18nService.t('searchNoResults') : 'No workflow runs yet'}
                </div>
              ) : (
                <div className="space-y-1">
                  {filteredWorkflowRuns.map((run) => (
                    <div
                      key={run.id}
                      className="group flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition-colors hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover cursor-pointer"
                      onClick={() => {
                        handleClose();
                        window.dispatchEvent(new CustomEvent('app:showWorkflow'));
                      }}
                    >
                      {run.status === 'running' ? (
                        <ArrowPathIcon className="h-4 w-4 text-yellow-500 animate-spin shrink-0" />
                      ) : run.status === 'completed' ? (
                        <CheckCircleIcon className="h-4 w-4 text-green-500 shrink-0" />
                      ) : (
                        <XCircleIcon className="h-4 w-4 text-red-500 shrink-0" />
                      )}
                      <span className="flex-1 truncate dark:text-claude-darkTextSecondary text-claude-textSecondary">
                        {run.title}
                      </span>
                      <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0">
                        {new Date(run.startTime).toLocaleString()}
                      </span>
                      {/* Individual delete button */}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          dispatch(removeWorkflowRun(run.id));
                        }}
                        className="p-1 rounded-lg opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 hover:bg-red-500/10 transition-all shrink-0"
                        title="Delete"
                      >
                        <TrashIcon className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default CoworkSearchModal;
