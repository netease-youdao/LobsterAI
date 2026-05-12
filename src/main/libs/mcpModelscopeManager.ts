import { McpServerFormData } from '../mcpStore';
import type { SqliteStore } from '../sqliteStore';
import { getModelScopeMcpBaseUrl } from './endpoints';

const MODELSCOPE_TOKEN_KEY = 'modelscope_token';

export interface ModelScopeMCPServer {
  id: string;
  name: string;
  description: string;
}

export interface ModelScopeMCPSearchResult {
  total_count: number;
  servers: ModelScopeMCPServer[];
}

export interface ModelScopeMCPOperationalUrl {
  type: string;
  url: string;
}

export interface ModelScopeMCPDetail {
  id: string;
  name: string;
  description: string;
  servers: ModelScopeMCPOperationalUrl[];
}

let storeRef: SqliteStore | null = null;

export function initModelScopeStore(store: SqliteStore): void {
  storeRef = store;
}

function getToken(): string | undefined {
  return storeRef?.get<string>(MODELSCOPE_TOKEN_KEY) || process.env.MODELSCOPE_TOKEN;
}

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const token = getToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

export async function searchModelScopeMCP(
  keyword = '',
  pageSize = 20,
): Promise<ModelScopeMCPSearchResult> {
  const url = getModelScopeMcpBaseUrl();
  const body = {
    filter: {},
    page_number: 1,
    page_size: Math.min(Math.max(pageSize, 1), 100),
    search: keyword,
  };

  const response = await fetch(url, {
    method: 'PUT',
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`ModelScope API error: HTTP ${response.status}`);
  }

  const data = (await response.json()) as {
    data?: {
      value?: {
        mcp_server_list?: Array<{ name: string; id: string; description: string }>;
        total_count?: number;
      };
    };
  };

  const value = data?.data?.value;
  const serverList = value?.mcp_server_list ?? [];
  return {
    total_count: value?.total_count ?? serverList.length,
    servers: serverList.map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
    })),
  };
}

export async function getModelScopeMCPDetail(
  serverId: string,
): Promise<ModelScopeMCPDetail> {
  const url = `${getModelScopeMcpBaseUrl()}/${encodeURIComponent(serverId)}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: buildHeaders(),
  });

  if (!response.ok) {
    throw new Error(`ModelScope API error: HTTP ${response.status}`);
  }

  const rawData = (await response.json()) as Record<string, unknown>;

  const operationalUrls = (rawData['operational_urls'] as Array<{ url: string }> | undefined) ?? [];

  const servers: ModelScopeMCPOperationalUrl[] = operationalUrls
    .filter((item) => item?.url)
    .map((item) => ({
      type: item.url.split('/').pop() || 'sse',
      url: item.url,
    }));

  return {
    id: (rawData['id'] as string) || serverId,
    name: (rawData['name'] as string) || '',
    description: (rawData['description'] as string) || '',
    servers,
  };
}

export function buildMcpServerFormData(
  detail: ModelScopeMCPDetail,
): McpServerFormData | null {
  const sseEntry = detail.servers.find(
    (s) => s.type === 'sse' || s.url.includes('/sse'),
  );
  if (!sseEntry) return null;

  return {
    name: detail.name || detail.id,
    description: detail.description,
    transportType: 'sse',
    url: sseEntry.url,
    registryId: detail.id,
  };
}

export function registerModelScopeMcpHandlers(
  ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => void },
  getMcpStore: () => { createServer: (data: McpServerFormData) => any; listServers: () => any[] },
  refreshBridge: () => Promise<{ tools: number; error?: string }>,
): void {
  ipcMain.handle('mcp:modelscope:search', async (_event: any, keyword?: string, pageSize?: number) => {
    try {
      const result = await searchModelScopeMCP(keyword, pageSize);
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Search failed' };
    }
  });

  ipcMain.handle('mcp:modelscope:detail', async (_event: any, serverId: string) => {
    try {
      const result = await getModelScopeMCPDetail(serverId);
      return { success: true, data: result };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Detail fetch failed' };
    }
  });

  ipcMain.handle('mcp:modelscope:install', async (_event: any, serverId: string) => {
    try {
      const detail = await getModelScopeMCPDetail(serverId);
      const formData = buildMcpServerFormData(detail);
      if (!formData) {
        return { success: false, error: 'No SSE URL found for this MCP server' };
      }
      getMcpStore().createServer(formData);
      const servers = getMcpStore().listServers();
      refreshBridge().catch((err: Error) => console.error('[McpBridge] background refresh error:', err));
      return { success: true, servers };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Install failed' };
    }
  });
}
