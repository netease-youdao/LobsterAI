import { XCircleIcon as XCircleIconSolid } from '@heroicons/react/20/solid';
import { ArrowLeftIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDispatch, useSelector } from 'react-redux';

import { ScheduledTaskDataStatus } from '../../../scheduledTask/constants';
import { i18nService } from '../../services/i18n';
import { scheduledTaskService } from '../../services/scheduledTask';
import { RootState } from '../../store';
import { selectTask, setViewMode } from '../../store/slices/scheduledTaskSlice';
import {
  MANAGEMENT_BODY_TEXT,
  MANAGEMENT_META_TEXT,
  MANAGEMENT_PAGE_TITLE_TEXT,
  MANAGEMENT_TITLE_TEXT,
} from '../common/managementTypography';
import ComposeIcon from '../icons/ComposeIcon';
import PlusCircleIcon from '../icons/PlusCircleIcon';
import SearchIcon from '../icons/SearchIcon';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import AllRunsHistory from './AllRunsHistory';
import { getTaskAnalyticsParams, reportScheduledTaskAction } from './analytics';
import DeleteConfirmModal from './DeleteConfirmModal';
import TaskDetail from './TaskDetail';
import TaskForm from './TaskForm';
import TaskList from './TaskList';
import type { ScheduledTaskTemplate } from './taskTemplates';

interface ScheduledTasksViewProps {
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
}

type TabType = 'tasks' | 'history';

type DeleteTaskInfo = {
  id: string;
  name: string;
  source: string;
  analyticsParams: Record<string, string | number | boolean | null | undefined>;
};

