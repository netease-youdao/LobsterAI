/**
 * Pure synchronous guard helpers for blocking disallowed desktop Office GUI
 * application launches (Keynote / WPS / Pages / Numbers / Microsoft Office /
 * non-headless LibreOffice) inside DSH's monotonic `ctx.tools.guard(...)`.
 *
 * Zero DSH peer imports so Vitest can test this module directly.
 */

const SHELL_TOOL_NAMES = new Set(['bash', 'pwsh', 'shell', 'exec', 'terminal_exec']);

const OFFICE_GUI_APP_NAMES =
  'Keynote|Pages|Numbers|WPS\\s*Office|wpsoffice|Microsoft\\s+Word|Microsoft\\s+PowerPoint|Microsoft\\s+Excel|LibreOffice|OpenOffice';
const OFFICE_DOC_EXTENSIONS = 'pptx|pptm|ppt|docx|docm|doc|xlsx|xlsm|xls';

const OSASCRIPT_OFFICE_GUI_RE = new RegExp(
  `\\bosascript\\b[\\s\\S]*\\btell\\s+(?:application|app)\\s+['"]?(${OFFICE_GUI_APP_NAMES})\\b`,
  'i',
);
const MAC_OPEN_OFFICE_GUI_RE = new RegExp(
  `(?:^|[\\n;&|(]\\s*)(?:\\/usr\\/bin\\/)?open\\b[^\\n;|&]*\\s-a\\s+['"]?(?:\\/[^\\s'"]*\\/)?(${OFFICE_GUI_APP_NAMES})(?:\\.app)?['"]?`,
  'i',
);
const MAC_OPEN_OFFICE_FILE_RE = new RegExp(
  `(?:^|[\\n;&|(]\\s*)(?:\\/usr\\/bin\\/)?open\\s+(?![^\\n;|&]*\\bhttps?:\\/\\/)[^\\n;|&]*\\.(${OFFICE_DOC_EXTENSIONS})(?=['"\\s;|&)\\n]|$)`,
  'i',
);
const DIRECT_OFFICE_MACOS_BINARY_RE =
  /(wpsoffice|Keynote|Pages|Numbers|Microsoft\s+Word|Microsoft\s+PowerPoint|Microsoft\s+Excel)\.app\/Contents\/MacOS\//i;
const WIN_START_OFFICE_GUI_RE =
  /(?:^|[\n;&|(]\s*)start\b[^\n;|&]*\b(WINWORD|POWERPNT|EXCEL|wps|et|wpp)(?:\.exe)?\b/i;
const PWSH_INVOKE_ITEM_OFFICE_FILE_RE = new RegExp(
  `(?:^|[\\n;&|(]\\s*|-(?:Command|c)\\s+['"]?\\s*)(Invoke-Item|ii)\\s+(?![^\\n;|&]*\\bhttps?:\\/\\/)[^\\n;|&]*\\.(${OFFICE_DOC_EXTENSIONS})(?=['"\\s;|&)\\n]|$)`,
  'i',
);
const INTERACTIVE_SOFFICE_CMD_RE =
  /(?:^|[\n;&|(]\s*|(?:timeout\s+\d+\s+))(?:\/[^\s]*\/)?(soffice|libreoffice)\b(?!\s+(?:--version|--help|-h)\b)/i;

/**
 * Extract the shell command text from a DSH tool execution's arguments.
 * @param {string} toolName
 * @param {unknown} args
 * @returns {string}
 */
export function extractShellCommand(toolName, args) {
  if (typeof toolName !== 'string' || !SHELL_TOOL_NAMES.has(toolName.trim().toLowerCase())) {
    return '';
  }
  if (!args || typeof args !== 'object') return '';
  const record = /** @type {Record<string, unknown>} */ (args);
  if (typeof record.command === 'string') return record.command;
  if (typeof record.cmd === 'string') return record.cmd;
  if (typeof record.script === 'string') return record.script;
  return '';
}

/**
 * Return a Chinese denial reason if a shell tool call attempts to launch a
 * desktop Office GUI app, or `undefined` when allowed.
 * @param {string} toolName
 * @param {unknown} args
 * @returns {string | undefined}
 */
export function evaluateOfficeGuiGuard(toolName, args) {
  const command = extractShellCommand(toolName, args);
  if (!command) return undefined;

  const osaMatch = OSASCRIPT_OFFICE_GUI_RE.exec(command);
  if (osaMatch) {
    return `禁止通过 AppleScript 启动桌面办公软件「${osaMatch[1]}」预览或转换文档。请使用无头脚本（如 PPT 使用 preview_html.js，Word/Excel 使用代码重开校验或可用的 soffice --headless），若无无头渲染工具则跳过视觉转图并直接交付文件链接。`;
  }

  const openMatch = MAC_OPEN_OFFICE_GUI_RE.exec(command);
  if (openMatch) {
    return `禁止使用 open -a 启动桌面办公软件「${openMatch[1]}」。请勿通过桌面 GUI 预览或检查文档；向用户交付文件时直接提供 Markdown 链接 [文件名](file:///绝对路径) 即可。`;
  }

  const openFileMatch = MAC_OPEN_OFFICE_FILE_RE.exec(command);
  if (openFileMatch) {
    return `禁止使用 open 直接打开办公文档（.${openFileMatch[1]}），会弹出桌面办公软件窗口。请勿通过桌面 GUI 预览或检查文档；向用户交付文件时直接提供 Markdown 链接 [文件名](file:///绝对路径) 即可。`;
  }

  const directBinMatch = DIRECT_OFFICE_MACOS_BINARY_RE.exec(command);
  if (directBinMatch) {
    return `禁止直接执行桌面办公软件「${directBinMatch[1]}」的可执行文件（会弹出桌面窗口）。请改用无头命令行校验或直接交付。`;
  }

  const winStartMatch = WIN_START_OFFICE_GUI_RE.exec(command);
  if (winStartMatch) {
    return `禁止启动桌面办公软件「${winStartMatch[1]}」预览或校验文档，请使用无头校验或直接提供文件链接。`;
  }

  const invokeItemMatch = PWSH_INVOKE_ITEM_OFFICE_FILE_RE.exec(command);
  if (invokeItemMatch) {
    return `禁止使用 ${invokeItemMatch[1]} 直接打开办公文档（.${invokeItemMatch[2]}），会弹出桌面办公软件窗口。请勿通过桌面 GUI 预览或检查文档；向用户交付文件时直接提供 Markdown 链接 [文件名](file:///绝对路径) 即可。`;
  }

  const sofficeMatch = INTERACTIVE_SOFFICE_CMD_RE.exec(command);
  if (sofficeMatch && !/--headless\b/i.test(command)) {
    return '调用 soffice / libreoffice 时必须携带 --headless 参数，禁止以桌面 GUI 模式启动。';
  }

  return undefined;
}
