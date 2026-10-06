export type EnterpriseAccountLogLevel = 'debug' | 'warn';

const formatError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 500);
};

export const logEnterpriseAccountDiagnostic = (
  level: EnterpriseAccountLogLevel,
  message: string,
  error?: unknown,
): void => {
  const resolvedMessage = error === undefined
    ? message
    : `${message}: ${formatError(error)}`;

  if (level === 'warn') {
    console.warn(`[EnterpriseAccount] ${resolvedMessage}`);
  } else {
    console.debug(`[EnterpriseAccount] ${resolvedMessage}`);
  }
  try {
    window.electron?.log?.fromRenderer?.(level, 'EnterpriseAccount', resolvedMessage);
  } catch {
    // Diagnostics must never interrupt the user action they are reporting.
  }
};
