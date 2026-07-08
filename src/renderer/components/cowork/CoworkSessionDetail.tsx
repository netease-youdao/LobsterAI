import {
  ArchiveBoxArrowDownIcon,
  ArrowDownIcon,
  ChatBubbleLeftIcon,
  DocumentArrowDownIcon,
  PhotoIcon,
} from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDispatch, useSelector } from 'react-redux';

import { stripGoalCommandPrefixForDisplay } from '../../../common/sessionTitle';
import { CoworkGoalStatus } from '../../../shared/cowork/goal';
import type { CoworkImageAttachmentPreview } from '../../../shared/cowork/imageAttachments';
import {
  COWORK_RAIL_TOOLTIP_PREVIEW_MAX_LENGTH,
  type CoworkMessageRailIndexItem,
} from '../../../shared/cowork/rail';
import {
  type CoworkSelectedTextSnippet,
  CoworkSelectedTextSource,
  type CoworkSelectedTextValidationError,
  normalizeCoworkSelectedTextSnippets,
} from '../../../shared/cowork/selectedText';
import { dedupeArtifactsForDisplay, normalizeFilePathForDedup, normalizeLocalServiceOrigin, normalizeLocalServiceUrlForDedup, parseFileLinksFromMessage, parseFilePathsFromText, parseLocalServiceUrlsFromText, parseMediaTokensFromText, parseRemoteImageArtifactsFromText, parseToolArtifact, parseToolResultMediaArtifacts, shouldParseFilePathsFromToolResult, stripFileLinksFromText } from '../../services/artifactParser';
import { coworkService } from '../../services/cowork';
import { i18nService } from '../../services/i18n';
import { getInstalledKitSkillIds } from '../../services/kitCapability';
import { RootState } from '../../store';
import {
  selectCurrentMessagesLength,
  selectCurrentSession,
  selectIsStreaming,
  selectLastMessageContent,
  selectRemoteManaged,
} from '../../store/selectors/coworkSelectors';
import {
  activateArtifactBrowserTab,
  activateArtifactFileListTab,
  activateArtifactPreviewTab,
  activateArtifactSubagentTab,
  addArtifact,
  type ArtifactPreviewTab,
  ArtifactSpecialTab,
  closeArtifactPreviewTab,
  closePanel,
  MAX_PANEL_WIDTH,
  MIN_PANEL_WIDTH,
  openArtifactPreviewTab,
  selectActivePreviewTab,
  selectIsPanelOpen,
  selectPanelWidth,
  togglePanel,
} from '../../store/slices/artifactSlice';
import {
  addDraftSelectedTextSnippet,
  PlanConfirmationState,
  setDraftCollaborationMode,
  setPlanConfirmationAwaiting,
  setPlanConfirmationHandled,
} from '../../store/slices/coworkSlice';
import { setActiveKitIds } from '../../store/slices/kitSlice';
import { setActiveSkillIds } from '../../store/slices/skillSlice';
import type { Artifact } from '../../types/artifact';
import { ArtifactTypeValue, PREVIEWABLE_ARTIFACT_TYPES } from '../../types/artifact';
import type { CoworkImageAttachment, CoworkMessage, CoworkMessageMetadata, SubagentSessionSummary } from '../../types/cowork';
import {
  CoworkCollaborationMode,
  type CoworkCollaborationMode as CoworkCollaborationModeType,
  CoworkSessionStatusValue,
} from '../../types/cowork';
import type { MediaAttachmentRef } from '../../types/mediaGeneration';
import { parseUserMessageForDisplay } from '../../utils/userMessageDisplay';
import { ArtifactPanel, type BrowserAnnotationPayload, SubagentPanelContent } from '../artifacts';
import { reportArtifactPreviewAction } from '../artifacts/artifactAnalytics';
import {
  ArtifactAutoPreviewOpenTarget,
  getAutoPreviewOpenTarget,
  selectAutoPreviewArtifact,
} from '../artifacts/autoPreviewPolicy';
import ComposeIcon from '../icons/ComposeIcon';
import FileTypeIcon from '../icons/fileTypes/FileTypeIcon';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import SubagentIcon from '../icons/SubagentIcon';
import MarkdownContent from '../MarkdownContent';
import WindowTitleBar from '../window/WindowTitleBar';
import AssistantTurnBlock, { ContextCompactionDivider } from './AssistantTurnBlock';
import { type CoworkOpenShareOptionsEventDetail, CoworkUiEvent } from './constants';
import ContextUsageIndicator from './ContextUsageIndicator';
import {
  bucketCount,
  bucketDistance,
  bucketLength,
  reportConversationNavigationAction,
} from './conversationAnalytics';
import CoworkPromptInput, { type CoworkPromptInputRef } from './CoworkPromptInput';
import LazyRenderTurn, { clearHeightCache } from './LazyRenderTurn';
import {
  buildConversationTurns,
  buildDisplayItems,
  type ConversationTurn,
  COWORK_DETAIL_CONTENT_CLASS,
  COWORK_DETAIL_GUTTER_CLASS,
  getStreamingActivityStatusText,
  hasRenderableAssistantContent,
  MEDIA_TOKEN_DISPLAY_RE,
  type ToolGroupItem,
} from './messageDisplayUtils';
import { parseProposedPlanBlock } from './proposedPlanParser';
import { buildSelectedKitContextPrompt } from './selectedKitContextPrompt';
import { buildSelectedSkillRoutingPrompt } from './selectedSkillRoutingPrompt';
import {
  buildCoworkSessionJSON,
  buildCoworkSessionMarkdown,
  CoworkTextExportFormat,
  type CoworkTextExportFormat as CoworkTextExportFormatValue,
  mergeCoworkTextExportMessages,
} from './sessionExport';
import SubagentTurnLinks from './SubagentTurnLinks';
import UserMessageContent from './UserMessageContent';
import UserMessageItem from './UserMessageItem';
interface CoworkSessionDetailProps {
  onManageSkills?: () => void;
  onManageKits?: () => void;
  onContinue: (
    prompt: string,
    skillPrompt?: string,
    imageAttachments?: CoworkImageAttachment[],
    mediaReferences?: MediaAttachmentRef[],
    selectedTextSnippets?: CoworkSelectedTextSnippet[],
    collaborationMode?: CoworkCollaborationModeType,
  ) => boolean | void | Promise<boolean | void>;
  onStop: () => void;
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
}

interface BrowserLocalServiceContext {
  artifactId?: string;
  url: string;
  origin: string;
  projectDirectory?: string;
  projectCandidates?: NonNullable<Artifact['localService']>['projectCandidates'];
}

const AUTO_SCROLL_THRESHOLD = 120;
const NAV_SCROLL_LOCK_DURATION = 800;
const NAV_BOTTOM_SNAP_THRESHOLD = 20;
const WHEEL_DELTA_LINE_HEIGHT = 16;
const SCROLL_TO_BOTTOM_SETTLE_THRESHOLD = 24;
const SCROLL_TO_BOTTOM_SETTLE_DELAYS_MS = [600, 1200, 1800] as const;
const AUTO_PREVIEW_ARTIFACT_SETTLE_MS = 600;
const ARTIFACT_PANEL_TRANSITION_MS = 200;
const ARTIFACT_PANEL_RESIZE_HANDLE_WIDTH = 4;
const COWORK_DETAIL_MIN_WIDTH = 480;
const ARTIFACT_PANEL_MIN_WIDTH_RATIO = 1 / 6;
const SUBAGENT_PANEL_POLL_INTERVAL_MS = 5_000;
const INVALID_FILE_NAME_PATTERN = /[<>:"/\\|?*\u0000-\u001F]/g;
const SELECTED_TEXT_ACTION_HALF_WIDTH = 72;
const SELECTED_TEXT_ACTION_SUPPRESS_MS = 250;
const EXPANDED_CONVERSATION_PREVIEW_COLLAPSED_MAX_LENGTH = 140;
const EXPANDED_CONVERSATION_PREVIEW_ITEM_MAX_LENGTH = 520;
const EXPANDED_CONVERSATION_PREVIEW_ITEM_LIMIT = 8;
const RAIL_LONG_JUMP_VIEWPORT_MULTIPLIER = 2.5;
const RAIL_LINE_DEFAULT_WIDTH = 8;
const RAIL_LINE_ACTIVE_WIDTH = 28;
const RAIL_LINE_HOVER_STEPS = [28, 18, 13, 10] as const;
const RAIL_LINE_HEIGHT = 3;
const RAIL_TARGET_RENDER_RELEASE_DELAY = 2400;
const RAIL_TARGET_SCROLL_RETRY_LIMIT = 6;

const getRailLineWidth = (
  index: number,
  activeIndex: number,
  hoveredIndex: number | null,
): number => {
  if (hoveredIndex !== null) {
    const hoverDistance = Math.abs(index - hoveredIndex);
    if (hoverDistance < RAIL_LINE_HOVER_STEPS.length) {
      return RAIL_LINE_HOVER_STEPS[hoverDistance];
    }
    return RAIL_LINE_DEFAULT_WIDTH;
  }

  return index === activeIndex ? RAIL_LINE_ACTIVE_WIDTH : RAIL_LINE_DEFAULT_WIDTH;
};

interface LatestProposedPlan {
  messageId: string;
  planTextHash: string;
}

const hashProposedPlanText = (value: string): string => {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  }
  return `${value.length}:${(hash >>> 0).toString(36)}`;
};

const findLatestProposedPlan = (messages: CoworkMessage[]): LatestProposedPlan | null => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.type !== 'assistant' || !message.content.trim()) continue;
    const proposedPlan = parseProposedPlanBlock(message.content);
    if (!proposedPlan.planText?.trim()) continue;
    return {
      messageId: message.id,
      planTextHash: hashProposedPlanText(proposedPlan.planText),
    };
  }
  return null;
};

type RailItem = {
  key: string;
  messageId: string | null;
  turnIndex: number;
  absoluteIndex: number;
  label: string;
  summary: string;
  contentLen: number;
  isUser: boolean;
  isLoaded: boolean;
  isPlaceholder?: boolean;
};

type RailNavigationDecision = {
  behavior: ScrollBehavior;
  distance: number;
  threshold: number;
  reason: 'long_distance' | 'nearby' | 'reduced_motion';
};

type ExpandedConversationPreviewItem = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  summary: string;
};

type ExpandedConversationPreview = {
  latest: ExpandedConversationPreviewItem;
  items: ExpandedConversationPreviewItem[];
};

const getTurnMessageIds = (turn: ConversationTurn): Set<string> => {
  const messageIds = new Set<string>();
  for (const item of turn.assistantItems) {
    if (item.type === 'assistant' || item.type === 'system' || item.type === 'tool_result') {
      messageIds.add(item.message.id);
      continue;
    }
    if (item.type === 'tool_group') {
      messageIds.add(item.group.toolUse.id);
      if (item.group.toolResult) {
        messageIds.add(item.group.toolResult.id);
      }
    }
  }
  return messageIds;
};

const findLatestAssistantTurn = (turns: ConversationTurn[]): ConversationTurn | null => {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn.assistantItems.length > 0) return turn;
  }
  return null;
};

const stripRailLabelMarkdown = (value: string): string => value
  .replace(MEDIA_TOKEN_DISPLAY_RE, ' ')
  .replace(/^#+\s+/gm, '')
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/`[^`]*`/g, ' ')
  .replace(/<\/?proposed_?plan\b[^>]*>/gi, ' ')
  .replace(/<\/?proposed_?plan\b\s*/gi, ' ')
  .replace(/[*_~>]/g, '')
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/\s+/g, ' ')
  .trim()
  .replace(
    /^(?:#{1,6}\s*)?(?:Summary|Implementation Approach|Key Changes|Validation|Assumptions or Questions)(?:\s*[:：]|\s+|(?=为))\s*/i,
    '',
  )
  .trim();

const getRailLabel = (content: string, fallback: string, maxLength = 50): string => {
  const proposedPlan = parseProposedPlanBlock(content);
  const labelSource = [proposedPlan.visibleText, proposedPlan.planText]
    .filter((part): part is string => Boolean(part?.trim()))
    .join('\n');
  const stripped = stripRailLabelMarkdown(labelSource || content);
  return stripped.slice(0, maxLength) || fallback;
};

const getSessionTitleForDisplay = (title: string | null | undefined): string => {
  return stripGoalCommandPrefixForDisplay(title ?? '').trim();
};

const isAssistantRailContentMessage = (message: CoworkMessage): boolean => (
  message.type === 'assistant'
  && !message.metadata?.isThinking
  && Boolean(message.content)
);

const getAssistantRailMessageId = (turn: ConversationTurn): string | null => {
  for (const item of turn.assistantItems) {
    if (item.type === 'assistant' && isAssistantRailContentMessage(item.message)) {
      return item.message.id;
    }
  }
  return null;
};

const buildRailItems = (
  turns: ConversationTurn[],
  messageOffsetById: Map<string, number>,
): RailItem[] => {
  const items: RailItem[] = [];

  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    let assistantContent = '';
    for (const item of turn.assistantItems) {
      if (item.type === 'assistant' && isAssistantRailContentMessage(item.message)) {
        assistantContent += item.message.content;
      }
    }

    const assistantMessageId = getAssistantRailMessageId(turn);
    const primaryMessageId = turn.userMessage?.id ?? assistantMessageId;
    if (!primaryMessageId) continue;

    const userContent = turn.userMessage?.content ?? '';
    items.push({
      key: `${turn.id}-turn`,
      messageId: primaryMessageId,
      turnIndex: index,
      absoluteIndex: messageOffsetById.get(primaryMessageId) ?? items.length,
      label: turn.userMessage ? getRailLabel(userContent, `Turn ${index + 1}`) : 'LobsterAI',
      summary: assistantContent
        ? getRailLabel(assistantContent, 'LobsterAI', COWORK_RAIL_TOOLTIP_PREVIEW_MAX_LENGTH)
        : '',
      contentLen: userContent.length + assistantContent.length,
      isUser: false,
      isLoaded: true,
    });
  }

  return items;
};

const buildLoadedRailTurnMap = (turns: ConversationTurn[]): Map<string, number> => {
  const map = new Map<string, number>();
  turns.forEach((turn, index) => {
    if (turn.userMessage) {
      map.set(turn.userMessage.id, index);
    }
    const assistantMessageId = getAssistantRailMessageId(turn);
    if (assistantMessageId) {
      map.set(assistantMessageId, index);
    }
  });
  return map;
};

const buildRailItemsFromIndex = (
  indexItems: CoworkMessageRailIndexItem[],
  loadedTurnByMessageId: Map<string, number>,
): RailItem[] => {
  const items: RailItem[] = [];
  let index = 0;

  while (index < indexItems.length) {
    const current = indexItems[index];

    if (current.type === 'user') {
      const assistantItems: CoworkMessageRailIndexItem[] = [];
      let nextIndex = index + 1;
      while (nextIndex < indexItems.length && indexItems[nextIndex].type === 'assistant') {
        assistantItems.push(indexItems[nextIndex]);
        nextIndex += 1;
      }

      const loadedAssistantTurnIndex = assistantItems
        .map(item => loadedTurnByMessageId.get(item.messageId))
        .find((turnIndex): turnIndex is number => turnIndex !== undefined);
      const loadedTurnIndex = loadedTurnByMessageId.get(current.messageId) ?? loadedAssistantTurnIndex ?? -1;
      items.push({
        key: [current.messageId, ...assistantItems.map(item => item.messageId)].join(':'),
        messageId: current.messageId,
        turnIndex: loadedTurnIndex,
        absoluteIndex: current.messageOffset,
        label: current.preview,
        summary: assistantItems.map(item => item.preview).join(' '),
        contentLen: current.contentLen + assistantItems.reduce((acc, item) => acc + item.contentLen, 0),
        isUser: false,
        isLoaded: loadedTurnIndex >= 0,
      });
      index = nextIndex;
      continue;
    }

    const loadedTurnIndex = loadedTurnByMessageId.get(current.messageId) ?? -1;
    items.push({
      key: current.messageId,
      messageId: current.messageId,
      turnIndex: loadedTurnIndex,
      absoluteIndex: current.messageOffset,
      label: 'LobsterAI',
      summary: current.preview,
      contentLen: current.contentLen,
      isUser: false,
      isLoaded: loadedTurnIndex >= 0,
    });
    index += 1;
  }

  return items;
};

const buildPlaceholderRailItems = (
  totalMessages: number,
  localItems: RailItem[],
): RailItem[] => {
  const count = Math.max(0, Math.floor(totalMessages));
  if (count <= localItems.length) return localItems;
  const estimatedTurnCount = Math.max(localItems.length, Math.ceil(count / 2));

  const localByRailIndex = new Map<number, RailItem>();
  localItems.forEach((item) => {
    localByRailIndex.set(Math.floor(item.absoluteIndex / 2), item);
  });

  return Array.from({ length: estimatedTurnCount }, (_, index) => {
    const localItem = localByRailIndex.get(index);
    if (localItem) {
      return localItem;
    }

    return {
      key: `placeholder-${index}`,
      messageId: null,
      turnIndex: -1,
      absoluteIndex: Math.min(Math.max(0, count - 1), index * 2),
      label: `Turn ${index + 1}`,
      summary: '',
      contentLen: 1,
      isUser: false,
      isLoaded: false,
      isPlaceholder: true,
    };
  });
};

const buildTurnToRailRange = (railItems: RailItem[]): { first: number; last: number }[] => {
  const rangeMap: { first: number; last: number }[] = [];
  for (let index = 0; index < railItems.length; index += 1) {
    const turnIndex = railItems[index].turnIndex;
    if (turnIndex < 0) continue;
    if (!rangeMap[turnIndex]) {
      rangeMap[turnIndex] = { first: index, last: index };
    } else {
      rangeMap[turnIndex].last = index;
    }
  }
  return rangeMap;
};

const prefersReducedMotion = (): boolean => (
  typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
);

const getRailNavigationDecision = (
  container: HTMLDivElement,
  targetElement: HTMLElement,
): RailNavigationDecision => {
  const containerRect = container.getBoundingClientRect();
  const targetRect = targetElement.getBoundingClientRect();
  const targetScrollTop = container.scrollTop + targetRect.top - containerRect.top;
  const distance = Math.abs(targetScrollTop - container.scrollTop);
  const threshold = Math.max(1, container.clientHeight) * RAIL_LONG_JUMP_VIEWPORT_MULTIPLIER;
  if (prefersReducedMotion()) {
    return {
      behavior: 'auto',
      distance,
      threshold,
      reason: 'reduced_motion',
    };
  }
  if (distance > threshold) {
    return {
      behavior: 'auto',
      distance,
      threshold,
      reason: 'long_distance',
    };
  }
  return {
    behavior: 'smooth',
    distance,
    threshold,
    reason: 'nearby',
  };
};

function normalizeExpandedConversationPreviewText(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#>*_~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateExpandedConversationPreviewText(value: string, maxLength: number): string {
  const characters = Array.from(value);
  if (characters.length <= maxLength) return value;
  return `${characters.slice(0, maxLength).join('')}...`;
}

function getExpandedConversationPreview(messages: CoworkMessage[]): ExpandedConversationPreview | null {
  const items: ExpandedConversationPreviewItem[] = [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.type !== 'user' && message.type !== 'assistant') continue;
    if (message.metadata?.isThinking) continue;

    const content = message.type === 'user'
      ? parseUserMessageForDisplay(message.content || '')
      : message.content;
    const text = normalizeExpandedConversationPreviewText(content);
    if (!text) continue;

    items.push({
      id: message.id,
      role: message.type,
      content,
      summary: truncateExpandedConversationPreviewText(text, EXPANDED_CONVERSATION_PREVIEW_ITEM_MAX_LENGTH),
    });

    if (items.length >= EXPANDED_CONVERSATION_PREVIEW_ITEM_LIMIT) break;
  }

  if (items.length === 0) return null;

  const orderedItems = items.reverse();
  const latestItem = orderedItems[orderedItems.length - 1];

  return {
    latest: {
      ...latestItem,
      summary: truncateExpandedConversationPreviewText(
        latestItem.summary,
        EXPANDED_CONVERSATION_PREVIEW_COLLAPSED_MAX_LENGTH,
      ),
    },
    items: orderedItems,
  };
}

function normalizeBrowserPreviewUrlForMatch(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString();
  } catch {
    return value;
  }
}

function isSameBrowserPreviewUrl(value: string, previewUrl: string): boolean {
  if (!value || !previewUrl) return false;
  return normalizeBrowserPreviewUrlForMatch(value) === normalizeBrowserPreviewUrlForMatch(previewUrl);
}

type SelectedAssistantTextRange = {
  text: string;
  sourceMessageId: string;
  rect: DOMRect;
};
const SELECTED_TEXT_ERROR_I18N_KEYS: Record<CoworkSelectedTextValidationError, string> = {
  empty: 'coworkSelectedTextInvalid',
  invalid: 'coworkSelectedTextInvalid',
  too_long: 'coworkSelectedTextTooLong',
  too_many: 'coworkSelectedTextTooMany',
  total_too_long: 'coworkSelectedTextTotalTooLong',
  duplicate: 'coworkSelectedTextDuplicate',
};

const extractBase64FromDataUrl = (dataUrl: string): { mimeType: string; base64Data: string } | null => {
  const match = /^data:(.+);base64,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  return { mimeType: match[1], base64Data: match[2] };
};

const showToast = (message: string): void => {
  window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
};

const sanitizeExportFileName = (value: string): string => {
  const sanitized = value.replace(INVALID_FILE_NAME_PATTERN, ' ').replace(/\s+/g, ' ').trim();
  return sanitized || 'cowork-session';
};

const formatExportTimestamp = (value: Date): string => {
  const pad = (num: number): string => String(num).padStart(2, '0');
  return `${value.getFullYear()}${pad(value.getMonth() + 1)}${pad(value.getDate())}-${pad(value.getHours())}${pad(value.getMinutes())}${pad(value.getSeconds())}`;
};

const logDetailDiagnostic = (message: string): void => {
  console.log(`[CoworkSessionDetail] ${message}`);
  window.electron?.log?.fromRenderer?.('info', 'CoworkSessionDetail', message);
};

const logRailNavigationDiagnostic = (message: string): void => {
  console.debug(`[CoworkSessionDetail] ${message}`);
  window.electron?.log?.fromRenderer?.('debug', 'CoworkSessionDetail', message);
};

const getSelectionAnchorRect = (range: Range): DOMRect => {
  const lineRects = Array.from(range.getClientRects())
    .filter(rect => rect.width > 0 && rect.height > 0);
  return lineRects[0] ?? range.getBoundingClientRect();
};

const getSelectedAssistantTextRange = (): SelectedAssistantTextRange | null => {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }
  const range = selection.getRangeAt(0);
  const startElement = range.startContainer.parentElement;
  const endElement = range.endContainer.parentElement;
  const startMessage = startElement?.closest<HTMLElement>('[data-cowork-assistant-message-id]');
  const endMessage = endElement?.closest<HTMLElement>('[data-cowork-assistant-message-id]');
  const sourceMessageId = startMessage?.dataset.coworkAssistantMessageId;
  const text = selection.toString().trim();
  if (!sourceMessageId || startMessage !== endMessage || !text) {
    return null;
  }
  return {
    text,
    sourceMessageId,
    rect: getSelectionAnchorRect(range),
  };
};

const getSelectedTextActionLeft = (rect: DOMRect, container: HTMLDivElement): number => {
  const containerRect = container.getBoundingClientRect();
  const selectionCenterX = rect.left - containerRect.left + rect.width / 2;
  return Math.min(
    container.clientWidth - SELECTED_TEXT_ACTION_HALF_WIDTH,
    Math.max(SELECTED_TEXT_ACTION_HALF_WIDTH, selectionCenterX),
  );
};

const getSelectedTextActionTop = (
  rect: DOMRect,
  container: HTMLDivElement,
): number => {
  const containerRect = container.getBoundingClientRect();
  const rawTop = container.scrollTop + rect.top - containerRect.top - 42;
  const minTop = container.scrollTop + 8;
  const maxTop = container.scrollTop + container.clientHeight - 48;
  return Math.min(maxTop, Math.max(minTop, rawTop));
};

type CaptureRect = { x: number; y: number; width: number; height: number };

const MAX_EXPORT_CANVAS_HEIGHT = 32760;
const MAX_EXPORT_SEGMENTS = 240;

const waitForNextFrame = (): Promise<void> =>
  new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });

const loadImageFromBase64 = (pngBase64: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to decode captured image'));
    img.src = `data:image/png;base64,${pngBase64}`;
  });

const domRectToCaptureRect = (rect: DOMRect): CaptureRect => ({
  x: Math.max(0, Math.round(rect.x)),
  y: Math.max(0, Math.round(rect.y)),
  width: Math.max(0, Math.round(rect.width)),
  height: Math.max(0, Math.round(rect.height)),
});

/** Format a date as "YYYY年MM月DD日" for the export header. */
const formatExportDate = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}年${String(d.getMonth() + 1).padStart(2, '0')}月${String(d.getDate()).padStart(2, '0')}日`;
};

