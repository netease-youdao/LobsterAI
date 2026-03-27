import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { Database } from 'sql.js';

const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

interface SessionIndexEntry {
  sessionId: string;
  updatedAt: number;
  skillsSnapshot?: {
    skills?: Array<string | { name: string }>;
    resolvedSkills?: Array<{ name: string }>;
  };
}

interface JsonlEventMessage {
  role?: string;
  content?: Array<{
    type: string;
    text?: string;
    id?: string;
    name?: string;
    arguments?: Record<string, unknown>;
    thinking?: string;
  }>;
  stopReason?: string;
  api?: string;
  toolCallId?: string;
  toolName?: string;
  timestamp?: string;
}

interface JsonlEvent {
  type: string;
  id?: string;
  parentId?: string;
  timestamp?: string;
  message?: JsonlEventMessage;
  customType?: string;
  data?: Record<string, unknown>;
}

type FailureCategory = 'SKILL_DEFECT' | 'MODEL_ERROR' | 'ENVIRONMENT';

interface SkillAlert {
  type: 'static_threshold' | 'dynamic_baseline';
  severity: 'warning' | 'critical';
  metric: string;
  message: string;
  currentValue: number;
  threshold: number;
  timestamp: number;
}

interface SkillUsageTrend {
  date: string;
  executionCount: number;
  errorCount: number;
  avgLatencyMs: number;
}

interface FailureAttribution {
  category: FailureCategory;
  confidence: number;
  evidence: string;
  executionId: string;
  timestamp: number;
}

interface TraceSpan {
  id: string;
  parentId: string | null;
  operationName: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  status: 'ok' | 'error';
  tags: Record<string, string>;
}

interface SkillDiagnosticData {
  evaluation: {
    scorecard: {
      triggerAccuracy: number;
      triggerRecall: number;
      triggerPrecision: number;
      execSuccessRate: number;
      interactionScore: number;
      overallScore: number;
    };
    triggerAnalysis: {
      total: number;
      hit: number;
      miss: number;
      falseAlarm: number;
      correctSkip: number;
    };
    executionBreakdown: {
      total: number;
      success: number;
      partial: number;
      failed: number;
    };
  };
  monitoring: {
    healthScore: {
      overall: number;
      effectivenessScore: number;
      efficiencyScore: number;
      stabilityScore: number;
      grade: 'excellent' | 'good' | 'warning' | 'critical';
      trendDirection: 'improving' | 'stable' | 'declining';
    };
    goldenMetrics: {
      successRate: number;
      avgLatencyMs: number;
      p95LatencyMs: number;
      p99LatencyMs: number;
    };
    alerts: SkillAlert[];
    trend: SkillUsageTrend[];
  };
  tracing: {
    recentTraces: TraceSpan[][];
    failureAttributions: FailureAttribution[];
    topBottlenecks: Array<{
      operationName: string;
      avgDurationMs: number;
      count: number;
    }>;
  };
}

export class SkillAnalyticsService {
  private db: Database;
  private saveFn: () => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private syncing = false;

  constructor(db: Database, saveFn: () => void) {
    this.db = db;
    this.saveFn = saveFn;
  }

