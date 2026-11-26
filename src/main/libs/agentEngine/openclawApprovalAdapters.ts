import fs from 'node:fs';
import path from 'node:path';

import { t } from '../../i18n';
import { trustedSettingsApproval } from '../agentSettingsConversation/approval';
import type { ExecApprovalRequest, PluginApprovalRequest } from './openclawApprovalBridge';

export const APPROVAL_ADAPTER_VERSION = '2026.8.1/1';
export interface ApprovalDescription { title: string; summary: string; remoteSafe: boolean }
const localOnly = (): ApprovalDescription => ({ title: t('remoteDecisionDesktopTitle'), summary: t('remoteDecisionDesktopSummary'), remoteSafe: false });
const readable = (value: string): boolean => !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value);
const bounded = (description: ApprovalDescription): ApprovalDescription => (
  description.title.length <= 128 && Buffer.byteLength(description.summary) <= 4096 ? description : localOnly()
);

/** Only a literal rm invocation whose complete target set fits in the chosen workspace. */
export function describeExecApproval(request: ExecApprovalRequest, workspace: { cwd: string; name: string } | null): ApprovalDescription {
  if (!workspace || typeof request.command !== 'string' || !readable(request.command)
    || (request.host && request.host !== 'gateway') || request.env || request.systemRunPlan || request.commandArgv
    || request.warningText || request.nodeId || (Array.isArray(request.unavailableDecisions) && request.unavailableDecisions.includes('allow-once')) || typeof request.cwd !== 'string'
    || path.resolve(request.cwd) !== path.resolve(workspace.cwd)) return localOnly();
  // Reject all shell interpretation, including quoting/globs/substitutions/redirects.
  const parts = request.command.trim().split(/ +/u);
  if (!['rm', '/bin/rm'].includes(parts[0]) || parts.length < 2) return localOnly();
  let recursive = false;
  const targets: string[] = [];
  let operands = false;
  for (const part of parts.slice(1)) {
    if (!operands && part === '--') { operands = true; continue; }
    if (!operands && /^-[rfv]+$/u.test(part)) { recursive ||= part.includes('r'); continue; }
    operands = true;
    if (!/^[\p{L}\p{N}_.\-/]+$/u.test(part) || part.startsWith('-') || path.isAbsolute(part)) return localOnly();
    const normalized = path.normalize(part);
    if (normalized === '.' || normalized === '..' || normalized.startsWith(`..${path.sep}`)) return localOnly();
    // rm removes a final symlink itself, but a symlink in a parent could redirect
    // deletion outside the named workspace. Verify parent containment again at dispatch.
    try {
      const root = fs.realpathSync(workspace.cwd);
      const parent = fs.realpathSync(path.dirname(path.resolve(workspace.cwd, normalized)));
      const relative = path.relative(root, parent);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return localOnly();
    } catch { return localOnly(); }
    targets.push(normalized);
  }
  if (!targets.length || targets.length > 32 || !readable(workspace.name)) return localOnly();
  return bounded({ title: t('remoteDecisionDeletionTitle'), summary: t('remoteDecisionDeletionSummary', {
    workspace: workspace.name, targets: targets.join(t('remoteDecisionTargetSeparator')), recursive: recursive ? t('remoteDecisionRecursiveWarning') : '',
  }), remoteSafe: true });
}

/** The pinned built-in Codex plugin's network approval producer emits this exact single-host format.
 * The entire description is parsed. Truncated descriptions, general commands, permissions and
 * arbitrary plugin supplied remoteSafe/publicSummary fields are deliberately not accepted.
 */
export function describePluginApproval(request: PluginApprovalRequest): ApprovalDescription {
  const settings = trustedSettingsApproval(request);
  if (settings) return { title: settings.title, summary: settings.summary, remoteSafe: settings.remoteSafe };
  if (request.pluginId !== 'codex' || request.toolName !== 'codex_network_approval'
    || request.title !== 'Codex app-server network approval' || request.detail || request.scope
    || typeof request.description !== 'string' || !request.allowedDecisions?.includes('allow-once')
    || !request.allowedDecisions.includes('deny')) return localOnly();
  const match = /^Network: (https?):\/\/([a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?)(?::([1-9][0-9]{0,4}))?$/u.exec(request.description);
  if (!match || match[2].includes('..') || (match[3] && Number(match[3]) > 65535)) return localOnly();
  return bounded({ title: t('remoteDecisionNetworkTitle'), summary: t('remoteDecisionNetworkSummary', {
    origin: `${match[1]}://${match[2]}${match[3] ? `:${match[3]}` : ''}`,
  }), remoteSafe: true });
}
