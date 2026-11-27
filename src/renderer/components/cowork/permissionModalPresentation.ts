// Pure presentation mapper turning raw tool approval requests (including DSH
// `approval/request` payloads) into plain-language, non-technical confirmation
// copy suitable for everyday users.

import {
  analyzeCommandDanger,
  CommandDangerLevel,
  CommandDangerReason,
} from '../../../common/commandDanger';
import {
  DSH_AGENT_RULES_TOOL,
  DshApprovalPermissionAction,
  DshPermissionPreset,
} from '../../../shared/dshEngine/hostConstants';
import type { DshPermissionPresetChangedDetail } from '../../services/dshHost';
import type { CoworkPermissionResult } from '../../types/cowork';

export type ApprovalDangerLevel = CommandDangerLevel;

export interface PermissionModalPresentation {
  title: string;
  summary: string;
  modelNote: string;
  modelNoteLabel: string;
  targetLabel: string;
  targetValue: string;
  command: string;
  dangerLevel: ApprovalDangerLevel;
  dangerReason: string;
  dangerReasonText: string;
  dangerDetailText: string;
  triggeredSnippet: string;
  triggeredLineNumber: number;
  isEmbeddedInScript: boolean;
  approvalScopeKey: string;
  allowSessionLabel: string;
  allowSessionHint: string;
  canAllowForSession: boolean;
  canSwitchFullAccess: boolean;
  technicalDetails: string;
}

const SHELL_TOOL_NAMES = new Set(['bash', 'pwsh', 'shell', 'exec', 'terminal_exec']);
const FILE_MUTATION_TOOL_NAMES = new Set(['write', 'edit', 'apply_patch', 'delete_file', 'move_file']);

const DANGER_REASON_I18N_MAP: Record<string, string> = {
  [CommandDangerReason.RecursiveDelete]: 'dangerReasonRecursiveDelete',
  [CommandDangerReason.GitForcePush]: 'dangerReasonGitForcePush',
  [CommandDangerReason.GitResetHard]: 'dangerReasonGitResetHard',
  [CommandDangerReason.DiskOverwrite]: 'dangerReasonDiskOverwrite',
  [CommandDangerReason.DiskFormat]: 'dangerReasonDiskFormat',
  [CommandDangerReason.FileDelete]: 'dangerReasonFileDelete',
  [CommandDangerReason.GitPush]: 'dangerReasonGitPush',
  [CommandDangerReason.ProcessKill]: 'dangerReasonProcessKill',
  [CommandDangerReason.PermissionChange]: 'dangerReasonPermissionChange',
  [CommandDangerReason.PrivilegeEscalation]: 'dangerReasonPrivilegeEscalation',
};

const DANGER_DETAIL_I18N_MAP: Record<string, string> = {
  [CommandDangerReason.RecursiveDelete]: 'coworkApprovalRiskRecursiveDelete',
  [CommandDangerReason.GitForcePush]: 'coworkApprovalRiskGitForcePush',
  [CommandDangerReason.GitResetHard]: 'coworkApprovalRiskGitResetHard',
  [CommandDangerReason.DiskOverwrite]: 'coworkApprovalRiskDiskOverwrite',
  [CommandDangerReason.DiskFormat]: 'coworkApprovalRiskDiskFormat',
  [CommandDangerReason.FileDelete]: 'coworkApprovalRiskFileDelete',
  [CommandDangerReason.GitPush]: 'coworkApprovalRiskGitPush',
  [CommandDangerReason.ProcessKill]: 'coworkApprovalRiskProcessKill',
  [CommandDangerReason.PermissionChange]: 'coworkApprovalRiskPermissionChange',
  [CommandDangerReason.PrivilegeEscalation]: 'coworkApprovalRiskPrivilegeEscalation',
};

const TITLE_KEY_BY_DANGER_REASON: Record<string, string> = {
  [CommandDangerReason.GitPush]: 'coworkApprovalTitleGitPush',
  [CommandDangerReason.GitForcePush]: 'coworkApprovalTitleGitForcePush',
  [CommandDangerReason.GitResetHard]: 'coworkApprovalTitleGitResetHard',
  [CommandDangerReason.FileDelete]: 'coworkApprovalTitleFileDelete',
  [CommandDangerReason.RecursiveDelete]: 'coworkApprovalTitleRecursiveDelete',
  [CommandDangerReason.ProcessKill]: 'coworkApprovalTitleProcessKill',
  [CommandDangerReason.PermissionChange]: 'coworkApprovalTitlePermissionChange',
  [CommandDangerReason.PrivilegeEscalation]: 'coworkApprovalTitlePrivilegeEscalation',
  [CommandDangerReason.DiskOverwrite]: 'coworkApprovalTitleDiskOp',
  [CommandDangerReason.DiskFormat]: 'coworkApprovalTitleDiskOp',
};

