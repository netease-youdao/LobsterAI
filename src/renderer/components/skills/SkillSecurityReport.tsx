import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ShieldCheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import Modal from '../common/Modal';

interface SecurityFinding {
  dimension: string;
  severity: string;
  ruleId: string;
  file: string;
  line?: number;
  matchedPattern: string;
  description: string;
}

interface SkillSecurityReport {
  skillName: string;
  riskLevel: string;
  riskScore: number;
  findings: SecurityFinding[];
  dimensionSummary: Record<string, { count: number; maxSeverity: string }>;
  scanDurationMs: number;
}

interface SkillSecurityReportProps {
  report: SkillSecurityReport;
  onAction: (action: 'install' | 'installDisabled' | 'cancel') => void;
  isLoading?: boolean;
}

const DIMENSION_LABELS: Record<string, string> = {
  file_access: 'securityDimFileAccess',
  dangerous_command: 'securityDimDangerousCmd',
  network: 'securityDimNetwork',
  process: 'securityDimProcess',
  screen_input: 'securityDimScreenInput',
  payment: 'securityDimPayment',
  prompt_injection: 'securityDimPromptInjection',
  web_content: 'securityDimWebContent',
};

// Severity dots shifted down one level to reduce user alarm
const SEVERITY_DOTS: Record<string, string> = {
  info: 'bg-gray-400',
  warning: 'bg-blue-400',
  danger: 'bg-yellow-500',
  critical: 'bg-orange-500',
};

const SkillSecurityReport: React.FC<SkillSecurityReportProps> = ({
  report,
  onAction,
  isLoading,
}) => {
  const [expandedDimensions, setExpandedDimensions] = useState<Set<string>>(new Set());

  const toggleDimension = (dim: string) => {
    setExpandedDimensions(prev => {
      const next = new Set(prev);
      if (next.has(dim)) {
        next.delete(dim);
      } else {
        next.add(dim);
      }
      return next;
    });
  };

  // Filter out info-level findings (not shown to user)
  const visibleFindings = report.findings.filter(f => f.severity !== 'info');

  // Group findings by dimension and compute max severity per dimension
  const severityOrder = ['info', 'warning', 'danger', 'critical'];
  const findingsByDimension = new Map<string, SecurityFinding[]>();
  const dimensionMaxSeverity = new Map<string, string>();
  for (const finding of visibleFindings) {
    const existing = findingsByDimension.get(finding.dimension) || [];
    existing.push(finding);
    findingsByDimension.set(finding.dimension, existing);

    const current = dimensionMaxSeverity.get(finding.dimension) || 'info';
    if (severityOrder.indexOf(finding.severity) > severityOrder.indexOf(current)) {
      dimensionMaxSeverity.set(finding.dimension, finding.severity);
    }
  }

  return createPortal(
    <Modal onClose={() => onAction('cancel')} overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-black/60" className="w-full max-w-xl mx-4 rounded-2xl bg-surface shadow-xl border border-border overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2.5">
            <ShieldCheckIcon className="h-5 w-5 text-green-600 dark:text-green-400" />
            <h3 className="text-base font-semibold text-foreground">
              {i18nService.t('securityScanTitle')}
            </h3>
          </div>
          <button
            type="button"
            onClick={() => onAction('cancel')}
            className="p-1 rounded-lg hover:bg-surface-raised transition-colors"
          >
            <XMarkIcon className="h-4 w-4 text-secondary" />
          </button>
        </div>

        {/* Summary - outside scroll area */}
        <div className="px-5 pt-4 pb-3">
          <p className="text-sm text-secondary">
            {i18nService.t('securityIssuesFound').replace('{name}', report.skillName)}
          </p>
        </div>

        {/* Findings - scrollable area */}
        <div className="px-5 pb-4 max-h-[50vh] overflow-y-auto">
          <div className="space-y-1.5">
            {Array.from(findingsByDimension.entries()).map(([dimension, findings]) => {
              const isExpanded = expandedDimensions.has(dimension);
              const maxSeverity = dimensionMaxSeverity.get(dimension) || 'warning';
              const dimLabel = DIMENSION_LABELS[dimension];

              return (
                <div key={dimension} className="rounded-xlSecondary bg-backgroundSecondary overflow-hidden">
                  <button
                    type="button"
                    onClick={() => toggleDimension(dimension)}
                    className="w-full flex items-center justify-between px-3.5 py-2.5 hover:bg-surface-raised transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      {isExpanded ? (
                        <ChevronDownIcon className="h-3.5 w-3.5 text-secondary" />
                      ) : (
                        <ChevronRightIcon className="h-3.5 w-3.5 text-secondary" />
                      )}
                      <span className={`w-2 h-2 rounded-full ${SEVERITY_DOTS[maxSeverity] || SEVERITY_DOTS.warning}`} />
                      <span className="text-sm font-medium text-foreground">
                        {dimLabel ? i18nService.t(dimLabel) : dimension}
                      </span>
                    </div>
                    <span className="text-xs text-secondary">
                      {findings.length}
                    </span>
                  </button>

                  {isExpanded && (
                    <div className="px-3.5 pb-3 space-y-2">
                      {findings.map((finding, idx) => (
                        <div key={`${finding.ruleId}-${idx}`} className="pl-6 text-xs">
                          <div className="flex items-start gap-1.5">
                            <span className={`mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${SEVERITY_DOTS[finding.severity] || SEVERITY_DOTS.warning}`} />
                            <div>
                              <p className="text-foreground">
                                {i18nService.t(finding.description) || finding.description}
                              </p>
                              <p className="text-secondary mt-0.5">
                                {finding.file}{finding.line ? `:${finding.line}` : ''}
                              </p>
                              {finding.matchedPattern && (
                                <p className="mt-1 px-2 py-1 rounded bg-black/5 dark:bg-white/5 font-mono text-[10px] text-secondary break-all overflow-x-auto max-h-16">
                                  {finding.matchedPattern}
                                </p>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-border">
          <button
            type="button"
            onClick={() => onAction('cancel')}
            disabled={isLoading}
            className="px-4 py-2 text-sm font-medium rounded-xl text-foreground hover:bg-surface-raised transition-colors border border-border active:scale-[0.98] disabled:opacity-50"
          >
            {i18nService.t('cancel')}
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onAction('installDisabled')}
              disabled={isLoading}
              className="px-4 py-2 text-sm font-medium rounded-xl bg-primary hover:bg-primary-hover text-white transition-colors active:scale-[0.98] disabled:opacity-50"
            >
              {i18nService.t('securityInstallDisabled')}
            </button>
            <button
              type="button"
              onClick={() => onAction('install')}
              disabled={isLoading}
              className="px-4 py-2 text-sm font-medium rounded-xl bg-orange-500/10 text-orange-600 dark:text-orange-400 border border-orange-500/20 hover:bg-orange-500/20 transition-colors active:scale-[0.98] disabled:opacity-50"
            >
              {i18nService.t('securityInstallAnyway')}
            </button>
          </div>
        </div>
    </Modal>,
    document.body
  );
};

export default SkillSecurityReport;