  start(): void {
    this.timer = setInterval(() => {
      this.syncIfIdle().catch(err =>
        console.error('[SkillAnalytics] scheduled sync failed:', err)
      );
    }, SYNC_INTERVAL_MS);
    console.log('[SkillAnalytics] started with 5-minute sync interval');

    setTimeout(() => {
      this.syncIfIdle().catch(err =>
        console.error('[SkillAnalytics] initial sync failed:', err)
      );
    }, 3000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async triggerSync(): Promise<{ success: boolean; error?: string }> {
    return this.syncIfIdle();
  }

  async reprocessAll(): Promise<{ success: boolean; processed: number; error?: string }> {
    if (this.syncing) {
      return { success: false, processed: 0, error: 'sync in progress' };
    }
    this.syncing = true;
    try {
      this.db.run('DELETE FROM skill_analytics_executions');
      this.db.run('DELETE FROM skill_analytics_sessions');
      this.db.run('DELETE FROM skill_analytics_sync_state');
      this.saveFn();

      const processedIds = new Set<string>();
      const count = this.syncOpenClawSessions(processedIds);
      if (count > 0) {
        this.saveProcessedSessionIds(processedIds);
      }
      this.saveFn();
      console.log(`[SkillAnalytics] reprocessed all sessions: ${count} total`);
      return { success: true, processed: count };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[SkillAnalytics] reprocess error:', err);
      return { success: false, processed: 0, error: msg };
    } finally {
      this.syncing = false;
    }
  }

  private async syncIfIdle(): Promise<{ success: boolean; error?: string }> {
    if (this.syncing) {
      return { success: true };
    }
    this.syncing = true;
    try {
      await this.incrementalSync();
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[SkillAnalytics] sync error:', err);
      return { success: false, error: msg };
    } finally {
      this.syncing = false;
    }
  }

  private getSessionsDir(): string {
    return path.join(
      app.getPath('userData'),
      'openclaw', 'state', 'agents', 'main', 'sessions'
    );
  }

  private getProcessedSessionIds(): Set<string> {
    const result = this.db.exec(
      'SELECT processed_session_ids FROM skill_analytics_sync_state WHERE id = 1'
    );
    if (!result[0]?.values[0]?.[0]) return new Set();
    try {
      const ids = JSON.parse(result[0].values[0][0] as string) as string[];
      return new Set(ids);
    } catch {
      return new Set();
    }
  }

  private saveProcessedSessionIds(ids: Set<string>): void {
    const json = JSON.stringify(Array.from(ids));
    const now = Date.now();
    this.db.run(`
      INSERT INTO skill_analytics_sync_state (id, last_sync_at, processed_session_ids)
      VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        last_sync_at = excluded.last_sync_at,
        processed_session_ids = excluded.processed_session_ids
    `, [now, json]);
    this.saveFn();
  }

  private async incrementalSync(): Promise<void> {
    const processedIds = this.getProcessedSessionIds();
    let totalProcessed = 0;

    totalProcessed += this.syncOpenClawSessions(processedIds);

    if (totalProcessed > 0) {
      this.saveProcessedSessionIds(processedIds);
      console.log(`[SkillAnalytics] sync completed, processed ${totalProcessed} sessions`);
    } else {
      console.debug('[SkillAnalytics] no new or updated sessions');
    }
  }

  private syncOpenClawSessions(processedIds: Set<string>): number {
    const sessionsDir = this.getSessionsDir();
    const indexPath = path.join(sessionsDir, 'sessions.json');

    if (!fs.existsSync(indexPath)) {
      console.debug('[SkillAnalytics] sessions.json not found, skipping OpenClaw sync');
      return 0;
    }

    const indexRaw = fs.readFileSync(indexPath, 'utf8');
    let sessionIndex: Record<string, SessionIndexEntry>;
    try {
      sessionIndex = JSON.parse(indexRaw);
    } catch {
      console.warn('[SkillAnalytics] failed to parse sessions.json');
      return 0;
    }

    const entries = Object.values(sessionIndex);
    const newOrUpdated: SessionIndexEntry[] = [];

    for (const entry of entries) {
      if (!entry.sessionId) continue;

      if (processedIds.has(entry.sessionId)) {
        const existing = this.db.exec(
          'SELECT updated_at FROM skill_analytics_sessions WHERE session_id = ?',
          [entry.sessionId]
        );
        const existingUpdatedAt = existing[0]?.values[0]?.[0] as number | undefined;
        if (existingUpdatedAt && existingUpdatedAt >= entry.updatedAt) {
          continue;
        }
      }
      newOrUpdated.push(entry);
    }

    if (newOrUpdated.length === 0) return 0;

    console.log(`[SkillAnalytics] syncing ${newOrUpdated.length} OpenClaw sessions`);

    this.db.run('BEGIN TRANSACTION;');
    try {
      for (const entry of newOrUpdated) {
        this.processSession(sessionsDir, entry);
        processedIds.add(entry.sessionId);
      }
      this.db.run('COMMIT;');
    } catch (err) {
      this.db.run('ROLLBACK;');
      throw err;
    }

    return newOrUpdated.length;
  }

  private processSession(sessionsDir: string, entry: SessionIndexEntry): void {
    const jsonlPath = path.join(sessionsDir, `${entry.sessionId}.jsonl`);
    if (!fs.existsSync(jsonlPath)) return;

    const skills = this.extractSkillNames(entry);
    const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean);
    const events: JsonlEvent[] = [];

    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch {
        // intentionally skip malformed JSONL lines
      }
    }

    this.processSessionEvents(entry.sessionId, events, skills, entry.updatedAt);
  }

