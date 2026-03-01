import React, { memo } from 'react';
import { Handle, Position, NodeResizer, type NodeProps } from '@xyflow/react';
import { useDrop } from 'react-dnd';
import {
  CodeBracketIcon,
  EyeIcon,
  ShieldCheckIcon,
  BeakerIcon,
  DocumentTextIcon,
  RocketLaunchIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import type { WorkflowAgent, Skill } from './workflowTypes';
import { i18nService } from '../../services/i18n';

interface AgentNodeData {
  agent: WorkflowAgent;
  onRemove: (id: string) => void;
  onRemoveSkill: (agentId: string, skillId: string) => void;
  onAddSkill: (agentId: string, skill: Skill) => void;
  onUpdateName: (id: string, name: string) => void;
  onUpdateSize?: (id: string, width: number, height: number) => void;
}

// Agent colors for avatar
const AGENT_COLORS = [
  '#10B981', '#8B5CF6', '#F59E0B', '#EF4444', '#3B82F6',
  '#EC4899', '#06B6D4', '#84CC16', '#F97316', '#6366F1',
];

const AgentNode: React.FC<NodeProps & { data: AgentNodeData }> = memo(({ data, selected }) => {
  const { agent, onRemove, onRemoveSkill, onAddSkill, onUpdateName, onUpdateSize } = data;
  const [isEditing, setIsEditing] = React.useState(false);
  const [editName, setEditName] = React.useState(agent.name);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const [{ isOver }, dropRef] = useDrop(() => ({
    accept: 'SKILL',
    drop: (item: Skill) => {
      onAddSkill(agent.id, item);
    },
    collect: (monitor) => ({
      isOver: monitor.isOver(),
    }),
  }), [agent.id, onAddSkill]);

  React.useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsEditing(true);
    setEditName(agent.name);
  };

  const handleNameSubmit = () => {
    if (editName.trim() && editName !== agent.name) {
      onUpdateName(agent.id, editName.trim());
    } else {
      setEditName(agent.name);
    }
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleNameSubmit();
    } else if (e.key === 'Escape') {
      setEditName(agent.name);
      setIsEditing(false);
    }
  };

  const getStatusColor = () => {
    switch (agent.status) {
      case 'running': return 'bg-green-500';
      case 'completed': return 'bg-blue-500';
      case 'error': return 'bg-red-500';
      default: return 'bg-gray-400';
    }
  };

  const getStatusText = () => {
    switch (agent.status) {
      case 'running': return 'Running';
      case 'completed': return 'Completed';
      case 'error': return 'Error';
      default: return 'Idle';
    }
  };

  const getInitials = (name: string) => {
    return name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
  };

  // Unified handle class for consistent styling
  const handleTwClass = "!w-3 !h-3 !bg-claude-accent !border-2 !border-white dark:!border-claude-darkBg transition-transform hover:scale-150";

  return (
    <>
      <NodeResizer
        minWidth={200}
        isVisible={selected}
        lineClassName="border-claude-accent"
        handleClassName="h-3 w-3 bg-white border-2 border-claude-accent rounded-sm"
        onResizeEnd={(_, params) => {
          if (onUpdateSize) {
            onUpdateSize(agent.id, params.width, params.height);
          }
        }}
      />
      <div
        ref={dropRef as any}
        className={`
          relative w-full h-full min-w-[200px] rounded-xl border shadow-sm transition-all
          dark:bg-claude-darkSurface bg-claude-surface
        ${isOver
            ? 'border-claude-accent ring-2 ring-claude-accent/50 shadow-lg shadow-claude-accent/20'
            : selected
              ? 'border-claude-accent shadow-lg shadow-claude-accent/20 dark:border-claude-darkBorder'
              : 'dark:border-claude-darkBorder border-claude-border hover:border-claude-accent/50'
          }
      `}
      >
        {/* Top Handles - both input and output */}
        <Handle type="target" position={Position.Top} id="top-target" className={handleTwClass} />
        <Handle type="source" position={Position.Top} id="top-source" className={handleTwClass} />

        {/* Bottom Handles - both input and output */}
        <Handle type="target" position={Position.Bottom} id="bottom-target" className={handleTwClass} />
        <Handle type="source" position={Position.Bottom} id="bottom-source" className={handleTwClass} />

        {/* Left Handles - both input and output */}
        <Handle type="target" position={Position.Left} id="left-target" className={handleTwClass} />
        <Handle type="source" position={Position.Left} id="left-source" className={handleTwClass} />

        {/* Right Handles - both input and output */}
        <Handle type="target" position={Position.Right} id="right-target" className={handleTwClass} />
        <Handle type="source" position={Position.Right} id="right-source" className={handleTwClass} />

        {/* Header - Avatar + Name + Remove button */}
        <div className="flex items-center justify-between p-3 pb-2 group">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {/* Avatar - colored circle with initials */}
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-semibold shrink-0"
              style={{ backgroundColor: AGENT_COLORS[Math.abs(agent.id.charCodeAt(0)) % AGENT_COLORS.length] }}
            >
              {getInitials(agent.name)}
            </div>

            {/* Name - editable on double-click */}
            {isEditing ? (
              <input
                ref={inputRef}
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={handleNameSubmit}
                onKeyDown={handleKeyDown}
                className="nodrag flex-1 min-w-0 px-1 py-0.5 text-sm font-medium bg-transparent border rounded dark:text-claude-darkText text-claude-text dark:border-claude-darkBorder border-claude-border focus:outline-none focus:border-claude-accent"
              />
            ) : (
              <span
                onDoubleClick={handleDoubleClick}
                className="text-sm font-medium truncate cursor-text dark:text-claude-darkText text-claude-text"
                title="Double-click to rename"
              >
                {agent.name}
              </span>
            )}
          </div>

          {/* Remove button - appears on hover */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRemove(agent.id);
            }}
            className="nodrag ml-1 p-1 rounded-lg opacity-0 group-hover:opacity-100 hover:bg-red-500/10 text-gray-400 hover:text-red-500 transition-all"
          >
            <XMarkIcon className="w-4 h-4" />
          </button>
        </div>

        {/* Skills - colored chips with remove button */}
        {agent.skills.length > 0 && (
          <div className="px-3 pb-3 pt-1">
            <div className="flex flex-wrap gap-1.5">
              {agent.skills.map((skill) => (
                <SkillBadge
                  key={skill.id}
                  skill={skill}
                  onRemove={() => onRemoveSkill(agent.id, skill.id)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Footer - Status indicator dot + status text */}
        <div className="px-3 pb-3 flex items-center gap-1.5">
          <div className={`w-2 h-2 rounded-full ${getStatusColor()} shrink-0`} />
          <span className="text-xs text-gray-500 dark:text-gray-400">{getStatusText()}</span>
        </div>

      </div>
    </>
  );
});

const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  CodeBracketIcon,
  EyeIcon,
  ShieldCheckIcon,
  BeakerIcon,
  DocumentTextIcon,
  RocketLaunchIcon,
};

// Skill Badge Component
const SkillBadge: React.FC<{ skill: Skill; onRemove: () => void }> = ({ skill, onRemove }) => {
  const IconComponent = ICON_MAP[skill.icon] || CodeBracketIcon;

  return (
    <div
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium text-white"
      style={{ backgroundColor: skill.color }}
    >
      <IconComponent className="w-3.5 h-3.5" />
      <span className="truncate max-w-[80px]">{i18nService.t(`skill.${skill.id}`) || skill.name}</span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="nodrag hover:bg-white/20 rounded-full p-0.5 ml-0.5"
      >
        <XMarkIcon className="w-3 h-3" />
      </button>
    </div>
  );
};

AgentNode.displayName = 'AgentNode';

export default AgentNode;
