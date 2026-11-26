import { resolveLocalizedText } from '../../services/skill';
import type { InstalledKit, MarketplaceKit } from '../../types/kit';

const MAX_DESCRIPTION_LENGTH = 480;
const MAX_SKILL_REFS = 32;
const MAX_INTEGRATION_REFS = 16;

type KitCapabilityRef = {
  id: string;
  name?: string;
  description?: string;
};

const escapeXmlText = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const escapeXmlAttribute = (value: string): string =>
  escapeXmlText(value).replace(/"/g, '&quot;');

const normalizePromptText = (value: string): string =>
  value.replace(/\s+/g, ' ').trim();

const truncateText = (value: string, maxLength: number): string => {
  const normalized = normalizePromptText(value);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const getStringField = (
  record: Record<string, unknown>,
  keys: string[],
): string | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
};

const normalizeCapabilityList = (value: unknown): unknown[] => (
  Array.isArray(value) ? value : []
);

const normalizeIntegrationRefs = (items: unknown[]): KitCapabilityRef[] => {
  return items.map((item, index) => {
    if (typeof item === 'string') {
      return { id: item, name: item };
    }
    if (!isRecord(item)) {
      return { id: `item-${index + 1}` };
    }

    const id = getStringField(item, ['id', 'name', 'serverId', 'connectorId']) ?? `item-${index + 1}`;
    const name = getStringField(item, ['name', 'displayName', 'title']);
    const description = getStringField(item, ['description', 'description_zh', 'description_en']);
    return {
      id,
      ...(name && name !== id ? { name } : {}),
      ...(description ? { description: truncateText(description, MAX_DESCRIPTION_LENGTH) } : {}),
    };
  });
};

const buildSkillRefs = (
  kit: MarketplaceKit | undefined,
  installedKit: InstalledKit | undefined,
): KitCapabilityRef[] => {
  const marketplaceSkillRefs = kit?.skills?.list ?? [];
  if (marketplaceSkillRefs.length > 0) {
    return marketplaceSkillRefs.map(skill => ({
      id: skill.id,
      name: resolveLocalizedText(skill.name),
    }));
  }

  return installedKit?.skills?.skillIds.map(skillId => ({
    id: skillId,
    name: skillId,
  })) ?? [];
};

const buildSelfClosingCapabilityTag = (
  tagName: string,
  ref: KitCapabilityRef,
): string => {
  const attributes = [
    `id="${escapeXmlAttribute(ref.id)}"`,
    ref.name ? `name="${escapeXmlAttribute(ref.name)}"` : undefined,
    ref.description ? `description="${escapeXmlAttribute(ref.description)}"` : undefined,
  ].filter(Boolean);
  return `      <${tagName} ${attributes.join(' ')} />`;
};

const buildCapabilityGroup = (
  groupName: string,
  itemName: string,
  refs: KitCapabilityRef[],
  maxItems: number,
): string[] => {
  if (refs.length === 0) {
    return [`    <${groupName} count="0" />`];
  }

  const visibleRefs = refs.slice(0, maxItems);
  const omittedCount = Math.max(0, refs.length - visibleRefs.length);
  return [
    `    <${groupName} count="${refs.length}"${omittedCount > 0 ? ` omitted="${omittedCount}"` : ''}>`,
    ...visibleRefs.map(ref => buildSelfClosingCapabilityTag(itemName, ref)),
    `    </${groupName}>`,
  ];
};

export const buildSelectedKitContextPrompt = (
  kitIds: string[],
  marketplaceKits: MarketplaceKit[],
  installedKits: Record<string, InstalledKit>,
): string | undefined => {
  if (kitIds.length === 0) return undefined;

  const kitEntries = kitIds.map((kitId) => {
    const kit = marketplaceKits.find(item => item.id === kitId);
    const installedKit = installedKits[kitId];
    const name = kit?.name ? resolveLocalizedText(kit.name) : kitId;
    const description = kit?.description
      ? truncateText(resolveLocalizedText(kit.description), MAX_DESCRIPTION_LENGTH)
      : '';
    const skillRefs = buildSkillRefs(kit, installedKit);
    const mcpServerRefs = normalizeIntegrationRefs(
      normalizeCapabilityList(installedKit?.mcpServers ?? kit?.mcpServers)
    );
    const connectorRefs = normalizeIntegrationRefs(
      normalizeCapabilityList(installedKit?.connectors ?? kit?.connectors)
    );

    return [
      '  <kit>',
      `    <id>${escapeXmlText(kitId)}</id>`,
      `    <name>${escapeXmlText(name)}</name>`,
      ...(description ? [`    <description>${escapeXmlText(description)}</description>`] : []),
      ...buildCapabilityGroup('skills', 'skill', skillRefs, MAX_SKILL_REFS),
      ...buildCapabilityGroup('mcpServers', 'mcpServer', mcpServerRefs, MAX_INTEGRATION_REFS),
      ...buildCapabilityGroup('connectors', 'connector', connectorRefs, MAX_INTEGRATION_REFS),
      '  </kit>',
    ].join('\n');
  });

  return [
    '## 本轮已选能力包（Kit）',
    '用户选择了以下能力包，请据此理解能力包边界与用途。其中列出的技能、MCP 服务与连接器仅作内部参考，除非用户明确询问，否则不要主动罗列内部组件。',
    '<selected_kits>',
    ...kitEntries,
    '</selected_kits>',
  ].join('\n');
};
