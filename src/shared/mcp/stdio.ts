export const StdioCommandValidationError = {
  NonString: 'non-string',
  Empty: 'empty',
  TooLong: 'too-long',
  ControlChar: 'control-char',
  ShellMeta: 'shell-meta',
  InlineArguments: 'inline-arguments',
  RelativePath: 'relative-path',
  PathTraversal: 'path-traversal',
  InvalidArgs: 'invalid-args',
  InvalidArgType: 'invalid-arg-type',
  TooManyArgs: 'too-many-args',
  ArgTooLong: 'arg-too-long',
  ArgControlChar: 'arg-control-char',
} as const;
export type StdioCommandValidationError =
  typeof StdioCommandValidationError[keyof typeof StdioCommandValidationError];

export type StdioCommandValidationResult =
  | { ok: true; command: string; args: string[] }
  | { ok: false; error: StdioCommandValidationError; detail?: string };

export const STDIO_COMMAND_MAX_LENGTH = 4096;
export const STDIO_ARG_MAX_LENGTH = 4096;
export const STDIO_ARGS_MAX_COUNT = 1024;

const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F]/;
const COMMAND_SHELL_META_RE = /[&|;<>`"'$%]/;
const ARG_SHELL_META_RE = /[&|;<>`]/;
const ABSOLUTE_PATH_RE = /^(?:[A-Za-z]:[\\/]|[\\/])/;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:/;

function hasPathTraversal(command: string): boolean {
  return command.split(/[\\/]+/).includes('..');
}

/**
 * Validate an MCP stdio command and its structured argument list.
 *
 * Commands must be either a bare executable name or an absolute path.
 * Arguments are passed as an array to the process spawner, so spaces and
 * `$` sequences are allowed in individual args; other shell metacharacters
 * are rejected so the config cannot smuggle a second command.
 */
export function validateStdioCommand(command: unknown, args?: unknown): StdioCommandValidationResult {
  if (typeof command !== 'string') {
    return { ok: false, error: StdioCommandValidationError.NonString };
  }

  const trimmed = command.trim();
  if (!trimmed) {
    return { ok: false, error: StdioCommandValidationError.Empty };
  }
  if (trimmed.length > STDIO_COMMAND_MAX_LENGTH) {
    return { ok: false, error: StdioCommandValidationError.TooLong };
  }
  if (CONTROL_CHAR_RE.test(trimmed)) {
    return { ok: false, error: StdioCommandValidationError.ControlChar };
  }
  if (COMMAND_SHELL_META_RE.test(trimmed)) {
    return { ok: false, error: StdioCommandValidationError.ShellMeta };
  }
  if (/\s/.test(trimmed) && !ABSOLUTE_PATH_RE.test(trimmed)) {
    return { ok: false, error: StdioCommandValidationError.InlineArguments };
  }
  if (hasPathTraversal(trimmed)) {
    return { ok: false, error: StdioCommandValidationError.PathTraversal };
  }
  if (
    trimmed.startsWith('~')
    || (WINDOWS_DRIVE_RE.test(trimmed) && !ABSOLUTE_PATH_RE.test(trimmed))
    || (!ABSOLUTE_PATH_RE.test(trimmed) && /[\\/]/.test(trimmed))
  ) {
    return { ok: false, error: StdioCommandValidationError.RelativePath };
  }

  if (args === undefined) {
    return { ok: true, command: trimmed, args: [] };
  }
  if (!Array.isArray(args)) {
    return { ok: false, error: StdioCommandValidationError.InvalidArgs };
  }
  if (args.length > STDIO_ARGS_MAX_COUNT) {
    return { ok: false, error: StdioCommandValidationError.TooManyArgs };
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg !== 'string') {
      return {
        ok: false,
        error: StdioCommandValidationError.InvalidArgType,
        detail: String(i),
      };
    }
    if (arg.length > STDIO_ARG_MAX_LENGTH) {
      return {
        ok: false,
        error: StdioCommandValidationError.ArgTooLong,
        detail: String(i),
      };
    }
    if (CONTROL_CHAR_RE.test(arg) || ARG_SHELL_META_RE.test(arg)) {
      return {
        ok: false,
        error: StdioCommandValidationError.ArgControlChar,
        detail: String(i),
      };
    }
  }

  return { ok: true, command: trimmed, args: args.slice() };
}

export function getStdioCommandValidationMessage(
  result: StdioCommandValidationResult,
): string {
  if (result.ok) return '';
  const failure = result as Extract<StdioCommandValidationResult, { ok: false }>;
  switch (failure.error) {
    case StdioCommandValidationError.NonString:
      return 'MCP stdio command must be a string';
    case StdioCommandValidationError.Empty:
      return 'MCP stdio command cannot be empty';
    case StdioCommandValidationError.TooLong:
      return 'MCP stdio command is too long';
    case StdioCommandValidationError.ControlChar:
      return 'MCP stdio command contains control characters';
    case StdioCommandValidationError.ShellMeta:
      return 'MCP stdio command contains shell metacharacters';
    case StdioCommandValidationError.InlineArguments:
      return 'MCP stdio command must be an executable path; arguments must be listed separately';
    case StdioCommandValidationError.RelativePath:
      return 'MCP stdio command must be an executable name or an absolute path';
    case StdioCommandValidationError.PathTraversal:
      return 'MCP stdio command must not contain ".." path segments';
    case StdioCommandValidationError.InvalidArgs:
      return 'MCP stdio args must be an array';
    case StdioCommandValidationError.InvalidArgType:
      return `MCP stdio arg at index ${failure.detail} must be a string`;
    case StdioCommandValidationError.TooManyArgs:
      return 'MCP stdio args list is too long';
    case StdioCommandValidationError.ArgTooLong:
      return `MCP stdio arg at index ${failure.detail} is too long`;
    case StdioCommandValidationError.ArgControlChar:
      return `MCP stdio arg at index ${failure.detail} contains control characters or shell metacharacters`;
  }
}
