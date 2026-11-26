import { CompanionAppCategory } from './appCategories';
import { CompanionFileKind } from './fileKinds';

export const CompanionContextClipboardKind = {
  Text: 'text',
  Image: 'image',
} as const;
export type CompanionContextClipboardKind = typeof CompanionContextClipboardKind[keyof typeof CompanionContextClipboardKind];

/** A verified local file or folder currently open in the foreground app. */
export interface DesktopCompanionContextFile {
  path: string;
  name: string;
  kind: CompanionFileKind;
  isDirectory: boolean;
  isImage: boolean;
}

/** Lightweight metadata for an eligible clipboard item; full content is materialized only on click. */
export interface DesktopCompanionContextClipboard {
  kind: CompanionContextClipboardKind;
  fingerprint: string;
  charCount?: number;
  preview?: string;
  width?: number;
  height?: number;
}

/** On-demand context captured when the user explicitly opens the quick panel or hover launcher. */
export interface DesktopCompanionContextSnapshot {
  capturedAt: number;
  appId: string | null;
  category: CompanionAppCategory | null;
  activeFile?: DesktopCompanionContextFile;
  clipboard?: DesktopCompanionContextClipboard;
}

export const CompanionContextActionKind = {
  ActiveFile: 'active-file',
  Clipboard: 'clipboard',
  Screenshot: 'screenshot',
  PickFiles: 'pick-files',
  Template: 'template',
} as const;
export type CompanionContextActionKind = typeof CompanionContextActionKind[keyof typeof CompanionContextActionKind];

export const CompanionContextActionFileFilter = {
  Spreadsheet: 'spreadsheet',
  Document: 'document',
  Pdf: 'pdf',
  Presentation: 'presentation',
  Folder: 'folder',
  Any: 'any',
} as const;
export type CompanionContextActionFileFilter = typeof CompanionContextActionFileFilter[keyof typeof CompanionContextActionFileFilter];

export const CompanionContextActionId = {
  ActiveFilePrimary: 'active-file-primary',
  ActiveFileAttach: 'active-file-attach',
  ClipboardText: 'clipboard-text',
  ClipboardImage: 'clipboard-image',
  ChatScreenshotTodo: 'chat-screenshot-todo',
  ChatOrganize: 'chat-organize',
  BrowserScreenshotExplain: 'browser-screenshot-explain',
  BrowserResearch: 'browser-research',
  SpreadsheetPickAnalyze: 'spreadsheet-pick-analyze',
  SpreadsheetScreenshotChart: 'spreadsheet-screenshot-chart',
  SpreadsheetFormula: 'spreadsheet-formula',
  DocumentPickDigest: 'document-pick-digest',
  DocumentPickTranslate: 'document-pick-translate',
  DocumentDraft: 'document-draft',
  PdfPickDigest: 'pdf-pick-digest',
  PdfPickTranslate: 'pdf-pick-translate',
  PdfScreenshotExplain: 'pdf-screenshot-explain',
  PresentationPickScript: 'presentation-pick-script',
  PresentationOutline: 'presentation-outline',
  CodeScreenshotDebug: 'code-screenshot-debug',
  CodeExplain: 'code-explain',
  FilesPickOrganize: 'files-pick-organize',
  FilesPickDigest: 'files-pick-digest',
  MailDraftReply: 'mail-draft-reply',
  MailScreenshotSummary: 'mail-screenshot-summary',
  CalendarScreenshotExtract: 'calendar-screenshot-extract',
  CalendarPlanDay: 'calendar-plan-day',
  NotesOrganize: 'notes-organize',
  NotesScreenshotExtract: 'notes-screenshot-extract',
  UniversalScreenshot: 'universal-screenshot',
  UniversalPickFiles: 'universal-pick-files',
} as const;
export type CompanionContextActionId = typeof CompanionContextActionId[keyof typeof CompanionContextActionId];

export interface CompanionContextAction {
  id: CompanionContextActionId;
  kind: CompanionContextActionKind;
  labelKey: string;
  promptKey: string;
  /** Subtle highlight for live-captured P1 context (active file or clipboard). */
  emphasis?: boolean;
  fileFilter?: CompanionContextActionFileFilter;
  allowDirectory?: boolean;
  fileName?: string;
  fileKind?: CompanionFileKind;
  isDirectory?: boolean;
  clipboardKind?: CompanionContextClipboardKind;
  clipboardCharCount?: number;
  clipboardFingerprint?: string;
}

