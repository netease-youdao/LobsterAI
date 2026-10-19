import { DefaultAgentAvatarIcon, parseAgentAvatarIcon, parseAgentAvatarImageUrl } from './avatar';
import { isExpertAssetUrl } from './expertAssets';
import {
  type ExpertCatalog, ExpertCatalogSchemaVersion,   ExpertScenarioAccent, type ExpertStoreManifest,
type LocalizedExpertText,
} from './presets';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected expert configuration object');
  return value as Record<string, unknown>;
}

function text(value: unknown, max = 1000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Invalid expert text');
  return value.trim();
}

function id(value: unknown): string {
  const result = text(value, 100);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(result) || result === 'main') throw new Error('Invalid expert identifier');
  return result;
}

function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error('Invalid expert list');
  return value;
}

function localized(value: unknown, max = 1000): LocalizedExpertText {
  const item = object(value);
  return { zh: text(item.zh, max), en: text(item.en, max) };
}

function unique(values: string[]): Set<string> {
  const result = new Set(values);
  if (result.size !== values.length) throw new Error('Duplicate expert identifier');
  return result;
}

export function parseExpertStoreManifest(value: unknown): ExpertStoreManifest {
  const item = object(value);
  if (item.schemaVersion !== ExpertCatalogSchemaVersion) throw new Error('Unsupported expert manifest schema');
  const catalogUrl = text(item.catalogUrl, 2048);
  const sha256 = text(item.sha256, 64);
  if (!isExpertAssetUrl(catalogUrl) || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid expert manifest asset');
  return { schemaVersion: ExpertCatalogSchemaVersion, version: text(item.version, 100), catalogUrl, sha256 };
}

export function parseExpertCatalog(value: unknown): ExpertCatalog {
  const item = object(value);
  if (item.schemaVersion !== ExpertCatalogSchemaVersion) throw new Error('Unsupported expert catalog schema');
  const categories = list(item.categories, 100).map(value => {
    const category = object(value);
    return { id: id(category.id), label: localized(category.label, 100) };
  });
  const categoryIds = unique(categories.map(category => category.id));
  const experts = list(item.experts, 1000).map(value => {
    const expert = object(value);
    const category = id(expert.category);
    if (!categoryIds.has(category)) throw new Error('Unknown expert category');
    const tags = list(expert.tags, 20).map(value => localized(value, 100));
    const starterPrompts = list(expert.starterPrompts, 12).map(value => localized(value, 4000));
    if (!tags.length || !starterPrompts.length) throw new Error('Missing expert discovery content');
    const icon = typeof expert.icon === 'string' ? expert.icon.trim() : '';
    // Missing/retired avatars should not make an otherwise usable catalog unavailable.
    const normalizedIcon = parseAgentAvatarIcon(icon) || parseAgentAvatarImageUrl(icon) ? icon : DefaultAgentAvatarIcon;
    const skillIds = list(expert.skillIds, 50).map(id);
    unique(skillIds);
    return {
      id: id(expert.id), category, tags, starterPrompts, icon: normalizedIcon, skillIds,
      name: text(expert.name, 100), nameEn: text(expert.nameEn, 100),
      description: text(expert.description), descriptionEn: text(expert.descriptionEn),
      identity: text(expert.identity, 4000), identityEn: text(expert.identityEn, 4000),
      systemPrompt: text(expert.systemPrompt, 50000), systemPromptEn: text(expert.systemPromptEn, 50000),
    };
  });
  const expertIds = unique(experts.map(expert => expert.id));
  const accents = new Set<string>(Object.values(ExpertScenarioAccent));
  const scenarios = list(item.scenarios, 100).map(value => {
    const scenario = object(value);
    const ids = list(scenario.expertIds, 12).map(id);
    if (!ids.length || ids.some(id => !expertIds.has(id))) throw new Error('Unknown featured expert');
    unique(ids);
    const accent = text(scenario.accent, 30);
    if (!accents.has(accent)) throw new Error('Unknown expert scenario accent');
    return { id: id(scenario.id), title: localized(scenario.title, 100), description: localized(scenario.description),
      accent: accent as ExpertScenarioAccent, expertIds: ids };
  });
  unique(scenarios.map(scenario => scenario.id));
  return { schemaVersion: ExpertCatalogSchemaVersion, version: text(item.version, 100), categories, scenarios, experts };
}
