export const WordPanelIpc = {
  Prepare: 'word-panel:prepare',
  Present: 'word-panel:present',
  Bounds: 'word-panel:bounds',
  Hide: 'word-panel:hide',
  Session: 'word-panel:session',
  Action: 'word-panel:action',
  Ready: 'word-panel:ready',
  Presented: 'word-panel:presented',
  ReadPreview: 'word-panel:read-preview',
} as const;

export const WordPanelAction = {
  Share: 'share', Download: 'download', Refresh: 'refresh', Reveal: 'reveal',
  FileList: 'file-list', OpenExternal: 'open-external', AddToChat: 'add-to-chat',
  Toast: 'toast', Failed: 'failed', Snapshot: 'snapshot', Shortcut: 'shortcut',
} as const;
export type WordPanelAction = typeof WordPanelAction[keyof typeof WordPanelAction];

export const WordPanelSessionAction = { Refresh: 'refresh', Close: 'close' } as const;
export type WordPanelSessionAction = typeof WordPanelSessionAction[keyof typeof WordPanelSessionAction];

export interface WordPanelPresentation {
  token: string;
  filePath: string;
  language: 'en' | 'zh';
  theme: string;
  dark: boolean;
  autoFocus: boolean;
  actions: WordPanelAction[];
  fileListOpen: boolean;
}

export interface WordPanelBounds { x: number; y: number; width: number; height: number }

export interface WordPanelEvent {
  token: string;
  action: WordPanelAction;
  text?: string;
  shortcut?: { key: string; code: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean };
}

export interface WordPanelBridge {
  prepare(): Promise<void>;
  present(panel: WordPanelPresentation): Promise<void>;
  bounds(token: string, bounds: WordPanelBounds | null): void;
  hide(token: string): void;
  session(action: WordPanelSessionAction, filePath: string): Promise<boolean>;
  onAction(listener: (event: WordPanelEvent) => void): () => void;
}

export interface WordPanelGuest {
  ready(): void;
  presented(token: string): void;
  action(event: WordPanelEvent): void;
  onPresent(listener: (panel: WordPanelPresentation | null) => void): () => void;
  onSession(listener: (action: WordPanelSessionAction, filePath: string) => Promise<boolean>): () => void;
}
