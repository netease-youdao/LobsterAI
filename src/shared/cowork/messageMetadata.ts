/** Keep the persisted message and live renderer on the same patch semantics. */
export const mergeCoworkMediaDetails = (
  previous: Record<string, unknown> | undefined,
  next: Record<string, unknown>,
): Record<string, unknown> => {
  const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value > 1
    ? Math.floor(value) : undefined;
  const before = count(previous?.pollCount);
  const after = count(next.pollCount);
  const pollCount = before == null ? after : after == null ? before : Math.max(before, after);
  const result = { ...previous, ...next };
  delete result.pollCount;
  if (pollCount != null) result.pollCount = pollCount;
  return result;
};

export const mergeCoworkMessageMetadata = (
  previous: Record<string, unknown> | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> => {
  const details = patch.toolResultDetails;
  return { ...previous, ...patch,
    ...(details && typeof details === 'object' && !Array.isArray(details)
      ? { toolResultDetails: mergeCoworkMediaDetails(
        previous?.toolResultDetails as Record<string, unknown> | undefined, details as Record<string, unknown>) }
      : {}),
  };
};
