import React, { memo } from 'react';
import { useDispatch } from 'react-redux';
import { updateAgentModel } from '../../store/slices/workflowSlice';
import ModelSelector from '../ModelSelector';
import { Model } from '../../store/slices/modelSlice';
import { NodeResizer, Handle, Position, type NodeProps } from '@xyflow/react';
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
import type { WorkflowAgent, Skill, RouteCondition } from './workflowTypes';
import { i18nService } from '../../services/i18n';

interface AgentNodeData {
  agent: WorkflowAgent;
  allAgents: WorkflowAgent[];
  onRemove: (id: string) => void;
  onRemoveSkill: (agentId: string, skillId: string) => void;
  onAddSkill: (agentId: string, skill: Skill) => void;
  onUpdateName: (id: string, name: string) => void;
  onUpdateSize?: (id: string, width: number, height: number) => void;
  onSetInputFrom: (agentId: string, fromId: string | null) => void;
  onAddRoute: (agentId: string, condition: RouteCondition, targetAgentId: string, keyword?: string) => void;
  onRemoveRoute: (agentId: string, routeId: string) => void;
  onUpdateRoute: (agentId: string, routeId: string, updates: { condition?: RouteCondition; keyword?: string; targetAgentId?: string }) => void;
}

// Agent colors for avatar
const AGENT_COLORS = [
  '#10B981', '#8B5CF6', '#F59E0B', '#EF4444', '#3B82F6',
  '#EC4899', '#06B6D4', '#84CC16', '#F97316', '#6366F1',
];

// Condition icons and labels
const CONDITION_OPTIONS: { value: RouteCondition; icon: string; labelKey: string; fallback: string }[] = [
  { value: 'onComplete', icon: '✅', labelKey: 'workflow.onComplete', fallback: '完成时' },
  { value: 'onError', icon: '❌', labelKey: 'workflow.onError', fallback: '失败时' },
  { value: 'outputContains', icon: '🔍', labelKey: 'workflow.outputContains', fallback: '含关键词' },
  { value: 'always', icon: '🔄', labelKey: 'workflow.always', fallback: '始终' },
];