const ScheduledTasksView: React.FC<ScheduledTasksViewProps> = ({
  isSidebarCollapsed,
  onToggleSidebar,
  onNewChat,
  updateBadge,
}) => {
  const dispatch = useDispatch();
  const isMac = window.electron.platform === 'darwin';
  const isWindows = window.electron.platform === 'win32';
  const viewMode = useSelector((state: RootState) => state.scheduledTask.viewMode);
  const selectedTaskId = useSelector((state: RootState) => state.scheduledTask.selectedTaskId);
  const tasks = useSelector((state: RootState) => state.scheduledTask.tasks);
  const taskListStatus = useSelector((state: RootState) => state.scheduledTask.taskListStatus);
  const availableModels = useSelector((state: RootState) => state.model.availableModels);
  const selectedTask = selectedTaskId ? (tasks.find(t => t.id === selectedTaskId) ?? null) : null;
  const [activeTab, setActiveTab] = useState<TabType>('tasks');
  const [searchText, setSearchText] = useState('');
  const [createTemplate, setCreateTemplate] = useState<ScheduledTaskTemplate | null>(null);
  const [deleteTaskInfo, setDeleteTaskInfo] = useState<DeleteTaskInfo | null>(null);
  const isFormDirtyRef = useRef(false);
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const pendingBackActionRef = useRef<(() => void) | null>(null);

  const handleFormDirtyChange = useCallback((dirty: boolean) => {
    isFormDirtyRef.current = dirty;
  }, []);

  const handleRequestDelete = useCallback((taskId: string, taskName: string, source = 'scheduled_tasks_view') => {
    const task = tasks.find(item => item.id === taskId);
    const analyticsParams = task ? getTaskAnalyticsParams(task, availableModels) : {};
    reportScheduledTaskAction('delete_confirm_open', {
      source,
      activeTab,
      viewMode,
      ...analyticsParams,
    });
    setDeleteTaskInfo({ id: taskId, name: taskName, source, analyticsParams });
  }, [activeTab, availableModels, tasks, viewMode]);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTaskInfo) return;
    const taskId = deleteTaskInfo.id;
    const { analyticsParams, source } = deleteTaskInfo;
    setDeleteTaskInfo(null);
    try {
      await scheduledTaskService.deleteTask(taskId);
      reportScheduledTaskAction('delete_success', {
        source,
        activeTab,
        viewMode,
        result: 'success',
        ...analyticsParams,
      });
      // If we were viewing this task's detail, go back to list
      if (selectedTaskId === taskId) {
        dispatch(selectTask(null));
        dispatch(setViewMode('list'));
      }
    } catch (error) {
      reportScheduledTaskAction('delete_failed', {
        source,
        activeTab,
        viewMode,
        result: 'failed',
        errorCode: 'delete_failed',
        ...analyticsParams,
      });
      throw error;
    }
  }, [activeTab, deleteTaskInfo, selectedTaskId, dispatch, viewMode]);

  const handleCancelDelete = useCallback(() => {
    if (deleteTaskInfo) {
      reportScheduledTaskAction('delete_confirm_cancel', {
        source: deleteTaskInfo.source,
        activeTab,
        viewMode,
        ...deleteTaskInfo.analyticsParams,
      });
    }
    setDeleteTaskInfo(null);
  }, [activeTab, deleteTaskInfo, viewMode]);

  useEffect(() => {
    scheduledTaskService.loadTasks();
  }, []);

  const requestLeave = useCallback((action: () => void) => {
    if (isFormDirtyRef.current) {
      reportScheduledTaskAction('form_unsaved_confirm_open', {
        source: 'scheduled_tasks_view',
        activeTab,
        viewMode,
      });
      pendingBackActionRef.current = () => {
        isFormDirtyRef.current = false;
        action();
      };
      setShowLeaveConfirm(true);
    } else {
      action();
    }
  }, [activeTab, viewMode]);

  const handleBackToList = () => {
    const action = () => {
      setCreateTemplate(null);
      dispatch(selectTask(null));
      dispatch(setViewMode('list'));
    };
    if (viewMode === 'create' || viewMode === 'edit') {
      requestLeave(action);
    } else {
      action();
    }
  };

  const handleCreateNew = useCallback(() => {
    reportScheduledTaskAction('new_task', {
      source: 'scheduled_tasks_view',
      activeTab,
      viewMode,
    });
    setCreateTemplate(null);
    dispatch(setViewMode('create'));
  }, [activeTab, dispatch, viewMode]);

  const handleCreateFromTemplate = useCallback(
    (template: ScheduledTaskTemplate) => {
      reportScheduledTaskAction('new_task_from_template', {
        source: 'scheduled_tasks_list',
        templateId: template.id,
        activeTab,
        viewMode,
      });
      setCreateTemplate(template);
      dispatch(setViewMode('create'));
    },
    [activeTab, dispatch, viewMode],
  );

  const handleEditCancel = useCallback(() => {
    requestLeave(() => dispatch(setViewMode('detail')));
  }, [requestLeave, dispatch]);

  const handleTabChange = (tab: TabType) => {
    reportScheduledTaskAction('tab_change', {
      source: 'scheduled_tasks_view',
      activeTab,
      targetTab: tab,
      viewMode,
    });
    setActiveTab(tab);
    if (tab === 'tasks') {
      dispatch(selectTask(null));
      dispatch(setViewMode('list'));
    }
  };

  // Show tabs only in list view (not in create/edit/detail sub-views)
  const showTabs = viewMode === 'list' && !selectedTaskId;

  return (
    <div
      data-skin-management-page="true"
      className="relative z-10 flex flex-col bg-background h-full"
    >
      {/* Header */}
      <div className="draggable flex h-12 items-center justify-between px-4 border-b border-border shrink-0">
        <div className="flex items-center space-x-3 h-8">
          {isSidebarCollapsed && !isWindows && (
            <div className={`non-draggable flex items-center gap-1 ${isMac ? 'pl-[68px]' : ''}`}>
              <button
                type="button"
                onClick={onToggleSidebar}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-secondary hover:bg-surface-raised transition-colors"
              >
                <SidebarToggleIcon className="h-4 w-4" isCollapsed={true} />
              </button>
              <button
                type="button"
                onClick={onNewChat}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-secondary hover:bg-surface-raised transition-colors"
              >
                <ComposeIcon className="h-4 w-4" />
              </button>
              {updateBadge}
            </div>
          )}
          {viewMode !== 'list' && (
            <button
              onClick={handleBackToList}
              className="non-draggable p-2 rounded-lg hover:bg-surface-raised text-secondary transition-colors"
              aria-label={i18nService.t('back')}
            >
              <ArrowLeftIcon className="h-5 w-5" />
            </button>
          )}
          <h1 className={`${MANAGEMENT_PAGE_TITLE_TEXT} font-semibold text-foreground`}>
            {i18nService.t('scheduledTasksTitle')}
          </h1>
        </div>
      </div>

      {/* List mode mirrors the other management pages (Kits / Skills):
          description, then a sticky search + action + tabs toolbar. */}
      {showTabs ? (
        <div className="flex-1 min-h-0 overflow-y-auto [scrollbar-gutter:stable]">
          <div className="mx-auto w-full max-w-[1120px] px-8 py-6">
            <div className="space-y-4">
              <p className={`${MANAGEMENT_BODY_TEXT} pb-2 text-secondary`}>
                {i18nService.t('scheduledTasksPageSubtitle')}
              </p>

              {/* Sticky toolbar: Search + New Task + tabs */}
              <div
                data-skin-management-toolbar="true"
                className="sticky top-0 z-10 space-y-4 bg-background pb-2"
              >
                <div className="flex items-center gap-3">
                  <div className="relative flex-1">
                    <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-secondary" />
                    <input
                      type="text"
                      value={searchText}
                      onChange={e => setSearchText(e.target.value)}
                      placeholder={i18nService.t('scheduledTasksSearchPlaceholder')}
                      className="w-full pl-9 pr-8 py-2 text-sm rounded-xl bg-surface text-foreground placeholder-secondary border border-border focus:outline-none focus:ring-2 focus:ring-primary"
                    />
                    {searchText && (
                      <button
                        type="button"
                        onClick={() => setSearchText('')}
                        aria-label={i18nService.t('scheduledTasksClearSearch')}
                        title={i18nService.t('scheduledTasksClearSearch')}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-secondary hover:text-primary transition-colors"
                      >
                        <XCircleIconSolid className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                  {/* Unlike the skills page, creating is THE primary action here,
                      so the button keeps the loud primary fill. The transparent
                      border keeps its height in lockstep with the search input. */}
                  <button
                    type="button"
                    onClick={handleCreateNew}
                    disabled={taskListStatus !== ScheduledTaskDataStatus.Ready}
                    className="px-3 py-2 text-sm rounded-xl border border-transparent transition-colors bg-primary text-white hover:bg-primary-hover flex items-center gap-2 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-primary"
                  >
                    <PlusCircleIcon className="h-4 w-4" />
                    <span>{i18nService.t('scheduledTasksNewTask')}</span>
                  </button>
                </div>

                {/* Tasks / History tabs */}
                <div className="flex items-center border-b border-border">
                  {(['tasks', 'history'] as const).map(tab => (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => handleTabChange(tab)}
                      className={`relative px-2.5 pb-2.5 pt-0.5 ${MANAGEMENT_TITLE_TEXT} font-semibold transition-colors ${
                        activeTab === tab
                          ? 'text-foreground'
                          : 'text-secondary hover:text-foreground'
                      }`}
                    >
                      {i18nService.t(
                        tab === 'tasks' ? 'scheduledTasksTabTasks' : 'scheduledTasksTabHistory',
                      )}
                      {tab === 'tasks' && tasks.length > 0 && (
                        <span className={`ml-1.5 rounded-full bg-surface-raised px-1.5 py-0.5 ${MANAGEMENT_META_TEXT} font-medium text-secondary`}>
                          {tasks.length}
                        </span>
                      )}
                      <div
                        className={`absolute bottom-[-1px] left-0 right-0 h-0.5 rounded-full transition-colors ${
                          activeTab === tab ? 'bg-primary' : 'bg-transparent'
                        }`}
                      />
                    </button>
                  ))}
                </div>
              </div>

              {activeTab === 'history' ? (
                <AllRunsHistory searchText={searchText} />
              ) : (
                <TaskList
                  searchText={searchText}
                  onClearSearch={() => setSearchText('')}
                  onRequestDelete={handleRequestDelete}
                  onCreateNew={handleCreateNew}
                  onCreateFromTemplate={handleCreateFromTemplate}
                />
              )}
            </div>
          </div>
        </div>
      ) : (
        <div
          className={`flex-1 min-h-0 ${viewMode === 'create' || viewMode === 'edit' ? 'flex flex-col overflow-hidden' : 'overflow-y-auto'}`}
        >
          {viewMode === 'create' && (
            <TaskForm
              mode="create"
              initialTemplate={createTemplate}
              onCancel={handleBackToList}
              onSaved={newTaskId => {
                setCreateTemplate(null);
                if (newTaskId) {
                  dispatch(selectTask(newTaskId));
                  dispatch(setViewMode('detail'));
                } else {
                  handleBackToList();
                }
              }}
              onDirtyChange={handleFormDirtyChange}
            />
          )}
          {viewMode === 'edit' && selectedTask && (
            <TaskForm
              mode="edit"
              task={selectedTask}
              onCancel={handleEditCancel}
              onSaved={() => dispatch(setViewMode('detail'))}
              onDirtyChange={handleFormDirtyChange}
            />
          )}
          {viewMode === 'detail' && selectedTask && (
            <TaskDetail task={selectedTask} onRequestDelete={handleRequestDelete} />
          )}
        </div>
      )}

      {/* Delete confirmation modal */}
      {deleteTaskInfo && (
        <DeleteConfirmModal
          taskName={deleteTaskInfo.name}
          onConfirm={handleConfirmDelete}
          onCancel={handleCancelDelete}
        />
      )}

      {/* Unsaved changes confirmation overlay (back arrow) */}
      {showLeaveConfirm &&
        createPortal(
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35">
            <div
              role="dialog"
              aria-modal="true"
              onClick={e => e.stopPropagation()}
              className="w-full max-w-sm rounded-2xl bg-background border-border border shadow-modal p-5"
            >
              <h4 className="text-sm font-semibold text-foreground mb-2">
                {i18nService.t('taskFormUnsavedChanges')}
              </h4>
              <p className="text-sm text-secondary mb-4">{i18nService.t('taskFormLeaveConfirm')}</p>
              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => {
                    reportScheduledTaskAction('form_unsaved_confirm_cancel', {
                      source: 'scheduled_tasks_view',
                      activeTab,
                      viewMode,
                    });
                    setShowLeaveConfirm(false);
                  }}
                  className="px-4 py-2 text-sm rounded-lg text-secondary hover:bg-surface-raised transition-colors border border-border"
                >
                  {i18nService.t('taskFormStay')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowLeaveConfirm(false);
                    reportScheduledTaskAction('form_unsaved_confirm_submit', {
                      source: 'scheduled_tasks_view',
                      activeTab,
                      viewMode,
                    });
                    pendingBackActionRef.current?.();
                    pendingBackActionRef.current = null;
                  }}
                  className="px-4 py-2 text-sm font-medium bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors"
                >
                  {i18nService.t('taskFormLeave')}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
};

export default ScheduledTasksView;
