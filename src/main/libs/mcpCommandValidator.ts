import path from 'path';

/**
 * MCP stdio command validator.
 *
 * Prevents arbitrary command injection by enforcing:
 * 1. Shell metacharacter rejection (always)
 * 2. Allowlist enforcement for built-in / marketplace servers
 * 3. Confirmation requirement for unknown commands from manual creation
 */

// Shell metacharacters that should never appear in a command or its arguments.
// These characters enable command chaining, piping, subshell execution, and
// variable expansion — none of which are legitimate for an MCP server command.
// Note: backslash is not included because it is a valid path separator on Windows.
const SHELL_META_PATTERN = /[;|&`$(){}<>\n\r]/;

// Known-safe base commands for stdio MCP servers.
// This list covers all standard MCP server runtimes.
const ALLOWED_COMMANDS = new Set([
  // Node.js ecosystem
  'node', 'node.exe',
  'npx', 'npx.cmd',
  'npm', 'npm.cmd',
  // Python ecosystem
  'python', 'python3', 'python.exe', 'python3.exe',
  'uvx', 'uv',
  'pip', 'pip3',
  // Other runtimes
  'docker', 'docker.exe',
  'deno', 'deno.exe',
  'bun', 'bun.exe',
]);

export interface CommandValidationResult {
  /** Whether the command passed all checks. */
  valid: boolean;
  /**
   * When true, the command is syntactically safe but not in the known allowlist.
   * The caller should ask the user for explicit confirmation before proceeding.
   * Only set when `valid` is true.
   */
  needsConfirmation: boolean;
  /** Human-readable error message when `valid` is false. */
  error?: string;
  /** Trimmed command string, available when `valid` is true. */
  sanitizedCommand?: string;
}

/**
 * Check whether a single string contains shell metacharacters.
 */
function containsShellMeta(value: string): boolean {
  return SHELL_META_PATTERN.test(value);
}

/**
 * Extract the basename of a command, handling absolute / relative paths.
 * e.g. "/usr/local/bin/node" → "node", "npx" → "npx"
 */
function commandBasename(command: string): string {
  return path.basename(command).toLowerCase();
}

/**
 * Check whether a command basename is in the known-safe allowlist.
 */
export function isAllowedCommand(command: string): boolean {
  const basename = commandBasename(command);
  return ALLOWED_COMMANDS.has(basename);
}

/**
 * Validate a stdio MCP server command and its arguments.
 *
 * @param command  - The command string (e.g. "npx", "/usr/bin/python3")
 * @param args     - The argument list
 * @param isBuiltIn - Whether this server originates from the built-in registry / marketplace
 */
export function validateMcpCommand(
  command?: string,
  args?: string[],
  isBuiltIn?: boolean,
): CommandValidationResult {
  const trimmed = (command || '').trim();

  // 1. Empty command
  if (!trimmed) {
    return { valid: false, needsConfirmation: false, error: 'Command is required for stdio transport' };
  }

  // 2. Shell metacharacters in command
  if (containsShellMeta(trimmed)) {
    return {
      valid: false,
      needsConfirmation: false,
      error: `Command contains disallowed characters: ${trimmed}`,
    };
  }

  // 3. Shell metacharacters in args
  if (args && args.length > 0) {
    for (const arg of args) {
      if (containsShellMeta(arg)) {
        return {
          valid: false,
          needsConfirmation: false,
          error: `Argument contains disallowed characters: ${arg}`,
        };
      }
    }
  }

  // 4. Allowlist check
  const allowed = isAllowedCommand(trimmed);

  if (!allowed && isBuiltIn) {
    // Built-in / marketplace servers must use known commands
    return {
      valid: false,
      needsConfirmation: false,
      error: `Built-in server command not recognized: ${trimmed}`,
    };
  }

  // 5. Command is safe (either in allowlist, or manual + no metacharacters)
  return {
    valid: true,
    needsConfirmation: !allowed,
    sanitizedCommand: trimmed,
  };
}

/**
 * Lightweight metacharacter-only check used by the defense-in-depth layer
 * in resolveStdioCommand(). Does NOT enforce the allowlist — only rejects
 * commands / args containing shell metacharacters.
 */
export function containsShellMetacharacters(command: string, args?: string[]): boolean {
  if (containsShellMeta(command)) return true;
  if (args) {
    for (const arg of args) {
      if (containsShellMeta(arg)) return true;
    }
  }
  return false;
}
