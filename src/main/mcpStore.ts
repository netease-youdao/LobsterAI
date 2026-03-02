import crypto from 'crypto';
import { Database } from 'sql.js';

export interface McpServerRecord {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  transportType: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  isBuiltIn: boolean;
  githubUrl?: string;
  registryId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface McpServerFormData {
  name: string;
  description: string;
  transportType: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  isBuiltIn?: boolean;
  githubUrl?: string;
  registryId?: string;
}

interface McpServerRow {
  id: string;
  name: string;
  description: string;
  enabled: number;
  transport_type: string;
  config_json: string;
  created_at: number;
  updated_at: number;
}

interface McpConfigJson {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  isBuiltIn?: boolean;
  githubUrl?: string;
  registryId?: string;
}

export class McpStore {
  private db: Database;
  private saveDb: () => void;

  constructor(db: Database, saveDb: () => void) {
    this.db = db;
    this.saveDb = saveDb;
  }

  private deserializeRow(values: unknown[]): McpServerRecord {
    const row: McpServerRow = {
      id: values[0] as string,
      name: values[1] as string,
      description: values[2] as string,
      enabled: values[3] as number,
      transport_type: values[4] as string,
      config_json: values[5] as string,
      created_at: values[6] as number,
      updated_at: values[7] as number,
    };

    let config: McpConfigJson = {};
    try {
      config = JSON.parse(row.config_json) as McpConfigJson;
    } catch {
      // Invalid JSON, use defaults
    }

    return {
      id: row.id,
      name: row.name,
      description: row.description,
      enabled: row.enabled === 1,
      transportType: row.transport_type as 'stdio' | 'sse' | 'http',
      command: config.command,
      args: config.args,
      env: config.env,
      url: config.url,
      headers: config.headers,
      isBuiltIn: config.isBuiltIn === true,
      githubUrl: config.githubUrl,
      registryId: config.registryId,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private serializeConfig(data: Partial<McpServerFormData>): string {
    const config: McpConfigJson = {};
    if (data.command !== undefined) config.command = data.command;
    if (data.args !== undefined) config.args = data.args;
    if (data.env !== undefined && Object.keys(data.env).length > 0) config.env = data.env;
    if (data.url !== undefined) config.url = data.url;
    if (data.headers !== undefined && Object.keys(data.headers).length > 0) config.headers = data.headers;
    if (data.isBuiltIn) config.isBuiltIn = true;
    if (data.githubUrl) config.githubUrl = data.githubUrl;
    if (data.registryId) config.registryId = data.registryId;
    return JSON.stringify(config);
  }

  listServers(): McpServerRecord[] {
    const result = this.db.exec(
      'SELECT id, name, description, enabled, transport_type, config_json, created_at, updated_at FROM mcp_servers ORDER BY created_at ASC'
    );
    if (!result[0]) return [];
    return result[0].values.map((row) => this.deserializeRow(row));
  }

  getServer(id: string): McpServerRecord | null {
    const result = this.db.exec(
      'SELECT id, name, description, enabled, transport_type, config_json, created_at, updated_at FROM mcp_servers WHERE id = ?',
      [id]
    );
    if (!result[0]?.values[0]) return null;
    return this.deserializeRow(result[0].values[0]);
  }

  createServer(data: McpServerFormData): McpServerRecord {
    const id = crypto.randomUUID();
    const now = Date.now();
    const configJson = this.serializeConfig(data);

    this.db.run(
      `INSERT INTO mcp_servers (id, name, description, enabled, transport_type, config_json, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
      [id, data.name, data.description, data.transportType, configJson, now, now]
    );
    this.saveDb();

    return this.getServer(id)!;
  }

  updateServer(id: string, data: Partial<McpServerFormData>): McpServerRecord | null {
    const existing = this.getServer(id);
    if (!existing) return null;

    const now = Date.now();
    const merged: McpServerFormData = {
      name: data.name ?? existing.name,
      description: data.description ?? existing.description,
      transportType: data.transportType ?? existing.transportType,
      command: data.command !== undefined ? data.command : existing.command,
      args: data.args !== undefined ? data.args : existing.args,
      env: data.env !== undefined ? data.env : existing.env,
      url: data.url !== undefined ? data.url : existing.url,
      headers: data.headers !== undefined ? data.headers : existing.headers,
      isBuiltIn: data.isBuiltIn !== undefined ? data.isBuiltIn : existing.isBuiltIn,
      githubUrl: data.githubUrl !== undefined ? data.githubUrl : existing.githubUrl,
      registryId: data.registryId !== undefined ? data.registryId : existing.registryId,
    };

    const configJson = this.serializeConfig(merged);

    this.db.run(
      `UPDATE mcp_servers SET name = ?, description = ?, transport_type = ?, config_json = ?, updated_at = ? WHERE id = ?`,
      [merged.name, merged.description, merged.transportType, configJson, now, id]
    );
    this.saveDb();

    return this.getServer(id);
  }

  deleteServer(id: string): boolean {
    const existing = this.getServer(id);
    if (!existing) return false;

    this.db.run('DELETE FROM mcp_servers WHERE id = ?', [id]);
    this.saveDb();
    return true;
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const existing = this.getServer(id);
    if (!existing) return false;

    const now = Date.now();
    this.db.run(
      'UPDATE mcp_servers SET enabled = ?, updated_at = ? WHERE id = ?',
      [enabled ? 1 : 0, now, id]
    );
    this.saveDb();
    return true;
  }

  getEnabledServers(): McpServerRecord[] {
    const result = this.db.exec(
      'SELECT id, name, description, enabled, transport_type, config_json, created_at, updated_at FROM mcp_servers WHERE enabled = 1 ORDER BY created_at ASC'
    );
    if (!result[0]) return [];
    return result[0].values.map((row) => this.deserializeRow(row));
  }
}
