import React, { useState, useCallback, useEffect } from 'react';
import { useDrag } from 'react-dnd';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '../../store';
import {
  CodeBracketIcon,
  EyeIcon,
  ShieldCheckIcon,
  BeakerIcon,
  DocumentTextIcon,
  RocketLaunchIcon,
  PlusIcon,
  XMarkIcon,
  Squares2X2Icon,
  CubeIcon,
  TrashIcon,
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
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  FolderOpenIcon,
} from '@heroicons/react/24/outline';
import { addSkill, removeSkill, addAgent, removeWorkflowRun } from '../../store/slices/workflowSlice';
import { coworkService } from '../../services/cowork';
import type { Skill } from './workflowTypes';
import { PREDEFINED_SKILLS, AGENT_TEMPLATES, PREDEFINED_SKILLS as ALL_SKILLS } from './workflowTypes';
import { i18nService } from '../../services/i18n';

// Icon mapping for all skills
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

interface SkillPaletteProps {
  onAgentCreated?: (agentId: string) => void;
  onViewSession?: (sessionId: string) => void;
  onShowSkills?: (skillId: string) => void;
}

const SkillPalette: React.FC<SkillPaletteProps> = ({ onAgentCreated, onViewSession, onShowSkills }) => {
  const dispatch = useDispatch();
  const customSkills = useSelector((state: RootState) => state.workflow.skills);
  const workflowAgents = useSelector((state: RootState) => state.workflow.agents);
  const workflowRuns = useSelector((state: RootState) => state.workflow.workflowRuns || []);
  const [newSkillName, setNewSkillName] = useState('');
  const [showAgents, setShowAgents] = useState(false);
  const [skillsExpanded, setSkillsExpanded] = useState(true);

  // Load sessions on mount
  useEffect(() => {
    coworkService.loadSessions();
  }, []);

  // Format relative time
  const formatRelativeTime = (timestamp: number): string => {
    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return i18nService.t('coworkJustNow') || 'Just now';
    if (minutes < 60) return i18nService.t('coworkMinutesAgo')?.replace('{n}', String(minutes)) || `${minutes}m ago`;
    if (hours < 24) return i18nService.t('coworkHoursAgo')?.replace('{n}', String(hours)) || `${hours}h ago`;
    return i18nService.t('coworkDaysAgo')?.replace('{n}', String(days)) || `${days}d ago`;
  };

  // Handle view session
  const handleViewSession = useCallback((sessionId: string) => {
    if (onViewSession) {
      onViewSession(sessionId);
    }
  }, [onViewSession]);

  const handleAddCustomSkill = useCallback(() => {
    if (!newSkillName.trim()) return;

    const id = `custom-${Date.now()}`;
    const colors = ['#10B981', '#8B5CF6', '#F59E0B', '#EF4444', '#3B82F6', '#EC4899'];
    const newSkill: Skill = {
      id,
      name: newSkillName.trim(),
      color: colors[Math.floor(Math.random() * colors.length)],
      icon: 'CodeBracketIcon',
    };

    dispatch(addSkill(newSkill));
    setNewSkillName('');
  }, [newSkillName, dispatch]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleAddCustomSkill();
    }
  };

  const handleRemoveCustomSkill = useCallback((skillId: string) => {
    dispatch(removeSkill(skillId));
  }, [dispatch]);

  const showToast = useCallback((message: string) => {
    window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
  }, []);

  const handleAddAgent = useCallback((templateId?: string) => {
    const agentCount = workflowAgents.length + 1;

    if (templateId) {
      const template = AGENT_TEMPLATES.find(t => t.id === templateId);
      if (template) {
        const templateSkills = template.suggestedSkills
          .map(skillId => ALL_SKILLS.find(s => s.id === skillId))
          .filter((s): s is Skill => s !== undefined);

        dispatch(addAgent({
          name: template.name,
          soulPrompt: template.soulPrompt,
          skills: templateSkills,
        }));

        showToast(`✅ ${template.name} created successfully`);
        if (onAgentCreated) {
          setTimeout(() => onAgentCreated('last'), 100);
        }
        return;
      }
    }

    dispatch(addAgent({
      name: `Agent ${agentCount}`,
    }));

    showToast(`✅ Agent ${agentCount} created successfully`);
    if (onAgentCreated) {
      setTimeout(() => onAgentCreated('last'), 100);
    }
  }, [workflowAgents, dispatch, showToast, onAgentCreated]);

  return (
    <div className="w-full h-full flex flex-col dark:bg-claude-darkSurface bg-claude-surface border-r dark:border-claude-darkBorder border-claude-border">
      {/* Header */}
      <div className="p-4 border-b dark:border-claude-darkBorder border-claude-border">
        <h2 className="text-sm font-semibold dark:text-claude-darkText text-claude-text">
          {i18nService.t('workflowTitle')}
        </h2>
      </div>

      {/* Tab Toggle - Pill style */}
      <div className="p-4 pb-2">
        <div className="flex bg-claude-surfaceHover dark:bg-claude-darkSurfaceHover rounded-lg p-0.5">
          <button
            onClick={() => setShowAgents(false)}
            className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md text-xs font-medium transition-all ${!showAgents
              ? 'bg-claude-surface dark:bg-claude-darkSurface shadow-sm text-claude-accent'
              : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
          >
            <Squares2X2Icon className="w-3.5 h-3.5" />
            Templates
          </button>
          <button
            onClick={() => setShowAgents(true)}
            className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md text-xs font-medium transition-all ${showAgents
              ? 'bg-claude-surface dark:bg-claude-darkSurface shadow-sm text-claude-accent'
              : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
          >
            <CubeIcon className="w-3.5 h-3.5" />
            {i18nService.t('workflowRunHistory') || 'History'}
            {workflowRuns.length > 0 && (
              <span className="ml-1 px-1.5 py-0.5 text-xs bg-claude-accent text-white rounded-full">
                {workflowRuns.length}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {/* Templates View */}
        {!showAgents && (
          <div className="p-3 pt-0 space-y-3">
            {/* Template List */}
            <div>
              <h3 className="text-[10px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-2">
                Agent Templates
              </h3>
              <div className="space-y-1.5">
                {AGENT_TEMPLATES.map((template) => (
                  <button
                    key={template.id}
                    onClick={() => handleAddAgent(template.id)}
                    className="w-full flex items-center gap-2 p-1.5 rounded-lg border dark:border-claude-darkBorder border-claude-border hover:border-claude-accent/50 hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors text-left"
                  >
                    <div
                      className="w-6 h-6 rounded-full flex items-center justify-center text-white text-[9px] font-semibold shrink-0"
                      style={{ backgroundColor: template.color }}
                    >
                      {template.name.split(' ').map(w => w[0]).join('').substring(0, 2)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium dark:text-claude-darkText text-claude-text truncate">
                        {template.name}
                      </p>
                      <p className="text-[10px] text-gray-400 dark:text-gray-500 truncate">
                        {template.suggestedSkills.map(s => s.replace('-', ' ')).join(', ')}
                      </p>
                    </div>
                    <PlusIcon className="w-3.5 h-3.5 text-gray-400" />
                  </button>
                ))}
              </div>
            </div>

            {/* Collapsible Skills Section */}
            <div className="pt-4 border-t dark:border-claude-darkBorder border-claude-border">
              <button
                onClick={() => setSkillsExpanded(!skillsExpanded)}
                className="w-full flex items-center justify-between mb-3"
              >
                <h3 className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  {i18nService.t('workflowSkills')}
                </h3>
                {skillsExpanded ? (
                  <ChevronDownIcon className="w-4 h-4 text-gray-400" />
                ) : (
                  <ChevronRightIcon className="w-4 h-4 text-gray-400" />
                )}
              </button>

              {skillsExpanded && (
                <>
                  {/* Predefined Skills - Grid */}
                  <div className="grid grid-cols-2 gap-2 mb-3">
                    {PREDEFINED_SKILLS.map((skill) => (
                      <DraggableSkill key={skill.id} skill={skill} compact onClick={() => onShowSkills?.(skill.id)} />
                    ))}
                  </div>

                  {/* Custom Skills */}
                  {customSkills.length > 0 && (
                    <div className="flex flex-wrap gap-2 mb-3 pt-3 border-t dark:border-claude-darkBorder border-claude-border">
                      {customSkills.map((skill) => (
                        <div key={skill.id} className="relative group">
                          <DraggableSkill skill={skill} onClick={() => onShowSkills?.(skill.id)} />
                          <button
                            onClick={() => handleRemoveCustomSkill(skill.id)}
                            className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
                          >
                            <XMarkIcon className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Add Custom Skill */}
                  <div className="mt-2">
                    <input
                      type="text"
                      value={newSkillName}
                      onChange={(e) => setNewSkillName(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder={i18nService.t('workflowCustomSkill')}
                      className="w-full px-3 py-2 text-sm rounded-lg border dark:bg-claude-darkBg bg-claude-bg dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text placeholder-gray-400 focus:outline-none focus:border-claude-accent"
                    />
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* Workflow Run History View */}
        {showAgents && (
          <div className="p-3 pt-0">
            {workflowRuns.length === 0 ? (
              <div className="text-center py-6">
                <ClockIcon className="w-10 h-10 mx-auto text-gray-300 dark:text-gray-600 mb-2" />
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {i18nService.t('workflowNoRuns') || 'No workflow runs yet'}
                </p>
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                  {i18nService.t('workflowNoRunsHint') || 'Run a workflow to see history here'}
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {workflowRuns.map((run) => (
                  <div
                    key={run.id}
                    className="rounded-lg border dark:border-claude-darkBorder border-claude-border overflow-hidden"
                  >
                    {/* Run Header */}
                    <div className="flex items-center gap-2 p-2 bg-claude-bg dark:bg-claude-darkBg">
                      <div className={`w-2 h-2 rounded-full shrink-0 ${run.status === 'running' ? 'bg-green-500 animate-pulse' :
                        run.status === 'completed' ? 'bg-blue-500' :
                          run.status === 'error' ? 'bg-red-500' : 'bg-gray-400'
                        }`} />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium dark:text-claude-darkText text-claude-text truncate">
                          {run.title || run.id}
                        </p>
                        <p className="text-[10px] text-gray-400 dark:text-gray-500">
                          {formatRelativeTime(run.startTime)}
                        </p>
                      </div>
                      {/* Run Actions */}
                      <div className="flex items-center gap-0.5">
                        {run.workingDirectory && (
                          <button
                            onClick={() => window.electron.shell.openPath(run.workingDirectory)}
                            className="p-1 rounded-lg hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover text-gray-400 hover:text-green-500 transition-colors"
                            title="Open Folder"
                          >
                            <FolderOpenIcon className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <button
                          onClick={() => dispatch(removeWorkflowRun(run.id))}
                          className="p-1 rounded-lg hover:bg-red-500/10 text-gray-400 hover:text-red-500 transition-colors"
                          title={i18nService.t('coworkDeleteTask') || 'Delete'}
                        >
                          <TrashIcon className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                    {/* Agent Entries */}
                    <div className="divide-y dark:divide-claude-darkBorder divide-claude-border">
                      {run.agents.map((agentEntry) => (
                        <div
                          key={agentEntry.agentId}
                          className="flex items-center gap-2 px-2 py-1.5 hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
                        >
                          <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${agentEntry.status === 'running' ? 'bg-yellow-500 animate-pulse' :
                            agentEntry.status === 'completed' ? 'bg-green-500' :
                              agentEntry.status === 'error' ? 'bg-red-500' :
                                agentEntry.status === 'skipped' ? 'bg-gray-400' : 'bg-gray-300'
                            }`} />
                          <span className="flex-1 text-[11px] dark:text-claude-darkText text-claude-text truncate">
                            {agentEntry.agentName}
                          </span>
                          {agentEntry.sessionId && (
                            <button
                              onClick={() => agentEntry.sessionId && handleViewSession(agentEntry.sessionId)}
                              className="p-0.5 rounded hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover text-gray-400 hover:text-claude-accent transition-colors"
                              title={i18nService.t('coworkViewTask') || 'View session'}
                            >
                              <EyeIcon className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Add Empty Agent Button */}
      <div className="p-3 border-t dark:border-claude-darkBorder border-claude-border">
        <button
          onClick={() => handleAddAgent()}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-claude-accent hover:bg-claude-accentHover text-white rounded-lg text-xs font-medium transition-colors"
        >
          <PlusIcon className="w-4 h-4" />
          {i18nService.t('workflowAddAgent')}
        </button>
      </div>
    </div>
  );
};

// Draggable Skill Component
interface DraggableSkillProps {
  skill: Skill;
  compact?: boolean;
  onClick?: () => void;
}

const DraggableSkill: React.FC<DraggableSkillProps> = ({ skill, compact, onClick }) => {
  const [{ isDragging }, drag] = useDrag(() => ({
    type: 'SKILL',
    item: skill,
    collect: (monitor) => ({
      isDragging: monitor.isDragging(),
    }),
  }), [skill]);

  const IconComponent = ICON_MAP[skill.icon] || CodeBracketIcon;

  return (
    <div
      ref={drag}
      onClick={onClick}
      className={`
        inline-flex items-center gap-1.5 rounded-lg font-medium text-white cursor-grab transition-all max-w-full overflow-hidden
        ${isDragging ? 'opacity-50 scale-95' : 'hover:scale-105'}
        ${compact ? 'px-2 py-1.5 text-[10px]' : 'px-2.5 py-1.5 text-xs'}
        ${onClick ? 'cursor-pointer' : ''}
      `}
      style={{ backgroundColor: skill.color }}
      title={i18nService.t(`skill.${skill.id}`) || skill.name}
    >
      <IconComponent className={compact ? 'w-3 h-3 shrink-0' : 'w-3.5 h-3.5 shrink-0'} />
      <span className="truncate flex-1 text-left leading-tight">
        {i18nService.t(`skill.${skill.id}`) || skill.name}
      </span>
    </div>
  );
};

export default SkillPalette;
