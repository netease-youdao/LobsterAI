import { describe, expect, test } from 'vitest';

import {
  DSH_AGENT_RULES_TOOL,
  DshAgentRulesAction,
  DshApprovalPermissionAction,
  DshPermissionPreset,
} from '../../../shared/dshEngine/hostConstants';
import {
  buildPermissionModalPresentation,
  buildSwitchFullAccessAction,
} from './permissionModalPresentation';

const identityT = (key: string): string => key;

describe('buildPermissionModalPresentation', () => {
  test('renders plain-language git-push confirmation from raw DSH approval payload without JSON noise', () => {
    const presentation = buildPermissionModalPresentation(
      'bash',
      {
        toolName: 'bash',
        callId: 'call_00_ET_oEUmOIH6SzDszgsuOn6b0933',
        reason:
          'Potentially dangerous command requires confirmation (git-push): cd /Users/wangning/lobsterai/project010/fisherdaddy && git push origin main 2>&1 | tail -5',
      },
      identityT,
    );

    expect(presentation.title).toBe('coworkApprovalTitleGitPush');
    expect(presentation.summary).toBe('coworkApprovalSummaryGitPush');
    expect(presentation.targetLabel).toBe('coworkApprovalTargetDir');
    expect(presentation.targetValue).toBe('/Users/wangning/lobsterai/project010/fisherdaddy');
    expect(presentation.command).toBe(
      'cd /Users/wangning/lobsterai/project010/fisherdaddy && git push origin main 2>&1 | tail -5',
    );
    expect(presentation.dangerLevel).toBe('caution');
    expect(presentation.dangerReasonText).toBe('dangerReasonGitPush');
    expect(presentation.dangerDetailText).toBe('coworkApprovalRiskGitPush');
    expect(presentation.approvalScopeKey).toBe('shell:git-push');
    expect(presentation.allowSessionLabel).toBe('coworkApprovalAllowSessionGitPush');
    expect(presentation.canAllowForSession).toBe(true);
    expect(presentation.canSwitchFullAccess).toBe(true);
    expect(presentation.technicalDetails).toBe('');
  });

  test('surfaces script title, exact triggered line, and scoped session-allow label for embedded scripts', () => {
    const scriptCommand = [
      'cd "/Users/alice/Documents/Obsidian Vault/.tmp/github-app-setup" && python3 - <<\'PY\'',
      'import json, os',
      'new = json.load(open(\'credentials.json\'))',
      'open(\'deploy.sh\', \'w\').write(\'echo ok\')',
      'os.chmod(\'deploy.sh\', 0o755)',
      'PY',
    ].join('\n');

    const presentation = buildPermissionModalPresentation(
      'bash',
      {
        command: scriptCommand,
        description: 'Prepare deployment helper script',
        permissionPreset: DshPermissionPreset.WorkspaceWrite,
      },
      identityT,
    );

    expect(presentation.title).toBe('coworkApprovalTitleScriptWithDanger');
    expect(presentation.summary).toBe('coworkApprovalSummaryScriptWithDanger');
    expect(presentation.modelNoteLabel).toBe('coworkApprovalModelNoteLabel');
    expect(presentation.modelNote).toBe('Prepare deployment helper script');
    expect(presentation.targetLabel).toBe('coworkApprovalTargetDir');
    expect(presentation.targetValue).toBe('/Users/alice/Documents/Obsidian Vault/.tmp/github-app-setup');
    expect(presentation.dangerLevel).toBe('caution');
    expect(presentation.dangerReasonText).toBe('dangerReasonPermissionChange');
    expect(presentation.dangerDetailText).toBe('coworkApprovalRiskPermissionChange');
    expect(presentation.triggeredSnippet).toBe("os.chmod('deploy.sh', 0o755)");
    expect(presentation.triggeredLineNumber).toBe(5);
    expect(presentation.isEmbeddedInScript).toBe(true);
    expect(presentation.allowSessionLabel).toBe('coworkApprovalAllowSessionPermissionChange');
    expect(presentation.canAllowForSession).toBe(true);
  });

  test('presents sudo commands as privilege escalation instead of file permission changes', () => {
    const presentation = buildPermissionModalPresentation(
      'bash',
      {
        command: 'sudo apt-get install jq',
        permissionPreset: DshPermissionPreset.WorkspaceWrite,
      },
      identityT,
    );

    expect(presentation.title).toBe('coworkApprovalTitlePrivilegeEscalation');
    expect(presentation.summary).toBe('coworkApprovalSummaryPrivilegeEscalation');
    expect(presentation.dangerLevel).toBe('caution');
    expect(presentation.dangerReasonText).toBe('dangerReasonPrivilegeEscalation');
    expect(presentation.dangerDetailText).toBe('coworkApprovalRiskPrivilegeEscalation');
    expect(presentation.approvalScopeKey).toBe('shell:privilege-escalation');
    expect(presentation.allowSessionLabel).toBe('coworkApprovalAllowSessionPrivilegeEscalation');
  });

  test('marks destructive commands non-session-rememberable while keeping full-access option', () => {
    const presentation = buildPermissionModalPresentation(
      'bash',
      {
        command: 'rm -rf /tmp/demo',
        description: 'Clean temporary output directory',
        dangerLevel: 'destructive',
        dangerReason: 'recursive-delete',
        permissionPreset: DshPermissionPreset.WorkspaceWrite,
      },
      identityT,
    );

    expect(presentation.title).toBe('coworkApprovalTitleRecursiveDelete');
    expect(presentation.modelNote).toBe('Clean temporary output directory');
    expect(presentation.dangerLevel).toBe('destructive');
    expect(presentation.dangerReasonText).toBe('dangerReasonRecursiveDelete');
    expect(presentation.canAllowForSession).toBe(false);
    expect(presentation.canSwitchFullAccess).toBe(true);
  });

  test('presents sandbox escalations clearly with model justification', () => {
    const presentation = buildPermissionModalPresentation(
      'bash',
      {
        command: 'git status',
        workdir: '/Users/alice/other-repo',
        sandboxPermissions: 'danger-full-access',
        justification: '需要检查工作区外的仓库状态',
      },
      identityT,
    );

    expect(presentation.title).toBe('coworkApprovalTitleSandboxEscalation');
    expect(presentation.summary).toBe('coworkApprovalSummarySandboxEscalation');
    expect(presentation.modelNote).toBe('需要检查工作区外的仓库状态');
    expect(presentation.targetValue).toBe('/Users/alice/other-repo');
    expect(presentation.canAllowForSession).toBe(false);
    expect(presentation.canSwitchFullAccess).toBe(true);
  });

  test('presents file write approvals with target file path', () => {
    const presentation = buildPermissionModalPresentation(
      'write',
      {
        file_path: '/Users/alice/project/README.md',
      },
      identityT,
    );

    expect(presentation.title).toBe('coworkApprovalTitleFileWrite');
    expect(presentation.targetLabel).toBe('coworkApprovalTargetFile');
    expect(presentation.targetValue).toBe('/Users/alice/project/README.md');
    expect(presentation.canAllowForSession).toBe(true);
  });

  test('presents lobster_agent_rules approvals with dedicated copy, rules preview, and no full-access switch', () => {
    const presentation = buildPermissionModalPresentation(
      DSH_AGENT_RULES_TOOL,
      {
        action: DshAgentRulesAction.Save,
        description: '整理团队周报',
        rules: '- 先给核心结论\n- 再列进展与待办',
        permissionPreset: DshPermissionPreset.WorkspaceWrite,
      },
      identityT,
    );

    expect(presentation.title).toBe('coworkApprovalTitleAgentRules');
    expect(presentation.summary).toBe('coworkApprovalSummaryAgentRules');
    expect(presentation.modelNote).toBe('整理团队周报\n\n- 先给核心结论\n- 再列进展与待办');
    expect(presentation.approvalScopeKey).toBe(`tool:${DSH_AGENT_RULES_TOOL}`);
    expect(presentation.canAllowForSession).toBe(true);
    expect(presentation.canSwitchFullAccess).toBe(false);
  });

  test('buildSwitchFullAccessAction scopes to active sessionId instead of setting global=true', () => {
    const action = buildSwitchFullAccessAction('session-a', { command: 'rm -rf /tmp/x' });
    expect(action.eventDetail).toEqual({
      preset: DshPermissionPreset.FullAccess,
      sessionId: 'session-a',
    });
    expect(action.eventDetail.defaultPreset).toBeUndefined();
    expect(action.response).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'rm -rf /tmp/x' },
      updatedPermissions: [
        {
          type: DshApprovalPermissionAction.SetPermissionPreset,
          preset: DshPermissionPreset.FullAccess,
          sessionId: 'session-a',
        },
      ],
    });
  });

  test('buildSwitchFullAccessAction falls back to global only when sessionId is missing', () => {
    const action = buildSwitchFullAccessAction('', { command: 'rm foo.txt' });
    expect(action.eventDetail).toEqual({
      preset: DshPermissionPreset.FullAccess,
      defaultPreset: DshPermissionPreset.FullAccess,
    });
    expect(action.response).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'rm foo.txt' },
      updatedPermissions: [
        {
          type: DshApprovalPermissionAction.SetPermissionPreset,
          preset: DshPermissionPreset.FullAccess,
          global: true,
        },
      ],
    });
  });
});
