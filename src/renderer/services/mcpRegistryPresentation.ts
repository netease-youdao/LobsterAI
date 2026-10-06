import type { McpRegistryEntry, McpServerConfig } from '../types/mcp';
import { McpRegistryEntryKind } from '../types/mcp';

export type McpInstalledItem =
  | { kind: 'server'; id: string; server: McpServerConfig }
  | {
    kind: 'registryGroup';
    id: string;
    registryId: string;
    servers: McpServerConfig[];
    registryEntry?: McpRegistryEntry;
  };

export function isRegistryBundleEntry(entry: McpRegistryEntry): boolean {
  return entry.kind === McpRegistryEntryKind.Bundle;
}

/** UI language code, as returned by the renderer i18n service. */
export type McpLanguage = 'zh' | 'en';

function pickLocalized(
  language: McpLanguage,
  zh: string | undefined,
  en: string | undefined,
): string {
  const preferred = language === 'zh' ? zh : en;
  const fallback = language === 'zh' ? en : zh;
  return (preferred?.trim() || fallback?.trim() || '');
}

/**
 * Display name for a marketplace entry. `name` is the English name, so only a
 * Chinese variant is carried separately; entries without one keep showing it.
 */
export function getRegistryEntryDisplayName(
  entry: McpRegistryEntry,
  language: McpLanguage,
): string {
  if (language === 'zh') {
    const localizedName = entry.name_zh?.trim();
    if (localizedName) return localizedName;
  }
  return entry.name;
}

/** Localized description, falling back to the other language when one is missing. */
export function getRegistryEntryLocalizedDescription(
  entry: McpRegistryEntry,
  language: McpLanguage,
): string {
  return pickLocalized(language, entry.description_zh, entry.description_en);
}

function getMarketplaceInsertionIndex(position: number | undefined, listLength: number): number {
  if (position === undefined || !Number.isFinite(position)) return listLength;
  const zeroBasedPosition = Math.max(0, Math.trunc(position) - 1);
  return Math.min(zeroBasedPosition, listLength);
}

export function mergeMarketplaceRegistry(
  remoteRegistry: McpRegistryEntry[],
  localRegistry: McpRegistryEntry[],
): McpRegistryEntry[] {
  const managedLocalEntries = localRegistry.filter(entry => entry.oauthProvider);
  const managedLocalIds = new Set(managedLocalEntries.map(entry => entry.id));
  const merged = remoteRegistry.filter(entry => !managedLocalIds.has(entry.id));

  for (const entry of managedLocalEntries) {
    const insertionIndex = getMarketplaceInsertionIndex(entry.marketplacePosition, merged.length);
    merged.splice(insertionIndex, 0, entry);
  }

  return merged;
}

export function buildInstalledMcpItems(
  servers: McpServerConfig[],
  registry: McpRegistryEntry[],
): McpInstalledItem[] {
  const registryById = new Map(registry.map(entry => [entry.id, entry]));
  const serversByRegistryId = new Map<string, McpServerConfig[]>();

  for (const server of servers) {
    if (!server.registryId) continue;
    const registryServers = serversByRegistryId.get(server.registryId) ?? [];
    registryServers.push(server);
    serversByRegistryId.set(server.registryId, registryServers);
  }

  const groupedRegistryIds = new Set<string>();
  for (const [registryId, registryServers] of serversByRegistryId) {
    const registryEntry = registryById.get(registryId);
    if (registryServers.length > 1 || (registryEntry && isRegistryBundleEntry(registryEntry))) {
      groupedRegistryIds.add(registryId);
    }
  }

  const insertedGroups = new Set<string>();
  const items: McpInstalledItem[] = [];
  for (const server of servers) {
    const registryId = server.registryId;
    if (registryId && groupedRegistryIds.has(registryId)) {
      if (!insertedGroups.has(registryId)) {
        items.push({
          kind: 'registryGroup',
          id: registryId,
          registryId,
          servers: serversByRegistryId.get(registryId) ?? [server],
          registryEntry: registryById.get(registryId),
        });
        insertedGroups.add(registryId);
      }
      continue;
    }
    items.push({ kind: 'server', id: server.id, server });
  }

  return items;
}
