import { LogReporterAction, reportYdAnalyzer } from '../../services/logReporter';
import { resolveLocalizedText } from '../../services/skill';
import type { InstalledKit, MarketplaceKit } from '../../types/kit';

type AnalyticsValue = string | number | boolean | null | undefined;
type AnalyticsParams = Record<string, AnalyticsValue>;

export function serializeKitAnalyticsList(values: Array<string | number | null | undefined>): string {
  return values
    .filter((value): value is string | number => value !== null && value !== undefined && value !== '')
    .map(String)
    .join(',');
}

export function getKitAnalyticsParams(
  kit: MarketplaceKit,
  installedKit?: InstalledKit,
): AnalyticsParams {
  const skillList = kit.skills?.list ?? [];
  const installedVersion = installedKit?.version;
  const hasUpdate = Boolean(
    installedVersion
    && kit.version
    && installedVersion !== kit.version,
  );

  return {
    kitId: kit.id,
    kitName: resolveLocalizedText(kit.name),
    kitSource: installedKit ? 'installed' : 'lobsterai-kits',
    isInstalled: Boolean(installedKit),
    version: kit.version,
    installedVersion,
    currentVersion: hasUpdate ? kit.version : undefined,
    hasUpdate,
    skillCount: skillList.length,
    skillIds: serializeKitAnalyticsList(skillList.map(skill => skill.id)),
    skillNames: serializeKitAnalyticsList(skillList.map(skill => resolveLocalizedText(skill.name))),
    mcpServerCount: kit.mcpServers?.length ?? 0,
    connectorCount: kit.connectors?.length ?? 0,
    hasTryAsking: Boolean(kit.tryAsking?.length),
  };
}

export function reportKitAction(
  actionType: string,
  params: AnalyticsParams = {},
): void {
  console.debug('[Kits] reporting analytics action', actionType);
  void reportYdAnalyzer({
    action: LogReporterAction.ExpertKitAction,
    actionType,
    ...params,
  });
}
