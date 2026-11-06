import { randomUUID } from 'node:crypto';

export const SettingsRuntime = {
  Plugin: 'lobster-agent-settings', Tool: 'lobsterai_agent_settings', Policy: 'agent-settings-writers',
  Status: 'lobster.settings.status', BindRun: 'lobster.settings.bindRun', Acquire: 'lobster.settings.acquire', Release: 'lobster.settings.release',
  MemoryLock: 'lobsterai.memoryWorkspaceLock.v1',
} as const;

export type SettingsRunIdentity = { agentId: string; sessionKey: string; runId: string };
export type ToolIdentity = SettingsRunIdentity & { toolCallId: string };
const MAX_REGISTERED_RUNS = 512;
const safeId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value);
export function isSettingsRunIdentity(value: Partial<SettingsRunIdentity>): value is SettingsRunIdentity {
  if (!safeId(value.agentId) || !safeId(value.runId) || typeof value.sessionKey !== 'string' || value.sessionKey.length > 256) return false;
  const prefix = `agent:${value.agentId}:lobsterai:`;
  return value.sessionKey.startsWith(prefix) && safeId(value.sessionKey.slice(prefix.length));
}
type ActiveTool = ToolIdentity & { toolName: string };
type Lease = { token: string; agentId: string; expiresAt: number; release: () => void };
type MemoryLock = <T>(workspace: string, action: () => Promise<T>) => Promise<T>;

/** Gateway-owned gate. Model arguments never select the owner or the excluded tool. */
export class SettingsWriterCoordinator {
  private readonly active = new Map<string, ActiveTool>();
  private readonly protectedRuns = new Set<string>();
  private readonly registeredRuns = new Map<string, SettingsRunIdentity>();
  private readonly leases = new Map<string, Lease>();
  constructor(private readonly now: () => number = Date.now) {}
  private key(context: ToolIdentity): string { return JSON.stringify([context.sessionKey, context.runId, context.toolCallId]); }
  private runKey(context: Pick<ToolIdentity, 'sessionKey' | 'runId'>): string { return JSON.stringify([context.sessionKey, context.runId]); }

  bindRun(context: SettingsRunIdentity): void {
    if (!isSettingsRunIdentity(context)) throw new Error('CONVERSATION_SOURCE_INVALID');
    const key = this.runKey(context), existing = this.registeredRuns.get(key);
    if (existing) {
      if (existing.agentId !== context.agentId) throw new Error('CONVERSATION_SOURCE_INVALID');
      return;
    }
    if (this.registeredRuns.size >= MAX_REGISTERED_RUNS) throw new Error('SETTINGS_RATE_LIMITED');
    this.registeredRuns.set(key, { agentId: context.agentId, sessionKey: context.sessionKey, runId: context.runId });
  }
  hasRun(context: Partial<SettingsRunIdentity>): boolean {
    return isSettingsRunIdentity(context) && this.registeredRuns.get(this.runKey(context))?.agentId === context.agentId;
  }

  enter(context: ToolIdentity, toolName: string): boolean {
    if (!context.agentId || !context.sessionKey || !context.runId || !context.toolCallId) return false;
    if (toolName === SettingsRuntime.Tool && !this.hasRun(context)) return false;
    const key = this.key(context);
    if (this.leases.has(context.agentId)) return false;
    if (this.protectedRuns.has(this.runKey(context)) && toolName !== SettingsRuntime.Tool) return false;
    if (toolName === SettingsRuntime.Tool) this.protectedRuns.add(this.runKey(context));
    const previous = this.active.get(key);
    if (previous && previous.toolName !== toolName) return false;
    this.active.set(key, { ...context, toolName });
    return true;
  }
  exit(context: ToolIdentity): void { this.active.delete(this.key(context)); }
  end(context: Pick<ToolIdentity, 'sessionKey' | 'runId'>): void {
    const runKey = this.runKey(context);
    this.protectedRuns.delete(runKey);
    this.registeredRuns.delete(runKey);
    for (const [key, tool] of this.active) if (this.runKey(tool) === runKey) this.active.delete(key);
  }
  hasCall(context: ToolIdentity): boolean { return this.hasRun(context) && this.active.get(this.key(context))?.toolName === SettingsRuntime.Tool; }

  async acquire(agentId: string, workspace: string, memoryLock: MemoryLock, ownTool?: ToolIdentity): Promise<{ token: string; expiresAt: number }> {
    if (this.leases.has(agentId)) throw new Error('AGENT_BUSY');
    if (ownTool && (!this.hasCall(ownTool) || ownTool.agentId !== agentId)) throw new Error('CONVERSATION_SOURCE_INVALID');
    if ([...this.active.values()].some(tool => tool.agentId === agentId && (!ownTool || this.key(tool) !== this.key(ownTool)))) throw new Error('AGENT_BUSY');
    const token = randomUUID();
    let resolveHeld!: () => void;
    const held = new Promise<void>(resolve => { resolveHeld = resolve; });
    const lease: Lease = { token, agentId, expiresAt: 0, release: resolveHeld };
    this.leases.set(agentId, lease); // Fence new tools before waiting for automatic memory writers.
    return await new Promise((resolve, reject) => {
      let acquired = false;
      const waiting = setTimeout(() => {
        if (acquired) return;
        if (this.leases.get(agentId) === lease) this.leases.delete(agentId);
        lease.release();
        reject(new Error('SETTINGS_WRITE_COORDINATION_REQUIRED'));
      }, 10_000);
      waiting.unref?.();
      void memoryLock(workspace, async () => {
        if (this.leases.get(agentId) !== lease) throw new Error('SETTINGS_LEASE_EXPIRED');
        lease.expiresAt = this.now() + 15_000;
        acquired = true;
        clearTimeout(waiting);
        const timer = setTimeout(() => this.release(agentId, token), 15_000);
        timer.unref?.();
        resolve({ token, expiresAt: lease.expiresAt });
        try { await held; } finally { clearTimeout(timer); }
      }).catch(error => { if (!acquired) reject(error); }).finally(() => {
        clearTimeout(waiting);
        if (this.leases.get(agentId) === lease) this.leases.delete(agentId);
      });
    });
  }
  release(agentId: string, token: string): boolean {
    const lease = this.leases.get(agentId);
    if (!lease || lease.token !== token) return false;
    lease.release();
    return true;
  }
}
