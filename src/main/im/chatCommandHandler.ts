/**
 * Chat Command Handler
 *
 * Provides slash-command support for IM channels. When a user sends a message
 * starting with '/', it is intercepted before reaching the Agent and handled
 * here directly.
 *
 * Supported commands (aligned with OpenClaw's command surface):
 *   /help              — list all available commands
 *   /status            — show current session status and context info
 *   /new               — start a fresh conversation session
 *   /compact           — compress context: reset the SDK session while keeping
 *                        the local message log (forces a history-inject restart)
 *   /stop              — stop the currently running agent turn
 *   /version           — show app version
 */

import { t } from '../i18n';
import type { CoworkRuntime } from '../libs/agentEngine/types';
import type { CoworkStore } from '../coworkStore';
import type { IMStore } from './imStore';
import type { IMMessage, Platform } from './types';

export interface ChatCommandDeps {
  coworkRuntime: CoworkRuntime;
  coworkStore: CoworkStore;
  imStore: IMStore;
  /** Callback to force-create a new session for the conversation */
  forceNewSession: (conversationId: string, platform: Platform) => Promise<void>;
}

interface ParsedCommand {
  name: string; // e.g. 'help', 'status', 'new'
  args: string[]; // remaining tokens
  raw: string; // original message content
}

/**
 * Parse a slash command from message content.
 * Returns null if the message is not a slash command.
 */
export function parseSlashCommand(content: string): ParsedCommand | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('/')) return null;

  const tokens = trimmed.slice(1).trim().split(/\s+/);
  if (tokens.length === 0 || !tokens[0]) return null;

  return {
    name: tokens[0].toLowerCase(),
    args: tokens.slice(1),
    raw: trimmed,
  };
}

/**
 * Handle a slash command.
 * Returns the reply string, or null if the command is not recognized
 * (caller should fall through to normal message processing).
 */
export async function handleSlashCommand(
  message: IMMessage,
  deps: ChatCommandDeps,
): Promise<string | null> {
  const parsed = parseSlashCommand(message.content);
  if (!parsed) return null;

  switch (parsed.name) {
    case 'help':
    case '帮助':
      return buildHelpText();

    case 'status':
    case '状态':
      return buildStatusText(message, deps);

    case 'new':
    case '新会话':
      return handleNewCommand(message, deps);

    case 'compact':
    case '压缩':
      return handleCompactCommand(message, deps);

    case 'stop':
    case '停止':
      return handleStopCommand(message, deps);

    case 'version':
    case '版本':
      return buildVersionText();

    default:
      // Unknown command — return help hint instead of falling through to agent
      return t('chatCommandUnknown', { command: parsed.name });
  }
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

function buildHelpText(): string {
  return [
    t('chatCommandHelpTitle'),
    '',
    `/help — ${t('chatCommandHelpDesc')}`,
    `/status — ${t('chatCommandStatusDesc')}`,
    `/new — ${t('chatCommandNewDesc')}`,
    `/compact — ${t('chatCommandCompactDesc')}`,
    `/stop — ${t('chatCommandStopDesc')}`,
    `/version — ${t('chatCommandVersionDesc')}`,
  ].join('\n');
}

async function buildStatusText(message: IMMessage, deps: ChatCommandDeps): Promise<string> {
  const mapping = deps.imStore.getSessionMapping(message.conversationId, message.platform);
  if (!mapping) {
    return t('chatCommandStatusNoSession');
  }

  const session = deps.coworkStore.getSession(mapping.coworkSessionId);
  if (!session) {
    return t('chatCommandStatusNoSession');
  }

  const isActive = deps.coworkRuntime.isSessionActive(mapping.coworkSessionId);
  const messageCount = session.messages?.length ?? 0;
  const status = isActive ? t('chatCommandStatusRunning') : t('chatCommandStatusIdle');

  const lines = [
    t('chatCommandStatusTitle'),
    '',
    `${t('chatCommandStatusSession')}: ${mapping.coworkSessionId.slice(0, 8)}...`,
    `${t('chatCommandStatusState')}: ${status}`,
    `${t('chatCommandStatusMessages')}: ${messageCount}`,
  ];

  if (session.title) {
    lines.splice(2, 0, `${t('chatCommandStatusTitle2')}: ${session.title}`);
  }

  return lines.join('\n');
}

async function handleNewCommand(message: IMMessage, deps: ChatCommandDeps): Promise<string> {
  const mapping = deps.imStore.getSessionMapping(message.conversationId, message.platform);
  if (mapping) {
    // Stop any running session first
    if (deps.coworkRuntime.isSessionActive(mapping.coworkSessionId)) {
      deps.coworkRuntime.stopSession(mapping.coworkSessionId);
    }
  }

  try {
    await deps.forceNewSession(message.conversationId, message.platform);
    return t('chatCommandNewSuccess');
  } catch (error) {
    console.error('[ChatCommand] /new failed:', error);
    return t('chatCommandNewFailed');
  }
}

async function handleCompactCommand(message: IMMessage, deps: ChatCommandDeps): Promise<string> {
  const mapping = deps.imStore.getSessionMapping(message.conversationId, message.platform);
  if (!mapping) {
    return t('chatCommandCompactNoSession');
  }

  const session = deps.coworkStore.getSession(mapping.coworkSessionId);
  if (!session) {
    return t('chatCommandCompactNoSession');
  }

  // Stop any running turn
  if (deps.coworkRuntime.isSessionActive(mapping.coworkSessionId)) {
    deps.coworkRuntime.stopSession(mapping.coworkSessionId);
  }

  // Reset the SDK session ID — this forces the next turn to restart the SDK
  // subprocess and inject compressed local history, triggering session pruning.
  deps.coworkStore.updateSession(mapping.coworkSessionId, { claudeSessionId: null });

  const messageCount = session.messages?.length ?? 0;
  return t('chatCommandCompactSuccess', { count: String(messageCount) });
}

function handleStopCommand(message: IMMessage, deps: ChatCommandDeps): string {
  const mapping = deps.imStore.getSessionMapping(message.conversationId, message.platform);
  if (!mapping) {
    return t('chatCommandStopNoSession');
  }

  const isActive = deps.coworkRuntime.isSessionActive(mapping.coworkSessionId);
  if (!isActive) {
    return t('chatCommandStopNotRunning');
  }

  deps.coworkRuntime.stopSession(mapping.coworkSessionId);
  return t('chatCommandStopSuccess');
}

function buildVersionText(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pkg = require('../../../package.json') as { version: string; name: string };
  return `${pkg.name} v${pkg.version}`;
}
