import type { CompanionAppCategory } from './appCategories';
import type { CompanionFileKind } from './fileKinds';
import type { CompanionHintTopic } from './hintPolicy';
import type { LanguageToolsBridge, SpeechStatus } from './languageTools';
import type { CompanionSelectionAction } from './selectionActions';

export const DesktopCompanionIpc = {
  GetState: 'desktop-companion:get-state',
  SetPreferences: 'desktop-companion:set-preferences',
  SetDraft: 'desktop-companion:set-draft',
  SelectSession: 'desktop-companion:select-session',
  TogglePanel: 'desktop-companion:toggle-panel',
  HidePanel: 'desktop-companion:hide-panel',
  OpenMain: 'desktop-companion:open-main',
  ContextMenu: 'desktop-companion:context-menu',
  Drag: 'desktop-companion:drag',
  Changed: 'desktop-companion:changed',
  OrbPointer: 'desktop-companion:orb-pointer',
  OrbFileDrag: 'desktop-companion:orb-file-drag',
  OrbAttention: 'desktop-companion:orb-attention',
  Gaze: 'desktop-companion:gaze',
  StageCommand: 'desktop-companion:stage-command',
  ResizeSurface: 'desktop-companion:resize-surface',
  Selection: 'desktop-companion:selection',
  SelectionCommand: 'desktop-companion:selection-command',
  QuickAnswerStart: 'desktop-companion:quick-answer-start',
  QuickAnswerAbort: 'desktop-companion:quick-answer-abort',
  QuickAnswerEvent: 'desktop-companion:quick-answer-event',
  RequestPermission: 'desktop-companion:request-permission',
  CopyText: 'desktop-companion:copy-text',
} as const;

export const DesktopCompanionSurface = {
  Mascot: 'mascot',
  Panel: 'panel',
  Stage: 'stage',
  Selection: 'selection',
  LanguageTools: 'language-tools',
} as const;
export type DesktopCompanionSurface = typeof DesktopCompanionSurface[keyof typeof DesktopCompanionSurface];

export const DesktopCompanionDragPhase = { Start: 'start', Move: 'move', End: 'end', Cancel: 'cancel' } as const;
export type DesktopCompanionDragPhase = typeof DesktopCompanionDragPhase[keyof typeof DesktopCompanionDragPhase];

export const DesktopCompanionPointerPhase = { Enter: 'enter', Leave: 'leave' } as const;
export type DesktopCompanionPointerPhase = typeof DesktopCompanionPointerPhase[keyof typeof DesktopCompanionPointerPhase];

export const DesktopCompanionFileDragPhase = { Enter: 'enter', Leave: 'leave', Drop: 'drop' } as const;
export type DesktopCompanionFileDragPhase = typeof DesktopCompanionFileDragPhase[keyof typeof DesktopCompanionFileDragPhase];

export const DesktopCompanionDock = { None: 'none', Left: 'left', Right: 'right' } as const;
export type DesktopCompanionDock = typeof DesktopCompanionDock[keyof typeof DesktopCompanionDock];

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
  Dock: 'desktop-companion.dock.v1',
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
}

export const DesktopCompanionStageKind = { None: 'none', Hint: 'hint', Drop: 'drop' } as const;
export type DesktopCompanionStageKind = typeof DesktopCompanionStageKind[keyof typeof DesktopCompanionStageKind];

export const DesktopCompanionStageSide = { Left: 'left', Right: 'right' } as const;
export type DesktopCompanionStageSide = typeof DesktopCompanionStageSide[keyof typeof DesktopCompanionStageSide];

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
  };

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
  speechStatus?: SpeechStatus;
  revision: number;
  preferences: DesktopCompanionPreferences;
  panelVisible: boolean;
  sessionId: string | null;
  draft: DesktopCompanionDraft;
  shortcutUnavailable: boolean;
  snooze: DesktopCompanionSnooze | null;
  dock: DesktopCompanionDock;
  peeking: boolean;
  stage: DesktopCompanionStage;
  /** Which side of the character the stage opens on, so its tail can point back at it. */
  stageSide: DesktopCompanionStageSide;
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
} as const;

export type DesktopCompanionStageCommand =
  | { type: typeof DesktopCompanionStageCommandType.HintAccept }
  | { type: typeof DesktopCompanionStageCommandType.HintDismiss }
  | { type: typeof DesktopCompanionStageCommandType.HintMute }
  | { type: typeof DesktopCompanionStageCommandType.HintTimeout }
  | { type: typeof DesktopCompanionStageCommandType.StageHover; hovering: boolean }
  | { type: typeof DesktopCompanionStageCommandType.DropAsk; attachments: DesktopCompanionAttachment[] }
  | { type: typeof DesktopCompanionStageCommandType.DropStarted; sessionId: string }
  | { type: typeof DesktopCompanionStageCommandType.DropCancel };

export const DesktopCompanionSelectionMode = { Toolbar: 'toolbar', Answer: 'answer' } as const;
export type DesktopCompanionSelectionMode = typeof DesktopCompanionSelectionMode[keyof typeof DesktopCompanionSelectionMode];

