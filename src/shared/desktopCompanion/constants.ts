import type { CompanionAnalyticsEvent } from './analytics';
import type { CompanionAppCategory } from './appCategories';
import type { CompanionFileKind } from './fileKinds';
import type { CompanionHintTopic } from './hintPolicy';
import type { LanguageToolsBridge, SpeechStatus } from './languageTools';
import type { CompanionResultsBridge, CompanionResultState } from './results';
import type { CompanionScreenshotBridge } from './screenshot';
import type { CompanionSelectionAction } from './selectionActions';
import type { CompanionSelectionApp } from './selectionApps';
import type { CompanionSelectionTaskContext } from './selectionTaskContext';
import { type CompanionToolbarItem, DEFAULT_COMPANION_TOOLBAR_ORDER } from './selectionToolbar';

export const DesktopCompanionIpc = {
  ReportAnalytics: 'desktop-companion:report-analytics',
  GetState: 'desktop-companion:get-state',
  SetPreferences: 'desktop-companion:set-preferences',
  GetSelectionExcludedApps: 'desktop-companion:get-selection-excluded-apps',
  SetDraft: 'desktop-companion:set-draft',
  SelectSession: 'desktop-companion:select-session',
  ToggleOrb: 'desktop-companion:toggle-orb',
  TogglePanel: 'desktop-companion:toggle-panel',
  HidePanel: 'desktop-companion:hide-panel',
  OpenMain: 'desktop-companion:open-main',
  OpenMainPage: 'desktop-companion:open-main-page',
  ConsumeMainPage: 'desktop-companion:consume-main-page',
  MainPageRequested: 'desktop-companion:main-page-requested',
  ContextMenu: 'desktop-companion:context-menu',
  Drag: 'desktop-companion:drag',
  Changed: 'desktop-companion:changed',
  OrbFileDrag: 'desktop-companion:orb-file-drag',
  StageCommand: 'desktop-companion:stage-command',
  ResizeSurface: 'desktop-companion:resize-surface',
  Selection: 'desktop-companion:selection',
  SelectionCommand: 'desktop-companion:selection-command',
  QuickAnswerStart: 'desktop-companion:quick-answer-start',
  QuickAnswerAbort: 'desktop-companion:quick-answer-abort',
  QuickAnswerEvent: 'desktop-companion:quick-answer-event',
  RequestPermission: 'desktop-companion:request-permission',
  CopyText: 'desktop-companion:copy-text',
  /** The composer started a task; the orb follows it and its activity bubble appears. */
  TaskStarted: 'desktop-companion:task-started',
  /** The followed task finished, failed or needs input; bring its activity bubble back. */
  TaskUpdated: 'desktop-companion:task-updated',
  /** The composer window lets clicks through its empty room above the card. */
  PanelPassThrough: 'desktop-companion:panel-pass-through',
  /** Reserve the welcome dialog's own size while login is open in the composer. */
  PanelLoginVisible: 'desktop-companion:panel-login-visible',
  /** The composer has painted its opening frame and can reveal the native window. */
  PanelReady: 'desktop-companion:panel-ready',
} as const;

export const DesktopCompanionMainPage = {
  Kits: 'kits',
  Skills: 'skills',
} as const;
export type DesktopCompanionMainPage = typeof DesktopCompanionMainPage[keyof typeof DesktopCompanionMainPage];

export const DesktopCompanionSurface = {
  Mascot: 'mascot',
  Panel: 'panel',
  Stage: 'stage',
  Selection: 'selection',
  LanguageTools: 'language-tools',
  Screenshot: 'screenshot',
  Result: 'result',
} as const;
export type DesktopCompanionSurface = typeof DesktopCompanionSurface[keyof typeof DesktopCompanionSurface];

export const DesktopCompanionDragPhase = { Start: 'start', Move: 'move', End: 'end', Cancel: 'cancel' } as const;
export type DesktopCompanionDragPhase = typeof DesktopCompanionDragPhase[keyof typeof DesktopCompanionDragPhase];

