import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  CleanupActionMode,
  CleanupCapabilityKind,
  CleanupDependencyKind,
  CONTEXT_CLEANUP_DEFAULTS,
  DECISION_MODEL_JEV_ITEM_ID,
} from '../../shared/contextCleanup/constants';
import { CapabilityUsageStore } from './capabilityUsageStore';
import {
  type CleanupAgentDescriptor,
  type CleanupMcpServerDescriptor,
  type CleanupSkillDescriptor,
  ContextCleanupService,
} from './contextCleanupService';

const MS_PER_DAY = 86_400_000;
const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-cleanup-svc-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('ContextCleanupService', () => {
  test('enforces 30d idle + 14d grace period + 1500 token threshold + dependency guards + apply/undo', async () => {
    const db = new Database(':memory:');
    const dshHome = createTempDir();
    const kv = new Map<string, unknown>();
    const kvStore = {
      get: <T,>(k: string) => kv.get(k) as T | undefined,
      set: (k: string, v: unknown) => { kv.set(k, v); },
    };
    const usageStore = new CapabilityUsageStore(db, { flushDebounceMs: 0 });

    const now = Date.UTC(2026, 10, 26, 12, 0, 0);
    const oldTs = now - 45 * MS_PER_DAY;
    const recentTs = now - 5 * MS_PER_DAY;

    // Seed 25 idle user skills (each ~70+ tokens => >1,500 tokens total),
    // plus 1 newly installed skill (5d old -> grace period),
    // 1 recently used skill (5d ago -> active),
    // 1 core builtin skill (`docx` -> dependency guard),
    // 1 skill referenced by an enabled expert (`expert-skill` -> dependency guard).
    const skills: CleanupSkillDescriptor[] = [
      ...Array.from({ length: 25 }, (_, i) => ({
        id: `idle-skill-${i}`,
        name: `Idle Skill ${i}`,
        description: '这是一个长期没有使用过的中文测试技能描述，用来检验上下文瘦身估算阈值与一键关闭功能。',
        enabled: true,
        updatedAt: oldTs,
      })),
      {
        id: 'brand-new-skill',
        name: 'Brand New Skill',
        description: 'Just installed 5 days ago.',
        enabled: true,
        updatedAt: recentTs,
      },
      {
        id: 'active-skill',
        name: 'Active Skill',
        description: 'Used 5 days ago.',
        enabled: true,
        updatedAt: oldTs,
      },
      {
        id: 'docx',
        name: 'Word',
        description: 'Built-in Word skill.',
        enabled: true,
        isBuiltIn: true,
        updatedAt: oldTs,
      },
      {
        id: 'expert-skill',
        name: 'Expert Skill',
        description: 'Bound to an enabled specialist agent.',
        enabled: true,
        updatedAt: oldTs,
      },
    ];

    usageStore.recordUsage(CleanupCapabilityKind.Skill, 'active-skill', recentTs);

    const mcpServers: CleanupMcpServerDescriptor[] = [
      {
        id: 'mcp-idle-1',
        name: 'Idle CRM',
        description: 'Unused CRM MCP',
        enabled: true,
        createdAt: oldTs,
        discoveredTools: [
          { name: 'crm_search', estimatedTokens: 320 },
          { name: 'crm_update', estimatedTokens: 280 },
        ],
      },
    ];

    const agents: CleanupAgentDescriptor[] = [
      {
        id: 'main',
        name: 'Main',
        skillIds: [],
        enabled: true,
      },
      {
        id: 'scheduled-agent',
        name: '日报专家',
        skillIds: ['expert-skill'],
        enabled: true,
      },
      {
        id: 'idle-agent',
        name: '闲置专家',
        skillIds: [],
        enabled: true,
      },
    ];

    let jevActive = true;
    const syncRuntimeConfig = vi.fn(async () => {});

    // Create a mock third-party DSH plugin entry in profile package.json.
    const profileDir = path.join(dshHome, 'profiles', 'lobsterai');
    fs.mkdirSync(profileDir, { recursive: true });
    const pkgPath = path.join(profileDir, 'package.json');
    fs.writeFileSync(pkgPath, JSON.stringify({
      dependencies: {
        '@lobsterai/dsh-bundle': 'file:../host',
        'dsh-guizang-design': '^0.1.4',
      },
    }), 'utf8');
    fs.utimesSync(pkgPath, new Date(oldTs), new Date(oldTs));

    const service = new ContextCleanupService({
      usageStore,
      kvStore,
      dshHomeDir: dshHome,
      listSkills: () => skills,
      setSkillsEnabledBatch: (ids, enabled) => {
        const set = new Set(ids);
        for (const s of skills) {
          if (set.has(s.id)) s.enabled = enabled;
        }
      },
      listMcpServers: () => mcpServers,
      setMcpServerEnabled: (id, enabled) => {
        const srv = mcpServers.find(s => s.id === id);
        if (!srv) return false;
        srv.enabled = enabled;
        return true;
      },
      listAgents: () => agents,
      isDecisionModelActive: () => jevActive,
      getDecisionModelUpdatedAt: () => oldTs,
      setDecisionModelEnabled: (enabled) => { jevActive = enabled; },
      listScheduledTasks: () => [
        { id: 'task-1', name: '每日早报', enabled: true, prompt: '/expert-skill 整理早报' },
      ],
      syncRuntimeConfig,
    });

    const scan = service.scan({ now });
    expect(scan.idleDaysThreshold).toBe(CONTEXT_CLEANUP_DEFAULTS.IdleDaysThreshold);
    expect(scan.gracePeriodDays).toBe(CONTEXT_CLEANUP_DEFAULTS.GracePeriodDays);
    expect(scan.shouldPromptInPopover).toBe(true);
    expect(scan.shouldShowBanner).toBe(true);
    expect(scan.recommendedSavableTokens).toBeGreaterThanOrEqual(
      CONTEXT_CLEANUP_DEFAULTS.PromptSavingsThresholdTokens,
    );

    const byId = new Map(scan.candidates.map(c => [`${c.kind}:${c.id}`, c]));
    // Newly installed & recently used skills must NOT appear.
    expect(byId.has(`${CleanupCapabilityKind.Skill}:brand-new-skill`)).toBe(false);
    expect(byId.has(`${CleanupCapabilityKind.Skill}:active-skill`)).toBe(false);

    // Core builtin skill and expert-bound skill appear with dependency guards and defaultSelected=false.
    expect(byId.get(`${CleanupCapabilityKind.Skill}:docx`)?.defaultSelected).toBe(false);
    expect(byId.get(`${CleanupCapabilityKind.Skill}:docx`)?.dependencies).toEqual([
      { kind: CleanupDependencyKind.CoreBuiltinSkill },
    ]);
    expect(byId.get(`${CleanupCapabilityKind.Skill}:expert-skill`)?.defaultSelected).toBe(false);
    expect(byId.get(`${CleanupCapabilityKind.Skill}:expert-skill`)?.dependencies).toEqual([
      { kind: CleanupDependencyKind.ScheduledTask, label: '每日早报' },
      { kind: CleanupDependencyKind.EnabledAgentSkill, label: '日报专家' },
    ]);

    // Specialist agents are never proposed for disabling in context cleanup.
    expect(scan.candidates.some(c => c.id === 'idle-agent' || c.id === 'scheduled-agent')).toBe(false);

    // MCP, Jev, and third-party DSH plugin detected properly.
    expect(byId.get(`${CleanupCapabilityKind.McpServer}:mcp-idle-1`)?.estimatedTokens).toBe(600);
    expect(byId.get(`${CleanupCapabilityKind.DecisionModel}:${DECISION_MODEL_JEV_ITEM_ID}`)?.defaultSelected).toBe(true);
    expect(byId.get(`${CleanupCapabilityKind.DshPlugin}:dsh-guizang-design`)?.actionMode).toBe(
      CleanupActionMode.NavigatePlugins,
    );

    // Dismiss hides banner during 30-day cooldown, but Popover prompt remains available.
    service.dismiss(now);
    const afterDismiss = service.scan({ now: now + 5 * MS_PER_DAY });
    expect(afterDismiss.shouldShowBanner).toBe(false);
    expect(afterDismiss.shouldPromptInPopover).toBe(true);

    // Apply disables selected items in one batch and supports undo.
    const toApply = scan.candidates
      .filter(c => c.defaultSelected && c.actionMode === CleanupActionMode.Toggle)
      .map(c => ({ kind: c.kind, id: c.id }));
    const applied = await service.apply(toApply);
    expect(applied.success).toBe(true);
    expect(applied.closedCount).toBe(toApply.length);
    expect(applied.undoToken).toBeTruthy();
    expect(jevActive).toBe(false);
    expect(mcpServers[0].enabled).toBe(false);
    expect(syncRuntimeConfig).toHaveBeenCalledTimes(1);

    const undone = await service.undo(applied.undoToken!);
    expect(undone).toEqual({ success: true, restoredCount: toApply.length });
    expect(jevActive).toBe(true);
    expect(mcpServers[0].enabled).toBe(true);
    expect(skills.find(s => s.id === 'idle-skill-0')?.enabled).toBe(true);
    expect(syncRuntimeConfig).toHaveBeenCalledTimes(2);

    // Reusing an already-consumed undo token fails cleanly.
    expect((await service.undo(applied.undoToken!)).success).toBe(false);
    db.close();
  });

  test('excludes canDisable=false core built-in skills from scan candidates and apply targets', async () => {
    const db = new Database(':memory:');
    const dshHome = createTempDir();
    const kv = new Map<string, unknown>();
    const kvStore = {
      get: <T,>(k: string) => kv.get(k) as T | undefined,
      set: (k: string, v: unknown) => { kv.set(k, v); },
    };
    const usageStore = new CapabilityUsageStore(db, { flushDebounceMs: 0 });
    const now = Date.UTC(2026, 10, 26, 12, 0, 0);
    const oldTs = now - 60 * MS_PER_DAY;
    const setSkillsEnabledBatch = vi.fn();

    const skills: CleanupSkillDescriptor[] = [
      {
        id: 'docx',
        name: 'Word',
        description: 'Core built-in Word skill.',
        enabled: true,
        isBuiltIn: true,
        canDisable: false,
        updatedAt: oldTs,
      },
      {
        id: 'weather',
        name: 'Weather',
        description: 'User-installed weather skill.',
        enabled: true,
        isBuiltIn: false,
        canDisable: true,
        updatedAt: oldTs,
      },
    ];

    const service = new ContextCleanupService({
      usageStore,
      kvStore,
      dshHomeDir: dshHome,
      listSkills: () => skills,
      setSkillsEnabledBatch,
      listMcpServers: () => [],
      setMcpServerEnabled: () => false,
      listAgents: () => [],
      isDecisionModelActive: () => false,
      setDecisionModelEnabled: () => {},
    });

    const scan = service.scan({ now });
    expect(scan.candidates.map((c) => c.id)).toEqual(['weather']);

    // Even if a caller passes a locked built-in skill directly to apply(), it is ignored.
    const applied = await service.apply([
      { kind: CleanupCapabilityKind.Skill, id: 'docx' },
      { kind: CleanupCapabilityKind.Skill, id: 'weather' },
    ]);
    expect(applied.closedCount).toBe(1);
    expect(setSkillsEnabledBatch).toHaveBeenCalledWith(['weather'], false);
    db.close();
  });
});
