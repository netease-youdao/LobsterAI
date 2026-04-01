import React from 'react';
import { i18nService } from '../../services/i18n';
import { TASK_TEMPLATES } from './taskTemplates';
import type { TaskTemplate } from './taskTemplates';
import TaskTemplateCard from './TaskTemplateCard';

interface TaskTemplateGalleryProps {
  onSelectTemplate: (template: TaskTemplate) => void;
}

const TaskTemplateGallery: React.FC<TaskTemplateGalleryProps> = ({ onSelectTemplate }) => {
  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-border shrink-0">
        <p className="text-sm text-secondary">{i18nService.t('scheduledTasksTemplatesHint')}</p>
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className="divide-y divide-border">
          {TASK_TEMPLATES.map((template) => (
            <TaskTemplateCard
              key={template.id}
              template={template}
              onClick={onSelectTemplate}
            />
          ))}
        </div>
      </div>
    </div>
  );
};

export default TaskTemplateGallery;
