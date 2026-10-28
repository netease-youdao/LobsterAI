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
 * Text from a connector's credential form. Its unsuffixed texts are Chinese and
 * the `_en` variants English, so either language falls back to the other.
 */
export function pickMcpConnectorText(
  language: McpLanguage,
  zh: string | undefined,
  en: string | undefined,
): string {
  return pickLocalized(language, zh, en);
}

/** "Try asking" prompts for a connector, in the UI language when it has them. */
export function getRegistryEntryExamples(entry: McpRegistryEntry, language: McpLanguage): string[] {
  const zh = entry.connector?.examples_zh ?? [];
  const en = entry.connector?.examples_en ?? [];
  const preferred = language === 'zh' ? zh : en;
  return preferred.length > 0 ? preferred : (language === 'zh' ? en : zh);
}

/** Credentials the user must supply: stdio env keys plus required connector fields. */
export function getRegistryEntryRequiredKeyCount(entry: McpRegistryEntry): number {
  const requiredFields = entry.connector?.tokenSchema?.fields.filter(field => field.required).length ?? 0;
  return (entry.requiredEnvKeys?.length ?? 0) + requiredFields;
}

const URL_HOST_RE = /^https?:\/\/([^/?#]+)/i;

/**
 * Short "where it runs" text for a marketplace card: the host of a remote
 * connector (templates keep their `${KEY}` out of view), else the command.
 */
export function getRegistryEntryEndpointSummary(entry: McpRegistryEntry): string {
  const url = entry.connector?.url;
  if (url) {
    const host = URL_HOST_RE.exec(url)?.[1];
    return host && !host.includes('${') ? host : url;
  }
  if (!entry.command) return '';
  if (entry.defaultArgs.length === 0) return entry.command;
  return `${entry.command} ${entry.defaultArgs[entry.defaultArgs.length - 1]}`;
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
