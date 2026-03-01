import React, { useState, useEffect } from 'react';
import { useDispatch } from 'react-redux';
import {
  XMarkIcon,
  SparklesIcon,
  PencilIcon,
  PlusIcon,
  WrenchIcon,
  WrenchScrewdriverIcon,
  CodeBracketIcon,
  EyeIcon,
  ShieldCheckIcon,
  BeakerIcon,
  DocumentTextIcon,
  RocketLaunchIcon,
  BugAntIcon,
  CheckCircleIcon,
  PencilSquareIcon,
  BookOpenIcon,
  ArrowPathIcon,
  CubeTransparentIcon,
  ServerStackIcon,
  ChartBarIcon,
  CircleStackIcon,
  TableCellsIcon,
  PaintBrushIcon,
  RectangleGroupIcon,
  ArrowsRightLeftIcon,
  LinkIcon,
  CpuChipIcon,
  ChatBubbleBottomCenterTextIcon,
  CloudIcon,
  ClipboardDocumentListIcon,
  UserGroupIcon,
  MagnifyingGlassIcon,
  CubeIcon,
} from '@heroicons/react/24/outline';
import { renameAgent, updateAgentSoul, removeAgent } from '../../store/slices/workflowSlice';
import type { WorkflowAgent, Skill } from './workflowTypes';
import { PREDEFINED_SKILLS, AGENT_COLORS } from './workflowTypes';
import { i18nService } from '../../services/i18n';

// Icon mapping for skills
const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  CodeBracketIcon,
  EyeIcon,
  ShieldCheckIcon,
  BeakerIcon,
  DocumentTextIcon,
  RocketLaunchIcon,
  WrenchScrewdriverIcon,
  BugAntIcon,
  CheckCircleIcon,
  PencilSquareIcon,
  BookOpenIcon,
  ArrowPathIcon,
  CubeTransparentIcon,
  ServerStackIcon,
  ChartBarIcon,
  CircleStackIcon,
  TableCellsIcon,
  PaintBrushIcon,
  RectangleGroupIcon,
  ArrowsRightLeftIcon,
  LinkIcon,
  CpuChipIcon,
  SparklesIcon,
  ChatBubbleBottomCenterTextIcon,
  CloudIcon,
  ClipboardDocumentListIcon,
  UserGroupIcon,
  MagnifyingGlassIcon,
  CubeIcon,
};

interface AgentConfigPanelProps {
  agent: WorkflowAgent | null;
  onClose: () => void;
  onRemoveSkill: (agentId: string, skillId: string) => void;
  onAddSkill: (agentId: string, skill: Skill) => void;
  onShowSkills?: (skillId: string) => void;
}

