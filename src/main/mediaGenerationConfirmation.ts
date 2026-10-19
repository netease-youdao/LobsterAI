/** Missing, malformed, denied, or free-text replies never authorize a paid submission. */
export function isMediaGenerationConfirmed(response: unknown, question: string, acceptLabel: string): boolean {
  if (!response || typeof response !== 'object') return false;
  const result = response as { behavior?: unknown; answers?: Record<string, unknown> };
  return result.behavior === 'allow' && result.answers?.[question] === acceptLabel;
}
