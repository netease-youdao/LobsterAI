import { McpAuthMode } from '../../shared/mcp/auth';
import {
  buildMcpConnectorCredentials,
  type McpConnectorCredentialsResult,
  parseMcpMarketplaceConnector,
} from '../../shared/mcp/marketplace';
import type {
  McpCategory,
  McpMarketplaceServer,
  McpRegistryEntry,
  McpServerFormData,
  McpTransportType,
} from '../types/mcp';

/**
 * Converts the remote marketplace payload to registry entries. Entries whose
 * connector settings do not validate are left out, so the UI never offers an
 * install that would save a broken URL or header.
 */
export function convertMarketplaceToRegistry(servers: McpMarketplaceServer[]): McpRegistryEntry[] {
  const entries: McpRegistryEntry[] = [];
  for (const server of servers) {
    const parsed = parseMcpMarketplaceConnector(
      server as unknown as Record<string, unknown>,
      server.transportType,
    );
    if (!parsed.ok) {
      console.warn(`[MCP] skipped marketplace entry "${server.id}": ${parsed.error}`);
      continue;
    }
    entries.push({
      id: server.id,
      name: server.name,
      name_zh: server.name_zh,
      icon: server.icon,
      descriptionKey: '',
      description_zh: server.description_zh,
      description_en: server.description_en,
      category: server.category as McpCategory,
      categoryKey: '',
      transportType: server.transportType as McpTransportType,
      command: server.command ?? '',
      defaultArgs: server.defaultArgs ?? [],
      requiredEnvKeys: server.requiredEnvKeys,
      optionalEnvKeys: server.optionalEnvKeys,
      kind: server.kind,
      ...(parsed.connector ? { connector: parsed.connector } : {}),
    });
  }
  return entries;
}

export const isRemoteRegistryEntry = (entry: McpRegistryEntry): boolean =>
  entry.transportType !== 'stdio' && Boolean(entry.connector?.url);

/** Marketplace OAuth connectors install in one click; the user signs in from the card. */
export const isOAuthRegistryEntry = (entry: McpRegistryEntry): boolean =>
  isRemoteRegistryEntry(entry) && entry.connector?.auth === McpAuthMode.OAuth;

/** Settings every install of the entry starts with, whatever the transport. */
export function getRegistryInstallDefaults(
  entry: McpRegistryEntry,
): Pick<McpServerFormData, 'toolFilter' | 'requestTimeoutMs' | 'connectionTimeoutMs'> {
  const connector = entry.connector;
  return {
    ...(connector?.allowedTools ? { toolFilter: { include: [...connector.allowedTools] } } : {}),
    ...(connector?.requestTimeoutMs ? { requestTimeoutMs: connector.requestTimeoutMs } : {}),
    ...(connector?.connectionTimeoutMs ? { connectionTimeoutMs: connector.connectionTimeoutMs } : {}),
  };
}

export type RegistryRemoteServerData = Pick<
  McpServerFormData,
  'transportType' | 'url' | 'headers' | 'auth' | 'tokenValues'
>;

type CredentialsFailure = Extract<McpConnectorCredentialsResult, { ok: false }>;

export type RegistryRemoteServerDataResult =
  | { ok: true; data: RegistryRemoteServerData }
  | CredentialsFailure;

/**
 * Connection fields of a remote marketplace server: the URL template and the
 * header bindings filled with the credential form's values. OAuth entries carry
 * no credentials; OpenClaw signs in and stores the token itself.
 */
export function buildRegistryRemoteServerData(
  entry: McpRegistryEntry,
  tokenValues: Record<string, string>,
): RegistryRemoteServerDataResult {
  const connector = entry.connector ?? {};
  const credentials = buildMcpConnectorCredentials(
    connector,
    connector.tokenSchema ? tokenValues : {},
  );
  if (!credentials.ok) return credentials;
  const isOAuth = connector.auth === McpAuthMode.OAuth;
  return {
    ok: true,
    data: {
      transportType: entry.transportType,
      url: credentials.url,
      headers: isOAuth ? {} : credentials.headers,
      // Sent explicitly so editing never leaves a stale mode behind.
      auth: isOAuth ? McpAuthMode.OAuth : McpAuthMode.None,
      ...(connector.tokenSchema ? { tokenValues: credentials.tokenValues } : {}),
    },
  };
}

/** Full create payload for a one-click OAuth install (no form). */
export function buildOAuthRegistryInstallData(
  entry: McpRegistryEntry,
  identity: { name: string; description: string },
): { ok: true; data: McpServerFormData } | CredentialsFailure {
  const remote = buildRegistryRemoteServerData(entry, {});
  if (!remote.ok) return remote;
  return {
    ok: true,
    data: {
      name: identity.name,
      description: identity.description,
      ...remote.data,
      ...getRegistryInstallDefaults(entry),
      isBuiltIn: true,
      registryId: entry.id,
    },
  };
}
