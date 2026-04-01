import React, { useCallback, useEffect, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '../../store';
import { setViewMode, selectTask } from '../../store/slices/scheduledTaskSlice';
import { scheduledTaskService } from '../../services/scheduledTask';
import { i18nService } from '../../services/i18n';
import TaskList from './TaskList';
import TaskForm from './TaskForm';
import TaskDetail from './TaskDetail';
import AllRunsHistory from './AllRunsHistory';
import DeleteConfirmModal from './DeleteConfirmModal';
import { ArrowLeftIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import ComposeIcon from '../icons/ComposeIcon';
import WindowTitleBar from '../window/WindowTitleBar';

interface ScheduledTasksViewProps {
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
}

type TabType = 'tasks' | 'history';

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
  const selectedTask = selectedTaskId ? tasks.find((t) => t.id === selectedTaskId) ?? null : null;
  const [activeTab, setActiveTab] = useState<TabType>('tasks');
  const [deleteTaskInfo, setDeleteTaskInfo] = useState<{ id: string; name: string } | null>(null);
  const [isFormDirty, setIsFormDirty] = useState(false);
  const [showUnsavedBackModal, setShowUnsavedBackModal] = useState(false);

  const isFormView = viewMode === 'create' || viewMode === 'edit';

  const handleRequestDelete = useCallback((taskId: string, taskName: string) => {
    setDeleteTaskInfo({ id: taskId, name: taskName });
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTaskInfo) return;
    const taskId = deleteTaskInfo.id;
    setDeleteTaskInfo(null);
    await scheduledTaskService.deleteTask(taskId);
    // If we were viewing this task's detail, go back to list
    if (selectedTaskId === taskId) {
      dispatch(selectTask(null));
      dispatch(setViewMode('list'));
    }
  }, [deleteTaskInfo, selectedTaskId, dispatch]);

  const handleCancelDelete = useCallback(() => {
    setDeleteTaskInfo(null);
  }, []);

  useEffect(() => {
    scheduledTaskService.loadTasks();
  }, []);

  const handleBackToList = () => {
    dispatch(selectTask(null));
    dispatch(setViewMode('list'));
    setIsFormDirty(false);
  };

  const handleBackRequest = () => {
    if (isFormView && isFormDirty) {
      setShowUnsavedBackModal(true);
    } else {
      handleBackToList();
    }
  };

  const handleFormDirtyChange = useCallback((dirty: boolean) => {
    setIsFormDirty(dirty);
  }, []);

  const handleTabChange = (tab: TabType) => {
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
              onClick={handleBackRequest}
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

      {/* Tabs + New Task button */}
      {showTabs && (
        <div className="flex items-center justify-between border-b border-border px-4 shrink-0">
          <div className="flex">
            <button
              type="button"
              onClick={() => handleTabChange('tasks')}
              className={`px-4 py-2.5 text-sm font-medium transition-colors relative ${
                activeTab === 'tasks'
                  ? 'text-foreground'
                  : 'text-secondary hover:hover:text-foreground'
              }`}
            >
              {i18nService.t('scheduledTasksTabTasks')}
              {activeTab === 'tasks' && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-t" />
              )}
            </button>
            <button
              type="button"
              onClick={() => handleTabChange('history')}
              className={`px-4 py-2.5 text-sm font-medium transition-colors relative ${
                activeTab === 'history'
                  ? 'text-foreground'
                  : 'text-secondary hover:hover:text-foreground'
              }`}
            >
              {i18nService.t('scheduledTasksTabHistory')}
              {activeTab === 'history' && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-t" />
              )}
            </button>
          </div>
          {activeTab === 'tasks' && (
            <button
              type="button"
              onClick={() => dispatch(setViewMode('create'))}
              className="px-3 py-1 text-sm font-medium bg-primary text-white rounded-lg hover:bg-primary-hover transition-colors"
            >
              {i18nService.t('scheduledTasksNewTask')}
            </button>
          )}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {showTabs && activeTab === 'history' ? (
          <AllRunsHistory />
        ) : (
          <>
            {viewMode === 'list' && <TaskList onRequestDelete={handleRequestDelete} />}
            {viewMode === 'create' && (
              <TaskForm
                mode="create"
                onCancel={handleBackToList}
                onSaved={handleBackToList}
                onDirtyChange={handleFormDirtyChange}
              />
            )}
            {viewMode === 'edit' && selectedTask && (
              <TaskForm
                mode="edit"
                task={selectedTask}
                onCancel={() => dispatch(setViewMode('detail'))}
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

      {showUnsavedBackModal && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center"
          onClick={() => setShowUnsavedBackModal(false)}
        >
          <div className="absolute inset-0 bg-black/40 dark:bg-black/60" />
          <div
            className="relative w-80 rounded-xl shadow-2xl bg-surface border border-border p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-col items-center text-center">
              <div className="w-10 h-10 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center mb-3">
                <ExclamationTriangleIcon className="w-5 h-5 text-amber-500" />
              </div>
              <h3 className="text-sm font-semibold text-foreground mb-2">
                {i18nService.t('scheduledTasksUnsavedTitle')}
              </h3>
              <p className="text-sm text-secondary mb-5">
                {i18nService.t('scheduledTasksUnsavedMessage')}
              </p>
              <div className="flex items-center gap-3 w-full">
                <button
                  type="button"
                  onClick={() => setShowUnsavedBackModal(false)}
                  className="flex-1 px-4 py-2 text-sm font-medium rounded-lg bg-primary text-white hover:bg-primary-hover transition-colors"
                >
                  {i18nService.t('scheduledTasksUnsavedStay')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowUnsavedBackModal(false);
                    handleBackToList();
                  }}
                  className="flex-1 px-4 py-2 text-sm rounded-lg text-foreground border border-border hover:bg-surface-raised transition-colors"
                >
                  {i18nService.t('scheduledTasksUnsavedLeave')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ScheduledTasksView;
