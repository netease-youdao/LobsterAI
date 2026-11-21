import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { buildManagedSessionKey } from '../../../shared/cowork/managedSessionKey';
import { DSH_SKILL_INSTALL_TOOL, DshSkillInstallAction } from '../../../shared/dshEngine/hostConstants';
import { ConfirmationBehavior } from '../../../shared/media/confirmation';
import { t } from '../../i18n';
import type { McpRuntime } from '../../mcp/mcpRuntime';
import type { SkillManager } from '../../skills/skillManager';
import type { SecurityReportAction, SkillSecurityReport } from '../skillSecurity/skillSecurityTypes';
import type { HostToolProvider } from './dshHostBridgeWiring';

interface SkillInstallOptions {
  manager: () => Pick<SkillManager, 'getSkillsRoot' | 'downloadSkill' | 'confirmPendingInstall'>;
  session: (sessionId: string) => { cwd: string; userMessage?: string } | null;
  ask: McpRuntime['askUserInternal'];
}

function resolveSource(source: string, cwd: string, message: string): string {
  const candidate = path.resolve(cwd, source);
  // The chat composer serializes non-media attachments as labeled absolute paths.
  for (const line of message.split('\n')) {
    const attached = /^(?:Input Files|Input Folder|输入文件|输入文件夹): (.+)$/.exec(line)?.[1];
    if (attached && path.isAbsolute(attached) && path.normalize(attached) === candidate) return realpathSync(candidate);
  }
  const inside = (relative: string) => !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
  if (inside(path.relative(cwd, candidate))) {
    const resolved = realpathSync(candidate);
    const relative = path.relative(realpathSync(cwd), resolved);
    if (inside(relative) && (relative || existsSync(path.join(resolved, 'SKILL.md')))) return resolved;
  }
  throw new Error('Choose a skill inside the session workspace or attach its folder, SKILL.md or ZIP in chat.');
}

async function review(report: SkillSecurityReport, sessionKey: string, ask: SkillInstallOptions['ask']): Promise<SecurityReportAction> {
  const question = t('skillChatAudit', { name: report.skillName, risk: report.riskLevel });
  const disabled = t('skillChatInstallDisabled');
  const install = t('skillChatInstall');
  const response = await ask([{
    question,
    subtitle: report.findings.map(f => `${f.file}${f.line ? ':' + f.line : ''} · ${f.ruleId} · ${f.description}`).join('\n'),
    options: [t('mediaVideoConfirmCancel'), disabled, install].map(label => ({ label })),
  }], 120_000, { sessionKey });
  if (response?.behavior !== ConfirmationBehavior.Allow) return 'cancel';
  const answer = response.answers?.[question];
  return answer === disabled ? 'installDisabled' : answer === install ? 'install' : 'cancel';
}

export function createDshSkillInstallProvider(options: SkillInstallOptions): HostToolProvider {
  return {
    listDescriptors: () => [{
      name: DSH_SKILL_INSTALL_TOOL,
      description: 'Install a user-requested local skill into My Skills of this LobsterAI instance. Inspect returns its actual destination. Use this tool for skill installation, including attached folders, SKILL.md files and ZIPs. The desktop manages review and registration. Never guess a skills directory or copy files with shell commands.',
      inputSchema: {
        type: 'object', required: ['action'],
        properties: {
          action: { type: 'string', enum: Object.values(DshSkillInstallAction) },
          source: { type: 'string', description: 'Local path of the user-selected skill. Required for install.' },
        },
      },
    }],
    async execute(tool, args, context) {
      const session = context.coworkSessionId && options.session(context.coworkSessionId);
      if (tool !== DSH_SKILL_INSTALL_TOOL || !session || !context.coworkSessionId) throw new Error('A bound chat session is required.');
      const manager = options.manager();
      const root = manager.getSkillsRoot();
      if (args.action === DshSkillInstallAction.Inspect) return { root };
      if (args.action !== DshSkillInstallAction.Install || typeof args.source !== 'string' || !args.source.trim()) {
        throw new Error('A local skill source is required.');
      }
      const source = resolveSource(args.source.trim(), session.cwd, session.userMessage ?? '');
      context.signal?.throwIfAborted();
      const result = await manager.downloadSkill(source, context.signal);
      if (!result.success) throw new Error(result.error);
      if (result.pendingInstallId && result.auditReport) {
        const pending = result.pendingInstallId;
        let action: SecurityReportAction = 'cancel';
        try {
          context.signal?.throwIfAborted();
          action = await review(result.auditReport, buildManagedSessionKey(context.coworkSessionId, context.agentId), options.ask);
        } finally {
          if (context.signal?.aborted || action === 'cancel') manager.confirmPendingInstall(pending, 'cancel');
        }
        if (context.signal?.aborted || action === 'cancel') return { installed: false, root, cancelled: true };
        const confirmed = manager.confirmPendingInstall(pending, action);
        if (!confirmed.success) throw new Error(confirmed.error);
        return { installed: true, root, ids: confirmed.installedIds };
      }
      return { installed: true, root, ids: result.installedIds };
    },
  };
}