/** Draw a rounded-rectangle path (for card clipping / filling). */
const roundRectPath = (
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
) => {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
};

/**
 * Compose a final export canvas with a rounded-card layout:
 *   outer background → rounded card → header (title + date) → content → footer (logo + tagline)
 */
const composeExportCanvas = async (
  contentCanvas: HTMLCanvasElement,
  title: string,
  createdAt: number,
): Promise<HTMLCanvasElement> => {
  const isDark = document.documentElement.classList.contains('dark');
  const dpr = window.devicePixelRatio || 1;
  const fontStack = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';

  const contentW = contentCanvas.width;   // CSS px
  const contentH = contentCanvas.height;  // CSS px

  // ── Layout constants (CSS px) ──
  const outerPadX = 24;          // horizontal breathing room around card
  const outerPadTop = 28;        // top breathing room
  const outerPadBottom = 28;     // bottom breathing room
  const cardRadius = 16;         // card corner radius
  const cardInnerPadX = 28;      // text indent inside card
  const headerHeight = 80;       // header area inside card
  const footerHeight = 80;       // footer area inside card
  const dividerThick = 1;
  const logoCssSize = 34;

  // ── Colors ──
  const outerBg = isDark ? '#111111' : '#f0f0f0';
  const cardBg = isDark ? '#1e1e1e' : '#ffffff';
  const cardShadowColor = isDark ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.08)';
  const titleColor = isDark ? '#eeeeee' : '#1a1a1a';
  const dateColor = isDark ? '#888888' : '#999999';
  const dividerColor = isDark ? '#2a2a2a' : '#ebebeb';
  const brandColor = isDark ? '#e0e0e0' : '#1a1a1a';
  const subtitleColor = isDark ? '#888888' : '#888888';

  // ── Compute dimensions ──
  const cardW = contentW;
  const cardH = headerHeight + dividerThick + contentH + dividerThick + footerHeight;
  const totalW = cardW + outerPadX * 2;
  const totalH = cardH + outerPadTop + outerPadBottom;

  const final = document.createElement('canvas');
  final.width = Math.round(totalW * dpr);
  final.height = Math.round(totalH * dpr);
  const ctx = final.getContext('2d');
  if (!ctx) throw new Error('Canvas context unavailable');
  ctx.scale(dpr, dpr);

  // ── Outer background ──
  ctx.fillStyle = outerBg;
  ctx.fillRect(0, 0, totalW, totalH);

  // ── Card shadow ──
  ctx.save();
  ctx.shadowColor = cardShadowColor;
  ctx.shadowBlur = 24;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 4;
  ctx.fillStyle = cardBg;
  roundRectPath(ctx, outerPadX, outerPadTop, cardW, cardH, cardRadius);
  ctx.fill();
  ctx.restore();

  // ── Clip to card bounds so content doesn't bleed past rounded corners ──
  ctx.save();
  roundRectPath(ctx, outerPadX, outerPadTop, cardW, cardH, cardRadius);
  ctx.clip();

  // card-local origin helpers
  const cx = outerPadX;           // card left
  const cy = outerPadTop;         // card top

  // ── Header ──
  const titleFontSize = 17;
  const dateFontSize = 12;
  ctx.textBaseline = 'middle';

  // Title
  ctx.fillStyle = titleColor;
  ctx.font = `600 ${titleFontSize}px ${fontStack}`;
  const maxTitleW = cardW - cardInnerPadX * 2;
  let displayTitle = title || 'Cowork Session';
  if (ctx.measureText(displayTitle).width > maxTitleW) {
    while (displayTitle.length > 1 && ctx.measureText(displayTitle + '…').width > maxTitleW) {
      displayTitle = displayTitle.slice(0, -1);
    }
    displayTitle += '…';
  }
  const headerCenterY = cy + headerHeight / 2;
  ctx.fillText(displayTitle, cx + cardInnerPadX, headerCenterY - dateFontSize / 2 - 3);

  // Date
  ctx.fillStyle = dateColor;
  ctx.font = `400 ${dateFontSize}px ${fontStack}`;
  ctx.fillText(formatExportDate(createdAt), cx + cardInnerPadX, headerCenterY + titleFontSize / 2 + 3);

  // ── Top divider ──
  ctx.fillStyle = dividerColor;
  ctx.fillRect(cx + cardInnerPadX, cy + headerHeight, cardW - cardInnerPadX * 2, dividerThick);

  // ── Content ──
  const contentY = cy + headerHeight + dividerThick;
  ctx.drawImage(contentCanvas, cx, contentY, contentW, contentH);

  // ── Bottom divider ──
  const bottomDivY = contentY + contentH;
  ctx.fillStyle = dividerColor;
  ctx.fillRect(cx + cardInnerPadX, bottomDivY, cardW - cardInnerPadX * 2, dividerThick);

  // ── Footer ──
  const footerTop = bottomDivY + dividerThick;
  const footerCenterY = footerTop + footerHeight / 2;

  // Load logo
  const logoImg = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load logo'));
    img.src = 'logo.png';
  });

  // Logo with rounded clipping
  const logoX = cx + cardInnerPadX;
  const logoY = footerCenterY - logoCssSize / 2;
  const logoRadius = 8;
  ctx.save();
  roundRectPath(ctx, logoX, logoY, logoCssSize, logoCssSize, logoRadius);
  ctx.clip();
  ctx.drawImage(logoImg, logoX, logoY, logoCssSize, logoCssSize);
  ctx.restore();

  // Re-clip to card (previous clip was consumed by logo)
  ctx.save();
  roundRectPath(ctx, outerPadX, outerPadTop, cardW, cardH, cardRadius);
  ctx.clip();

  // Brand text
  const textX = logoX + logoCssSize + 12;
  const brandFontSize = 13;
  const taglineFontSize = 11;

  ctx.fillStyle = brandColor;
  ctx.font = `600 ${brandFontSize}px ${fontStack}`;
  ctx.fillText('LobsterAI — 全场景个人助理 Agent', textX, footerCenterY - taglineFontSize / 2 - 2);

  ctx.fillStyle = subtitleColor;
  ctx.font = `400 ${taglineFontSize}px ${fontStack}`;
  ctx.fillText('7×24 小时帮你干活的全场景个人助理，由网易有道开发', textX, footerCenterY + brandFontSize / 2 + 3);

  ctx.restore(); // card clip

  return final;
};

const ArtifactPanelIcon: React.FC<React.SVGProps<SVGSVGElement> & { open?: boolean }> = ({ open, ...props }) => {
  const dividerX = open ? 10.5 : 12.5;
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <rect x="1.5" y="2" width="13" height="12" rx="2" />
      <line x1={dividerX} y1="2" x2={dividerX} y2="14" />
    </svg>
  );
};

const PanelExpandIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M10 3h3v3" />
    <path d="M6 13H3v-3" />
    <path d="M9 7l4-4" />
    <path d="M7 9l-4 4" />
  </svg>
);

const PanelRestoreIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M13.25 2.75l-4 4" />
    <path d="M9.25 3.75v3h3" />
    <path d="M2.75 13.25l4-4" />
    <path d="M3.75 9.25h3v3" />
  </svg>
);

const PromptInputCollapseIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M4.5 6.25L8 9.75l3.5-3.5" />
  </svg>
);

const PromptInputExpandIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M4.5 9.75L8 6.25l3.5 3.5" />
  </svg>
);

const ArtifactTabCloseIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" {...props}>
    <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
  </svg>
);

const ArtifactTabPlusIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" {...props}>
    <path d="M8 3.5v9M3.5 8h9" />
  </svg>
);

const artifactTabCloseButtonClassName =
  'mr-1 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-transparent transition-colors group-hover:bg-muted group-hover:text-background hover:!bg-foreground hover:!text-background';

const ArtifactBrowserTabIcon: React.FC<React.SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <circle cx="8" cy="8" r="6" />
    <ellipse cx="8" cy="8" rx="2.5" ry="6" />
    <path d="M2 8h12" />
  </svg>
);

class ArtifactPanelErrorBoundary extends React.Component<
  { children: React.ReactNode; onClose: () => void },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: React.ReactNode; onClose: () => void }) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error) {
    console.error('[ArtifactPanel] render error:', error);
  }
  render() {
    if (this.state.hasError) {
      return (
        <aside className="w-[420px] shrink-0 border-l border-border bg-background flex flex-col h-full items-center justify-center p-4">
          <p className="text-sm text-red-500 mb-2">Artifact panel error</p>
          <pre className="text-xs text-muted whitespace-pre-wrap max-w-full overflow-auto mb-3">
            {this.state.error?.message}
          </pre>
          <button
            onClick={() => { this.setState({ hasError: false, error: null }); this.props.onClose(); }}
            className="px-3 py-1.5 text-xs rounded-lg bg-surface hover:bg-surface-hover text-foreground"
          >
            Close
          </button>
        </aside>
      );
    }
    return this.props.children;
  }
}

// Streaming activity bar shown between messages and input
const StreamingActivityBar: React.FC<{ messages: CoworkMessage[]; isContextMaintenance?: boolean }> = ({
  messages,
  isContextMaintenance = false,
}) => {
  const statusText = getStreamingActivityStatusText(messages, isContextMaintenance);

  return (
    <div className={`shrink-0 animate-fade-in ${COWORK_DETAIL_GUTTER_CLASS}`}>
      <div className={COWORK_DETAIL_CONTENT_CLASS}>
        <div className="streaming-bar" />
        {statusText && (
          <div className="py-1">
            <span className="text-xs text-secondary">
              {statusText}
            </span>
          </div>
        )}
      </div>
    </div>
  );
};

// ── Path resolution utilities (used by resolveLocalFilePath) ─────────────────

const safeDecodeURIComponent = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const stripHashAndQuery = (value: string): string => value.split('#')[0].split('?')[0];

const stripFileProtocol = (value: string): string => {
  let cleaned = value.replace(/^file:\/\//i, '');
  if (/^\/[A-Za-z]:/.test(cleaned)) {
    cleaned = cleaned.slice(1);
  }
  return cleaned;
};

const hasScheme = (value: string): boolean => /^[a-z][a-z0-9+.-]*:/i.test(value);

const isAbsolutePath = (value: string): boolean => (
  value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)
);

const isRelativePath = (value: string): boolean => !isAbsolutePath(value) && !hasScheme(value);

const parseRootRelativePath = (value: string): string | null => {
  const trimmed = value.trim();
  if (!/^file:\/\//i.test(trimmed)) return null;
  const separatorIndex = trimmed.indexOf('::');
  if (separatorIndex < 0) return null;

  const rootPart = trimmed.slice(0, separatorIndex);
  const relativePart = trimmed.slice(separatorIndex + 2);
  if (!relativePart.trim()) return null;

  const rootPath = safeDecodeURIComponent(stripFileProtocol(stripHashAndQuery(rootPart)));
  const relativePath = safeDecodeURIComponent(stripHashAndQuery(relativePart));
  if (!rootPath || !relativePath) return null;

  const normalizedRoot = rootPath.replace(/[\\/]+$/, '');
  const normalizedRelative = relativePath.replace(/^[\\/]+/, '');
  if (!normalizedRelative) return null;

  return `${normalizedRoot}/${normalizedRelative}`;
};

const normalizeLocalPath = (
  value: string
): { path: string; isRelative: boolean; isAbsolute: boolean } | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const fileScheme = /^file:\/\//i.test(trimmed);
  const schemePresent = hasScheme(trimmed);
  if (schemePresent && !fileScheme && !isAbsolutePath(trimmed)) return null;

  let raw = trimmed;
  if (fileScheme) {
    raw = stripFileProtocol(raw);
  }
  raw = stripHashAndQuery(raw);
  const decoded = safeDecodeURIComponent(raw);
  const path = decoded || raw;
  if (!path) return null;

  const isAbsolute = isAbsolutePath(path);
  const isRelative = isRelativePath(path);
  return { path, isRelative, isAbsolute };
};

const toAbsolutePathFromCwd = (filePath: string, cwd: string): string => {
  if (isAbsolutePath(filePath)) {
    return filePath;
  }
  return `${cwd.replace(/\/$/, '')}/${filePath.replace(/^\.\//, '')}`;
};

const EMPTY_ARTIFACTS: Artifact[] = [];
const EMPTY_PREVIEW_TABS: ArtifactPreviewTab[] = [];