  private processSessionEvents(
    sessionId: string,
    events: JsonlEvent[],
    skills: string[],
    fallbackUpdatedAt?: number
  ): void {
    let turnCount = 0;
    let errorCount = 0;
    let startTime = 0;

    this.db.run(
      'DELETE FROM skill_analytics_executions WHERE session_id = ?',
      [sessionId]
    );

    let turnIndex = 0;
    let lastUserTimestamp = 0;

    const pendingToolCalls = new Map<string, { name: string; timestamp: number; skillName: string | null; args: Record<string, unknown> | undefined }>();

    for (const event of events) {
      if (event.type === 'session' && event.timestamp) {
        startTime = new Date(event.timestamp).getTime();
      }

      const msg = event.message;
      if (!msg || event.type !== 'message') continue;

      if (msg.role === 'user') {
        turnIndex++;
        turnCount++;
        lastUserTimestamp = event.timestamp
          ? new Date(event.timestamp).getTime()
          : Date.now();
      }

      if (msg.role === 'assistant') {
        if (msg.stopReason === 'error') {
          errorCount++;
        }

        const eventTs = event.timestamp ? new Date(event.timestamp).getTime() : 0;
        const toolCalls = (msg.content || []).filter(c => c.type === 'toolCall');

        for (const tc of toolCalls) {
          const toolName = tc.name || '';
          const detectedSkill = this.detectSkillFromToolCall(tc, skills);
          if (tc.id) {
            pendingToolCalls.set(tc.id, {
              name: toolName,
              timestamp: eventTs,
              skillName: detectedSkill,
              args: tc.arguments,
            });
          }
        }
      }

      if (msg.role === 'toolResult') {
        const toolCallId = msg.toolCallId || '';
        const toolName = msg.toolName || '';
        const resultTs = event.timestamp ? new Date(event.timestamp).getTime() : 0;

        let latencyMs = 0;
        let resolvedSkill: string | null = null;
        const pending = toolCallId ? pendingToolCalls.get(toolCallId) : undefined;
        if (pending) {
          latencyMs = resultTs && pending.timestamp ? resultTs - pending.timestamp : 0;
          resolvedSkill = pending.skillName;
          pendingToolCalls.delete(toolCallId);
        }

        const isError = this.isToolResultError(msg) ? 1 : 0;
        if (isError) errorCount++;

        if (!resolvedSkill) {
          resolvedSkill = this.detectSkillFromToolResult(msg, toolName, skills);
        }

        if (resolvedSkill) {
          const execCategory = pending
            ? this.classifyExecution(pending.name, pending.args, pending.skillName)
            : this.classifyExecution(toolName, undefined, resolvedSkill);
          const execSummary = pending
            ? this.extractExecSummary(pending.name, pending.args)
            : this.extractExecSummary(toolName, undefined);
          const execId = crypto.randomUUID();
          this.db.run(`
            INSERT INTO skill_analytics_executions
            (id, session_id, turn_index, skill_name, tool_name,
             latency_ms, is_error, error_message, exec_category, exec_summary, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            execId,
            sessionId,
            turnIndex,
            resolvedSkill,
            toolName,
            Math.max(0, latencyMs),
            isError,
            '',
            execCategory,
            execSummary,
            lastUserTimestamp || startTime || Date.now(),
          ]);
        }
      }
    }

    if (!startTime) startTime = fallbackUpdatedAt || Date.now();

    this.db.run(`
      INSERT INTO skill_analytics_sessions
      (session_id, skills, turn_count, error_count, start_time, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        skills = excluded.skills,
        turn_count = excluded.turn_count,
        error_count = excluded.error_count,
        updated_at = excluded.updated_at
    `, [
      sessionId,
      JSON.stringify(skills),
      turnCount,
      errorCount,
      startTime,
      fallbackUpdatedAt || Date.now(),
    ]);
  }

  private extractSkillNames(entry: SessionIndexEntry): string[] {
    const skills = new Set<string>();
    if (entry.skillsSnapshot?.skills) {
      for (const s of entry.skillsSnapshot.skills) {
        if (typeof s === 'string') {
          skills.add(s);
        } else if (s && typeof s === 'object' && 'name' in s) {
          skills.add((s as { name: string }).name);
        }
      }
    }
    if (entry.skillsSnapshot?.resolvedSkills) {
      for (const rs of entry.skillsSnapshot.resolvedSkills) {
        if (rs.name) skills.add(rs.name);
      }
    }
    return Array.from(skills);
  }

  private detectSkillFromToolCall(
    tc: { type: string; name?: string; text?: string; arguments?: Record<string, unknown> },
    sessionSkills: string[]
  ): string | null {
    const toolName = tc.name || '';
    if (!toolName) return null;

    if (toolName === 'read' && tc.arguments) {
      const filePath = String(tc.arguments.file_path || tc.arguments.path || '');
      if (/SKILL\.md/i.test(filePath)) {
        for (const skill of sessionSkills) {
          if (filePath.toLowerCase().includes(skill.toLowerCase())) {
            return skill;
          }
        }
      }
    }

    if ((toolName === 'exec' || toolName === 'Bash' || toolName === 'bash') && tc.arguments) {
      const cmd = String(tc.arguments.command || tc.arguments.cmd || '');
      const pathMatch = cmd.match(/\b(?:SKILLs|skills|\.lobsterai\/skills)\/([^/]+)\//i);
      if (pathMatch) {
        const dirName = pathMatch[1].toLowerCase();
        for (const skill of sessionSkills) {
          if (skill.toLowerCase() === dirName) return skill;
        }
      }
    }

    for (const skill of sessionSkills) {
      const normalized = skill.toLowerCase().replace(/[-_]/g, '');
      const toolNormalized = toolName.toLowerCase().replace(/[-_]/g, '');
      if (toolNormalized.includes(normalized) || normalized.includes(toolNormalized)) {
        return skill;
      }
    }

    return null;
  }

  private detectSkillFromToolResult(
    _msg: JsonlEventMessage,
    toolName: string,
    sessionSkills: string[]
  ): string | null {
    for (const skill of sessionSkills) {
      const normalized = skill.toLowerCase().replace(/[-_]/g, '');
      const toolNormalized = toolName.toLowerCase().replace(/[-_]/g, '');
      if (toolNormalized.includes(normalized) || normalized.includes(toolNormalized)) {
        return skill;
      }
    }

    return null;
  }

  private isToolResultError(msg: JsonlEventMessage): boolean {
    const content = msg.content || [];
    for (const c of content) {
      if (c.type === 'text' && c.text) {
        const lower = c.text.toLowerCase();
        if (lower.startsWith('error:') || lower.startsWith('error ') ||
            lower.includes('command failed') || lower.includes('permission denied') ||
            lower.includes('not found') || lower.includes('timed out')) {
          return true;
        }
      }
    }
    return false;
  }

  private classifyExecution(
    toolName: string,
    args: Record<string, unknown> | undefined,
    _skillName?: string | null
  ): 'skill_script' | 'agent_action' {
    const SKILL_PATH_RE = /\b(SKILLs|skills|\.lobsterai\/skills)\/[^/]+\//i;
    const NON_EXEC_PREFIX = /^\s*(find|ls|cat|head|tail|wc|file|stat|du|tree|grep|rg|awk|sed)\s/i;

    if (toolName === 'exec' || toolName === 'Bash' || toolName === 'bash') {
      const cmd = String(args?.command || args?.cmd || '');
      if (!cmd) return 'agent_action';

      if (NON_EXEC_PREFIX.test(cmd)) return 'agent_action';

      if (SKILL_PATH_RE.test(cmd)) return 'skill_script';

      return 'agent_action';
    }

    return 'agent_action';
  }

  private extractExecSummary(
    toolName: string,
    args: Record<string, unknown> | undefined,
  ): string {
    if (!args) return toolName;

    if (toolName === 'exec' || toolName === 'Bash' || toolName === 'bash') {
      const cmd = String(args.command || args.cmd || '');
      if (!cmd) return toolName;
      return cmd.length > 120 ? cmd.slice(0, 117) + '...' : cmd;
    }

    if (toolName === 'read') {
      return String(args.file_path || args.path || 'read');
    }

    if (toolName === 'write' || toolName === 'edit') {
      return String(args.file_path || args.path || toolName);
    }

    const firstArg = Object.values(args)[0];
    if (firstArg && typeof firstArg === 'string') {
      return firstArg.length > 120 ? firstArg.slice(0, 117) + '...' : firstArg;
    }

    return toolName;
  }

  getSyncState(): {
    lastSyncAt: number;
    processedSessionCount: number;
    totalSessionCount: number;
    isSyncing: boolean;
  } {
    const result = this.db.exec(
      'SELECT last_sync_at, processed_session_ids FROM skill_analytics_sync_state WHERE id = 1'
    );

    let lastSyncAt = 0;
    let processedCount = 0;
    if (result[0]?.values[0]) {
      lastSyncAt = result[0].values[0][0] as number;
      try {
        const ids = JSON.parse(result[0].values[0][1] as string) as string[];
        processedCount = ids.length;
      } catch { /* corrupted JSON in sync state */ }
    }

    let totalCount = 0;
    try {
      const sessionsDir = this.getSessionsDir();
      const indexPath = path.join(sessionsDir, 'sessions.json');
      if (fs.existsSync(indexPath)) {
        const raw = fs.readFileSync(indexPath, 'utf8');
        const index = JSON.parse(raw);
        totalCount = Object.keys(index).length;
      }
    } catch {
      // fs read may fail if openclaw state dir doesn't exist yet
    }

    return {
      lastSyncAt,
      processedSessionCount: processedCount,
      totalSessionCount: totalCount,
      isSyncing: this.syncing,
    };
  }

  getDashboardData(timeRange?: { from: number; to: number }): {
    syncState: ReturnType<SkillAnalyticsService['getSyncState']>;
    skills: Array<{
      skillName: string;
      overallScore: number;
      effectivenessScore: number;
      efficiencyScore: number;
      stabilityScore: number;
      grade: 'excellent' | 'good' | 'warning' | 'critical';
      totalExecutions: number;
      totalSessions: number;
      avgLatencyMs: number;
      avgScriptLatencyMs: number;
      avgActionLatencyMs: number;
      errorRate: number;
      scriptExecutionCount: number;
    }>;
    recentExecutions: Array<{
      id: string;
      sessionId: string;
      turnIndex: number;
      skillName: string;
      toolName: string;
      latencyMs: number;
      isError: boolean;
      errorMessage: string;
      execCategory: string;
      execSummary: string;
      timestamp: number;
    }>;
    globalStats: {
      totalSessions: number;
      totalExecutions: number;
      totalScriptExecutions: number;
      avgErrorRate: number;
      skillCount: number;
      avgTriggerAccuracy: number;
      avgExecSuccessRate: number;
      avgInteractionScore: number;
    };
  } {
    const syncState = this.getSyncState();

    const skillNames = new Set<string>();
    const sessionQuery = timeRange
      ? 'SELECT skills FROM skill_analytics_sessions WHERE start_time >= ? AND start_time < ?'
      : 'SELECT skills FROM skill_analytics_sessions';
    const sessionParams = timeRange ? [timeRange.from, timeRange.to] : [];
    const sessionResult = this.db.exec(sessionQuery, sessionParams);
    if (sessionResult[0]?.values) {
      for (const row of sessionResult[0].values) {
        try {
          const names = JSON.parse(row[0] as string) as string[];
          names.forEach(n => skillNames.add(n));
        } catch { /* corrupted skills JSON */ }
      }
    }

    const skills = Array.from(skillNames)
      .map(name => this.computeSkillHealth(name, timeRange))
      .filter(s => s.totalExecutions > 0);
    const skillCount = skills.length;
    const avgTriggerAccuracy = skillCount > 0
      ? skills.reduce((sum, s) => sum + s.triggerAccuracy, 0) / skillCount
      : 0;
    const avgExecSuccessRate = skillCount > 0
      ? skills.reduce((sum, s) => sum + s.execSuccessRate, 0) / skillCount
      : 0;
    const avgInteractionScore = skillCount > 0
      ? skills.reduce((sum, s) => sum + s.interactionScore, 0) / skillCount
      : 0;

    const recentQuery = timeRange
      ? `SELECT id, session_id, turn_index, skill_name, tool_name,
             latency_ms, is_error, error_message, exec_category, exec_summary, timestamp
        FROM skill_analytics_executions
        WHERE timestamp >= ? AND timestamp < ?
        ORDER BY timestamp DESC
        LIMIT 50`
      : `SELECT id, session_id, turn_index, skill_name, tool_name,
             latency_ms, is_error, error_message, exec_category, exec_summary, timestamp
        FROM skill_analytics_executions
        ORDER BY timestamp DESC
        LIMIT 50`;
    const recentParams = timeRange ? [timeRange.from, timeRange.to] : [];
    const recentResult = this.db.exec(recentQuery, recentParams);

    const recentExecutions = (recentResult[0]?.values || []).map(row => ({
      id: row[0] as string,
      sessionId: row[1] as string,
      turnIndex: row[2] as number,
      skillName: row[3] as string,
      toolName: row[4] as string,
      latencyMs: row[5] as number,
      isError: (row[6] as number) === 1,
      errorMessage: row[7] as string,
      execCategory: (row[8] as string) || 'agent_action',
      execSummary: (row[9] as string) || '',
      timestamp: row[10] as number,
    }));

    const globalQuery = timeRange
      ? `SELECT
          COUNT(*) as total_sessions,
          AVG(CASE WHEN turn_count > 0 THEN CAST(error_count AS REAL) / turn_count ELSE 0 END) as avg_error_rate
        FROM skill_analytics_sessions
        WHERE start_time >= ? AND start_time < ?`
      : `SELECT
          COUNT(*) as total_sessions,
          AVG(CASE WHEN turn_count > 0 THEN CAST(error_count AS REAL) / turn_count ELSE 0 END) as avg_error_rate
        FROM skill_analytics_sessions`;
    const globalParams = timeRange ? [timeRange.from, timeRange.to] : [];
    const globalResult = this.db.exec(globalQuery, globalParams);

    const execCountQuery = timeRange
      ? 'SELECT COUNT(*) FROM skill_analytics_executions WHERE timestamp >= ? AND timestamp < ?'
      : 'SELECT COUNT(*) FROM skill_analytics_executions';
    const execCountParams = timeRange ? [timeRange.from, timeRange.to] : [];
    const execCountResult = this.db.exec(execCountQuery, execCountParams);

    const globalRow = globalResult[0]?.values[0];
    const totalScriptExecutions = skills.reduce((sum, s) => sum + s.scriptExecutionCount, 0);
    const globalStats = {
      totalSessions: (globalRow?.[0] as number) || 0,
      totalExecutions: (execCountResult[0]?.values[0]?.[0] as number) || 0,
      totalScriptExecutions,
      avgErrorRate: (globalRow?.[1] as number) || 0,
      skillCount: skillNames.size,
      avgTriggerAccuracy: Math.round(avgTriggerAccuracy),
      avgExecSuccessRate: Math.round(avgExecSuccessRate),
      avgInteractionScore: Math.round(avgInteractionScore),
    };

    return { syncState, skills, recentExecutions, globalStats };
  }

  getSkillDetail(skillName: string, timeRange?: { from: number; to: number }): {
    skill: ReturnType<SkillAnalyticsService['computeSkillHealth']>;
    executions: Array<{
      id: string;
      sessionId: string;
      turnIndex: number;
      skillName: string;
      toolName: string;
      latencyMs: number;
      isError: boolean;
      errorMessage: string;
      execCategory: string;
      execSummary: string;
      timestamp: number;
    }>;
    trend: Array<{
      date: string;
      executionCount: number;
      errorCount: number;
      avgLatencyMs: number;
    }>;
    diagnostics: SkillDiagnosticData;
  } {
    const skill = this.computeSkillHealth(skillName, timeRange);

    const execTimeFilter = timeRange ? ' AND timestamp >= ? AND timestamp < ?' : '';
    const execParams = timeRange ? [skillName, timeRange.from, timeRange.to] : [skillName];
    const execResult = this.db.exec(`
      SELECT id, session_id, turn_index, skill_name, tool_name,
             latency_ms, is_error, error_message, exec_category, exec_summary, timestamp
      FROM skill_analytics_executions
      WHERE skill_name = ?${execTimeFilter}
      ORDER BY timestamp DESC
      LIMIT 200
    `, execParams);

    const executions = (execResult[0]?.values || []).map(row => ({
      id: row[0] as string,
      sessionId: row[1] as string,
      turnIndex: row[2] as number,
      skillName: row[3] as string,
      toolName: row[4] as string,
      latencyMs: row[5] as number,
      isError: (row[6] as number) === 1,
      errorMessage: row[7] as string,
      execCategory: (row[8] as string) || 'agent_action',
      execSummary: (row[9] as string) || '',
      timestamp: row[10] as number,
    }));

    const trendTimeFilter = timeRange ? ' AND timestamp >= ? AND timestamp < ?' : '';
    const trendParams = timeRange ? [skillName, timeRange.from, timeRange.to] : [skillName];
    const trendResult = this.db.exec(`
      SELECT
        date(timestamp / 1000, 'unixepoch') as day,
        COUNT(*) as exec_count,
        SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) as err_count,
        AVG(latency_ms) as avg_latency
      FROM skill_analytics_executions
      WHERE skill_name = ?${trendTimeFilter}
      GROUP BY day
      ORDER BY day DESC
      LIMIT 30
    `, trendParams);

    const trend = (trendResult[0]?.values || []).map(row => ({
      date: row[0] as string,
      executionCount: row[1] as number,
      errorCount: row[2] as number,
      avgLatencyMs: Math.round(row[3] as number),
    })).reverse();

    const diagnostics = this.getSkillDiagnostics(skillName, timeRange);

    return { skill, executions, trend, diagnostics };
  }

  getSkillDiagnostics(skillName: string, timeRange?: { from: number; to: number }): SkillDiagnosticData {
    const health = this.computeSkillHealth(skillName, timeRange);

    const diagTimeFilter = timeRange ? ' AND timestamp >= ? AND timestamp < ?' : '';
    const diagParams = timeRange ? [skillName, timeRange.from, timeRange.to] : [skillName];
    const execSummaryResult = this.db.exec(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) as errors,
        AVG(latency_ms) as avg_latency
      FROM skill_analytics_executions
      WHERE skill_name = ?${diagTimeFilter}
    `, diagParams);
    const execSummaryRow = execSummaryResult[0]?.values[0];
    const totalExecutions = (execSummaryRow?.[0] as number) || 0;
    const errorCount = (execSummaryRow?.[1] as number) || 0;
    const avgLatencyMs = Math.round((execSummaryRow?.[2] as number) || 0);
    const successCount = Math.max(0, totalExecutions - errorCount);

    const latencyResult = this.db.exec(`
      SELECT latency_ms
      FROM skill_analytics_executions
      WHERE skill_name = ?${diagTimeFilter}
      ORDER BY latency_ms ASC
    `, diagParams);
    const latencyValues = (latencyResult[0]?.values || []).map(row => row[0] as number);
    const percentile = (values: number[], ratio: number): number => {
      if (values.length === 0) return 0;
      const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * ratio) - 1));
      return Math.round(values[index]);
    };
    const p95LatencyMs = percentile(latencyValues, 0.95);
    const p99LatencyMs = percentile(latencyValues, 0.99);

    const trendResult = this.db.exec(`
      SELECT
        date(timestamp / 1000, 'unixepoch') as day,
        COUNT(*) as exec_count,
        SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) as err_count,
        AVG(latency_ms) as avg_latency
      FROM skill_analytics_executions
      WHERE skill_name = ?${diagTimeFilter}
      GROUP BY day
      ORDER BY day DESC
      LIMIT 30
    `, diagParams);
    const trend = (trendResult[0]?.values || []).map(row => ({
      date: row[0] as string,
      executionCount: row[1] as number,
      errorCount: row[2] as number,
      avgLatencyMs: Math.round(row[3] as number),
    })).reverse();

    let trendDirection: 'improving' | 'stable' | 'declining' = 'stable';
    if (trend.length >= 2) {
      const mid = Math.floor(trend.length / 2);
      const firstAvg = trend.slice(0, mid).reduce((sum, t) => sum + t.executionCount, 0) / Math.max(1, mid);
      const secondAvg = trend.slice(mid).reduce((sum, t) => sum + t.executionCount, 0) / Math.max(1, trend.length - mid);
      if (secondAvg > firstAvg * 1.1) trendDirection = 'improving';
      else if (secondAvg < firstAvg * 0.9) trendDirection = 'declining';
    }

    const alerts: SkillAlert[] = [];
    const errorRate = totalExecutions > 0 ? errorCount / totalExecutions : 0;
    if (errorRate > 0.2) {
      alerts.push({
        type: 'static_threshold',
        severity: errorRate > 0.5 ? 'critical' : 'warning',
        metric: 'errorRate',
        message: 'Execution error rate exceeds the expected threshold.',
        currentValue: Math.round(errorRate * 100),
        threshold: 20,
        timestamp: Date.now(),
      });
    }
    if (avgLatencyMs > 10000) {
      alerts.push({
        type: 'static_threshold',
        severity: avgLatencyMs > 20000 ? 'critical' : 'warning',
        metric: 'avgLatencyMs',
        message: 'Average execution latency exceeds the expected threshold.',
        currentValue: avgLatencyMs,
        threshold: 10000,
        timestamp: Date.now(),
      });
    }

    const execTraceResult = this.db.exec(`
      SELECT id, skill_name, tool_name, latency_ms, is_error, error_message, exec_category, timestamp
      FROM skill_analytics_executions
      WHERE skill_name = ?${diagTimeFilter}
      ORDER BY timestamp DESC
      LIMIT 50
    `, diagParams);

    const recentTraces: TraceSpan[][] = [];
    const failureAttributions: FailureAttribution[] = [];

    for (const row of execTraceResult[0]?.values || []) {
      const executionId = row[0] as string;
      const toolName = row[2] as string;
      const latencyMs = (row[3] as number) || 0;
      const isError = (row[4] as number) === 1;
      const errorMessage = (row[5] as string) || '';
      const execCategory = (row[6] as string) || 'agent_action';
      const timestamp = (row[7] as number) || Date.now();

      const span: TraceSpan = {
        id: executionId,
        parentId: null,
        operationName: toolName,
        startTime: timestamp,
        endTime: timestamp + Math.max(0, latencyMs),
        durationMs: Math.max(0, latencyMs),
        status: isError ? 'error' : 'ok',
        tags: {
          skillName,
          toolName,
          execCategory,
        },
      };
      recentTraces.push([span]);

      if (isError) {
        const lower = errorMessage.toLowerCase();
        let category: FailureCategory = 'MODEL_ERROR';
        let confidence = 0.5;
        if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('network')) {
          category = 'ENVIRONMENT';
          confidence = 0.75;
        } else if (lower.includes('permission') || lower.includes('not found')) {
          category = 'SKILL_DEFECT';
          confidence = 0.7;
        }

        failureAttributions.push({
          category,
          confidence,
          evidence: errorMessage || 'Execution failed without a detailed error message.',
          executionId,
          timestamp,
        });
      }
    }

