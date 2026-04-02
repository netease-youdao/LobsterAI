import React, { useState } from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { formatScheduleLabel } from './utils';
import type { ExportedTask } from '../../../scheduledTask/types';

interface ImportPreviewModalProps {
  tasks: ExportedTask[];
  filename: string;
  onConfirm: (selectedTasks: ExportedTask[]) => void;
  onCancel: () => void;
  importing?: boolean;
}

const ImportPreviewModal: React.FC<ImportPreviewModalProps> = ({
  tasks,
  filename,
  onConfirm,
  onCancel,
  importing = false,
}) => {
  const [selected, setSelected] = useState<Set<number>>(() =>
    new Set(tasks.map((_, i) => i))
  );

  const allSelected = selected.size === tasks.length;

  const toggleAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(tasks.map((_, i) => i)));
    }
  };

  const toggleOne = (idx: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) {
        next.delete(idx);
      } else {
        next.add(idx);
      }
      return next;
    });
  };

  const handleConfirm = () => {
    const selectedTasks = tasks.filter((_, i) => selected.has(i));
    onConfirm(selectedTasks);
  };

  const t = (key: string) => i18nService.t(key as any);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-surface rounded-xl shadow-xl w-full max-w-lg mx-4 flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div>
            <h2 className="text-base font-semibold text-foreground">
              {t('scheduledTasksImportPreviewTitle')}
            </h2>
            <p className="text-xs text-secondary mt-0.5 truncate max-w-xs" title={filename}>
              {filename}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="p-1.5 rounded-md text-secondary hover:bg-surface-raised transition-colors"
          >
            <XMarkIcon className="w-4 h-4" />
          </button>
        </div>

        {/* Select all row */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-border-subtle shrink-0">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={toggleAll}
            className="w-4 h-4 rounded accent-primary cursor-pointer"
          />
          <span className="text-sm text-secondary">
            {t('scheduledTasksSelectAll')} ({tasks.length})
          </span>
        </div>

        {/* Task list */}
        <div className="overflow-y-auto flex-1">
          {tasks.map((task, idx) => (
            <div
              key={idx}
              className="flex items-center gap-3 px-5 py-3 border-b border-border-subtle hover:bg-surface-raised/40 cursor-pointer"
              onClick={() => toggleOne(idx)}
            >
              <input
                type="checkbox"
                checked={selected.has(idx)}
                onChange={() => toggleOne(idx)}
                onClick={(e) => e.stopPropagation()}
                className="w-4 h-4 rounded accent-primary cursor-pointer shrink-0"
              />
              <div className="flex-1 min-w-0">
                <div className="text-sm text-foreground truncate">{task.name}</div>
                <div className="text-xs text-secondary truncate">
                  {formatScheduleLabel(task.schedule)}
                </div>
              </div>
              <span
                className={`text-xs font-medium px-1.5 py-0.5 rounded shrink-0 ${
                  task.enabled
                    ? 'bg-green-500/10 text-green-600 dark:text-green-400'
                    : 'bg-border text-secondary'
                }`}
              >
                {task.enabled ? t('scheduledTasksEnabled') : t('scheduledTasksDisabled')}
              </span>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-border shrink-0">
          <button
            type="button"
            onClick={onCancel}
            disabled={importing}
            className="px-3 py-1.5 text-sm text-secondary hover:text-foreground transition-colors disabled:opacity-50"
          >
            {t('scheduledTasksCancel')}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={selected.size === 0 || importing}
            className="px-3 py-1.5 text-sm font-medium bg-primary text-white rounded-lg hover:bg-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {importing
              ? '...'
              : `${t('scheduledTasksImport')} ${selected.size} ${selected.size === 1 ? '' : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ImportPreviewModal;