export const DesktopCompanionFileDragPhase = { Enter: 'enter', Leave: 'leave', Drop: 'drop' } as const;
export type DesktopCompanionFileDragPhase = typeof DesktopCompanionFileDragPhase[keyof typeof DesktopCompanionFileDragPhase];

export const DesktopCompanionSnoozeMode = { Hidden: 'hidden', Quiet: 'quiet' } as const;
export type DesktopCompanionSnoozeMode = typeof DesktopCompanionSnoozeMode[keyof typeof DesktopCompanionSnoozeMode];

export interface DesktopCompanionSnooze {
  mode: DesktopCompanionSnoozeMode;
  until: number;
}

export const DesktopCompanionStoreKey = {
  Preferences: 'desktop-companion.preferences.v1',
  Position: 'desktop-companion.position.v1',
  Draft: 'desktop-companion.draft.v1',
  Session: 'desktop-companion.session.v1',
  Snooze: 'desktop-companion.snooze.v1',
  HintLedger: 'desktop-companion.hints.v1',
  Greeted: 'desktop-companion.greeted.v1',
} as const;

export const CompanionCapability = {
  Unsupported: 'unsupported',
  Off: 'off',
  NeedsPermission: 'needs-permission',
  Ready: 'ready',
} as const;
export type CompanionCapability = typeof CompanionCapability[keyof typeof CompanionCapability];

export const CompanionPermission = { Accessibility: 'accessibility' } as const;
export type CompanionPermission = typeof CompanionPermission[keyof typeof CompanionPermission];

export const DEFAULT_COMPANION_SKIN = 'lobster';

export interface DesktopCompanionPreferences {
  enabled: boolean;
  shortcut: string;
  skin: string;
  selectionToolbar: boolean;
  dragAssist: boolean;
  contextHints: boolean;
  selectionExcludedApps: string[];
  selectionToolbarOrder: CompanionToolbarItem[];
}

export interface DesktopCompanionAttachment {
  path: string;
  name: string;
  isImage?: boolean;
  isDirectory?: boolean;
}

export interface DesktopCompanionDraft {
  prompt: string;
  attachments: DesktopCompanionAttachment[];
  workingDirectory: string;
  selectionContext?: CompanionSelectionTaskContext;
}

export const DesktopCompanionStageKind = { None: 'none', Hint: 'hint', Drop: 'drop', Task: 'task' } as const;
export type DesktopCompanionStageKind = typeof DesktopCompanionStageKind[keyof typeof DesktopCompanionStageKind];

export const DesktopCompanionStageSide = { Left: 'left', Right: 'right' } as const;
export type DesktopCompanionStageSide = typeof DesktopCompanionStageSide[keyof typeof DesktopCompanionStageSide];

/** Where the quick panel's card sits: beside the orb on the side it opens to, or mid-screen when no orb is on screen. */
export const DesktopCompanionPanelPlacement = { ...DesktopCompanionStageSide, Center: 'center' } as const;
export type DesktopCompanionPanelPlacement = typeof DesktopCompanionPanelPlacement[keyof typeof DesktopCompanionPanelPlacement];

export const DesktopCompanionDropSource = { Global: 'global', Orb: 'orb' } as const;
export type DesktopCompanionDropSource = typeof DesktopCompanionDropSource[keyof typeof DesktopCompanionDropSource];

export interface DesktopCompanionDropFile {
  name: string;
  kind: CompanionFileKind;
}

export type DesktopCompanionStage =
  | { kind: typeof DesktopCompanionStageKind.None }
  | { kind: typeof DesktopCompanionStageKind.Hint; id: string; topic: CompanionHintTopic; variant: number }
  | {
    kind: typeof DesktopCompanionStageKind.Drop;
    id: string;
    source: DesktopCompanionDropSource;
    files: DesktopCompanionDropFile[];
    kinds: CompanionFileKind[];
  }
  | { kind: typeof DesktopCompanionStageKind.Task; id: string; sessionId: string };