    const bottleneckResult = this.db.exec(`
      SELECT tool_name, AVG(latency_ms) as avg_latency, COUNT(*) as cnt
      FROM skill_analytics_executions
      WHERE skill_name = ?${diagTimeFilter}
      GROUP BY tool_name
      ORDER BY avg_latency DESC
      LIMIT 5
    `, diagParams);
    const topBottlenecks = (bottleneckResult[0]?.values || []).map(row => ({
      operationName: row[0] as string,
      avgDurationMs: Math.round((row[1] as number) || 0),
      count: row[2] as number,
    }));

    const evaluationOverallScore = Math.round(
      health.triggerAccuracy * 0.3 + health.execSuccessRate * 0.5 + health.interactionScore * 0.2
    );

    return {
      evaluation: {
        scorecard: {
          triggerAccuracy: health.triggerAccuracy,
          triggerRecall: health.triggerRecall,
          triggerPrecision: health.triggerPrecision,
          execSuccessRate: health.execSuccessRate,
          interactionScore: health.interactionScore,
          overallScore: evaluationOverallScore,
        },
        triggerAnalysis: {
          total: totalExecutions,
          hit: successCount,
          miss: 0,
          falseAlarm: errorCount,
          correctSkip: 0,
        },
        executionBreakdown: {
          total: totalExecutions,
          success: successCount,
          partial: 0,
          failed: errorCount,
        },
      },
      monitoring: {
        healthScore: {
          overall: health.overallScore,
          effectivenessScore: health.effectivenessScore,
          efficiencyScore: health.efficiencyScore,
          stabilityScore: health.stabilityScore,
          grade: health.grade,
          trendDirection,
        },
        goldenMetrics: {
          successRate: totalExecutions > 0 ? Math.round((successCount / totalExecutions) * 100) : 0,
          avgLatencyMs,
          p95LatencyMs,
          p99LatencyMs,
        },
        alerts,
        trend,
      },
      tracing: {
        recentTraces,
        failureAttributions,
        topBottlenecks,
      },
    };
  }

  // Health score: effectiveness 40% + efficiency 30% + stability 30%
  private computeSkillHealth(skillName: string, timeRange?: { from: number; to: number }): {
    skillName: string;
    overallScore: number;
    effectivenessScore: number;
    efficiencyScore: number;
    stabilityScore: number;
    grade: 'excellent' | 'good' | 'warning' | 'critical';
    totalExecutions: number;
    totalSessions: number;
    avgLatencyMs: number;
    avgScriptLatencyMs: number;
    avgActionLatencyMs: number;
    errorRate: number;
    scriptExecutionCount: number;
    triggerAccuracy: number;
    triggerRecall: number;
    triggerPrecision: number;
    execSuccessRate: number;
    interactionScore: number;
  } {
    const healthTimeFilter = timeRange ? ' AND timestamp >= ? AND timestamp < ?' : '';
    const healthParams = timeRange ? [skillName, timeRange.from, timeRange.to] : [skillName];
    const execResult = this.db.exec(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) as errors,
        AVG(latency_ms) as avg_latency
      FROM skill_analytics_executions
      WHERE skill_name = ?${healthTimeFilter}
    `, healthParams);

    const row = execResult[0]?.values[0];
    const totalExecutions = (row?.[0] as number) || 0;
    const errorCount = (row?.[1] as number) || 0;
    const avgLatencyMs = Math.round((row?.[2] as number) || 0);

    const categoryLatencyResult = this.db.exec(`
      SELECT
        AVG(CASE WHEN exec_category = 'skill_script' THEN latency_ms END) as avg_script,
        AVG(CASE WHEN exec_category = 'agent_action' THEN latency_ms END) as avg_action
      FROM skill_analytics_executions
      WHERE skill_name = ?${healthTimeFilter}
    `, healthParams);
    const catRow = categoryLatencyResult[0]?.values[0];
    const avgScriptLatencyMs = Math.round((catRow?.[0] as number) || 0);
    const avgActionLatencyMs = Math.round((catRow?.[1] as number) || 0);

    const sessionCountResult = this.db.exec(`
      SELECT COUNT(DISTINCT session_id) FROM skill_analytics_executions WHERE skill_name = ?${healthTimeFilter}
    `, healthParams);
    const totalSessions = (sessionCountResult[0]?.values[0]?.[0] as number) || 0;

    const scriptCountQuery = timeRange
      ? `SELECT COUNT(*) FROM skill_analytics_executions WHERE skill_name = ? AND exec_category = 'skill_script' AND timestamp >= ? AND timestamp < ?`
      : `SELECT COUNT(*) FROM skill_analytics_executions WHERE skill_name = ? AND exec_category = 'skill_script'`;
    const scriptCountParams = timeRange ? [skillName, timeRange.from, timeRange.to] : [skillName];
    const scriptCountResult = this.db.exec(scriptCountQuery, scriptCountParams);
    const scriptExecutionCount = (scriptCountResult[0]?.values[0]?.[0] as number) || 0;

    const errorRate = totalExecutions > 0 ? errorCount / totalExecutions : 0;

    const successRate = 1 - errorRate;
    const effectivenessScore = Math.round(successRate * 100);

    const latencyForScoring = avgScriptLatencyMs > 0 ? avgScriptLatencyMs : avgLatencyMs;
    const latencyScore = Math.max(0, Math.min(100,
      100 - ((latencyForScoring - 1000) / 14000) * 100
    ));
    const efficiencyScore = Math.round(latencyScore);

    const stabilityResult = this.db.exec(`
      SELECT
        AVG(CASE WHEN is_error = 1 THEN 1.0 ELSE 0.0 END) as mean_err,
        COUNT(*) as n
      FROM skill_analytics_executions
      WHERE skill_name = ?${healthTimeFilter}
    `, healthParams);
    const meanErr = (stabilityResult[0]?.values[0]?.[0] as number) || 0;
    const n = (stabilityResult[0]?.values[0]?.[1] as number) || 0;
    const stabilityScore = n > 1
      ? Math.round(Math.max(0, (1 - meanErr * 2) * 100))
      : (totalExecutions > 0 ? 80 : 0);

    const overallScore = Math.round(
      effectivenessScore * 0.5 + stabilityScore * 0.3 + efficiencyScore * 0.2
    );

    const triggerAccuracy = Math.round((1 - errorRate) * 100);
    const triggerRecall = totalExecutions > 0 && totalSessions > 0
      ? Math.min(100, (totalExecutions / totalSessions) * 20)
      : 0;
    const triggerPrecision = totalExecutions > 0
      ? Math.round(((totalExecutions - errorCount) / totalExecutions) * 100)
      : 0;
    const execSuccessRate = triggerPrecision;
    let interactionScore = 70;
    if (avgLatencyMs > 0 && avgLatencyMs < 5000) interactionScore += 15;
    if (errorRate < 0.1) interactionScore += 15;
    interactionScore = Math.min(100, interactionScore);

    let grade: 'excellent' | 'good' | 'warning' | 'critical';
    if (overallScore >= 90) grade = 'excellent';
    else if (overallScore >= 70) grade = 'good';
    else if (overallScore >= 50) grade = 'warning';
    else grade = 'critical';

    return {
      skillName,
      overallScore,
      effectivenessScore,
      efficiencyScore,
      stabilityScore,
      grade,
      totalExecutions,
      totalSessions,
      avgLatencyMs,
      avgScriptLatencyMs,
      avgActionLatencyMs,
      errorRate,
      scriptExecutionCount,
      triggerAccuracy,
      triggerRecall,
      triggerPrecision,
      execSuccessRate,
      interactionScore,
    };
  }
}