const AgentConfigPanel: React.FC<AgentConfigPanelProps> = ({
  agent,
  onClose,
  onRemoveSkill,
  onAddSkill,
  onShowSkills,
}) => {
  const dispatch = useDispatch();
  const [name, setName] = useState(agent?.name || '');
  const [soulPrompt, setSoulPrompt] = useState(agent?.soulPrompt || '');
  const [isEditingName, setIsEditingName] = useState(false);

  useEffect(() => {
    if (agent) {
      setName(agent.name);
      setSoulPrompt(agent.soulPrompt || '');
    }
  }, [agent]);

  if (!agent) return null;

  const handleNameSubmit = () => {
    if (name.trim() && name !== agent.name) {
      dispatch(renameAgent({ id: agent.id, name: name.trim() }));
    }
    setIsEditingName(false);
  };

  const handleSoulPromptChange = (value: string) => {
    setSoulPrompt(value);
    dispatch(updateAgentSoul({ id: agent.id, soulPrompt: value }));
  };

  const handleAddSkill = (skill: Skill) => {
    if (!agent.skills.find(s => s.id === skill.id)) {
      onAddSkill(agent.id, skill);
    }
  };

  const handleRemoveSkill = (skillId: string) => {
    onRemoveSkill(agent.id, skillId);
  };

  const handleRemoveAgent = () => {
    dispatch(removeAgent(agent.id));
    onClose();
  };

  const getInitials = (agentName: string) => {
    return agentName.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
  };

  const availableSkills = PREDEFINED_SKILLS.filter(
    ps => !agent.skills.find(s => s.id === ps.id)
  );

  return (
    <div className="absolute right-0 top-0 h-full w-96 bg-claude-surface dark:bg-claude-darkSurface border-l dark:border-claude-darkBorder border-claude-border shadow-2xl z-50 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b dark:border-claude-darkBorder border-claude-border">
        <h2 className="text-sm font-semibold dark:text-claude-darkText text-claude-text">
          Agent Configuration
        </h2>
        <button
          onClick={onClose}
          className="p-1 rounded-lg hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
        >
          <XMarkIcon className="w-5 h-5 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Agent Name */}
        <div>
          <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">
            Name
          </label>
          {isEditingName ? (
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={handleNameSubmit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleNameSubmit();
                if (e.key === 'Escape') {
                  setName(agent.name);
                  setIsEditingName(false);
                }
              }}
              className="w-full px-3 py-2 text-sm rounded-lg border dark:bg-claude-darkBg bg-claude-bg dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text focus:outline-none focus:border-claude-accent"
              autoFocus
            />
          ) : (
            <div
              onClick={() => setIsEditingName(true)}
              className="flex items-center gap-2 px-3 py-2 rounded-lg border dark:border-claude-darkBorder border-claude-border cursor-pointer hover:border-claude-accent/50 transition-colors"
            >
              <div
                className="w-6 h-6 rounded-full flex items-center justify-center text-white text-xs font-semibold"
                style={{ backgroundColor: AGENT_COLORS[Math.abs(agent.id.charCodeAt(0)) % AGENT_COLORS.length] }}
              >
                {getInitials(agent.name)}
              </div>
              <span className="flex-1 dark:text-claude-darkText text-claude-text">{agent.name}</span>
              <PencilIcon className="w-4 h-4 text-gray-400" />
            </div>
          )}
        </div>

        {/* Soul Prompt */}
        <div>
          <label className="flex items-center gap-2 text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">
            <SparklesIcon className="w-4 h-4" />
            Soul Prompt (System Instruction)
          </label>
          <textarea
            value={soulPrompt}
            onChange={(e) => handleSoulPromptChange(e.target.value)}
            placeholder="Define this agent's personality and capabilities...&#10;Example: You are a full-stack developer specializing in Go and Angular..."
            className="w-full h-48 px-3 py-2 text-sm rounded-lg border dark:bg-claude-darkBg bg-claude-bg dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text placeholder-gray-400 focus:outline-none focus:border-claude-accent resize-none"
          />
          <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
            This prompt defines the agent's behavior and capabilities
          </p>
        </div>

        {/* Skills */}
        <div>
          <label className="flex items-center gap-2 text-xs font-medium text-gray-500 dark:text-gray-400 mb-3">
            <WrenchIcon className="w-4 h-4" />
            {i18nService.t('workflowSkills')}
          </label>

          {/* Current Skills - with icons */}
          <div className="space-y-2 mb-4">
            {agent.skills.length > 0 ? (
              agent.skills.map((skill) => {
                const IconComponent = ICON_MAP[skill.icon] || WrenchScrewdriverIcon;
                return (
                  <div
                    key={skill.id}
                    className="flex items-center gap-3 p-2.5 rounded-lg border dark:border-claude-darkBorder border-claude-border"
                    style={{ backgroundColor: `${skill.color}15`, borderColor: `${skill.color}40` }}
                  >
                    <div
                      className="w-8 h-8 rounded-lg flex items-center justify-center text-white shrink-0"
                      style={{ backgroundColor: skill.color }}
                      onClick={onShowSkills ? () => onShowSkills(skill.id) : undefined}
                    >
                      <IconComponent className="w-3.5 h-3.5" />
                    </div>
                    <div
                      className="flex-1 min-w-0 cursor-pointer"
                      onClick={onShowSkills ? () => onShowSkills(skill.id) : undefined}
                    >
                      <p className="text-sm font-medium dark:text-claude-darkText text-claude-text truncate hover:text-claude-accent transition-colors">
                        {i18nService.t(`skill.${skill.id}`) || skill.name}
                      </p>
                    </div>
                    <button
                      onClick={() => handleRemoveSkill(skill.id)}
                      className="p-1.5 rounded-lg hover:bg-red-500/10 text-gray-400 hover:text-red-500 transition-colors"
                    >
                      <XMarkIcon className="w-4 h-4" />
                    </button>
                  </div>
                );
              })
            ) : (
              <div className="text-center py-4 px-3 rounded-lg border border-dashed dark:border-claude-darkBorder border-claude-border">
                <p className="text-xs text-gray-400 dark:text-gray-500">
                  No skills assigned yet
                </p>
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                  Add skills from the list below
                </p>
              </div>
            )}
          </div>

          {/* Available Skills to Add */}
          {availableSkills.length > 0 && (
            <div className="pt-3 border-t dark:border-claude-darkBorder border-claude-border">
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-3">
                {i18nService.t('workflowAddSkill') || 'Available Skills'}
              </p>
              <div className="grid grid-cols-2 gap-2">
                {availableSkills.slice(0, 12).map((skill) => {
                  const IconComponent = ICON_MAP[skill.icon] || WrenchScrewdriverIcon;
                  return (
                    <button
                      key={skill.id}
                      onClick={() => handleAddSkill(skill)}
                      className="flex items-center gap-2 p-2 rounded-lg border dark:border-claude-darkBorder border-claude-border hover:border-claude-accent/50 hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors text-left"
                    >
                      <div
                        className="w-6 h-6 rounded-md flex items-center justify-center text-white shrink-0"
                        style={{ backgroundColor: skill.color }}
                      >
                        <IconComponent className="w-3 h-3" />
                      </div>
                      <span className="text-xs font-medium dark:text-claude-darkText text-claude-text truncate">
                        {skill.name}
                      </span>
                      <PlusIcon className="w-3 h-3 text-gray-400 ml-auto" />
                    </button>
                  );
                })}
              </div>
              {availableSkills.length > 12 && (
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-2 text-center">
                  +{availableSkills.length - 12} more skills available
                </p>
              )}
            </div>
          )}
        </div>

        {/* Danger Zone */}
        <div className="pt-4 border-t dark:border-claude-darkBorder border-claude-border">
          <button
            onClick={handleRemoveAgent}
            className="w-full px-3 py-2 text-sm font-medium text-red-600 dark:text-red-400 rounded-lg border border-red-300 dark:border-red-700 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
          >
            Remove Agent
          </button>
        </div>
      </div>
    </div>
  );
};

export default AgentConfigPanel;
