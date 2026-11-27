import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { AgentId } from '../../shared/agent/constants';
import {
  CleanupActionMode,
  CleanupCapabilityKind,
  CleanupDependencyKind,
  CONTEXT_CLEANUP_DEFAULTS,
  CONTEXT_CLEANUP_KV_KEYS,
  CORE_BUILTIN_SKILL_IDS,
  DECISION_MODEL_JEV_ITEM_ID,
} from '../../shared/contextCleanup/constants';
import type {
  ContextCleanupApplyResult,
  ContextCleanupCandidate,
  ContextCleanupDependency,
  ContextCleanupScanResult,
  ContextCleanupTargetItem,
  ContextCleanupUndoResult,
} from '../../shared/contextCleanup/types';
import type { CapabilityUsageKvStore, CapabilityUsageStore } from './capabilityUsageStore';
import { makeUsageKey } from './capabilityUsageStore';
import {
  estimateDecisionEvaluateTokens,
  estimateMcpServerTokensFromTools,
  estimateSkillCatalogTokens,
} from './tokenEstimator';

const MS_PER_DAY = 86_400_000;

export interface CleanupSkillDescriptor {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  isBuiltIn?: boolean;
  updatedAt?: number;
  skillDirPath?: string;
}

export interface CleanupMcpServerDescriptor {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  createdAt: number;
  discoveredTools?: ReadonlyArray<{ name: string; estimatedTokens?: number }>;
}

export interface CleanupAgentDescriptor {
  id: string;
  name: string;
  skillIds: string[];
  enabled: boolean;
}

export interface CleanupScheduledTaskDescriptor {
  id: string;
  name: string;
  enabled: boolean;
  prompt?: string;
}

export interface ContextCleanupServiceDeps {
  usageStore: CapabilityUsageStore;
  kvStore: CapabilityUsageKvStore;
  dshHomeDir: string;
  listSkills: () => CleanupSkillDescriptor[];
  setSkillsEnabledBatch: (ids: readonly string[], enabled: boolean) => void | Promise<void>;
  listMcpServers: () => CleanupMcpServerDescriptor[];
  setMcpServerEnabled: (id: string, enabled: boolean) => boolean | Promise<boolean>;
  listAgents: () => CleanupAgentDescriptor[];
  isDecisionModelActive: () => boolean;
  getDecisionModelUpdatedAt?: () => number | null;
  setDecisionModelEnabled: (enabled: boolean) => void | Promise<void>;
  listScheduledTasks?: () => CleanupScheduledTaskDescriptor[];
  syncRuntimeConfig?: (reason: string) => Promise<void>;
  catalogDescriptionMaxChars?: number;
}

interface UndoSnapshot {
  createdAt: number;
  items: ContextCleanupTargetItem[];
}

function normalizeServerLookupKey(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
}

function getFileCreatedOrMtimeMs(targetPath: string | undefined, fallback: number): number {
  if (!targetPath) return fallback;
  try {
    const stat = fs.statSync(targetPath);
    const candidate = stat.birthtimeMs && stat.birthtimeMs > 0 ? Math.min(stat.birthtimeMs, stat.mtimeMs) : stat.mtimeMs;
    return Number.isFinite(candidate) && candidate > 0 ? Math.floor(candidate) : fallback;
  } catch {
    return fallback;
  }
}

function listThirdPartyDshPlugins(dshHomeDir: string, fallbackTime: number): Array<{
  id: string;
  name: string;
  installedAt: number;
}> {
  const pkgPath = path.join(dshHomeDir, 'profiles', 'lobsterai', 'package.json');
  if (!fs.existsSync(pkgPath)) return [];
  try {
    const stat = fs.statSync(pkgPath);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const deps = pkg?.dependencies ?? {};
    const plugins: Array<{ id: string; name: string; installedAt: number }> = [];
    for (const pkgName of Object.keys(deps)) {
      if (pkgName.startsWith('@deepseek-ai/') || pkgName.startsWith('@lobsterai/')) continue;
      const pkgDir = path.join(dshHomeDir, 'profiles', 'lobsterai', 'node_modules', pkgName);
      const installedAt = getFileCreatedOrMtimeMs(pkgDir, Math.floor(stat.mtimeMs) || fallbackTime);
      plugins.push({ id: pkgName, name: pkgName, installedAt });
    }
    return plugins;
  } catch {
    return [];
  }
}