export interface DesktopCompanionContextActionRequest {
  actionId: CompanionContextActionId;
}

export interface DesktopCompanionContextActionResult {
  success: boolean;
  prompt?: string;
  pastedText?: string;
  attachments?: Array<{ path: string; name: string; isImage?: boolean; isDirectory?: boolean }>;
  error?: string;
}

export const COMPANION_MAX_CONTEXT_ACTIONS = 3;
export const COMPANION_CLIPBOARD_MIN_TEXT_CHARS = 40;
export const COMPANION_CLIPBOARD_MIN_MULTILINE_CHARS = 20;
export const COMPANION_CLIPBOARD_MAX_TEXT_CHARS = 200_000;
export const COMPANION_CLIPBOARD_MIN_IMAGE_PX = 32;
const MAX_DISPLAY_FILENAME_CHARS = 18;

const ACTIVE_FILE_ELIGIBLE_CATEGORIES: ReadonlySet<CompanionAppCategory> = new Set([
  CompanionAppCategory.Document,
  CompanionAppCategory.Spreadsheet,
  CompanionAppCategory.Presentation,
  CompanionAppCategory.Pdf,
  CompanionAppCategory.Files,
  CompanionAppCategory.Notes,
  CompanionAppCategory.Code,
]);

/** Categories that commonly hold a local document or folder worth inspecting on demand. */
export function supportsActiveFileInspection(category: CompanionAppCategory | null | undefined): boolean {
  return !!category && ACTIVE_FILE_ELIGIBLE_CATEGORIES.has(category);
}

/** Categories where the companion stays completely quiet even inside the quick panel. */
export function isContextSuggestionsBlocked(category: CompanionAppCategory | null | undefined): boolean {
  return category === CompanionAppCategory.Password || category === CompanionAppCategory.Meeting;
}

export function isCompanionContextActionId(value: unknown): value is CompanionContextActionId {
  return typeof value === 'string' && Object.values(CompanionContextActionId).some(id => id === value);
}

/** Maps a live active file or folder to its primary label and task prompt copy keys. */
export function activeFileActionCopyKeys(file: Pick<DesktopCompanionContextFile, 'kind' | 'isDirectory'>): {
  labelKey: string;
  promptKey: string;
} {
  if (file.isDirectory || file.kind === CompanionFileKind.Folder) {
    return {
      labelKey: 'desktopCompanionContextActiveFolderOrganize',
      promptKey: 'desktopCompanionDropOrganizePrompt',
    };
  }
  switch (file.kind) {
    case CompanionFileKind.Spreadsheet:
      return {
        labelKey: 'desktopCompanionContextActiveFileAnalyze',
        promptKey: 'desktopCompanionDropAnalyzePrompt',
      };
    case CompanionFileKind.Presentation:
      return {
        labelKey: 'desktopCompanionContextActiveFileOutline',
        promptKey: 'desktopCompanionDropOutlinePrompt',
      };
    case CompanionFileKind.Image:
      return {
        labelKey: 'desktopCompanionContextActiveFileDescribe',
        promptKey: 'desktopCompanionDropDescribePrompt',
      };
    default:
      return {
        labelKey: 'desktopCompanionContextActiveFileDigest',
        promptKey: 'desktopCompanionDropDigestPrompt',
      };
  }
}

export function clipboardTextPromptKey(category: CompanionAppCategory | null | undefined): string {
  switch (category) {
    case CompanionAppCategory.Chat:
      return 'desktopCompanionContextClipboardChatPrompt';
    case CompanionAppCategory.Code:
      return 'desktopCompanionContextClipboardCodePrompt';
    case CompanionAppCategory.Mail:
      return 'desktopCompanionContextClipboardMailPrompt';
    case CompanionAppCategory.Notes:
      return 'desktopCompanionContextClipboardNotesPrompt';
    default:
      return 'desktopCompanionContextClipboardDefaultPrompt';
  }
}

