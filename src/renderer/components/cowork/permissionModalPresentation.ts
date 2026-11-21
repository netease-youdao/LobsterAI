// Pure presentation mapper turning raw tool approval requests (including DSH
// `approval/request` payloads) into plain-language, non-technical confirmation
// copy suitable for everyday users.

import { isDeleteCommand } from '../../../common/deleteCommand';
import { DshPermissionPreset } from '../../../shared/dshEngine/hostConstants';

export type ApprovalDangerLevel = 'safe' | 'caution' | 'destructive';

export interface PermissionModalPresentation {
  title: string;
  summary: string;
  modelNote: string;
  targetLabel: string;
  targetValue: string;
  command: string;
  dangerLevel: ApprovalDangerLevel;
  dangerReasonText: string;
  approvalScopeKey: string;
  canAllowForSession: boolean;
  canSwitchFullAccess: boolean;
  technicalDetails: string;
}

const SHELL_TOOL_NAMES = new Set(['bash', 'pwsh', 'shell', 'exec', 'terminal_exec']);
const FILE_MUTATION_TOOL_NAMES = new Set(['write', 'edit', 'apply_patch', 'delete_file', 'move_file']);

const DANGER_REASON_I18N_MAP: Record<string, string> = {
  'recursive-delete': 'dangerReasonRecursiveDelete',
  'git-force-push': 'dangerReasonGitForcePush',
  'git-reset-hard': 'dangerReasonGitResetHard',
  'disk-overwrite': 'dangerReasonDiskOverwrite',
  'disk-format': 'dangerReasonDiskFormat',
  'file-delete': 'dangerReasonFileDelete',
  'git-push': 'dangerReasonGitPush',
  'process-kill': 'dangerReasonProcessKill',
  'permission-change': 'dangerReasonPermissionChange',
};

const TITLE_KEY_BY_DANGER_REASON: Record<string, string> = {
  'git-push': 'coworkApprovalTitleGitPush',
  'git-force-push': 'coworkApprovalTitleGitForcePush',
  'git-reset-hard': 'coworkApprovalTitleGitResetHard',
  'file-delete': 'coworkApprovalTitleFileDelete',
  'recursive-delete': 'coworkApprovalTitleRecursiveDelete',
  'process-kill': 'coworkApprovalTitleProcessKill',
  'permission-change': 'coworkApprovalTitlePermissionChange',
  'disk-overwrite': 'coworkApprovalTitleDiskOp',
  'disk-format': 'coworkApprovalTitleDiskOp',
};

const SUMMARY_KEY_BY_DANGER_REASON: Record<string, string> = {
  'git-push': 'coworkApprovalSummaryGitPush',
  'git-force-push': 'coworkApprovalSummaryGitForcePush',
  'git-reset-hard': 'coworkApprovalSummaryGitResetHard',
  'file-delete': 'coworkApprovalSummaryFileDelete',
  'recursive-delete': 'coworkApprovalSummaryRecursiveDelete',
  'process-kill': 'coworkApprovalSummaryProcessKill',
  'permission-change': 'coworkApprovalSummaryPermissionChange',
  'disk-overwrite': 'coworkApprovalSummaryDiskOp',
  'disk-format': 'coworkApprovalSummaryDiskOp',
};

export function detectDangerFromCommand(command: string): {
  level: ApprovalDangerLevel;
  reason: string;
} {
  if (/\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f?|--recursive)\b/i.test(command)) {
    return { level: 'destructive', reason: 'recursive-delete' };
  }
  if (/\bgit\s+push\s+.*(?:--force|-f)\b/i.test(command)) {
    return { level: 'destructive', reason: 'git-force-push' };
  }
  if (/\bgit\s+reset\s+--hard\b/i.test(command)) {
    return { level: 'destructive', reason: 'git-reset-hard' };
  }
  if (/\bdd\b/i.test(command)) {
    return { level: 'destructive', reason: 'disk-overwrite' };
  }
  if (/\bmkfs\b/i.test(command)) {
    return { level: 'destructive', reason: 'disk-format' };
  }
  if (isDeleteCommand(command)) {
    return { level: 'caution', reason: 'file-delete' };
  }
  if (/\bgit\s+push\b/i.test(command)) {
    return { level: 'caution', reason: 'git-push' };
  }
  if (/\b(kill|killall|pkill)\b/i.test(command)) {
    return { level: 'caution', reason: 'process-kill' };
  }
  if (/\b(chmod|chown)\b/i.test(command) || /\bsudo\b/i.test(command)) {
    return { level: 'caution', reason: 'permission-change' };
  }
  return { level: 'safe', reason: '' };
}

function readString(input: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const val = input[key];
    if (typeof val === 'string' && val.trim().length > 0) {
      return val.trim();
    }
  }
  return '';
}

function extractCommandFromReason(reason: string): string {
  const match = /requires confirmation \([^)]+\):\s*([\s\S]+)$/i.exec(reason);
  return match?.[1]?.trim() ?? '';
}