export class ContextCleanupService {
  private readonly deps: ContextCleanupServiceDeps;
  private readonly undoSnapshots = new Map<string, UndoSnapshot>();

  constructor(deps: ContextCleanupServiceDeps) {
    this.deps = deps;
  }

  scan(options?: { idleDays?: number; now?: number }): ContextCleanupScanResult {
    const now = options?.now ?? Date.now();
    const idleDaysThreshold = options?.idleDays ?? CONTEXT_CLEANUP_DEFAULTS.IdleDaysThreshold;
    const gracePeriodDays = CONTEXT_CLEANUP_DEFAULTS.GracePeriodDays;
    const promptSavingsThresholdTokens = CONTEXT_CLEANUP_DEFAULTS.PromptSavingsThresholdTokens;
    const catalogDescMaxChars =
      this.deps.catalogDescriptionMaxChars ?? CONTEXT_CLEANUP_DEFAULTS.DefaultCatalogDescriptionMaxChars;

    const skills = this.deps.listSkills();
    const mcpServers = this.deps.listMcpServers();
    const agents = this.deps.listAgents();
    const decisionModelActive = this.deps.isDecisionModelActive();
    const scheduledTasks = this.deps.listScheduledTasks?.() ?? [];
    const thirdPartyPlugins = listThirdPartyDshPlugins(this.deps.dshHomeDir, now);

    // Map normalized MCP server names -> IDs for history backfill.
    const mcpNameToId = new Map<string, string>();
    for (const srv of mcpServers) {
      mcpNameToId.set(srv.name.trim().toLowerCase(), srv.id);
      mcpNameToId.set(normalizeServerLookupKey(srv.name), srv.id);
      mcpNameToId.set(srv.id.trim().toLowerCase(), srv.id);
    }

    this.deps.usageStore.backfillFromDshHistoryOnce({
      dshHomeDir: this.deps.dshHomeDir,
      kvStore: this.deps.kvStore,
      mcpServerNameToId: mcpNameToId,
      now,
    });

    // Seed `first_seen_at` for currently enabled items so newly installed items get the 14-day grace period,
    // while pre-existing items inherit their real disk/DB creation timestamps.
    const firstSeenSeeds: Array<{ kind: CleanupCapabilityKind; itemId: string; firstSeenAt: number }> = [];
    for (const skill of skills) {
      if (!skill.enabled) continue;
      const seedTs = getFileCreatedOrMtimeMs(skill.skillDirPath, skill.updatedAt ?? now);
      firstSeenSeeds.push({ kind: CleanupCapabilityKind.Skill, itemId: skill.id, firstSeenAt: seedTs });
    }
    for (const srv of mcpServers) {
      if (!srv.enabled) continue;
      firstSeenSeeds.push({
        kind: CleanupCapabilityKind.McpServer,
        itemId: srv.id,
        firstSeenAt: srv.createdAt > 0 ? srv.createdAt : now,
      });
    }
    if (decisionModelActive) {
      const jevTs = this.deps.getDecisionModelUpdatedAt?.() ?? now;
      firstSeenSeeds.push({
        kind: CleanupCapabilityKind.DecisionModel,
        itemId: DECISION_MODEL_JEV_ITEM_ID,
        firstSeenAt: jevTs > 0 ? jevTs : now,
      });
    }
    for (const plugin of thirdPartyPlugins) {
      firstSeenSeeds.push({
        kind: CleanupCapabilityKind.DshPlugin,
        itemId: plugin.id,
        firstSeenAt: plugin.installedAt,
      });
    }
    this.deps.usageStore.ensureFirstSeen(firstSeenSeeds, now);

    const usageMap = this.deps.usageStore.getUsageMap();

    // Build dependency indices.
    const skillAgentDeps = new Map<string, string[]>();
    for (const agent of agents) {
      if (!agent.enabled || agent.id === AgentId.Main) continue;
      for (const skillId of agent.skillIds) {
        const clean = skillId.trim();
        if (!clean) continue;
        const list = skillAgentDeps.get(clean) ?? [];
        list.push(agent.name || agent.id);
        skillAgentDeps.set(clean, list);
      }
    }

    const scheduledSkillDeps = new Map<string, string[]>();
    for (const task of scheduledTasks) {
      if (!task.enabled) continue;
      const taskLabel = task.name || task.id;
      if (typeof task.prompt === 'string' && task.prompt.trim()) {
        for (const skill of skills) {
          if (!skill.enabled) continue;
          const escaped = skill.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          if (new RegExp(`(?:^|\\s)/${escaped}(?:$|\\s)`, 'i').test(task.prompt)) {
            const list = scheduledSkillDeps.get(skill.id) ?? [];
            list.push(taskLabel);
            scheduledSkillDeps.set(skill.id, list);
          }
        }
      }
    }

    const candidates: ContextCleanupCandidate[] = [];

    const evaluateIdle = (kind: CleanupCapabilityKind, id: string, fallbackFirstSeen: number) => {
      const row = usageMap.get(makeUsageKey(kind, id));
      const firstSeenAt = row?.firstSeenAt ?? fallbackFirstSeen;
      const lastUsedAt = row?.lastUsedAt ?? null;
      const enabledDays = Math.max(0, Math.floor((now - firstSeenAt) / MS_PER_DAY));
      const idleDays = lastUsedAt !== null ? Math.max(0, Math.floor((now - lastUsedAt) / MS_PER_DAY)) : null;
      if (enabledDays < gracePeriodDays) return null;
      if (idleDays !== null && idleDays < idleDaysThreshold) return null;
      return { lastUsedAt, idleDays, enabledDays };
    };

    // 1. Skills
    for (const skill of skills) {
      if (!skill.enabled) continue;
      const idle = evaluateIdle(CleanupCapabilityKind.Skill, skill.id, skill.updatedAt ?? now);
      if (!idle) continue;
      const dependencies: ContextCleanupDependency[] = [];
      if (CORE_BUILTIN_SKILL_IDS.has(skill.id.toLowerCase())) {
        dependencies.push({ kind: CleanupDependencyKind.CoreBuiltinSkill });
      }
      for (const taskName of scheduledSkillDeps.get(skill.id) ?? []) {
        dependencies.push({ kind: CleanupDependencyKind.ScheduledTask, label: taskName });
      }
      for (const agentName of skillAgentDeps.get(skill.id) ?? []) {
        dependencies.push({ kind: CleanupDependencyKind.EnabledAgentSkill, label: agentName });
      }
      candidates.push({
        kind: CleanupCapabilityKind.Skill,
        id: skill.id,
        name: skill.name || skill.id,
        description: skill.description || '',
        estimatedTokens: estimateSkillCatalogTokens(skill.id, skill.description || '', catalogDescMaxChars),
        lastUsedAt: idle.lastUsedAt,
        idleDays: idle.idleDays,
        enabledDays: idle.enabledDays,
        dependencies,
        defaultSelected: dependencies.length === 0,
        actionMode: CleanupActionMode.Toggle,
      });
    }

    // 2. MCP Servers
    for (const srv of mcpServers) {
      if (!srv.enabled) continue;
      const idle = evaluateIdle(CleanupCapabilityKind.McpServer, srv.id, srv.createdAt || now);
      if (!idle) continue;
      const tokenEst = estimateMcpServerTokensFromTools(srv.discoveredTools);
      candidates.push({
        kind: CleanupCapabilityKind.McpServer,
        id: srv.id,
        name: srv.name || srv.id,
        description: srv.description || '',
        estimatedTokens: tokenEst.tokens,
        ...(tokenEst.unknown ? { estimatedTokensUnknown: true } : {}),
        lastUsedAt: idle.lastUsedAt,
        idleDays: idle.idleDays,
        enabledDays: idle.enabledDays,
        dependencies: [],
        defaultSelected: true,
        actionMode: CleanupActionMode.Toggle,
      });
    }

    // 3. Experimental Jev Decision Model
    if (decisionModelActive) {
      const idle = evaluateIdle(
        CleanupCapabilityKind.DecisionModel,
        DECISION_MODEL_JEV_ITEM_ID,
        this.deps.getDecisionModelUpdatedAt?.() ?? now,
      );
      if (idle) {
        candidates.push({
          kind: CleanupCapabilityKind.DecisionModel,
          id: DECISION_MODEL_JEV_ITEM_ID,
          name: 'Jev (decision_evaluate)',
          description: '',
          estimatedTokens: estimateDecisionEvaluateTokens(),
          lastUsedAt: idle.lastUsedAt,
          idleDays: idle.idleDays,
          enabledDays: idle.enabledDays,
          dependencies: [],
          defaultSelected: true,
          actionMode: CleanupActionMode.Toggle,
        });
      }
    }

    // 5. Third-party DSH Plugins (navigate-only; never silently uninstalled)
    for (const plugin of thirdPartyPlugins) {
      const idle = evaluateIdle(CleanupCapabilityKind.DshPlugin, plugin.id, plugin.installedAt);
      if (!idle) continue;
      candidates.push({
        kind: CleanupCapabilityKind.DshPlugin,
        id: plugin.id,
        name: plugin.name,
        description: '',
        estimatedTokens: 0,
        estimatedTokensUnknown: true,
        lastUsedAt: idle.lastUsedAt,
        idleDays: idle.idleDays,
        enabledDays: idle.enabledDays,
        dependencies: [],
        defaultSelected: false,
        actionMode: CleanupActionMode.NavigatePlugins,
      });
    }

    candidates.sort((a, b) => {
      if (b.estimatedTokens !== a.estimatedTokens) return b.estimatedTokens - a.estimatedTokens;
      return a.name.localeCompare(b.name);
    });

    let totalSavableTokens = 0;
    let recommendedSavableTokens = 0;
    for (const item of candidates) {
      if (item.actionMode !== CleanupActionMode.Toggle) continue;
      totalSavableTokens += item.estimatedTokens;
      if (item.defaultSelected) {
        recommendedSavableTokens += item.estimatedTokens;
      }
    }

    const rawDismissedAt = this.deps.kvStore.get<number>(CONTEXT_CLEANUP_KV_KEYS.DismissedAt);
    const dismissedAt = typeof rawDismissedAt === 'number' && Number.isFinite(rawDismissedAt) ? rawDismissedAt : null;
    const isDismissedWithinCooldown =
      dismissedAt !== null
      && now - dismissedAt < CONTEXT_CLEANUP_DEFAULTS.DismissCooldownDays * MS_PER_DAY;

    const meetsThreshold = recommendedSavableTokens >= promptSavingsThresholdTokens;

    return {
      scannedAt: now,
      idleDaysThreshold,
      gracePeriodDays,
      promptSavingsThresholdTokens,
      candidates,
      totalSavableTokens,
      recommendedSavableTokens,
      shouldPromptInPopover: meetsThreshold,
      shouldShowBanner: meetsThreshold && !isDismissedWithinCooldown,
      dismissedAt,
    };
  }

