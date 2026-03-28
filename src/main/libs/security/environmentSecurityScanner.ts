/**
 * Environment Security Scanner
 * Scans the entire environment for security issues including skills, permissions, and system state.
 */

import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import {
  EnvironmentSecurityReport,
  EnvironmentRiskLevel,
  SecurityIssue,
  SecurityIssueSeverity,
  SystemPermission,
  SystemPermissionId,
  SkillSecuritySummary,
  SecuritySettings,
  DEFAULT_SECURITY_SETTINGS,
} from './environmentSecurityTypes';
import { scanSkillSecurity } from '../skillSecurity/skillSecurityScanner';
import { SkillSecurityReport, SecurityRiskLevel } from '../skillSecurity/skillSecurityTypes';

// ─────────────────────────────────────────────────────────────────────────────
// Permission Definitions
// ─────────────────────────────────────────────────────────────────────────────

const PERMISSION_DEFINITIONS: Omit<SystemPermission, 'status' | 'enabled' | 'lastChecked'>[] = [
  {
    id: 'file_system_read',
    name: 'securityPermFileRead',
    description: 'securityPermFileReadDesc',
    category: 'data',
    riskLevel: 'low',
    platform: 'all',
  },
  {
    id: 'file_system_write',
    name: 'securityPermFileWrite',
    description: 'securityPermFileWriteDesc',
    category: 'data',
    riskLevel: 'medium',
    platform: 'all',
  },
  {
    id: 'shell_execution',
    name: 'securityPermShell',
    description: 'securityPermShellDesc',
    category: 'system',
    riskLevel: 'high',
    platform: 'all',
  },
  {
    id: 'network_access',
    name: 'securityPermNetwork',
    description: 'securityPermNetworkDesc',
    category: 'network',
    riskLevel: 'medium',
    platform: 'all',
  },
  {
    id: 'clipboard_access',
    name: 'securityPermClipboard',
    description: 'securityPermClipboardDesc',
    category: 'privacy',
    riskLevel: 'medium',
    platform: 'all',
  },
  {
    id: 'screen_capture',
    name: 'securityPermScreen',
    description: 'securityPermScreenDesc',
    category: 'privacy',
    riskLevel: 'high',
    platform: 'all',
  },
  {
    id: 'calendar_access',
    name: 'securityPermCalendar',
    description: 'securityPermCalendarDesc',
    category: 'privacy',
    riskLevel: 'low',
    platform: 'darwin',
  },
  {
    id: 'browser_control',
    name: 'securityPermBrowser',
    description: 'securityPermBrowserDesc',
    category: 'system',
    riskLevel: 'high',
    platform: 'all',
  },
  {
    id: 'process_management',
    name: 'securityPermProcess',
    description: 'securityPermProcessDesc',
    category: 'system',
    riskLevel: 'high',
    platform: 'all',
  },
  {
    id: 'system_settings',
    name: 'securityPermSystem',
    description: 'securityPermSystemDesc',
    category: 'system',
    riskLevel: 'critical',
    platform: 'all',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Risk Score Calculation
// ─────────────────────────────────────────────────────────────────────────────

const SEVERITY_SCORES: Record<SecurityIssueSeverity, number> = {
  info: 1,
  warning: 5,
  danger: 15,
  critical: 30,
};

function calculateOverallRiskScore(issues: SecurityIssue[]): number {
  let score = 0;
  for (const issue of issues) {
    score += SEVERITY_SCORES[issue.severity];
  }
  return Math.min(score, 100);
}

function scoreToRiskLevel(score: number): EnvironmentRiskLevel {
  if (score === 0) return 'secure';
  if (score <= 10) return 'low';
  if (score <= 30) return 'medium';
  if (score <= 60) return 'high';
  return 'critical';
}

function skillRiskToEnvironmentRisk(level: SecurityRiskLevel): EnvironmentRiskLevel {
  const mapping: Record<SecurityRiskLevel, EnvironmentRiskLevel> = {
    safe: 'secure',
    low: 'low',
    medium: 'medium',
    high: 'high',
    critical: 'critical',
  };
  return mapping[level];
}

// ─────────────────────────────────────────────────────────────────────────────
// Permission Scanner
// ─────────────────────────────────────────────────────────────────────────────

export async function scanPermissions(
  settings: SecuritySettings
): Promise<{ permissions: SystemPermission[]; issues: SecurityIssue[] }> {
  const platform = process.platform;
  const permissions: SystemPermission[] = [];
  const issues: SecurityIssue[] = [];
  const now = Date.now();

  for (const def of PERMISSION_DEFINITIONS) {
    // Skip platform-specific permissions that don't apply
    if (def.platform !== 'all' && def.platform !== platform) {
      continue;
    }

    const enabled = settings.permissions[def.id] ?? true;
    const permission: SystemPermission = {
      ...def,
      status: 'granted', // Default to granted since we control via settings
      enabled,
      lastChecked: now,
    };

    permissions.push(permission);

    // Generate issues for high-risk permissions that are enabled
    if (enabled && (def.riskLevel === 'high' || def.riskLevel === 'critical')) {
      issues.push({
        id: `perm_${def.id}_enabled`,
        category: 'permissions',
        severity: def.riskLevel === 'critical' ? 'danger' : 'warning',
        title: `securityIssuePermEnabled`,
        description: `securityIssuePermEnabledDesc`,
        recommendation: `securityIssuePermEnabledRec`,
        affectedItems: [def.id],
        detectedAt: now,
      });
    }
  }

  return { permissions, issues };
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill Scanner
// ─────────────────────────────────────────────────────────────────────────────

export async function scanSkills(
  skillsDir: string,
  getSkillEnabled: (skillId: string) => boolean
): Promise<{ skills: SkillSecuritySummary[]; issues: SecurityIssue[] }> {
  const skills: SkillSecuritySummary[] = [];
  const issues: SecurityIssue[] = [];
  const now = Date.now();

  if (!fs.existsSync(skillsDir)) {
    return { skills, issues };
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return { skills, issues };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;

    const skillDir = path.join(skillsDir, entry.name);
    const skillMdPath = path.join(skillDir, 'SKILL.md');

    // Skip if no SKILL.md
    if (!fs.existsSync(skillMdPath)) continue;

    try {
      const report = await scanSkillSecurity(skillDir);
      const enabled = getSkillEnabled(entry.name);

      // Count findings by severity
      let criticalCount = 0;
      let dangerCount = 0;
      let warningCount = 0;

      for (const finding of report.findings) {
        if (finding.severity === 'critical') criticalCount++;
        else if (finding.severity === 'danger') dangerCount++;
        else if (finding.severity === 'warning') warningCount++;
      }

      const summary: SkillSecuritySummary = {
        skillId: entry.name,
        skillName: report.skillName,
        skillPath: skillDir,
        riskLevel: skillRiskToEnvironmentRisk(report.riskLevel),
        riskScore: report.riskScore,
        findingsCount: report.findings.length,
        criticalCount,
        dangerCount,
        warningCount,
        enabled,
        findings: report.findings.map((f) => ({
          ruleId: f.ruleId,
          dimension: f.dimension,
          severity: f.severity,
          file: f.file,
          line: f.line,
          matchedPattern: f.matchedPattern,
          description: f.description,
        })),
      };

      skills.push(summary);

      // Generate issues for high-risk enabled skills
      if (enabled && (report.riskLevel === 'high' || report.riskLevel === 'critical')) {
        issues.push({
          id: `skill_${entry.name}_high_risk`,
          category: 'skills',
          severity: report.riskLevel === 'critical' ? 'critical' : 'danger',
          title: 'securityIssueSkillHighRisk',
          description: 'securityIssueSkillHighRiskDesc',
          recommendation: 'securityIssueSkillHighRiskRec',
          affectedItems: [report.skillName],
          detectedAt: now,
        });
      }

      // Generate issues for critical findings
      if (criticalCount > 0 && enabled) {
        issues.push({
          id: `skill_${entry.name}_critical_findings`,
          category: 'skills',
          severity: 'critical',
          title: 'securityIssueSkillCritical',
          description: 'securityIssueSkillCriticalDesc',
          recommendation: 'securityIssueSkillCriticalRec',
          affectedItems: [`${report.skillName}: ${criticalCount} critical findings`],
          detectedAt: now,
        });
      }
    } catch (err) {
      console.warn(`[SecurityScanner] Failed to scan skill ${entry.name}:`, err);
    }
  }

  return { skills, issues };
}

// ─────────────────────────────────────────────────────────────────────────────
// System Scanner
// ─────────────────────────────────────────────────────────────────────────────

export async function scanSystem(): Promise<{ issues: SecurityIssue[] }> {
  const issues: SecurityIssue[] = [];
  const now = Date.now();
  const platform = process.platform;
  const homeDir = os.homedir();

  // Check for common sensitive file exposures
  const sensitiveFiles = [
    { path: path.join(homeDir, '.ssh', 'id_rsa'), name: 'SSH Private Key' },
    { path: path.join(homeDir, '.aws', 'credentials'), name: 'AWS Credentials' },
    { path: path.join(homeDir, '.env'), name: 'Environment Variables' },
  ];

  for (const file of sensitiveFiles) {
    try {
      const stats = fs.statSync(file.path);
      if (stats.isFile()) {
        // Check file permissions on Unix
        if (platform !== 'win32') {
          const mode = stats.mode;
          const isWorldReadable = (mode & 0o004) !== 0;
          if (isWorldReadable) {
            issues.push({
              id: `system_sensitive_${path.basename(file.path)}`,
              category: 'credentials',
              severity: 'warning',
              title: 'securityIssueSensitiveFile',
              description: 'securityIssueSensitiveFileDesc',
              recommendation: 'securityIssueSensitiveFileRec',
              affectedItems: [file.name],
              detectedAt: now,
            });
          }
        }
      }
    } catch {
      // File doesn't exist, which is fine
    }
  }

  // Check if running with elevated privileges
  if (platform !== 'win32' && process.getuid && process.getuid() === 0) {
    issues.push({
      id: 'system_root_privilege',
      category: 'system',
      severity: 'danger',
      title: 'securityIssueRootPrivilege',
      description: 'securityIssueRootPrivilegeDesc',
      recommendation: 'securityIssueRootPrivilegeRec',
      detectedAt: now,
    });
  }

  return { issues };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Scanner
// ─────────────────────────────────────────────────────────────────────────────

export interface ScanOptions {
  settings: SecuritySettings;
  skillsDir: string;
  getSkillEnabled: (skillId: string) => boolean;
}

export async function scanEnvironmentSecurity(
  options: ScanOptions
): Promise<EnvironmentSecurityReport> {
  const startTime = Date.now();
  const allIssues: SecurityIssue[] = [];

  // Scan permissions
  const { permissions, issues: permissionIssues } = await scanPermissions(options.settings);
  allIssues.push(...permissionIssues);

  // Scan skills
  const { skills, issues: skillIssues } = await scanSkills(
    options.skillsDir,
    options.getSkillEnabled
  );
  allIssues.push(...skillIssues);

  // Scan system
  const { issues: systemIssues } = await scanSystem();
  allIssues.push(...systemIssues);

  // Calculate summary stats
  const permissionSummary = {
    total: permissions.length,
    granted: permissions.filter((p) => p.status === 'granted' && p.enabled).length,
    denied: permissions.filter((p) => !p.enabled).length,
    notDetermined: permissions.filter((p) => p.status === 'not_determined').length,
  };

  const skillSummary = {
    total: skills.length,
    enabled: skills.filter((s) => s.enabled).length,
    highRisk: skills.filter((s) => s.riskLevel === 'high').length,
    criticalRisk: skills.filter((s) => s.riskLevel === 'critical').length,
  };

  const issuesBySeverity = {
    critical: allIssues.filter((i) => i.severity === 'critical').length,
    danger: allIssues.filter((i) => i.severity === 'danger').length,
    warning: allIssues.filter((i) => i.severity === 'warning').length,
    info: allIssues.filter((i) => i.severity === 'info').length,
  };

  const overallRiskScore = calculateOverallRiskScore(allIssues);

  return {
    scannedAt: Date.now(),
    scanDurationMs: Date.now() - startTime,
    overallRiskLevel: scoreToRiskLevel(overallRiskScore),
    overallRiskScore,
    permissions: {
      summary: permissionSummary,
      items: permissions,
      issues: permissionIssues,
    },
    skills: {
      summary: skillSummary,
      items: skills,
      issues: skillIssues,
    },
    system: {
      issues: systemIssues,
    },
    allIssues,
    issuesBySeverity,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings Management
// ─────────────────────────────────────────────────────────────────────────────

export function getDefaultSecuritySettings(): SecuritySettings {
  return { ...DEFAULT_SECURITY_SETTINGS };
}

export function validateSecuritySettings(settings: unknown): SecuritySettings {
  if (!settings || typeof settings !== 'object') {
    return getDefaultSecuritySettings();
  }

  const s = settings as Partial<SecuritySettings>;
  const defaults = getDefaultSecuritySettings();

  return {
    permissions: {
      ...defaults.permissions,
      ...(s.permissions || {}),
    },
    autoScanOnStartup: s.autoScanOnStartup ?? defaults.autoScanOnStartup,
    autoScanOnSkillInstall: s.autoScanOnSkillInstall ?? defaults.autoScanOnSkillInstall,
    notifyOnHighRisk: s.notifyOnHighRisk ?? defaults.notifyOnHighRisk,
    notifyOnNewIssue: s.notifyOnNewIssue ?? defaults.notifyOnNewIssue,
    lastScanAt: s.lastScanAt,
    lastScanRiskLevel: s.lastScanRiskLevel,
  };
}