const AgentNode: React.FC<NodeProps & { data: AgentNodeData }> = memo(({ data, selected }) => {
  const { agent, allAgents, onRemove, onRemoveSkill, onAddSkill, onUpdateName, onUpdateSize, onSetInputFrom, onAddRoute, onRemoveRoute, onUpdateRoute } = data;
  const dispatch = useDispatch();
  const [isEditing, setIsEditing] = React.useState(false);
  const [editName, setEditName] = React.useState(agent.name);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Get other agents for dropdown options (exclude self)
  const otherAgents = allAgents.filter(a => a.id !== agent.id);

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
                onClick={(e) => e.stopPropagation()}
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
          <div className="px-3 pb-2 pt-1">
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

        {/* Input From / Output Routes */}
        <div className="px-3 pb-2 space-y-1.5">
          {/* Input From - Select upstream node */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500 dark:text-gray-400 w-8">↓{i18nService.t('workflow.inputFrom') || '入口'}</span>
            <select
              value={agent.inputFrom || ''}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => onSetInputFrom(agent.id, e.target.value || null)}
              className="nodrag flex-1 min-w-0 px-2 py-1 text-xs bg-transparent border rounded dark:text-claude-darkText text-claude-text dark:border-claude-darkBorder border-claude-border focus:outline-none focus:border-claude-accent"
            >
              <option value="">{i18nService.t('workflow.none') || '无 (起点)'}</option>
              {otherAgents.map((otherAgent) => (
                <option key={otherAgent.id} value={otherAgent.id}>
                  {otherAgent.name}
                </option>
              ))}
            </select>
          </div>

          {/* Output Routes - Conditional route list */}
          <div className="space-y-1">
            <span className="text-xs text-gray-500 dark:text-gray-400">↑ {i18nService.t('workflow.outputRoutes') || '出口路由'}</span>
            {(agent.outputRoutes || []).map((route) => (
              <div key={route.id} className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                {/* Condition selector */}
                <select
                  value={route.condition}
                  onChange={(e) => onUpdateRoute(agent.id, route.id, { condition: e.target.value as RouteCondition })}
                  className="nodrag min-w-0 px-1 py-0.5 text-xs bg-transparent border rounded dark:text-claude-darkText text-claude-text dark:border-claude-darkBorder border-claude-border focus:outline-none focus:border-claude-accent"
                >
                  {CONDITION_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.icon} {i18nService.t(opt.labelKey) || opt.fallback}
                    </option>
                  ))}
                </select>

                {/* Keyword input (only for outputContains) */}
                {route.condition === 'outputContains' && (
                  <div className="flex flex-col gap-1 items-center">
                    <input
                      type="text"
                      value={route.keyword || ''}
                      placeholder={i18nService.t('workflow.keyword') || '关键词'}
                      onChange={(e) => onUpdateRoute(agent.id, route.id, { keyword: e.target.value })}
                      className="nodrag w-16 px-1 py-0.5 text-xs bg-transparent border rounded dark:text-claude-darkText text-claude-text dark:border-claude-darkBorder border-claude-border focus:outline-none focus:border-claude-accent"
                    />
                    <div className="flex gap-1">
                      <button
                        onClick={(e) => { e.stopPropagation(); onUpdateRoute(agent.id, route.id, { keyword: 'PASS' }) }}
                        className="nodrag text-[9px] px-1 py-0.5 bg-green-500/10 text-green-600 dark:text-green-400 hover:bg-green-500/20 rounded transition-colors font-medium border border-green-500/20"
                        title="Quick set to PASS"
                      >
                        PASS
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); onUpdateRoute(agent.id, route.id, { keyword: 'REJECT' }) }}
                        className="nodrag text-[9px] px-1 py-0.5 bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20 rounded transition-colors font-medium border border-red-500/20"
                        title="Quick set to REJECT"
                      >
                        REJECT
                      </button>
                    </div>
                  </div>
                )}

                {/* Arrow */}
                <span className="text-xs text-gray-400">→</span>

                {/* Target agent selector */}
                <select
                  value={route.targetAgentId}
                  onChange={(e) => onUpdateRoute(agent.id, route.id, { targetAgentId: e.target.value })}
                  className="nodrag flex-1 min-w-0 px-1 py-0.5 text-xs bg-transparent border rounded dark:text-claude-darkText text-claude-text dark:border-claude-darkBorder border-claude-border focus:outline-none focus:border-claude-accent"
                >
                  {otherAgents.map((otherAgent) => (
                    <option key={otherAgent.id} value={otherAgent.id}>
                      {otherAgent.name}
                    </option>
                  ))}
                </select>

                {/* Delete button */}
                <button
                  onClick={(e) => { e.stopPropagation(); onRemoveRoute(agent.id, route.id); }}
                  className="nodrag p-0.5 rounded hover:bg-red-500/10 text-gray-400 hover:text-red-500 transition-all"
                >
                  <XMarkIcon className="w-3 h-3" />
                </button>
              </div>
            ))}

            {/* Add route button */}
            {otherAgents.length > 0 && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onAddRoute(agent.id, 'onComplete', otherAgents[0].id);
                }}
                className="nodrag w-full px-2 py-0.5 text-xs text-gray-400 hover:text-claude-accent border border-dashed rounded dark:border-claude-darkBorder border-claude-border hover:border-claude-accent transition-all"
              >
                + {i18nService.t('workflow.addRoute') || '添加路由'}
              </button>
            )}
          </div>

          {/* Model Selection */}
          <div className="pt-2 mt-2 border-t dark:border-claude-darkBorder border-claude-border" onClick={(e) => e.stopPropagation()} onWheelCapture={(e) => e.stopPropagation()}>
            <span className="text-xs text-gray-500 dark:text-gray-400 block mb-1">
              🤖 {i18nService.t('workflow.model') || '大模型'}
            </span>
            <div className="nodrag">
              <ModelSelector
                dropdownDirection="up"
                showDefaultOption={true}
                value={agent.model ? { id: agent.model.id, name: agent.model.name || agent.model.id, providerKey: agent.model.providerKey } : null}
                onChange={(model: Model | null) => {
                  if (model) {
                    dispatch(updateAgentModel({
                      id: agent.id,
                      model: { id: model.id, providerKey: model.providerKey, name: model.name }
                    }));
                  } else {
                    dispatch(updateAgentModel({ id: agent.id, model: undefined }));
                  }
                }}
              />
            </div>
          </div>
        </div>

        {/* Footer - Status indicator dot + status text */}
        <div className="px-3 pb-3 flex items-center gap-1.5">
          <div className={`w-2 h-2 rounded-full ${getStatusColor()} shrink-0`} />
          <span className="text-xs text-gray-500 dark:text-gray-400">{getStatusText()}</span>
        </div>

      </div>

      {/* Handles for React Flow Edge rendering — 4 sides, source+target each */}
      {/* Top */}
      <Handle type="target" position={Position.Top} id="target-top" className="opacity-0 pointer-events-none" />
      <Handle type="source" position={Position.Top} id="source-top" className="opacity-0 pointer-events-none" />
      {/* Bottom */}
      <Handle type="target" position={Position.Bottom} id="target-bottom" className="opacity-0 pointer-events-none" />
      <Handle type="source" position={Position.Bottom} id="source-bottom" className="opacity-0 pointer-events-none" />
      {/* Left */}
      <Handle type="target" position={Position.Left} id="target-left" className="opacity-0 pointer-events-none" />
      <Handle type="source" position={Position.Left} id="source-left" className="opacity-0 pointer-events-none" />
      {/* Right */}
      <Handle type="target" position={Position.Right} id="target-right" className="opacity-0 pointer-events-none" />
      <Handle type="source" position={Position.Right} id="source-right" className="opacity-0 pointer-events-none" />
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