export interface DesktopCompanionCapabilities {
  selection: CompanionCapability;
  foregroundApp: CompanionCapability;
  globalDrag: CompanionCapability;
}

export interface DesktopCompanionForeground {
  appId: string;
  category: CompanionAppCategory;
}

export interface DesktopCompanionState {
  result: CompanionResultState;
  speechStatus?: SpeechStatus;
  revision: number;
  preferences: DesktopCompanionPreferences;
  panelVisible: boolean;
  /** Identifies an opening even when a rapid close/reopen is batched by the renderer. */
  panelOpenRevision: number;
  sessionId: string | null;
  draft: DesktopCompanionDraft;
  shortcutUnavailable: boolean;
  snooze: DesktopCompanionSnooze | null;
  stage: DesktopCompanionStage;
  /** Which side of the character the stage opens on, so its tail can point back at it. */
  stageSide: DesktopCompanionStageSide;
  /** Where the quick panel's card sits in its window, and so which corner points back at the orb. */
  panelPlacement: DesktopCompanionPanelPlacement;
  fileDragActive: boolean;
  foreground: DesktopCompanionForeground | null;
  capabilities: DesktopCompanionCapabilities;
}

export interface DesktopCompanionResult {
  success: boolean;
  state: DesktopCompanionState;
  error?: string;
}

export const DesktopCompanionStageCommandType = {
  HintAccept: 'hint-accept',
  HintDismiss: 'hint-dismiss',
  HintMute: 'hint-mute',
  HintTimeout: 'hint-timeout',
  StageHover: 'stage-hover',
  DropAsk: 'drop-ask',
  DropStarted: 'drop-started',
  DropCancel: 'drop-cancel',
  TaskOpen: 'task-open',
  TaskDismiss: 'task-dismiss',
} as const;

export type DesktopCompanionStageCommand =
  | { type: typeof DesktopCompanionStageCommandType.HintAccept }
  | { type: typeof DesktopCompanionStageCommandType.HintDismiss }
  | { type: typeof DesktopCompanionStageCommandType.HintMute }
  | { type: typeof DesktopCompanionStageCommandType.HintTimeout }
  | { type: typeof DesktopCompanionStageCommandType.StageHover; hovering: boolean }
  | { type: typeof DesktopCompanionStageCommandType.DropAsk; attachments: DesktopCompanionAttachment[] }
  | { type: typeof DesktopCompanionStageCommandType.DropStarted; sessionId: string }
  | { type: typeof DesktopCompanionStageCommandType.DropCancel }
  | { type: typeof DesktopCompanionStageCommandType.TaskOpen }
  | { type: typeof DesktopCompanionStageCommandType.TaskDismiss };

export const DesktopCompanionSelectionMode = { Toolbar: 'toolbar', Answer: 'answer' } as const;
export type DesktopCompanionSelectionMode = typeof DesktopCompanionSelectionMode[keyof typeof DesktopCompanionSelectionMode];

/** Maximum UTF-8 payload size for selection intake and clipboard writes (1 MB). */
export const COMPANION_COPY_MAX_BYTES = 1_000_000;

export type CompanionCopyResult = { success: true } | { success: false; error: string };

export interface DesktopCompanionSelection {
  id: string;
  text: string;
  /** Oversized selections carry no text and only show a capacity notice. */
  tooLarge?: boolean;
  appId: string;
  actions: CompanionSelectionAction[];
  mode: DesktopCompanionSelectionMode;
  action: CompanionSelectionAction | null;
  pinned: boolean;
  /** The toolbar's "more" menu is open inside the same window. */
  menuOpen: boolean;
  /** Menu space is reserved above the toolbar when there is not enough room below. */
  menuUp: boolean;
  /** How tall the answer card may grow beside the selection before it scrolls. */
  cardMaxHeight?: number;
}

