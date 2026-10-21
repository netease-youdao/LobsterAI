import * as fs from 'fs';
import * as path from 'path';

import { buildScheduledTaskEnginePrompt } from '../../../scheduledTask/enginePrompt';
import { AgentId } from '../../../shared/agent/constants';
import { getMainAgentWorkspacePath } from '../openclawMemoryFile';

/**
 * OpenClaw truncates any workspace bootstrap file longer than this before
 * injecting it into the system prompt (`DEFAULT_BOOTSTRAP_MAX_CHARS` in
 * OpenClaw). LobsterAI does not set `agents.defaults.bootstrapMaxChars`, so the
 * default applies; update this if the config sync ever starts overriding it.
 */
export const OPENCLAW_BOOTSTRAP_MAX_CHARS = 20_000;

const AGENTS_MD_FILENAME = 'AGENTS.md';

export const resolveOpenClawAgentWorkspaceDir = (stateDir: string, agentId?: string): string => {
  const normalizedAgentId = agentId?.trim() || AgentId.Main;
  return normalizedAgentId === AgentId.Main
    ? getMainAgentWorkspacePath(stateDir)
    : path.join(stateDir, `workspace-${normalizedAgentId}`);
};

/**
 * Remove instruction sections that the agent's AGENTS.md already delivers.
 *
 * OpenClaw injects the whole AGENTS.md into the system prompt of every session,
 * so repeating one of its sections in the desktop `[LobsterAI system
 * instructions]` block only spends tokens (issue #2440). A section is removed
 * only when it appears verbatim in AGENTS.md and the file fits OpenClaw's
 * bootstrap budget; otherwise OpenClaw truncates the file and the injected
 * copy may be the only complete one, so the prompt is returned unchanged.
 */
export const removeWorkspaceDeliveredSections = (
  systemPrompt: string,
  agentsMdContent: string | null,
  sections: readonly string[],
  maxChars = OPENCLAW_BOOTSTRAP_MAX_CHARS,
): string => {
  if (!agentsMdContent || agentsMdContent.trimEnd().length > maxChars) {
    return systemPrompt;
  }

  let remaining = systemPrompt;
  for (const section of sections) {
    const normalizedSection = section.trim();
    if (normalizedSection && agentsMdContent.includes(normalizedSection)) {
      remaining = remaining.replaceAll(normalizedSection, '');
    }
  }

  return remaining === systemPrompt
    ? systemPrompt
    : remaining.replace(/\n{3,}/g, '\n\n').trim();
};

const readAgentsMd = (workspaceDir: string): string | null => {
  try {
    return fs.readFileSync(path.join(workspaceDir, AGENTS_MD_FILENAME), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
};

/**
 * Strip the app-level instructions that LobsterAI also writes into the agent's
 * AGENTS.md managed section (the default system prompt and the scheduled-task
 * policy) from a session system prompt before it is injected into a message.
 */
export const removeWorkspaceDeliveredInstructions = (options: {
  systemPrompt: string;
  stateDir: string;
  agentId?: string;
  defaultSystemPrompt?: string;
}): string => removeWorkspaceDeliveredSections(
  options.systemPrompt,
  readAgentsMd(resolveOpenClawAgentWorkspaceDir(options.stateDir, options.agentId)),
  [options.defaultSystemPrompt ?? '', buildScheduledTaskEnginePrompt()],
);
