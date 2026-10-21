import { type McpOAuthActionResult, McpOAuthErrorCode, type McpOAuthState } from '../../shared/mcp/auth';
import {
  McpToolDiscoveryErrorCode,
  type McpToolDiscoveryRequest,
  type McpToolDiscoveryResult,
} from '../../shared/mcp/toolDiscovery';
import { McpMarketplaceCategoryInfo, McpMarketplaceServer,McpRegistryEntry, McpServerConfig, McpServerFormData } from '../types/mcp';
import { LogReporterAction, reportYdAnalyzer } from './logReporter';
import { convertMarketplaceToRegistry } from './mcpMarketplaceInstall';

/**
 * Last successful marketplace payload, kept so the page's first frame renders
 * the same localized names and entries as the eventual fetch — without it the
 * grid mounts on the bundled English-only registry and visibly renames itself
 * a few seconds later.
 */
const MARKETPLACE_CACHE_KEY = 'mcpMarketplaceCache.v1';

interface MarketplaceCachePayload {
  servers: McpMarketplaceServer[];
  categories: McpMarketplaceCategoryInfo[];
}

function readMarketplaceCache(): MarketplaceCachePayload | null {
  try {
    const raw = window.localStorage.getItem(MARKETPLACE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MarketplaceCachePayload;
    if (!Array.isArray(parsed?.servers) || !Array.isArray(parsed?.categories)) return null;
    return parsed;
  } catch {
    // localStorage unavailable or the cache is corrupt; fetch will repopulate.
    return null;
  }
}

function writeMarketplaceCache(payload: MarketplaceCachePayload): void {
  try {
    window.localStorage.setItem(MARKETPLACE_CACHE_KEY, JSON.stringify(payload));
  } catch {
    // Cache is an optimization only; failing to persist must not break fetch.
  }
}

function getMcpAnalyticsSource(server: McpServerConfig): string {
  if (server.isBuiltIn) return 'built_in';
  if (server.registryId) return 'marketplace';
  return 'custom';
}

class McpService {
  private servers: McpServerConfig[] = [];
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.loadServers();
    this.initialized = true;
  }

  async loadServers(): Promise<McpServerConfig[]> {
    try {
      const result = await window.electron.mcp.list();
      if (result.success && result.servers) {
        this.servers = result.servers;
      } else {
        this.servers = [];
      }
      return this.servers;
    } catch (error) {
      console.error('Failed to load MCP servers:', error);
      this.servers = [];
      return this.servers;
    }
  }

  async createServer(data: McpServerFormData): Promise<{ success: boolean; servers?: McpServerConfig[]; error?: string }> {
    try {
      const result = await window.electron.mcp.create(data);
      if (result.success && result.servers) {
        this.servers = result.servers;
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create MCP server';
      console.error('Failed to create MCP server:', error);
      return { success: false, error: message };
    }
  }

  async updateServer(id: string, data: Partial<McpServerFormData>): Promise<{ success: boolean; servers?: McpServerConfig[]; error?: string }> {
    try {
      const result = await window.electron.mcp.update(id, data);
      if (result.success && result.servers) {
        this.servers = result.servers;
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update MCP server';
      console.error('Failed to update MCP server:', error);
      return { success: false, error: message };
    }
  }

  /** Connects to the server described by the form and lists its tools. */
  async listTools(request: McpToolDiscoveryRequest): Promise<McpToolDiscoveryResult> {
    try {
      return await window.electron.mcp.listTools(request);
    } catch (error) {
      console.error('Failed to list MCP tools:', error);
      return {
        success: false,
        code: McpToolDiscoveryErrorCode.Failed,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async deleteServer(id: string): Promise<{ success: boolean; servers?: McpServerConfig[]; error?: string }> {
    try {
      const result = await window.electron.mcp.delete(id);
      if (result.success && result.servers) {
        this.servers = result.servers;
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete MCP server';
      console.error('Failed to delete MCP server:', error);
      return { success: false, error: message };
    }
  }

  async deleteByRegistryId(registryId: string): Promise<{ success: boolean; servers?: McpServerConfig[]; error?: string }> {
    try {
      const result = await window.electron.mcp.deleteByRegistryId(registryId);
      if (result.success && result.servers) {
        this.servers = result.servers;
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete MCP registry servers';
      console.error('Failed to delete MCP registry servers:', error);
      return { success: false, error: message };
    }
  }

  async setServerEnabled(id: string, enabled: boolean): Promise<McpServerConfig[]> {
    try {
      const previousServer = this.servers.find(server => server.id === id);
      const result = await window.electron.mcp.setEnabled({ id, enabled });
      if (result.success && result.servers) {
        this.servers = result.servers;
        const updatedServer = this.servers.find(server => server.id === id) ?? previousServer;
        if (enabled && previousServer?.enabled !== true && updatedServer) {
          void reportYdAnalyzer({
            action: LogReporterAction.McpEnabled,
            mcpId: updatedServer.id,
            mcpName: updatedServer.name,
            mcpSource: getMcpAnalyticsSource(updatedServer),
            registryId: updatedServer.registryId,
            transportType: updatedServer.transportType,
            isBuiltIn: updatedServer.isBuiltIn,
          });
        }
        return this.servers;
      }
      throw new Error(result.error || 'Failed to update MCP server');
    } catch (error) {
      console.error('Failed to update MCP server:', error);
      throw error;
    }
  }

  async setRegistryEnabled(registryId: string, enabled: boolean): Promise<McpServerConfig[]> {
    try {
      const result = await window.electron.mcp.setEnabledByRegistryId({ registryId, enabled });
      if (result.success && result.servers) {
        this.servers = result.servers;
        return this.servers;
      }
      throw new Error(result.error || 'Failed to update MCP registry servers');
    } catch (error) {
      console.error('Failed to update MCP registry servers:', error);
      throw error;
    }
  }

  async retryLaunchResolution(id: string): Promise<{ success: boolean; servers?: McpServerConfig[]; error?: string }> {
    try {
      const result = await window.electron.mcp.retryLaunchResolution(id);
      if (result.success && result.servers) {
        this.servers = result.servers;
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to retry MCP launch resolution';
      console.error('Failed to retry MCP launch resolution:', error);
      return { success: false, error: message };
    }
  }

  async connectQichacha(): Promise<{ success: boolean; servers?: McpServerConfig[]; error?: string }> {
    try {
      const result = await window.electron.mcp.connectQichacha();
      if (result.success && result.servers) {
        this.servers = result.servers;
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to connect Qichacha MCP';
      console.error('Failed to connect Qichacha MCP:', error);
      return { success: false, error: message };
    }
  }

  /** Runs the MCP OAuth sign-in for an `auth: 'oauth'` server; the browser opens on the provider's page. */
  async oauthLogin(id: string): Promise<McpOAuthActionResult> {
    try {
      return await window.electron.mcp.oauthLogin(id);
    } catch (error) {
      console.error('Failed to sign in to MCP server:', error);
      return {
        success: false,
        code: McpOAuthErrorCode.Failed,
        error: error instanceof Error ? error.message : 'Failed to sign in to MCP server',
      };
    }
  }

  /** Stops a sign-in that is waiting for the browser; its `oauthLogin` call then resolves as cancelled. */
  async oauthCancel(id: string): Promise<boolean> {
    try {
      return await window.electron.mcp.oauthCancel(id);
    } catch (error) {
      console.error('Failed to cancel MCP sign-in:', error);
      return false;
    }
  }

  async oauthLogout(id: string): Promise<McpOAuthActionResult> {
    try {
      return await window.electron.mcp.oauthLogout(id);
    } catch (error) {
      console.error('Failed to sign out of MCP server:', error);
      return {
        success: false,
        code: McpOAuthErrorCode.Failed,
        error: error instanceof Error ? error.message : 'Failed to sign out of MCP server',
      };
    }
  }

  /** OAuth state per server id, for servers configured with `auth: 'oauth'`. */
  async oauthStatus(): Promise<Record<string, McpOAuthState>> {
    try {
      const result = await window.electron.mcp.oauthStatus();
      return result.success ? result.states : {};
    } catch (error) {
      console.error('Failed to read MCP OAuth status:', error);
      return {};
    }
  }

  onChanged(callback: () => void): () => void {
    return window.electron.mcp.onChanged(callback);
  }

  getServers(): McpServerConfig[] {
    return this.servers;
  }

  getEnabledServers(): McpServerConfig[] {
    return this.servers.filter(s => s.enabled);
  }

  getServerById(id: string): McpServerConfig | undefined {
    return this.servers.find(s => s.id === id);
  }

  async fetchMarketplace(): Promise<{
    registry: McpRegistryEntry[];
    categories: McpMarketplaceCategoryInfo[];
  } | null> {
    try {
      const result = await window.electron.mcp.fetchMarketplace();
      if (result.success && result.data) {
        writeMarketplaceCache(result.data);
        const registry = convertMarketplaceToRegistry(result.data.servers);
        return { registry, categories: result.data.categories };
      }
      return null;
    } catch (error) {
      console.error('Failed to fetch MCP marketplace:', error);
      return null;
    }
  }

  /** Cached copy of the last fetch, already converted; null on first run. */
  getCachedMarketplace(): {
    registry: McpRegistryEntry[];
    categories: McpMarketplaceCategoryInfo[];
  } | null {
    const cached = readMarketplaceCache();
    if (!cached) return null;
    return {
      registry: convertMarketplaceToRegistry(cached.servers),
      categories: cached.categories,
    };
  }
}

export const mcpService = new McpService();
