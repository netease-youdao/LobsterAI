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
  const managedAllowlist = previousPolicy && Object.keys(previousPolicy).length === 1
    && previousRefs.length > 0 && matchesModelRefs(previousPolicy.allow, previousRefs);
  if (managedAllowlist || (policy === undefined && previousMigrations?.modelPolicyAllowlist !== true)) {
    // Reuse the existing order when the set is unchanged to avoid a write just
    // because OpenClaw serialized an equivalent allowlist in a different order.
    policy = nextRefs.length > 0
      ? (previousPolicy && matchesModelRefs(previousPolicy.allow, nextRefs)
        ? previousPolicy
        : { allow: nextRefs })
      : undefined;
  }

  const nextDefaults = { ...defaults };
  delete nextDefaults.modelPolicy;
  if (policy !== undefined) nextDefaults.modelPolicy = policy;

  const meta = asRecord(config.meta);
  return {
    ...config,
    agents: { ...agents, defaults: nextDefaults },
    meta: {
      ...meta,
      migrations: {
        ...previousMigrations,
        ...asRecord(meta?.migrations),
        modelPolicyAllowlist: true,
      },
    },
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
