const asRecord = (value: unknown): Record<string, unknown> | undefined => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
);

const modelRefs = (models: unknown): string[] => (
  Object.keys(asRecord(models) ?? {}).filter(ref => ref.trim().length > 0)
);

const matchesModelRefs = (allow: unknown, refs: string[]): allow is string[] => (
  Array.isArray(allow) && allow.length === refs.length && refs.every(ref => allow.includes(ref))
);

const MODEL_POLICY_COMPAT_SELECTORS = new Set(['openrouter:auto', 'openrouter:free']);

const isPolicySegment = (value: string): boolean => (
  value.length > 0 && !/[\s*]/u.test(value)
  && [...value].every(char => char.codePointAt(0)! > 0x1f && char.codePointAt(0) !== 0x7f)
);

/**
 * v2026.8.1 validates explicit policies more strictly than legacy models keys.
 * Mirror its segment grammar for generated refs; unresolved refs must retain
 * the whole legacy map, rather than emitting a partial or empty allowlist.
 */
const canMaterializeModelRefs = (refs: string[], models: unknown): boolean => {
  const aliases = new Set(Object.values(asRecord(models) ?? {}).flatMap(entry => {
    const alias = asRecord(entry)?.alias;
    return typeof alias === 'string' && alias.trim() ? [alias.trim().toLowerCase()] : [];
  }));
  return refs.every(ref => {
    const trimmed = ref.trim();
    if (aliases.has(trimmed.toLowerCase()) || MODEL_POLICY_COMPAT_SELECTORS.has(trimmed.toLowerCase())) return true;
    const wildcardSegments = trimmed.split('/').map(segment => segment.trim());
    if (wildcardSegments.length >= 2 && wildcardSegments.at(-1) === '*') {
      return wildcardSegments.slice(0, -1).every(isPolicySegment);
    }
    const separator = trimmed.indexOf('/');
    if (separator <= 0) return false;
    const provider = trimmed.slice(0, separator).trim();
    const model = trimmed.slice(separator + 1).trim();
    return [provider, ...model.split('/')].every(isPolicySegment);
  });
};

/**
 * Finish a rebuilt LobsterAI config using OpenClaw v2026.8.1 model policy semantics.
 * A legacy models map was an allowlist; after migration it is metadata only.
 * Policies that exactly match the previous managed map are treated as managed
 * and refreshed. Other policies, explicit allow-any objects, and migrated policy
 * removal remain authoritative.
 */
export function withManagedOpenClawModelPolicy(
  config: Record<string, unknown>,
  previousConfig: unknown,
): Record<string, unknown> {
  const previous = asRecord(previousConfig);
  const previousDefaults = asRecord(asRecord(previous?.agents)?.defaults);
  const previousMigrations = asRecord(asRecord(previous?.meta)?.migrations);
  const previousPolicy = asRecord(previousDefaults?.modelPolicy);
  const previousRefs = modelRefs(previousDefaults?.models);
  const agents = asRecord(config.agents);
  const defaults = asRecord(agents?.defaults);
  const nextRefs = modelRefs(defaults?.models);

  let policy = previousDefaults?.modelPolicy;
  let deferred = false;
  const managedAllowlist = previousPolicy && Object.keys(previousPolicy).length === 1
    && previousRefs.length > 0 && matchesModelRefs(previousPolicy.allow, previousRefs);
  if (managedAllowlist || (policy === undefined && previousMigrations?.modelPolicyAllowlist !== true)) {
    deferred = !canMaterializeModelRefs(nextRefs, defaults?.models);
    // Reuse the existing order when the set is unchanged to avoid a write just
    // because OpenClaw serialized an equivalent allowlist in a different order.
    // This also repairs an invalid policy generated from the complete previous
    // map by older LobsterAI versions, without relaxing an authored policy.
    policy = !deferred && nextRefs.length > 0
      ? (previousPolicy && matchesModelRefs(previousPolicy.allow, nextRefs)
        ? previousPolicy
        : { allow: nextRefs })
      : undefined;
  }

  const nextDefaults = { ...defaults };
  delete nextDefaults.modelPolicy;
  if (policy !== undefined) nextDefaults.modelPolicy = policy;

  const meta = asRecord(config.meta);
  const migrations = { ...previousMigrations, ...asRecord(meta?.migrations) };
  // A missing marker keeps the entire legacy models map authoritative. Marking
  // a deferred migration complete would silently turn that map into metadata.
  if (deferred) delete migrations.modelPolicyAllowlist;
  else migrations.modelPolicyAllowlist = true;
  const nextMeta = { ...meta };
  delete nextMeta.migrations;
  if (Object.keys(migrations).length > 0) nextMeta.migrations = migrations;
  return {
    ...config,
    agents: { ...agents, defaults: nextDefaults },
    meta: nextMeta,
  };
}

/** Keep migration state in config comparisons; only write provenance is inert. */
export function withoutOpenClawWriteMetadata(config: Record<string, unknown>): Record<string, unknown> {
  const comparable = { ...config };
  const meta = { ...asRecord(config.meta) };
  delete meta.lastTouchedVersion;
  delete meta.lastTouchedAt; // Retired by OpenClaw v2026.8.1.
  delete comparable.meta;
  if (Object.keys(meta).length > 0) comparable.meta = meta;
  return comparable;
}
