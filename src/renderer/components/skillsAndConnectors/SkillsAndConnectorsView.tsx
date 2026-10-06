import React, { useEffect, useRef } from 'react';

import { i18nService } from '../../services/i18n';
import { MANAGEMENT_PAGE_TITLE_TEXT } from '../common/managementTypography';
import ComposeIcon from '../icons/ComposeIcon';
import SidebarMcpIcon from '../icons/SidebarMcpIcon';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import SkillIcon from '../icons/SkillIcon';
import { McpManager } from '../mcp';
import { reportMcpAction } from '../mcp/analytics';
import { SkillsManager } from '../skills';
import { reportSkillAction } from '../skills/analytics';
import {
  SKILLS_CONNECTORS_SECTION_LABEL_KEYS,
  SKILLS_CONNECTORS_SECTION_ORDER,
  SkillsConnectorsSection,
} from './sections';

interface SkillsAndConnectorsViewProps {
  activeSection: SkillsConnectorsSection;
  onSectionChange: (section: SkillsConnectorsSection) => void;
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  onCreateSkillByChat?: () => void;
  onUseSkill?: (skillId: string) => void;
  updateBadge?: React.ReactNode;
  skillsReadOnly?: boolean;
}

const SECTION_ICONS: Record<SkillsConnectorsSection, React.FC<{ className?: string }>> = {
  [SkillsConnectorsSection.Skills]: SkillIcon,
  [SkillsConnectorsSection.Connectors]: SidebarMcpIcon,
};

const SkillsAndConnectorsView: React.FC<SkillsAndConnectorsViewProps> = ({
  activeSection,
  onSectionChange,
  isSidebarCollapsed,
  onToggleSidebar,
  onNewChat,
  onCreateSkillByChat,
  onUseSkill,
  updateBadge,
  skillsReadOnly,
}) => {
  const isMac = window.electron.platform === 'darwin';
  const isWindows = window.electron.platform === 'win32';
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Each section has its own content height; keep the switch landing at the top.
  useEffect(() => {
    scrollContainerRef.current?.scrollTo({ top: 0 });
  }, [activeSection]);

  const handleSectionSelect = (section: SkillsConnectorsSection) => {
    if (section === activeSection) return;
    const report = section === SkillsConnectorsSection.Connectors ? reportMcpAction : reportSkillAction;
    report('section_change', {
      source: 'skills_connectors_view',
      fromSection: activeSection,
      targetSection: section,
    });
    onSectionChange(section);
  };

  return (
    <div
      data-skin-management-page="true"
      className="relative z-10 flex-1 flex flex-col bg-background h-full"
    >
      <div className="draggable flex h-12 items-center px-4 border-b border-border shrink-0">
        {isSidebarCollapsed && !isWindows && (
          <div className={`non-draggable mr-3 flex items-center gap-1 ${isMac ? 'pl-[68px]' : ''}`}>
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
        {/* The two section titles ARE the page header: quiet pill tabs, active
            marked by a soft raised background rather than an underline (the
            managers below already own the underline language). */}
        <div
          role="tablist"
          aria-label={i18nService.t('skillsAndConnectors')}
          className="non-draggable flex items-center gap-1"
        >
          {SKILLS_CONNECTORS_SECTION_ORDER.map((section) => {
            const isActive = activeSection === section;
            const Icon = SECTION_ICONS[section];
            return (
              <button
                key={section}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => handleSectionSelect(section)}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 ${MANAGEMENT_PAGE_TITLE_TEXT} font-semibold transition-colors ${
                  isActive
                    ? 'bg-surface-raised text-foreground'
                    : 'text-secondary hover:text-foreground'
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {i18nService.t(SKILLS_CONNECTORS_SECTION_LABEL_KEYS[section])}
              </button>
            );
          })}
        </div>
      </div>

      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto min-h-0 [scrollbar-gutter:stable]">
        <div className="mx-auto w-full max-w-[1120px] px-8 py-6">
          {activeSection === SkillsConnectorsSection.Connectors ? (
            <McpManager />
          ) : (
            <SkillsManager
              readOnly={skillsReadOnly}
              onCreateByChat={onCreateSkillByChat}
              onUseSkill={onUseSkill}
            />
          )}
        </div>
      </div>
    </div>
  );
};

export default SkillsAndConnectorsView;