export const DesktopCompanionSelectionCommandType = {
  Run: 'run',
  Dismiss: 'dismiss',
  Pin: 'pin',
  ExcludeApp: 'exclude-app',
  Pause: 'pause',
  FocusInput: 'focus-input',
  More: 'more',
  Settings: 'settings',
  /** The pointer left the toolbar or card for the window's transparent margin, or came back. */
  PassThrough: 'pass-through',
} as const;

export type DesktopCompanionSelectionCommand =
  | { type: typeof DesktopCompanionSelectionCommandType.Run; action: CompanionSelectionAction }
  | { type: typeof DesktopCompanionSelectionCommandType.Dismiss }
  | { type: typeof DesktopCompanionSelectionCommandType.Pin; pinned: boolean }
  | { type: typeof DesktopCompanionSelectionCommandType.ExcludeApp }
  | { type: typeof DesktopCompanionSelectionCommandType.Pause }
  | { type: typeof DesktopCompanionSelectionCommandType.FocusInput }
  | { type: typeof DesktopCompanionSelectionCommandType.More; open: boolean }
  | { type: typeof DesktopCompanionSelectionCommandType.Settings }
  | { type: typeof DesktopCompanionSelectionCommandType.PassThrough; passThrough: boolean };

export interface CompanionQuickAnswerTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface CompanionQuickAnswerRequest {
  requestId: string;
  action: CompanionSelectionAction;
  text: string;
  question?: string;
  history?: CompanionQuickAnswerTurn[];
}

export const CompanionQuickAnswerErrorCode = { LoginRequired: 'login_required' } as const;
export type CompanionQuickAnswerErrorCode = typeof CompanionQuickAnswerErrorCode[keyof typeof CompanionQuickAnswerErrorCode];

export interface CompanionQuickAnswerResult {
  success: boolean;
  error?: string;
  code?: CompanionQuickAnswerErrorCode;
}

export const CompanionQuickAnswerEventType = { Delta: 'delta', Done: 'done', Error: 'error' } as const;

export type CompanionQuickAnswerEvent =
  | { requestId: string; type: typeof CompanionQuickAnswerEventType.Delta; text: string }
  | { requestId: string; type: typeof CompanionQuickAnswerEventType.Done }
  | { requestId: string; type: typeof CompanionQuickAnswerEventType.Error; message: string };

export interface CompanionSurfaceSize {
  width: number;
  height: number;
}

export interface DesktopCompanionBridge extends LanguageToolsBridge, CompanionScreenshotBridge, CompanionResultsBridge {
  reportAnalytics(event: CompanionAnalyticsEvent): Promise<void>;
  getState(): Promise<DesktopCompanionState>;
  setPreferences(patch: Partial<DesktopCompanionPreferences>): Promise<DesktopCompanionResult>;
  getSelectionExcludedApps(): Promise<CompanionSelectionApp[]>;
  setDraft(draft: DesktopCompanionDraft): Promise<DesktopCompanionState>;
  selectSession(sessionId: string | null): Promise<DesktopCompanionState>;
  /** Pointer activation uses the main process snapshot captured by drag(Start). */
  toggleOrb(fromPointer?: boolean): Promise<void>;
  togglePanel(): Promise<void>;
  hidePanel(): Promise<void>;
  openMain(sessionId?: string | null): Promise<void>;
  openMainPage(page: DesktopCompanionMainPage): Promise<void>;
  consumeMainPage(): Promise<DesktopCompanionMainPage | null>;
  onMainPageRequested(callback: () => void): () => void;
  showContextMenu(): Promise<void>;
  drag(phase: DesktopCompanionDragPhase): void;
  orbFileDrag(phase: DesktopCompanionFileDragPhase, kinds: CompanionFileKind[]): void;
  taskStarted(sessionId: string): Promise<void>;
  taskUpdated(): void;
  setPanelPassThrough(passThrough: boolean): void;
  setPanelLoginVisible(visible: boolean): void;
  panelReady(revision: number): Promise<boolean>;
  stageCommand(command: DesktopCompanionStageCommand): Promise<void>;
  resizeSurface(size: CompanionSurfaceSize): void;
  selectionCommand(command: DesktopCompanionSelectionCommand): Promise<void>;
  startQuickAnswer(request: CompanionQuickAnswerRequest): Promise<CompanionQuickAnswerResult>;
  abortQuickAnswer(requestId: string): Promise<void>;
  requestPermission(permission: CompanionPermission): Promise<DesktopCompanionState>;
  copyText(text: string): Promise<CompanionCopyResult>;
  onChanged(callback: (state: DesktopCompanionState) => void): () => void;
  onSelection(callback: (selection: DesktopCompanionSelection | null) => void): () => void;
  onQuickAnswer(callback: (event: CompanionQuickAnswerEvent) => void): () => void;
}

