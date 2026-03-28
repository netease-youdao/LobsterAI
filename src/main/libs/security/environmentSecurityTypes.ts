/**
 * Environment Security Types
 * Types for system-wide security scanning and permission management.
 */

// ─────────────────────────────────────────────────────────────────────────────
// System Permission Types
// ─────────────────────────────────────────────────────────────────────────────

export type SystemPermissionId =
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

export type PermissionStatus = 'granted' | 'denied' | 'not_determined' | 'restricted';

export interface SystemPermission {
  id: SystemPermissionId;
  name: string;
  description: string;
  category: 'data' | 'system' | 'privacy' | 'network';
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  status: PermissionStatus;
  enabled: boolean; // User toggle in settings
  lastChecked?: number;
  platform?: 'all' | 'darwin' | 'win32' | 'linux';
}

export interface PermissionToggleResult {
  success: boolean;
  permission: SystemPermissionId;
  newStatus: boolean;
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Environment Security Scan Types
// ─────────────────────────────────────────────────────────────────────────────

export type EnvironmentRiskLevel = 'secure' | 'low' | 'medium' | 'high' | 'critical';

export type EnvironmentScanCategory =
  | 'skills'
  | 'permissions'
  | 'system'
  | 'network'
  | 'credentials';

export type SecurityIssueSeverity = 'info' | 'warning' | 'danger' | 'critical';

export interface SecurityIssue {
  id: string;
  category: EnvironmentScanCategory;
  severity: SecurityIssueSeverity;
  title: string;
  description: string;
  recommendation?: string;
  affectedItems?: string[];
  detectedAt: number;
}

export interface SkillSecurityFinding {
  ruleId: string;
  dimension: string;
  severity: 'info' | 'warning' | 'danger' | 'critical';
  file: string;
  line?: number;
  matchedPattern: string;
  description: string;
}

export interface SkillSecuritySummary {
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

export interface EnvironmentSecurityReport {
  // Scan metadata
  scannedAt: number;
  scanDurationMs: number;
  
  // Overall assessment
  overallRiskLevel: EnvironmentRiskLevel;
  overallRiskScore: number; // 0-100
  
  // Detailed results
  permissions: {
    summary: {
      total: number;
      granted: number;
      denied: number;
      notDetermined: number;
    };
    items: SystemPermission[];
    issues: SecurityIssue[];
  };
  
  skills: {
    summary: {
      total: number;
      enabled: number;
      highRisk: number;
      criticalRisk: number;
    };
    items: SkillSecuritySummary[];
    issues: SecurityIssue[];
  };
  
  system: {
    issues: SecurityIssue[];
  };
  
  // All issues aggregated
  allIssues: SecurityIssue[];
  issuesBySeverity: {
    critical: number;
    danger: number;
    warning: number;
    info: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Security Settings Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SecuritySettings {
  // Permission toggles
  permissions: Record<SystemPermissionId, boolean>;
  
  // Auto-scan settings
  autoScanOnStartup: boolean;
  autoScanOnSkillInstall: boolean;
  
  // Notification settings
  notifyOnHighRisk: boolean;
  notifyOnNewIssue: boolean;
  
  // Last scan info
  lastScanAt?: number;
  lastScanRiskLevel?: EnvironmentRiskLevel;
}

export const DEFAULT_SECURITY_SETTINGS: SecuritySettings = {
  permissions: {
    file_system_read: true,
    file_system_write: true,
    shell_execution: true,
    network_access: true,
    clipboard_access: true,
    screen_capture: false,
    calendar_access: false,
    browser_control: false,
    process_management: true,
    system_settings: false,
  },
  autoScanOnStartup: false,
  autoScanOnSkillInstall: true,
  notifyOnHighRisk: true,
  notifyOnNewIssue: true,
};