const SUMMARY_KEY_BY_DANGER_REASON: Record<string, string> = {
  [CommandDangerReason.GitPush]: 'coworkApprovalSummaryGitPush',
  [CommandDangerReason.GitForcePush]: 'coworkApprovalSummaryGitForcePush',
  [CommandDangerReason.GitResetHard]: 'coworkApprovalSummaryGitResetHard',
  [CommandDangerReason.FileDelete]: 'coworkApprovalSummaryFileDelete',
  [CommandDangerReason.RecursiveDelete]: 'coworkApprovalSummaryRecursiveDelete',
  [CommandDangerReason.ProcessKill]: 'coworkApprovalSummaryProcessKill',
  [CommandDangerReason.PermissionChange]: 'coworkApprovalSummaryPermissionChange',
  [CommandDangerReason.PrivilegeEscalation]: 'coworkApprovalSummaryPrivilegeEscalation',
  [CommandDangerReason.DiskOverwrite]: 'coworkApprovalSummaryDiskOp',
  [CommandDangerReason.DiskFormat]: 'coworkApprovalSummaryDiskOp',
};

const ALLOW_SESSION_LABEL_KEY_BY_REASON: Record<string, string> = {
  [CommandDangerReason.FileDelete]: 'coworkApprovalAllowSessionFileDelete',
  [CommandDangerReason.GitPush]: 'coworkApprovalAllowSessionGitPush',
  [CommandDangerReason.ProcessKill]: 'coworkApprovalAllowSessionProcessKill',
  [CommandDangerReason.PermissionChange]: 'coworkApprovalAllowSessionPermissionChange',
  [CommandDangerReason.PrivilegeEscalation]: 'coworkApprovalAllowSessionPrivilegeEscalation',
};