const APP_CATEGORY_ACTIONS: Partial<Record<CompanionAppCategory, readonly CompanionContextAction[]>> = {
  [CompanionAppCategory.Chat]: [
    {
      id: CompanionContextActionId.ChatScreenshotTodo,
      kind: CompanionContextActionKind.Screenshot,
      labelKey: 'desktopCompanionContextChatScreenshotTodo',
      promptKey: 'desktopCompanionContextChatScreenshotTodoPrompt',
    },
    {
      id: CompanionContextActionId.ChatOrganize,
      kind: CompanionContextActionKind.Template,
      labelKey: 'desktopCompanionContextChatOrganize',
      promptKey: 'desktopCompanionContextChatOrganizePrompt',
    },
  ],
  [CompanionAppCategory.Browser]: [
    {
      id: CompanionContextActionId.BrowserScreenshotExplain,
      kind: CompanionContextActionKind.Screenshot,
      labelKey: 'desktopCompanionContextBrowserScreenshotExplain',
      promptKey: 'desktopCompanionContextBrowserScreenshotExplainPrompt',
    },
    {
      id: CompanionContextActionId.BrowserResearch,
      kind: CompanionContextActionKind.Template,
      labelKey: 'desktopCompanionContextBrowserResearch',
      promptKey: 'desktopCompanionContextBrowserResearchPrompt',
    },
  ],
  [CompanionAppCategory.Spreadsheet]: [
    {
      id: CompanionContextActionId.SpreadsheetPickAnalyze,
      kind: CompanionContextActionKind.PickFiles,
      fileFilter: CompanionContextActionFileFilter.Spreadsheet,
      labelKey: 'desktopCompanionContextSpreadsheetPickAnalyze',
      promptKey: 'desktopCompanionDropAnalyzePrompt',
    },
    {
      id: CompanionContextActionId.SpreadsheetScreenshotChart,
      kind: CompanionContextActionKind.Screenshot,
      labelKey: 'desktopCompanionContextSpreadsheetScreenshotChart',
      promptKey: 'desktopCompanionContextSpreadsheetScreenshotChartPrompt',
    },
    {
      id: CompanionContextActionId.SpreadsheetFormula,
      kind: CompanionContextActionKind.Template,
      labelKey: 'desktopCompanionContextSpreadsheetFormula',
      promptKey: 'desktopCompanionContextSpreadsheetFormulaPrompt',
    },
  ],
  [CompanionAppCategory.Document]: [
    {
      id: CompanionContextActionId.DocumentPickDigest,
      kind: CompanionContextActionKind.PickFiles,
      fileFilter: CompanionContextActionFileFilter.Document,
      labelKey: 'desktopCompanionContextDocumentPickDigest',
      promptKey: 'desktopCompanionDropDigestPrompt',
    },
    {
      id: CompanionContextActionId.DocumentPickTranslate,
      kind: CompanionContextActionKind.PickFiles,
      fileFilter: CompanionContextActionFileFilter.Document,
      labelKey: 'desktopCompanionContextDocumentPickTranslate',
      promptKey: 'desktopCompanionDropTranslatePrompt',
    },
    {
      id: CompanionContextActionId.DocumentDraft,
      kind: CompanionContextActionKind.Template,
      labelKey: 'desktopCompanionContextDocumentDraft',
      promptKey: 'desktopCompanionContextDocumentDraftPrompt',
    },
  ],
  [CompanionAppCategory.Pdf]: [
    {
      id: CompanionContextActionId.PdfPickDigest,
      kind: CompanionContextActionKind.PickFiles,
      fileFilter: CompanionContextActionFileFilter.Pdf,
      labelKey: 'desktopCompanionContextPdfPickDigest',
      promptKey: 'desktopCompanionDropDigestPrompt',
    },
    {
      id: CompanionContextActionId.PdfPickTranslate,
      kind: CompanionContextActionKind.PickFiles,
      fileFilter: CompanionContextActionFileFilter.Pdf,
      labelKey: 'desktopCompanionContextPdfPickTranslate',
      promptKey: 'desktopCompanionDropTranslatePrompt',
    },
    {
      id: CompanionContextActionId.PdfScreenshotExplain,
      kind: CompanionContextActionKind.Screenshot,
      labelKey: 'desktopCompanionContextPdfScreenshotExplain',
      promptKey: 'desktopCompanionContextPdfScreenshotExplainPrompt',
    },
  ],
  [CompanionAppCategory.Presentation]: [
    {
      id: CompanionContextActionId.PresentationPickScript,
      kind: CompanionContextActionKind.PickFiles,
      fileFilter: CompanionContextActionFileFilter.Presentation,
      labelKey: 'desktopCompanionContextPresentationPickScript',
      promptKey: 'desktopCompanionDropScriptPrompt',
    },
    {
      id: CompanionContextActionId.PresentationOutline,
      kind: CompanionContextActionKind.Template,
      labelKey: 'desktopCompanionContextPresentationOutline',
      promptKey: 'desktopCompanionContextPresentationOutlinePrompt',
    },
  ],
  [CompanionAppCategory.Code]: [
    {
      id: CompanionContextActionId.CodeScreenshotDebug,
      kind: CompanionContextActionKind.Screenshot,
      labelKey: 'desktopCompanionContextCodeScreenshotDebug',
      promptKey: 'desktopCompanionContextCodeScreenshotDebugPrompt',
    },
    {
      id: CompanionContextActionId.CodeExplain,
      kind: CompanionContextActionKind.Template,
      labelKey: 'desktopCompanionContextCodeExplain',
      promptKey: 'desktopCompanionContextCodeExplainPrompt',
    },
  ],
  [CompanionAppCategory.Files]: [
    {
      id: CompanionContextActionId.FilesPickOrganize,
      kind: CompanionContextActionKind.PickFiles,
      fileFilter: CompanionContextActionFileFilter.Folder,
      allowDirectory: true,
      labelKey: 'desktopCompanionContextFilesPickOrganize',
      promptKey: 'desktopCompanionDropOrganizePrompt',
    },
    {
      id: CompanionContextActionId.FilesPickDigest,
      kind: CompanionContextActionKind.PickFiles,
      fileFilter: CompanionContextActionFileFilter.Any,
      labelKey: 'desktopCompanionContextFilesPickDigest',
      promptKey: 'desktopCompanionDropDigestPrompt',
    },
  ],
  [CompanionAppCategory.Mail]: [
    {
      id: CompanionContextActionId.MailDraftReply,
      kind: CompanionContextActionKind.Template,
      labelKey: 'desktopCompanionContextMailDraftReply',
      promptKey: 'desktopCompanionContextMailDraftReplyPrompt',
    },
    {
      id: CompanionContextActionId.MailScreenshotSummary,
      kind: CompanionContextActionKind.Screenshot,
      labelKey: 'desktopCompanionContextMailScreenshotSummary',
      promptKey: 'desktopCompanionContextMailScreenshotSummaryPrompt',
    },
  ],
  [CompanionAppCategory.Calendar]: [
    {
      id: CompanionContextActionId.CalendarScreenshotExtract,
      kind: CompanionContextActionKind.Screenshot,
      labelKey: 'desktopCompanionContextCalendarScreenshotExtract',
      promptKey: 'desktopCompanionContextCalendarScreenshotExtractPrompt',
    },
    {
      id: CompanionContextActionId.CalendarPlanDay,
      kind: CompanionContextActionKind.Template,
      labelKey: 'desktopCompanionContextCalendarPlanDay',
      promptKey: 'desktopCompanionContextCalendarPlanDayPrompt',
    },
  ],
  [CompanionAppCategory.Notes]: [
    {
      id: CompanionContextActionId.NotesOrganize,
      kind: CompanionContextActionKind.Template,
      labelKey: 'desktopCompanionContextNotesOrganize',
      promptKey: 'desktopCompanionContextNotesOrganizePrompt',
    },
    {
      id: CompanionContextActionId.NotesScreenshotExtract,
      kind: CompanionContextActionKind.Screenshot,
      labelKey: 'desktopCompanionContextNotesScreenshotExtract',
      promptKey: 'desktopCompanionContextNotesScreenshotExtractPrompt',
    },
  ],
};

