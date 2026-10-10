import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { buildScheduledTaskEnginePrompt } from '../../../scheduledTask/enginePrompt';
import {
  OPENCLAW_BOOTSTRAP_MAX_CHARS,
  removeWorkspaceDeliveredInstructions,
  removeWorkspaceDeliveredSections,
  resolveOpenClawAgentWorkspaceDir,
} from './workspaceDeliveredInstructions';

const MARKER = '<!-- LobsterAI managed: do not edit below this line -->';
const DEFAULT_SYSTEM_PROMPT = '# Style\n- Keep replies concise.\n\n# File Paths\n- Link files with file:// URLs.';
const SCHEDULED_TASK_PROMPT = buildScheduledTaskEnginePrompt();
const SKILL_PROMPT = '## Selected skills\n- Use the docx skill for this request.';

const buildAgentsMd = (...sections: string[]): string => (
  `# AGENTS.md - Your Workspace\n\nUser notes.\n\n${MARKER}\n\n${sections.join('\n\n')}\n`
);

describe('removeWorkspaceDeliveredSections', () => {
  test('removes sections that AGENTS.md already carries and keeps the rest', () => {
    const systemPrompt = [SCHEDULED_TASK_PROMPT, SKILL_PROMPT, DEFAULT_SYSTEM_PROMPT].join('\n\n');
    const agentsMd = buildAgentsMd(`## System Prompt\n\n${DEFAULT_SYSTEM_PROMPT}`, SCHEDULED_TASK_PROMPT);

    expect(removeWorkspaceDeliveredSections(
      systemPrompt,
      agentsMd,
      [DEFAULT_SYSTEM_PROMPT, SCHEDULED_TASK_PROMPT],
    )).toBe(SKILL_PROMPT);
  });

  test('returns an empty prompt when AGENTS.md carries every section', () => {
    const systemPrompt = [SCHEDULED_TASK_PROMPT, DEFAULT_SYSTEM_PROMPT].join('\n\n');
    const agentsMd = buildAgentsMd(DEFAULT_SYSTEM_PROMPT, SCHEDULED_TASK_PROMPT);

    expect(removeWorkspaceDeliveredSections(
      systemPrompt,
      agentsMd,
      [DEFAULT_SYSTEM_PROMPT, SCHEDULED_TASK_PROMPT],
    )).toBe('');
  });

  test('keeps a section that AGENTS.md does not carry', () => {
    // Non-main agents put their own prompt in AGENTS.md, not the default one.
    const systemPrompt = [SCHEDULED_TASK_PROMPT, DEFAULT_SYSTEM_PROMPT].join('\n\n');
    const agentsMd = buildAgentsMd('## System Prompt\n\nYou are a translator.', SCHEDULED_TASK_PROMPT);

    expect(removeWorkspaceDeliveredSections(
      systemPrompt,
      agentsMd,
      [DEFAULT_SYSTEM_PROMPT, SCHEDULED_TASK_PROMPT],
    )).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  test('keeps the prompt unchanged when AGENTS.md is missing', () => {
    const systemPrompt = [SCHEDULED_TASK_PROMPT, DEFAULT_SYSTEM_PROMPT].join('\n\n');

    expect(removeWorkspaceDeliveredSections(
      systemPrompt,
      null,
      [DEFAULT_SYSTEM_PROMPT, SCHEDULED_TASK_PROMPT],
    )).toBe(systemPrompt);
  });

  test('keeps the prompt unchanged when OpenClaw would truncate AGENTS.md', () => {
    const systemPrompt = [SCHEDULED_TASK_PROMPT, DEFAULT_SYSTEM_PROMPT].join('\n\n');
    const agentsMd = buildAgentsMd(
      'x'.repeat(OPENCLAW_BOOTSTRAP_MAX_CHARS),
      DEFAULT_SYSTEM_PROMPT,
      SCHEDULED_TASK_PROMPT,
    );

    expect(removeWorkspaceDeliveredSections(
      systemPrompt,
      agentsMd,
      [DEFAULT_SYSTEM_PROMPT, SCHEDULED_TASK_PROMPT],
    )).toBe(systemPrompt);
  });

  test('ignores empty sections', () => {
    const agentsMd = buildAgentsMd(SCHEDULED_TASK_PROMPT);

    expect(removeWorkspaceDeliveredSections(SKILL_PROMPT, agentsMd, ['', '   '])).toBe(SKILL_PROMPT);
  });
});

describe('resolveOpenClawAgentWorkspaceDir', () => {
  test('maps the main agent to workspace-main and others to workspace-<id>', () => {
    expect(resolveOpenClawAgentWorkspaceDir('/state')).toBe(path.join('/state', 'workspace-main'));
    expect(resolveOpenClawAgentWorkspaceDir('/state', 'main')).toBe(path.join('/state', 'workspace-main'));
    expect(resolveOpenClawAgentWorkspaceDir('/state', 'writer')).toBe(path.join('/state', 'workspace-writer'));
  });
});

describe('removeWorkspaceDeliveredInstructions', () => {
  let stateDir = '';

  afterEach(() => {
    if (stateDir) {
      fs.rmSync(stateDir, { recursive: true, force: true });
      stateDir = '';
    }
  });

  const writeAgentsMd = (agentId: string, content: string): void => {
    const workspaceDir = resolveOpenClawAgentWorkspaceDir(stateDir, agentId);
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'AGENTS.md'), content, 'utf8');
  };

  test('reads the agent workspace AGENTS.md to decide what to remove', () => {
    stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-agents-md-')));
    writeAgentsMd('main', buildAgentsMd(`## System Prompt\n\n${DEFAULT_SYSTEM_PROMPT}`, SCHEDULED_TASK_PROMPT));
    writeAgentsMd('writer', buildAgentsMd('## System Prompt\n\nYou are a writer.', SCHEDULED_TASK_PROMPT));
    const systemPrompt = [SCHEDULED_TASK_PROMPT, SKILL_PROMPT, DEFAULT_SYSTEM_PROMPT].join('\n\n');

    expect(removeWorkspaceDeliveredInstructions({
      systemPrompt,
      stateDir,
      agentId: 'main',
      defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,
    })).toBe(SKILL_PROMPT);
    expect(removeWorkspaceDeliveredInstructions({
      systemPrompt,
      stateDir,
      agentId: 'writer',
      defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,
    })).toBe([SKILL_PROMPT, DEFAULT_SYSTEM_PROMPT].join('\n\n'));
  });

  test('keeps the full prompt when the agent workspace has no AGENTS.md yet', () => {
    stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-agents-md-')));
    const systemPrompt = [SCHEDULED_TASK_PROMPT, DEFAULT_SYSTEM_PROMPT].join('\n\n');

    expect(removeWorkspaceDeliveredInstructions({
      systemPrompt,
      stateDir,
      agentId: 'missing-agent',
      defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,
    })).toBe(systemPrompt);
  });
});