export function detectDangerFromCommand(command: string): {
  level: ApprovalDangerLevel;
  reason: string;
} {
  const { level, reason } = analyzeCommandDanger(command);
  return { level, reason };
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

function readPositiveInt(input: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const val = input[key];
    if (typeof val === 'number' && Number.isInteger(val) && val > 0) {
      return val;
    }
  }
  return 0;
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
    'dangerSnippet',
    'dangerLineNumber',
    'isEmbeddedInScript',
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

const MAX_RULES_PREVIEW_CHARS = 800;

function formatAgentRulesPreview(input: Record<string, unknown>): string {
  const rules = readString(input, 'rules');
  const description = readString(input, 'description');
  const preview = rules.length > MAX_RULES_PREVIEW_CHARS
    ? `${rules.slice(0, MAX_RULES_PREVIEW_CHARS).trimEnd()}…`
    : rules;
  if (description && preview) return `${description}\n\n${preview}`;
  return preview || description;
}

export function buildPermissionModalPresentation(
  toolName: string,
  rawToolInput: Record<string, unknown>,
  t: (key: string) => string,
): PermissionModalPresentation {
  const input = rawToolInput && typeof rawToolInput === 'object' ? rawToolInput : {};
  const normalizedTool = toolName.trim().toLowerCase();
  const isAgentRulesTool = normalizedTool === DSH_AGENT_RULES_TOOL;
  const isShellTool = SHELL_TOOL_NAMES.has(normalizedTool);
  const isFileTool = FILE_MUTATION_TOOL_NAMES.has(normalizedTool);

  const rawReason = readString(input, 'reason');
  const command = readString(input, 'command', 'cmd', 'script')
    || (rawReason ? extractCommandFromReason(rawReason) : '');

  const modelNote = isAgentRulesTool
    ? formatAgentRulesPreview(input)
    : readString(input, 'justification', 'description');
  const modelNoteLabel = modelNote
    ? (isAgentRulesTool ? t('coworkApprovalAgentRulesPreviewLabel') : t('coworkApprovalModelNoteLabel'))
    : '';
  const filePath = readString(input, 'filePath', 'file_path', 'path', 'target_path');
  const workdir = readString(input, 'workdir', 'cwd')
    || (command ? extractCdDirectoryFromCommand(command) : '');
  const sandboxPermissions = readString(input, 'sandboxPermissions', 'sandbox_permissions');
  const isSandboxEscalation = Boolean(
    sandboxPermissions
    || /sandbox|outside.*workspace|wider access/i.test(rawReason),
  );

  const detected = command
    ? analyzeCommandDanger(command)
    : {
        level: CommandDangerLevel.Safe,
        reason: '' as const,
        matchedSnippet: '',
        matchedLineNumber: 0,
        isEmbeddedInScript: false,
      };
  const rawDangerLevel = readString(input, 'dangerLevel');
  const dangerLevel: ApprovalDangerLevel =
    rawDangerLevel === CommandDangerLevel.Destructive
    || rawDangerLevel === CommandDangerLevel.Caution
    || rawDangerLevel === CommandDangerLevel.Safe
      ? (rawDangerLevel === CommandDangerLevel.Safe && detected.level !== CommandDangerLevel.Safe
          ? detected.level
          : rawDangerLevel)
      : detected.level;

  const dangerReason = readString(input, 'dangerReason')
    || detected.reason
    || (rawReason ? extractReasonCode(rawReason) : '');

  const dangerReasonKey = DANGER_REASON_I18N_MAP[dangerReason];
  const dangerReasonText = dangerReasonKey ? t(dangerReasonKey) : '';
  const dangerDetailKey = DANGER_DETAIL_I18N_MAP[dangerReason];
  const dangerDetailText = dangerDetailKey ? t(dangerDetailKey) : '';

  const triggeredSnippet = detected.matchedSnippet || readString(input, 'dangerSnippet');
  const triggeredLineNumber = detected.matchedLineNumber || readPositiveInt(input, 'dangerLineNumber');
  const isEmbeddedInScript = Boolean(
    detected.isEmbeddedInScript
    || input.isEmbeddedInScript === true
    || (Boolean(dangerReason) && command.includes('\n')),
  );

  let title: string;
  let summary: string;

  if (isAgentRulesTool) {
    title = t('coworkApprovalTitleAgentRules');
    summary = t('coworkApprovalSummaryAgentRules');
  } else if (dangerReason && isEmbeddedInScript && dangerReasonText) {
    title = t('coworkApprovalTitleScriptWithDanger').replace('{reason}', dangerReasonText);
    summary = t('coworkApprovalSummaryScriptWithDanger').replace('{reason}', dangerReasonText);
  } else if (dangerReason && TITLE_KEY_BY_DANGER_REASON[dangerReason]) {
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

  let allowSessionLabel: string;
  if (isAgentRulesTool) {
    allowSessionLabel = t('coworkApprovalAllowSessionAgentRules');
  } else if (dangerReason && ALLOW_SESSION_LABEL_KEY_BY_REASON[dangerReason]) {
    allowSessionLabel = t(ALLOW_SESSION_LABEL_KEY_BY_REASON[dangerReason]);
  } else if (isFileTool) {
    allowSessionLabel = t('coworkApprovalAllowSessionFileWrite');
  } else {
    allowSessionLabel = t('coworkApprovalAllowSessionGeneric');
  }

  const allowSessionHint = dangerReasonText
    ? t('coworkApprovalAllowSessionHintScoped').replace('{scope}', dangerReasonText)
    : t('coworkApprovalAllowSessionHintGeneric');

  const currentPreset = readString(input, 'permissionPreset');
  const canAllowForSession = dangerLevel !== CommandDangerLevel.Destructive
    && !isSandboxEscalation
    && approvalScopeKey.length > 0;
  const canSwitchFullAccess = !isAgentRulesTool && currentPreset !== DshPermissionPreset.FullAccess;

  return {
    title,
    summary,
    modelNote,
    modelNoteLabel,
    targetLabel,
    targetValue,
    command,
    dangerLevel,
    dangerReason,
    dangerReasonText,
    dangerDetailText,
    triggeredSnippet,
    triggeredLineNumber,
    isEmbeddedInScript,
    approvalScopeKey,
    allowSessionLabel,
    allowSessionHint,
    canAllowForSession,
    canSwitchFullAccess,
    technicalDetails: command ? '' : buildSanitizedTechnicalDetails(input),
  };
}

/**
 * Build the approval response and renderer preset-change event for clicking
 * "Switch to Full Access" inside `CoworkPermissionModal`.
 * Always scopes to the requesting session when `sessionId` is present so
 * `danger-full-access` never bleeds into other sessions or the global default.
 */
export function buildSwitchFullAccessAction(
  sessionId: string | null | undefined,
  toolInput: unknown,
): {
  eventDetail: DshPermissionPresetChangedDetail;
  response: CoworkPermissionResult;
} {
  const targetSessionId = typeof sessionId === 'string' && sessionId.trim()
    ? sessionId.trim()
    : undefined;
  return {
    eventDetail: {
      preset: DshPermissionPreset.FullAccess,
      ...(targetSessionId
        ? { sessionId: targetSessionId }
        : { defaultPreset: DshPermissionPreset.FullAccess }),
    },
    response: {
      behavior: 'allow',
      updatedInput: toolInput && typeof toolInput === 'object'
        ? (toolInput as Record<string, unknown>)
        : {},
      updatedPermissions: [
        {
          type: DshApprovalPermissionAction.SetPermissionPreset,
          preset: DshPermissionPreset.FullAccess,
          ...(targetSessionId ? { sessionId: targetSessionId } : { global: true }),
        },
      ],
    },
  };
}