export const DEFAULT_DESKTOP_COMPANION_PREFERENCES: DesktopCompanionPreferences = {
  enabled: true,
  // Electron's Alt accelerator maps to Option on macOS and Alt on Windows.
  shortcut: 'Alt+Space',
  skin: DEFAULT_COMPANION_SKIN,
  selectionToolbar: true,
  dragAssist: true,
  contextHints: true,
  selectionExcludedApps: [],
  selectionToolbarOrder: [...DEFAULT_COMPANION_TOOLBAR_ORDER],
};

export const EMPTY_DESKTOP_COMPANION_DRAFT: DesktopCompanionDraft = {
  prompt: '',
  attachments: [],
  workingDirectory: '',
};

export const DesktopCompanionSize = {
  Orb: { width: 84, height: 84 },
  // Logical pixels from the work area's left or right edge; applied when an orb drag ends.
  OrbSnapDistance: 48,
  // Keep the default disc easy to see and grab alongside other desktop assistants.
  BrandMark: 40,
  // Window for the brand disc, status badge and shadow. Cards beside the orb
  // line up with the window's edges, so the window has to fit the art closely.
  BrandOrb: { width: 60, height: 60 },
  // File drags can summon actions outside the orb without enlarging its native hit area.
  DropProximityPadding: 128,
  DropProximityExitPadding: 32,
  // Window sizes include the transparent SurfacePad margin that holds the card shadow.
  // The quick panel is the home composer in a narrow card that grows upward. Its
  // window adds room above the card and toward the middle of the screen, so the
  // composer's menus and their submenus open beside the card without moving it.
  Composer: { width: 380, maxHeight: 560 },
  ComposerMenuRoom: 360,
  ComposerSideRoom: 400,
  // Preserve the welcome card's spacing independently of the prompt height and orb position.
  ComposerLogin: { width: 824, height: 412 },
  PanelCompactHeight: 280,
  Task: { width: 420, height: 112 },
  Hint: { width: 320, height: 168 },
  // A 420px card with generous drop targets, plus its transparent shadow margin.
  Drop: { width: 464, height: 188 },
  // A 48px toolbar plus the margin; the window always reserves ToolbarMenu space below or above it.
  Toolbar: { width: 680, height: 92 },
  ToolbarMenu: 200,
  // A card up to 400 × 600 plus the margin.
  Answer: { width: 444, height: 644 },
  Result: { width: 404, height: 644 },
  // A 330px summary bubble plus the transparent margin.
  ResultCompactWidth: 374,
  // About an answer card's first frame (title, quote, thinking, input), so one opening above the selection does not jump once measured.
  AnswerStartHeight: 240,
  SurfacePad: 22,
  Margin: 12,
  Gap: 6,
} as const;

export const DesktopCompanionTiming = {
  HintAutoDismissMs: 12_000,
  DropExpandDelayMs: 180,
  DropProximityPollMs: 60,
  DropLingerMs: 450,
  SnoozeHourMs: 60 * 60_000,
} as const;
