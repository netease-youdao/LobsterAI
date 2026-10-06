export type SidebarExperienceLogLevel = 'debug' | 'info' | 'warn';

export const logSidebarExperienceDiagnostic = (
  level: SidebarExperienceLogLevel,
  message: string,
  error?: unknown,
): void => {
  const formatted = `[SidebarExperience] ${message}`;
  if (level === 'warn') {
    console.warn(formatted, ...(error === undefined ? [] : [error]));
  } else if (level === 'debug') {
    console.debug(formatted);
  } else {
    console.log(formatted);
  }

  try {
    const boundedMessage = message.replace(/\s+/g, ' ').trim().slice(0, 340);
    const persistedMessage = error === undefined
      ? boundedMessage
      : `${boundedMessage}; errorType=${error instanceof Error ? error.name : typeof error}`;
    window.electron?.log?.fromRenderer?.(
      level,
      'SidebarExperience',
      persistedMessage.slice(0, 400),
    );
  } catch {
    // Diagnostics must never interrupt sidebar rendering or user actions.
  }
};
