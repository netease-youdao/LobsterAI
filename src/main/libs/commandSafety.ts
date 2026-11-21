/**
 * Shared dangerous-command detection used by Cowork and IM channel auto-approve logic.
 */

import { isDeleteCommand } from '../../common/deleteCommand';

export { isDeleteCommand };

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

// Disallowed desktop Office GUI launch patterns (prevents agents from popping up
// WPS / Keynote / Pages / Microsoft Office windows during document validation).
const OFFICE_GUI_APP_NAMES =
  'Keynote|Pages|Numbers|WPS\\s*Office|wpsoffice|Microsoft\\s+Word|Microsoft\\s+PowerPoint|Microsoft\\s+Excel|LibreOffice|OpenOffice';
const OSASCRIPT_OFFICE_GUI_RE = new RegExp(
  `\\bosascript\\b[\\s\\S]*\\btell\\s+(?:application|app)\\s+['"]?(${OFFICE_GUI_APP_NAMES})\\b`,
  'i',
);
const MAC_OPEN_OFFICE_GUI_RE = new RegExp(
  `(?:^|[;&|]\\s*)open\\b[^\\n;|&]*\\s-a\\s+['"]?(?:\\/[^\\s'"]*\\/)?(${OFFICE_GUI_APP_NAMES})(?:\\.app)?['"]?`,
  'i',
);
const DIRECT_OFFICE_MACOS_BINARY_RE =
  /(wpsoffice|Keynote|Pages|Numbers|Microsoft\s+Word|Microsoft\s+PowerPoint|Microsoft\s+Excel)\.app\/Contents\/MacOS\//i;
const WIN_START_OFFICE_GUI_RE =
  /(?:^|[;&|]\s*)start\b[^\n;|&]*\b(WINWORD|POWERPNT|EXCEL|wps|et|wpp)(?:\.exe)?\b/i;
const INTERACTIVE_SOFFICE_CMD_RE =
  /(?:^|[;&|]\s*|(?:timeout\s+\d+\s+))(?:\/[^\s]*\/)?(soffice|libreoffice)\b(?!\s+(?:--version|--help|-h)\b)/i;

export type DangerLevel = 'safe' | 'caution' | 'destructive';

export interface DisallowedOfficeGuiLaunch {
  matched: boolean;
  app?: string;
  reason?: string;
}

/**
 * Detect shell commands that attempt to launch desktop Office GUI applications
 * (WPS, Keynote, Pages, Microsoft Office, or non-headless LibreOffice) which
 * hijack focus and disrupt the user during document generation/validation.
 */
export function detectDisallowedOfficeGuiLaunch(command: string): DisallowedOfficeGuiLaunch {
  if (!command || typeof command !== 'string') {
    return { matched: false };
  }

  const osaMatch = OSASCRIPT_OFFICE_GUI_RE.exec(command);
  if (osaMatch) {
    return {
      matched: true,
      app: osaMatch[1],
      reason: `禁止通过 AppleScript 启动桌面办公软件「${osaMatch[1]}」预览或转换文档。请使用无头脚本（如 PPT 使用 preview_html.js，Word/Excel 使用代码重开校验或可用的 soffice --headless），若无无头渲染工具则跳过视觉转图并直接交付文件链接。`,
    };
  }

  const openMatch = MAC_OPEN_OFFICE_GUI_RE.exec(command);
  if (openMatch) {
    return {
      matched: true,
      app: openMatch[1],
      reason: `禁止使用 open -a 启动桌面办公软件「${openMatch[1]}」。请勿通过桌面 GUI 预览或检查文档；向用户交付文件时直接提供 Markdown 链接 [文件名](file:///绝对路径) 即可。`,
    };
  }

  const directBinMatch = DIRECT_OFFICE_MACOS_BINARY_RE.exec(command);
  if (directBinMatch) {
    return {
      matched: true,
      app: directBinMatch[1],
      reason: `禁止直接执行桌面办公软件「${directBinMatch[1]}」的可执行文件（会弹出桌面窗口）。请改用无头命令行校验或直接交付。`,
    };
  }

  const winStartMatch = WIN_START_OFFICE_GUI_RE.exec(command);
  if (winStartMatch) {
    return {
      matched: true,
      app: winStartMatch[1],
      reason: `禁止启动桌面办公软件「${winStartMatch[1]}」预览或校验文档，请使用无头校验或直接提供文件链接。`,
    };
  }

  const sofficeMatch = INTERACTIVE_SOFFICE_CMD_RE.exec(command);
  if (sofficeMatch && !/--headless\b/i.test(command)) {
    return {
      matched: true,
      app: sofficeMatch[1],
      reason: '调用 soffice / libreoffice 时必须携带 --headless 参数，禁止以桌面 GUI 模式启动。',
    };
  }

  return { matched: false };
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
