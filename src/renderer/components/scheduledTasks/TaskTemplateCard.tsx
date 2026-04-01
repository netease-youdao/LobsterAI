import React from 'react';
import type { TaskTemplate } from './taskTemplates';

interface TaskTemplateCardProps {
  template: TaskTemplate;
  onClick: (template: TaskTemplate) => void;
}

const TaskTemplateCard: React.FC<TaskTemplateCardProps> = ({ template, onClick }) => {
  return (
    <button
      type="button"
      onClick={() => onClick(template)}
      className="w-full flex items-center gap-4 px-4 py-3.5 text-left hover:bg-surface-raised transition-colors"
    >
      <span className="text-3xl shrink-0 w-10 text-center">{template.icon}</span>
      <div className="min-w-0">
        <p className="font-medium text-foreground text-sm">{template.name}</p>
        <p className="text-sm text-secondary mt-0.5 truncate">{template.description}</p>
      </div>
    </button>
  );
};

export default TaskTemplateCard;
