import { describe, expect, test } from 'vitest';

import {
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
    expect(presentation.approvalScopeKey).toBe('shell:git-push');
    expect(presentation.canAllowForSession).toBe(true);
    expect(presentation.canSwitchFullAccess).toBe(true);
    expect(presentation.technicalDetails).toBe('');
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
