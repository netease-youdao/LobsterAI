/**
 * Shared dangerous-command detection used by both local Cowork (coworkRunner)
 * and IM channel auto-approve logic (imCoworkHandler).
 */

// Delete patterns
const DELETE_COMMAND_RE = /\b(rm|rmdir|unlink|del|erase|remove-item|trash)\b/i;
const FIND_DELETE_COMMAND_RE = /\bfind\b[\s\S]*\s-delete\b/i;
const GIT_CLEAN_COMMAND_RE = /\bgit\s+clean\b/i;
const OSASCRIPT_DELETE_RE = /\bosascript\b[\s\S]*\bdelete\b/i;

// Destructive patterns (high severity)
const RM_RECURSIVE_RE = /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f?|--recursive)\b/i;
const GIT_PUSH_FORCE_RE = /\bgit\s+push\s+.*(?:--force|-f)\b/i;
const GIT_RESET_HARD_RE = /\bgit\s+reset\s+--hard\b/i;
const DD_COMMAND_RE = /\bdd\b/i;
const MKFS_COMMAND_RE = /\bmkfs\b/i;

// Other destructive patterns (moderate severity)
const GIT_PUSH_RE = /\bgit\s+push\b/i;
const KILL_COMMAND_RE = /\b(kill|killall|pkill)\b/i;
const CHMOD_COMMAND_RE = /\b(chmod|chown)\b/i;

export type DangerLevel = 'safe' | 'caution' | 'destructive';

/**
 * Returns true if the command is a delete operation
 * (rm, rmdir, unlink, del, erase, remove-item, find -delete, git clean).
 */
export function isDeleteCommand(command: string): boolean {
  return DELETE_COMMAND_RE.test(command)
    || FIND_DELETE_COMMAND_RE.test(command)
    || GIT_CLEAN_COMMAND_RE.test(command)
    || OSASCRIPT_DELETE_RE.test(command);
}

/**
 * Returns true if the command is considered dangerous and should require
 * explicit user confirmation before execution.
 */
export function isDangerousCommand(command: string): boolean {
  return isDeleteCommand(command)
    || GIT_PUSH_RE.test(command)
    || GIT_RESET_HARD_RE.test(command)
    || KILL_COMMAND_RE.test(command)
    || CHMOD_COMMAND_RE.test(command);
}

/**
 * Returns the danger level and a short reason string for a command.
 * Used to display graded warnings in the permission modal.
 */
export function getCommandDangerLevel(command: string): {
  level: DangerLevel;
  reason: string;
} {
  // Destructive level — high risk, hard to reverse
  if (RM_RECURSIVE_RE.test(command)) {
    return { level: 'destructive', reason: 'recursive-delete' };
  }
  if (GIT_PUSH_FORCE_RE.test(command)) {
    return { level: 'destructive', reason: 'git-force-push' };
  }
  if (GIT_RESET_HARD_RE.test(command)) {
    return { level: 'destructive', reason: 'git-reset-hard' };
  }
  if (DD_COMMAND_RE.test(command)) {
    return { level: 'destructive', reason: 'disk-overwrite' };
  }
  if (MKFS_COMMAND_RE.test(command)) {
    return { level: 'destructive', reason: 'disk-format' };
  }

  // Caution level — potentially harmful but more recoverable
  if (isDeleteCommand(command)) {
    return { level: 'caution', reason: 'file-delete' };
  }
  if (GIT_PUSH_RE.test(command)) {
    return { level: 'caution', reason: 'git-push' };
  }
  if (KILL_COMMAND_RE.test(command)) {
    return { level: 'caution', reason: 'process-kill' };
  }
  if (CHMOD_COMMAND_RE.test(command)) {
    return { level: 'caution', reason: 'permission-change' };
  }

  return { level: 'safe', reason: '' };
}
