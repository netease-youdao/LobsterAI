/**
 * Security Settings Component
 * Provides UI for security scanning, permission management, and security settings.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  ShieldCheckIcon,
  ShieldExclamationIcon,
  ExclamationTriangleIcon,
  CheckCircleIcon,
  ArrowPathIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  InformationCircleIcon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';

// ─────────────────────────────────────────────────────────────────────────────
// Types (matching electron.d.ts)
// ─────────────────────────────────────────────────────────────────────────────

type SystemPermissionId =
  | 'file_system_read'
  | 'file_system_write'
  | 'shell_execution'
  | 'network_access'
  | 'clipboard_access'
  | 'screen_capture'
  | 'calendar_access'
  | 'browser_control'
  | 'process_management'
  | 'system_settings';

type EnvironmentRiskLevel = 'secure' | 'low' | 'medium' | 'high' | 'critical';

interface SystemPermission {
  id: SystemPermissionId;
  name: string;
  description: string;
  category: 'data' | 'system' | 'privacy' | 'network';
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  enabled: boolean;
}

interface SecuritySettings {
  permissions: Record<SystemPermissionId, boolean>;
  autoScanOnStartup: boolean;
  autoScanOnSkillInstall: boolean;
  notifyOnHighRisk: boolean;
  notifyOnNewIssue: boolean;
  lastScanAt?: number;
  lastScanRiskLevel?: EnvironmentRiskLevel;
}

interface SkillSecurityFinding {
  ruleId: string;
  dimension: string;
  severity: 'info' | 'warning' | 'danger' | 'critical';
  file: string;
  line?: number;
  matchedPattern: string;
  description: string;
}

interface SkillSecuritySummary {
  skillId: string;
  skillName: string;
  skillPath: string;
  riskLevel: EnvironmentRiskLevel;
  riskScore: number;
  findingsCount: number;
  criticalCount: number;
  dangerCount: number;
  warningCount: number;
  enabled: boolean;
  findings: SkillSecurityFinding[];
}

interface EnvironmentSecurityReport {
  scannedAt: number;
  scanDurationMs: number;
  overallRiskLevel: EnvironmentRiskLevel;
  overallRiskScore: number;
  permissions: {
    summary: { total: number; granted: number; denied: number };
    items: SystemPermission[];
  };
  skills: {
    summary: { total: number; enabled: number; highRisk: number; criticalRisk: number };
    items: SkillSecuritySummary[];
  };
  allIssues: Array<{
    id: string;
    severity: string;
    title: string;
    description: string;
    recommendation?: string;
  }>;
  issuesBySeverity: {
    critical: number;
    danger: number;
    warning: number;
    info: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Risk Level Badge Component
// ─────────────────────────────────────────────────────────────────────────────

const RiskLevelBadge: React.FC<{ level: EnvironmentRiskLevel; size?: 'sm' | 'md' | 'lg'; friendly?: boolean }> = ({
  level,
  size = 'md',
  friendly = false,
}) => {
  // 友好模式：使用更温和的颜色和标签
  const friendlyConfig = {
    secure: {
      bg: 'bg-green-100 dark:bg-green-900/30',
      text: 'text-green-700 dark:text-green-400',
      icon: CheckCircleIcon,
      label: 'securityStatusSecure',
    },
    low: {
      bg: 'bg-blue-100 dark:bg-blue-900/30',
      text: 'text-blue-700 dark:text-blue-400',
      icon: InformationCircleIcon,
      label: 'securityStatusLowNotice',
    },
    medium: {
      bg: 'bg-blue-100 dark:bg-blue-900/30',
      text: 'text-blue-700 dark:text-blue-400',
      icon: InformationCircleIcon,
      label: 'securityStatusMediumNotice',
    },
    high: {
      bg: 'bg-amber-100 dark:bg-amber-900/30',
      text: 'text-amber-700 dark:text-amber-400',
      icon: InformationCircleIcon,
      label: 'securityStatusHighNotice',
    },
    critical: {
      bg: 'bg-amber-100 dark:bg-amber-900/30',
      text: 'text-amber-700 dark:text-amber-400',
      icon: ExclamationTriangleIcon,
      label: 'securityStatusCriticalNotice',
    },
  };

  // 原始模式：保留警告风格
  const originalConfig = {
    secure: {
      bg: 'bg-green-100 dark:bg-green-900/30',
      text: 'text-green-700 dark:text-green-400',
      icon: CheckCircleIcon,
      label: 'securityRiskSecure',
    },
    low: {
      bg: 'bg-blue-100 dark:bg-blue-900/30',
      text: 'text-blue-700 dark:text-blue-400',
      icon: ShieldCheckIcon,
      label: 'securityRiskLow',
    },
    medium: {
      bg: 'bg-yellow-100 dark:bg-yellow-900/30',
      text: 'text-yellow-700 dark:text-yellow-400',
      icon: ExclamationTriangleIcon,
      label: 'securityRiskMedium',
    },
    high: {
      bg: 'bg-orange-100 dark:bg-orange-900/30',
      text: 'text-orange-700 dark:text-orange-400',
      icon: ShieldExclamationIcon,
      label: 'securityRiskHigh',
    },
    critical: {
      bg: 'bg-red-100 dark:bg-red-900/30',
      text: 'text-red-700 dark:text-red-400',
      icon: ShieldExclamationIcon,
      label: 'securityRiskCritical',
    },
  };

  const config = (friendly ? friendlyConfig : originalConfig)[level];

  const sizeClasses = {
    sm: 'px-2 py-0.5 text-xs',
    md: 'px-3 py-1 text-sm',
    lg: 'px-4 py-1.5 text-base',
  }[size];

  const Icon = config.icon;

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full font-medium ${config.bg} ${config.text} ${sizeClasses}`}>
      <Icon className={size === 'sm' ? 'h-3 w-3' : 'h-4 w-4'} />
      {i18nService.t(config.label)}
    </span>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Permission Toggle Component
// ─────────────────────────────────────────────────────────────────────────────

const PermissionToggle: React.FC<{
  permission: SystemPermission;
  onToggle: (id: SystemPermissionId, enabled: boolean) => void;
}> = ({ permission, onToggle }) => {
  const riskColors = {
    low: 'text-green-600 dark:text-green-400',
    medium: 'text-yellow-600 dark:text-yellow-400',
    high: 'text-orange-600 dark:text-orange-400',
    critical: 'text-red-600 dark:text-red-400',
  };

  return (
    <div className="flex items-center justify-between py-3 border-b dark:border-claude-darkBorder border-claude-border last:border-b-0">
      <div className="flex-1 min-w-0 pr-4">
        <div className="flex items-center gap-2">
          <span className="font-medium dark:text-claude-darkText text-claude-text">
            {i18nService.t(permission.name)}
          </span>
          <span className={`text-xs ${riskColors[permission.riskLevel]}`}>
            {permission.riskLevel === 'critical' ? '⚠️' : permission.riskLevel === 'high' ? '⚡' : ''}
          </span>
        </div>
        <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary mt-0.5">
          {i18nService.t(permission.description)}
        </p>
      </div>
      <button
        type="button"
        onClick={() => onToggle(permission.id, !permission.enabled)}
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
          permission.enabled
            ? 'bg-claude-accent'
            : 'bg-gray-300 dark:bg-gray-600'
        }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
            permission.enabled ? 'translate-x-6' : 'translate-x-1'
          }`}
        />
      </button>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Main Security Settings Component
// ─────────────────────────────────────────────────────────────────────────────

const SecuritySettings: React.FC = () => {
  const [settings, setSettings] = useState<SecuritySettings | null>(null);
  const [report, setReport] = useState<EnvironmentSecurityReport | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['permissions']));
  const [error, setError] = useState<string | null>(null);

  // Load settings on mount
  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const result = await window.electron.security.getSettings();
      if (result.success && result.settings) {
        setSettings(result.settings);
      }
    } catch (err) {
      console.error('Failed to load security settings:', err);
      setError('Failed to load settings');
    }
  };

  const runScan = useCallback(async () => {
    setIsScanning(true);
    setError(null);
    try {
      const result = await window.electron.security.scan();
      if (result.success && result.report) {
        setReport(result.report);
        // Reload settings to get updated lastScanAt
        await loadSettings();
      } else {
        setError(result.error || 'Scan failed');
      }
    } catch (err) {
      console.error('Security scan failed:', err);
      setError('Scan failed');
    } finally {
      setIsScanning(false);
    }
  }, []);

  const handlePermissionToggle = useCallback(async (permissionId: SystemPermissionId, enabled: boolean) => {
    try {
      const result = await window.electron.security.togglePermission(permissionId, enabled);
      if (result.success) {
        setSettings((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            permissions: {
              ...prev.permissions,
              [permissionId]: enabled,
            },
          };
        });
      }
    } catch (err) {
      console.error('Failed to toggle permission:', err);
    }
  }, []);

  const handleSettingToggle = useCallback(async (key: keyof SecuritySettings, value: boolean) => {
    if (!settings) return;
    
    const newSettings = { ...settings, [key]: value };
    try {
      const result = await window.electron.security.setSettings(newSettings);
      if (result.success && result.settings) {
        setSettings(result.settings);
      }
    } catch (err) {
      console.error('Failed to update settings:', err);
    }
  }, [settings]);

  const toggleSection = useCallback((section: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
  }, []);

  // Handle skill enable/disable toggle
  const handleSkillToggle = useCallback(async (skillId: string, enabled: boolean) => {
    try {
      const result = await window.electron.skills.setEnabled({ id: skillId, enabled });
      if (result.success) {
        // Re-scan to update the report
        runScan();
      } else {
        setError(result.error || 'Failed to toggle skill');
      }
    } catch (err) {
      console.error('Failed to toggle skill:', err);
      setError('Failed to toggle skill');
    }
  }, [runScan]);

  // Handle skill uninstall (using delete API)
  const handleSkillUninstall = useCallback(async (skillId: string, skillName: string) => {
    const confirmed = window.confirm(
      i18nService.t('securityUninstallConfirm').replace('{name}', skillName)
    );
    if (!confirmed) return;

    try {
      const result = await window.electron.skills.delete(skillId);
      if (result.success) {
        // Re-scan to update the report
        runScan();
      } else {
        setError(result.error || 'Failed to uninstall skill');
      }
    } catch (err) {
      console.error('Failed to uninstall skill:', err);
      setError('Failed to uninstall skill');
    }
  }, [runScan]);

  const formatLastScan = (timestamp?: number) => {
    if (!timestamp) return i18nService.t('securityNeverScanned');
    const date = new Date(timestamp);
    return date.toLocaleString();
  };

  // Build permissions list for display
  const permissionsList: SystemPermission[] = settings
    ? [
        { id: 'file_system_read', name: 'securityPermFileRead', description: 'securityPermFileReadDesc', category: 'data', riskLevel: 'low', enabled: settings.permissions.file_system_read },
        { id: 'file_system_write', name: 'securityPermFileWrite', description: 'securityPermFileWriteDesc', category: 'data', riskLevel: 'medium', enabled: settings.permissions.file_system_write },
        { id: 'shell_execution', name: 'securityPermShell', description: 'securityPermShellDesc', category: 'system', riskLevel: 'high', enabled: settings.permissions.shell_execution },
        { id: 'network_access', name: 'securityPermNetwork', description: 'securityPermNetworkDesc', category: 'network', riskLevel: 'medium', enabled: settings.permissions.network_access },
        { id: 'clipboard_access', name: 'securityPermClipboard', description: 'securityPermClipboardDesc', category: 'privacy', riskLevel: 'medium', enabled: settings.permissions.clipboard_access },
        { id: 'screen_capture', name: 'securityPermScreen', description: 'securityPermScreenDesc', category: 'privacy', riskLevel: 'high', enabled: settings.permissions.screen_capture },
        { id: 'browser_control', name: 'securityPermBrowser', description: 'securityPermBrowserDesc', category: 'system', riskLevel: 'high', enabled: settings.permissions.browser_control },
        { id: 'process_management', name: 'securityPermProcess', description: 'securityPermProcessDesc', category: 'system', riskLevel: 'high', enabled: settings.permissions.process_management },
        { id: 'system_settings', name: 'securityPermSystem', description: 'securityPermSystemDesc', category: 'system', riskLevel: 'critical', enabled: settings.permissions.system_settings },
      ]
    : [];

  // Group permissions by category
  const permissionsByCategory = permissionsList.reduce((acc, perm) => {
    if (!acc[perm.category]) acc[perm.category] = [];
    acc[perm.category].push(perm);
    return acc;
  }, {} as Record<string, SystemPermission[]>);

  const categoryLabels: Record<string, string> = {
    data: 'securityCategoryData',
    system: 'securityCategorySystem',
    privacy: 'securityCategoryPrivacy',
    network: 'securityCategoryNetwork',
  };

  if (!settings) {
    return (
      <div className="flex items-center justify-center h-64">
        <ArrowPathIcon className="h-8 w-8 animate-spin text-claude-accent" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header with Scan Button */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
            {i18nService.t('securitySettings')}
          </h2>
          <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary mt-1">
            {i18nService.t('securityLastScan')}: {formatLastScan(settings.lastScanAt)}
          </p>
        </div>
        <button
          type="button"
          onClick={runScan}
          disabled={isScanning}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-claude-accent text-white hover:bg-claude-accentHover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <ArrowPathIcon className={`h-4 w-4 ${isScanning ? 'animate-spin' : ''}`} />
          {isScanning ? i18nService.t('securityScanning') : i18nService.t('securityScanNow')}
        </button>
      </div>

      {/* Error Message */}
      {error && (
        <div className="p-3 rounded-lg bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* Scan Results */}
      {report && (
        <div className="rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-white overflow-hidden">
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (report.allIssues.length > 0) {
                toggleSection('scanResults');
              }
            }}
            className={`w-full p-4 text-left ${report.allIssues.length > 0 ? 'cursor-pointer hover:bg-gray-50 dark:hover:bg-claude-darkSurfaceHover' : 'cursor-default'} transition-colors`}
          >
            <div className="flex items-center justify-between mb-4">
              <span className="font-medium dark:text-claude-darkText text-claude-text">
                {i18nService.t('securitySkillBehaviorTitle')}
              </span>
            </div>
            
            {/* Data Leak Summary - 只统计数据泄露风险 */}
            {(() => {
              const dataLeakDimensions = ['file_access', 'network', 'credentials', 'screen_input'];
              const skillsWithDataLeakRisk = report.skills?.items?.filter((skill) =>
                skill.findings.some((f) => dataLeakDimensions.includes(f.dimension) && f.severity !== 'info')
              ) || [];
              
              return skillsWithDataLeakRisk.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService.t('securitySkillsWithDataLeakRisk').replace('{count}', String(skillsWithDataLeakRisk.length))}
                  </p>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
                      <InformationCircleIcon className="h-4 w-4" />
                      <span>{i18nService.t('securityClickToReviewDataLeak')}</span>
                    </div>
                    <div className="flex items-center gap-1 text-xs text-claude-accent">
                      <span>{i18nService.t('securityViewDetails')}</span>
                      {expandedSections.has('scanResults') ? (
                        <ChevronDownIcon className="h-4 w-4" />
                      ) : (
                        <ChevronRightIcon className="h-4 w-4" />
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-green-600 dark:text-green-400">
                  ✓ {i18nService.t('securityNoDataLeakRisk')}
                </p>
              );
            })()}
          </button>
          
          {/* Expanded Issue Details - Show by Skill (Friendly Mode) */}
          {expandedSections.has('scanResults') && report.skills?.items && (
            <div className="border-t dark:border-claude-darkBorder border-claude-border">
              {/* Friendly notice header */}
              <div className="px-4 py-3 bg-blue-50 dark:bg-blue-900/20 border-b dark:border-claude-darkBorder border-claude-border">
                <div className="flex items-center gap-2 text-sm text-blue-700 dark:text-blue-400">
                  <InformationCircleIcon className="h-4 w-4 flex-shrink-0" />
                  <span>{i18nService.t('securitySkillBehaviorNoticeHeader')}</span>
                </div>
              </div>
              <div className="max-h-96 overflow-y-auto">
                {/* Skills with data leak risks - 只显示有数据泄露风险的技能 */}
                {(() => {
                  const dataLeakDimensions = ['file_access', 'network', 'credentials', 'screen_input'];
                  return report.skills.items
                    .filter((skill) => skill.findings.some(
                      (f) => dataLeakDimensions.includes(f.dimension) && f.severity !== 'info'
                    ))
                    .sort((a, b) => b.riskScore - a.riskScore)
                    .map((skill) => {
                      // 使用统一的浅灰蓝色调
                      const noticeConfig = {
                        bg: 'bg-gray-50 dark:bg-gray-800/30',
                        headerBg: 'bg-gray-100 dark:bg-gray-800/50',
                      };
                    const isSkillExpanded = expandedSections.has(`skill_${skill.skillId}`);
                    
                    return (
                      <div key={skill.skillId} className="border-b last:border-b-0 dark:border-claude-darkBorder border-claude-border">
                        {/* Skill Header */}
                        <div className={`p-4 ${noticeConfig.headerBg}`}>
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-3">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  toggleSection(`skill_${skill.skillId}`);
                                }}
                                className="flex items-center gap-2"
                              >
                                {isSkillExpanded ? (
                                  <ChevronDownIcon className="h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                                ) : (
                                  <ChevronRightIcon className="h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                                )}
                                <span className="font-medium dark:text-claude-darkText text-claude-text">
                                  {skill.skillName}
                                </span>
                              </button>
                              <RiskLevelBadge level={skill.riskLevel} size="sm" friendly />
                              {!skill.enabled && (
                                <span className="text-xs px-2 py-0.5 rounded bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400">
                                  {i18nService.t('disabled')}
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              {/* Disable/Enable Button */}
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  handleSkillToggle(skill.skillId, !skill.enabled);
                                }}
                                className={`px-3 py-1 text-xs rounded-lg transition-colors ${
                                  skill.enabled
                                    ? 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                                    : 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 hover:bg-green-200 dark:hover:bg-green-900/50'
                                }`}
                              >
                                {skill.enabled ? i18nService.t('securityDisableSkill') : i18nService.t('securityEnableSkill')}
                              </button>
                              {/* Uninstall Button - 使用更温和的样式 */}
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  handleSkillUninstall(skill.skillId, skill.skillName);
                                }}
                                className="px-3 py-1 text-xs rounded-lg bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-900/50 transition-colors"
                              >
                                {i18nService.t('securityUninstallSkill')}
                              </button>
                            </div>
                          </div>
                          {/* 数据泄露风险提示 - 只显示相关的 findings */}
                          {(() => {
                            // 只筛选与数据泄露相关的 findings
                            const dataLeakDimensions = ['file_access', 'network', 'credentials', 'screen_input'];
                            const dataLeakFindings = skill.findings.filter(
                              (f) => dataLeakDimensions.includes(f.dimension) && f.severity !== 'info'
                            );
                            const dataLeakCount = dataLeakFindings.length;
                            
                            return dataLeakCount > 0 ? (
                              <>
                                <div className="flex gap-3 text-xs ml-6 text-gray-600 dark:text-gray-400">
                                  <span className="flex items-center gap-1">
                                    <InformationCircleIcon className="h-3.5 w-3.5" />
                                    {i18nService.t('securityDataLeakNotice').replace('{count}', String(dataLeakCount))}
                                  </span>
                                </div>
                              </>
                            ) : (
                              <div className="flex gap-3 text-xs ml-6 text-green-600 dark:text-green-400">
                                <span>✓ {i18nService.t('securityNoDataLeakRisk')}</span>
                              </div>
                            );
                          })()}
                        </div>
                        
                        {/* Skill Findings Detail - 只显示数据泄露相关 */}
                        {isSkillExpanded && (() => {
                          const dataLeakDimensions = ['file_access', 'network', 'credentials', 'screen_input'];
                          const dataLeakFindings = skill.findings.filter(
                            (f) => dataLeakDimensions.includes(f.dimension) && f.severity !== 'info'
                          );
                          
                          return dataLeakFindings.length > 0 && (
                            <div className={`${noticeConfig.bg} px-4 py-3`}>
                              <div className="space-y-2 ml-6">
                                {dataLeakFindings.map((finding, idx) => {
                                  return (
                                    <div key={`${finding.ruleId}-${idx}`} className="flex items-start gap-2 text-xs">
                                      <span className="mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0 bg-blue-400 dark:bg-blue-500" />
                                      <div className="flex-1 min-w-0">
                                        <span className="text-gray-700 dark:text-gray-300">
                                          {i18nService.t(finding.description) || finding.description}
                                        </span>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    );
                  });
                })()}
                
                {/* No data leak risk message */}
                {(() => {
                  const dataLeakDimensions = ['file_access', 'network', 'credentials', 'screen_input'];
                  const hasDataLeakRisk = report.skills.items.some((skill) =>
                    skill.findings.some((f) => dataLeakDimensions.includes(f.dimension) && f.severity !== 'info')
                  );
                  return !hasDataLeakRisk && (
                    <div className="p-4 text-center">
                      <p className="text-sm text-green-600 dark:text-green-400">
                        ✓ {i18nService.t('securityNoDataLeakRisk')}
                      </p>
                    </div>
                  );
                })()}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Permissions Section */}
      <div className="rounded-xl border dark:border-claude-darkBorder border-claude-border overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('permissions')}
          className="w-full flex items-center justify-between p-4 dark:bg-claude-darkSurface bg-white hover:bg-gray-50 dark:hover:bg-claude-darkSurfaceHover transition-colors"
        >
          <div className="flex items-center gap-3">
            <ShieldCheckIcon className="h-5 w-5 text-claude-accent" />
            <div className="text-left">
              <span className="font-medium dark:text-claude-darkText text-claude-text">
                {i18nService.t('securityPermissions')}
              </span>
              <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('securityPermissionsDesc')}
              </p>
            </div>
          </div>
          {expandedSections.has('permissions') ? (
            <ChevronDownIcon className="h-5 w-5 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
          ) : (
            <ChevronRightIcon className="h-5 w-5 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
          )}
        </button>
        
        {expandedSections.has('permissions') && (
          <div className="p-4 border-t dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurfaceMuted bg-gray-50">
            {Object.entries(permissionsByCategory).map(([category, perms]) => (
              <div key={category} className="mb-4 last:mb-0">
                <h4 className="text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-2">
                  {i18nService.t(categoryLabels[category] || category)}
                </h4>
                <div className="rounded-lg dark:bg-claude-darkSurface bg-white border dark:border-claude-darkBorder border-claude-border px-4">
                  {perms.map((perm) => (
                    <PermissionToggle
                      key={perm.id}
                      permission={perm}
                      onToggle={handlePermissionToggle}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Auto Scan Settings */}
      <div className="rounded-xl border dark:border-claude-darkBorder border-claude-border overflow-hidden">
        <button
          type="button"
          onClick={() => toggleSection('autoScan')}
          className="w-full flex items-center justify-between p-4 dark:bg-claude-darkSurface bg-white hover:bg-gray-50 dark:hover:bg-claude-darkSurfaceHover transition-colors"
        >
          <div className="flex items-center gap-3">
            <ArrowPathIcon className="h-5 w-5 text-claude-accent" />
            <span className="font-medium dark:text-claude-darkText text-claude-text">
              {i18nService.t('securityAutoScan')}
            </span>
          </div>
          {expandedSections.has('autoScan') ? (
            <ChevronDownIcon className="h-5 w-5 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
          ) : (
            <ChevronRightIcon className="h-5 w-5 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
          )}
        </button>
        
        {expandedSections.has('autoScan') && (
          <div className="p-4 border-t dark:border-claude-darkBorder border-claude-border space-y-3">
            <label className="flex items-center justify-between">
              <span className="dark:text-claude-darkText text-claude-text">
                {i18nService.t('securityAutoScanStartup')}
              </span>
              <button
                type="button"
                onClick={() => handleSettingToggle('autoScanOnStartup', !settings.autoScanOnStartup)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  settings.autoScanOnStartup ? 'bg-claude-accent' : 'bg-gray-300 dark:bg-gray-600'
                }`}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  settings.autoScanOnStartup ? 'translate-x-6' : 'translate-x-1'
                }`} />
              </button>
            </label>
            <label className="flex items-center justify-between">
              <span className="dark:text-claude-darkText text-claude-text">
                {i18nService.t('securityAutoScanSkillInstall')}
              </span>
              <button
                type="button"
                onClick={() => handleSettingToggle('autoScanOnSkillInstall', !settings.autoScanOnSkillInstall)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  settings.autoScanOnSkillInstall ? 'bg-claude-accent' : 'bg-gray-300 dark:bg-gray-600'
                }`}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  settings.autoScanOnSkillInstall ? 'translate-x-6' : 'translate-x-1'
                }`} />
              </button>
            </label>
          </div>
        )}
      </div>
    </div>
  );
};

export default SecuritySettings;
