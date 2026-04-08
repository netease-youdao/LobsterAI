import Database from 'better-sqlite3';

export interface SkillUsageStat {
  skillId: string;
  useCount: number;
  lastUsedAt: number;
}

export class SkillUsageStore {
  constructor(private readonly db: Database.Database) {
    this.ensureTable();
  }

  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skill_usage_stats (
        skill_id     TEXT    PRIMARY KEY,
        use_count    INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER NOT NULL
      );
    `);
  }

  /** 批量记录技能使用（每次会话 start/continue 调用） */
  recordUsage(skillIds: string[]): void {
    if (!skillIds || skillIds.length === 0) return;
    const now = Date.now();
    const upsert = this.db.prepare(`
      INSERT INTO skill_usage_stats (skill_id, use_count, last_used_at)
      VALUES (?, 1, ?)
      ON CONFLICT(skill_id) DO UPDATE SET
        use_count    = use_count + 1,
        last_used_at = excluded.last_used_at
    `);
    const runBatch = this.db.transaction((ids: string[]) => {
      for (const id of ids) {
        upsert.run(id, now);
      }
    });
    runBatch(skillIds);
  }

  /** 获取所有记录，按最近使用时间降序 */
  getAll(): SkillUsageStat[] {
    const rows = this.db.prepare(`
      SELECT skill_id, use_count, last_used_at
      FROM skill_usage_stats
      ORDER BY last_used_at DESC
    `).all() as Array<{ skill_id: string; use_count: number; last_used_at: number }>;
    return rows.map(r => ({
      skillId: r.skill_id,
      useCount: r.use_count,
      lastUsedAt: r.last_used_at,
    }));
  }
}
