import Database from 'better-sqlite3';
import crypto from 'crypto';

import type { McpLaunchResolution } from './mcpLaunchResolution';

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
  launchResolution?: McpLaunchResolution;
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

interface McpLaunchResolutionRow {
  server_id: string;
  resolver_kind: string;
  source_fingerprint: string;
  status: string;
  package_name: string | null;
  requested_version: string | null;
  resolved_version: string | null;
  install_dir: string | null;
  command: string | null;
  args_json: string | null;
  env_json: string | null;
  error: string | null;
  installed_at: number | null;
  resolved_at: number | null;
  last_probe_at: number | null;
  last_probe_status: string | null;
  updated_at: number;
}

export class McpStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  private parseJsonValue<T>(value: string | null | undefined, fallback: T): T {
    if (!value) return fallback;
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }

  private deserializeLaunchResolution(row: McpLaunchResolutionRow | undefined): McpLaunchResolution | undefined {
    if (!row) return undefined;
    return {
      serverId: row.server_id,
      resolverKind: row.resolver_kind as McpLaunchResolution['resolverKind'],
      sourceFingerprint: row.source_fingerprint,
      status: row.status as McpLaunchResolution['status'],
      packageName: row.package_name || undefined,
      requestedVersion: row.requested_version || undefined,
      resolvedVersion: row.resolved_version || undefined,
      installDir: row.install_dir || undefined,
      command: row.command || undefined,
      args: this.parseJsonValue<string[]>(row.args_json, []),
      env: this.parseJsonValue<Record<string, string> | undefined>(row.env_json, undefined),
      error: row.error || undefined,
      installedAt: row.installed_at || undefined,
      resolvedAt: row.resolved_at || undefined,
      lastProbeAt: row.last_probe_at || undefined,
      lastProbeStatus: row.last_probe_status || undefined,
      updatedAt: row.updated_at,
    };
  }

  getLaunchResolution(serverId: string): McpLaunchResolution | undefined {
    const row = this.db
      .prepare('SELECT * FROM mcp_launch_resolutions WHERE server_id = ?')
      .get(serverId) as McpLaunchResolutionRow | undefined;
    return this.deserializeLaunchResolution(row);
  }

  upsertLaunchResolution(resolution: McpLaunchResolution): void {
    const now = resolution.updatedAt || Date.now();
    this.db
      .prepare(`
        INSERT INTO mcp_launch_resolutions (
          server_id, resolver_kind, source_fingerprint, status,
          package_name, requested_version, resolved_version, install_dir,
          command, args_json, env_json, error,
          installed_at, resolved_at, last_probe_at, last_probe_status, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(server_id) DO UPDATE SET
          resolver_kind = excluded.resolver_kind,
          source_fingerprint = excluded.source_fingerprint,
          status = excluded.status,
          package_name = excluded.package_name,
          requested_version = excluded.requested_version,
          resolved_version = excluded.resolved_version,
          install_dir = excluded.install_dir,
          command = excluded.command,
          args_json = excluded.args_json,
          env_json = excluded.env_json,
          error = excluded.error,
          installed_at = excluded.installed_at,
          resolved_at = excluded.resolved_at,
          last_probe_at = excluded.last_probe_at,
          last_probe_status = excluded.last_probe_status,
          updated_at = excluded.updated_at
      `)
      .run(
        resolution.serverId,
        resolution.resolverKind,
        resolution.sourceFingerprint,
        resolution.status,
        resolution.packageName ?? null,
        resolution.requestedVersion ?? null,
        resolution.resolvedVersion ?? null,
        resolution.installDir ?? null,
        resolution.command ?? null,
        resolution.args ? JSON.stringify(resolution.args) : null,
        resolution.env ? JSON.stringify(resolution.env) : null,
        resolution.error ?? null,
        resolution.installedAt ?? null,
        resolution.resolvedAt ?? null,
        resolution.lastProbeAt ?? null,
        resolution.lastProbeStatus ?? null,
        now,
      );
  }

  deleteLaunchResolution(serverId: string): void {
    this.db.prepare('DELETE FROM mcp_launch_resolutions WHERE server_id = ?').run(serverId);
  }

  private deserializeRow(row: McpServerRow): McpServerRecord {
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
      launchResolution: this.getLaunchResolution(row.id),
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

  private normalizeTransportConfig(data: McpServerFormData): McpServerFormData {
    if (data.transportType === 'stdio') {
      return {
        ...data,
        url: undefined,
        headers: undefined,
      };
    }

    return {
      ...data,
      command: undefined,
      args: undefined,
      env: undefined,
    };
  }

  listServers(): McpServerRecord[] {
    const rows = this.db
      .prepare(
        'SELECT id, name, description, enabled, transport_type, config_json, created_at, updated_at FROM mcp_servers ORDER BY created_at ASC',
      )
      .all() as McpServerRow[];
    return rows.map((row) => this.deserializeRow(row));
  }

  getServer(id: string): McpServerRecord | null {
    const row = this.db
      .prepare(
        'SELECT id, name, description, enabled, transport_type, config_json, created_at, updated_at FROM mcp_servers WHERE id = ?',
      )
      .get(id) as McpServerRow | undefined;
    if (!row) return null;
    return this.deserializeRow(row);
  }

  createServer(data: McpServerFormData): McpServerRecord {
    const id = crypto.randomUUID();
    const now = Date.now();
    const normalized = this.normalizeTransportConfig(data);
    const configJson = this.serializeConfig(normalized);

    this.db
      .prepare(
        `INSERT INTO mcp_servers (id, name, description, enabled, transport_type, config_json, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
      )
      .run(id, normalized.name, normalized.description, normalized.transportType, configJson, now, now);

    return this.getServer(id)!;
  }

  updateServer(id: string, data: Partial<McpServerFormData>): McpServerRecord | null {
    const existing = this.getServer(id);
    if (!existing) return null;

    const now = Date.now();
    const merged = this.normalizeTransportConfig({
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
    });

    const configJson = this.serializeConfig(merged);

    this.db
      .prepare(
        `UPDATE mcp_servers SET name = ?, description = ?, transport_type = ?, config_json = ?, updated_at = ? WHERE id = ?`,
      )
      .run(merged.name, merged.description, merged.transportType, configJson, now, id);

    return this.getServer(id);
  }

  deleteServer(id: string): boolean {
    const existing = this.getServer(id);
    if (!existing) return false;

    this.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
    this.deleteLaunchResolution(id);
    return true;
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const existing = this.getServer(id);
    if (!existing) return false;

    const now = Date.now();
    this.db
      .prepare('UPDATE mcp_servers SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, now, id);
    return true;
  }

  getEnabledServers(): McpServerRecord[] {
    const rows = this.db
      .prepare(
        'SELECT id, name, description, enabled, transport_type, config_json, created_at, updated_at FROM mcp_servers WHERE enabled = 1 ORDER BY created_at ASC',
      )
      .all() as McpServerRow[];
    return rows.map((row) => this.deserializeRow(row));
  }
}
