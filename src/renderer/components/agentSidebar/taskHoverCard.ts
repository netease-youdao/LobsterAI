import { i18nService } from '../../services/i18n';
import { formatMessageDateTime } from '../../utils/tokenFormat';

export const TASK_HOVER_CARD_WIDTH = 276;
export const TASK_HOVER_CARD_DEFAULT_HEIGHT = 112;
export const TASK_HOVER_CARD_VIEWPORT_PADDING = 12;
export const TASK_HOVER_CARD_HORIZONTAL_GAP = 10;
export const TASK_HOVER_CARD_TITLE_ALIGN_OFFSET = 8;
export const TASK_HOVER_CARD_SHOW_DELAY_MS = 350;
export const TASK_HOVER_CARD_WARM_DELAY_MS = 80;
export const TASK_HOVER_CARD_WARM_WINDOW_MS = 450;

export interface TaskWorkspaceDisplay {
  folderName: string;
  displayPath: string;
  fullPath: string;
}

export interface TaskHoverCardAnchor {
  rowTop: number;
  rowHeight: number;
  sidebarRight: number;
}

export interface TaskHoverCardPosition {
  left: number;
  top: number;
}

const stripTrailingSeparators = (rawPath: string): string => {
  if (rawPath === '/' || /^[A-Za-z]:[\\/]?$/.test(rawPath)) {
    return rawPath;
  }
  return rawPath.replace(/[\\/]+$/, '');
};

const compactHomeDirectory = (normalizedPath: string): string => {
  const posixMatch = normalizedPath.match(/^\/(?:Users|home)\/[^/]+(\/.*)?$/);
  if (posixMatch) {
    return `~${posixMatch[1] ?? ''}`;
  }
  const windowsMatch = normalizedPath.match(/^[A-Za-z]:\\Users\\[^\\]+(\\.*)?$/i);
  if (windowsMatch) {
    return `~${windowsMatch[1] ?? ''}`;
  }
  return normalizedPath;
};

export const formatTaskWorkspaceDisplay = (
  cwd?: string | null,
  fallbackWorkingDirectory?: string | null,
): TaskWorkspaceDisplay | null => {
  const candidate = cwd?.trim() || fallbackWorkingDirectory?.trim() || '';
  if (!candidate) return null;

  const fullPath = stripTrailingSeparators(candidate);
  const segments = fullPath.split(/[\\/]+/).filter(Boolean);
  const folderName = segments.length > 0 ? segments[segments.length - 1] : fullPath;
  const displayPath = compactHomeDirectory(fullPath);

  return {
    folderName,
    displayPath,
    fullPath,
  };
};

export const formatTaskHoverUpdatedTime = (
  timestamp: number,
  options: {
    now?: number;
    updatedAtTemplate?: string;
  } = {},
): string => {
  const rawFormatted = Number.isFinite(timestamp) && timestamp > 0
    ? formatMessageDateTime(timestamp)
    : '';
  const formattedTime = rawFormatted || formatMessageDateTime(options.now ?? Date.now());
  const template = options.updatedAtTemplate ?? i18nService.t('myAgentSidebarHoverUpdatedAt');
  return template.replace('{time}', formattedTime);
};

export const calculateTaskHoverCardPosition = (
  anchor: TaskHoverCardAnchor,
  viewport: { width: number; height: number },
  cardSize: { width: number; height: number } = {
    width: TASK_HOVER_CARD_WIDTH,
    height: TASK_HOVER_CARD_DEFAULT_HEIGHT,
  },
): TaskHoverCardPosition => {
  const maxLeft = Math.max(
    TASK_HOVER_CARD_VIEWPORT_PADDING,
    viewport.width - cardSize.width - TASK_HOVER_CARD_VIEWPORT_PADDING,
  );
  const left = Math.min(
    Math.max(TASK_HOVER_CARD_VIEWPORT_PADDING, anchor.sidebarRight + TASK_HOVER_CARD_HORIZONTAL_GAP),
    maxLeft,
  );

  const maxTop = Math.max(
    TASK_HOVER_CARD_VIEWPORT_PADDING,
    viewport.height - cardSize.height - TASK_HOVER_CARD_VIEWPORT_PADDING,
  );
  const top = Math.min(
    Math.max(TASK_HOVER_CARD_VIEWPORT_PADDING, anchor.rowTop - TASK_HOVER_CARD_TITLE_ALIGN_OFFSET),
    maxTop,
  );

  return {
    left: Math.round(left),
    top: Math.round(top),
  };
};
