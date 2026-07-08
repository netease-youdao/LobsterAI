import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  HEARTBEAT_EMPTY_TEMPLATE,
  isLegacyHeartbeatTemplate,
  repairHeartbeatFile,
  stripProactiveHeartbeatSection,
} from './openclawHeartbeatRepair';

const LEGACY_PROSE = [
  '# HEARTBEAT.md',
  'Keep this file empty unless you want a tiny checklist. Keep it small.',
].join('\n');

const LEGACY_HEADING_FENCED = [
  '# HEARTBEAT.md Template',
  '```markdown',
  '# Keep this file empty (or with only comments) to skip heartbeat API calls.',
  '# Add tasks below when you want the agent to check something periodically.',
  '```',
].join('\n');

const LEGACY_FENCED = [
  '```markdown',
  '# Keep this file empty (or with only comments) to skip heartbeat API calls.',
  '# Add tasks below when you want the agent to check something periodically.',
  '```',
].join('\n');

const LEGACY_FENCED_RELATED = [
  '```markdown',
  '# Keep this file empty (or with only comments) to skip heartbeat API calls.',
  '# Add tasks below when you want the agent to check something periodically.',
  '```',
  '## Related',
  '- [Heartbeat config](/gateway/config-agents)',
].join('\n');

const DOCS_PAGE_TEMPLATE = [
  '# HEARTBEAT.md template',
  '`HEARTBEAT.md` lives in the agent workspace. Keep the file empty, or with only Markdown comments and headings, when you want OpenClaw to skip heartbeat model calls.',
  'The default runtime template is:',
  '```markdown',
  '# Keep this file empty (or with only comments) to skip heartbeat API calls.',
  '# Add tasks below when you want the agent to check something periodically.',
  '```',
  'Add short tasks below the comments only when you want the agent to check something periodically. Keep heartbeat instructions small because they are read during recurring wakes.',
  '## Related',
  '- [Heartbeat config](/gateway/config-agents)',
].join('\n');

describe('isLegacyHeartbeatTemplate', () => {
  test('matches all known legacy template variants', () => {
    for (const template of [
      LEGACY_PROSE,
      LEGACY_HEADING_FENCED,
      LEGACY_FENCED,
      LEGACY_FENCED_RELATED,
      DOCS_PAGE_TEMPLATE,
    ]) {
      expect(isLegacyHeartbeatTemplate(template)).toBe(true);
    }
  });

  test('matches templates with CRLF line endings and trailing whitespace', () => {
    const crlf = LEGACY_PROSE.split('\n')
      .map((line) => `${line}  `)
      .join('\r\n');
    expect(isLegacyHeartbeatTemplate(`${crlf}\r\n`)).toBe(true);
  });

  test('does not match empty or whitespace-only content', () => {
    expect(isLegacyHeartbeatTemplate('')).toBe(false);
    expect(isLegacyHeartbeatTemplate('\n\n  \n')).toBe(false);
  });

  test('does not match user content', () => {
    expect(isLegacyHeartbeatTemplate('- Check my repo issues every hour')).toBe(false);
  });

  test('does not match a legacy template mixed with custom lines', () => {
    expect(isLegacyHeartbeatTemplate(`${LEGACY_FENCED}\n- Watch the deploy pipeline`)).toBe(false);
  });

  test('does not match the replacement empty template', () => {
    expect(isLegacyHeartbeatTemplate(HEARTBEAT_EMPTY_TEMPLATE)).toBe(false);
  });
});

describe('repairHeartbeatFile', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heartbeat-repair-'));
  });

  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  const heartbeatPath = () => path.join(workspaceDir, 'HEARTBEAT.md');

  test('replaces a legacy template with the empty template', () => {
    fs.writeFileSync(heartbeatPath(), LEGACY_PROSE, 'utf8');
    expect(repairHeartbeatFile(workspaceDir)).toBe(true);
    expect(fs.readFileSync(heartbeatPath(), 'utf8')).toBe(HEARTBEAT_EMPTY_TEMPLATE);
  });

  test('creates the empty template when the file is missing', () => {
    expect(repairHeartbeatFile(workspaceDir)).toBe(true);
    expect(fs.readFileSync(heartbeatPath(), 'utf8')).toBe(HEARTBEAT_EMPTY_TEMPLATE);
  });

  test('leaves user content untouched', () => {
    const content = '- Watch issue #42 and summarize new replies\n';
    fs.writeFileSync(heartbeatPath(), content, 'utf8');
    expect(repairHeartbeatFile(workspaceDir)).toBe(false);
    expect(fs.readFileSync(heartbeatPath(), 'utf8')).toBe(content);
  });

  test('leaves an empty file untouched', () => {
    fs.writeFileSync(heartbeatPath(), '', 'utf8');
    expect(repairHeartbeatFile(workspaceDir)).toBe(false);
    expect(fs.readFileSync(heartbeatPath(), 'utf8')).toBe('');
  });

  test('is idempotent after a repair', () => {
    fs.writeFileSync(heartbeatPath(), LEGACY_HEADING_FENCED, 'utf8');
    expect(repairHeartbeatFile(workspaceDir)).toBe(true);
    expect(repairHeartbeatFile(workspaceDir)).toBe(false);
    expect(fs.readFileSync(heartbeatPath(), 'utf8')).toBe(HEARTBEAT_EMPTY_TEMPLATE);
  });

  test('skips when the workspace directory does not exist', () => {
    const missingDir = path.join(workspaceDir, 'not-created');
    expect(repairHeartbeatFile(missingDir)).toBe(false);
    expect(fs.existsSync(missingDir)).toBe(false);
  });
});

describe('stripProactiveHeartbeatSection', () => {
  const template = [
    '# AGENTS.md',
    '',
    '## Tools',
    'Use tools well.',
    '',
    '## 💓 Heartbeats - Be Proactive!',
    '',
    "Don't just reply HEARTBEAT_OK every time. Use heartbeats productively!",
    '',
    '### Heartbeat vs Cron: When to Use Each',
    '- batch checks together',
    '',
    '## Make It Yours',
    'Edit freely.',
  ].join('\n');

  test('removes the section up to the next H2 heading', () => {
    const result = stripProactiveHeartbeatSection(template);
    expect(result).not.toContain('Be Proactive!');
    expect(result).not.toContain('Heartbeat vs Cron');
    expect(result).toContain('## Tools');
    expect(result).toContain('## Make It Yours');
  });

  test('returns content unchanged when the section is absent', () => {
    const content = '# AGENTS.md\n\n## Tools\n';
    expect(stripProactiveHeartbeatSection(content)).toBe(content);
  });

  test('removes a trailing section with no following H2 heading', () => {
    const content = [
      '## Tools',
      '',
      '## 💓 Heartbeats - Be Proactive!',
      'go check emails',
    ].join('\n');
    const result = stripProactiveHeartbeatSection(content);
    expect(result).not.toContain('go check emails');
    expect(result.trimEnd()).toBe('## Tools');
  });

  test('strips the section from the real bundled runtime template when present', () => {
    const templatePath = path.join(
      process.cwd(),
      'vendor',
      'openclaw-runtime',
      'current',
      'docs',
      'reference',
      'templates',
      'AGENTS.md',
    );
    let bundled: string;
    try {
      bundled = fs.readFileSync(templatePath, 'utf8');
    } catch {
      return; // runtime not built in this checkout — covered by the fixture tests above
    }
    const result = stripProactiveHeartbeatSection(bundled);
    expect(result).not.toContain('Be Proactive!');
    expect(result).not.toContain('Track your checks');
  });
});