export interface DesktopCompanionSelection {
  id: string;
  text: string;
  appId: string;
  actions: CompanionSelectionAction[];
  mode: DesktopCompanionSelectionMode;
  action: CompanionSelectionAction | null;
  pinned: boolean;
}

export const DesktopCompanionSelectionCommandType = {
  Run: 'run',
  Dismiss: 'dismiss',
  Pin: 'pin',
  ExcludeApp: 'exclude-app',
  Pause: 'pause',
  FocusInput: 'focus-input',
  More: 'more',
} as const;

export type DesktopCompanionSelectionCommand =
  | { type: typeof DesktopCompanionSelectionCommandType.Run; action: CompanionSelectionAction }
  | { type: typeof DesktopCompanionSelectionCommandType.Dismiss }
  | { type: typeof DesktopCompanionSelectionCommandType.Pin; pinned: boolean }
  | { type: typeof DesktopCompanionSelectionCommandType.ExcludeApp }
  | { type: typeof DesktopCompanionSelectionCommandType.Pause }
  | { type: typeof DesktopCompanionSelectionCommandType.FocusInput }
  | { type: typeof DesktopCompanionSelectionCommandType.More };

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

export const CompanionQuickAnswerEventType = { Delta: 'delta', Done: 'done', Error: 'error' } as const;

export type CompanionQuickAnswerEvent =
  | { requestId: string; type: typeof CompanionQuickAnswerEventType.Delta; text: string }
  | { requestId: string; type: typeof CompanionQuickAnswerEventType.Done }
  | { requestId: string; type: typeof CompanionQuickAnswerEventType.Error; message: string };

export interface CompanionSurfaceSize {
  width: number;
  height: number;
}

export interface CompanionGaze {
  x: number;
  y: number;
}

export interface DesktopCompanionBridge extends LanguageToolsBridge {
  getState(): Promise<DesktopCompanionState>;
  setPreferences(patch: Partial<DesktopCompanionPreferences>): Promise<DesktopCompanionResult>;
  setDraft(draft: DesktopCompanionDraft): Promise<DesktopCompanionState>;
  selectSession(sessionId: string | null): Promise<DesktopCompanionState>;
  togglePanel(): Promise<void>;
  hidePanel(): Promise<void>;
  openMain(sessionId?: string | null): Promise<void>;
  showContextMenu(): Promise<void>;
  drag(phase: DesktopCompanionDragPhase): void;
  orbPointer(phase: DesktopCompanionPointerPhase): void;
  orbFileDrag(phase: DesktopCompanionFileDragPhase, kinds: CompanionFileKind[]): void;
  /** The character has news (done, needs input, failed) and should not stay tucked away. */
  orbAttention(active: boolean): void;
  stageCommand(command: DesktopCompanionStageCommand): Promise<void>;
  resizeSurface(size: CompanionSurfaceSize): void;
  selectionCommand(command: DesktopCompanionSelectionCommand): Promise<void>;
  startQuickAnswer(request: CompanionQuickAnswerRequest): Promise<{ success: boolean; error?: string }>;
  abortQuickAnswer(requestId: string): Promise<void>;
  requestPermission(permission: CompanionPermission): Promise<DesktopCompanionState>;
  copyText(text: string): Promise<void>;
  onChanged(callback: (state: DesktopCompanionState) => void): () => void;
  onGaze(callback: (gaze: CompanionGaze) => void): () => void;
  onSelection(callback: (selection: DesktopCompanionSelection | null) => void): () => void;
  onQuickAnswer(callback: (event: CompanionQuickAnswerEvent) => void): () => void;
}

export const DEFAULT_DESKTOP_COMPANION_PREFERENCES: DesktopCompanionPreferences = {
  enabled: false,
  shortcut: '',
  skin: DEFAULT_COMPANION_SKIN,
  selectionToolbar: true,
  dragAssist: true,
  contextHints: true,
  selectionExcludedApps: [],
};

export const EMPTY_DESKTOP_COMPANION_DRAFT: DesktopCompanionDraft = {
  prompt: '',
  attachments: [],
  workingDirectory: '',
};

export const DesktopCompanionSize = {
  Orb: { width: 84, height: 84 },
  PeekVisible: 38,
  // Window sizes include the transparent SurfacePad margin that holds the card shadow.
  Panel: { width: 444, height: 584 },
  Hint: { width: 320, height: 168 },
  Drop: { width: 448, height: 214 },
  Toolbar: { width: 600, height: 64 },
  Answer: { width: 436, height: 460 },
  SurfacePad: 22,
  Margin: 12,
  Gap: 6,
  SnapDistance: 96,
} as const;

export const DesktopCompanionTiming = {
  HintAutoDismissMs: 12_000,
  DropLingerMs: 450,
  GazeIntervalMs: 140,
  SnoozeHourMs: 60 * 60_000,
} as const;
