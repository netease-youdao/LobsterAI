import { ArrowLeftIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import { ScheduledTaskDataStatus } from '../../../scheduledTask/constants';
import { i18nService } from '../../services/i18n';
import { scheduledTaskService } from '../../services/scheduledTask';
import { RootState } from '../../store';
import { selectTask, setViewMode } from '../../store/slices/scheduledTaskSlice';
import ComposeIcon from '../icons/ComposeIcon';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import WindowTitleBar from '../window/WindowTitleBar';
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

const pageGutterClass = 'px-6 sm:px-8 lg:px-10';
const pageContentClass = 'mx-auto w-full max-w-[880px]';

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
  const viewMode = useSelector((state: RootState) => state.scheduledTask.viewMode);
  const selectedTaskId = useSelector((state: RootState) => state.scheduledTask.selectedTaskId);
  const tasks = useSelector((state: RootState) => state.scheduledTask.tasks);
  const taskListStatus = useSelector((state: RootState) => state.scheduledTask.taskListStatus);
  const availableModels = useSelector((state: RootState) => state.model.availableModels);
  const selectedTask = selectedTaskId ? (tasks.find(t => t.id === selectedTaskId) ?? null) : null;
  const [activeTab, setActiveTab] = useState<TabType>('tasks');
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
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="draggable flex h-12 items-center justify-between px-4 border-b border-border shrink-0">
        <div className="flex items-center space-x-3 h-8">
          {isSidebarCollapsed && (
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
          <h1 className="text-lg font-semibold text-foreground">
            {i18nService.t('scheduledTasksTitle')}
          </h1>
        </div>
        <WindowTitleBar inline />
      </div>

      {/* Page header: title + subtitle + tabs + New Task button */}
      {showTabs && (
        <div className="shrink-0">
          <div className={`${pageGutterClass} pt-5 pb-1`}>
            <div className={pageContentClass}>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h2 className="text-xl font-semibold text-foreground">
                    {i18nService.t('scheduledTasksTitle')}
                  </h2>
                  <p className="mt-1 text-sm text-secondary">
                    {i18nService.t('scheduledTasksPageSubtitle')}
                  </p>
                </div>
                {activeTab === 'tasks' && (
                  <button
                    type="button"
                    onClick={handleCreateNew}
                    disabled={taskListStatus !== ScheduledTaskDataStatus.Ready}
                    className="shrink-0 rounded-lg bg-primary px-3.5 py-1.5 text-[14px] font-medium leading-5 text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-primary"
                  >
                    {i18nService.t('scheduledTasksNewTask')}
                  </button>
                )}
              </div>
              <div className="mt-4 inline-flex rounded-lg bg-surface-raised p-0.5">
                {(['tasks', 'history'] as const).map(tab => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => handleTabChange(tab)}
                    className={`rounded-md px-3.5 py-1 text-[13px] leading-5 transition-colors ${
                      activeTab === tab
                        ? 'bg-surface text-foreground shadow-subtle font-medium'
                        : 'text-secondary hover:text-foreground'
                    }`}
                  >
                    {i18nService.t(
                      tab === 'tasks' ? 'scheduledTasksTabTasks' : 'scheduledTasksTabHistory',
                    )}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Content */}
      <div
        className={`flex-1 min-h-0 ${viewMode === 'create' || viewMode === 'edit' ? 'flex flex-col overflow-hidden' : 'overflow-y-auto'}`}
      >
        {showTabs && activeTab === 'history' ? (
          <AllRunsHistory />
        ) : (
          <>
            {viewMode === 'list' && (
              <TaskList
                onRequestDelete={handleRequestDelete}
                onCreateNew={handleCreateNew}
                onCreateFromTemplate={handleCreateFromTemplate}
              />
            )}
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
          </>
        )}
      </div>

      {/* Delete confirmation modal */}
      {deleteTaskInfo && (
        <DeleteConfirmModal
          taskName={deleteTaskInfo.name}
          onConfirm={handleConfirmDelete}
          onCancel={handleCancelDelete}
        />
      )}

      {/* Unsaved changes confirmation overlay (back arrow) */}
      {showLeaveConfirm && (
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
        </div>
      )}
    </div>
  );
};

export default ScheduledTasksView;
