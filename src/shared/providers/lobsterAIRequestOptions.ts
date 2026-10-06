export const LobsterAIRequestCapability = {
  OptionsV1: 'lobsterai-options-v1',
} as const;

export type LobsterAIRequestCapability =
  typeof LobsterAIRequestCapability[keyof typeof LobsterAIRequestCapability];

export const LOBSTERAI_REQUEST_OPTIONS_FIELD = 'lobsterai_options';
export const LOBSTERAI_REQUEST_OPTIONS_VERSION = 1;

const LOBSTERAI_REQUEST_CAPABILITY_VALUES = new Set<string>(
  Object.values(LobsterAIRequestCapability),
);

export const parseLobsterAIRequestCapabilities = (
  value: unknown,
): LobsterAIRequestCapability[] | undefined => {
  if (!Array.isArray(value)) return undefined;

  const result: LobsterAIRequestCapability[] = [];
  const seen = new Set<LobsterAIRequestCapability>();
  for (const candidate of value) {
    if (
      typeof candidate !== 'string'
      || !LOBSTERAI_REQUEST_CAPABILITY_VALUES.has(candidate)
    ) {
      continue;
    }
    const capability = candidate as LobsterAIRequestCapability;
    if (!seen.has(capability)) {
      seen.add(capability);
      result.push(capability);
    }
  }
  return result.length > 0 ? result : undefined;
};

export const supportsLobsterAIRequestOptionsV1 = (
  capabilities: readonly LobsterAIRequestCapability[] | undefined,
): boolean => capabilities?.includes(LobsterAIRequestCapability.OptionsV1) === true;
