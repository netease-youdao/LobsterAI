import crypto from 'crypto';
import { Database } from 'sql.js';
import type { RawPromptTemplate } from '../prompt-template/constants';

export type { RawPromptTemplate };

export class PromptTemplateStore {
  private db: Database;
  private saveDb: () => void;

  constructor(db: Database, saveDb: () => void) {
    this.db = db;
    this.saveDb = saveDb;
  }

  // Deserialize a single row from db.exec result values array
  private deserializeRow(values: unknown[]): RawPromptTemplate {
    return {
      id: values[0] as string,
      title: values[1] as string,
      content: values[2] as string,
      description: values[3] as string | null,
      category: values[4] as string | null,
      variables: values[5] as string,
      is_starred: values[6] as number,
      used_count: values[7] as number,
      created_at: values[8] as string,
      updated_at: values[9] as string,
    };
  }

  private static readonly COLUMNS = 'id, title, content, description, category, variables, is_starred, used_count, created_at, updated_at';

  list(query?: { search?: string; category?: string }): RawPromptTemplate[] {
    let sql = `SELECT ${PromptTemplateStore.COLUMNS} FROM prompt_templates WHERE 1=1`;
    const params: (string | number)[] = [];

    if (query?.category) {
      sql += ' AND category = ?';
      params.push(query.category);
    }
    if (query?.search) {
      sql += ' AND (title LIKE ? OR content LIKE ?)';
      params.push(`%${query.search}%`, `%${query.search}%`);
    }

    sql += ' ORDER BY is_starred DESC, used_count DESC, updated_at DESC';

    const result = this.db.exec(sql, params);
    if (!result[0]) return [];
    return result[0].values.map((row) => this.deserializeRow(row));
  }

  getById(id: string): RawPromptTemplate | null {
    const result = this.db.exec(
      `SELECT ${PromptTemplateStore.COLUMNS} FROM prompt_templates WHERE id = ?`,
      [id]
    );
    if (!result[0]?.values[0]) return null;
    return this.deserializeRow(result[0].values[0]);
  }

  create(input: {
    title: string;
    content: string;
    description?: string | null;
    category?: string | null;
    variables: string;
  }): RawPromptTemplate {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    this.db.run(
      `INSERT INTO prompt_templates (${PromptTemplateStore.COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
      [id, input.title, input.content, input.description ?? null, input.category ?? null, input.variables, now, now]
    );
    this.saveDb();

    return this.getById(id)!;
  }

  update(id: string, updates: Partial<{
    title: string;
    content: string;
    description: string | null;
    category: string | null;
    variables: string;
    is_starred: number;
  }>): RawPromptTemplate | null {
    const existing = this.getById(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const merged = {
      title: updates.title ?? existing.title,
      content: updates.content ?? existing.content,
      description: updates.description !== undefined ? updates.description : existing.description,
      category: updates.category !== undefined ? updates.category : existing.category,
      variables: updates.variables ?? existing.variables,
      is_starred: updates.is_starred !== undefined ? updates.is_starred : existing.is_starred,
    };

    this.db.run(
      `UPDATE prompt_templates SET title=?, content=?, description=?, category=?, variables=?, is_starred=?, updated_at=? WHERE id=?`,
      [merged.title, merged.content, merged.description, merged.category, merged.variables, merged.is_starred, now, id]
    );
    this.saveDb();

    return this.getById(id);
  }

  delete(id: string): boolean {
    const existing = this.getById(id);
    if (!existing) return false;

    this.db.run('DELETE FROM prompt_templates WHERE id = ?', [id]);
    this.saveDb();
    return true;
  }

  incrementUsedCount(id: string): void {
    this.db.run(
      'UPDATE prompt_templates SET used_count = used_count + 1 WHERE id = ?',
      [id]
    );
    this.saveDb();
  }
}
