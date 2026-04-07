type AppConfigLike = {
  model?: {
    defaultModel?: unknown;
    defaultModelProvider?: unknown;
  };
  providers?: Record<string, {
    enabled?: unknown;
    apiKey?: unknown;
    baseUrl?: unknown;
    apiFormat?: unknown;
    codingPlanEnabled?: unknown;
    models?: Array<{
      id?: unknown;
      name?: unknown;
      supportsImage?: unknown;
    }>;
  }>;
};

const asTrimmedString = (value: unknown): string => (
  typeof value === 'string' ? value.trim() : ''
);

const normalizeAppConfigRuntimeSnapshot = (config: AppConfigLike | null | undefined) => {
  const providers = Object.fromEntries(
    Object.entries(config?.providers ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([providerName, providerConfig]) => [
        providerName,
        {
          enabled: providerConfig?.enabled === true,
          apiKey: asTrimmedString(providerConfig?.apiKey),
          baseUrl: asTrimmedString(providerConfig?.baseUrl),
          apiFormat: asTrimmedString(providerConfig?.apiFormat),
          codingPlanEnabled: providerConfig?.codingPlanEnabled === true,
          models: (providerConfig?.models ?? []).map((model) => ({
            id: asTrimmedString(model?.id),
            name: asTrimmedString(model?.name),
            supportsImage: model?.supportsImage === true,
          })),
        },
      ])
  );

  return {
    model: {
      defaultModel: asTrimmedString(config?.model?.defaultModel),
      defaultModelProvider: asTrimmedString(config?.model?.defaultModelProvider),
    },
    providers,
  };
};

export function hasOpenClawRuntimeAppConfigChanges(
  previousConfig: AppConfigLike | null | undefined,
  nextConfig: AppConfigLike | null | undefined,
): boolean {
  return JSON.stringify(normalizeAppConfigRuntimeSnapshot(previousConfig))
    !== JSON.stringify(normalizeAppConfigRuntimeSnapshot(nextConfig));
}