  async apply(items: readonly ContextCleanupTargetItem[]): Promise<ContextCleanupApplyResult> {
    if (!Array.isArray(items) || items.length === 0) {
      return { success: true, closedCount: 0, savedTokens: 0, undoToken: null, failedItems: [] };
    }

    // Snapshot estimated savings before disabling.
    const scanBefore = this.scan();
    const tokenLookup = new Map<string, number>();
    for (const candidate of scanBefore.candidates) {
      tokenLookup.set(makeUsageKey(candidate.kind, candidate.id), candidate.estimatedTokens);
    }

    const skillIds: string[] = [];
    const mcpIds: string[] = [];
    let disableJev = false;
    const seen = new Set<string>();

    for (const item of items) {
      if (!item || typeof item.id !== 'string' || !item.id.trim()) continue;
      const key = makeUsageKey(item.kind, item.id.trim());
      if (seen.has(key)) continue;
      seen.add(key);

      if (item.kind === CleanupCapabilityKind.Skill) skillIds.push(item.id.trim());
      else if (item.kind === CleanupCapabilityKind.McpServer) mcpIds.push(item.id.trim());
      else if (item.kind === CleanupCapabilityKind.DecisionModel) disableJev = true;
    }

    const closedItems: ContextCleanupTargetItem[] = [];
    const failedItems: Array<{ kind: CleanupCapabilityKind; id: string; reason: string }> = [];

    if (skillIds.length > 0) {
      const enabledSkillSet = new Set(this.deps.listSkills().filter(s => s.enabled).map(s => s.id));
      const toDisable = skillIds.filter(id => enabledSkillSet.has(id));
      if (toDisable.length > 0) {
        try {
          await this.deps.setSkillsEnabledBatch(toDisable, false);
          for (const id of toDisable) closedItems.push({ kind: CleanupCapabilityKind.Skill, id });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          for (const id of toDisable) failedItems.push({ kind: CleanupCapabilityKind.Skill, id, reason });
        }
      }
    }

    const enabledMcpSet = new Set(this.deps.listMcpServers().filter(s => s.enabled).map(s => s.id));
    for (const id of mcpIds) {
      if (!enabledMcpSet.has(id)) continue;
      try {
        const ok = await this.deps.setMcpServerEnabled(id, false);
        if (ok) closedItems.push({ kind: CleanupCapabilityKind.McpServer, id });
        else failedItems.push({ kind: CleanupCapabilityKind.McpServer, id, reason: 'MCP server not found' });
      } catch (error) {
        failedItems.push({
          kind: CleanupCapabilityKind.McpServer,
          id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (disableJev && this.deps.isDecisionModelActive()) {
      try {
        await this.deps.setDecisionModelEnabled(false);
        closedItems.push({ kind: CleanupCapabilityKind.DecisionModel, id: DECISION_MODEL_JEV_ITEM_ID });
      } catch (error) {
        failedItems.push({
          kind: CleanupCapabilityKind.DecisionModel,
          id: DECISION_MODEL_JEV_ITEM_ID,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (closedItems.length > 0 && this.deps.syncRuntimeConfig) {
      await this.deps.syncRuntimeConfig('context-cleanup-apply');
    }

    let undoToken: string | null = null;
    if (closedItems.length > 0) {
      undoToken = randomUUID();
      this.undoSnapshots.set(undoToken, { createdAt: Date.now(), items: closedItems });
      while (this.undoSnapshots.size > CONTEXT_CLEANUP_DEFAULTS.MaxUndoSnapshots) {
        const oldestKey = this.undoSnapshots.keys().next().value;
        if (!oldestKey) break;
        this.undoSnapshots.delete(oldestKey);
      }
    }

    let savedTokens = 0;
    for (const item of closedItems) {
      savedTokens += tokenLookup.get(makeUsageKey(item.kind, item.id)) ?? 0;
    }

    return {
      success: failedItems.length === 0 || closedItems.length > 0,
      closedCount: closedItems.length,
      savedTokens,
      undoToken,
      failedItems,
    };
  }

  async undo(undoToken: string): Promise<ContextCleanupUndoResult> {
    const token = typeof undoToken === 'string' ? undoToken.trim() : '';
    const snapshot = token ? this.undoSnapshots.get(token) : undefined;
    if (!snapshot) {
      return { success: false, restoredCount: 0, error: 'Undo snapshot expired or not found.' };
    }
    this.undoSnapshots.delete(token);

    const skillIds: string[] = [];
    let restoredCount = 0;

    for (const item of snapshot.items) {
      if (item.kind === CleanupCapabilityKind.Skill) {
        skillIds.push(item.id);
      } else if (item.kind === CleanupCapabilityKind.McpServer) {
        if (await this.deps.setMcpServerEnabled(item.id, true)) restoredCount += 1;
      } else if (item.kind === CleanupCapabilityKind.DecisionModel) {
        await this.deps.setDecisionModelEnabled(true);
        restoredCount += 1;
      }
    }

    if (skillIds.length > 0) {
      await this.deps.setSkillsEnabledBatch(skillIds, true);
      restoredCount += skillIds.length;
    }

    if (restoredCount > 0 && this.deps.syncRuntimeConfig) {
      await this.deps.syncRuntimeConfig('context-cleanup-undo');
    }

    return { success: true, restoredCount };
  }

  dismiss(now = Date.now()): { success: boolean; dismissedAt: number } {
    this.deps.kvStore.set(CONTEXT_CLEANUP_KV_KEYS.DismissedAt, now);
    return { success: true, dismissedAt: now };
  }
}