const CoworkSessionDetail: React.FC<CoworkSessionDetailProps> = ({
  onManageSkills,
  onManageKits,
  onContinue,
  onStop,
  isSidebarCollapsed,
  onToggleSidebar,
  onNewChat,
  updateBadge,
}) => {
  const dispatch = useDispatch();
  const isMac = window.electron.platform === 'darwin';
  const currentSession = useSelector(selectCurrentSession);
  const isStreaming = useSelector(selectIsStreaming);
  const remoteManaged = useSelector(selectRemoteManaged);
  const lastMessageContent = useSelector(selectLastMessageContent);
  const messagesLength = useSelector(selectCurrentMessagesLength);
  const skills = useSelector((state: RootState) => state.skill.skills);
  const activeSkillIds = useSelector((state: RootState) => state.skill.activeSkillIds);
  const activeKitIds = useSelector((state: RootState) => state.kit.activeKitIds);
  const installedKits = useSelector((state: RootState) => state.kit.installedKits);
  const marketplaceKits = useSelector((state: RootState) => state.kit.marketplaceKits);
  const selectedDraftSnippets = useSelector((state: RootState) =>
    currentSession?.id ? state.cowork.draftSelectedTextSnippets[currentSession.id] ?? [] : []
  );
  const contextUsage = useSelector((state: RootState) =>
    currentSession?.id ? state.cowork.contextUsageBySessionId[currentSession.id] : undefined
  );
  const draftCollaborationMode = useSelector((state: RootState) =>
    currentSession?.id
      ? state.cowork.draftCollaborationModes[currentSession.id] || CoworkCollaborationMode.Default
      : CoworkCollaborationMode.Default
  );
  const planConfirmation = useSelector((state: RootState) =>
    currentSession?.id ? state.cowork.planConfirmations[currentSession.id] : undefined
  );
  const messageRailIndex = useSelector((state: RootState) =>
    currentSession?.id ? state.cowork.messageRailIndexBySessionId[currentSession.id] ?? [] : []
  );
  const isContextCompacting = useSelector((state: RootState) =>
    currentSession?.id ? state.cowork.compactingSessionIds.includes(currentSession.id) : false
  );
  const isContextMaintenance = useSelector((state: RootState) =>
    currentSession?.id ? state.cowork.contextMaintenanceSessionIds.includes(currentSession.id) : false
  );
  const isContextBusy = isContextCompacting || isContextMaintenance;
  const isSessionBusy = isStreaming || isContextMaintenance;
  const detailRootRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const promptInputRef = useRef<CoworkPromptInputRef>(null);
  const compactConfirmRef = useRef<HTMLDivElement>(null);
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);
  const [isLoadingMoreMessages, setIsLoadingMoreMessages] = useState(false);
  const [showCompactConfirm, setShowCompactConfirm] = useState(false);
  const [selectedTextAction, setSelectedTextAction] = useState<{
    text: string;
    sourceMessageId: string;
    left: number;
    top: number;
  } | null>(null);
  const isLoadingMoreMessagesRef = useRef(false);
  const prevScrollHeightRef = useRef<number | null>(null);
  const scrollToBottomIntentRef = useRef(false);
  const scrollToBottomSettleTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const suppressSelectedTextActionUntilRef = useRef(0);

  const clearScrollToBottomSettleTimers = useCallback(() => {
    scrollToBottomSettleTimersRef.current.forEach(timer => clearTimeout(timer));
    scrollToBottomSettleTimersRef.current = [];
  }, []);

  const closeSelectedTextAction = useCallback((options: {
    clearSelection?: boolean;
    suppressNextMouseUp?: boolean;
  } = {}) => {
    if (options.suppressNextMouseUp) {
      suppressSelectedTextActionUntilRef.current = Date.now() + SELECTED_TEXT_ACTION_SUPPRESS_MS;
    }
    if (options.clearSelection) {
      window.getSelection()?.removeAllRanges();
    }
    setSelectedTextAction(null);
  }, []);

  const syncSelectedTextActionPosition = useCallback((options: {
    closeWhenMissing?: boolean;
  } = {}) => {
    const selectedRange = getSelectedAssistantTextRange();
    if (!selectedRange) {
      if (options.closeWhenMissing) {
        closeSelectedTextAction();
      }
      return;
    }
    const container = scrollContainerRef.current;
    if (!container) {
      closeSelectedTextAction();
      return;
    }
    setSelectedTextAction({
      text: selectedRange.text,
      sourceMessageId: selectedRange.sourceMessageId,
      left: getSelectedTextActionLeft(selectedRange.rect, container),
      top: getSelectedTextActionTop(selectedRange.rect, container),
    });
  }, [closeSelectedTextAction]);

  // Clear lazy-render height cache when session changes
  const sessionId = currentSession?.id;
  const handleGoalCommand = useCallback((command: string) => {
    if (!currentSession?.id) return Promise.resolve(false);
    const goalAction = command.split(/\s+/, 2)[1] ?? 'unknown';
    console.debug(`[CoworkGoal] dispatching goal command action=${goalAction} for session ${currentSession.id}.`);
    return coworkService.runGoalCommand({
      sessionId: currentSession.id,
      command,
    }).catch((error) => {
      console.warn(`[CoworkGoal] goal command action=${goalAction} failed for session ${currentSession.id}.`, error);
      return false;
    }).finally(() => {
      if (currentSession.id) {
        void coworkService.refreshContextUsage(currentSession.id, { notifyCompaction: false });
      }
    });
  }, [currentSession?.id]);
  const latestProposedPlan = useMemo(
    () => currentSession ? findLatestProposedPlan(currentSession.messages) : null,
    [currentSession],
  );
  const confirmExecutionSkillPrompt = useMemo(() => {
    const kitSkillIds = activeKitIds.flatMap(kitId => getInstalledKitSkillIds(installedKits[kitId]));
    const allSkillIds = [...new Set([...activeSkillIds, ...kitSkillIds])];
    const activeSkills = allSkillIds
      .map(id => skills.find(skill => skill.id === id))
      .filter((skill): skill is NonNullable<typeof skill> => skill !== undefined);
    return [
      buildSelectedKitContextPrompt(activeKitIds, marketplaceKits, installedKits),
      buildSelectedSkillRoutingPrompt(activeSkills),
    ].filter(Boolean).join('\n\n') || undefined;
  }, [activeKitIds, activeSkillIds, installedKits, marketplaceKits, skills]);
  useEffect(() => {
    clearHeightCache();
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !latestProposedPlan) return;
    if (draftCollaborationMode !== CoworkCollaborationMode.Plan) return;
    if (isSessionBusy || currentSession?.status === CoworkSessionStatusValue.Running) return;
    const isSamePlan = planConfirmation?.messageId === latestProposedPlan.messageId
      && planConfirmation.planTextHash === latestProposedPlan.planTextHash;
    if (isSamePlan) return;
    dispatch(setPlanConfirmationAwaiting({
      sessionId,
      messageId: latestProposedPlan.messageId,
      planTextHash: latestProposedPlan.planTextHash,
    }));
    window.electron?.log?.fromRenderer?.(
      'debug',
      'CoworkSessionDetail',
      `Latest proposed plan is awaiting confirmation for session ${sessionId}.`,
    );
  }, [
    currentSession?.status,
    dispatch,
    draftCollaborationMode,
    isSessionBusy,
    latestProposedPlan,
    planConfirmation?.messageId,
    planConfirmation?.planTextHash,
    sessionId,
  ]);

  useEffect(() => {
    setShowCompactConfirm(false);
    closeSelectedTextAction({ clearSelection: true });
  }, [closeSelectedTextAction, sessionId]);

  useEffect(() => {
    if (!selectedTextAction) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('[data-cowork-selected-text-action]')) {
        return;
      }
      closeSelectedTextAction({ clearSelection: true, suppressNextMouseUp: true });
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeSelectedTextAction({ clearSelection: true });
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeSelectedTextAction, selectedTextAction]);

  useEffect(() => {
    if (!showCompactConfirm) return undefined;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && compactConfirmRef.current?.contains(target)) {
        return;
      }
      setShowCompactConfirm(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowCompactConfirm(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [showCompactConfirm]);

  // Rail navigation states
  const [currentRailIndex, setCurrentRailIndex] = useState(-1);
  const currentRailIndexRef = useRef(-1);
  const railItemsRef = useRef<RailItem[]>([]);
  const railItemCountRef = useRef(0);
  // Mapping: turnIndex → { first: firstRailIdx, last: lastRailIdx }
  const turnToRailRangeRef = useRef<{ first: number; last: number }[]>([]);
  const loadedRailRangeRef = useRef<{ first: number; last: number } | null>(null);
  const isNavigatingRef = useRef(false);
  const navigatingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isLoadingRailTargetRef = useRef(false);
  const turnElsCacheRef = useRef<HTMLElement[]>([]);
  const railLinesRef = useRef<HTMLDivElement>(null);
  const [isScrollable, setIsScrollable] = useState(false);
  const [forcedRailTurnIndex, setForcedRailTurnIndex] = useState<number | null>(null);
  const forcedRailTurnReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hoveredRailIndex, setHoveredRailIndex] = useState<number | null>(null);
  const [isRailHovered, setIsRailHovered] = useState(false);
  const [railTooltip, setRailTooltip] = useState<{
    railIndex: number;
    top: number;
    right: number;
  } | null>(null);

  // Export states
  const [isExportingImage, setIsExportingImage] = useState(false);
  const [isExportingText, setIsExportingText] = useState(false);
  const [showExportOptions, setShowExportOptions] = useState(false);

  const getConversationControlAnalyticsParams = useCallback(() => ({
    sessionMessageCountBucket: bucketCount(currentSession?.messages.length ?? 0),
    totalMessageCountBucket: bucketCount(currentSession?.totalMessages ?? currentSession?.messages.length ?? 0),
    isStreaming,
    isSessionBusy,
  }), [
    currentSession?.messages.length,
    currentSession?.totalMessages,
    isSessionBusy,
    isStreaming,
  ]);

  useEffect(() => {
    setShouldAutoScroll(true);
  }, [currentSession?.id]);

  const handleCompactContext = useCallback(() => {
    if (!currentSession?.id) {
      console.warn('[CoworkSessionDetail] manual context compaction was ignored because no session is selected.');
      return;
    }
    if (isContextBusy) {
      console.debug('[CoworkSessionDetail] manual context compaction was ignored because compaction is already running.');
      reportConversationNavigationAction({
        actionType: 'context_compact_blocked',
        params: {
          ...getConversationControlAnalyticsParams(),
          reason: 'context_busy',
        },
      });
      return;
    }
    if (isSessionBusy || currentSession.status === CoworkSessionStatusValue.Running) {
      console.debug('[CoworkSessionDetail] manual context compaction was ignored because the session is still running.');
      reportConversationNavigationAction({
        actionType: 'context_compact_blocked',
        params: {
          ...getConversationControlAnalyticsParams(),
          reason: 'session_running',
        },
      });
      window.dispatchEvent(new CustomEvent('app:showToast', {
        detail: i18nService.t('coworkContextCompactBlockedRunning'),
      }));
      return;
    }
    console.debug('[CoworkSessionDetail] manual context compaction confirmation toggled.');
    setShowCompactConfirm(prev => {
      const targetOpen = !prev;
      reportConversationNavigationAction({
        actionType: targetOpen ? 'context_compact_confirm_open' : 'context_compact_confirm_close',
        params: {
          ...getConversationControlAnalyticsParams(),
          targetOpen,
        },
      });
      return targetOpen;
    });
  }, [
    currentSession?.id,
    currentSession?.status,
    getConversationControlAnalyticsParams,
    isContextBusy,
    isSessionBusy,
  ]);

  const handleCancelCompactContext = useCallback(() => {
    console.debug('[CoworkSessionDetail] manual context compaction was canceled by the user.');
    reportConversationNavigationAction({
      actionType: 'context_compact_cancel',
      params: getConversationControlAnalyticsParams(),
    });
    setShowCompactConfirm(false);
  }, [getConversationControlAnalyticsParams]);

  const handleConfirmCompactContext = useCallback(() => {
    if (!currentSession?.id) {
      setShowCompactConfirm(false);
      console.warn('[CoworkSessionDetail] manual context compaction confirmation was ignored because no session is selected.');
      return;
    }
    console.log(`[CoworkSessionDetail] manual context compaction confirmed for session ${currentSession.id}.`);
    reportConversationNavigationAction({
      actionType: 'context_compact_confirm',
      params: getConversationControlAnalyticsParams(),
    });
    setShowCompactConfirm(false);
    void coworkService.compactContext(currentSession.id);
  }, [currentSession?.id, getConversationControlAnalyticsParams]);

  const handleForkMessage = useCallback((messageId: string) => {
    if (!currentSession?.id) {
      console.warn('[CoworkFork] message fork was ignored because no session is selected');
      return;
    }
    if (isStreaming || currentSession.status === CoworkSessionStatusValue.Running) {
      window.dispatchEvent(new CustomEvent('app:showToast', {
        detail: i18nService.t('coworkForkRunningBlocked'),
      }));
      console.warn('[CoworkFork] message fork was rejected because the session is still running');
      return;
    }

    console.log(`[CoworkFork] requesting a fork from assistant message ${messageId} in session ${currentSession.id}`);
    void coworkService.forkSession({
      sessionId: currentSession.id,
      forkedFromMessageId: messageId,
    });
  }, [currentSession?.id, currentSession?.status, isStreaming]);

  const handleConfirmPlan = useCallback(async (messageId: string) => {
    if (!currentSession?.id || !latestProposedPlan || latestProposedPlan.messageId !== messageId) return;
    if (isSessionBusy || currentSession.status === CoworkSessionStatusValue.Running) {
      window.dispatchEvent(new CustomEvent('app:showToast', {
        detail: i18nService.t('coworkSessionStillRunning'),
      }));
      return;
    }
    window.electron?.log?.fromRenderer?.(
      'debug',
      'CoworkSessionDetail',
      `Confirmed proposed plan ${messageId} for session ${currentSession.id}.`,
    );
    dispatch(setDraftCollaborationMode({
      draftKey: currentSession.id,
      mode: CoworkCollaborationMode.Default,
    }));
    const result = await onContinue(
      i18nService.t('coworkPlanConfirmExecutionPrompt'),
      confirmExecutionSkillPrompt,
      undefined,
      undefined,
      undefined,
      CoworkCollaborationMode.Default,
    );
    if (result === false) {
      dispatch(setDraftCollaborationMode({
        draftKey: currentSession.id,
        mode: CoworkCollaborationMode.Plan,
      }));
      return;
    }
    dispatch(setPlanConfirmationHandled({
      sessionId: currentSession.id,
      messageId,
    }));
  }, [confirmExecutionSkillPrompt, currentSession?.id, currentSession?.status, dispatch, isSessionBusy, latestProposedPlan, onContinue]);

  const handleAdjustPlan = useCallback((messageId: string) => {
    if (!currentSession?.id || !latestProposedPlan || latestProposedPlan.messageId !== messageId) return;
    dispatch(setPlanConfirmationHandled({
      sessionId: currentSession.id,
      messageId,
    }));
    dispatch(setDraftCollaborationMode({
      draftKey: currentSession.id,
      mode: CoworkCollaborationMode.Plan,
    }));
    promptInputRef.current?.focus();
    window.electron?.log?.fromRenderer?.(
      'debug',
      'CoworkSessionDetail',
      `User chose to adjust proposed plan ${messageId} for session ${currentSession.id}.`,
    );
  }, [currentSession?.id, dispatch, latestProposedPlan]);

  const handleAssistantTextSelection = useCallback(() => {
    if (remoteManaged) return;
    if (Date.now() < suppressSelectedTextActionUntilRef.current) {
      return;
    }
    suppressSelectedTextActionUntilRef.current = 0;
    syncSelectedTextActionPosition({ closeWhenMissing: true });
  }, [remoteManaged, syncSelectedTextActionPosition]);

  const addSelectedTextSnippetToDraft = useCallback((snippet: CoworkSelectedTextSnippet) => {
    if (!currentSession?.id) return;
    const sourceType = snippet.sourceType ?? snippet.sourceMessageType ?? 'unknown';
    const sourceLabel = snippet.sourceTitle?.trim()
      || snippet.sourceId
      || snippet.sourceMessageId
      || 'unknown source';
    const result = normalizeCoworkSelectedTextSnippets([...selectedDraftSnippets, snippet]);
    if (result.success === false) {
      reportConversationNavigationAction({
        actionType: 'selected_text_add_blocked',
        params: {
          ...getConversationControlAnalyticsParams(),
          sourceType,
          selectedTextLengthBucket: bucketLength(snippet.text.length),
          selectedSnippetCount: selectedDraftSnippets.length,
          errorCode: result.error,
        },
      });
      logDetailDiagnostic(
        `rejected a selected text excerpt for session ${currentSession.id}; `
        + `source type is ${sourceType}, source is ${sourceLabel}, and reason is ${result.error}`,
      );
      window.dispatchEvent(new CustomEvent('app:showToast', {
        detail: i18nService.t(SELECTED_TEXT_ERROR_I18N_KEYS[result.error]),
      }));
      return;
    }
    dispatch(addDraftSelectedTextSnippet({ draftKey: currentSession.id, snippet }));
    reportConversationNavigationAction({
      actionType: 'selected_text_add_to_prompt',
      params: {
        ...getConversationControlAnalyticsParams(),
        sourceType,
        selectedTextLengthBucket: bucketLength(snippet.text.length),
        selectedSnippetCount: result.snippets.length,
        selectedTextTotalLengthBucket: bucketLength(result.snippets.reduce((total, item) => total + item.text.length, 0)),
      },
    });
    logDetailDiagnostic(
      `added a selected text excerpt to the draft for session ${currentSession.id}; `
      + `source type is ${sourceType}, source is ${sourceLabel}; `
      + `${result.snippets.length} excerpts now contain ${result.snippets.reduce((total, item) => total + item.text.length, 0)} characters`,
    );
    promptInputRef.current?.focus();
  }, [currentSession?.id, dispatch, getConversationControlAnalyticsParams, selectedDraftSnippets]);

  const handleAddSelectedText = useCallback(() => {
    if (!selectedTextAction) return;
    addSelectedTextSnippetToDraft({
      id: `selected-text-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text: selectedTextAction.text,
      sourceMessageId: selectedTextAction.sourceMessageId,
      sourceMessageType: CoworkSelectedTextSource.AssistantMessage,
      sourceId: selectedTextAction.sourceMessageId,
      sourceType: CoworkSelectedTextSource.AssistantMessage,
      createdAt: Date.now(),
    });
    closeSelectedTextAction({ clearSelection: true });
  }, [addSelectedTextSnippetToDraft, closeSelectedTextAction, selectedTextAction]);

  const handleLocateSelectedText = useCallback((sourceMessageId: string) => {
    const container = scrollContainerRef.current;
    const element = Array.from(
      container?.querySelectorAll<HTMLElement>('[data-cowork-assistant-message-id]') ?? [],
    ).find(candidate => candidate.dataset.coworkAssistantMessageId === sourceMessageId);
    if (!element) {
      reportConversationNavigationAction({
        actionType: 'selected_text_locate_source',
        params: {
          ...getConversationControlAnalyticsParams(),
          result: 'failed',
        },
      });
      window.dispatchEvent(new CustomEvent('app:showToast', {
        detail: i18nService.t('coworkSelectedTextSourceUnavailable'),
      }));
      return;
    }
    reportConversationNavigationAction({
      actionType: 'selected_text_locate_source',
      params: {
        ...getConversationControlAnalyticsParams(),
        result: 'success',
      },
    });
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    element.classList.add('ring-2', 'ring-primary/50', 'rounded-lg');
    window.setTimeout(() => {
      element.classList.remove('ring-2', 'ring-primary/50', 'rounded-lg');
    }, 1600);
  }, [getConversationControlAnalyticsParams]);

  // ─── Artifact detection ─────────────────────────────────────────────
  const isPanelOpen = useSelector((state: RootState) => selectIsPanelOpen(state, sessionId));
  const panelWidth = useSelector(selectPanelWidth);
  const [shouldRenderArtifactPanel, setShouldRenderArtifactPanel] = useState(isPanelOpen);
  const [isArtifactPanelVisible, setIsArtifactPanelVisible] = useState(isPanelOpen);
  const [isArtifactPanelTransitioning, setIsArtifactPanelTransitioning] = useState(false);
  const [isFileListPreviewTabOpen, setIsFileListPreviewTabOpen] = useState(isPanelOpen);
  const [isBrowserPreviewTabOpen, setIsBrowserPreviewTabOpen] = useState(false);
  const [isSubagentPreviewTabOpen, setIsSubagentPreviewTabOpen] = useState(false);
  const [activeSpecialPreviewTab, setActiveSpecialPreviewTab] = useState<ArtifactSpecialTab>(ArtifactSpecialTab.FileList);
  const [browserPreviewAddress, setBrowserPreviewAddress] = useState('');
  const [browserPreviewUrl, setBrowserPreviewUrl] = useState('');
  const [browserPreviewTitle, setBrowserPreviewTitle] = useState('');
  const [browserLocalServiceContext, setBrowserLocalServiceContext] =
    useState<BrowserLocalServiceContext | null>(null);
  const [browserHtmlPreviewArtifactId, setBrowserHtmlPreviewArtifactId] = useState<string | null>(null);
  const [showArtifactAddMenu, setShowArtifactAddMenu] = useState(false);
  const [artifactAddMenuPosition, setArtifactAddMenuPosition] = useState<{ left: number; top: number } | null>(null);
  const [artifactTabsCanScrollLeft, setArtifactTabsCanScrollLeft] = useState(false);
  const [artifactTabsCanScrollRight, setArtifactTabsCanScrollRight] = useState(false);
  const [artifactTabsIsOverflowing, setArtifactTabsIsOverflowing] = useState(false);
  const [artifactPanelMinWidth, setArtifactPanelMinWidth] = useState(MIN_PANEL_WIDTH);
  const [artifactPanelMaxWidth, setArtifactPanelMaxWidth] = useState(MAX_PANEL_WIDTH);
  const [subagents, setSubagents] = useState<SubagentSessionSummary[]>([]);
  const [subagentsLoading, setSubagentsLoading] = useState(false);
  const [selectedSubagent, setSelectedSubagent] = useState<SubagentSessionSummary | null>(null);
  const [contentRowWidth, setContentRowWidth] = useState(0);
  const [promptInputAreaHeight, setPromptInputAreaHeight] = useState(0);
  const [isArtifactPanelExpanded, setIsArtifactPanelExpanded] = useState(false);
  const [isExpandedPromptInputHidden, setIsExpandedPromptInputHidden] = useState(false);
  const [isExpandedConversationPreviewOpen, setIsExpandedConversationPreviewOpen] = useState(false);
  const previousArtifactPanelOpenRef = useRef(isPanelOpen);
  const fileListPreviewTabOpenBySessionRef = useRef<Record<string, boolean>>({});
  const browserPreviewTabOpenBySessionRef = useRef<Record<string, boolean>>({});
  const subagentPreviewTabOpenBySessionRef = useRef<Record<string, boolean>>({});
  const activeSpecialPreviewTabBySessionRef = useRef<Record<string, ArtifactSpecialTab>>({});
  const browserPreviewAddressBySessionRef = useRef<Record<string, string>>({});
  const browserPreviewUrlBySessionRef = useRef<Record<string, string>>({});
  const browserPreviewTitleBySessionRef = useRef<Record<string, string>>({});
  const browserLocalServiceContextBySessionRef = useRef<Record<string, BrowserLocalServiceContext>>({});
  const browserHtmlPreviewArtifactIdBySessionRef = useRef<Record<string, string>>({});
  const browserHtmlPreviewSessionIdBySessionRef = useRef<Record<string, string>>({});
  const browserHtmlPreviewUrlBySessionRef = useRef<Record<string, string>>({});
  const browserHtmlPreviewRequestIdRef = useRef(0);
  const artifactAddButtonRef = useRef<HTMLButtonElement>(null);
  const artifactAddMenuRef = useRef<HTMLDivElement>(null);
  const artifactTabsScrollRef = useRef<HTMLDivElement>(null);
  const contentRowRef = useRef<HTMLDivElement>(null);
  const promptInputAreaRef = useRef<HTMLDivElement>(null);
  const rawSessionArtifacts = useSelector((state: RootState) =>
    sessionId ? state.artifact.artifactsBySession[sessionId] ?? EMPTY_ARTIFACTS : EMPTY_ARTIFACTS
  );
  const sessionArtifacts = useMemo(
    () => dedupeArtifactsForDisplay(
      rawSessionArtifacts,
      { defaultProjectDirectory: currentSession?.cwd },
    ),
    [currentSession?.cwd, rawSessionArtifacts],
  );
  const artifactPreviewTabs = useSelector((state: RootState) =>
    sessionId ? state.artifact.previewTabsBySession[sessionId] ?? EMPTY_PREVIEW_TABS : EMPTY_PREVIEW_TABS
  );
  const activeArtifactPreviewTab = useSelector((state: RootState) =>
    sessionId ? selectActivePreviewTab(state, sessionId) : null
  );
  const artifactTabsWithArtifacts = useMemo(() => {
    const artifactsById = new Map(sessionArtifacts.map(artifact => [artifact.id, artifact]));
    return artifactPreviewTabs
      .map(tab => ({ tab, artifact: artifactsById.get(tab.artifactId) }))
      .filter((item): item is { tab: typeof artifactPreviewTabs[number]; artifact: Artifact } => Boolean(item.artifact));
  }, [artifactPreviewTabs, sessionArtifacts]);
  const shouldPinArtifactAddTab = artifactTabsIsOverflowing || artifactTabsCanScrollLeft || artifactTabsCanScrollRight;
  const browserPreviewTabTitle = browserPreviewTitle.trim() || i18nService.t('artifactBrowserTab');
  const fetchSubagents = useCallback(async (targetSessionId: string, options: { showLoading?: boolean } = {}) => {
    if (!targetSessionId) return;
    if (options.showLoading) {
      setSubagentsLoading(true);
    }
    try {
      const result = await window.electron?.cowork?.listSubagentSessions(targetSessionId);
      if (targetSessionId !== currentSession?.id) return;
      if (!result?.success || !result.runs) {
        setSubagents([]);
        return;
      }
      setSubagents(result.runs.map((run) => ({
        id: run.id,
        agentId: run.agentId,
        task: run.task,
        label: run.label,
        sessionKey: run.sessionKey,
        parentSessionId: targetSessionId,
        status: run.status,
        createdAt: run.createdAt,
        endedAt: run.endedAt,
      })));
    } catch {
      if (targetSessionId === currentSession?.id) {
        setSubagents([]);
      }
    } finally {
      if (targetSessionId === currentSession?.id) {
        setSubagentsLoading(false);
      }
    }
  }, [currentSession?.id]);

  useEffect(() => {
    if (!sessionId) return;
    void fetchSubagents(sessionId, { showLoading: subagents.length === 0 });
  }, [fetchSubagents, messagesLength, sessionId, subagents.length]);

  useEffect(() => {
    if (!sessionId) return undefined;
    const hasRunningSubagents = subagents.some(subagent => subagent.status === 'running');
    const shouldPoll = isSubagentPreviewTabOpen ||
      hasRunningSubagents ||
      currentSession?.status === CoworkSessionStatusValue.Running;
    if (!shouldPoll) return undefined;
    const timer = window.setInterval(() => {
      void fetchSubagents(sessionId);
    }, SUBAGENT_PANEL_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [
    currentSession?.status,
    fetchSubagents,
    isSubagentPreviewTabOpen,
    sessionId,
    subagents,
  ]);

  const subagentsByRunId = useMemo(() => new Map(
    subagents.map(subagent => [subagent.id, subagent]),
  ), [subagents]);
  const selectedSubagentForPanel = useMemo(() => (
    selectedSubagent
      ? subagents.find(subagent => subagent.id === selectedSubagent.id) ?? selectedSubagent
      : null
  ), [selectedSubagent, subagents]);

  const getToolGroupSubagents = useCallback((group: ToolGroupItem): SubagentSessionSummary[] => {
    const seen = new Set<string>();
    const result: SubagentSessionSummary[] = [];
    const candidateIds = [
      group.toolUse.id,
      group.toolUse.metadata?.toolUseId,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);
    for (const candidateId of candidateIds) {
      if (seen.has(candidateId)) continue;
      const subagent = subagentsByRunId.get(candidateId);
      if (!subagent) continue;
      seen.add(candidateId);
      result.push(subagent);
    }
    return result;
  }, [subagentsByRunId]);

  const loadedFileIdsRef = useRef<Set<string>>(new Set());
  const autoPreviewHandledTurnIdsRef = useRef<Record<string, Set<string>>>({});
  const autoPreviewArtifactSettleTimerRef = useRef<number | null>(null);
  const previousAutoPreviewSessionIdRef = useRef<string | undefined>(sessionId);
  const previousAutoPreviewStreamingRef = useRef(isStreaming);
  const previousAutoPreviewMessagesLengthRef = useRef(messagesLength);
  const previousAutoPreviewLatestTurnIdRef = useRef<string | null>(null);
  const [autoPreviewPendingTurnId, setAutoPreviewPendingTurnId] = useState<string | null>(null);

  const getAutoPreviewHandledTurnIds = useCallback((targetSessionId: string): Set<string> => {
    let handled = autoPreviewHandledTurnIdsRef.current[targetSessionId];
    if (!handled) {
      handled = new Set<string>();
      autoPreviewHandledTurnIdsRef.current[targetSessionId] = handled;
    }
    return handled;
  }, []);

  const clearAutoPreviewArtifactSettleTimer = useCallback(() => {
    if (autoPreviewArtifactSettleTimerRef.current) {
      window.clearTimeout(autoPreviewArtifactSettleTimerRef.current);
      autoPreviewArtifactSettleTimerRef.current = null;
    }
  }, []);

  const setCurrentAutoPreviewPendingTurnId = useCallback((turnId: string | null) => {
    setAutoPreviewPendingTurnId(turnId);
  }, []);

  const markAutoPreviewTurnHandled = useCallback((targetSessionId: string, turnId: string) => {
    clearAutoPreviewArtifactSettleTimer();
    getAutoPreviewHandledTurnIds(targetSessionId).add(turnId);
    if (targetSessionId === sessionId && autoPreviewPendingTurnId === turnId) {
      setAutoPreviewPendingTurnId(null);
    }
  }, [
    autoPreviewPendingTurnId,
    clearAutoPreviewArtifactSettleTimer,
    getAutoPreviewHandledTurnIds,
    sessionId,
  ]);

  useEffect(() => {
    let animationFrame: number | undefined;
    let transitionTimeout: number | undefined;
    const wasOpen = previousArtifactPanelOpenRef.current;

    previousArtifactPanelOpenRef.current = isPanelOpen;

    if (wasOpen === isPanelOpen) {
      return undefined;
    }

    if (isPanelOpen) {
      setShouldRenderArtifactPanel(true);
      setIsArtifactPanelVisible(false);
      setIsArtifactPanelTransitioning(true);
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = window.requestAnimationFrame(() => {
          setIsArtifactPanelVisible(true);
          transitionTimeout = window.setTimeout(() => {
            setIsArtifactPanelTransitioning(false);
          }, ARTIFACT_PANEL_TRANSITION_MS);
        });
      });
    } else {
      setIsArtifactPanelTransitioning(true);
      setIsArtifactPanelVisible(false);
      transitionTimeout = window.setTimeout(() => {
        setShouldRenderArtifactPanel(false);
        setIsArtifactPanelTransitioning(false);
      }, ARTIFACT_PANEL_TRANSITION_MS);
    }

    return () => {
      if (animationFrame !== undefined) {
        window.cancelAnimationFrame(animationFrame);
      }
      if (transitionTimeout !== undefined) {
        window.clearTimeout(transitionTimeout);
      }
    };
  }, [isPanelOpen]);

  const updateArtifactPanelMaxWidth = useCallback(() => {
    const contentWidth = contentRowRef.current?.clientWidth ?? 0;
    if (contentWidth <= 0) return;
    setContentRowWidth(contentWidth);
    const availablePanelWidth = contentWidth - COWORK_DETAIL_MIN_WIDTH - ARTIFACT_PANEL_RESIZE_HANDLE_WIDTH;
    const nextMaxWidth = Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, availablePanelWidth));
    const proportionalMinWidth = Math.floor(contentWidth * ARTIFACT_PANEL_MIN_WIDTH_RATIO);
    const nextMinWidth = Math.min(nextMaxWidth, Math.max(MIN_PANEL_WIDTH, proportionalMinWidth));
    setArtifactPanelMinWidth(nextMinWidth);
    setArtifactPanelMaxWidth(nextMaxWidth);
  }, []);

  useLayoutEffect(() => {
    updateArtifactPanelMaxWidth();
    const container = contentRowRef.current;
    window.addEventListener('resize', updateArtifactPanelMaxWidth);

    if (typeof ResizeObserver === 'undefined' || !container) {
      return () => {
        window.removeEventListener('resize', updateArtifactPanelMaxWidth);
      };
    }

    const resizeObserver = new ResizeObserver(updateArtifactPanelMaxWidth);
    resizeObserver.observe(container);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', updateArtifactPanelMaxWidth);
    };
  }, [currentSession?.id, updateArtifactPanelMaxWidth]);

  const updatePromptInputAreaHeight = useCallback(() => {
    setPromptInputAreaHeight(promptInputAreaRef.current?.offsetHeight ?? 0);
  }, []);

  useLayoutEffect(() => {
    updatePromptInputAreaHeight();
    const element = promptInputAreaRef.current;
    window.addEventListener('resize', updatePromptInputAreaHeight);

    if (typeof ResizeObserver === 'undefined' || !element) {
      return () => {
        window.removeEventListener('resize', updatePromptInputAreaHeight);
      };
    }

    const resizeObserver = new ResizeObserver(updatePromptInputAreaHeight);
    resizeObserver.observe(element);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', updatePromptInputAreaHeight);
    };
  }, [currentSession?.id, isExpandedPromptInputHidden, updatePromptInputAreaHeight]);

  useEffect(() => {
    if (isPanelOpen) return;
    setIsArtifactPanelExpanded(false);
    setIsExpandedPromptInputHidden(false);
    setIsExpandedConversationPreviewOpen(false);
  }, [isPanelOpen]);

  useEffect(() => {
    setIsFileListPreviewTabOpen(sessionId ? fileListPreviewTabOpenBySessionRef.current[sessionId] ?? false : false);
    setIsBrowserPreviewTabOpen(sessionId ? browserPreviewTabOpenBySessionRef.current[sessionId] ?? false : false);
    setIsSubagentPreviewTabOpen(sessionId ? subagentPreviewTabOpenBySessionRef.current[sessionId] ?? false : false);
    setActiveSpecialPreviewTab(sessionId
      ? activeSpecialPreviewTabBySessionRef.current[sessionId] ?? ArtifactSpecialTab.FileList
      : ArtifactSpecialTab.FileList);
    setBrowserPreviewAddress(sessionId ? browserPreviewAddressBySessionRef.current[sessionId] ?? '' : '');
    setBrowserPreviewUrl(sessionId ? browserPreviewUrlBySessionRef.current[sessionId] ?? '' : '');
    setBrowserPreviewTitle(sessionId ? browserPreviewTitleBySessionRef.current[sessionId] ?? '' : '');
    setBrowserLocalServiceContext(sessionId ? browserLocalServiceContextBySessionRef.current[sessionId] ?? null : null);
    setBrowserHtmlPreviewArtifactId(sessionId ? browserHtmlPreviewArtifactIdBySessionRef.current[sessionId] ?? null : null);
    setIsArtifactPanelExpanded(false);
    setIsExpandedPromptInputHidden(false);
    setIsExpandedConversationPreviewOpen(false);
    setShowArtifactAddMenu(false);
    setSubagents([]);
    setSubagentsLoading(false);
    setSelectedSubagent(null);
    loadedFileIdsRef.current = new Set();
    setAutoPreviewPendingTurnId(null);
  }, [sessionId]);

  useEffect(() => (
    () => {
      for (const previewSessionId of Object.values(browserHtmlPreviewSessionIdBySessionRef.current)) {
        void window.electron?.artifact?.destroyPreviewSession(previewSessionId);
      }
      browserHtmlPreviewSessionIdBySessionRef.current = {};
      browserHtmlPreviewUrlBySessionRef.current = {};
      browserHtmlPreviewArtifactIdBySessionRef.current = {};
    }
  ), []);

  const setSessionFileListPreviewTabOpen = useCallback((open: boolean) => {
    setIsFileListPreviewTabOpen(open);
    if (sessionId) {
      fileListPreviewTabOpenBySessionRef.current[sessionId] = open;
    }
  }, [sessionId]);

  const setSessionBrowserPreviewTabOpen = useCallback((open: boolean) => {
    setIsBrowserPreviewTabOpen(open);
    if (sessionId) {
      browserPreviewTabOpenBySessionRef.current[sessionId] = open;
    }
  }, [sessionId]);

  const setSessionSubagentPreviewTabOpen = useCallback((open: boolean) => {
    setIsSubagentPreviewTabOpen(open);
    if (sessionId) {
      subagentPreviewTabOpenBySessionRef.current[sessionId] = open;
    }
  }, [sessionId]);

  const setSessionActiveSpecialPreviewTab = useCallback((tab: ArtifactSpecialTab) => {
    setActiveSpecialPreviewTab(tab);
    if (sessionId) {
      activeSpecialPreviewTabBySessionRef.current[sessionId] = tab;
    }
  }, [sessionId]);

  const handleBrowserPreviewAddressChange = useCallback((value: string) => {
    setBrowserPreviewAddress(value);
    if (sessionId) {
      browserPreviewAddressBySessionRef.current[sessionId] = value;
    }
  }, [sessionId]);

  const setSessionBrowserLocalServiceContext = useCallback((context: BrowserLocalServiceContext | null) => {
    setBrowserLocalServiceContext(context);
    if (!sessionId) return;
    if (context) {
      browserLocalServiceContextBySessionRef.current[sessionId] = context;
    } else {
      delete browserLocalServiceContextBySessionRef.current[sessionId];
    }
  }, [sessionId]);

  const clearBrowserHtmlPreviewState = useCallback((targetSessionId = sessionId) => {
    if (!targetSessionId) return;
    const previewSessionId = browserHtmlPreviewSessionIdBySessionRef.current[targetSessionId];
    if (previewSessionId) {
      void window.electron?.artifact?.destroyPreviewSession(previewSessionId);
    }
    delete browserHtmlPreviewSessionIdBySessionRef.current[targetSessionId];
    delete browserHtmlPreviewUrlBySessionRef.current[targetSessionId];
    delete browserHtmlPreviewArtifactIdBySessionRef.current[targetSessionId];
    if (targetSessionId === sessionId) {
      setBrowserHtmlPreviewArtifactId(null);
    }
  }, [sessionId]);

  const handleBrowserPreviewUrlChange = useCallback((value: string) => {
    setBrowserPreviewUrl(value);
    if (sessionId) {
      browserPreviewUrlBySessionRef.current[sessionId] = value;
      const htmlPreviewUrl = browserHtmlPreviewUrlBySessionRef.current[sessionId];
      if (htmlPreviewUrl && !isSameBrowserPreviewUrl(value, htmlPreviewUrl)) {
        clearBrowserHtmlPreviewState(sessionId);
      }
    }
    setBrowserLocalServiceContext(current => {
      if (!current || !value.trim()) return current;
      if (normalizeLocalServiceOrigin(value) === current.origin) return current;
      if (sessionId) {
        delete browserLocalServiceContextBySessionRef.current[sessionId];
      }
      return null;
    });
  }, [clearBrowserHtmlPreviewState, sessionId]);

  const handleBrowserPreviewTitleChange = useCallback((value: string) => {
    const nextTitle = value.trim();
    setBrowserPreviewTitle(nextTitle);
    if (sessionId) {
      if (nextTitle) {
        browserPreviewTitleBySessionRef.current[sessionId] = nextTitle;
      } else {
        delete browserPreviewTitleBySessionRef.current[sessionId];
      }
    }
  }, [sessionId]);

  const clearBrowserPreviewState = useCallback(() => {
    setBrowserPreviewAddress('');
    setBrowserPreviewUrl('');
    setBrowserPreviewTitle('');
    setBrowserLocalServiceContext(null);
    if (sessionId) {
      delete browserPreviewAddressBySessionRef.current[sessionId];
      delete browserPreviewUrlBySessionRef.current[sessionId];
      delete browserPreviewTitleBySessionRef.current[sessionId];
      delete browserLocalServiceContextBySessionRef.current[sessionId];
      clearBrowserHtmlPreviewState(sessionId);
    }
  }, [clearBrowserHtmlPreviewState, sessionId]);

  const handleOpenArtifactFileListTab = useCallback(() => {
    reportArtifactPreviewAction({
      actionType: 'panel_tab_open',
      source: 'artifact_panel',
      params: {
        tabType: 'file_list',
        tabCount: artifactTabsWithArtifacts.length,
      },
    });
    setSessionFileListPreviewTabOpen(true);
    setSessionActiveSpecialPreviewTab(ArtifactSpecialTab.FileList);
    if (sessionId) {
      dispatch(activateArtifactFileListTab({ sessionId }));
    }
  }, [artifactTabsWithArtifacts.length, dispatch, sessionId, setSessionActiveSpecialPreviewTab, setSessionFileListPreviewTabOpen]);

  const handleActivateArtifactFileListTab = useCallback(() => {
    if (!sessionId) return;
    reportArtifactPreviewAction({
      actionType: 'panel_tab_switch',
      source: 'artifact_panel',
      params: {
        tabType: 'file_list',
        tabCount: artifactTabsWithArtifacts.length,
      },
    });
    setSessionFileListPreviewTabOpen(true);
    setSessionActiveSpecialPreviewTab(ArtifactSpecialTab.FileList);
    dispatch(activateArtifactFileListTab({ sessionId }));
  }, [artifactTabsWithArtifacts.length, dispatch, sessionId, setSessionActiveSpecialPreviewTab, setSessionFileListPreviewTabOpen]);

  const handleOpenArtifactBrowserTab = useCallback(() => {
    reportArtifactPreviewAction({
      actionType: 'panel_tab_open',
      source: 'artifact_panel',
      params: {
        tabType: 'browser',
        tabCount: artifactTabsWithArtifacts.length,
      },
    });
    setShowArtifactAddMenu(false);
    if (!sessionId) return;
    setSessionBrowserPreviewTabOpen(true);
    setSessionActiveSpecialPreviewTab(ArtifactSpecialTab.Browser);
    dispatch(activateArtifactBrowserTab({ sessionId }));
  }, [artifactTabsWithArtifacts.length, dispatch, sessionId, setSessionActiveSpecialPreviewTab, setSessionBrowserPreviewTabOpen]);

  const handleOpenArtifactSubagentTab = useCallback(() => {
    reportArtifactPreviewAction({
      actionType: 'panel_tab_open',
      source: 'artifact_panel',
      params: {
        tabType: 'subagents',
        tabCount: artifactTabsWithArtifacts.length,
      },
    });
    setShowArtifactAddMenu(false);
    setSelectedSubagent(null);
    if (!sessionId) return;
    setSessionSubagentPreviewTabOpen(true);
    setSessionActiveSpecialPreviewTab(ArtifactSpecialTab.Subagents);
    dispatch(activateArtifactSubagentTab({ sessionId }));
    void fetchSubagents(sessionId, { showLoading: subagents.length === 0 });
  }, [
    artifactTabsWithArtifacts.length,
    dispatch,
    fetchSubagents,
    sessionId,
    setSessionActiveSpecialPreviewTab,
    setSessionSubagentPreviewTabOpen,
    subagents.length,
  ]);

  const handleSelectSubagent = useCallback((subagent: SubagentSessionSummary) => {
    if (!sessionId) return;
    setSelectedSubagent(subagent);
    setSessionSubagentPreviewTabOpen(true);
    setSessionActiveSpecialPreviewTab(ArtifactSpecialTab.Subagents);
    dispatch(activateArtifactSubagentTab({ sessionId }));
    void fetchSubagents(sessionId, { showLoading: subagents.length === 0 });
  }, [
    dispatch,
    fetchSubagents,
    sessionId,
    setSessionActiveSpecialPreviewTab,
    setSessionSubagentPreviewTabOpen,
    subagents.length,
  ]);

  const handleToggleArtifactPanelExpanded = useCallback(() => {
    setIsArtifactPanelExpanded(value => {
      const nextValue = !value;
      reportArtifactPreviewAction({
        actionType: 'panel_expand_toggle',
        source: 'artifact_panel',
        params: {
          targetExpanded: nextValue,
          tabCount: artifactTabsWithArtifacts.length,
        },
      });
      if (!nextValue) {
        setIsExpandedPromptInputHidden(false);
        setIsExpandedConversationPreviewOpen(false);
      }
      return nextValue;
    });
  }, [artifactTabsWithArtifacts.length]);

  const handleToggleExpandedPromptInput = useCallback(() => {
    setIsExpandedPromptInputHidden(value => {
      const nextValue = !value;
      if (nextValue) {
        setIsExpandedConversationPreviewOpen(false);
      }
      return nextValue;
    });
  }, []);

  const handleOpenHtmlFileInBrowser = useCallback(async (artifact: Artifact) => {
    if (!sessionId || artifact.type !== ArtifactTypeValue.Html || !artifact.filePath) return;
    reportArtifactPreviewAction({
      actionType: 'open_lobster_browser',
      source: 'artifact_panel',
      artifact,
      params: {
        openTarget: 'lobster_browser',
      },
    });

    setShowArtifactAddMenu(false);
    setSessionBrowserPreviewTabOpen(true);
    setSessionActiveSpecialPreviewTab(ArtifactSpecialTab.Browser);
    setSessionBrowserLocalServiceContext(null);
    dispatch(activateArtifactBrowserTab({ sessionId }));

    const requestId = browserHtmlPreviewRequestIdRef.current + 1;
    browserHtmlPreviewRequestIdRef.current = requestId;
    const previousPreviewSessionId = browserHtmlPreviewSessionIdBySessionRef.current[sessionId];
    try {
      const result = await window.electron?.artifact?.createPreviewSession(artifact.filePath);
      if (
        browserHtmlPreviewRequestIdRef.current !== requestId ||
        currentSession?.id !== sessionId
      ) {
        if (result?.success && result.sessionId) {
          void window.electron?.artifact?.destroyPreviewSession(result.sessionId);
        }
        return;
      }
      if (!result?.success || !result.url || !result.sessionId) {
        throw new Error(result?.error || i18nService.t('artifactSourceLoadFailed'));
      }
      if (previousPreviewSessionId && previousPreviewSessionId !== result.sessionId) {
        void window.electron?.artifact?.destroyPreviewSession(previousPreviewSessionId);
      }
      browserHtmlPreviewArtifactIdBySessionRef.current[sessionId] = artifact.id;
      browserHtmlPreviewSessionIdBySessionRef.current[sessionId] = result.sessionId;
      browserHtmlPreviewUrlBySessionRef.current[sessionId] = result.url;
      setBrowserHtmlPreviewArtifactId(artifact.id);
      handleBrowserPreviewAddressChange(artifact.filePath);
      handleBrowserPreviewUrlChange(result.url);
      handleBrowserPreviewTitleChange('');
      reportArtifactPreviewAction({
        actionType: 'browser_preview_session_create',
        source: 'artifact_panel',
        artifact,
        params: {
          result: 'success',
        },
      });
    } catch (error) {
      if (!previousPreviewSessionId) {
        clearBrowserHtmlPreviewState(sessionId);
      }
      window.dispatchEvent(new CustomEvent('app:showToast', {
        detail: error instanceof Error ? error.message : i18nService.t('artifactSourceLoadFailed'),
      }));
      reportArtifactPreviewAction({
        actionType: 'browser_preview_session_create',
        source: 'artifact_panel',
        artifact,
        params: {
          result: 'failed',
        },
      });
    }
  }, [
    clearBrowserHtmlPreviewState,
    currentSession?.id,
    dispatch,
    handleBrowserPreviewAddressChange,
    handleBrowserPreviewTitleChange,
    handleBrowserPreviewUrlChange,
    sessionId,
    setSessionActiveSpecialPreviewTab,
    setSessionBrowserPreviewTabOpen,
    setSessionBrowserLocalServiceContext,
  ]);

  const handleOpenLocalServiceArtifact = useCallback((artifact: Artifact) => {
    const url = artifact.url || artifact.content;
    if (!url) return;
    const origin = artifact.localService?.origin || normalizeLocalServiceOrigin(url);
    const projectDirectory = artifact.localService?.projectDirectory?.trim() || currentSession?.cwd?.trim();
    reportArtifactPreviewAction({
      actionType: 'open_local_service',
      source: 'artifact_panel',
      artifact,
      params: {
        openTarget: 'lobster_browser',
      },
    });
    handleOpenArtifactBrowserTab();
    setSessionBrowserLocalServiceContext({
      artifactId: artifact.id,
      url,
      origin,
      ...(projectDirectory ? { projectDirectory } : {}),
      ...(artifact.localService?.projectCandidates?.length
        ? { projectCandidates: artifact.localService.projectCandidates }
        : {}),
    });
    handleBrowserPreviewAddressChange(url);
    handleBrowserPreviewUrlChange(url);
    handleBrowserPreviewTitleChange('');
  }, [
    currentSession?.cwd,
    handleBrowserPreviewAddressChange,
    handleBrowserPreviewTitleChange,
    handleBrowserPreviewUrlChange,
    handleOpenArtifactBrowserTab,
    setSessionBrowserLocalServiceContext,
  ]);

  const handleOpenArtifactFileListFromMenu = useCallback(() => {
    setShowArtifactAddMenu(false);
    handleOpenArtifactFileListTab();
  }, [handleOpenArtifactFileListTab]);

  const handleCloseArtifactFileListTab = useCallback(() => {
    const wasActive = !activeArtifactPreviewTab && activeSpecialPreviewTab === ArtifactSpecialTab.FileList;
    reportArtifactPreviewAction({
      actionType: 'panel_tab_close',
      source: 'artifact_panel',
      params: {
        tabType: 'file_list',
        wasActive,
        tabCount: artifactTabsWithArtifacts.length,
      },
    });
    setSessionFileListPreviewTabOpen(false);
    if (!sessionId) {
      dispatch(closePanel(undefined));
      return;
    }

    if (!wasActive) return;

    const nextTabId = artifactTabsWithArtifacts[0]?.tab.id;
    if (nextTabId) {
      dispatch(activateArtifactPreviewTab({ sessionId, tabId: nextTabId }));
      return;
    }

    if (isBrowserPreviewTabOpen) {
      setSessionActiveSpecialPreviewTab(ArtifactSpecialTab.Browser);
      dispatch(activateArtifactBrowserTab({ sessionId }));
      return;
    }

    if (isSubagentPreviewTabOpen) {
      setSessionActiveSpecialPreviewTab(ArtifactSpecialTab.Subagents);
      dispatch(activateArtifactSubagentTab({ sessionId }));
      return;
    }

    dispatch(closePanel({ sessionId }));
  }, [
    activeArtifactPreviewTab,
    activeSpecialPreviewTab,
    artifactTabsWithArtifacts,
    dispatch,
    isBrowserPreviewTabOpen,
    isSubagentPreviewTabOpen,
    sessionId,
    setSessionActiveSpecialPreviewTab,
    setSessionFileListPreviewTabOpen,
  ]);

  const handleActivateArtifactBrowserTab = useCallback(() => {
    if (!sessionId) return;
    reportArtifactPreviewAction({
      actionType: 'panel_tab_switch',
      source: 'artifact_panel',
      params: {
        tabType: 'browser',
        tabCount: artifactTabsWithArtifacts.length,
      },
    });
    setSessionBrowserPreviewTabOpen(true);
    setSessionActiveSpecialPreviewTab(ArtifactSpecialTab.Browser);
    dispatch(activateArtifactBrowserTab({ sessionId }));
  }, [artifactTabsWithArtifacts.length, dispatch, sessionId, setSessionActiveSpecialPreviewTab, setSessionBrowserPreviewTabOpen]);

  const handleActivateArtifactSubagentTab = useCallback(() => {
    if (!sessionId) return;
    reportArtifactPreviewAction({
      actionType: 'panel_tab_switch',
      source: 'artifact_panel',
      params: {
        tabType: 'subagents',
        tabCount: artifactTabsWithArtifacts.length,
      },
    });
    setSessionSubagentPreviewTabOpen(true);
    setSessionActiveSpecialPreviewTab(ArtifactSpecialTab.Subagents);
    dispatch(activateArtifactSubagentTab({ sessionId }));
    void fetchSubagents(sessionId, { showLoading: subagents.length === 0 });
  }, [
    artifactTabsWithArtifacts.length,
    dispatch,
    fetchSubagents,
    sessionId,
    setSessionActiveSpecialPreviewTab,
    setSessionSubagentPreviewTabOpen,
    subagents.length,
  ]);

  const handleCloseArtifactBrowserTab = useCallback(() => {
    const wasActive = !activeArtifactPreviewTab && activeSpecialPreviewTab === ArtifactSpecialTab.Browser;
    reportArtifactPreviewAction({
      actionType: 'panel_tab_close',
      source: 'artifact_panel',
      params: {
        tabType: 'browser',
        wasActive,
        tabCount: artifactTabsWithArtifacts.length,
      },
    });
    setSessionBrowserPreviewTabOpen(false);
    clearBrowserPreviewState();
    if (!sessionId) {
      dispatch(closePanel(undefined));
      return;
    }

    if (!wasActive) return;

    const nextTabId = artifactTabsWithArtifacts[0]?.tab.id;
    if (nextTabId) {
      dispatch(activateArtifactPreviewTab({ sessionId, tabId: nextTabId }));
      return;
    }

    if (isFileListPreviewTabOpen) {
      setSessionActiveSpecialPreviewTab(ArtifactSpecialTab.FileList);
      dispatch(activateArtifactFileListTab({ sessionId }));
      return;
    }

    if (isSubagentPreviewTabOpen) {
      setSessionActiveSpecialPreviewTab(ArtifactSpecialTab.Subagents);
      dispatch(activateArtifactSubagentTab({ sessionId }));
      return;
    }

    dispatch(closePanel({ sessionId }));
  }, [
    activeArtifactPreviewTab,
    activeSpecialPreviewTab,
    artifactTabsWithArtifacts,
    dispatch,
    clearBrowserPreviewState,
    isFileListPreviewTabOpen,
    isSubagentPreviewTabOpen,
    sessionId,
    setSessionActiveSpecialPreviewTab,
    setSessionBrowserPreviewTabOpen,
  ]);

  const handleCloseArtifactSubagentTab = useCallback(() => {
    const wasActive = !activeArtifactPreviewTab && activeSpecialPreviewTab === ArtifactSpecialTab.Subagents;
    reportArtifactPreviewAction({
      actionType: 'panel_tab_close',
      source: 'artifact_panel',
      params: {
        tabType: 'subagents',
        wasActive,
        tabCount: artifactTabsWithArtifacts.length,
      },
    });
    setSessionSubagentPreviewTabOpen(false);
    setSelectedSubagent(null);
    if (!sessionId) {
      dispatch(closePanel(undefined));
      return;
    }

    if (!wasActive) return;

    const nextTabId = artifactTabsWithArtifacts[0]?.tab.id;
    if (nextTabId) {
      dispatch(activateArtifactPreviewTab({ sessionId, tabId: nextTabId }));
      return;
    }

    if (isBrowserPreviewTabOpen) {
      setSessionActiveSpecialPreviewTab(ArtifactSpecialTab.Browser);
      dispatch(activateArtifactBrowserTab({ sessionId }));
      return;
    }

    if (isFileListPreviewTabOpen) {
      setSessionActiveSpecialPreviewTab(ArtifactSpecialTab.FileList);
      dispatch(activateArtifactFileListTab({ sessionId }));
      return;
    }

    dispatch(closePanel({ sessionId }));
  }, [
    activeArtifactPreviewTab,
    activeSpecialPreviewTab,
    artifactTabsWithArtifacts,
    dispatch,
    isBrowserPreviewTabOpen,
    isFileListPreviewTabOpen,
    sessionId,
    setSessionActiveSpecialPreviewTab,
    setSessionSubagentPreviewTabOpen,
  ]);

  const handleActivateArtifactTab = useCallback((tabId: string) => {
    if (!sessionId) return;
    const artifact = artifactTabsWithArtifacts.find(item => item.tab.id === tabId)?.artifact;
    reportArtifactPreviewAction({
      actionType: 'panel_tab_switch',
      source: 'artifact_panel',
      artifact,
      params: {
        tabType: 'artifact',
        tabCount: artifactTabsWithArtifacts.length,
      },
    });
    dispatch(activateArtifactPreviewTab({ sessionId, tabId }));
  }, [artifactTabsWithArtifacts, dispatch, sessionId]);

  const handleCloseArtifactTab = useCallback((tabId: string) => {
    if (!sessionId) return;
    const artifact = artifactTabsWithArtifacts.find(item => item.tab.id === tabId)?.artifact;
    const remainingTabs = artifactTabsWithArtifacts.filter(({ tab }) => tab.id !== tabId);
    reportArtifactPreviewAction({
      actionType: 'panel_tab_close',
      source: 'artifact_panel',
      artifact,
      params: {
        tabType: 'artifact',
        tabCount: artifactTabsWithArtifacts.length,
      },
    });
    dispatch(closeArtifactPreviewTab({ sessionId, tabId }));
    if (remainingTabs.length === 0 && !isFileListPreviewTabOpen && !isBrowserPreviewTabOpen && !isSubagentPreviewTabOpen) {
      dispatch(closePanel({ sessionId }));
    }
  }, [artifactTabsWithArtifacts, dispatch, isBrowserPreviewTabOpen, isFileListPreviewTabOpen, isSubagentPreviewTabOpen, sessionId]);

  const handleToggleArtifactPanel = useCallback(() => {
    reportArtifactPreviewAction({
      actionType: 'panel_toggle',
      source: 'artifact_panel',
      params: {
        targetOpen: !isPanelOpen,
        tabCount: artifactTabsWithArtifacts.length,
      },
    });
    if (isPanelOpen) {
      setShowArtifactAddMenu(false);
      if (sessionId && autoPreviewPendingTurnId) {
        markAutoPreviewTurnHandled(sessionId, autoPreviewPendingTurnId);
      }
      dispatch(closePanel(sessionId ? { sessionId } : undefined));
      return;
    }

    if (!sessionId) {
      dispatch(togglePanel(undefined));
      return;
    }

    if (artifactTabsWithArtifacts.length === 0 && !isFileListPreviewTabOpen && !isBrowserPreviewTabOpen && !isSubagentPreviewTabOpen) {
      setSessionFileListPreviewTabOpen(true);
      setSessionActiveSpecialPreviewTab(ArtifactSpecialTab.FileList);
      dispatch(activateArtifactFileListTab({ sessionId }));
      return;
    }

    dispatch(togglePanel({ sessionId }));
  }, [
    artifactTabsWithArtifacts.length,
    autoPreviewPendingTurnId,
    dispatch,
    isBrowserPreviewTabOpen,
    isFileListPreviewTabOpen,
    isSubagentPreviewTabOpen,
    isPanelOpen,
    markAutoPreviewTurnHandled,
    sessionId,
    setSessionActiveSpecialPreviewTab,
    setSessionFileListPreviewTabOpen,
  ]);

  useEffect(() => {
    window.addEventListener(CoworkUiEvent.ShortcutToggleArtifacts, handleToggleArtifactPanel);
    return () => {
      window.removeEventListener(CoworkUiEvent.ShortcutToggleArtifacts, handleToggleArtifactPanel);
    };
  }, [handleToggleArtifactPanel]);

  const handleToggleArtifactAddMenu = useCallback(() => {
    setShowArtifactAddMenu(open => {
      const nextOpen = !open;
      reportArtifactPreviewAction({
        actionType: 'panel_add_menu_toggle',
        source: 'artifact_panel',
        params: {
          targetOpen: nextOpen,
          tabCount: artifactTabsWithArtifacts.length,
        },
      });
      return nextOpen;
    });
  }, [artifactTabsWithArtifacts.length]);

  useLayoutEffect(() => {
    if (!showArtifactAddMenu) {
      setArtifactAddMenuPosition(null);
      return undefined;
    }

    const updateMenuPosition = () => {
      const rect = artifactAddButtonRef.current?.getBoundingClientRect();
      if (!rect) return;
      setArtifactAddMenuPosition({
        left: Math.round(Math.max(8, Math.min(window.innerWidth - 184, rect.right - 176))),
        top: Math.round(rect.bottom + 6),
      });
    };

    updateMenuPosition();
    window.addEventListener('resize', updateMenuPosition);
    window.addEventListener('scroll', updateMenuPosition, true);
    return () => {
      window.removeEventListener('resize', updateMenuPosition);
      window.removeEventListener('scroll', updateMenuPosition, true);
    };
  }, [showArtifactAddMenu]);

  const updateArtifactTabsScrollState = useCallback(() => {
    const element = artifactTabsScrollRef.current;
    if (!element) {
      setArtifactTabsCanScrollLeft(false);
      setArtifactTabsCanScrollRight(false);
      setArtifactTabsIsOverflowing(false);
      return;
    }

    const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
    setArtifactTabsCanScrollLeft(element.scrollLeft > 1);
    setArtifactTabsCanScrollRight(element.scrollLeft < maxScrollLeft - 1);
    setArtifactTabsIsOverflowing(element.scrollWidth > element.clientWidth + 1);
  }, []);

  useLayoutEffect(() => {
    const container = artifactTabsScrollRef.current;
    if (!container || !isArtifactPanelVisible) return undefined;

    const animationFrame = window.requestAnimationFrame(() => {
      const activeTab = container.querySelector<HTMLElement>('[data-artifact-preview-active="true"]');
      if (!activeTab) {
        updateArtifactTabsScrollState();
        return;
      }

      const containerRect = container.getBoundingClientRect();
      const activeRect = activeTab.getBoundingClientRect();
      const visibleLeft = containerRect.left;
      const visibleRight = containerRect.right - (shouldPinArtifactAddTab ? 36 : 0);
      const padding = 8;

      if (activeRect.left < visibleLeft + padding) {
        container.scrollLeft -= visibleLeft + padding - activeRect.left;
      } else if (activeRect.right > visibleRight - padding) {
        container.scrollLeft += activeRect.right - visibleRight + padding;
      }

      updateArtifactTabsScrollState();
    });

    return () => {
      window.cancelAnimationFrame(animationFrame);
    };
  }, [
    activeArtifactPreviewTab?.id,
    activeSpecialPreviewTab,
    isArtifactPanelVisible,
    isBrowserPreviewTabOpen,
    isFileListPreviewTabOpen,
    shouldPinArtifactAddTab,
    updateArtifactTabsScrollState,
  ]);

  useLayoutEffect(() => {
    const element = artifactTabsScrollRef.current;
    if (!element || !isArtifactPanelVisible) {
      setArtifactTabsCanScrollLeft(false);
      setArtifactTabsCanScrollRight(false);
      setArtifactTabsIsOverflowing(false);
      return undefined;
    }

    updateArtifactTabsScrollState();
    const animationFrame = window.requestAnimationFrame(updateArtifactTabsScrollState);
    element.addEventListener('scroll', updateArtifactTabsScrollState, { passive: true });

    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(updateArtifactTabsScrollState)
      : null;
    resizeObserver?.observe(element);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      element.removeEventListener('scroll', updateArtifactTabsScrollState);
      resizeObserver?.disconnect();
    };
  }, [
    activeArtifactPreviewTab?.id,
    activeSpecialPreviewTab,
    artifactPanelMaxWidth,
    artifactPanelMinWidth,
    artifactTabsWithArtifacts.length,
    isArtifactPanelVisible,
    isBrowserPreviewTabOpen,
    isFileListPreviewTabOpen,
    panelWidth,
    updateArtifactTabsScrollState,
  ]);

  useEffect(() => {
    if (!showArtifactAddMenu) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (artifactAddMenuRef.current?.contains(target) || artifactAddButtonRef.current?.contains(target)) {
        return;
      }
      setShowArtifactAddMenu(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowArtifactAddMenu(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [showArtifactAddMenu]);

  useEffect(() => {
    if (!sessionId || !currentSession?.messages?.length) return;
    if (isStreaming) return;

    try {
      const messages = currentSession.messages;
      const detected: Artifact[] = [];
      const pushFileArtifactIfNew = (artifact: Artifact, seenFilePaths: Set<string>) => {
        const normalized = artifact.filePath ? normalizeFilePathForDedup(artifact.filePath) : '';
        if (!artifact.filePath || seenFilePaths.has(normalized)) return;
        seenFilePaths.add(normalized);
        detected.push(artifact);
      };
      const pushLocalServiceArtifactIfNew = (artifact: Artifact, seenLocalServiceUrls: Set<string>) => {
        const url = artifact.url || artifact.content;
        const normalized = normalizeLocalServiceUrlForDedup(url);
        if (!url || seenLocalServiceUrls.has(normalized)) return;
        seenLocalServiceUrls.add(normalized);
        detected.push(artifact);
      };

      for (const msg of messages) {
        if (msg.type === 'assistant' && !msg.metadata?.isThinking && msg.content) {
          const seenFilePaths = new Set<string>();
          const seenLocalServiceUrls = new Set<string>();
          const localServiceArtifacts = parseLocalServiceUrlsFromText(
            msg.content,
            msg.id,
            sessionId,
            { projectDirectory: currentSession.cwd },
          );
          for (const serviceArtifact of localServiceArtifacts) {
            pushLocalServiceArtifactIfNew(serviceArtifact, seenLocalServiceUrls);
          }

          const fileLinks = parseFileLinksFromMessage(msg.content, msg.id, sessionId);
          for (const fl of fileLinks) {
            pushFileArtifactIfNew(fl, seenFilePaths);
          }

          const contentWithoutFileLinks = stripFileLinksFromText(msg.content);
          const pathArtifacts = parseFilePathsFromText(contentWithoutFileLinks, msg.id, sessionId);
          for (const pa of pathArtifacts) {
            pushFileArtifactIfNew(pa, seenFilePaths);
          }

          detected.push(...parseRemoteImageArtifactsFromText(msg.content, msg.id, sessionId, 'artifact-remote-assistant'));
        }

        if (msg.type === 'tool_result') {
          const seenFilePaths = new Set<string>();
          const toolMediaArtifacts = parseToolResultMediaArtifacts(msg, sessionId);
          if (toolMediaArtifacts.length > 0) {
            for (const mediaArtifact of toolMediaArtifacts) {
              if (mediaArtifact.filePath) {
                pushFileArtifactIfNew(mediaArtifact, seenFilePaths);
              } else {
                detected.push(mediaArtifact);
              }
            }
            continue;
          }

          if (!msg.content) continue;

          const mediaArtifacts = parseMediaTokensFromText(msg.content, msg.id, sessionId);
          for (const ma of mediaArtifacts) {
            pushFileArtifactIfNew(ma, seenFilePaths);
          }

          // Only parse bare file paths from tool results of image generation tools.
          // Other tools (e.g. Bash running `find`) may output many file paths in their
          // results that should NOT become artifacts.
          const toolUseId = msg.metadata?.toolUseId;
          const pairedToolUse = toolUseId
            ? messages.find(m => m.type === 'tool_use' && m.metadata?.toolUseId === toolUseId)
            : undefined;
          const toolName = pairedToolUse?.metadata?.toolName
            ? String(pairedToolUse.metadata.toolName)
            : '';
          if (shouldParseFilePathsFromToolResult(toolName)) {
            const pathArtifacts = parseFilePathsFromText(msg.content, msg.id, sessionId, 'artifact-toolresult');
            for (const pa of pathArtifacts) {
              pushFileArtifactIfNew(pa, seenFilePaths);
            }
          }
          detected.push(...parseRemoteImageArtifactsFromText(msg.content, msg.id, sessionId, 'artifact-remote-toolresult'));
        }

        if (msg.type === 'system') {
          const seenFilePaths = new Set<string>();
          const toolMediaArtifacts = parseToolResultMediaArtifacts(msg, sessionId);
          if (toolMediaArtifacts.length > 0) {
            for (const mediaArtifact of toolMediaArtifacts) {
              if (mediaArtifact.filePath) {
                pushFileArtifactIfNew(mediaArtifact, seenFilePaths);
              } else {
                detected.push(mediaArtifact);
              }
            }
            continue;
          }

          if (!msg.content) continue;

          const fileLinks = parseFileLinksFromMessage(msg.content, msg.id, sessionId);
          for (const fl of fileLinks) {
            pushFileArtifactIfNew(fl, seenFilePaths);
          }

          const contentWithoutFileLinks = stripFileLinksFromText(msg.content);
          const pathArtifacts = parseFilePathsFromText(contentWithoutFileLinks, msg.id, sessionId, 'artifact-system-path');
          for (const pa of pathArtifacts) {
            pushFileArtifactIfNew(pa, seenFilePaths);
          }

          detected.push(...parseRemoteImageArtifactsFromText(msg.content, msg.id, sessionId, 'artifact-remote-system'));
        }
      }

      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.type === 'tool_use') {
          const toolUseId = msg.metadata?.toolUseId;
          const toolResult = toolUseId
            ? messages.find(m => m.type === 'tool_result' && m.metadata?.toolUseId === toolUseId)
            : messages[i + 1]?.type === 'tool_result' ? messages[i + 1] : undefined;
          const toolArtifact = parseToolArtifact(msg, toolResult, sessionId);
          if (toolArtifact && toolArtifact.filePath) {
            detected.push(toolArtifact);
          }
        }
      }

      const cwd = currentSession.cwd;
      for (const artifact of detected) {
        if (artifact.type === ArtifactTypeValue.LocalService) {
          dispatch(addArtifact({ sessionId, artifact, defaultProjectDirectory: cwd }));
        }
      }

      const toLoad = detected.filter(a => a.filePath && !loadedFileIdsRef.current.has(a.id));
      if (toLoad.length === 0) return;

      const loadFiles = async () => {
        for (const artifact of toLoad) {
          let rawPath = artifact.filePath!;
          if (rawPath.startsWith('file:///')) {
            rawPath = rawPath.slice(7);
          } else if (rawPath.startsWith('file://')) {
            rawPath = rawPath.slice(7);
          } else if (rawPath.startsWith('file:/')) {
            rawPath = rawPath.slice(5);
          }
          // Strip leading / before Windows drive letter
          if (/^\/[A-Za-z]:/.test(rawPath)) {
            rawPath = rawPath.slice(1);
          }
          const absPath = rawPath.startsWith('/')
            ? rawPath
            : (/^[A-Za-z]:/.test(rawPath) ? rawPath : `${cwd}/${rawPath}`);
          if (artifact.type === 'video') {
            loadedFileIdsRef.current.add(artifact.id);
            dispatch(addArtifact({
              sessionId,
              artifact: { ...artifact, content: '', filePath: absPath },
            }));
            continue;
          }
          if (artifact.type === ArtifactTypeValue.Html) {
            try {
              const stat = await window.electron.dialog.statFile(absPath);
              if (stat?.success && stat.isFile) {
                dispatch(addArtifact({
                  sessionId,
                  artifact: { ...artifact, content: '', filePath: absPath, contentVersion: Date.now() },
                }));
              }
            } catch {
              // File unreadable or missing.
            }
            loadedFileIdsRef.current.add(artifact.id);
            continue;
          }
          try {
            const result = await window.electron.dialog.readFileAsDataUrl(absPath);
            if (result?.success && result.dataUrl) {
              const isTextType = artifact.type !== 'image' && artifact.type !== 'document';
              let content = result.dataUrl;
              if (isTextType) {
                try {
                  const base64 = result.dataUrl.split(',')[1] || '';
                  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
                  content = new TextDecoder('utf-8').decode(bytes);
                } catch {
                  content = result.dataUrl;
                }
              }
              loadedFileIdsRef.current.add(artifact.id);
              dispatch(addArtifact({
                sessionId,
                artifact: { ...artifact, content, filePath: absPath },
              }));
            } else {
              // File does not exist or is unreadable — mark as loaded to avoid retrying
              loadedFileIdsRef.current.add(artifact.id);
            }
          } catch {
            // File unreadable or missing — mark as loaded to avoid retrying
            loadedFileIdsRef.current.add(artifact.id);
          }
        }
      };
      loadFiles();
    } catch (err) {
      console.error('[ArtifactDetection] failed:', err);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- uses messagesLength as stable proxy for currentSession.messages
  }, [sessionId, messagesLength, isStreaming, dispatch]);

  // Mid-turn artifact detection: detect MEDIA/file artifacts from backfilled tool results
  // while still streaming. The main effect above skips when isStreaming=true, but incremental
  // backfill can populate tool_result text mid-turn. This effect handles that case.
  useEffect(() => {
    if (!sessionId || !isStreaming || !currentSession?.messages?.length) return;

    try {
      const messages = currentSession.messages;
      const cwd = currentSession.cwd;
      const toLoad: Artifact[] = [];

      for (const msg of messages) {
        if (msg.type !== 'tool_result' || !msg.content || !msg.metadata?.isFinal) continue;
        if (loadedFileIdsRef.current.has(msg.id)) continue;

        // Only detect explicit MEDIA: tokens in tool results — do NOT parse bare file paths
        // here, because tool output (e.g. `ls`) may contain many irrelevant file paths.
        const seenFilePaths = new Set<string>();
        const mediaArtifacts = parseMediaTokensFromText(msg.content, msg.id, sessionId);
        for (const ma of mediaArtifacts) {
          const normalized = ma.filePath ? normalizeFilePathForDedup(ma.filePath) : '';
          if (ma.filePath && !seenFilePaths.has(normalized) && !loadedFileIdsRef.current.has(ma.id)) {
            seenFilePaths.add(normalized);
            toLoad.push(ma);
          }
        }
      }

      if (toLoad.length === 0) return;

      const loadFiles = async () => {
        for (const artifact of toLoad) {
          if (loadedFileIdsRef.current.has(artifact.id)) continue;
          let rawPath = artifact.filePath!;
          if (rawPath.startsWith('file:///')) {
            rawPath = rawPath.slice(7);
          } else if (rawPath.startsWith('file://')) {
            rawPath = rawPath.slice(7);
          } else if (rawPath.startsWith('file:/')) {
            rawPath = rawPath.slice(5);
          }
          if (/^\/[A-Za-z]:/.test(rawPath)) {
            rawPath = rawPath.slice(1);
          }
          const absPath = rawPath.startsWith('/')
            ? rawPath
            : (/^[A-Za-z]:/.test(rawPath) ? rawPath : `${cwd}/${rawPath}`);
          if (artifact.type === ArtifactTypeValue.Html) {
            try {
              const stat = await window.electron.dialog.statFile(absPath);
              if (stat?.success && stat.isFile) {
                dispatch(addArtifact({
                  sessionId,
                  artifact: { ...artifact, content: '', filePath: absPath, contentVersion: Date.now() },
                }));
              }
            } catch {
              // File unreadable or missing.
            }
            loadedFileIdsRef.current.add(artifact.id);
            continue;
          }
          try {
            const result = await window.electron.dialog.readFileAsDataUrl(absPath);
            if (result?.success && result.dataUrl) {
              const isTextType = artifact.type !== 'image' && artifact.type !== 'document';
              let content = result.dataUrl;
              if (isTextType) {
                try {
                  const base64 = result.dataUrl.split(',')[1] || '';
                  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
                  content = new TextDecoder('utf-8').decode(bytes);
                } catch {
                  content = result.dataUrl;
                }
              }
              loadedFileIdsRef.current.add(artifact.id);
              dispatch(addArtifact({
                sessionId,
                artifact: { ...artifact, content, filePath: absPath },
              }));
            } else {
              loadedFileIdsRef.current.add(artifact.id);
            }
          } catch {
            loadedFileIdsRef.current.add(artifact.id);
          }
        }
      };
      loadFiles();
    } catch (err) {
      console.error('[ArtifactDetection:midTurn] failed:', err);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mid-turn artifact detection for backfilled tool results
  }, [sessionId, messagesLength, isStreaming, dispatch]);
  // Cleanup nav timers on unmount
  useEffect(() => {
    return () => {
      if (navigatingTimerRef.current) clearTimeout(navigatingTimerRef.current);
      if (forcedRailTurnReleaseTimerRef.current) clearTimeout(forcedRailTurnReleaseTimerRef.current);
      clearScrollToBottomSettleTimers();
    };
  }, [clearScrollToBottomSettleTimers]);

  // Reset nav state when session changes
  useEffect(() => {
    setIsScrollable(false);
    setCurrentRailIndex(-1);
    currentRailIndexRef.current = -1;
    isNavigatingRef.current = false;
    scrollToBottomIntentRef.current = false;
    clearScrollToBottomSettleTimers();
    turnElsCacheRef.current = [];
    loadedRailRangeRef.current = null;
    isLoadingRailTargetRef.current = false;
    if (navigatingTimerRef.current) clearTimeout(navigatingTimerRef.current);
    if (forcedRailTurnReleaseTimerRef.current) clearTimeout(forcedRailTurnReleaseTimerRef.current);
    forcedRailTurnReleaseTimerRef.current = null;
    setForcedRailTurnIndex(null);
    setHoveredRailIndex(null);
  }, [clearScrollToBottomSettleTimers, currentSession?.id]);

  useEffect(() => {
    const handleOpenShareOptions = (event: Event) => {
      const detail = (event as CustomEvent<CoworkOpenShareOptionsEventDetail>).detail;
      if (!detail?.sessionId || detail.sessionId !== currentSession?.id) return;
      reportConversationNavigationAction({
        actionType: 'export_options_open',
        params: getConversationControlAnalyticsParams(),
      });
      setShowExportOptions(true);
    };

    window.addEventListener(CoworkUiEvent.OpenShareOptions, handleOpenShareOptions);
    return () => {
      window.removeEventListener(CoworkUiEvent.OpenShareOptions, handleOpenShareOptions);
    };
  }, [currentSession?.id, getConversationControlAnalyticsParams]);

  useEffect(() => {
    if (!currentSession?.id || messageRailIndex.length > 0) return;
    void coworkService.loadSessionMessageRailIndex(currentSession.id);
  }, [currentSession?.id, messageRailIndex.length]);

  const loadTextExportMessages = useCallback(async (): Promise<CoworkMessage[]> => {
    if (!currentSession) return [];

    const loadedMessages = currentSession.messages;
    const totalMessages = Math.max(currentSession.totalMessages ?? 0, loadedMessages.length);
    const hasLoadedFullHistory = (currentSession.messagesOffset ?? 0) <= 0 && loadedMessages.length >= totalMessages;
    if (hasLoadedFullHistory) {
      return loadedMessages;
    }

    const result = await window.electron.cowork.getSessionMessages({
      sessionId: currentSession.id,
      limit: Math.max(totalMessages, 1),
      offset: 0,
    });
    if (!result.success || !result.messages) {
      throw new Error(result.error || 'Failed to load session messages for export');
    }

    let storedMessages = result.messages;
    const returnedTotal = result.total ?? totalMessages;
    if (returnedTotal > storedMessages.length) {
      const retryResult = await window.electron.cowork.getSessionMessages({
        sessionId: currentSession.id,
        limit: returnedTotal,
        offset: 0,
      });
      if (retryResult.success && retryResult.messages) {
        storedMessages = retryResult.messages;
      }
    }

    return mergeCoworkTextExportMessages(storedMessages, loadedMessages);
  }, [currentSession]);

  const handleExportText = useCallback(async (format: CoworkTextExportFormatValue) => {
    if (!currentSession || isExportingText) return;
    setIsExportingText(true);
    reportConversationNavigationAction({
      actionType: 'export_text_submit',
      params: {
        ...getConversationControlAnalyticsParams(),
        exportFormat: format,
      },
    });
    const timestamp = new Date().toISOString().slice(0, 10);
    const fileName = sanitizeExportFileName(`${currentSession.title}-${timestamp}.${format}`);
    try {
      const messages = await loadTextExportMessages();
      const content = format === CoworkTextExportFormat.Markdown
        ? buildCoworkSessionMarkdown(currentSession, messages, i18nService.t.bind(i18nService))
        : buildCoworkSessionJSON(currentSession, messages);
      const result = await window.electron.cowork.exportSessionText({
        content,
        defaultFileName: fileName,
        fileExtension: format,
      });
      if (result.success && !result.canceled) {
        reportConversationNavigationAction({
          actionType: 'export_text_result',
          params: {
            ...getConversationControlAnalyticsParams(),
            exportFormat: format,
            result: 'success',
          },
        });
        window.dispatchEvent(new CustomEvent('app:showToast', {
          detail: i18nService.t('coworkExportTextSuccess'),
        }));
      } else if (result.canceled) {
        reportConversationNavigationAction({
          actionType: 'export_text_result',
          params: {
            ...getConversationControlAnalyticsParams(),
            exportFormat: format,
            result: 'cancelled',
          },
        });
      } else if (!result.success) {
        throw new Error(result.error || 'Export failed');
      }
    } catch (error) {
      reportConversationNavigationAction({
        actionType: 'export_text_result',
        params: {
          ...getConversationControlAnalyticsParams(),
          exportFormat: format,
          result: 'failed',
        },
      });
      console.error('Failed to export session text:', error);
      window.dispatchEvent(new CustomEvent('app:showToast', {
        detail: i18nService.t('coworkExportTextFailed'),
      }));
    } finally {
      setIsExportingText(false);
    }
  }, [currentSession, getConversationControlAnalyticsParams, isExportingText, loadTextExportMessages]);

  const handleExportDiagnostics = useCallback(async () => {
    if (!currentSession?.id) return;
    reportConversationNavigationAction({
      actionType: 'export_diagnostics_submit',
      params: getConversationControlAnalyticsParams(),
    });

    const result = await coworkService.exportSessionDiagnostics({ sessionId: currentSession.id });
    const outcome = result.canceled ? 'cancelled' : result.success ? 'success' : 'failed';
    reportConversationNavigationAction({
      actionType: 'export_diagnostics_result',
      params: {
        ...getConversationControlAnalyticsParams(),
        result: outcome,
      },
    });
    if (result.canceled) return;

    window.dispatchEvent(new CustomEvent('app:showToast', {
      detail: result.success
        ? i18nService.t('coworkExportDiagnosticsSuccess')
        : result.error || i18nService.t('coworkExportDiagnosticsFailed'),
    }));
  }, [currentSession?.id, getConversationControlAnalyticsParams]);

  const handleShareClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!currentSession || isExportingImage) return;
    setIsExportingImage(true);
    reportConversationNavigationAction({
      actionType: 'export_image_submit',
      params: getConversationControlAnalyticsParams(),
    });

    window.requestAnimationFrame(() => {
      void (async () => {
        try {
          const scrollContainer = scrollContainerRef.current;
          if (!scrollContainer) {
            throw new Error('Capture target not found');
          }
          const initialScrollTop = scrollContainer.scrollTop;
          try {
            const scrollRect = domRectToCaptureRect(scrollContainer.getBoundingClientRect());
            if (scrollRect.width <= 0 || scrollRect.height <= 0) {
              throw new Error('Invalid capture area');
            }

            const scrollContentHeight = Math.max(scrollContainer.scrollHeight, scrollContainer.clientHeight);
            if (scrollContentHeight <= 0) {
              throw new Error('Invalid content height');
            }

            const toContentY = (viewportY: number): number => {
              const y = scrollContainer.scrollTop + (viewportY - scrollRect.y);
              return Math.max(0, Math.min(scrollContentHeight, y));
            };

            const userAnchors = scrollContainer.querySelectorAll<HTMLElement>('[data-export-role="user-message"]');
            const assistantAnchors = scrollContainer.querySelectorAll<HTMLElement>('[data-export-role="assistant-block"]');

            let contentStart = 0;
            let contentEnd = scrollContentHeight;

            if (userAnchors.length > 0) {
              contentStart = toContentY(userAnchors[0].getBoundingClientRect().top);
            } else if (assistantAnchors.length > 0) {
              contentStart = toContentY(assistantAnchors[0].getBoundingClientRect().top);
            }

            if (assistantAnchors.length > 0) {
              const lastAssistant = assistantAnchors[assistantAnchors.length - 1];
              contentEnd = toContentY(lastAssistant.getBoundingClientRect().bottom);
            } else if (userAnchors.length > 0) {
              const lastUser = userAnchors[userAnchors.length - 1];
              contentEnd = toContentY(lastUser.getBoundingClientRect().bottom);
            }

            const maxStart = Math.max(0, scrollContentHeight - 1);
            contentStart = Math.max(0, Math.min(maxStart, Math.round(contentStart)));
            contentEnd = Math.max(contentStart + 1, Math.min(scrollContentHeight, Math.round(contentEnd)));

            const outputHeight = contentEnd - contentStart;

            if (outputHeight > MAX_EXPORT_CANVAS_HEIGHT) {
              throw new Error(`Export image is too tall (${outputHeight}px)`);
            }

            const segmentsEstimate = Math.ceil(outputHeight / Math.max(1, scrollRect.height)) + 1;
            if (segmentsEstimate > MAX_EXPORT_SEGMENTS) {
              throw new Error('Export image is too long');
            }

            const canvas = document.createElement('canvas');
            canvas.width = scrollRect.width;
            canvas.height = outputHeight;
            const context = canvas.getContext('2d');
            if (!context) {
              throw new Error('Canvas context unavailable');
            }

            const captureAndLoad = async (rect: CaptureRect): Promise<HTMLImageElement> => {
              const chunk = await coworkService.captureSessionImageChunk({ rect });
              if (!chunk.success || !chunk.pngBase64) {
                throw new Error(chunk.error || 'Failed to capture image chunk');
              }
              return loadImageFromBase64(chunk.pngBase64);
            };

            scrollContainer.scrollTop = Math.min(contentStart, Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight));
            await waitForNextFrame();
            await waitForNextFrame();

            const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
            let contentOffset = contentStart;
            while (contentOffset < contentEnd) {
              const targetScrollTop = Math.min(contentOffset, maxScrollTop);
              scrollContainer.scrollTop = targetScrollTop;
              await waitForNextFrame();
              await waitForNextFrame();

              const chunkImage = await captureAndLoad(scrollRect);
              const sourceYOffset = Math.max(0, contentOffset - targetScrollTop);
              const drawableHeight = Math.min(scrollRect.height - sourceYOffset, contentEnd - contentOffset);
              if (drawableHeight <= 0) {
                throw new Error('Failed to stitch export image');
              }
              const scaleY = chunkImage.naturalHeight / scrollRect.height;
              const sourceYInImage = Math.max(0, Math.round(sourceYOffset * scaleY));
              const sourceHeightInImage = Math.max(1, Math.min(
                chunkImage.naturalHeight - sourceYInImage,
                Math.round(drawableHeight * scaleY),
              ));

              context.drawImage(
                chunkImage,
                0,
                sourceYInImage,
                chunkImage.naturalWidth,
                sourceHeightInImage,
                0,
                contentOffset - contentStart,
                scrollRect.width,
                drawableHeight,
              );

              contentOffset += drawableHeight;
            }

            // Compose final canvas with branded header and footer
            const finalCanvas = await composeExportCanvas(
              canvas,
              currentSession.title,
              currentSession.createdAt,
            );

            const pngDataUrl = finalCanvas.toDataURL('image/png');
            const base64Index = pngDataUrl.indexOf(',');
            if (base64Index < 0) {
              throw new Error('Failed to encode export image');
            }

            const timestamp = formatExportTimestamp(new Date());
            const saveResult = await coworkService.saveSessionResultImage({
              pngBase64: pngDataUrl.slice(base64Index + 1),
              defaultFileName: sanitizeExportFileName(`${currentSession.title}-${timestamp}.png`),
            });
            if (saveResult.success && !saveResult.canceled) {
              reportConversationNavigationAction({
                actionType: 'export_image_result',
                params: {
                  ...getConversationControlAnalyticsParams(),
                  result: 'success',
                },
              });
              window.dispatchEvent(new CustomEvent('app:showToast', {
                detail: i18nService.t('coworkExportImageSuccess'),
              }));
              return;
            }
            if (!saveResult.success) {
              throw new Error(saveResult.error || 'Failed to export image');
            }
            reportConversationNavigationAction({
              actionType: 'export_image_result',
              params: {
                ...getConversationControlAnalyticsParams(),
                result: 'cancelled',
              },
            });
          } finally {
            scrollContainer.scrollTop = initialScrollTop;
          }
        } catch (error) {
          reportConversationNavigationAction({
            actionType: 'export_image_result',
            params: {
              ...getConversationControlAnalyticsParams(),
              result: 'failed',
            },
          });
          console.error('Failed to export session image:', error);
          window.dispatchEvent(new CustomEvent('app:showToast', {
            detail: i18nService.t('coworkExportImageFailed'),
          }));
        } finally {
          setIsExportingImage(false);
        }
      })();
    });
  };

  const handleMessagesScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const isNearBottom = distanceToBottom <= AUTO_SCROLL_THRESHOLD;
    setShouldAutoScroll((prev) => (prev === isNearBottom ? prev : isNearBottom));
    if (scrollToBottomIntentRef.current && distanceToBottom <= SCROLL_TO_BOTTOM_SETTLE_THRESHOLD) {
      scrollToBottomIntentRef.current = false;
      clearScrollToBottomSettleTimers();
    }

    // Check if content overflows the container (use functional updater to avoid redundant re-renders)
    const scrollable = container.scrollHeight > container.clientHeight;
    setIsScrollable((prev) => (prev === scrollable ? prev : scrollable));
    if (!scrollable) return;

    // Load older messages when scrolled near the top
    if (container.scrollTop <= 80 && !isLoadingMoreMessagesRef.current) {
      const sessionId = currentSession?.id;
      const offset = currentSession?.messagesOffset ?? 0;
      if (sessionId && offset > 0) {
        isLoadingMoreMessagesRef.current = true;
        setIsLoadingMoreMessages(true);
        prevScrollHeightRef.current = container.scrollHeight;
        logDetailDiagnostic(`loading older messages after scrolling near the top for session ${sessionId}; current offset is ${offset}.`);
        coworkService.loadMoreMessages(sessionId).catch(() => {
          prevScrollHeightRef.current = null;
          isLoadingMoreMessagesRef.current = false;
          setIsLoadingMoreMessages(false);
        });
      }
    }


    // Skip index recalculation during programmatic navigation
    if (isNavigatingRef.current) return;

    // Use turn-level elements (always in DOM, even for lazy-rendered turns) for scroll detection
    const turnEls = turnElsCacheRef.current;
    const railCount = railItemCountRef.current;
    if (turnEls.length === 0 || railCount === 0) return;

    const loadedMessageCount = currentSession?.messages.length ?? 0;
    const loadedMessageOffset = currentSession?.messagesOffset ?? 0;
    const totalMessageCount = currentSession?.totalMessages ?? loadedMessageCount;
    const hasLoadedSessionEnd = loadedMessageOffset + loadedMessageCount >= totalMessageCount;

    // Only snap to the final rail item when the loaded window includes the real
    // session end. Middle windows can also reach their local bottom, and snapping
    // there would highlight the window's last rail item instead of the visible turn.
    if (hasLoadedSessionEnd && distanceToBottom <= NAV_BOTTOM_SNAP_THRESHOLD) {
      const lastRail = railCount - 1;
      if (currentRailIndexRef.current !== lastRail) {
        logRailNavigationDiagnostic(
          `rail highlight snapped to final item ${lastRail} at session bottom; offset=${loadedMessageOffset}; loaded=${loadedMessageCount}; total=${totalMessageCount}.`,
        );
        currentRailIndexRef.current = lastRail;
        setCurrentRailIndex(lastRail);
      }
      return;
    }

    // Find current turn based on turn element offsetTop
    const scrollTop = container.scrollTop;
    let currentTurn = 0;
    for (let i = 0; i < turnEls.length; i++) {
      if (turnEls[i].offsetTop <= scrollTop + 80) {
        currentTurn = i;
      } else {
        break;
      }
    }

    // Map turn to rail index: check if scrolled past the midpoint of the turn
    // (first half → user message = first rail item, second half → assistant = last rail item)
    const range = turnToRailRangeRef.current[currentTurn];
    if (!range) return;
    let railIdx = range.first;
    if (range.first !== range.last) {
      const turnEl = turnEls[currentTurn];
      const nextTurnTop = currentTurn + 1 < turnEls.length
        ? turnEls[currentTurn + 1].offsetTop
        : container.scrollHeight;
      const turnMid = turnEl.offsetTop + (nextTurnTop - turnEl.offsetTop) / 2;
      if (scrollTop + 80 >= turnMid) {
        railIdx = range.last;
      }
    }

    if (currentRailIndexRef.current !== railIdx) {
      currentRailIndexRef.current = railIdx;
      setCurrentRailIndex(railIdx);
    }
  }, [
    clearScrollToBottomSettleTimers,
    currentSession?.id,
    currentSession?.messages.length,
    currentSession?.messagesOffset,
    currentSession?.totalMessages,
  ]);

  const handleScrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const prefersReducedMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const scrollLogMessage = `Scroll to bottom requested for session ${currentSession?.id ?? 'unknown'}; distance was ${Math.max(0, Math.round(distanceToBottom))}px.`;
    console.debug(`[CoworkSessionDetail] ${scrollLogMessage}`);
    window.electron?.log?.fromRenderer?.('debug', 'CoworkSessionDetail', scrollLogMessage);
    reportConversationNavigationAction({
      actionType: 'scroll_to_bottom_click',
      params: {
        distanceToBottomBucket: bucketDistance(Math.max(0, distanceToBottom)),
        railItemCount: railItemCountRef.current,
        currentRailIndex: currentRailIndexRef.current,
        sessionMessageCountBucket: bucketCount(currentSession?.messages.length ?? 0),
        totalMessageCountBucket: bucketCount(currentSession?.totalMessages ?? currentSession?.messages.length ?? 0),
        isStreaming,
      },
    });
    clearScrollToBottomSettleTimers();
    scrollToBottomIntentRef.current = true;
    if (prefersReducedMotion) {
      setShouldAutoScroll(true);
    }
    container.scrollTo({
      top: container.scrollHeight,
      behavior: prefersReducedMotion ? 'auto' : 'smooth',
    });
    const lastRail = railItemCountRef.current > 0 ? railItemCountRef.current - 1 : -1;
    currentRailIndexRef.current = lastRail;
    setCurrentRailIndex(lastRail);
    SCROLL_TO_BOTTOM_SETTLE_DELAYS_MS.forEach((delayMs, index) => {
      const timer = setTimeout(() => {
        if (!scrollToBottomIntentRef.current) return;
        const latestContainer = scrollContainerRef.current;
        if (!latestContainer) return;
        const latestDistance = latestContainer.scrollHeight - latestContainer.scrollTop - latestContainer.clientHeight;
        if (latestDistance <= SCROLL_TO_BOTTOM_SETTLE_THRESHOLD) {
          scrollToBottomIntentRef.current = false;
          clearScrollToBottomSettleTimers();
          setShouldAutoScroll(true);
          return;
        }
        latestContainer.scrollTo({
          top: latestContainer.scrollHeight,
          behavior: prefersReducedMotion || index === SCROLL_TO_BOTTOM_SETTLE_DELAYS_MS.length - 1
            ? 'auto'
            : 'smooth',
        });
      }, delayMs);
      scrollToBottomSettleTimersRef.current.push(timer);
    });
  }, [clearScrollToBottomSettleTimers, currentSession?.id, currentSession?.messages.length, currentSession?.totalMessages, isStreaming]);

  const handleScrollToBottomWheel = useCallback((event: React.WheelEvent<HTMLButtonElement>) => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const deltaMultiplier = event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? WHEEL_DELTA_LINE_HEIGHT
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? container.clientHeight
        : 1;
    event.preventDefault();
    container.scrollBy({
      left: event.deltaX * deltaMultiplier,
      top: event.deltaY * deltaMultiplier,
      behavior: 'auto',
    });
  }, []);

  const handleRailWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    const container = railLinesRef.current;
    if (!container) return;

    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    if (maxScrollTop <= 1) return;

    const deltaMultiplier = event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? WHEEL_DELTA_LINE_HEIGHT
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? container.clientHeight
        : 1;
    const nextScrollTop = Math.max(
      0,
      Math.min(maxScrollTop, container.scrollTop + event.deltaY * deltaMultiplier),
    );
    if (nextScrollTop === container.scrollTop) return;

    event.stopPropagation();
    container.scrollTop = nextScrollTop;
  }, []);

  // Auto-load older messages if content doesn't fill the container (no scrollbar = onScroll never fires)
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || isLoadingMoreMessagesRef.current) return;
    const sessionId = currentSession?.id;
    const offset = currentSession?.messagesOffset ?? 0;
    if (!sessionId || offset <= 0) return;
    if (container.scrollHeight <= container.clientHeight) {
      isLoadingMoreMessagesRef.current = true;
      setIsLoadingMoreMessages(true);
      prevScrollHeightRef.current = container.scrollHeight;
      logDetailDiagnostic(
        `auto-loading older messages because session ${sessionId} content height ${container.scrollHeight} does not exceed viewport height ${container.clientHeight}; current offset is ${offset}.`,
      );
      coworkService.loadMoreMessages(sessionId).catch(() => {
        prevScrollHeightRef.current = null;
        isLoadingMoreMessagesRef.current = false;
        setIsLoadingMoreMessages(false);
      });
    }
  }, [currentSession?.id, currentSession?.messagesOffset, currentSession?.messages.length]);

  // Restore scroll position synchronously before browser paint when messages are prepended
  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || prevScrollHeightRef.current === null) return;
    const newScrollHeight = container.scrollHeight;
    container.scrollTop += newScrollHeight - prevScrollHeightRef.current;
    prevScrollHeightRef.current = null;
    isLoadingMoreMessagesRef.current = false;
    setIsLoadingMoreMessages(false);
    if (scrollToBottomIntentRef.current) {
      requestAnimationFrame(() => {
        const latestContainer = scrollContainerRef.current;
        if (!latestContainer || !scrollToBottomIntentRef.current) return;
        latestContainer.scrollTo({
          top: latestContainer.scrollHeight,
          behavior: 'auto',
        });
      });
    }
  }, [currentSession?.messages.length]);

  const navigateToRailItem = useCallback((
    railIndex: number,
    actionType: 'rail_item_click' | 'rail_prev_click' | 'rail_next_click' = 'rail_item_click',
  ) => {
    if (railIndex < 0 || railIndex >= railItemCountRef.current) return;
    const item = railItemsRef.current[railIndex];
    if (!item) return;

    reportConversationNavigationAction({
      actionType,
      params: {
        currentRailIndex: currentRailIndexRef.current,
        targetRailIndex: railIndex,
        railItemCount: railItemCountRef.current,
        sessionMessageCountBucket: bucketCount(currentSession?.messages.length ?? 0),
        totalMessageCountBucket: bucketCount(currentSession?.totalMessages ?? currentSession?.messages.length ?? 0),
        isStreaming,
      },
    });

    const isNavigatingToLastRailItem = railIndex >= railItemCountRef.current - 1;
    if (!isNavigatingToLastRailItem) {
      scrollToBottomIntentRef.current = false;
      setShouldAutoScroll(false);
    }

    const container = scrollContainerRef.current;
    const forceRenderRailTurn = (turnIndex: number): void => {
      if (turnIndex < 0) return;
      setForcedRailTurnIndex(turnIndex);
      if (forcedRailTurnReleaseTimerRef.current) {
        clearTimeout(forcedRailTurnReleaseTimerRef.current);
      }
      forcedRailTurnReleaseTimerRef.current = setTimeout(() => {
        forcedRailTurnReleaseTimerRef.current = null;
        setForcedRailTurnIndex(current => (current === turnIndex ? null : current));
      }, RAIL_TARGET_RENDER_RELEASE_DELAY);
    };

    const scrollToRailTarget = (targetRailIndex: number, targetItem: RailItem, requireMessageTarget = false): boolean => {
      const latestContainer = scrollContainerRef.current;
      if (!latestContainer) return false;

      const messageEl = targetItem.messageId
        ? latestContainer.querySelector<HTMLElement>(`[data-rail-message-id="${CSS.escape(targetItem.messageId)}"]`)
        : null;
      if (messageEl) {
        const decision = getRailNavigationDecision(latestContainer, messageEl);
        if (decision.behavior === 'auto') {
          logRailNavigationDiagnostic(
            `rail navigation used instant scroll for item ${targetRailIndex}; reason=${decision.reason}; distance=${Math.round(decision.distance)}px; threshold=${Math.round(decision.threshold)}px.`,
          );
        }
        messageEl.scrollIntoView({ behavior: decision.behavior, block: 'start' });
        return true;
      }

      if (requireMessageTarget) {
        return false;
      }

      const el = messageEl
        ?? latestContainer.querySelector<HTMLElement>(`[data-rail-index="${targetRailIndex}"]`);
      if (el) {
        const decision = getRailNavigationDecision(latestContainer, el);
        if (decision.behavior === 'auto') {
          logRailNavigationDiagnostic(
            `rail navigation used instant scroll for item ${targetRailIndex}; reason=${decision.reason}; distance=${Math.round(decision.distance)}px; threshold=${Math.round(decision.threshold)}px.`,
          );
        }
        el.scrollIntoView({ behavior: decision.behavior, block: 'start' });
        return true;
      }

      const targetTurnIdx = targetItem.turnIndex;
      if (targetTurnIdx >= 0) {
        // Fallback: scroll to the turn element (always in DOM)
        const turnEls = turnElsCacheRef.current;
        if (targetTurnIdx < turnEls.length) {
          const targetEl = turnEls[targetTurnIdx];
          const decision = getRailNavigationDecision(latestContainer, targetEl);
          if (decision.behavior === 'auto') {
            logRailNavigationDiagnostic(
              `rail navigation used instant fallback scroll for item ${targetRailIndex}; reason=${decision.reason}; distance=${Math.round(decision.distance)}px; threshold=${Math.round(decision.threshold)}px.`,
            );
          }
          targetEl.scrollIntoView({ behavior: decision.behavior, block: 'start' });
          return true;
        } else {
          logRailNavigationDiagnostic(`rail navigation skipped item ${targetRailIndex} because target turn ${targetTurnIdx} is not mounted.`);
        }
      } else {
        logRailNavigationDiagnostic(`rail navigation skipped item ${targetRailIndex} because no loaded target was found.`);
      }
      return false;
    };

    const scrollToRenderedRailTarget = (targetRailIndex: number, fallbackItem: RailItem, attempt = 0): void => {
      const latestRailItems = railItemsRef.current;
      const latestItem = latestRailItems[targetRailIndex] ?? fallbackItem;
      if (latestItem.turnIndex >= 0) {
        forceRenderRailTurn(latestItem.turnIndex);
      }

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (scrollToRailTarget(targetRailIndex, latestItem, true)) return;
          if (attempt < RAIL_TARGET_SCROLL_RETRY_LIMIT) {
            scrollToRenderedRailTarget(targetRailIndex, latestItem, attempt + 1);
            return;
          }
          logRailNavigationDiagnostic(
            `rail navigation could not find rendered message for item ${targetRailIndex} after ${attempt + 1} attempts; falling back to turn container.`,
          );
          scrollToRailTarget(targetRailIndex, latestItem);
        });
      });
    };

    isNavigatingRef.current = true;
    if (navigatingTimerRef.current) clearTimeout(navigatingTimerRef.current);
    navigatingTimerRef.current = setTimeout(() => { isNavigatingRef.current = false; }, NAV_SCROLL_LOCK_DURATION);

    if (container && scrollToRailTarget(railIndex, item, true)) {
      currentRailIndexRef.current = railIndex;
      setCurrentRailIndex(railIndex);
      return;
    }

    if (container && item.turnIndex >= 0) {
      scrollToRenderedRailTarget(railIndex, item);
      currentRailIndexRef.current = railIndex;
      setCurrentRailIndex(railIndex);
      return;
    }

    if (container && scrollToRailTarget(railIndex, item)) {
      currentRailIndexRef.current = railIndex;
      setCurrentRailIndex(railIndex);
      return;
    }

    if (!currentSession?.id || isLoadingRailTargetRef.current) return;

    isLoadingRailTargetRef.current = true;
    void coworkService.loadMessageWindowAroundIndex(currentSession.id, item.absoluteIndex).then((loaded) => {
      if (!loaded) return;
      scrollToRenderedRailTarget(railIndex, item);
    }).finally(() => {
      isLoadingRailTargetRef.current = false;
    });

    currentRailIndexRef.current = railIndex;
    setCurrentRailIndex(railIndex);
  }, [currentSession?.id, currentSession?.messages.length, currentSession?.totalMessages, isStreaming]);

  // lastMessageContent and messagesLength are now sourced from memoized
  // selectors (selectLastMessageContent / selectCurrentMessagesLength)
  // so there is no need to derive them from currentSession here.

  const resolveLocalFilePath = useCallback((href: string, text: string) => {
    const hrefValue = typeof href === 'string' ? href.trim() : '';
    const textValue = typeof text === 'string' ? text.trim() : '';
    if (!hrefValue && !textValue) return null;

    const hrefRootRelative = hrefValue ? parseRootRelativePath(hrefValue) : null;
    if (hrefRootRelative) {
      return hrefRootRelative;
    }

    const hrefPath = hrefValue ? normalizeLocalPath(hrefValue) : null;
    if (hrefPath) {
      if (hrefPath.isRelative && currentSession?.cwd) {
        return toAbsolutePathFromCwd(hrefPath.path, currentSession.cwd);
      }
      if (hrefPath.isAbsolute) {
        return hrefPath.path;
      }
    }

    const textRootRelative = textValue ? parseRootRelativePath(textValue) : null;
    if (textRootRelative) {
      return textRootRelative;
    }

    const textPath = textValue ? normalizeLocalPath(textValue) : null;
    if (textPath) {
      if (textPath.isRelative && currentSession?.cwd) {
        return toAbsolutePathFromCwd(textPath.path, currentSession.cwd);
      }
      if (textPath.isAbsolute) {
        return textPath.path;
      }
    }

    return null;
  }, [currentSession?.cwd]);

  const mapDisplayText = useCallback((value: string): string => {
    return value;
  }, []);

  const handleReEdit = useCallback((message: CoworkMessage) => {
    const ref = promptInputRef.current;
    if (!ref) return;
    void (async () => {
      const metadata = message.metadata as CoworkMessageMetadata | undefined;
      const imagePreviews = Array.isArray(metadata?.imageAttachmentPreviews)
        ? metadata.imageAttachmentPreviews as CoworkImageAttachmentPreview[]
        : [];
      let imageAttachments = ((metadata?.imageAttachments ?? []) as CoworkImageAttachment[]);

      if (imagePreviews.length > 0 && imageAttachments.length === 0) {
        const restoredImages: CoworkImageAttachment[] = [];
        for (const preview of imagePreviews) {
          if (!preview.localPath) {
            showToast(i18nService.t('coworkImageAttachmentOriginalMissing'));
            return;
          }
          try {
            const readResult = await window.electron.dialog.readFileAsDataUrl(preview.localPath);
            if (!readResult.success || !readResult.dataUrl) {
              showToast(i18nService.t('coworkImageAttachmentOriginalMissing'));
              return;
            }
            const extracted = extractBase64FromDataUrl(readResult.dataUrl);
            if (!extracted) {
              showToast(i18nService.t('coworkImageAttachmentOriginalMissing'));
              return;
            }
            restoredImages.push({
              name: preview.name,
              mimeType: extracted.mimeType,
              base64Data: extracted.base64Data,
              localPath: preview.localPath,
            });
          } catch (error) {
            console.warn('[CoworkSessionDetail] failed to restore image attachment for re-edit:', error);
            showToast(i18nService.t('coworkImageAttachmentOriginalMissing'));
            return;
          }
        }
        imageAttachments = restoredImages;
      }

      // Set text content
      if (message.content?.trim()) {
        ref.setValue(message.content);
      }
      // Restore image attachments (always call to clear previous attachments)
      ref.setImageAttachments(imageAttachments);
      const selectedTextSnippets = (metadata?.selectedTextSnippets ?? []) as CoworkSelectedTextSnippet[];
      ref.setSelectedTextSnippets(selectedTextSnippets);
      // Restore active skills
      const skillIds = metadata?.skillIds ?? [];
      dispatch(setActiveSkillIds(skillIds));
      const kitIds = metadata?.kitIds ?? [];
      dispatch(setActiveKitIds(kitIds));
      // Focus the input
      ref.focus();
    })();
  }, [dispatch]);

  const handleBrowserAnnotationCaptured = useCallback((payload: BrowserAnnotationPayload) => {
    promptInputRef.current?.insertBrowserAnnotation(payload);
  }, []);

  const messages = currentSession?.messages;
  const displayItems = useMemo(() => messages ? buildDisplayItems(messages) : [], [messages]);
  const turns = useMemo(() => buildConversationTurns(displayItems), [displayItems]);
  const latestAssistantTurn = useMemo(() => findLatestAssistantTurn(turns), [turns]);
  const loadedRailTurnMap = useMemo(() => buildLoadedRailTurnMap(turns), [turns]);
  const messageOffsetById = useMemo(() => {
    const offsetById = new Map<string, number>();
    const sessionMessages = currentSession?.messages ?? [];
    const messagesOffset = currentSession?.messagesOffset ?? 0;
    sessionMessages.forEach((message, index) => {
      offsetById.set(message.id, messagesOffset + index);
    });
    return offsetById;
  }, [currentSession?.messages, currentSession?.messagesOffset]);
  const localRailItems = useMemo(() => buildRailItems(turns, messageOffsetById), [messageOffsetById, turns]);
  const railItems = useMemo(
    () => (messageRailIndex.length > 0
      ? buildRailItemsFromIndex(messageRailIndex, loadedRailTurnMap)
      : buildPlaceholderRailItems(
        currentSession?.totalMessages ?? localRailItems.length,
        localRailItems,
      )),
    [
      currentSession?.totalMessages,
      loadedRailTurnMap,
      localRailItems,
      messageRailIndex,
    ],
  );
  const railTooltipItem = railTooltip ? railItems[railTooltip.railIndex] : undefined;
  const railTooltipTitle = railTooltipItem
    ? railTooltipItem.isPlaceholder
      ? i18nService.t('coworkRailUnloadedMessageTitle')
      : railTooltipItem.label
    : '';
  const railTooltipSummary = railTooltipItem
    ? railTooltipItem.isPlaceholder
      ? i18nService.t('coworkRailUnloadedMessageHint')
      : railTooltipItem.summary
    : '';

  useEffect(() => {
    const previousSessionId = previousAutoPreviewSessionIdRef.current;
    const sessionChanged = previousSessionId !== sessionId;
    const wasStreaming = previousAutoPreviewStreamingRef.current;
    const previousMessagesLength = previousAutoPreviewMessagesLengthRef.current;
    const previousLatestTurnId = previousAutoPreviewLatestTurnIdRef.current;
    const latestTurnId = latestAssistantTurn?.id ?? null;

    previousAutoPreviewSessionIdRef.current = sessionId;
    previousAutoPreviewStreamingRef.current = isStreaming;
    previousAutoPreviewMessagesLengthRef.current = messagesLength;
    previousAutoPreviewLatestTurnIdRef.current = latestTurnId;

    if (sessionChanged) {
      clearAutoPreviewArtifactSettleTimer();
      setAutoPreviewPendingTurnId(null);
      return;
    }

    if (!sessionId || !latestAssistantTurn) {
      clearAutoPreviewArtifactSettleTimer();
      setAutoPreviewPendingTurnId(null);
      return;
    }

    const completedStreamingTurn = wasStreaming && !isStreaming;
    const latestTurnChanged = latestTurnId !== null && latestTurnId !== previousLatestTurnId;
    const appendedCompletedTurn = !isStreaming && messagesLength > previousMessagesLength && latestTurnChanged;
    if (!completedStreamingTurn && !appendedCompletedTurn) return;

    if (getAutoPreviewHandledTurnIds(sessionId).has(latestAssistantTurn.id)) return;
    setCurrentAutoPreviewPendingTurnId(latestAssistantTurn.id);
  }, [
    clearAutoPreviewArtifactSettleTimer,
    getAutoPreviewHandledTurnIds,
    isStreaming,
    latestAssistantTurn,
    messagesLength,
    sessionId,
    setCurrentAutoPreviewPendingTurnId,
  ]);

  useEffect(() => {
    if (!sessionId || !autoPreviewPendingTurnId || !currentSession) return;
    if (getAutoPreviewHandledTurnIds(sessionId).has(autoPreviewPendingTurnId)) {
      clearAutoPreviewArtifactSettleTimer();
      setCurrentAutoPreviewPendingTurnId(null);
      return;
    }

    const pendingTurn = turns.find(turn => turn.id === autoPreviewPendingTurnId);
    if (!pendingTurn) return;

    if (isPanelOpen) {
      markAutoPreviewTurnHandled(sessionId, autoPreviewPendingTurnId);
      return;
    }

    const turnMessageIds = getTurnMessageIds(pendingTurn);
    const turnArtifacts = rawSessionArtifacts.filter(
      artifact => turnMessageIds.has(artifact.messageId) && PREVIEWABLE_ARTIFACT_TYPES.has(artifact.type),
    );
    const artifact = selectAutoPreviewArtifact(
      turnArtifacts,
      { defaultProjectDirectory: currentSession.cwd },
    );
    if (!artifact) return;

    clearAutoPreviewArtifactSettleTimer();
    autoPreviewArtifactSettleTimerRef.current = window.setTimeout(() => {
      autoPreviewArtifactSettleTimerRef.current = null;
      if (getAutoPreviewHandledTurnIds(sessionId).has(autoPreviewPendingTurnId)) return;

      switch (getAutoPreviewOpenTarget(artifact)) {
        case ArtifactAutoPreviewOpenTarget.LocalServiceBrowser:
          handleOpenLocalServiceArtifact(artifact);
          break;
        case ArtifactAutoPreviewOpenTarget.HtmlBrowser:
          void handleOpenHtmlFileInBrowser(artifact);
          break;
        case ArtifactAutoPreviewOpenTarget.PreviewTab:
          dispatch(openArtifactPreviewTab({ sessionId, artifactId: artifact.id }));
          break;
        default:
          return;
      }

      markAutoPreviewTurnHandled(sessionId, autoPreviewPendingTurnId);
    }, AUTO_PREVIEW_ARTIFACT_SETTLE_MS);

    return clearAutoPreviewArtifactSettleTimer;
  }, [
    autoPreviewPendingTurnId,
    clearAutoPreviewArtifactSettleTimer,
    currentSession,
    dispatch,
    getAutoPreviewHandledTurnIds,
    handleOpenHtmlFileInBrowser,
    handleOpenLocalServiceArtifact,
    isPanelOpen,
    markAutoPreviewTurnHandled,
    rawSessionArtifacts,
    sessionId,
    setCurrentAutoPreviewPendingTurnId,
    turns,
  ]);

  // Cache turn-level DOM elements (data-turn-index, always in DOM even for lazy turns)
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) { turnElsCacheRef.current = []; return; }
    turnElsCacheRef.current = Array.from(
      container.querySelectorAll<HTMLElement>('[data-turn-index]')
    );
  }, [turns]);

  useLayoutEffect(() => {
    railItemsRef.current = railItems;
    railItemCountRef.current = railItems.length;
    turnToRailRangeRef.current = buildTurnToRailRange(railItems);
    const loadedIndices = railItems
      .map((item, index) => (item.isLoaded ? index : -1))
      .filter(index => index >= 0);
    loadedRailRangeRef.current = loadedIndices.length > 0
      ? { first: loadedIndices[0], last: loadedIndices[loadedIndices.length - 1] }
      : null;
  }, [railItems]);

  // Sync rail index when turns change or rail first appears (isScrollable becomes true)
  useEffect(() => {
    // After turns/scrollable change, if rail index is uninitialized (-1) or out of bounds,
    // wait for next frame so render IIFE has updated railItemCountRef, then sync
    const frameId = requestAnimationFrame(() => {
      const count = railItemCountRef.current;
      if (count === 0) return;
      const idx = currentRailIndexRef.current;
      if (idx < 0 || idx >= count) {
        const resolved = count - 1;
        currentRailIndexRef.current = resolved;
        setCurrentRailIndex(resolved);
      }
    });
    return () => cancelAnimationFrame(frameId);
  }, [isScrollable, railItems.length, turns]);

  const alignActiveRailItem = useCallback(() => {
    const container = railLinesRef.current;
    if (!container || currentRailIndex < 0) return;
    const activeEl = container.children[currentRailIndex] as HTMLElement | undefined;
    if (!activeEl) return;

    if (currentRailIndex <= 0) {
      container.scrollTop = 0;
      return;
    }
    if (currentRailIndex >= railItemCountRef.current - 1) {
      container.scrollTop = container.scrollHeight;
      return;
    }

    // Use viewport-relative rects instead of offsetTop: the rail list is an
    // overflow container whose layout can change after lazy pagination prepends.
    const containerRect = container.getBoundingClientRect();
    const activeRect = activeEl.getBoundingClientRect();
    if (activeRect.top < containerRect.top) {
      container.scrollTop -= containerRect.top - activeRect.top;
    } else if (activeRect.bottom > containerRect.bottom) {
      container.scrollTop += activeRect.bottom - containerRect.bottom;
    }
  }, [currentRailIndex]);

  // Scroll rail lines container to keep active item visible (without affecting page scroll)
  useEffect(() => {
    let secondFrameId: number | null = null;
    const firstFrameId = requestAnimationFrame(() => {
      alignActiveRailItem();
      secondFrameId = requestAnimationFrame(() => {
        alignActiveRailItem();
      });
    });
    return () => {
      cancelAnimationFrame(firstFrameId);
      if (secondFrameId !== null) cancelAnimationFrame(secondFrameId);
    };
  }, [
    alignActiveRailItem,
    currentSession?.messages.length,
    currentSession?.messagesOffset,
    isScrollable,
    railItems.length,
  ]);

  // Auto scroll to bottom when new messages arrive or content updates (streaming)
  useEffect(() => {
    if (isNavigatingRef.current) {
      return;
    }
    if (!shouldAutoScroll) {
      return;
    }
    const container = scrollContainerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
      setIsScrollable(container.scrollHeight > container.clientHeight);
    }
    // Sync rail index to last when auto-scrolled to bottom
    if (turns.length > 0) {
      // Use -1 when rail hasn't rendered yet (count is 0),
      // so the render IIFE resolvedRailIndex fallback picks the last item
      const lastRail = railItemCountRef.current > 0 ? railItemCountRef.current - 1 : -1;
      currentRailIndexRef.current = lastRail;
      setCurrentRailIndex(lastRail);
    }
  }, [messagesLength, lastMessageContent, isContextCompacting, isStreaming, shouldAutoScroll, turns.length]);


  if (!currentSession) {
    return null;
  }

  const defaultArtifactPanelContentWidth = Math.max(
    artifactPanelMinWidth,
    Math.min(panelWidth, artifactPanelMaxWidth),
  );
  const expandedArtifactPanelContentWidth = Math.max(
    MIN_PANEL_WIDTH,
    contentRowWidth - ARTIFACT_PANEL_RESIZE_HANDLE_WIDTH,
  );
  const artifactPanelContentWidth = isArtifactPanelExpanded
    ? expandedArtifactPanelContentWidth
    : defaultArtifactPanelContentWidth;
  const artifactPanelFrameWidth = isArtifactPanelVisible
    ? artifactPanelContentWidth + ARTIFACT_PANEL_RESIZE_HANDLE_WIDTH
    : 0;
  const artifactHeaderWidth = isArtifactPanelVisible
    ? isArtifactPanelExpanded && contentRowWidth > 0
      ? contentRowWidth
      : Math.max(0, artifactPanelFrameWidth - ARTIFACT_PANEL_RESIZE_HANDLE_WIDTH)
    : undefined;
  const artifactPanelRenderMinWidth = isArtifactPanelExpanded
    ? expandedArtifactPanelContentWidth
    : artifactPanelMinWidth;
  const artifactPanelRenderMaxWidth = isArtifactPanelExpanded
    ? expandedArtifactPanelContentWidth
    : artifactPanelMaxWidth;
  const artifactPanelIsOverlay = isArtifactPanelVisible && isArtifactPanelExpanded;
  const artifactPanelOverlayBottom = artifactPanelIsOverlay && !isExpandedPromptInputHidden
    ? promptInputAreaHeight
    : 0;
  const artifactPanelInnerWidth = artifactPanelIsOverlay ? '100%' : artifactPanelFrameWidth;
  const shouldShowTurnNavigationRail = railItems.length > 1 && isScrollable;
  const shouldShowScrollToBottom = isScrollable && !shouldAutoScroll;
  const expandedConversationPreview = getExpandedConversationPreview(currentSession.messages);
  const resolvedRailIndex = currentRailIndex < 0 || currentRailIndex >= railItems.length
    ? railItems.length - 1
    : currentRailIndex;
  const planConfirmationMessageId = (
    latestProposedPlan
    && draftCollaborationMode === CoworkCollaborationMode.Plan
    && !isSessionBusy
    && planConfirmation?.state === PlanConfirmationState.Awaiting
    && planConfirmation.messageId === latestProposedPlan.messageId
    && planConfirmation.planTextHash === latestProposedPlan.planTextHash
  )
    ? latestProposedPlan.messageId
    : null;

  const renderConversationTurns = () => {
    let railCounter = 0;
    if (turns.length === 0) {
      if (!isStreaming) return null;
      return (
        <div data-export-role="assistant-block">
          <AssistantTurnBlock
            turn={{
              id: 'streaming-only',
              userMessage: null,
              assistantItems: [],
            }}
            resolveLocalFilePath={resolveLocalFilePath}
            localServiceDirectory={currentSession?.cwd}
            showTypingIndicator
            showCopyButtons={!isStreaming}
            completedGoal={
              currentSession.goal?.status === CoworkGoalStatus.Complete
                ? currentSession.goal
                : null
            }
            planConfirmationMessageId={planConfirmationMessageId}
            onConfirmPlan={handleConfirmPlan}
            onAdjustPlan={handleAdjustPlan}
          />
        </div>
      );
    }

    return turns.map((turn, index) => {
      const isLastTurn = index === turns.length - 1;
      const showTypingIndicator = isStreaming && isLastTurn && !hasRenderableAssistantContent(turn);
      const showAssistantBlock = turn.assistantItems.length > 0 || showTypingIndicator;
      // Always render last 3 turns (needed for streaming, auto-scroll, and smooth UX)
      const alwaysRender = index >= turns.length - 3 || index === forcedRailTurnIndex;

      // Compute one rail index per conversation turn (must match grouped rail item logic).
      const hasAssistantContent = turn.assistantItems.some(
        item => item.type === 'assistant' && isAssistantRailContentMessage(item.message),
      );
      const turnRailIdx = turn.userMessage || hasAssistantContent ? railCounter++ : -1;
      const assistantRailMessageId = getAssistantRailMessageId(turn);

      const turnMessageIds = getTurnMessageIds(turn);
      const turnArtifacts = rawSessionArtifacts.filter(
        a => turnMessageIds.has(a.messageId) && PREVIEWABLE_ARTIFACT_TYPES.has(a.type)
      );

      return (
        <LazyRenderTurn key={turn.id} turnId={turn.id} alwaysRender={alwaysRender} data-turn-index={index}>
          {turn.userMessage && (
            <div
              data-export-role="user-message"
              data-rail-message-id={turn.userMessage.id}
              className={isLastTurn ? 'animate-message-in' : undefined}
              {...(turnRailIdx >= 0 ? { 'data-rail-index': turnRailIdx } : undefined)}
            >
              <UserMessageItem
                message={turn.userMessage}
                skills={skills}
                marketplaceKits={marketplaceKits}
                onReEdit={remoteManaged ? undefined : handleReEdit}
                onLocateSelectedText={handleLocateSelectedText}
              />
            </div>
          )}
          {showAssistantBlock && (
            <div
              data-export-role="assistant-block"
              {...(assistantRailMessageId ? { 'data-rail-message-id': assistantRailMessageId } : undefined)}
              className={isLastTurn ? 'animate-message-in' : undefined}
              {...(turnRailIdx >= 0 ? { 'data-rail-index': turnRailIdx } : undefined)}
            >
              <AssistantTurnBlock
                turn={turn}
                artifacts={turnArtifacts}
                resolveLocalFilePath={resolveLocalFilePath}
                mapDisplayText={mapDisplayText}
                localServiceDirectory={currentSession?.cwd}
                onOpenLocalService={handleOpenLocalServiceArtifact}
                onOpenHtmlFile={handleOpenHtmlFileInBrowser}
                onForkMessage={remoteManaged ? undefined : handleForkMessage}
                renderToolGroupFooter={(group) => {
                  const groupSubagents = getToolGroupSubagents(group);
                  if (groupSubagents.length === 0) return null;
                  return (
                    <SubagentTurnLinks
                      subagents={groupSubagents}
                      variant="tool"
                      onSelectSubagent={handleSelectSubagent}
                    />
                  );
                }}
                showTypingIndicator={showTypingIndicator}
                showCopyButtons={!isStreaming || !isLastTurn}
                completedGoal={
                  isLastTurn && currentSession.goal?.status === CoworkGoalStatus.Complete
                    ? currentSession.goal
                    : null
                }
                planConfirmationMessageId={planConfirmationMessageId}
                onConfirmPlan={handleConfirmPlan}
                onAdjustPlan={handleAdjustPlan}
              />
            </div>
          )}
        </LazyRenderTurn>
      );
    });
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden">
      {/* Header — spans full width */}
      <div className={`draggable flex h-12 items-center justify-between border-b border-border bg-background shrink-0 ${
        isArtifactPanelExpanded ? 'pl-0 pr-4' : 'px-4'
      }`}
      >
        {/* Left side: Toggle buttons (when collapsed) + Title */}
        <div className="flex h-full flex-1 items-center gap-2 min-w-0">
          {isSidebarCollapsed && (
            <div className={`non-draggable flex items-center gap-1 ${isMac ? 'pl-[68px]' : ''}`}>
              <button
                type="button"
                onClick={onToggleSidebar}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-secondary hover:bg-surface-raised transition-colors"
              >
                <SidebarToggleIcon className="h-4 w-4" isCollapsed={true} />
              </button>
              <button
                type="button"
                onClick={onNewChat}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-secondary hover:bg-surface-raised transition-colors"
              >
                <ComposeIcon className="h-4 w-4" />
              </button>
              {updateBadge}
            </div>
          )}
          <h1 className="text-sm leading-none font-medium text-foreground truncate max-w-[360px]">
            {getSessionTitleForDisplay(currentSession.title) || i18nService.t('coworkNewSession')}
          </h1>
        </div>

        {/* Right side: Artifact toggle */}
        <div
          className={`flex h-full shrink-0 items-center gap-1 ${
            isArtifactPanelVisible
              ? isArtifactPanelExpanded
                ? '-mr-4 pr-4'
                : '-mr-4 border-l border-border pr-4'
              : ''
          }`}
          style={artifactHeaderWidth !== undefined ? { width: artifactHeaderWidth } : undefined}
        >
          {isArtifactPanelVisible && (
            <div className="flex h-full min-w-0 flex-1 items-center">
              <div className="relative flex h-full min-w-0 flex-1">
                <div
                  ref={artifactTabsScrollRef}
                  className="scrollbar-hidden flex h-full min-w-0 flex-1 overflow-x-auto overflow-y-hidden"
                >
                  <div className={`flex h-full min-w-max items-center gap-1 pr-3 ${
                    isArtifactPanelExpanded ? 'pl-3' : 'pl-4'
                  }`}
                  >
                  {isFileListPreviewTabOpen && (
                    <div
                      data-artifact-preview-active={
                        !activeArtifactPreviewTab && activeSpecialPreviewTab === ArtifactSpecialTab.FileList
                          ? 'true'
                          : undefined
                      }
                      className={`non-draggable group flex h-7 max-w-[190px] items-center rounded-lg text-xs transition-colors ${
                        activeArtifactPreviewTab || activeSpecialPreviewTab !== ArtifactSpecialTab.FileList
                          ? 'text-secondary hover:bg-surface hover:text-foreground'
                          : 'bg-surface-raised text-foreground shadow-sm'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={handleActivateArtifactFileListTab}
                        className="flex min-w-0 items-center gap-1.5 px-2 text-left"
                        title={i18nService.t('artifactFileList')}
                      >
                        <ArtifactPanelIcon className="h-3.5 w-3.5 shrink-0" open />
                        <span className="truncate">{i18nService.t('artifactFileList')}</span>
                      </button>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleCloseArtifactFileListTab();
                        }}
                        className={artifactTabCloseButtonClassName}
                        title={i18nService.t('artifactCloseTab')}
                      >
                        <ArtifactTabCloseIcon className="h-2.5 w-2.5" />
                      </button>
                    </div>
                  )}
                  {isBrowserPreviewTabOpen && (
                    <div
                      data-artifact-preview-active={
                        !activeArtifactPreviewTab && activeSpecialPreviewTab === ArtifactSpecialTab.Browser
                          ? 'true'
                          : undefined
                      }
                      className={`non-draggable group flex h-7 max-w-[190px] items-center rounded-lg text-xs transition-colors ${
                        activeArtifactPreviewTab || activeSpecialPreviewTab !== ArtifactSpecialTab.Browser
                          ? 'text-secondary hover:bg-surface hover:text-foreground'
                          : 'bg-surface-raised text-foreground shadow-sm'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={handleActivateArtifactBrowserTab}
                        className="flex min-w-0 items-center gap-1.5 px-2 text-left"
                        title={browserPreviewTabTitle}
                      >
                        <ArtifactBrowserTabIcon className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{browserPreviewTabTitle}</span>
                      </button>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleCloseArtifactBrowserTab();
                        }}
                        className={artifactTabCloseButtonClassName}
                        title={i18nService.t('artifactCloseTab')}
                      >
                        <ArtifactTabCloseIcon className="h-2.5 w-2.5" />
                      </button>
                    </div>
                  )}
                  {isSubagentPreviewTabOpen && (
                    <div
                      data-artifact-preview-active={
                        !activeArtifactPreviewTab && activeSpecialPreviewTab === ArtifactSpecialTab.Subagents
                          ? 'true'
                          : undefined
                      }
                      className={`non-draggable group flex h-7 max-w-[190px] items-center rounded-lg text-xs transition-colors ${
                        activeArtifactPreviewTab || activeSpecialPreviewTab !== ArtifactSpecialTab.Subagents
                          ? 'text-secondary hover:bg-surface hover:text-foreground'
                          : 'bg-surface-raised text-foreground shadow-sm'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={handleActivateArtifactSubagentTab}
                        className="flex min-w-0 items-center gap-1.5 px-2 text-left"
                        title={i18nService.t('subagentPanelTitle')}
                      >
                        <SubagentIcon className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{i18nService.t('subagentPanelTitle')}</span>
                      </button>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleCloseArtifactSubagentTab();
                        }}
                        className={artifactTabCloseButtonClassName}
                        title={i18nService.t('artifactCloseTab')}
                      >
                        <ArtifactTabCloseIcon className="h-2.5 w-2.5" />
                      </button>
                    </div>
                  )}
                  {artifactTabsWithArtifacts.map(({ tab, artifact }) => {
                    const isActive = tab.id === activeArtifactPreviewTab?.id;
                    const fileName = artifact.fileName || artifact.title;
                    return (
                      <div
                        key={tab.id}
                        data-artifact-preview-active={isActive ? 'true' : undefined}
                        className={`non-draggable group flex h-7 max-w-[190px] shrink-0 items-center rounded-lg text-xs transition-colors ${
                          isActive
                            ? 'bg-surface-raised text-foreground shadow-sm'
                            : 'text-secondary hover:bg-surface hover:text-foreground'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => handleActivateArtifactTab(tab.id)}
                          className="flex min-w-0 max-w-[158px] items-center gap-1.5 px-2 text-left"
                          title={fileName}
                        >
                          <FileTypeIcon fileName={fileName} className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate">{fileName}</span>
                        </button>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            handleCloseArtifactTab(tab.id);
                          }}
                          className={artifactTabCloseButtonClassName}
                          title={i18nService.t('artifactCloseTab')}
                        >
                          <ArtifactTabCloseIcon className="h-2.5 w-2.5" />
                        </button>
                      </div>
                    );
                  })}
                  {shouldPinArtifactAddTab ? (
                    <div className="h-full w-9 shrink-0" aria-hidden="true" />
                  ) : (
                    <div className="z-20 flex h-full shrink-0 items-center bg-background pl-1 pr-1">
                      <button
                        ref={artifactAddButtonRef}
                        type="button"
                        onClick={handleToggleArtifactAddMenu}
                        className={`non-draggable inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface hover:text-foreground ${
                          showArtifactAddMenu ? 'bg-surface text-foreground' : ''
                        }`}
                        aria-label={i18nService.t('artifactAddTab')}
                        title={i18nService.t('artifactAddTab')}
                      >
                        <ArtifactTabPlusIcon className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                  </div>
                </div>
                {shouldPinArtifactAddTab && (
                  <div className="absolute inset-y-0 right-0 z-20 flex items-center bg-background pl-1 pr-1">
                    <button
                      ref={artifactAddButtonRef}
                      type="button"
                      onClick={handleToggleArtifactAddMenu}
                      className={`non-draggable inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-surface hover:text-foreground ${
                        showArtifactAddMenu ? 'bg-surface text-foreground' : ''
                      }`}
                      aria-label={i18nService.t('artifactAddTab')}
                      title={i18nService.t('artifactAddTab')}
                    >
                      <ArtifactTabPlusIcon className="h-4 w-4" />
                    </button>
                  </div>
                )}
                {(artifactTabsCanScrollLeft || artifactTabsCanScrollRight) && (
                  <>
                    {artifactTabsCanScrollLeft && (
                      <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-12 bg-gradient-to-r from-background from-[34%] via-background/80 via-[66%] to-transparent backdrop-blur-sm [mask-image:linear-gradient(to_right,black_0%,black_40%,rgba(0,0,0,0.75)_72%,transparent_100%)] [-webkit-mask-image:linear-gradient(to_right,black_0%,black_40%,rgba(0,0,0,0.75)_72%,transparent_100%)]" />
                    )}
                    {artifactTabsCanScrollRight && (
                      <div className="pointer-events-none absolute inset-y-0 right-[36px] z-10 w-12 bg-gradient-to-l from-background from-[18%] via-background/80 via-[58%] to-transparent backdrop-blur-sm [mask-image:linear-gradient(to_left,black_0%,black_30%,rgba(0,0,0,0.75)_68%,transparent_100%)] [-webkit-mask-image:linear-gradient(to_left,black_0%,black_30%,rgba(0,0,0,0.75)_68%,transparent_100%)]" />
                    )}
                  </>
                )}
              </div>
            </div>
          )}
          {/* Artifact panel toggle */}
          {isPanelOpen && (
            <button
              type="button"
              onClick={handleToggleArtifactPanelExpanded}
              className={`non-draggable relative inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
                isArtifactPanelExpanded
                  ? 'bg-surface-raised text-foreground hover:bg-surface-hover'
                  : 'text-secondary hover:bg-surface-raised hover:text-foreground'
              }`}
              aria-label={
                isArtifactPanelExpanded
                  ? i18nService.t('artifactBrowserRestorePanelWidth')
                  : i18nService.t('artifactBrowserExpandPanel')
              }
              title={
                isArtifactPanelExpanded
                  ? i18nService.t('artifactBrowserRestorePanelWidth')
                  : i18nService.t('artifactBrowserExpandPanel')
              }
            >
              {isArtifactPanelExpanded ? (
                <PanelRestoreIcon className="h-4 w-4" />
              ) : (
                <PanelExpandIcon className="h-4 w-4" />
              )}
            </button>
          )}
          <button
            type="button"
            onClick={handleToggleArtifactPanel}
            className="non-draggable relative h-8 w-8 inline-flex items-center justify-center rounded-lg text-secondary hover:bg-surface-raised transition-colors"
            aria-label={i18nService.t('artifactPanelToggle')}
          >
            <ArtifactPanelIcon className="h-4 w-4" open={isPanelOpen} />
          </button>

          <WindowTitleBar inline className="ml-1" />
        </div>
      </div>

      {showArtifactAddMenu && artifactAddMenuPosition && createPortal(
        <div
          ref={artifactAddMenuRef}
          className="fixed z-50 w-44 overflow-hidden rounded-lg border border-border bg-background py-1 shadow-lg"
          style={{ left: artifactAddMenuPosition.left, top: artifactAddMenuPosition.top }}
        >
          <button
            type="button"
            onClick={handleOpenArtifactFileListFromMenu}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-surface"
          >
            <ArtifactPanelIcon className="h-4 w-4 shrink-0" open />
            <span className="truncate">{i18nService.t('artifactOpenFileTab')}</span>
          </button>
          <button
            type="button"
            onClick={handleOpenArtifactBrowserTab}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-surface"
          >
            <ArtifactBrowserTabIcon className="h-4 w-4 shrink-0" />
            <span className="truncate">{i18nService.t('artifactBrowserTab')}</span>
          </button>
          <button
            type="button"
            onClick={handleOpenArtifactSubagentTab}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-surface"
          >
            <SubagentIcon className="h-4 w-4 shrink-0" />
            <span className="truncate">{i18nService.t('subagentPanelTitle')}</span>
          </button>
        </div>,
        document.body
      )}

      {/* Export Options Modal */}
      {showExportOptions && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop"
          onClick={() => setShowExportOptions(false)}
        >
          <div
            className="w-full max-w-xs mx-4 dark:bg-claude-darkSurface bg-claude-surface rounded-2xl shadow-modal overflow-hidden modal-content"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b dark:border-claude-darkBorder border-claude-border">
              <h3 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
                {i18nService.t('coworkExportAs')}
              </h3>
            </div>
            <div className="py-1">
              <button
                type="button"
                onClick={(e) => { setShowExportOptions(false); handleShareClick(e); }}
                disabled={isExportingImage}
                className="w-full flex items-center gap-3 px-5 py-3 text-left text-sm dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors disabled:opacity-50"
              >
                <PhotoIcon className="h-5 w-5 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                <div>
                  <div className="font-medium">{i18nService.t('coworkExportImage')}</div>
                  <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('coworkExportImageDesc')}</div>
                </div>
              </button>
              <button
                type="button"
                onClick={() => { setShowExportOptions(false); handleExportText(CoworkTextExportFormat.Markdown); }}
                disabled={isExportingText}
                className="w-full flex items-center gap-3 px-5 py-3 text-left text-sm dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors disabled:opacity-50"
              >
                <DocumentArrowDownIcon className="h-5 w-5 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                <div>
                  <div className="font-medium">Markdown</div>
                  <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('coworkExportMarkdownDesc')}</div>
                </div>
              </button>
              <button
                type="button"
                onClick={() => { setShowExportOptions(false); handleExportText(CoworkTextExportFormat.Json); }}
                disabled={isExportingText}
                className="w-full flex items-center gap-3 px-5 py-3 text-left text-sm dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors disabled:opacity-50"
              >
                <DocumentArrowDownIcon className="h-5 w-5 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                <div>
                  <div className="font-medium">JSON</div>
                  <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('coworkExportJSONDesc')}</div>
                </div>
              </button>
              <button
                type="button"
                onClick={() => { setShowExportOptions(false); void handleExportDiagnostics(); }}
                className="w-full flex items-center gap-3 px-5 py-3 text-left text-sm dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
              >
                <ArchiveBoxArrowDownIcon className="h-5 w-5 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                <div>
                  <div className="font-medium">{i18nService.t('coworkExportDiagnostics')}</div>
                  <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('coworkExportDiagnosticsDesc')}</div>
                </div>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Content row: chat + artifact panel */}
      <div ref={contentRowRef} className="relative flex-1 flex overflow-hidden">
      <div
        ref={detailRootRef}
        className="flex-1 flex flex-col bg-background h-full min-w-0"
        style={{ minWidth: isArtifactPanelExpanded ? 0 : COWORK_DETAIL_MIN_WIDTH }}
      >
      <div className="relative flex-1 min-h-0">
        <div
          ref={scrollContainerRef}
          onScroll={handleMessagesScroll}
          onMouseUp={handleAssistantTextSelection}
          className="relative h-full min-h-0 overflow-y-auto pt-3"
          style={{ scrollbarGutter: 'stable both-edges' }}
        >
          {selectedTextAction && (
            <button
              type="button"
              data-cowork-selected-text-action
              onClick={handleAddSelectedText}
              className="absolute z-40 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-medium text-foreground shadow-popover transition-colors hover:bg-surface-raised"
              style={{ left: selectedTextAction.left, top: selectedTextAction.top }}
            >
              <ChatBubbleLeftIcon className="h-3.5 w-3.5 shrink-0 text-secondary" />
              <span>{i18nService.t('coworkSelectedTextAddToChat')}</span>
            </button>
          )}
          {isLoadingMoreMessages && (
            <div className="py-2 text-center text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('loading')}
            </div>
          )}
          {renderConversationTurns()}
          {isContextCompacting && (
            <div className={`${COWORK_DETAIL_GUTTER_CLASS} animate-message-in`}>
              <div className={COWORK_DETAIL_CONTENT_CLASS}>
                <ContextCompactionDivider
                  label={i18nService.t('coworkContextCompacting')}
                  active
                />
              </div>
            </div>
          )}
          <div className="h-20" />
        </div>

        {/* Turn Navigation Rail — to the left of scrollbar */}
        {shouldShowTurnNavigationRail && (
          <div
            className="absolute right-[18px] top-1/2 -translate-y-1/2 w-5 flex flex-col items-end z-10"
            style={{ maxHeight: 'calc(100% - 40px)' }}
            onWheel={handleRailWheel}
            onMouseEnter={() => setIsRailHovered(true)}
            onMouseLeave={() => {
              setIsRailHovered(false);
              setHoveredRailIndex(null);
              setRailTooltip(null);
            }}
          >
            {/* Up Arrow */}
            <button
              type="button"
              onClick={() => {
                const resolvedRail = currentRailIndex < 0 ? railItemCountRef.current - 1 : currentRailIndex;
                if (resolvedRail <= 0) return;
                navigateToRailItem(resolvedRail - 1, 'rail_prev_click');
              }}
              onMouseEnter={() => { setHoveredRailIndex(null); }}
              className={`shrink-0 flex items-center justify-center w-5 h-5 mb-2 -mr-[5px] rounded-full transition-all text-neutral-600 dark:text-neutral-400
                ${!isRailHovered
                  ? 'opacity-0 pointer-events-none'
                  : (currentRailIndex < 0 ? railItemCountRef.current - 1 : currentRailIndex) <= 0
                    ? 'opacity-30 cursor-default'
                    : 'cursor-pointer hover:text-neutral-800 dark:hover:text-neutral-200 hover:bg-neutral-200/60 dark:hover:bg-neutral-700/60'}`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-3.5 h-3.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
              </svg>
            </button>

            {/* Message Lines */}
            <div
              ref={railLinesRef}
              onWheel={handleRailWheel}
              className="overflow-y-auto overscroll-contain min-h-0"
              style={{ maxHeight: 'calc(100% - 56px)', scrollbarWidth: 'none' }}
            >
              {railItems.map((msg, idx) => {
                const isActive = idx === resolvedRailIndex;
                const isHighlighted = hoveredRailIndex === null ? isActive : idx === hoveredRailIndex;
                const lineWidth = getRailLineWidth(idx, resolvedRailIndex, hoveredRailIndex);
                return (
                  <button
                    key={msg.key}
                    type="button"
                    onClick={() => {
                      navigateToRailItem(idx, 'rail_item_click');
                    }}
                    onMouseEnter={(e) => {
                      setHoveredRailIndex(idx);
                      const rect = e.currentTarget.getBoundingClientRect();
                      const top = Math.max(8, Math.min(rect.top + rect.height / 2, window.innerHeight - 8));
                      setRailTooltip({
                        railIndex: idx,
                        top,
                        right: window.innerWidth - rect.left + 8,
                      });
                    }}
                    onMouseLeave={() => setRailTooltip(null)}
                    className="flex items-center justify-end cursor-pointer w-5 py-[5px]"
                  >
                    <span
                      className={`block shrink-0 border-solid transition-[width,border-color] ${
                        isHighlighted
                          ? 'border-neutral-800 dark:border-neutral-200'
                          : 'border-neutral-300 dark:border-neutral-600'
                      }`}
                      style={{
                        width: lineWidth,
                        height: 0,
                        borderTopWidth: RAIL_LINE_HEIGHT,
                      }}
                    />
                  </button>
                );
              })}
            </div>

            {/* Down Arrow */}
            <button
              type="button"
              onClick={() => {
                const maxRail = railItemCountRef.current - 1;
                const resolvedRail = currentRailIndex < 0 ? maxRail : currentRailIndex;
                if (resolvedRail >= maxRail) return;
                navigateToRailItem(resolvedRail + 1, 'rail_next_click');
              }}
              onMouseEnter={() => { setHoveredRailIndex(null); }}
              className={`shrink-0 flex items-center justify-center w-5 h-5 mt-2 -mr-[5px] rounded-full transition-all text-neutral-600 dark:text-neutral-400
                ${!isRailHovered
                  ? 'opacity-0 pointer-events-none'
                  : (currentRailIndex < 0 ? railItemCountRef.current - 1 : currentRailIndex) >= railItemCountRef.current - 1
                    ? 'opacity-30 cursor-default'
                    : 'cursor-pointer hover:text-neutral-800 dark:hover:text-neutral-200 hover:bg-neutral-200/60 dark:hover:bg-neutral-700/60'}`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-3.5 h-3.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
              </svg>
            </button>
          </div>
        )}

        {railTooltip && railTooltipItem && createPortal(
          <div
            className={`fixed z-[100] px-3.5 py-2 text-[13px] leading-snug pointer-events-none overflow-hidden
              shadow-[0_2px_12px_rgba(0,0,0,0.12)]
              border dark:shadow-[0_2px_12px_rgba(0,0,0,0.4)]
              rounded-xl bg-neutral-50 border-neutral-200/80 dark:bg-neutral-800 dark:border-neutral-700`}
            style={{
              top: railTooltip.top,
              right: railTooltip.right,
              width: `min(420px, calc(100vw - ${railTooltip.right + 16}px))`,
              transform: 'translateY(-50%)',
            }}
          >
            <div
              className="text-[13px] font-semibold text-neutral-900 dark:text-neutral-100"
              style={{
                display: '-webkit-box',
                WebkitLineClamp: 1,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
                wordBreak: 'break-all',
              }}
            >
              {railTooltipTitle}
            </div>
            {railTooltipSummary && (
              <div
                className="mt-1 text-[13px] text-neutral-600 dark:text-neutral-300"
                style={{
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                  wordBreak: 'break-all',
                }}
              >
                {railTooltipSummary}
              </div>
            )}
          </div>,
          document.body
        )}
        {shouldShowScrollToBottom && (
          <button
            type="button"
            onClick={handleScrollToBottom}
            onWheel={handleScrollToBottomWheel}
            className="absolute bottom-4 left-1/2 z-20 inline-flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-background text-foreground/85 shadow-[0_2px_10px_rgba(15,23,42,0.12)] transition-colors hover:bg-surface-raised hover:text-foreground dark:shadow-[0_2px_14px_rgba(0,0,0,0.36)]"
            aria-label={i18nService.t('coworkScrollToBottom')}
            title={i18nService.t('coworkScrollToBottom')}
          >
            <ArrowDownIcon className="h-4 w-4 stroke-[2.1]" />
          </button>
        )}
      </div>

      {/* Streaming Activity Bar */}
      {isSessionBusy && <StreamingActivityBar messages={currentSession.messages} isContextMaintenance={isContextMaintenance} />}

      {/* Input Area */}
      <div
        ref={promptInputAreaRef}
        className={`relative shrink-0 ${COWORK_DETAIL_GUTTER_CLASS} ${
          isArtifactPanelExpanded ? 'z-50 bg-background pb-2 pt-1' : 'pb-4 pt-0'
        } ${isArtifactPanelExpanded && isExpandedPromptInputHidden ? 'hidden' : ''}`}
      >
        {isArtifactPanelExpanded && !isExpandedPromptInputHidden && (
          <button
            type="button"
            onClick={handleToggleExpandedPromptInput}
            className="absolute right-3 top-1 z-20 inline-flex h-5 w-5 items-center justify-center rounded-md border border-border bg-surface-raised text-muted shadow-sm transition-colors hover:bg-surface-hover hover:text-foreground"
            aria-label={i18nService.t('artifactBrowserHideInput')}
            title={i18nService.t('artifactBrowserHideInput')}
          >
            <PromptInputCollapseIcon className="h-3.5 w-3.5" />
          </button>
        )}
        {isArtifactPanelExpanded && (expandedConversationPreview || isSessionBusy) && (
          <div className={`${COWORK_DETAIL_CONTENT_CLASS} mb-1`}>
            <div className="overflow-hidden rounded-2xl border border-border bg-surface-raised shadow-subtle">
              <button
                type="button"
                onClick={() => setIsExpandedConversationPreviewOpen(value => !value)}
                className="flex h-8 w-full items-center gap-2 px-3 pr-8 text-left text-xs text-secondary transition-colors hover:bg-surface-hover hover:text-foreground"
                aria-label={i18nService.t(
                  isExpandedConversationPreviewOpen
                    ? 'coworkExpandedConversationPreviewCollapse'
                    : 'coworkExpandedConversationPreviewExpand',
                )}
                title={i18nService.t(
                  isExpandedConversationPreviewOpen
                    ? 'coworkExpandedConversationPreviewCollapse'
                    : 'coworkExpandedConversationPreviewExpand',
                )}
              >
                <span className="shrink-0 font-medium text-muted">
                  {i18nService.t(
                    isExpandedConversationPreviewOpen
                      ? 'coworkExpandedConversationPreviewMessages'
                      : 'coworkExpandedConversationPreviewLatest',
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {expandedConversationPreview?.latest.summary ?? i18nService.t('coworkExpandedConversationPreviewEmpty')}
                </span>
                {isSessionBusy && (
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium leading-4 text-primary">
                    <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" aria-hidden="true" />
                    {i18nService.t('coworkExpandedConversationStatusRunning')}
                  </span>
                )}
                {isExpandedConversationPreviewOpen ? (
                  <PromptInputExpandIcon className="h-3.5 w-3.5 shrink-0 text-muted" />
                ) : (
                  <PromptInputCollapseIcon className="h-3.5 w-3.5 shrink-0 text-muted" />
                )}
              </button>
              {isExpandedConversationPreviewOpen && (
                <div className="max-h-44 overflow-y-auto border-t border-border/70 px-3 py-2">
                  <div className="space-y-2">
                    {expandedConversationPreview?.items.map(item => (
                      <div
                        key={item.id}
                        className={`flex ${item.role === 'user' ? 'justify-end' : 'justify-start'}`}
                      >
                        <div
                          className={
                            item.role === 'user'
                              ? 'max-w-[82%] rounded-2xl bg-background px-3 py-2 text-foreground shadow-subtle'
                              : 'min-w-0 flex-1 px-1 py-1 text-foreground'
                          }
                        >
                          {item.role === 'user' ? (
                            <UserMessageContent
                              content={item.content}
                              className="max-w-none text-xs leading-5"
                            />
                          ) : (
                            <MarkdownContent
                              content={item.content}
                              className="prose dark:prose-invert max-w-none text-xs leading-5"
                              resolveLocalFilePath={resolveLocalFilePath}
                              showRevealInFolderAction
                            />
                          )}
                        </div>
                      </div>
                    ))}
                    {isSessionBusy && (
                      <div className="flex items-center gap-2 rounded-xl bg-primary/10 px-2.5 py-2 text-xs font-medium text-primary">
                        <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" aria-hidden="true" />
                        {i18nService.t('coworkExpandedConversationStatusRunning')}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
        <div className={COWORK_DETAIL_CONTENT_CLASS}>
          <CoworkPromptInput
            ref={promptInputRef}
            onSubmit={onContinue}
            onStop={onStop}
            isStreaming={isSessionBusy}
            placeholder={i18nService.t(remoteManaged ? 'coworkRemoteManagedPlaceholder' : 'coworkContinuePlaceholder')}
            disabled={remoteManaged}
            size={isArtifactPanelExpanded ? 'compact' : 'large'}
            remoteManaged={remoteManaged}
            onManageSkills={remoteManaged ? undefined : onManageSkills}
            onManageKits={remoteManaged ? undefined : onManageKits}
            showModelSelector={true}
            showReadOnlyContext={!isArtifactPanelExpanded}
            readOnlyContextTrailingText={isArtifactPanelExpanded ? undefined : i18nService.t('aiGeneratedDisclaimer')}
            workingDirectory={currentSession?.cwd ?? ''}
            contextAgentId={currentSession?.agentId}
            sessionId={currentSession?.id}
            goal={!remoteManaged ? currentSession?.goal : null}
            onGoalCommand={!remoteManaged && currentSession?.id ? handleGoalCommand : undefined}
            contextUsageControl={(
              <div className="flex min-w-0 items-center gap-2">
                <div ref={compactConfirmRef} className="relative inline-flex flex-shrink-0">
                  <ContextUsageIndicator
                    usage={contextUsage}
                    compacting={isContextBusy}
                    disabled={remoteManaged || !currentSession?.id}
                    onCompact={handleCompactContext}
                    showTooltip={!showCompactConfirm}
                    active={showCompactConfirm}
                    className="-mr-1"
                  />
                  {showCompactConfirm && (
                    <div className="absolute bottom-full left-1/2 z-50 mb-1.5 flex -translate-x-1/2 items-center gap-2 rounded-xl border border-border bg-surface p-1.5 shadow-popover">
                      <button
                        type="button"
                        onClick={handleCancelCompactContext}
                        className="whitespace-nowrap rounded-md bg-surface-raised px-2.5 py-1 text-center text-[11px] font-medium leading-4 text-secondary transition-colors hover:text-foreground"
                      >
                        {i18nService.t('cancel')}
                      </button>
                      <button
                        type="button"
                        onClick={handleConfirmCompactContext}
                        className="whitespace-nowrap rounded-md bg-primary px-2.5 py-1 text-center text-[11px] font-semibold leading-4 text-white transition-colors hover:bg-primary-hover"
                      >
                        {i18nService.t('coworkContextCompactConfirmActionShort')}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
          />
        </div>
      </div>
      {isArtifactPanelExpanded && isExpandedPromptInputHidden && (
        <button
          type="button"
          onClick={handleToggleExpandedPromptInput}
          className="absolute bottom-2 right-2 z-50 inline-flex h-5 w-5 items-center justify-center rounded-md border border-border bg-surface-raised text-muted shadow-sm transition-colors hover:bg-surface-hover hover:text-foreground"
          aria-label={i18nService.t('artifactBrowserShowInput')}
          title={i18nService.t('artifactBrowserShowInput')}
        >
          <PromptInputExpandIcon className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
    {shouldRenderArtifactPanel && (
      <div
        className={`${
          artifactPanelIsOverlay
            ? 'absolute inset-x-0 top-0 z-40 overflow-hidden bg-background'
            : 'h-full shrink-0 overflow-hidden'
        } ${
          isArtifactPanelTransitioning
            ? 'transition-[width,opacity] duration-200 ease-out motion-reduce:transition-none'
            : ''
        } ${isArtifactPanelVisible ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
        style={artifactPanelIsOverlay
          ? {
              bottom: artifactPanelOverlayBottom,
              width: 'auto',
              maxWidth: 'none',
            }
          : {
              width: artifactPanelFrameWidth,
              maxWidth: artifactPanelMaxWidth + ARTIFACT_PANEL_RESIZE_HANDLE_WIDTH,
            }}
        aria-hidden={!isPanelOpen}
      >
        <div
          className="flex h-full"
          style={{ width: artifactPanelInnerWidth }}
        >
          <ArtifactPanelErrorBoundary onClose={() => dispatch(closePanel({ sessionId: currentSession.id }))}>
            <ArtifactPanel
              sessionId={currentSession.id}
              artifacts={sessionArtifacts}
              workingDirectory={currentSession.cwd}
              activeSpecialTab={activeSpecialPreviewTab}
              minPanelWidth={artifactPanelRenderMinWidth}
              maxPanelWidth={artifactPanelRenderMaxWidth}
              isPanelExpanded={isArtifactPanelExpanded}
              browserAddress={browserPreviewAddress}
              browserUrl={browserPreviewUrl}
              browserLocalServiceContext={browserLocalServiceContext}
              browserHtmlArtifactId={browserHtmlPreviewArtifactId}
              onBrowserAddressChange={handleBrowserPreviewAddressChange}
              onBrowserUrlChange={handleBrowserPreviewUrlChange}
              onBrowserTitleChange={handleBrowserPreviewTitleChange}
              onBrowserLocalServiceContextChange={setSessionBrowserLocalServiceContext}
              onOpenFileListTab={handleOpenArtifactFileListTab}
              onOpenBrowserTab={handleOpenArtifactBrowserTab}
              onOpenHtmlFileInBrowser={handleOpenHtmlFileInBrowser}
              onBrowserAnnotationCaptured={handleBrowserAnnotationCaptured}
              subagentPanel={(
                <SubagentPanelContent
                  subagents={subagents}
                  loading={subagentsLoading}
                  selectedSubagent={selectedSubagentForPanel}
                  onBackToList={() => setSelectedSubagent(null)}
                  onSelectSubagent={handleSelectSubagent}
                />
              )}
              onAddSelectedText={addSelectedTextSnippetToDraft}
              selectedTextEnabled={!remoteManaged}
            />
          </ArtifactPanelErrorBoundary>
        </div>
      </div>
    )}
    </div>
    </div>
  );
};

export default CoworkSessionDetail;