const UNIVERSAL_ACTIONS: readonly CompanionContextAction[] = [
  {
    id: CompanionContextActionId.UniversalScreenshot,
    kind: CompanionContextActionKind.Screenshot,
    labelKey: 'desktopCompanionScreenshot',
    promptKey: '',
  },
  {
    id: CompanionContextActionId.UniversalPickFiles,
    kind: CompanionContextActionKind.PickFiles,
    fileFilter: CompanionContextActionFileFilter.Any,
    labelKey: 'desktopCompanionLauncherFiles',
    promptKey: '',
  },
];

function buildActiveFilePrimaryAction(file: DesktopCompanionContextFile): CompanionContextAction {
  const keys = activeFileActionCopyKeys(file);
  return {
    id: CompanionContextActionId.ActiveFilePrimary,
    kind: CompanionContextActionKind.ActiveFile,
    labelKey: keys.labelKey,
    promptKey: keys.promptKey,
    emphasis: true,
    fileName: file.name,
    fileKind: file.kind,
    isDirectory: file.isDirectory,
  };
}

function buildActiveFileAttachAction(file: DesktopCompanionContextFile): CompanionContextAction {
  return {
    id: CompanionContextActionId.ActiveFileAttach,
    kind: CompanionContextActionKind.ActiveFile,
    labelKey: file.isDirectory ? 'desktopCompanionContextActiveFolderAttach' : 'desktopCompanionContextActiveFileAttach',
    promptKey: '',
    fileName: file.name,
    fileKind: file.kind,
    isDirectory: file.isDirectory,
  };
}

