import { LogReporterAction, reportYdAnalyzer } from '../../services/logReporter';
import type { McpRegistryEntry, McpServerConfig, McpServerFormData } from '../../types/mcp';

type AnalyticsValue = string | number | boolean | null | undefined;
type AnalyticsParams = Record<string, AnalyticsValue>;

export function getMcpSource(server: Pick<McpServerConfig, 'isBuiltIn' | 'registryId'>): string {
  if (server.isBuiltIn) return 'built_in';
  if (server.registryId) return 'marketplace';
  return 'custom';
}

export function getRegistryAnalyticsParams(entry: McpRegistryEntry): AnalyticsParams {
  const requiredEnvKeyCount = entry.requiredEnvKeys?.length ?? 0;
  const optionalEnvKeyCount = entry.optionalEnvKeys?.length ?? 0;
  return {
    mcpId: entry.id,
    mcpName: entry.name,
    mcpSource: 'marketplace',
    registryId: entry.id,
    category: entry.category,
    transportType: entry.transportType,
    isBuiltIn: true,
    requiredEnvKeyCount,
    optionalEnvKeyCount,
    hasRequiredEnv: requiredEnvKeyCount > 0,
    hasOptionalEnv: optionalEnvKeyCount > 0,
    argCount: entry.defaultArgs.length,
  };
}

export function getServerAnalyticsParams(
  server: McpServerConfig,
  registryEntry?: McpRegistryEntry,
): AnalyticsParams {
  const envKeyCount = server.env ? Object.keys(server.env).length : 0;
  const headerKeyCount = server.headers ? Object.keys(server.headers).length : 0;
  const requiredEnvKeyCount = registryEntry?.requiredEnvKeys?.length ?? 0;
  const optionalEnvKeyCount = registryEntry?.optionalEnvKeys?.length ?? 0;
  return {
    mcpId: server.id,
    mcpName: server.name,
    mcpSource: getMcpSource(server),
    registryId: server.registryId,
    category: registryEntry?.category,
    transportType: server.transportType,
    isBuiltIn: server.isBuiltIn,
    enabled: server.enabled,
    requiredEnvKeyCount,
    optionalEnvKeyCount,
    hasRequiredEnv: requiredEnvKeyCount > 0,
    hasOptionalEnv: optionalEnvKeyCount > 0,
    envKeyCount,
    headerKeyCount,
    argCount: server.args?.length ?? 0,
    hasUrl: Boolean(server.url),
    launchStatus: server.launchResolution?.status,
    resolverKind: server.launchResolution?.resolverKind,
    packageName: server.launchResolution?.packageName,
    requestedVersion: server.launchResolution?.requestedVersion,
    resolvedVersion: server.launchResolution?.resolvedVersion,
    hasLaunchError: Boolean(server.launchResolution?.error),
  };
}

export function getFormAnalyticsParams(
  data: McpServerFormData,
  registryEntry?: McpRegistryEntry | null,
): AnalyticsParams {
  const requiredEnvKeyCount = registryEntry?.requiredEnvKeys?.length ?? 0;
  const optionalEnvKeyCount = registryEntry?.optionalEnvKeys?.length ?? 0;
  return {
    mcpName: data.name,
    mcpSource: data.isBuiltIn || registryEntry ? 'marketplace' : 'custom',
    registryId: data.registryId ?? registryEntry?.id,
    category: registryEntry?.category,
    transportType: data.transportType,
    isBuiltIn: Boolean(data.isBuiltIn || registryEntry),
    requiredEnvKeyCount,
    optionalEnvKeyCount,
    hasRequiredEnv: requiredEnvKeyCount > 0,
    hasOptionalEnv: optionalEnvKeyCount > 0,
    envKeyCount: data.env ? Object.keys(data.env).length : 0,
    headerKeyCount: data.headers ? Object.keys(data.headers).length : 0,
    argCount: data.args?.length ?? 0,
    hasUrl: Boolean(data.url),
  };
}

export function reportMcpAction(
  actionType: string,
  params: AnalyticsParams = {},
): void {
  console.debug('[MCP] reporting analytics action', actionType);
  void reportYdAnalyzer({
    action: LogReporterAction.McpAction,
    actionType,
    ...params,
  });
}
