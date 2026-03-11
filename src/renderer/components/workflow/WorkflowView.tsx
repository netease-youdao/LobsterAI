import React, { useState, useCallback } from 'react';
import { useSelector } from 'react-redux';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import SkillPalette from './SkillPalette';
import WorkflowCanvas from './WorkflowCanvas';
import WorkflowOutputPanel from './WorkflowOutputPanel';
import { i18nService } from '../../services/i18n';
import { RootState } from '../../store';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import ComposeIcon from '../icons/ComposeIcon';
import SkillConfigPanel from './SkillConfigPanel';

interface WorkflowViewProps {
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  onViewSession?: (sessionId: string) => void;
  onShowSkills?: () => void; // still used to navigate away if needed
}

const WorkflowView: React.FC<WorkflowViewProps> = ({
  isSidebarCollapsed,
  onToggleSidebar,
  onNewChat,
  onViewSession,
}) => {
  const isMac = window.electron.platform === 'darwin';
  const [focusAgentId, setFocusAgentId] = useState<string | null>(null);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const isRunning = useSelector((state: RootState) => state.workflow.isRunning);
  const currentRunDirectory = useSelector((state: RootState) => state.workflow.currentRunDirectory);

  const handleAgentCreated = useCallback((agentId: string) => {
    setFocusAgentId(agentId);
    // Clear focus after a short delay to allow re-triggering
    setTimeout(() => setFocusAgentId(null), 100);
  }, []);

  const handleShowSkillConfig = useCallback((skillId: string) => {
    setSelectedSkillId(skillId);
  }, []);

  return (
    <DndProvider backend={HTML5Backend}>
      <ReactFlowProvider>
        <div className="flex flex-col h-full relative">
          {/* Header - Draggable bar with title */}
          <div className="draggable flex h-12 items-center justify-between px-4 border-b dark:border-claude-darkBorder border-claude-border shrink-0">
            <div className="flex items-center space-x-3 h-8">
              {isSidebarCollapsed && (
                <div className={`non-draggable flex items-center gap-1 ${isMac ? 'pl-[68px]' : ''}`}>
                  <button
                    type="button"
                    onClick={onToggleSidebar}
                    className="h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
                  >
                    <SidebarToggleIcon className="h-4 w-4" isCollapsed={true} />
                  </button>
                  <button
                    type="button"
                    onClick={onNewChat}
                    className="h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
                  >
                    <ComposeIcon className="h-4 w-4" />
                  </button>
                </div>
              )}
              <h1 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
                {i18nService.t('agentWorkflow')}
              </h1>
            </div>
          </div>

          {/* Main Content Area - Canvas + Output Panel stacked */}
          <div className="non-draggable flex flex-col flex-1 min-h-0">
            {/* Left Panel - Skill Palette (absolute left) */}
            <div className="absolute left-0 top-0 bottom-0 w-72 z-10 border-r dark:border-claude-darkBorder border-claude-border">
              <SkillPalette onAgentCreated={handleAgentCreated} onViewSession={onViewSession} onShowSkills={handleShowSkillConfig as any} />
            </div>

            {/* Canvas and Output Panel - stacked vertically */}
            <div className="flex-1 flex flex-col ml-72 min-w-0">
              {/* Canvas Area */}
              <div className="flex-1 min-h-0">
                <WorkflowCanvas focusAgentId={focusAgentId} onShowSkills={handleShowSkillConfig as any} />
              </div>

              {/* Output Panel at bottom */}
              <WorkflowOutputPanel
                workingDirectory={currentRunDirectory || ''}
                isRunning={isRunning}
              />
            </div>

            {/* Skill Config Panel overlapping the canvas on the right */}
            {selectedSkillId && (
              <SkillConfigPanel
                skillId={selectedSkillId}
                onClose={() => setSelectedSkillId(null)}
              />
            )}
          </div>
        </div>
      </ReactFlowProvider>
    </DndProvider>
  );
};

export default WorkflowView;
