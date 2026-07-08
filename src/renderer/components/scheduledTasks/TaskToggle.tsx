import React from 'react';

interface TaskToggleProps {
  enabled: boolean;
  onToggle: () => void;
  title?: string;
}

/** Small enable/disable switch shared by the task list and detail views. */
const TaskToggle: React.FC<TaskToggleProps> = ({ enabled, onToggle, title }) => (
  <button
    type="button"
    role="switch"
    aria-checked={enabled}
    title={title}
    onClick={event => {
      event.stopPropagation();
      onToggle();
    }}
    className={`relative shrink-0 w-8 h-[18px] rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
      enabled ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'
    }`}
  >
    <span
      className={`absolute top-0.5 left-0.5 h-[14px] w-[14px] rounded-full bg-white shadow-sm transition-transform ${
        enabled ? 'translate-x-[14px]' : 'translate-x-0'
      }`}
    />
  </button>
);

export default TaskToggle;