function buildClipboardAction(
  clipboard: DesktopCompanionContextClipboard,
  category: CompanionAppCategory | null,
): CompanionContextAction {
  if (clipboard.kind === CompanionContextClipboardKind.Image) {
    return {
      id: CompanionContextActionId.ClipboardImage,
      kind: CompanionContextActionKind.Clipboard,
      labelKey: 'desktopCompanionContextClipboardImage',
      promptKey: '',
      emphasis: true,
      clipboardKind: CompanionContextClipboardKind.Image,
      clipboardFingerprint: clipboard.fingerprint,
    };
  }
  return {
    id: CompanionContextActionId.ClipboardText,
    kind: CompanionContextActionKind.Clipboard,
    labelKey: 'desktopCompanionContextClipboardText',
    promptKey: clipboardTextPromptKey(category),
    emphasis: true,
    clipboardKind: CompanionContextClipboardKind.Text,
    clipboardCharCount: clipboard.charCount,
    clipboardFingerprint: clipboard.fingerprint,
  };
}

/**
 * Resolves at most 3 contextual chips for the quick panel:
 * 1) P1 live active file/folder, 2) P1 eligible clipboard item, 3) P0 app-category actions.
 */
export function resolveCompanionContextActions(
  context: DesktopCompanionContextSnapshot | null | undefined,
  fallbackCategory: CompanionAppCategory | null | undefined = null,
): CompanionContextAction[] {
  const category = context?.category ?? fallbackCategory ?? null;
  if (isContextSuggestionsBlocked(category)) return [];

  const actions: CompanionContextAction[] = [];
  const activeFile = context?.activeFile;
  if (activeFile) {
    actions.push(buildActiveFilePrimaryAction(activeFile));
    actions.push(buildActiveFileAttachAction(activeFile));
  }
  if (context?.clipboard && actions.length < COMPANION_MAX_CONTEXT_ACTIONS) {
    actions.push(buildClipboardAction(context.clipboard, category));
  }

  const categoryActions = (category ? APP_CATEGORY_ACTIONS[category] : undefined) ?? [];
  const pool = categoryActions.length > 0
    ? categoryActions
    : actions.length === 0 ? UNIVERSAL_ACTIONS : [];

  for (const item of pool) {
    if (actions.length >= COMPANION_MAX_CONTEXT_ACTIONS) break;
    // Skip generic file pickers when we already have the exact open file/folder at hand.
    if (activeFile && item.kind === CompanionContextActionKind.PickFiles) continue;
    actions.push(item);
  }
  return actions;
}

/**
 * The hover launcher stays completely fixed unless a concrete local file or folder
 * is detected in the foreground app — never padded with generic slogans.
 */
export function resolveCompanionLauncherContextAction(
  context: DesktopCompanionContextSnapshot | null | undefined,
): CompanionContextAction | null {
  if (!context?.activeFile || isContextSuggestionsBlocked(context.category)) return null;
  return buildActiveFilePrimaryAction(context.activeFile);
}

/** Finds a static or dynamic action definition by ID for the given context snapshot. */
export function findCompanionContextAction(
  actionId: CompanionContextActionId,
  context: DesktopCompanionContextSnapshot | null | undefined,
  fallbackCategory: CompanionAppCategory | null | undefined = null,
): CompanionContextAction | null {
  const resolved = resolveCompanionContextActions(context, fallbackCategory);
  const direct = resolved.find(item => item.id === actionId);
  if (direct) return direct;
  // Allow running any known static P0 action even if context shifted slightly mid-click.
  for (const list of [...Object.values(APP_CATEGORY_ACTIONS), UNIVERSAL_ACTIONS]) {
    const match = list?.find(item => item.id === actionId);
    if (match) return match;
  }
  return null;
}