function extractReasonCode(reason: string): string {
  const match = /requires confirmation \(([^)]+)\)/i.exec(reason);
  return match?.[1]?.trim() ?? '';
}

function extractCdDirectoryFromCommand(command: string): string {
  const match = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/i.exec(command);
  return (match?.[1] || match?.[2] || match?.[3] || '').trim();
}

function buildSanitizedTechnicalDetails(input: Record<string, unknown>): string {
  const cleaned: Record<string, unknown> = {};
  const skipKeys = new Set([
    'callId',
    'toolName',
    'dangerLevel',
    'dangerReason',
    'approvalScopeKey',
    'permissionPreset',
  ]);
  for (const [k, v] of Object.entries(input)) {
    if (skipKeys.has(k)) continue;
    if (v === undefined || v === null || v === '') continue;
    cleaned[k] = v;
  }
  try {
    return Object.keys(cleaned).length > 0 ? JSON.stringify(cleaned, null, 2) : '';
  } catch {
    return '';
  }
}

export function buildPermissionModalPresentation(
  toolName: string,
  rawToolInput: Record<string, unknown>,
  t: (key: string) => string,
): PermissionModalPresentation {
  const input = rawToolInput && typeof rawToolInput === 'object' ? rawToolInput : {};
  const normalizedTool = toolName.trim().toLowerCase();
  const isShellTool = SHELL_TOOL_NAMES.has(normalizedTool);
  const isFileTool = FILE_MUTATION_TOOL_NAMES.has(normalizedTool);

  const rawReason = readString(input, 'reason');
  const command = readString(input, 'command', 'cmd', 'script')
    || (rawReason ? extractCommandFromReason(rawReason) : '');

  const modelNote = readString(input, 'justification', 'description');
  const filePath = readString(input, 'filePath', 'file_path', 'path', 'target_path');
  const workdir = readString(input, 'workdir', 'cwd')
    || (command ? extractCdDirectoryFromCommand(command) : '');
  const sandboxPermissions = readString(input, 'sandboxPermissions', 'sandbox_permissions');
  const isSandboxEscalation = Boolean(
    sandboxPermissions
    || /sandbox|outside.*workspace|wider access/i.test(rawReason),
  );

  const detected = command ? detectDangerFromCommand(command) : { level: 'safe' as ApprovalDangerLevel, reason: '' };
  const rawDangerLevel = readString(input, 'dangerLevel');
  const dangerLevel: ApprovalDangerLevel =
    rawDangerLevel === 'destructive' || rawDangerLevel === 'caution' || rawDangerLevel === 'safe'
      ? (rawDangerLevel === 'safe' && detected.level !== 'safe' ? detected.level : rawDangerLevel)
      : detected.level;

  const dangerReason = readString(input, 'dangerReason')
    || detected.reason
    || (rawReason ? extractReasonCode(rawReason) : '');

  const dangerReasonKey = DANGER_REASON_I18N_MAP[dangerReason];
  const dangerReasonText = dangerReasonKey ? t(dangerReasonKey) : '';

  let title: string;
  let summary: string;

  if (dangerReason && TITLE_KEY_BY_DANGER_REASON[dangerReason]) {
    title = t(TITLE_KEY_BY_DANGER_REASON[dangerReason]);
    summary = t(SUMMARY_KEY_BY_DANGER_REASON[dangerReason]);
  } else if (isSandboxEscalation) {
    title = t('coworkApprovalTitleSandboxEscalation');
    summary = t('coworkApprovalSummarySandboxEscalation');
  } else if (isFileTool) {
    title = t('coworkApprovalTitleFileWrite');
    summary = t('coworkApprovalSummaryFileWrite');
  } else if (isShellTool || command) {
    title = t('coworkApprovalTitleShellCommand');
    summary = t('coworkApprovalSummaryShellCommand');
  } else {
    title = t('coworkApprovalTitleToolAction').replace('{tool}', toolName || 'tool');
    summary = t('coworkApprovalSummaryToolAction');
  }

  let targetLabel = '';
  let targetValue = '';
  if (filePath) {
    targetLabel = t('coworkApprovalTargetFile');
    targetValue = filePath;
  } else if (workdir) {
    targetLabel = t('coworkApprovalTargetDir');
    targetValue = workdir;
  }

  const approvalScopeKey = readString(input, 'approvalScopeKey')
    || (isShellTool
      ? (dangerReason ? `shell:${dangerReason}` : 'shell:exec')
      : `tool:${normalizedTool || 'tool'}`);

  const currentPreset = readString(input, 'permissionPreset');
  const canAllowForSession = dangerLevel !== 'destructive' && !isSandboxEscalation && approvalScopeKey.length > 0;
  const canSwitchFullAccess = currentPreset !== DshPermissionPreset.FullAccess;

  return {
    title,
    summary,
    modelNote,
    targetLabel,
    targetValue,
    command,
    dangerLevel,
    dangerReasonText,
    approvalScopeKey,
    canAllowForSession,
    canSwitchFullAccess,
    technicalDetails: command ? '' : buildSanitizedTechnicalDetails(input),
  };
}
