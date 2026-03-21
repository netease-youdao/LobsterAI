export type SecurityRiskLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical';

export type SecurityDimension =
  | 'file_access'
  | 'dangerous_command'
  | 'network'
  | 'process'
  | 'screen_input'
  | 'payment'
  | 'prompt_injection'
  | 'web_content';

export type FindingSeverity = 'info' | 'warning' | 'danger' | 'critical';

export interface SecurityFinding {
  dimension: SecurityDimension;
  severity: FindingSeverity;
  ruleId: string;
  file: string;
  line?: number;
  matchedPattern: string;
  description: string;
}

export interface SkillSecurityReport {
  scannedAt: number;
  skillName: string;
  riskLevel: SecurityRiskLevel;
  riskScore: number;
  findings: SecurityFinding[];
  dimensionSummary: Partial<Record<SecurityDimension, { count: number; maxSeverity: FindingSeverity }>>;
  scanDurationMs: number;
}

export type SecurityReportAction = 'install' | 'installDisabled' | 'cancel';

export interface SecurityRule {
  id: string;
  dimension: SecurityDimension;
  severity: FindingSeverity;
  filePatterns: string[];
  patterns: RegExp[];
  description: string;
}