/** Shortens a filename while keeping its extension legible when possible. */
export function shortenContextFileName(name: string, maxChars = MAX_DISPLAY_FILENAME_CHARS): string {
  const trimmed = name.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const dot = trimmed.lastIndexOf('.');
  if (dot > 0 && trimmed.length - dot <= 6 && dot > 3) {
    const ext = trimmed.slice(dot);
    const stemBudget = Math.max(3, maxChars - ext.length - 1);
    return `${trimmed.slice(0, stemBudget)}…${ext}`;
  }
  return `${trimmed.slice(0, Math.max(3, maxChars - 1))}…`;
}

export function formatCompanionContextActionLabel(
  action: CompanionContextAction,
  t: (key: string) => string,
): string {
  const template = t(action.labelKey);
  if (action.fileName) {
    return template.replace('{name}', shortenContextFileName(action.fileName));
  }
  if (typeof action.clipboardCharCount === 'number') {
    return template.replace('{count}', String(action.clipboardCharCount));
  }
  return template;
}

const SENSITIVE_PATH_PATTERNS: readonly RegExp[] = [
  /^\/System(?:\/|$)/i,
  /^\/Library\/Keychains(?:\/|$)/i,
  /(?:^|[\\/])Library[\\/]Keychains(?:[\\/]|$)/i,
  /(?:^|[\\/])\.ssh(?:[\\/]|$)/i,
  /(?:^|[\\/])\.gnupg(?:[\\/]|$)/i,
  /(?:^|[\\/])\.aws(?:[\\/]|$)/i,
  /(?:^|[\\/])\.kube(?:[\\/]|$)/i,
  /(?:^|[\\/])\.env(?:\.[^\\/]+)?$/i,
  /(?:^|[\\/])(?:id_rsa|id_ed25519|id_ecdsa|credentials\.json|secrets?\.(?:json|ya?ml|toml))$/i,
];

/** Rejects system directories and common credential/secret file locations. */
export function isSensitiveContextPath(filePath: string): boolean {
  const normalized = filePath.trim();
  if (!normalized) return true;
  return SENSITIVE_PATH_PATTERNS.some(pattern => pattern.test(normalized));
}

const SECRET_PREFIX_PATTERN = /^(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|Bearer\s+[A-Za-z0-9._-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})$/;
const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

/** Avoids surfacing passwords, API keys, JWTs, or private keys copied to the clipboard. */
export function looksLikeSecretText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (PRIVATE_KEY_PATTERN.test(trimmed)) return true;
  if (SECRET_PREFIX_PATTERN.test(trimmed)) return true;
  // A single-line string with no whitespace and no CJK characters is very likely a URL, token, or password.
  if (!/[\s\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(trimmed) && !/^https?:\/\//i.test(trimmed)) {
    return true;
  }
  return false;
}

export function isEligibleClipboardText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > COMPANION_CLIPBOARD_MAX_TEXT_CHARS) return false;
  const multiline = trimmed.includes('\n');
  const minChars = multiline ? COMPANION_CLIPBOARD_MIN_MULTILINE_CHARS : COMPANION_CLIPBOARD_MIN_TEXT_CHARS;
  if (trimmed.length < minChars) return false;
  return !looksLikeSecretText(trimmed);
}

/** Converts a macOS AXDocument / AXURL string (`file:///...` or `/...`) into a local path. */
export function parseLocalFileReference(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let resolved: string | null = null;
  if (/^file:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (url.protocol !== 'file:') return null;
      // Reject remote SMB/network hostnames in file://host/path URLs.
      if (url.hostname && url.hostname.toLowerCase() !== 'localhost') return null;
      resolved = decodeURIComponent(url.pathname);
      // On Windows file:///C:/foo produces /C:/foo.
      if (/^\/[A-Za-z]:\//.test(resolved)) resolved = resolved.slice(1);
    } catch {
      return null;
    }
  } else if (trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    resolved = trimmed;
  }
  if (!resolved) return null;
  // Strip trailing slash from folder URLs like file:///Users/alice/Downloads/ while keeping root intact.
  if (resolved.length > 1 && !/^[A-Za-z]:[\\/]$/.test(resolved)) {
    resolved = resolved.replace(/[\\/]+$/, '');
  }
  return isSensitiveContextPath(resolved) ? null : resolved;
}
