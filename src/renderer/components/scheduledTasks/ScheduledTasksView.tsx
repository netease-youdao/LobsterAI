import React, { useCallback, useEffect, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '../../store';
import {
  setViewMode,
  selectTask,
  enterSelectionMode,
  exitSelectionMode,
  selectAllTasks,
  deselectAllTasks,
} from '../../store/slices/scheduledTaskSlice';
import { scheduledTaskService } from '../../services/scheduledTask';
import { i18nService } from '../../services/i18n';
import TaskList from './TaskList';
import TaskForm from './TaskForm';
import TaskDetail from './TaskDetail';
import AllRunsHistory from './AllRunsHistory';
import DeleteConfirmModal from './DeleteConfirmModal';
import SplitButton, { ArrowUpTrayIcon, ArrowDownTrayIcon } from './SplitButton';
import ImportPreviewModal from './ImportPreviewModal';
import { ArrowLeftIcon } from '@heroicons/react/24/outline';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import ComposeIcon from '../icons/ComposeIcon';
import WindowTitleBar from '../window/WindowTitleBar';
import type { ExportedTask } from '../../../scheduledTask/types';

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
  const selectionMode = useSelector((state: RootState) => state.scheduledTask.selectionMode);
  const selectedTaskIds = useSelector((state: RootState) => state.scheduledTask.selectedTaskIds);
  const allTaskIds = tasks.map((t) => t.id);
  const allSelected = allTaskIds.length > 0 && selectedTaskIds.length === allTaskIds.length;

  const [activeTab, setActiveTab] = useState<TabType>('tasks');
  const [deleteTaskInfo, setDeleteTaskInfo] = useState<{ id: string; name: string } | null>(null);
  const [importPreview, setImportPreview] = useState<{ tasks: ExportedTask[]; filename: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const handleExport = async () => {
    if (selectedTaskIds.length === 0) return;
    try {
      const result = await scheduledTaskService.exportTasks(selectedTaskIds);
      if (result === 'success') {
        dispatch(exitSelectionMode());
        showToast(
          i18nService.t('scheduledTasksExportSuccess').replace('{n}', String(selectedTaskIds.length))
        );
      }
    } catch (err) {
      showToast(i18nService.t('scheduledTasksImportError'));
    }
  };

  const handleImportOpen = async () => {
    try {
      const parsed = await scheduledTaskService.importParse();
      if (parsed) {
        setImportPreview(parsed);
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : i18nService.t('scheduledTasksImportError'));
    }
  };

  const handleImportConfirm = async (selectedTasks: ExportedTask[]) => {
    setImporting(true);
    try {
      const result = await scheduledTaskService.importExecute(selectedTasks);
      setImportPreview(null);
      await scheduledTaskService.loadTasks();
      if (result.failCount === 0) {
        showToast(
          i18nService.t('scheduledTasksImportSuccess').replace('{n}', String(result.successCount))
        );
      } else {
        showToast(
          i18nService.t('scheduledTasksImportPartial')
            .replace('{success}', String(result.successCount))
            .replace('{fail}', String(result.failCount))
        );
      }
    } catch (err) {
      showToast(i18nService.t('scheduledTasksImportError'));
    } finally {
      setImporting(false);
    }
  };

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
  };

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

      {/* Tabs + toolbar (normal mode) */}
      {showTabs && !selectionMode && (
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
            <div className="flex items-center gap-2">
              <SplitButton
                label={i18nService.t('scheduledTasksImportExport')}
                items={[
                  {
                    label: i18nService.t('scheduledTasksExport'),
                    icon: <ArrowUpTrayIcon />,
                    onClick: () => dispatch(enterSelectionMode()),
                  },
                  {
                    label: i18nService.t('scheduledTasksImportTasks'),
                    icon: <ArrowDownTrayIcon />,
                    onClick: handleImportOpen,
                  },
                ]}
              />
              <button
                type="button"
                onClick={() => dispatch(setViewMode('create'))}
                className="px-3 py-1 text-sm font-medium bg-primary text-white rounded-lg hover:bg-primary-hover transition-colors"
              >
                {i18nService.t('scheduledTasksNewTask')}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Selection action bar */}
      {showTabs && selectionMode && (
        <div className="flex items-center justify-between border-b border-border px-4 py-2 shrink-0 bg-surface-raised/30">
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={() => allSelected ? dispatch(deselectAllTasks()) : dispatch(selectAllTasks())}
              className="w-4 h-4 rounded accent-primary cursor-pointer"
            />
            <span className="text-sm text-secondary">
              {i18nService.t('scheduledTasksNSelected').replace('{n}', String(selectedTaskIds.length))}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleExport()}
              disabled={selectedTaskIds.length === 0}
              className="px-3 py-1 text-sm font-medium bg-primary text-white rounded-lg hover:bg-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {i18nService.t('scheduledTasksExport')}
            </button>
            <button
              type="button"
              onClick={() => dispatch(exitSelectionMode())}
              className="px-3 py-1 text-sm text-secondary hover:text-foreground transition-colors"
            >
              {i18nService.t('scheduledTasksCancel')}
            </button>
          </div>
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
              />
            )}
            {viewMode === 'edit' && selectedTask && (
              <TaskForm
                mode="edit"
                task={selectedTask}
                onCancel={() => dispatch(setViewMode('detail'))}
                onSaved={() => dispatch(setViewMode('detail'))}
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

      {/* Import preview modal */}
      {importPreview && (
        <ImportPreviewModal
          tasks={importPreview.tasks}
          filename={importPreview.filename}
          onConfirm={(selected) => void handleImportConfirm(selected)}
          onCancel={() => setImportPreview(null)}
          importing={importing}
        />
      )}

      {/* Toast notification */}
      {toast && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg bg-foreground text-background text-sm shadow-lg pointer-events-none z-50 max-w-xs text-center">
          {toast}
        </div>
      )}
    </div>
  );
};

export default ScheduledTasksView;
