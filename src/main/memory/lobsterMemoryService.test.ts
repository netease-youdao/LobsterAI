import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import {
  LobsterMemoryService,
  stripManagedAgentsSection,
  WorkspaceFileName,
} from './lobsterMemoryService';

const tempDirs: string[] = [];
const services: LobsterMemoryService[] = [];

function createService(): LobsterMemoryService {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-memory-'));
  tempDirs.push(dir);
  const service = new LobsterMemoryService(dir);
  services.push(service);
  return service;
}

afterEach(() => {
  while (services.length > 0) services.pop()?.close();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('LobsterMemoryService', () => {
  test('performs surgical CRUD on MEMORY.md and indexes CJK + English via FTS5', () => {
    const service = createService();

    const added = service.addMemory('main', '用户偏好使用中文回复，代码注释保持英文', 'Preferences');
    service.addMemory('main', 'Project uses Electron 43 and Node 24 runtime', 'Tech Stack');

    const entries = service.listMemories('main');
    expect(entries).toHaveLength(2);
    expect(entries[0].section).toBe('Preferences');

    // 3+ char CJK trigram search
    const cjkHits = service.search('main', '中文回复');
    expect(cjkHits.length).toBeGreaterThan(0);
    expect(cjkHits[0].relPath).toBe(WorkspaceFileName.Memory);

    // Short 2-char CJK fallback search
    const shortCjkHits = service.search('main', '中文');
    expect(shortCjkHits.length).toBeGreaterThan(0);

    // English search
    const enHits = service.search('main', 'Electron 43');
    expect(enHits.length).toBeGreaterThan(0);

    // Update & delete
    const updated = service.updateMemory('main', added.id, '用户偏好简洁中文回复');
    expect(updated?.text).toBe('用户偏好简洁中文回复');
    expect(service.search('main', '简洁中文')).toHaveLength(1);

    expect(service.deleteMemory('main', updated!.id)).toBe(true);
    expect(service.listMemories('main')).toHaveLength(1);
  });

  test('isolates workspaces per agentId and indexes daily memory notes', () => {
    const service = createService();

    service.writeWorkspaceFile('agent-a', WorkspaceFileName.Soul, 'You are Agent A.');
    const relPath = service.appendDailyNote('agent-a', '今天完成了季度财报分析', new Date('2026-11-19T10:00:00Z'));
    expect(relPath).toBe('memory/2026-11-19.md');

    const bundleA = service.readPersonaBundle('agent-a');
    expect(bundleA.soul).toBe('You are Agent A.');

    expect(service.search('agent-a', '季度财报')).toHaveLength(1);
    expect(service.search('main', '季度财报')).toHaveLength(0);

    const snippet = service.readMemorySnippet('agent-a', relPath, 1, 10);
    expect(snippet).toContain('季度财报分析');
  });

  test('rejects path traversal in readMemorySnippet', () => {
    const service = createService();
    service.ensureAgentWorkspace('main');
    expect(() => service.readMemorySnippet('main', '../secret.txt')).toThrow(/outside agent workspace/i);
  });
});

describe('stripManagedAgentsSection', () => {
  test('keeps user instructions and removes legacy LobsterAI managed block', () => {
    const raw = [
      '# My Custom Rules',
      'Always format tables cleanly.',
      '',
      '<!-- LobsterAI managed: do not edit below this line -->',
      '## Managed OpenClaw Instructions',
      'Internal policy text',
    ].join('\n');

    expect(stripManagedAgentsSection(raw)).toBe('# My Custom Rules\nAlways format tables cleanly.');
  });

  test('strips OpenClaw stock AGENTS.md workspace boilerplate while preserving trailing user rules', () => {
    const stock = [
      '# AGENTS.md - Your Workspace',
      '',
      'This folder is home. Treat it that way.',
      '',
      '## First Run',
      'If `BOOTSTRAP.md` exists, follow it.',
      '',
      '## Tools',
      'Voice storytelling: sag ElevenLabs TTS',
      '',
      '## Make It Yours',
      '',
      'This is a starting point. Add your own conventions, style, and rules as you figure out what works.',
      '',
      '## Related',
      '',
      '- [Default AGENTS.md](/reference/AGENTS.default)',
      '- [Heartbeat](/gateway/heartbeat)',
    ].join('\n');

    expect(stripManagedAgentsSection(stock)).toBe('');
    expect(stripManagedAgentsSection(`${stock}\n\n## 我的自定义规则\n- 回复始终带目录`)).toBe(
      '## 我的自定义规则\n- 回复始终带目录',
    );
  });

  test('preserves non-OpenClaw custom AGENTS.md manuals intact', () => {
    const custom = '# AGENTS.md — 抖音带货官工作手册\n\n- 选品先看佣金率与复购率';
    expect(stripManagedAgentsSection(custom)).toBe(custom);
  });
});
