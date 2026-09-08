import {
  ArchiveBoxArrowDownIcon,
  ArrowDownIcon,
  ComputerDesktopIcon,
  DocumentArrowDownIcon,
  ExclamationTriangleIcon,
  PaperClipIcon,
  PhotoIcon,
  QuestionMarkCircleIcon,
} from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDispatch, useSelector } from 'react-redux';

import { stripGoalCommandPrefixForDisplay } from '../../../common/sessionTitle';
import {
  BrowserDisplayMode,
  normalizeBrowserWebAccessConfig,
} from '../../../shared/browserWebAccess/constants';
import type { CoworkBrowserAnnotationMessageBatch } from '../../../shared/cowork/browserAnnotations';
import {
  buildCoworkBtwComposerQuestion,
  buildCoworkBtwContextualQuestion,
  createCoworkBtwRunId,
  normalizeCoworkBtwQuestion,
  resolveCoworkBtwSelectedTextSnippets,
} from '../../../shared/cowork/btw';
import { CoworkOnboardingMessageKind } from '../../../shared/cowork/constants';
import { CoworkGoalStatus } from '../../../shared/cowork/goal';
import type { CoworkImageAttachmentPreview } from '../../../shared/cowork/imageAttachments';
import {
  COWORK_RAIL_TOOLTIP_PREVIEW_MAX_LENGTH,
  type CoworkMessageRailIndexItem,
} from '../../../shared/cowork/rail';
import type {
  CoworkSearchMessageCursor,
  CoworkSearchMessagePage,
} from '../../../shared/cowork/search';
import {
  type CoworkSelectedTextSnippet,
  CoworkSelectedTextSource,
  type CoworkSelectedTextValidationError,
  normalizeCoworkSelectedTextSnippets,
} from '../../../shared/cowork/selectedText';
import { classifyWaitingNotificationKind, WaitingNotificationKind } from '../../../shared/notifications/constants';
import { ShareDeploymentCandidateSource } from '../../../shared/shareDeployment/constants';
import { resolveArtifactAutoPreviewEnabled } from '../../config';
import { EnterpriseQuotaPrompt } from '../../features/enterpriseAccount/components/EnterpriseQuotaPrompt';
import {
  findCurrentEnterpriseQuotaSignal,
  resolveActiveEnterpriseQuotaSignal,
} from '../../features/enterpriseAccount/quotaPromptState';
import { selectEnterpriseAccountContext } from '../../features/enterpriseAccount/selectors';
import { collectSessionArtifacts, loadDetectedFileArtifact } from '../../services/artifactDetection';
import {
  dedupeArtifactsForDisplay,
  normalizeFilePathForDedup,
  normalizeLocalServiceOrigin,
  normalizeProjectDirectoryForDedup,
  parseMediaTokensFromText,
} from '../../services/artifactParser';
import { configService, ConfigServiceEvent } from '../../services/config';
import { coworkService } from '../../services/cowork';
import { i18nService } from '../../services/i18n';
import { getInstalledKitSkillIds } from '../../services/kitCapability';
import { readLocalServiceProjectDirectoryCandidate } from '../../services/localServiceProjectDirectoryCache';
import { RootState } from '../../store';
import {
  selectCurrentMessagesLength,
  selectCurrentMessagesWithDetachedTail,
  selectCurrentSession,
  selectIsStreaming,
  selectLastMessageContent,
  selectRemoteManaged,
} from '../../store/selectors/coworkSelectors';
import {
  activateArtifactAgentBrowserTab,
  activateArtifactBrowserTab,
  activateArtifactFileListTab,
  activateArtifactPreviewTab,
  activateArtifactSubagentTab,
  activateArtifactUserAttachmentTab,
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
  updateLocalServiceProjectMetadata,
} from '../../store/slices/artifactSlice';
import {
  addDraftSelectedTextSnippet,
  clearBtwComposerIfUnchanged,
  clearBtwEntries,
  closeBtwThread,
  openBtwThread,
  PlanConfirmationState,
  setBtwDraft,
  setBtwSelectedTextSnippets,
  setDraftCollaborationMode,
  setPlanConfirmationAwaiting,
  setPlanConfirmationHandled,
} from '../../store/slices/coworkSlice';
import { setActiveKitIds } from '../../store/slices/kitSlice';
import { setActiveSkillIds } from '../../store/slices/skillSlice';
import type { Artifact } from '../../types/artifact';
import { ArtifactTypeValue, PREVIEWABLE_ARTIFACT_TYPES } from '../../types/artifact';
import type {
  CoworkImageAttachment,
  CoworkMessage,
  CoworkMessageMetadata,
  CoworkPermissionRequest,
  CoworkPermissionResult,
  SubagentSessionSummary,
} from '../../types/cowork';
import {
  CoworkCollaborationMode,
  type CoworkCollaborationMode as CoworkCollaborationModeType,
  CoworkSessionStatusValue,
} from '../../types/cowork';
import type { MediaAttachmentRef } from '../../types/mediaGeneration';
import { parseUserMessageForDisplay } from '../../utils/userMessageDisplay';
import {
  AgentBrowserInAppPanel,
  ArtifactPanel,
  type LocalServiceDeploymentRequest,
  SubagentPanelContent,
  UserAttachmentPanelContent,
  type UserAttachmentPreviewPayload,
} from '../artifacts';
import { reportArtifactPreviewAction } from '../artifacts/artifactAnalytics';
import { ArtifactFileShareProvider } from '../artifacts/ArtifactFileShareController';
import {
  ArtifactAutoPreviewOpenTarget,
  getAutoPreviewOpenTarget,
  selectAutoPreviewArtifact,
} from '../artifacts/autoPreviewPolicy';
import ComposeIcon from '../icons/ComposeIcon';
import FileTypeIcon from '../icons/fileTypes/FileTypeIcon';
import SidebarSearchIcon from '../icons/SidebarSearchIcon';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import SubagentIcon from '../icons/SubagentIcon';
import MarkdownContent from '../MarkdownContent';
import { type ToastEventDetail } from '../Toast';
import { resolveAgentModelSelection, useAgentSelectedModel } from './agentModelSelection';
import AssistantTurnBlock, { ContextCompactionDivider } from './AssistantTurnBlock';
import type { BrowserAnnotationAttachmentOpenPayload } from './BrowserAnnotationMessageAttachments';
import { type CoworkOpenShareOptionsEventDetail, CoworkUiEvent } from './constants';
import ContextUsageIndicator from './ContextUsageIndicator';
import {
  bucketCount,
  bucketDistance,
  bucketLength,
  reportConversationNavigationAction,
} from './conversationAnalytics';
import {
  canScrollElementInWheelDirection,
  isAtConversationSessionBottom,
  isWheelScrollingAwayFromBottom,
  shouldAutoScrollForPosition,
  shouldLoadNewerConversationMessages,
} from './conversationScrollPolicy';
import {
  applyConversationSearchHighlights,
  clearConversationSearchHighlights,
} from './conversationSearchHighlight';
import {
  logConversationSearchDebug,
  logConversationSearchWarning,
} from './conversationSearchLogger';
import {
  getConversationSearchCenterDelta,
  isUsableConversationSearchRect,
  scheduleConversationSearchSettle,
} from './conversationSearchNavigation';
import CoworkBtwFloatingPanel from './CoworkBtwFloatingPanel';
import CoworkConversationSearch from './CoworkConversationSearch';
import CoworkPromptInput, { type CoworkPromptInputRef } from './CoworkPromptInput';
import LazyRenderTurn, { clearHeightCache } from './LazyRenderTurn';
import {
  buildConversationTurns,
  buildDisplayItems,
  type ConversationTurn,
  COWORK_DETAIL_CONTENT_CLASS,
  COWORK_DETAIL_GUTTER_CLASS,
  getTurnMessageIds,
  MEDIA_TOKEN_DISPLAY_RE,
  type ToolGroupItem,
} from './messageDisplayUtils';
import { parseProposedPlanBlock } from './proposedPlanParser';
import { buildSelectedKitContextPrompt } from './selectedKitContextPrompt';
import { buildSelectedSkillRoutingPrompt } from './selectedSkillRoutingPrompt';
import SelectedTextActionToolbar from './SelectedTextActionToolbar';
import {
  buildCoworkSessionJSON,
  buildCoworkSessionMarkdown,
  CoworkTextExportFormat,
  type CoworkTextExportFormat as CoworkTextExportFormatValue,
  mergeCoworkTextExportMessages,
} from './sessionExport';
import SubagentSpawnCard from './SubagentSpawnCard';
import { useCoworkConversationSearch } from './useCoworkConversationSearch';
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
    browserAnnotations?: import('@shared/cowork/browserAnnotations').CoworkBrowserAnnotationMessageBatch[],
    collaborationMode?: CoworkCollaborationModeType,
  ) => boolean | void | Promise<boolean | void>;
  onStop: () => void;
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
  minimizedPermission?: CoworkPermissionRequest | null;
  onRestorePermission?: () => void;
  onRespondToPermission?: (result: CoworkPermissionResult) => void;
}

interface BrowserLocalServiceContext {
  artifactId?: string;
  url: string;
  origin: string;
  projectDirectory?: string;
  projectCandidates?: NonNullable<Artifact['localService']>['projectCandidates'];
}

const LOCAL_SERVICE_RESOLVED_CANDIDATE_SOURCES = new Set<string>([
  ShareDeploymentCandidateSource.Process,
  ShareDeploymentCandidateSource.ProcessCwd,
  ShareDeploymentCandidateSource.Cache,
  ShareDeploymentCandidateSource.Workspace,
  ShareDeploymentCandidateSource.WorkspaceChild,
]);

const getLocalServiceContextCandidates = (artifact: Artifact) => (
  artifact.localService?.projectCandidates?.filter(candidate =>
    !LOCAL_SERVICE_RESOLVED_CANDIDATE_SOURCES.has(candidate.source)
  ) ?? []
);

const getLocalServiceProjectResolutionInputKey = (
  artifact: Artifact,
  workingDirectory?: string,
  cachedProjectDirectory?: string,
): string => {
  const candidates = getLocalServiceContextCandidates(artifact)
    .map(candidate => [
      candidate.source,
      normalizeProjectDirectoryForDedup(candidate.directory),
      candidate.messageId || '',
      candidate.confidence,
    ].join(':'));
  return [
    artifact.url || artifact.content,
    normalizeProjectDirectoryForDedup(workingDirectory || ''),
    normalizeProjectDirectoryForDedup(cachedProjectDirectory || ''),
    ...candidates,
  ].join('|');
};

const getLocalServiceProjectMetadataKey = (
  projectDirectory: string | undefined,
  projectCandidates: NonNullable<Artifact['localService']>['projectCandidates'] | undefined,
): string => [
  normalizeProjectDirectoryForDedup(projectDirectory || ''),
  ...(projectCandidates ?? []).map(candidate =>
    `${candidate.source}:${normalizeProjectDirectoryForDedup(candidate.directory)}`
  ),
].join('|');
const NAV_SCROLL_LOCK_DURATION = 800;
const NAV_BOTTOM_SNAP_THRESHOLD = 20;
const WHEEL_DELTA_LINE_HEIGHT = 16;
const SCROLL_TO_BOTTOM_SETTLE_THRESHOLD = 24;
const SCROLL_TO_BOTTOM_SETTLE_DELAYS_MS = [600, 1200, 1800] as const;
const AutoScrollDetachSource = {
  ConversationWheel: 'conversation_wheel',
  ScrollToBottomControlWheel: 'scroll_to_bottom_control_wheel',
} as const;
type AutoScrollDetachSource = typeof AutoScrollDetachSource[keyof typeof AutoScrollDetachSource];
const AUTO_PREVIEW_ARTIFACT_SETTLE_MS = 600;
const MAX_AUTO_PREVIEW_HANDLED_TURNS = 128;
const LOCAL_SERVICE_PROCESS_DIRECTORY_RETRY_DELAY_MS = 900;
const ARTIFACT_PANEL_TRANSITION_MS = 200;
const ARTIFACT_PANEL_RESIZE_HANDLE_WIDTH = 4;
const COWORK_DETAIL_MIN_WIDTH = 480;
const ARTIFACT_PANEL_MIN_WIDTH_RATIO = 1 / 6;
const SUBAGENT_PANEL_POLL_INTERVAL_MS = 5_000;
const INVALID_FILE_NAME_PATTERN = /[<>:"/\\|?*\u0000-\u001F]/g;
const SELECTED_TEXT_ACTION_HALF_WIDTH = 150;
const SELECTED_TEXT_ACTION_SUPPRESS_MS = 250;
const SECONDARY_POINTER_BUTTON = 2;
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

const getPermissionPreviewText = (permission: CoworkPermissionRequest): string => {
  const toolInput = permission.toolInput ?? {};
  if (classifyWaitingNotificationKind(permission.toolName) === WaitingNotificationKind.Question) {
    const rawQuestions = (toolInput as Record<string, unknown>).questions;
    if (Array.isArray(rawQuestions)) {
      const firstQuestion = rawQuestions.find((question): question is Record<string, unknown> => (
        !!question && typeof question === 'object' && !Array.isArray(question)
      ));
      if (typeof firstQuestion?.question === 'string') {
        return firstQuestion.question;
      }
    }
  }

  const command = (toolInput as Record<string, unknown>).command;
  if (typeof command === 'string' && command.trim()) {
    return command.trim();
  }

  try {
    return JSON.stringify(toolInput);
  } catch {
    return permission.toolName;
  }
};

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

/**
 * Success toast for a completed export: adds a "Show in Folder" action so the
 * user can jump straight to the saved file instead of hunting for it.
 */
const showExportedFileToast = (message: string, savedPath?: string): void => {
  if (!savedPath) {
    showToast(message);
    return;
  }
  const detail: ToastEventDetail = {
    message,
    actionLabel: i18nService.t('showInFolder'),
    onAction: () => {
      void (async () => {
        try {
          const result = await window.electron?.shell?.showItemInFolder?.(savedPath);
          if (result && result.success === false) {
            showToast(i18nService.t('showInFolderFailed'));
          }
        } catch {
          showToast(i18nService.t('showInFolderFailed'));
        }
      })();
    },
  };
  window.dispatchEvent(new CustomEvent<ToastEventDetail>('app:showToast', { detail }));
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

const logAutoScrollDiagnostic = (message: string): void => {
  console.debug(`[CoworkSessionDetail] ${message}`);
  window.electron?.log?.fromRenderer?.('debug', 'CoworkSessionDetail', message);
};

const logSelectedTextDiagnostic = (message: string): void => {
  console.debug(`[CoworkSessionDetail] ${message}`);
  window.electron?.log?.fromRenderer?.('debug', 'CoworkSessionDetail', message);
};

const getSelectionAnchorRect = (range: Range): DOMRect => {
  const lineRects = Array.from(range.getClientRects())
    .filter(rect => rect.width > 0 && rect.height > 0);
  return lineRects[0] ?? range.getBoundingClientRect();
};

const isWheelHandledByNestedScroller = (
  target: EventTarget | null,
  conversationContainer: HTMLElement,
  deltaY: number,
): boolean => {
  let element = target instanceof HTMLElement ? target : null;
  while (element && element !== conversationContainer) {
    const style = window.getComputedStyle(element);
    const hasScrollableOverflow = style.overflowY === 'auto' || style.overflowY === 'scroll';
    if (hasScrollableOverflow && element.scrollHeight > element.clientHeight) {
      if (style.overscrollBehaviorY === 'contain' || style.overscrollBehaviorY === 'none') {
        return true;
      }
      if (canScrollElementInWheelDirection(
        element.scrollTop,
        element.scrollHeight,
        element.clientHeight,
        deltaY,
      )) {
        return true;
      }
    }
    element = element.parentElement;
  }
  return false;
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
  const availableHalfWidth = Math.max(0, (container.clientWidth - 16) / 2);
  const actionHalfWidth = Math.min(
    SELECTED_TEXT_ACTION_HALF_WIDTH,
    availableHalfWidth,
  );
  return Math.min(
    container.clientWidth - actionHalfWidth,
    Math.max(actionHalfWidth, selectionCenterX),
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

// Chromium caps a canvas dimension at 65535px; stay under it with margin.
const MAX_EXPORT_CANVAS_DIMENSION = 65000;
// Cap the final canvas area so content + composed canvases stay within a
// few hundred MB of bitmap memory during export.
const MAX_EXPORT_CANVAS_AREA = 60_000_000;
// Below this render scale the exported text becomes unreadable; sessions that
// still exceed the canvas dimension at this scale are rejected as too long.
const MIN_EXPORT_SCALE = 0.5;
// Non-content chrome added by composeExportCanvas, in CSS px. Must match its
// layout constants: header 80 + footer 80 + 2 dividers + outer padding 28+28.
const EXPORT_CHROME_CSS_HEIGHT = 218;
// Horizontal chrome added by composeExportCanvas: outer padding 24+24.
const EXPORT_CHROME_CSS_WIDTH = 48;
const MAX_EXPORT_SEGMENTS = 400;
// Hard cap on how many messages a single exported image may cover; beyond
// this the content is guaranteed to blow past the canvas limits anyway.
const MAX_EXPORT_MESSAGE_COUNT = 1500;
const EXPORT_IMAGE_DECODE_TIMEOUT_MS = 1500;

class ExportImageCancelledError extends Error {
  constructor() {
    super('Export image cancelled');
  }
}

class ExportImageTooLongError extends Error {
  constructor() {
    super('Conversation too long for a single export image');
  }
}

type ExportImageProgress = {
  phase: 'loading' | 'capturing' | 'saving';
  current?: number;
  total?: number;
};

const waitForNextFrame = (): Promise<void> =>
  new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });

/** Wait until the container's scroll height stops changing (layout settled). */
const waitForStableLayout = async (
  container: HTMLElement,
  requiredStableFrames = 5,
  maxFrames = 300,
): Promise<void> => {
  let lastScrollHeight = container.scrollHeight;
  let stableFrames = 0;
  for (let frame = 0; frame < maxFrames && stableFrames < requiredStableFrames; frame += 1) {
    await waitForNextFrame();
    const nextScrollHeight = container.scrollHeight;
    if (nextScrollHeight === lastScrollHeight) {
      stableFrames += 1;
    } else {
      stableFrames = 0;
      lastScrollHeight = nextScrollHeight;
    }
  }
};

/**
 * Force every image in the container to start loading and wait for them to
 * finish decoding, so the measured layout matches what gets captured. Images
 * that fail or exceed the timeout are skipped (they capture as-is).
 */
const prepareAllImagesForExport = async (
  container: HTMLElement,
  timeoutMs = 10000,
): Promise<void> => {
  const pendingImages = Array.from(container.querySelectorAll('img')).filter((img) => !img.complete);
  if (pendingImages.length === 0) return;
  pendingImages.forEach((img) => {
    if (img.loading === 'lazy') {
      img.loading = 'eager';
    }
  });
  await Promise.race([
    Promise.all(pendingImages.map((img) => img.decode().catch(() => undefined))),
    new Promise<void>((resolve) => {
      window.setTimeout(resolve, timeoutMs);
    }),
  ]);
};

/**
 * Wait for images intersecting the container's viewport to finish decoding so
 * a capture does not stitch in blank placeholders (lazy-loaded attachments).
 */
const waitForViewportImagesReady = async (
  container: HTMLElement,
  timeoutMs = EXPORT_IMAGE_DECODE_TIMEOUT_MS,
): Promise<void> => {
  const containerRect = container.getBoundingClientRect();
  const pendingImages = Array.from(container.querySelectorAll('img')).filter((img) => {
    if (img.complete) return false;
    const rect = img.getBoundingClientRect();
    return rect.bottom > containerRect.top && rect.top < containerRect.bottom;
  });
  if (pendingImages.length === 0) return;
  await Promise.race([
    Promise.all(pendingImages.map((img) => img.decode().catch(() => undefined))),
    new Promise<void>((resolve) => {
      window.setTimeout(resolve, timeoutMs);
    }),
  ]);
  await waitForNextFrame();
};

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
  renderScale: number = window.devicePixelRatio || 1,
): Promise<HTMLCanvasElement> => {
  const isDark = document.documentElement.classList.contains('dark');
  const dpr = renderScale;
  const fontStack = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';

  // The content canvas is rendered at renderScale device px per CSS px.
  const contentW = contentCanvas.width / dpr;   // CSS px
  const contentH = contentCanvas.height / dpr;  // CSS px

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
  ctx.fillText('LobsterAI — 全场景办公助手 Agent', textX, footerCenterY - taglineFontSize / 2 - 2);

  ctx.fillStyle = subtitleColor;
  ctx.font = `400 ${taglineFontSize}px ${fontStack}`;
  ctx.fillText('国内大厂首个开源桌面级 Agent，网易有道出品', textX, footerCenterY + brandFontSize / 2 + 3);

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
  minimizedPermission,
  onRestorePermission,
  onRespondToPermission,
}) => {
  const dispatch = useDispatch();
  const isMac = window.electron.platform === 'darwin';
  const isWindows = window.electron.platform === 'win32';
  const currentSession = useSelector(selectCurrentSession);
  const enterpriseAccountContext = useSelector(selectEnterpriseAccountContext);
  const isStreaming = useSelector(selectIsStreaming);
  const remoteManaged = useSelector(selectRemoteManaged);
  const lastMessageContent = useSelector(selectLastMessageContent);
  const messagesLength = useSelector(selectCurrentMessagesLength);
  const skills = useSelector((state: RootState) => state.skill.skills);
  const activeSkillIds = useSelector((state: RootState) => state.skill.activeSkillIds);
  const activeKitIds = useSelector((state: RootState) => state.kit.activeKitIds);
  const installedKits = useSelector((state: RootState) => state.kit.installedKits);
  const marketplaceKits = useSelector((state: RootState) => state.kit.marketplaceKits);
  const currentAgentId = useSelector((state: RootState) => state.agent.currentAgentId);
  const agents = useSelector((state: RootState) => state.agent.agents);
  const availableModels = useSelector((state: RootState) => state.model.availableModels);
  const coworkAgentEngine = useSelector((state: RootState) => state.cowork.config.agentEngine);
  const currentAgent = agents.find(agent => agent.id === currentAgentId);
  const currentAgentSelectedModel = useAgentSelectedModel(
    currentAgentId,
    currentAgent?.model ?? '',
  );
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
  const btwThread = useSelector((state: RootState) =>
    currentSession?.id ? state.cowork.btwThreadsBySessionId[currentSession.id] : undefined
  );
  const queuedSteerCount = useSelector((state: RootState) => {
    if (!currentSession?.id) return 0;
    return (
      (state.cowork.pendingSteers[currentSession.id]?.length ?? 0)
      + (state.cowork.rejectedSteers[currentSession.id]?.length ?? 0)
    );
  });
  const messageRailIndex = useSelector((state: RootState) =>
    currentSession?.id ? state.cowork.messageRailIndexBySessionId[currentSession.id] ?? [] : []
  );
  const currentMessagesWithDetachedTail = useSelector(selectCurrentMessagesWithDetachedTail);
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
  const shouldAutoScrollRef = useRef(true);
  const userDetachedFromBottomRef = useRef(false);
  const [isViewportAtSessionBottom, setIsViewportAtSessionBottom] = useState(true);
  const [isLoadingMoreMessages, setIsLoadingMoreMessages] = useState(false);
  const [showCompactConfirm, setShowCompactConfirm] = useState(false);
  const [selectedTextAction, setSelectedTextAction] = useState<{
    text: string;
    sourceMessageId: string;
    left: number;
    top: number;
  } | null>(null);
  const isLoadingMoreMessagesRef = useRef(false);
  const isLoadingNewerMessagesRef = useRef(false);
  const newerMessagesLoadRequestRef = useRef(0);
  const prevScrollHeightRef = useRef<number | null>(null);
  const scrollToBottomIntentRef = useRef(false);
  const scrollToBottomSettleTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const suppressSelectedTextActionUntilRef = useRef(0);
  const minimizedPermissionPreview = minimizedPermission
    ? getPermissionPreviewText(minimizedPermission)
    : '';
  // AskUserQuestion is the agent asking for input, not a risky action awaiting
  // approval — style it neutrally instead of as an amber warning.
  const isMinimizedQuestionPermission = classifyWaitingNotificationKind(minimizedPermission?.toolName) === WaitingNotificationKind.Question;
  const handleDenyMinimizedPermission = useCallback(() => {
    onRespondToPermission?.({
      behavior: 'deny',
      message: 'Permission denied',
    });
  }, [onRespondToPermission]);

  const clearScrollToBottomSettleTimers = useCallback(() => {
    scrollToBottomSettleTimersRef.current.forEach(timer => clearTimeout(timer));
    scrollToBottomSettleTimersRef.current = [];
  }, []);

  const updateShouldAutoScroll = useCallback((enabled: boolean) => {
    shouldAutoScrollRef.current = enabled;
    setShouldAutoScroll((current) => (current === enabled ? current : enabled));
  }, []);

  const detachAutoScrollForUserIntent = useCallback((source: AutoScrollDetachSource) => {
    const hadScrollToBottomIntent = scrollToBottomIntentRef.current;
    if (userDetachedFromBottomRef.current && !hadScrollToBottomIntent) return;

    userDetachedFromBottomRef.current = true;
    scrollToBottomIntentRef.current = false;
    clearScrollToBottomSettleTimers();
    updateShouldAutoScroll(false);

    const container = scrollContainerRef.current;
    const distanceToBottom = container
      ? Math.max(0, Math.round(container.scrollHeight - container.scrollTop - container.clientHeight))
      : -1;
    logAutoScrollDiagnostic(
      `Auto-scroll detached by user input; session=${currentSession?.id ?? 'unknown'}; source=${source}; distanceToBottom=${distanceToBottom}; cancelledScrollToBottom=${hadScrollToBottomIntent}.`,
    );
  }, [clearScrollToBottomSettleTimers, currentSession?.id, updateShouldAutoScroll]);

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
      const isSecondaryPointer = event.button === SECONDARY_POINTER_BUTTON;
      const isMacContextClick = isMac && event.button === 0 && event.ctrlKey;
      if (isSecondaryPointer || isMacContextClick) {
        logSelectedTextDiagnostic(
          `Preserved assistant selected text for context menu; sourceMessageId=${selectedTextAction.sourceMessageId}; selectedLength=${selectedTextAction.text.length}.`,
        );
        return;
      }
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
  }, [closeSelectedTextAction, isMac, selectedTextAction]);

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
  const [conversationSearchLoadVersion, setConversationSearchLoadVersion] = useState(0);
  const forcedRailTurnReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const conversationSearchNavigationRequestRef = useRef(0);
  const conversationSearchPaginationLockRef = useRef<number | null>(null);
  const conversationSearchLoadingTargetRef = useRef<string | null>(null);
  const conversationSearchFailedTargetRef = useRef<string | null>(null);
  const conversationSearchViewportLockedRef = useRef(false);
  const conversationSearchForcedTurnRef = useRef<number | null>(null);
  const conversationSearchFallbackElementRef = useRef<HTMLElement | null>(null);
  const conversationSearchActiveMatchKeyRef = useRef<string | null>(null);
  const conversationSearchLastNavigatedMatchKeyRef = useRef<string | null>(null);
  const conversationSearchManualViewportMatchKeyRef = useRef<string | null>(null);
  const scrollToBottomRequestRef = useRef(0);
  const [hoveredRailIndex, setHoveredRailIndex] = useState<number | null>(null);
  const [isRailHovered, setIsRailHovered] = useState(false);
  const [railTooltip, setRailTooltip] = useState<{
    railIndex: number;
    top: number;
    right: number;
  } | null>(null);

  const markConversationSearchViewportAsManual = useCallback(() => {
    const activeMatchKey = conversationSearchActiveMatchKeyRef.current;
    if (!conversationSearchViewportLockedRef.current || !activeMatchKey) return;
    if (conversationSearchManualViewportMatchKeyRef.current === activeMatchKey) return;
    conversationSearchManualViewportMatchKeyRef.current = activeMatchKey;
    conversationSearchNavigationRequestRef.current += 1;
    conversationSearchPaginationLockRef.current = null;
    const forcedTurnIndex = conversationSearchForcedTurnRef.current;
    if (forcedTurnIndex !== null) {
      conversationSearchForcedTurnRef.current = null;
      setForcedRailTurnIndex(current => (current === forcedTurnIndex ? null : current));
    }
  }, []);

  // Export states
  const [isExportingImage, setIsExportingImage] = useState(false);
  const [exportImageProgress, setExportImageProgress] = useState<ExportImageProgress | null>(null);
  const isExportingImageRef = useRef(false);
  const exportImageAbortRef = useRef(false);
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
    userDetachedFromBottomRef.current = false;
    isLoadingNewerMessagesRef.current = false;
    newerMessagesLoadRequestRef.current += 1;
    scrollToBottomRequestRef.current += 1;
    conversationSearchManualViewportMatchKeyRef.current = null;
    setIsViewportAtSessionBottom(true);
    updateShouldAutoScroll(true);
  }, [currentSession?.id, updateShouldAutoScroll]);

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

  const handleOpenSelectedTextInSideChat = useCallback(() => {
    if (!selectedTextAction || !currentSession?.id) return;
    const sourceMessageId = selectedTextAction.sourceMessageId;
    const sessionId = currentSession.id;
    const selectedTextSnippet: CoworkSelectedTextSnippet = {
      id: `btw-selected-text-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text: selectedTextAction.text,
      sourceMessageId,
      sourceMessageType: CoworkSelectedTextSource.AssistantMessage,
      sourceId: sourceMessageId,
      sourceType: CoworkSelectedTextSource.AssistantMessage,
      createdAt: Date.now(),
    };
    const shouldAppendToOpenThread = btwThread?.isOpen === true;
    const normalized = resolveCoworkBtwSelectedTextSnippets(
      btwThread?.selectedTextSnippets ?? [],
      [selectedTextSnippet],
      shouldAppendToOpenThread,
    );
    closeSelectedTextAction({ clearSelection: true });
    if (!normalized.success) {
      window.dispatchEvent(new CustomEvent('app:showToast', {
        detail: i18nService.t(SELECTED_TEXT_ERROR_I18N_KEYS[normalized.error]),
      }));
      logDetailDiagnostic(
        `rejected selected assistant text for side chat in session ${sessionId}; `
        + `source is ${sourceMessageId}; reason=${normalized.error}`,
      );
      return;
    }

    dispatch(openBtwThread({
      sessionId,
      selectedTextSnippets: normalized.snippets,
    }));
    reportConversationNavigationAction({
      actionType: 'selected_text_open_side_chat',
      params: {
        ...getConversationControlAnalyticsParams(),
        sourceType: CoworkSelectedTextSource.AssistantMessage,
        selectedTextLengthBucket: bucketLength(selectedTextSnippet.text.length),
        selectedSnippetCount: normalized.snippets.length,
        selectedTextTotalLengthBucket: bucketLength(normalized.snippets.reduce(
          (total, snippet) => total + snippet.text.length,
          0,
        )),
      },
    });
    logDetailDiagnostic(
      `opened side chat from selected assistant text for session ${sessionId}; `
      + `source is ${sourceMessageId}; mode=${shouldAppendToOpenThread ? 'append' : 'replace'}; `
      + `selected excerpts=${normalized.snippets.length}; `
      + `characters=${normalized.snippets.reduce((total, snippet) => total + snippet.text.length, 0)}`,
    );
  }, [
    btwThread?.isOpen,
    btwThread?.selectedTextSnippets,
    closeSelectedTextAction,
    currentSession?.id,
    dispatch,
    getConversationControlAnalyticsParams,
    selectedTextAction,
  ]);

  const handleSubmitBtwDraft = useCallback(() => {
    if (!btwThread || !currentSession?.id) return;
    const selectedTextSnippets = btwThread.selectedTextSnippets ?? [];
    const displayQuestion = normalizeCoworkBtwQuestion(btwThread.draft);
    const composerQuestion = buildCoworkBtwComposerQuestion(
      displayQuestion,
      selectedTextSnippets,
    );
    if (!composerQuestion) {
      window.dispatchEvent(new CustomEvent('app:showToast', {
        detail: i18nService.t('coworkBtwEmptyQuestion'),
      }));
      return;
    }

    const requestQuestion = buildCoworkBtwContextualQuestion(
      btwThread.entries,
      composerQuestion,
    );
    const sessionId = currentSession.id;
    const runId = createCoworkBtwRunId();
    logDetailDiagnostic(
      `submitted side-chat draft for session ${sessionId}; run is ${runId}; `
      + `display characters=${displayQuestion.length}; request characters=${requestQuestion.length}; `
      + `selected excerpts=${selectedTextSnippets.length}; `
      + `previous entries=${btwThread.entries.length}`,
    );
    void coworkService.submitBtw({
      sessionId,
      question: requestQuestion,
      displayQuestion,
      selectedTextSnippets,
      runId,
    }).then((accepted) => {
      if (!accepted) return;
      dispatch(clearBtwComposerIfUnchanged({
        sessionId,
        expectedDraft: btwThread.draft,
        expectedSelectedTextSnippetIds: selectedTextSnippets.map(snippet => snippet.id),
      }));
    });
  }, [btwThread, currentSession?.id, dispatch]);

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
  const [isAgentBrowserPreviewTabOpen, setIsAgentBrowserPreviewTabOpen] = useState(false);
  const [browserDisplayMode, setBrowserDisplayMode] = useState(
    () => normalizeBrowserWebAccessConfig(
      configService.getConfig().browserWebAccess,
    ).displayMode,
  );
  const [hasUnreadAgentBrowserActivity, setHasUnreadAgentBrowserActivity] = useState(false);
  const [isSubagentPreviewTabOpen, setIsSubagentPreviewTabOpen] = useState(false);
  const [isUserAttachmentPreviewTabOpen, setIsUserAttachmentPreviewTabOpen] = useState(false);
  const [userAttachmentPreview, setUserAttachmentPreview] = useState<UserAttachmentPreviewPayload | null>(null);
  const [activeSpecialPreviewTab, setActiveSpecialPreviewTab] = useState<ArtifactSpecialTab>(ArtifactSpecialTab.FileList);
  const [browserPreviewAddress, setBrowserPreviewAddress] = useState('');
  const [browserPreviewUrl, setBrowserPreviewUrl] = useState('');
  const [browserPreviewTitle, setBrowserPreviewTitle] = useState('');
  const [browserLocalServiceContext, setBrowserLocalServiceContext] =
    useState<BrowserLocalServiceContext | null>(null);
  const [localServiceDeploymentRequest, setLocalServiceDeploymentRequest] =
    useState<LocalServiceDeploymentRequest | null>(null);
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
  const [goalStatusBarPortalTarget, setGoalStatusBarPortalTarget] = useState<HTMLDivElement | null>(null);
  const [steerPreviewPortalTarget, setSteerPreviewPortalTarget] = useState<HTMLDivElement | null>(null);
  const previousArtifactPanelOpenRef = useRef(isPanelOpen);
  const fileListPreviewTabOpenBySessionRef = useRef<Record<string, boolean>>({});
  const browserPreviewTabOpenBySessionRef = useRef<Record<string, boolean>>({});
  const agentBrowserPreviewTabOpenBySessionRef = useRef<Record<string, boolean>>({});
  const unreadAgentBrowserActivityBySessionRef = useRef<Record<string, boolean>>({});
  const subagentPreviewTabOpenBySessionRef = useRef<Record<string, boolean>>({});
  const userAttachmentPreviewTabOpenBySessionRef = useRef<Record<string, boolean>>({});
  const userAttachmentPreviewBySessionRef = useRef<Record<string, UserAttachmentPreviewPayload>>({});
  const userAttachmentFocusRequestKeyRef = useRef(0);
  const activeSpecialPreviewTabBySessionRef = useRef<Record<string, ArtifactSpecialTab>>({});
  const browserPreviewAddressBySessionRef = useRef<Record<string, string>>({});
  const browserPreviewUrlBySessionRef = useRef<Record<string, string>>({});
  const browserPreviewTitleBySessionRef = useRef<Record<string, string>>({});
  const browserLocalServiceContextBySessionRef = useRef<Record<string, BrowserLocalServiceContext>>({});
  const browserHtmlPreviewArtifactIdBySessionRef = useRef<Record<string, string>>({});
  const browserHtmlPreviewSessionIdBySessionRef = useRef<Record<string, string>>({});
  const browserHtmlPreviewUrlBySessionRef = useRef<Record<string, string>>({});
  const browserHtmlPreviewRequestIdRef = useRef(0);
  const localServiceDeploymentRequestIdRef = useRef(0);
  const artifactAddButtonRef = useRef<HTMLButtonElement>(null);
  const artifactAddMenuRef = useRef<HTMLDivElement>(null);
  const artifactTabsScrollRef = useRef<HTMLDivElement>(null);
  const contentRowRef = useRef<HTMLDivElement>(null);
  const promptInputAreaRef = useRef<HTMLDivElement>(null);
  const promptContentAnchorRef = useRef<HTMLDivElement>(null);
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
        childCoworkSessionId: run.childCoworkSessionId,
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
  const localServiceProjectResolutionKeysRef = useRef<Map<string, string>>(new Map());
  const localServiceProjectRetryTimersRef = useRef<Map<string, number>>(new Map());
  const autoPreviewHandledTurnIdsRef = useRef<Record<string, Set<string>>>({});
  const autoPreviewArtifactSettleTimerRef = useRef<number | null>(null);
  const previousAutoPreviewSessionIdRef = useRef<string | undefined>(sessionId);
  const previousAutoPreviewStreamingRef = useRef(isStreaming);
  const previousAutoPreviewMessagesLengthRef = useRef(messagesLength);
  const previousAutoPreviewLatestTurnIdRef = useRef<string | null>(null);
  const [autoPreviewPendingTurnId, setAutoPreviewPendingTurnId] = useState<string | null>(null);
  const [artifactAutoPreviewEnabled, setArtifactAutoPreviewEnabled] = useState(
    () => resolveArtifactAutoPreviewEnabled(
      configService.getConfig().artifactAutoPreviewEnabled,
    ),
  );

  const getAutoPreviewHandledTurnIds = useCallback((targetSessionId: string): Set<string> => {
    let handled = autoPreviewHandledTurnIdsRef.current[targetSessionId];
    if (!handled) {
      handled = new Set<string>();
      autoPreviewHandledTurnIdsRef.current[targetSessionId] = handled;
    }
    return handled;
  }, []);

  const clearAutoPreviewArtifactSettleTimer = useCallback(() => {
    if (autoPreviewArtifactSettleTimerRef.current !== null) {
      window.clearTimeout(autoPreviewArtifactSettleTimerRef.current);
      autoPreviewArtifactSettleTimerRef.current = null;
    }
  }, []);

  const setCurrentAutoPreviewPendingTurnId = useCallback((turnId: string | null) => {
    setAutoPreviewPendingTurnId(turnId);
  }, []);

  const markAutoPreviewTurnHandled = useCallback((targetSessionId: string, turnId: string) => {
    clearAutoPreviewArtifactSettleTimer();
    const handledTurnIds = getAutoPreviewHandledTurnIds(targetSessionId);
    handledTurnIds.add(turnId);
    while (handledTurnIds.size > MAX_AUTO_PREVIEW_HANDLED_TURNS) {
      const oldestTurnId = handledTurnIds.values().next().value;
      if (!oldestTurnId) break;
      handledTurnIds.delete(oldestTurnId);
    }
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
    const syncArtifactAutoPreviewSetting = () => {
      const enabled = resolveArtifactAutoPreviewEnabled(
        configService.getConfig().artifactAutoPreviewEnabled,
      );
      if (!enabled) {
        const canceledPendingPreview = autoPreviewArtifactSettleTimerRef.current !== null;
        clearAutoPreviewArtifactSettleTimer();
        setAutoPreviewPendingTurnId(null);
        if (canceledPendingPreview) {
          console.debug('[ArtifactPreview] canceled pending automatic preview: preference disabled.');
        }
      }
      setArtifactAutoPreviewEnabled(enabled);
    };
    window.addEventListener(ConfigServiceEvent.Updated, syncArtifactAutoPreviewSetting);
    return () => {
      window.removeEventListener(ConfigServiceEvent.Updated, syncArtifactAutoPreviewSetting);
    };
  }, [clearAutoPreviewArtifactSettleTimer]);

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

  // Keep the prompt and expanded preview overlay in the same pre-paint layout pass.
  useLayoutEffect(() => {
    updatePromptInputAreaHeight();
  }, [
    currentSession?.id,
    isArtifactPanelExpanded,
    isExpandedConversationPreviewOpen,
    isExpandedPromptInputHidden,
    updatePromptInputAreaHeight,
  ]);

  useLayoutEffect(() => {
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
  }, [currentSession?.id, updatePromptInputAreaHeight]);

  useEffect(() => {
    if (isPanelOpen) return;
    setIsArtifactPanelExpanded(false);
    setIsExpandedPromptInputHidden(false);
    setIsExpandedConversationPreviewOpen(false);
  }, [isPanelOpen]);

  useEffect(() => {
    setIsFileListPreviewTabOpen(sessionId ? fileListPreviewTabOpenBySessionRef.current[sessionId] ?? false : false);
    setIsBrowserPreviewTabOpen(sessionId ? browserPreviewTabOpenBySessionRef.current[sessionId] ?? false : false);
    setIsAgentBrowserPreviewTabOpen(sessionId
      ? agentBrowserPreviewTabOpenBySessionRef.current[sessionId] ?? false
      : false);
    setHasUnreadAgentBrowserActivity(sessionId
      ? unreadAgentBrowserActivityBySessionRef.current[sessionId] ?? false
      : false);
    setIsSubagentPreviewTabOpen(sessionId ? subagentPreviewTabOpenBySessionRef.current[sessionId] ?? false : false);
    setIsUserAttachmentPreviewTabOpen(sessionId ? userAttachmentPreviewTabOpenBySessionRef.current[sessionId] ?? false : false);
    setUserAttachmentPreview(sessionId ? userAttachmentPreviewBySessionRef.current[sessionId] ?? null : null);
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
    localServiceProjectResolutionKeysRef.current = new Map();
    for (const timer of localServiceProjectRetryTimersRef.current.values()) {
      window.clearTimeout(timer);
    }
    localServiceProjectRetryTimersRef.current.clear();
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
      for (const timer of localServiceProjectRetryTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      localServiceProjectRetryTimersRef.current.clear();
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

  const setSessionAgentBrowserPreviewTabOpen = useCallback((open: boolean) => {
    setIsAgentBrowserPreviewTabOpen(open);
    if (sessionId) {
      agentBrowserPreviewTabOpenBySessionRef.current[sessionId] = open;
    }
  }, [sessionId]);

  const setSessionAgentBrowserUnread = useCallback((unread: boolean) => {
    setHasUnreadAgentBrowserActivity(unread);
    if (sessionId) {
      unreadAgentBrowserActivityBySessionRef.current[sessionId] = unread;
    }
  }, [sessionId]);

  const setSessionSubagentPreviewTabOpen = useCallback((open: boolean) => {
    setIsSubagentPreviewTabOpen(open);
    if (sessionId) {
      subagentPreviewTabOpenBySessionRef.current[sessionId] = open;
    }
  }, [sessionId]);

  const setSessionUserAttachmentPreviewTabOpen = useCallback((open: boolean) => {
    setIsUserAttachmentPreviewTabOpen(open);
    if (sessionId) {
      userAttachmentPreviewTabOpenBySessionRef.current[sessionId] = open;
    }
  }, [sessionId]);

  const setSessionUserAttachmentPreview = useCallback((payload: UserAttachmentPreviewPayload) => {
    setUserAttachmentPreview(payload);
    if (sessionId) {
      userAttachmentPreviewBySessionRef.current[sessionId] = payload;
    }
  }, [sessionId]);

  const setSessionActiveSpecialPreviewTab = useCallback((tab: ArtifactSpecialTab) => {
    setActiveSpecialPreviewTab(tab);
    if (sessionId) {
      activeSpecialPreviewTabBySessionRef.current[sessionId] = tab;
    }
  }, [sessionId]);

  useEffect(() => {
    const syncBrowserDisplayMode = () => {
      const mode = normalizeBrowserWebAccessConfig(
        configService.getConfig().browserWebAccess,
      ).displayMode;
      setBrowserDisplayMode(mode);
      if (mode === BrowserDisplayMode.External) {
        agentBrowserPreviewTabOpenBySessionRef.current = {};
        unreadAgentBrowserActivityBySessionRef.current = {};
        setIsAgentBrowserPreviewTabOpen(false);
        setHasUnreadAgentBrowserActivity(false);
      }
    };
    window.addEventListener(ConfigServiceEvent.Updated, syncBrowserDisplayMode);
    return () => window.removeEventListener(ConfigServiceEvent.Updated, syncBrowserDisplayMode);
  }, []);

  useEffect(() => {
    if (browserDisplayMode !== BrowserDisplayMode.InApp) return undefined;
    const browserApi = window.electron?.openclaw?.browser;
    if (!browserApi) return undefined;
    return browserApi.onHostState(event => {
      if (!event.sessionId || event.state.tabs.length === 0) return;
      const wasOpen = agentBrowserPreviewTabOpenBySessionRef.current[event.sessionId] === true;
      agentBrowserPreviewTabOpenBySessionRef.current[event.sessionId] = true;
      if (event.sessionId !== sessionId) {
        unreadAgentBrowserActivityBySessionRef.current[event.sessionId] = true;
        return;
      }
      if (!wasOpen) {
        unreadAgentBrowserActivityBySessionRef.current[event.sessionId] = false;
        setIsAgentBrowserPreviewTabOpen(true);
        setHasUnreadAgentBrowserActivity(false);
        setSessionActiveSpecialPreviewTab(ArtifactSpecialTab.AgentBrowser);
        dispatch(activateArtifactAgentBrowserTab({ sessionId: event.sessionId }));
        return;
      }
      const isActivelyViewing = isPanelOpen
        && !activeArtifactPreviewTab
        && activeSpecialPreviewTab === ArtifactSpecialTab.AgentBrowser;
      unreadAgentBrowserActivityBySessionRef.current[event.sessionId] = !isActivelyViewing;
      setIsAgentBrowserPreviewTabOpen(true);
      setHasUnreadAgentBrowserActivity(!isActivelyViewing);
    });
  }, [
    activeArtifactPreviewTab,
    activeSpecialPreviewTab,
    browserDisplayMode,
    dispatch,
    isPanelOpen,
    sessionId,
    setSessionActiveSpecialPreviewTab,
  ]);

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

  useEffect(() => {
    const artifactId = browserLocalServiceContext?.artifactId;
    if (!artifactId) return;
    const artifact = rawSessionArtifacts.find(item => item.id === artifactId);
    if (artifact?.type !== ArtifactTypeValue.LocalService || !artifact.localService) return;
    const nextMetadataKey = getLocalServiceProjectMetadataKey(
      artifact.localService.projectDirectory,
      artifact.localService.projectCandidates,
    );
    const currentMetadataKey = getLocalServiceProjectMetadataKey(
      browserLocalServiceContext.projectDirectory,
      browserLocalServiceContext.projectCandidates,
    );
    if (nextMetadataKey === currentMetadataKey) return;
    setSessionBrowserLocalServiceContext({
      ...browserLocalServiceContext,
      projectDirectory: artifact.localService.projectDirectory,
      projectCandidates: artifact.localService.projectCandidates,
    });
  }, [
    browserLocalServiceContext,
    rawSessionArtifacts,
    setSessionBrowserLocalServiceContext,
  ]);

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

  useEffect(() => {
    const handleSelectSubagentEvent = (event: Event) => {
      const detail = (event as CustomEvent<SubagentSessionSummary | null>).detail;
      if (!detail) {
        setSelectedSubagent(null);
        return;
      }
      if (!sessionId || detail.parentSessionId !== sessionId) return;
      setSelectedSubagent(detail);
      setSessionSubagentPreviewTabOpen(true);
      setSessionActiveSpecialPreviewTab(ArtifactSpecialTab.Subagents);
      dispatch(activateArtifactSubagentTab({ sessionId }));
      void fetchSubagents(sessionId, { showLoading: subagents.length === 0 });
    };

    window.addEventListener(CoworkUiEvent.SelectSubagent, handleSelectSubagentEvent);
    return () => {
      window.removeEventListener(CoworkUiEvent.SelectSubagent, handleSelectSubagentEvent);
    };
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
    const projectDirectory = artifact.localService?.projectDirectory?.trim();
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
    handleBrowserPreviewAddressChange,
    handleBrowserPreviewTitleChange,
    handleBrowserPreviewUrlChange,
    handleOpenArtifactBrowserTab,
    setSessionBrowserLocalServiceContext,
  ]);

  const handleDeployLocalServiceArtifact = useCallback((artifact: Artifact) => {
    if (!sessionId || artifact.type !== ArtifactTypeValue.LocalService) return;
    const url = (artifact.url || artifact.content || '').trim();

    const requestId = localServiceDeploymentRequestIdRef.current + 1;
    localServiceDeploymentRequestIdRef.current = requestId;
    setLocalServiceDeploymentRequest({
      requestId,
      sessionId,
      artifactId: artifact.id,
      url,
      title: artifact.title,
      projectDirectory: artifact.localService?.projectDirectory,
      projectCandidates: artifact.localService?.projectCandidates,
    });
  }, [sessionId]);

  const handleLocalServiceDeploymentRequestConsumed = useCallback((requestId: number) => {
    setLocalServiceDeploymentRequest(current =>
      current?.requestId === requestId ? null : current,
    );
  }, []);

  useEffect(() => {
    setLocalServiceDeploymentRequest(null);
  }, [sessionId]);

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

    if (isAgentBrowserPreviewTabOpen) {
      setSessionActiveSpecialPreviewTab(ArtifactSpecialTab.AgentBrowser);
      dispatch(activateArtifactAgentBrowserTab({ sessionId }));
      return;
    }

    if (isSubagentPreviewTabOpen) {
      setSessionActiveSpecialPreviewTab(ArtifactSpecialTab.Subagents);
      dispatch(activateArtifactSubagentTab({ sessionId }));
      return;
    }

    if (isUserAttachmentPreviewTabOpen) {
      setSessionActiveSpecialPreviewTab(ArtifactSpecialTab.UserAttachment);
      dispatch(activateArtifactUserAttachmentTab({ sessionId }));
      return;
    }

    dispatch(closePanel({ sessionId }));
  }, [
    activeArtifactPreviewTab,
    activeSpecialPreviewTab,
    artifactTabsWithArtifacts,
    dispatch,
    isAgentBrowserPreviewTabOpen,
    isBrowserPreviewTabOpen,
    isSubagentPreviewTabOpen,
    isUserAttachmentPreviewTabOpen,
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

  const handleActivateArtifactAgentBrowserTab = useCallback(() => {
    if (!sessionId) return;
    reportArtifactPreviewAction({
      actionType: 'panel_tab_switch',
      source: 'artifact_panel',
      params: {
        tabType: 'agent_browser',
        tabCount: artifactTabsWithArtifacts.length,
      },
    });
    setSessionAgentBrowserPreviewTabOpen(true);
    setSessionAgentBrowserUnread(false);
    setSessionActiveSpecialPreviewTab(ArtifactSpecialTab.AgentBrowser);
    dispatch(activateArtifactAgentBrowserTab({ sessionId }));
  }, [
    artifactTabsWithArtifacts.length,
    dispatch,
    sessionId,
    setSessionActiveSpecialPreviewTab,
    setSessionAgentBrowserPreviewTabOpen,
    setSessionAgentBrowserUnread,
  ]);

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

    if (isAgentBrowserPreviewTabOpen) {
      setSessionActiveSpecialPreviewTab(ArtifactSpecialTab.AgentBrowser);
      dispatch(activateArtifactAgentBrowserTab({ sessionId }));
      return;
    }

    if (isSubagentPreviewTabOpen) {
      setSessionActiveSpecialPreviewTab(ArtifactSpecialTab.Subagents);
      dispatch(activateArtifactSubagentTab({ sessionId }));
      return;
    }

    if (isUserAttachmentPreviewTabOpen) {
      setSessionActiveSpecialPreviewTab(ArtifactSpecialTab.UserAttachment);
      dispatch(activateArtifactUserAttachmentTab({ sessionId }));
      return;
    }

    dispatch(closePanel({ sessionId }));
  }, [
    activeArtifactPreviewTab,
    activeSpecialPreviewTab,
    artifactTabsWithArtifacts,
    dispatch,
    clearBrowserPreviewState,
    isAgentBrowserPreviewTabOpen,
    isFileListPreviewTabOpen,
    isSubagentPreviewTabOpen,
    isUserAttachmentPreviewTabOpen,
    sessionId,
    setSessionActiveSpecialPreviewTab,
    setSessionBrowserPreviewTabOpen,
  ]);

  const handleCloseArtifactAgentBrowserTab = useCallback(() => {
    const wasActive = !activeArtifactPreviewTab
      && activeSpecialPreviewTab === ArtifactSpecialTab.AgentBrowser;
    reportArtifactPreviewAction({
      actionType: 'panel_tab_close',
      source: 'artifact_panel',
      params: {
        tabType: 'agent_browser',
        wasActive,
        tabCount: artifactTabsWithArtifacts.length,
      },
    });
    setSessionAgentBrowserPreviewTabOpen(false);
    setSessionAgentBrowserUnread(false);
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
    if (isSubagentPreviewTabOpen) {
      setSessionActiveSpecialPreviewTab(ArtifactSpecialTab.Subagents);
      dispatch(activateArtifactSubagentTab({ sessionId }));
      return;
    }
    if (isUserAttachmentPreviewTabOpen) {
      setSessionActiveSpecialPreviewTab(ArtifactSpecialTab.UserAttachment);
      dispatch(activateArtifactUserAttachmentTab({ sessionId }));
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
    isSubagentPreviewTabOpen,
    isUserAttachmentPreviewTabOpen,
    sessionId,
    setSessionActiveSpecialPreviewTab,
    setSessionAgentBrowserPreviewTabOpen,
    setSessionAgentBrowserUnread,
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

    if (isAgentBrowserPreviewTabOpen) {
      setSessionActiveSpecialPreviewTab(ArtifactSpecialTab.AgentBrowser);
      dispatch(activateArtifactAgentBrowserTab({ sessionId }));
      return;
    }

    if (isUserAttachmentPreviewTabOpen) {
      setSessionActiveSpecialPreviewTab(ArtifactSpecialTab.UserAttachment);
      dispatch(activateArtifactUserAttachmentTab({ sessionId }));
      return;
    }

    dispatch(closePanel({ sessionId }));
  }, [
    activeArtifactPreviewTab,
    activeSpecialPreviewTab,
    artifactTabsWithArtifacts,
    dispatch,
    isAgentBrowserPreviewTabOpen,
    isBrowserPreviewTabOpen,
    isFileListPreviewTabOpen,
    isUserAttachmentPreviewTabOpen,
    sessionId,
    setSessionActiveSpecialPreviewTab,
    setSessionSubagentPreviewTabOpen,
  ]);

  const handleActivateArtifactUserAttachmentTab = useCallback(() => {
    if (!sessionId) return;
    reportArtifactPreviewAction({
      actionType: 'panel_tab_switch',
      source: 'artifact_panel',
      params: {
        tabType: 'user_attachment',
        tabCount: artifactTabsWithArtifacts.length,
      },
    });
    setSessionUserAttachmentPreviewTabOpen(true);
    setSessionActiveSpecialPreviewTab(ArtifactSpecialTab.UserAttachment);
    dispatch(activateArtifactUserAttachmentTab({ sessionId }));
  }, [artifactTabsWithArtifacts.length, dispatch, sessionId, setSessionActiveSpecialPreviewTab, setSessionUserAttachmentPreviewTabOpen]);

  const handleCloseArtifactUserAttachmentTab = useCallback(() => {
    const wasActive = !activeArtifactPreviewTab && activeSpecialPreviewTab === ArtifactSpecialTab.UserAttachment;
    reportArtifactPreviewAction({
      actionType: 'panel_tab_close',
      source: 'artifact_panel',
      params: {
        tabType: 'user_attachment',
        wasActive,
        tabCount: artifactTabsWithArtifacts.length,
      },
    });
    setSessionUserAttachmentPreviewTabOpen(false);
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

    if (isAgentBrowserPreviewTabOpen) {
      setSessionActiveSpecialPreviewTab(ArtifactSpecialTab.AgentBrowser);
      dispatch(activateArtifactAgentBrowserTab({ sessionId }));
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
    isAgentBrowserPreviewTabOpen,
    isBrowserPreviewTabOpen,
    isFileListPreviewTabOpen,
    isSubagentPreviewTabOpen,
    sessionId,
    setSessionActiveSpecialPreviewTab,
    setSessionUserAttachmentPreviewTabOpen,
  ]);

  const handleOpenMessageAnnotation = useCallback((
    message: CoworkMessage,
    payload: BrowserAnnotationAttachmentOpenPayload,
  ) => {
    if (!sessionId) return;
    const metadata = message.metadata as CoworkMessageMetadata | undefined;
    const batches = (metadata?.browserAnnotations ?? []) as CoworkBrowserAnnotationMessageBatch[];
    if (batches.length === 0) return;
    userAttachmentFocusRequestKeyRef.current += 1;
    setSessionUserAttachmentPreview({
      batches,
      focusAnnotationId: payload.annotationId,
      focusRequestKey: userAttachmentFocusRequestKeyRef.current,
    });
    setSessionUserAttachmentPreviewTabOpen(true);
    setSessionActiveSpecialPreviewTab(ArtifactSpecialTab.UserAttachment);
    dispatch(activateArtifactUserAttachmentTab({ sessionId }));
  }, [
    dispatch,
    sessionId,
    setSessionActiveSpecialPreviewTab,
    setSessionUserAttachmentPreview,
    setSessionUserAttachmentPreviewTabOpen,
  ]);

  const handleAnnotationSendRequest = useCallback(() => {
    promptInputRef.current?.submit();
  }, []);

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
    if (
      remainingTabs.length === 0
      && !isFileListPreviewTabOpen
      && !isBrowserPreviewTabOpen
      && !isAgentBrowserPreviewTabOpen
      && !isSubagentPreviewTabOpen
    ) {
      dispatch(closePanel({ sessionId }));
    }
  }, [
    artifactTabsWithArtifacts,
    dispatch,
    isAgentBrowserPreviewTabOpen,
    isBrowserPreviewTabOpen,
    isFileListPreviewTabOpen,
    isSubagentPreviewTabOpen,
    sessionId,
  ]);

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

    if (hasUnreadAgentBrowserActivity && isAgentBrowserPreviewTabOpen) {
      handleActivateArtifactAgentBrowserTab();
      return;
    }

    if (
      artifactTabsWithArtifacts.length === 0
      && !isFileListPreviewTabOpen
      && !isBrowserPreviewTabOpen
      && !isAgentBrowserPreviewTabOpen
      && !isSubagentPreviewTabOpen
    ) {
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
    handleActivateArtifactAgentBrowserTab,
    hasUnreadAgentBrowserActivity,
    isAgentBrowserPreviewTabOpen,
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
    isAgentBrowserPreviewTabOpen,
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
    isAgentBrowserPreviewTabOpen,
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
      const cwd = currentSession.cwd;
      const detected = collectSessionArtifacts(currentSession.messages, sessionId, cwd);

      for (const artifact of detected) {
        if (artifact.type === ArtifactTypeValue.LocalService) {
          dispatch(addArtifact({ sessionId, artifact, defaultProjectDirectory: cwd }));
        }
      }

      const toLoad = detected.filter(a => a.filePath && !loadedFileIdsRef.current.has(a.id));
      if (toLoad.length === 0) return;

      const loadFiles = async () => {
        for (const artifact of toLoad) {
          const loaded = await loadDetectedFileArtifact(artifact, cwd);
          // Mark as loaded either way to avoid retrying missing files.
          loadedFileIdsRef.current.add(artifact.id);
          if (loaded) {
            dispatch(addArtifact({ sessionId, artifact: loaded }));
          }
        }
      };
      loadFiles();
    } catch (err) {
      console.error('[ArtifactDetection] failed:', err);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- uses messagesLength as stable proxy for currentSession.messages
  }, [sessionId, messagesLength, isStreaming, dispatch]);

  useEffect(() => {
    const detectProjectCandidates = window.electron?.shareDeployment?.detectProjectCandidates;
    if (!sessionId || !detectProjectCandidates) return;
    const workingDirectory = currentSession?.cwd || '';
    type DetectProjectCandidatesInput = Parameters<typeof detectProjectCandidates>[0];
    interface PendingResolutionGroup {
      inputKey: string;
      artifactIds: string[];
      request: DetectProjectCandidatesInput;
    }
    const pendingGroups = new Map<string, PendingResolutionGroup>();

    for (const artifact of rawSessionArtifacts) {
      if (artifact.type !== ArtifactTypeValue.LocalService) continue;
      const localServiceUrl = artifact.url || artifact.content;
      if (!localServiceUrl) continue;
      const cachedCandidate = readLocalServiceProjectDirectoryCandidate(sessionId, localServiceUrl);
      const inputKey = getLocalServiceProjectResolutionInputKey(
        artifact,
        workingDirectory,
        cachedCandidate?.directory,
      );
      if (localServiceProjectResolutionKeysRef.current.get(artifact.id) === inputKey) continue;
      localServiceProjectResolutionKeysRef.current.set(artifact.id, inputKey);
      const existingGroup = pendingGroups.get(inputKey);
      if (existingGroup) {
        existingGroup.artifactIds.push(artifact.id);
        continue;
      }
      pendingGroups.set(inputKey, {
        inputKey,
        artifactIds: [artifact.id],
        request: {
          localServiceUrl,
          workingDirectory,
          projectCandidates: getLocalServiceContextCandidates(artifact),
          ...(cachedCandidate?.directory
            ? { cachedProjectDirectory: cachedCandidate.directory }
            : {}),
        },
      });
    }
    if (!pendingGroups.size) return;

    const applyResolution = (
      group: PendingResolutionGroup,
      result: Awaited<ReturnType<typeof detectProjectCandidates>>,
    ) => {
      if (!result?.success || !result.candidates[0]) return;
      for (const artifactId of group.artifactIds) {
        if (localServiceProjectResolutionKeysRef.current.get(artifactId) !== group.inputKey) {
          continue;
        }
        dispatch(updateLocalServiceProjectMetadata({
          sessionId,
          artifactId,
          projectDirectory: result.candidates[0].directory,
          projectCandidates: result.candidates,
        }));
      }
    };

    const scheduleProcessDirectoryRetry = (group: PendingResolutionGroup) => {
      const timerKey = `${sessionId}:${group.inputKey}`;
      if (localServiceProjectRetryTimersRef.current.has(timerKey)) return;
      const timer = window.setTimeout(() => {
        localServiceProjectRetryTimersRef.current.delete(timerKey);
        const hasActiveArtifact = group.artifactIds.some(artifactId =>
          localServiceProjectResolutionKeysRef.current.get(artifactId) === group.inputKey
        );
        if (!hasActiveArtifact) return;
        void detectProjectCandidates(group.request)
          .then(result => {
            applyResolution(group, result);
            if (result?.success && result.candidates[0]) return;
            for (const artifactId of group.artifactIds) {
              if (localServiceProjectResolutionKeysRef.current.get(artifactId) === group.inputKey) {
                localServiceProjectResolutionKeysRef.current.delete(artifactId);
              }
            }
          })
          .catch(() => {
            for (const artifactId of group.artifactIds) {
              if (localServiceProjectResolutionKeysRef.current.get(artifactId) === group.inputKey) {
                localServiceProjectResolutionKeysRef.current.delete(artifactId);
              }
            }
          });
      }, LOCAL_SERVICE_PROCESS_DIRECTORY_RETRY_DELAY_MS);
      localServiceProjectRetryTimersRef.current.set(timerKey, timer);
    };

    void Promise.all(Array.from(pendingGroups.values()).map(async group => {
      try {
        const result = await detectProjectCandidates(group.request);
        return { group, result };
      } catch {
        return { group, result: null };
      }
    })).then(resolutions => {
      for (const { group, result } of resolutions) {
        if (result) applyResolution(group, result);
        const hasProcessDirectory = result?.success && result.candidates.some(candidate =>
          candidate.source === ShareDeploymentCandidateSource.Process ||
          candidate.source === ShareDeploymentCandidateSource.ProcessCwd
        );
        if (!hasProcessDirectory) {
          scheduleProcessDirectoryRetry(group);
        }
      }
    });
  }, [currentSession?.cwd, dispatch, rawSessionArtifacts, sessionId]);

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
          const loaded = await loadDetectedFileArtifact(artifact, cwd);
          // Mark as loaded either way to avoid retrying missing files.
          loadedFileIdsRef.current.add(artifact.id);
          if (loaded) {
            dispatch(addArtifact({ sessionId, artifact: loaded }));
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
    userDetachedFromBottomRef.current = false;
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

  const loadConversationSearchMessagePage = useCallback(async (
    options: {
      offset: number;
      limit: number;
      cursor?: CoworkSearchMessageCursor;
      knownTotal?: number;
    },
  ): Promise<CoworkSearchMessagePage> => {
    const targetSessionId = currentSession?.id;
    if (!targetSessionId) {
      throw new Error('Cannot load conversation search history without a session');
    }
    const result = await window.electron.cowork.getSessionSearchMessages({
      sessionId: targetSessionId,
      offset: options.offset,
      limit: options.limit,
      cursor: options.cursor,
      knownTotal: options.knownTotal,
    });
    if (
      !result.success
      || !result.messages
      || result.offset === undefined
      || result.nextOffset === undefined
      || result.total === undefined
    ) {
      throw new Error(result.error || 'Failed to load conversation search history');
    }
    return {
      messages: result.messages,
      offset: result.offset,
      nextOffset: result.nextOffset,
      nextCursor: result.nextCursor,
      total: result.total,
    };
  }, [currentSession?.id]);

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
        showExportedFileToast(i18nService.t('coworkExportTextSuccess'), result.path);
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

    if (result.success) {
      showExportedFileToast(i18nService.t('coworkExportDiagnosticsSuccess'), result.path);
    } else {
      showToast(result.error || i18nService.t('coworkExportDiagnosticsFailed'));
    }
  }, [currentSession?.id, getConversationControlAnalyticsParams]);

  const handleCancelExportImage = useCallback(() => {
    exportImageAbortRef.current = true;
  }, []);

  const handleShareClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!currentSession || isExportingImage) return;
    if (isSessionBusy) {
      showToast(i18nService.t('coworkExportImageSessionBusy'));
      return;
    }
    const sessionId = currentSession.id;
    const sessionTitle = currentSession.title;
    const sessionCreatedAt = currentSession.createdAt;
    const knownTotalMessages = Math.max(
      currentSession.totalMessages ?? 0,
      currentSession.messages.length,
    );
    setIsExportingImage(true);
    isExportingImageRef.current = true;
    exportImageAbortRef.current = false;
    setExportImageProgress({ phase: 'loading' });
    reportConversationNavigationAction({
      actionType: 'export_image_submit',
      params: getConversationControlAnalyticsParams(),
    });

    void (async () => {
      try {
        const scrollContainer = scrollContainerRef.current;
        if (!scrollContainer) {
          throw new Error('Capture target not found');
        }
        const throwIfAborted = () => {
          if (exportImageAbortRef.current) {
            throw new ExportImageCancelledError();
          }
        };
        const initialDistanceToBottom =
          scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;
        try {
          // Phase 1: bring the whole conversation into the DOM. Sessions are
          // paginated (only a recent window is loaded), so capturing without
          // this exports just the loaded slice of a long conversation.
          if (knownTotalMessages > MAX_EXPORT_MESSAGE_COUNT) {
            throw new ExportImageTooLongError();
          }
          let contentTooLong = false;
          const historyLoaded = await coworkService.loadFullSessionHistory(sessionId, {
            onProgress: (loadedCount, totalCount) => {
              setExportImageProgress({ phase: 'loading', current: loadedCount, total: totalCount });
              if (scrollContainer.scrollHeight > MAX_EXPORT_CANVAS_DIMENSION / MIN_EXPORT_SCALE) {
                contentTooLong = true;
              }
            },
            shouldAbort: () => exportImageAbortRef.current || contentTooLong,
          });
          if (contentTooLong) {
            throw new ExportImageTooLongError();
          }
          throwIfAborted();
          if (!historyLoaded) {
            throw new Error('Failed to load the full conversation history');
          }

          await prepareAllImagesForExport(scrollContainer);
          await waitForStableLayout(scrollContainer);
          throwIfAborted();

          // Phase 2: measure the settled layout. Clamp the rect to the window:
          // capturePage cannot see pixels outside the viewport, and passing an
          // off-screen rect yields clamped chunks that stretch when stitched
          // (e.g. a narrow window where the min-width chat column overflows).
          const boundingRect = scrollContainer.getBoundingClientRect();
          const visibleLeft = Math.max(0, boundingRect.left);
          const visibleTop = Math.max(0, boundingRect.top);
          const scrollRect = domRectToCaptureRect(new DOMRect(
            visibleLeft,
            visibleTop,
            Math.min(boundingRect.right, window.innerWidth) - visibleLeft,
            Math.min(boundingRect.bottom, window.innerHeight) - visibleTop,
          ));
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

          // Phase 3: pick an export scale that keeps the composed canvas
          // inside Chromium's canvas limits. Long conversations degrade to a
          // lower resolution instead of failing; only extreme ones reject.
          const devicePixelRatio = window.devicePixelRatio || 1;
          const composedCssHeight = outputHeight + EXPORT_CHROME_CSS_HEIGHT;
          const composedCssWidth = scrollRect.width + EXPORT_CHROME_CSS_WIDTH;
          const dimensionScale = MAX_EXPORT_CANVAS_DIMENSION / composedCssHeight;
          const areaScale = Math.sqrt(MAX_EXPORT_CANVAS_AREA / (composedCssHeight * composedCssWidth));
          const exportScale = Math.min(devicePixelRatio, dimensionScale, areaScale);
          if (exportScale < MIN_EXPORT_SCALE) {
            throw new ExportImageTooLongError();
          }

          const totalSegments = Math.ceil(outputHeight / Math.max(1, scrollRect.height));
          if (totalSegments + 1 > MAX_EXPORT_SEGMENTS) {
            throw new ExportImageTooLongError();
          }

          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(scrollRect.width * exportScale));
          canvas.height = Math.max(1, Math.round(outputHeight * exportScale));
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

          // Phase 4: scroll through the conversation and stitch the chunks.
          scrollContainer.scrollTop = Math.min(contentStart, Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight));
          await waitForNextFrame();
          await waitForNextFrame();

          let contentOffset = contentStart;
          let capturedSegments = 0;
          while (contentOffset < contentEnd) {
            throwIfAborted();
            capturedSegments += 1;
            if (capturedSegments > MAX_EXPORT_SEGMENTS) {
              throw new Error('Failed to stitch export image');
            }
            setExportImageProgress({
              phase: 'capturing',
              current: Math.min(capturedSegments, totalSegments),
              total: totalSegments,
            });
            const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
            const targetScrollTop = Math.min(contentOffset, maxScrollTop);
            scrollContainer.scrollTop = targetScrollTop;
            await waitForNextFrame();
            await waitForNextFrame();
            await waitForViewportImagesReady(scrollContainer);

            const chunkImage = await captureAndLoad(scrollRect);
            const sourceYOffset = Math.max(0, contentOffset - targetScrollTop);
            const drawableHeight = Math.min(scrollRect.height - sourceYOffset, contentEnd - contentOffset);
            if (drawableHeight <= 0) {
              throw new Error('Failed to stitch export image');
            }
            const chunkDeviceScale = chunkImage.naturalHeight / scrollRect.height;
            const sourceY = sourceYOffset * chunkDeviceScale;
            const sourceHeight = Math.max(1, Math.min(
              chunkImage.naturalHeight - sourceY,
              drawableHeight * chunkDeviceScale,
            ));
            // Snap destination rows to integers via shared edges so adjacent
            // chunks neither overlap nor leave hairline gaps.
            const destTop = Math.round((contentOffset - contentStart) * exportScale);
            const destBottom = Math.round((contentOffset - contentStart + drawableHeight) * exportScale);
            const destHeight = Math.max(1, destBottom - destTop);

            context.drawImage(
              chunkImage,
              0,
              sourceY,
              chunkImage.naturalWidth,
              sourceHeight,
              0,
              destTop,
              canvas.width,
              destHeight,
            );

            contentOffset += drawableHeight;
          }

          throwIfAborted();
          setExportImageProgress({ phase: 'saving' });

          // Compose final canvas with branded header and footer
          const finalCanvas = await composeExportCanvas(
            canvas,
            sessionTitle,
            sessionCreatedAt,
            exportScale,
          );

          const pngDataUrl = finalCanvas.toDataURL('image/png');
          const base64Index = pngDataUrl.indexOf(',');
          if (base64Index < 0 || pngDataUrl.length - base64Index <= 1) {
            throw new Error('Failed to encode export image');
          }

          const timestamp = formatExportTimestamp(new Date());
          const saveResult = await coworkService.saveSessionResultImage({
            pngBase64: pngDataUrl.slice(base64Index + 1),
            defaultFileName: sanitizeExportFileName(`${sessionTitle}-${timestamp}.png`),
          });
          if (saveResult.success && !saveResult.canceled) {
            reportConversationNavigationAction({
              actionType: 'export_image_result',
              params: {
                ...getConversationControlAnalyticsParams(),
                result: 'success',
              },
            });
            showExportedFileToast(i18nService.t('coworkExportImageSuccess'), saveResult.path);
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
          const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
          scrollContainer.scrollTop = Math.max(
            0,
            Math.min(maxScrollTop, maxScrollTop - initialDistanceToBottom),
          );
        }
      } catch (error) {
        if (error instanceof ExportImageCancelledError) {
          reportConversationNavigationAction({
            actionType: 'export_image_result',
            params: {
              ...getConversationControlAnalyticsParams(),
              result: 'cancelled',
            },
          });
          return;
        }
        reportConversationNavigationAction({
          actionType: 'export_image_result',
          params: {
            ...getConversationControlAnalyticsParams(),
            result: 'failed',
          },
        });
        console.error('Failed to export session image:', error);
        showToast(error instanceof ExportImageTooLongError
          ? i18nService.t('coworkExportImageTooLong')
          : i18nService.t('coworkExportImageFailed'));
      } finally {
        setIsExportingImage(false);
        isExportingImageRef.current = false;
        setExportImageProgress(null);
      }
    })();
  };

  const handleMessagesScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const loadedMessageCount = currentSession?.messages.length ?? 0;
    const loadedMessageOffset = currentSession?.messagesOffset ?? 0;
    const totalMessageCount = currentSession?.totalMessages ?? loadedMessageCount;
    const hasLoadedSessionEnd = loadedMessageOffset + loadedMessageCount >= totalMessageCount;
    const nextIsViewportAtSessionBottom = isAtConversationSessionBottom(
      loadedMessageOffset,
      loadedMessageCount,
      totalMessageCount,
      distanceToBottom,
    );
    setIsViewportAtSessionBottom(current => (
      current === nextIsViewportAtSessionBottom ? current : nextIsViewportAtSessionBottom
    ));
    const nextShouldAutoScroll = shouldAutoScrollForPosition(
      distanceToBottom,
      userDetachedFromBottomRef.current,
      conversationSearchViewportLockedRef.current || !hasLoadedSessionEnd,
    );
    if (userDetachedFromBottomRef.current && nextShouldAutoScroll) {
      userDetachedFromBottomRef.current = false;
      logAutoScrollDiagnostic(
        `Auto-scroll reattached at conversation bottom; session=${currentSession?.id ?? 'unknown'}; distanceToBottom=${Math.max(0, Math.round(distanceToBottom))}.`,
      );
    }
    updateShouldAutoScroll(nextShouldAutoScroll);
    // Check if content overflows the container (use functional updater to avoid redundant re-renders)
    const scrollable = container.scrollHeight > container.clientHeight;
    setIsScrollable((prev) => (prev === scrollable ? prev : scrollable));
    if (!scrollable) return;

    const isSearchNavigationActive = conversationSearchPaginationLockRef.current !== null;
    let requestedNewerMessages = false;
    if (!isSearchNavigationActive && shouldLoadNewerConversationMessages(
      loadedMessageOffset,
      loadedMessageCount,
      totalMessageCount,
      distanceToBottom,
      isLoadingNewerMessagesRef.current || isLoadingMoreMessagesRef.current,
    )) {
      const sessionId = currentSession?.id;
      if (sessionId) {
        requestedNewerMessages = true;
        isLoadingNewerMessagesRef.current = true;
        const loadRequestId = ++newerMessagesLoadRequestRef.current;
        logDetailDiagnostic(
          `loading newer messages after scrolling near the bottom for session ${sessionId}; `
          + `current offset is ${loadedMessageOffset}; loaded=${loadedMessageCount}; total=${totalMessageCount}.`,
        );
        void coworkService.loadNewerMessages(sessionId).catch((error: unknown) => {
          console.warn(`[CoworkSessionDetail] failed to load newer messages for session ${sessionId}.`, error);
        }).finally(() => {
          if (loadRequestId === newerMessagesLoadRequestRef.current) {
            isLoadingNewerMessagesRef.current = false;
          }
        });
      }
    }

    // Load older messages when scrolled near the top
    if (
      !isSearchNavigationActive
      && !requestedNewerMessages
      && !isLoadingNewerMessagesRef.current
      && container.scrollTop <= 80
      && !isLoadingMoreMessagesRef.current
    ) {
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
    currentSession?.id,
    currentSession?.messages.length,
    currentSession?.messagesOffset,
    currentSession?.totalMessages,
    updateShouldAutoScroll,
  ]);

  const handleMessagesWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (event.deltaY === 0) return;
    if (isWheelHandledByNestedScroller(event.target, event.currentTarget, event.deltaY)) return;
    markConversationSearchViewportAsManual();
    if (!isWheelScrollingAwayFromBottom(event.deltaY)) return;
    if (userDetachedFromBottomRef.current && !scrollToBottomIntentRef.current) return;
    detachAutoScrollForUserIntent(AutoScrollDetachSource.ConversationWheel);
  }, [detachAutoScrollForUserIntent, markConversationSearchViewportAsManual]);

  const handleScrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const targetSessionId = currentSession?.id;
    const loadedMessageCount = currentSession?.messages.length ?? 0;
    const loadedMessageOffset = currentSession?.messagesOffset ?? 0;
    const totalMessageCount = currentSession?.totalMessages ?? loadedMessageCount;
    const hasLoadedSessionEnd = loadedMessageOffset + loadedMessageCount >= totalMessageCount;
    const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const prefersReducedMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const scrollLogMessage = `Scroll to bottom requested for session ${targetSessionId ?? 'unknown'}; distance was ${Math.max(0, Math.round(distanceToBottom))}px; loadedEnd=${hasLoadedSessionEnd}.`;
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
    const activeSearchMatchKey = conversationSearchActiveMatchKeyRef.current;
    if (conversationSearchViewportLockedRef.current && activeSearchMatchKey) {
      markConversationSearchViewportAsManual();
      clearConversationSearchHighlights();
    }
    const requestId = ++scrollToBottomRequestRef.current;
    const scrollLoadedWindowToBottom = () => {
      if (requestId !== scrollToBottomRequestRef.current) return;
      const latestContainer = scrollContainerRef.current;
      if (!latestContainer) return;

      clearScrollToBottomSettleTimers();
      userDetachedFromBottomRef.current = false;
      scrollToBottomIntentRef.current = true;
      if (prefersReducedMotion) {
        updateShouldAutoScroll(!conversationSearchViewportLockedRef.current);
      }
      latestContainer.scrollTo({
        top: latestContainer.scrollHeight,
        behavior: prefersReducedMotion ? 'auto' : 'smooth',
      });
      const lastRail = railItemCountRef.current > 0 ? railItemCountRef.current - 1 : -1;
      currentRailIndexRef.current = lastRail;
      setCurrentRailIndex(lastRail);
      SCROLL_TO_BOTTOM_SETTLE_DELAYS_MS.forEach((delayMs, index) => {
        const timer = setTimeout(() => {
          if (!scrollToBottomIntentRef.current || requestId !== scrollToBottomRequestRef.current) return;
          const settledContainer = scrollContainerRef.current;
          if (!settledContainer) return;
          const latestDistance = settledContainer.scrollHeight
            - settledContainer.scrollTop
            - settledContainer.clientHeight;
          const isFinalSettleCheck = index === SCROLL_TO_BOTTOM_SETTLE_DELAYS_MS.length - 1;
          if (latestDistance <= SCROLL_TO_BOTTOM_SETTLE_THRESHOLD && isFinalSettleCheck) {
            scrollToBottomIntentRef.current = false;
            clearScrollToBottomSettleTimers();
            setIsViewportAtSessionBottom(true);
            updateShouldAutoScroll(!conversationSearchViewportLockedRef.current);
            return;
          }
          if (latestDistance <= SCROLL_TO_BOTTOM_SETTLE_THRESHOLD) return;
          settledContainer.scrollTo({
            top: settledContainer.scrollHeight,
            behavior: prefersReducedMotion || isFinalSettleCheck
              ? 'auto'
              : 'smooth',
          });
          if (isFinalSettleCheck) {
            window.requestAnimationFrame(() => {
              if (requestId !== scrollToBottomRequestRef.current) return;
              scrollToBottomIntentRef.current = false;
              clearScrollToBottomSettleTimers();
              setIsViewportAtSessionBottom(true);
              updateShouldAutoScroll(!conversationSearchViewportLockedRef.current);
            });
          }
        }, delayMs);
        scrollToBottomSettleTimersRef.current.push(timer);
      });
    };

    if (!targetSessionId || totalMessageCount <= 0 || hasLoadedSessionEnd) {
      scrollLoadedWindowToBottom();
      return;
    }

    clearScrollToBottomSettleTimers();
    scrollToBottomIntentRef.current = false;
    updateShouldAutoScroll(false);
    logRailNavigationDiagnostic(
      `loading final message window before scrolling to session bottom; offset=${loadedMessageOffset}; loaded=${loadedMessageCount}; total=${totalMessageCount}.`,
    );
    void coworkService.loadMessageWindowAroundIndex(
      targetSessionId,
      totalMessageCount - 1,
    ).then((loaded) => {
      if (requestId !== scrollToBottomRequestRef.current) return;
      if (!loaded) {
        console.warn(`[CoworkSessionDetail] failed to load the final message window for session ${targetSessionId}.`);
        return;
      }
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(scrollLoadedWindowToBottom);
      });
    }).catch((error: unknown) => {
      if (requestId !== scrollToBottomRequestRef.current) return;
      console.error(`[CoworkSessionDetail] failed to scroll session ${targetSessionId} to the real bottom.`, error);
    });
  }, [
    clearScrollToBottomSettleTimers,
    currentSession?.id,
    currentSession?.messages.length,
    currentSession?.messagesOffset,
    currentSession?.totalMessages,
    isStreaming,
    markConversationSearchViewportAsManual,
    updateShouldAutoScroll,
  ]);

  const handleScrollToBottomWheel = useCallback((event: React.WheelEvent<HTMLButtonElement>) => {
    const container = scrollContainerRef.current;
    if (!container) return;
    if (event.deltaY !== 0) {
      markConversationSearchViewportAsManual();
    }
    if (isWheelScrollingAwayFromBottom(event.deltaY)) {
      detachAutoScrollForUserIntent(AutoScrollDetachSource.ScrollToBottomControlWheel);
    }
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
  }, [detachAutoScrollForUserIntent, markConversationSearchViewportAsManual]);

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

  // Extend the active window if its content does not fill the viewport, because
  // no scroll event can reach either pagination edge in that state.
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const sessionId = currentSession?.id;
    const offset = currentSession?.messagesOffset ?? 0;
    const loadedCount = currentSession?.messages.length ?? 0;
    const totalMessages = currentSession?.totalMessages ?? loadedCount;
    if (!sessionId || container.scrollHeight > container.clientHeight) return;
    if (offset > 0 && !isLoadingMoreMessagesRef.current) {
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
      return;
    }
    if (offset + loadedCount < totalMessages && !isLoadingNewerMessagesRef.current) {
      isLoadingNewerMessagesRef.current = true;
      const loadRequestId = ++newerMessagesLoadRequestRef.current;
      logDetailDiagnostic(
        `auto-loading newer messages because session ${sessionId} content height ${container.scrollHeight} `
        + `does not exceed viewport height ${container.clientHeight}; current offset is ${offset}.`,
      );
      void coworkService.loadNewerMessages(sessionId).catch((error: unknown) => {
        console.warn(`[CoworkSessionDetail] failed to auto-load newer messages for session ${sessionId}.`, error);
      }).finally(() => {
        if (loadRequestId === newerMessagesLoadRequestRef.current) {
          isLoadingNewerMessagesRef.current = false;
        }
      });
    }
  }, [
    currentSession?.id,
    currentSession?.messages.length,
    currentSession?.messagesOffset,
    currentSession?.totalMessages,
  ]);

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
      updateShouldAutoScroll(false);
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
  }, [currentSession?.id, currentSession?.messages.length, currentSession?.totalMessages, isStreaming, updateShouldAutoScroll]);

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


  const messages = currentSession?.messages;
  const isNewUserWelcomeSession = useMemo(() => (
    messages?.some(message => message.metadata?.kind === CoworkOnboardingMessageKind.NewUserWelcome) ?? false
  ), [messages]);
  const displayItems = useMemo(() => messages ? buildDisplayItems(messages) : [], [messages]);
  const turns = useMemo(() => buildConversationTurns(displayItems), [displayItems]);
  const enterpriseQuotaSignal = useMemo(
    () => findCurrentEnterpriseQuotaSignal(currentSession, currentMessagesWithDetachedTail),
    [currentMessagesWithDetachedTail, currentSession],
  );
  const sessionModelSelection = useMemo(() => resolveAgentModelSelection({
    sessionModel: currentSession?.modelOverride,
    agentModel: currentAgent?.model ?? '',
    availableModels,
    fallbackModel: currentAgentSelectedModel,
    engine: coworkAgentEngine,
  }), [
    availableModels,
    coworkAgentEngine,
    currentAgent?.model,
    currentAgentSelectedModel,
    currentSession?.modelOverride,
  ]);
  const activeEnterpriseQuotaSignal = useMemo(
    () => resolveActiveEnterpriseQuotaSignal(
      enterpriseQuotaSignal,
      enterpriseAccountContext,
      sessionModelSelection.hasInvalidExplicitModel
        ? null
        : sessionModelSelection.selectedModel,
    ),
    [
      enterpriseAccountContext,
      enterpriseQuotaSignal,
      sessionModelSelection.hasInvalidExplicitModel,
      sessionModelSelection.selectedModel,
    ],
  );
  const enterpriseQuotaPromptMessageId = enterpriseAccountContext
    ? enterpriseQuotaSignal?.messageId ?? null
    : null;
  const {
    isOpen: isConversationSearchOpen,
    query: conversationSearchQuery,
    status: conversationSearchStatus,
    errorReason: conversationSearchErrorReason,
    matches: conversationSearchMatches,
    isResultLimitReached: isConversationSearchResultLimitReached,
    activeMatch: activeConversationSearchMatch,
    activeMatchIndex: activeConversationSearchMatchIndex,
    focusRequestKey: conversationSearchFocusRequestKey,
    open: openConversationSearch,
    close: closeConversationSearch,
    setQuery: setConversationSearchQuery,
    navigate: navigateConversationSearch,
  } = useCoworkConversationSearch({
    sessionId,
    currentMessages: currentMessagesWithDetachedTail,
    currentTotalMessages: currentSession?.totalMessages,
    loadMessagePage: loadConversationSearchMessagePage,
  });
  conversationSearchViewportLockedRef.current = isConversationSearchOpen;
  const activeConversationSearchMatchKey = activeConversationSearchMatch?.key ?? null;
  const activeConversationSearchMessageId = activeConversationSearchMatch?.messageId ?? null;
  const activeConversationSearchAbsoluteIndex = activeConversationSearchMatch?.absoluteMessageIndex ?? -1;
  const activeConversationSearchSessionId = currentSession?.id;
  conversationSearchActiveMatchKeyRef.current = activeConversationSearchMatchKey;
  const isActiveConversationSearchMessageLoaded = useMemo(() => (
    activeConversationSearchMessageId !== null
      && Boolean(currentSession?.messages.some(
        message => message.id === activeConversationSearchMessageId,
      ))
  ), [activeConversationSearchMessageId, currentSession?.messages]);
  const activeConversationSearchTurnIndex = useMemo(() => {
    if (!activeConversationSearchMessageId) return -1;
    return turns.findIndex(turn => (
      getTurnMessageIds(turn).has(activeConversationSearchMessageId)
    ));
  }, [activeConversationSearchMessageId, turns]);
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

  const clearConversationSearchPresentation = useCallback(() => {
    conversationSearchNavigationRequestRef.current += 1;
    conversationSearchPaginationLockRef.current = null;
    clearConversationSearchHighlights();
    conversationSearchFallbackElementRef.current?.classList.remove(
      'cowork-conversation-search-fallback',
    );
    conversationSearchFallbackElementRef.current = null;
    conversationSearchLoadingTargetRef.current = null;
    conversationSearchFailedTargetRef.current = null;
    conversationSearchLastNavigatedMatchKeyRef.current = null;
    conversationSearchManualViewportMatchKeyRef.current = null;
    const forcedTurnIndex = conversationSearchForcedTurnRef.current;
    if (forcedTurnIndex !== null) {
      setForcedRailTurnIndex(current => current === forcedTurnIndex ? null : current);
      conversationSearchForcedTurnRef.current = null;
    }
  }, []);

  const handleOpenConversationSearch = useCallback(() => {
    if (!sessionId) return;
    if (!isConversationSearchOpen) {
      if (forcedRailTurnReleaseTimerRef.current) {
        clearTimeout(forcedRailTurnReleaseTimerRef.current);
        forcedRailTurnReleaseTimerRef.current = null;
      }
      setForcedRailTurnIndex(null);
      conversationSearchForcedTurnRef.current = null;
    }
    userDetachedFromBottomRef.current = true;
    scrollToBottomIntentRef.current = false;
    clearScrollToBottomSettleTimers();
    updateShouldAutoScroll(false);
    setIsArtifactPanelExpanded(false);
    setIsExpandedPromptInputHidden(false);
    setIsExpandedConversationPreviewOpen(false);
    setShowArtifactAddMenu(false);
    openConversationSearch();
  }, [
    clearScrollToBottomSettleTimers,
    isConversationSearchOpen,
    openConversationSearch,
    sessionId,
    updateShouldAutoScroll,
  ]);

  useEffect(() => {
    window.addEventListener(
      CoworkUiEvent.ShortcutConversationSearch,
      handleOpenConversationSearch,
    );
    return () => {
      window.removeEventListener(
        CoworkUiEvent.ShortcutConversationSearch,
        handleOpenConversationSearch,
      );
    };
  }, [handleOpenConversationSearch]);

  useEffect(() => {
    if (isConversationSearchOpen) return undefined;
    clearConversationSearchPresentation();
    const frameId = window.requestAnimationFrame(handleMessagesScroll);
    return () => window.cancelAnimationFrame(frameId);
  }, [
    clearConversationSearchPresentation,
    handleMessagesScroll,
    isConversationSearchOpen,
  ]);

  useEffect(() => () => {
    conversationSearchNavigationRequestRef.current += 1;
    conversationSearchPaginationLockRef.current = null;
    conversationSearchLoadingTargetRef.current = null;
    conversationSearchFailedTargetRef.current = null;
    conversationSearchActiveMatchKeyRef.current = null;
    conversationSearchLastNavigatedMatchKeyRef.current = null;
    conversationSearchManualViewportMatchKeyRef.current = null;
    clearConversationSearchHighlights();
    conversationSearchFallbackElementRef.current?.classList.remove(
      'cowork-conversation-search-fallback',
    );
  }, []);

  useEffect(() => {
    const requestId = ++conversationSearchNavigationRequestRef.current;
    let frameId: number | null = null;
    let secondFrameId: number | null = null;
    let cancelSettleChecks: (() => void) | null = null;

    const releasePaginationLock = () => {
      if (conversationSearchPaginationLockRef.current === requestId) {
        conversationSearchPaginationLockRef.current = null;
      }
    };

    conversationSearchFallbackElementRef.current?.classList.remove(
      'cowork-conversation-search-fallback',
    );
    conversationSearchFallbackElementRef.current = null;

    if (
      !isConversationSearchOpen
      || !conversationSearchQuery.trim()
      || !activeConversationSearchMatchKey
      || !activeConversationSearchMessageId
      || !activeConversationSearchSessionId
    ) {
      conversationSearchPaginationLockRef.current = null;
      clearConversationSearchHighlights();
      conversationSearchLastNavigatedMatchKeyRef.current = null;
      conversationSearchManualViewportMatchKeyRef.current = null;
      const forcedTurnIndex = conversationSearchForcedTurnRef.current;
      if (forcedTurnIndex !== null) {
        setForcedRailTurnIndex(current => current === forcedTurnIndex ? null : current);
        conversationSearchForcedTurnRef.current = null;
      }
      return undefined;
    }

    if (
      conversationSearchManualViewportMatchKeyRef.current
      && conversationSearchManualViewportMatchKeyRef.current !== activeConversationSearchMatchKey
    ) {
      conversationSearchManualViewportMatchKeyRef.current = null;
    }
    if (conversationSearchManualViewportMatchKeyRef.current === activeConversationSearchMatchKey) {
      conversationSearchPaginationLockRef.current = null;
      return undefined;
    }

    conversationSearchPaginationLockRef.current = requestId;

    userDetachedFromBottomRef.current = true;
    scrollToBottomIntentRef.current = false;
    clearScrollToBottomSettleTimers();
    updateShouldAutoScroll(false);

    if (!isActiveConversationSearchMessageLoaded) {
      const forcedTurnIndex = conversationSearchForcedTurnRef.current;
      if (forcedTurnIndex !== null) {
        setForcedRailTurnIndex(current => current === forcedTurnIndex ? null : current);
        conversationSearchForcedTurnRef.current = null;
      }
      if (conversationSearchFailedTargetRef.current === activeConversationSearchMatchKey) {
        releasePaginationLock();
        return undefined;
      }
      if (conversationSearchLoadingTargetRef.current) return undefined;
      const targetMatchKey = activeConversationSearchMatchKey;
      const isTargetRequestCurrent = () => (
        requestId === conversationSearchNavigationRequestRef.current
        && conversationSearchViewportLockedRef.current
        && conversationSearchActiveMatchKeyRef.current === targetMatchKey
        && conversationSearchManualViewportMatchKeyRef.current !== targetMatchKey
      );
      conversationSearchLoadingTargetRef.current = targetMatchKey;
      logConversationSearchDebug(
        `Loading message window for search target; absoluteIndex=${activeConversationSearchAbsoluteIndex}.`,
      );
      void coworkService.loadMessageWindowAroundIndex(
        activeConversationSearchSessionId,
        activeConversationSearchAbsoluteIndex,
        {
          expectedMessageId: activeConversationSearchMessageId,
          isRequestCurrent: isTargetRequestCurrent,
        },
      ).then(loaded => {
        const targetIsStillActive = isTargetRequestCurrent();
        if (!loaded) {
          if (targetIsStillActive) {
            conversationSearchFailedTargetRef.current = targetMatchKey;
            logConversationSearchWarning('Target message window was unavailable.');
            window.dispatchEvent(new CustomEvent('app:showToast', {
              detail: i18nService.t('coworkConversationSearchTargetUnavailable'),
            }));
          }
          releasePaginationLock();
          return;
        }
        if (targetIsStillActive) {
          logConversationSearchDebug('Loaded message window for active search target.');
        }
      }).catch((error: unknown) => {
        if (conversationSearchActiveMatchKeyRef.current === targetMatchKey) {
          conversationSearchFailedTargetRef.current = targetMatchKey;
          logConversationSearchWarning('Failed to load target message window.', error);
          window.dispatchEvent(new CustomEvent('app:showToast', {
            detail: i18nService.t('coworkConversationSearchTargetUnavailable'),
          }));
        }
        releasePaginationLock();
      }).finally(() => {
        if (conversationSearchLoadingTargetRef.current === targetMatchKey) {
          conversationSearchLoadingTargetRef.current = null;
          setConversationSearchLoadVersion(value => value + 1);
        }
      });
      return undefined;
    }

    conversationSearchLoadingTargetRef.current = null;
    conversationSearchFailedTargetRef.current = null;
    const targetTurnIndex = activeConversationSearchTurnIndex;
    if (targetTurnIndex < 0) {
      releasePaginationLock();
      logConversationSearchWarning(
        `Loaded search target could not be mapped to a conversation turn; absoluteIndex=${activeConversationSearchAbsoluteIndex}.`,
      );
      return undefined;
    }

    conversationSearchForcedTurnRef.current = targetTurnIndex;
    setForcedRailTurnIndex(targetTurnIndex);

    let settledActiveRange: Range | null = null;
    const getCurrentTargetRect = (): DOMRect | null => {
      const container = scrollContainerRef.current;
      if (!container) return null;
      if (
        settledActiveRange
        && container.contains(settledActiveRange.commonAncestorContainer)
      ) {
        const existingRangeRect = settledActiveRange.getBoundingClientRect();
        if (isUsableConversationSearchRect(existingRangeRect)) {
          return existingRangeRect;
        }
      }
      const result = applyConversationSearchHighlights(
        container,
        conversationSearchQuery,
        conversationSearchMatches,
        activeConversationSearchMatchKey,
      );
      settledActiveRange = result.activeRange;
      const rangeRect = result.activeRange?.getBoundingClientRect();
      if (rangeRect && isUsableConversationSearchRect(rangeRect)) {
        conversationSearchFallbackElementRef.current?.classList.remove(
          'cowork-conversation-search-fallback',
        );
        conversationSearchFallbackElementRef.current = null;
        return rangeRect;
      }
      const fallbackElement = result.activeElement ?? turnElsCacheRef.current[targetTurnIndex];
      if (fallbackElement) {
        conversationSearchFallbackElementRef.current?.classList.remove(
          'cowork-conversation-search-fallback',
        );
        fallbackElement.classList.add('cowork-conversation-search-fallback');
        conversationSearchFallbackElementRef.current = fallbackElement;
      }
      return null;
    };

    const scheduleSettleChecks = () => {
      cancelSettleChecks?.();
      cancelSettleChecks = scheduleConversationSearchSettle({
        isCurrent: () => (
          requestId === conversationSearchNavigationRequestRef.current
          && conversationSearchManualViewportMatchKeyRef.current !== activeConversationSearchMatchKey
        ),
        getContainer: () => scrollContainerRef.current,
        getTargetRect: getCurrentTargetRect,
        onSettled: ({ correctionCount, observedDelta }) => {
          logConversationSearchDebug(
            `Settled active search target; result=${activeConversationSearchMatchIndex + 1}/${conversationSearchMatches.length}; absoluteIndex=${activeConversationSearchAbsoluteIndex}; corrections=${correctionCount}; observedDelta=${Math.round(observedDelta)}.`,
          );
        },
        onTargetUnavailable: () => {
          logConversationSearchWarning(
            `Active search target had no visible geometry after settling; absoluteIndex=${activeConversationSearchAbsoluteIndex}.`,
          );
        },
        onError: (error) => {
          logConversationSearchWarning(
            `Failed to settle active search target; absoluteIndex=${activeConversationSearchAbsoluteIndex}.`,
            error,
          );
        },
        onRelease: releasePaginationLock,
      });
    };

    const locateTarget = (attempt: number) => {
      if (requestId !== conversationSearchNavigationRequestRef.current) return;
      const container = scrollContainerRef.current;
      if (!container) {
        releasePaginationLock();
        return;
      }

      const result = applyConversationSearchHighlights(
        container,
        conversationSearchQuery,
        conversationSearchMatches,
        activeConversationSearchMatchKey,
      );

      const rangeRect = result.activeRange?.getBoundingClientRect();
      const hasUsableRange = Boolean(rangeRect && isUsableConversationSearchRect(rangeRect));
      if ((!result.activeElement || (result.activeRange && !hasUsableRange)) && attempt < 10) {
        frameId = window.requestAnimationFrame(() => locateTarget(attempt + 1));
        return;
      }

      if (!result.activeElement) {
        const fallbackTurn = turnElsCacheRef.current[targetTurnIndex];
        if (!fallbackTurn) {
          releasePaginationLock();
          logConversationSearchWarning(
            `Active search target turn was unavailable; absoluteIndex=${activeConversationSearchAbsoluteIndex}.`,
          );
          return;
        }
        fallbackTurn.classList.add('cowork-conversation-search-fallback');
        conversationSearchFallbackElementRef.current = fallbackTurn;
        const shouldScroll = conversationSearchLastNavigatedMatchKeyRef.current
          !== activeConversationSearchMatchKey;
        conversationSearchLastNavigatedMatchKeyRef.current = activeConversationSearchMatchKey;
        if (shouldScroll) {
          logConversationSearchDebug('Using turn-level fallback for search target navigation.');
          fallbackTurn.scrollIntoView({
            behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
            block: 'center',
          });
        }
        scheduleSettleChecks();
        return;
      }

      if (!result.activeRange || !rangeRect || !hasUsableRange) {
        settledActiveRange = null;
        result.activeElement.classList.add('cowork-conversation-search-fallback');
        conversationSearchFallbackElementRef.current = result.activeElement;
        const shouldScroll = conversationSearchLastNavigatedMatchKeyRef.current
          !== activeConversationSearchMatchKey;
        conversationSearchLastNavigatedMatchKeyRef.current = activeConversationSearchMatchKey;
        if (shouldScroll) {
          logConversationSearchDebug('Using message-level fallback for search target navigation.');
          result.activeElement.scrollIntoView({
            behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
            block: 'center',
          });
        }
        scheduleSettleChecks();
        return;
      }

      settledActiveRange = result.activeRange;
      const shouldScroll = conversationSearchLastNavigatedMatchKeyRef.current
        !== activeConversationSearchMatchKey;
      conversationSearchLastNavigatedMatchKeyRef.current = activeConversationSearchMatchKey;
      if (shouldScroll) {
        const delta = getConversationSearchCenterDelta(
          container.getBoundingClientRect(),
          container.clientHeight,
          rangeRect,
        );
        const shouldReduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const behavior: ScrollBehavior = shouldReduceMotion || Math.abs(delta) > container.clientHeight * 2
          ? 'auto'
          : 'smooth';
        container.scrollTo({ top: container.scrollTop + delta, behavior });
        logConversationSearchDebug(
          `Started active search target navigation; result=${activeConversationSearchMatchIndex + 1}/${conversationSearchMatches.length}; absoluteIndex=${activeConversationSearchAbsoluteIndex}; attempt=${attempt}; behavior=${behavior}.`,
        );
      }
      scheduleSettleChecks();
    };

    frameId = window.requestAnimationFrame(() => {
      secondFrameId = window.requestAnimationFrame(() => locateTarget(0));
    });

    return () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      if (secondFrameId !== null) window.cancelAnimationFrame(secondFrameId);
      cancelSettleChecks?.();
      releasePaginationLock();
    };
  }, [
    activeConversationSearchAbsoluteIndex,
    activeConversationSearchMatchKey,
    activeConversationSearchMatchIndex,
    activeConversationSearchMessageId,
    activeConversationSearchSessionId,
    activeConversationSearchTurnIndex,
    clearScrollToBottomSettleTimers,
    conversationSearchLoadVersion,
    conversationSearchMatches,
    conversationSearchQuery,
    isActiveConversationSearchMessageLoaded,
    isConversationSearchOpen,
    updateShouldAutoScroll,
  ]);

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
    if (!artifactAutoPreviewEnabled) {
      clearAutoPreviewArtifactSettleTimer();
      setCurrentAutoPreviewPendingTurnId(null);
      return;
    }
    setCurrentAutoPreviewPendingTurnId(latestAssistantTurn.id);
  }, [
    artifactAutoPreviewEnabled,
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

    if (!artifactAutoPreviewEnabled) {
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
      if (!resolveArtifactAutoPreviewEnabled(
        configService.getConfig().artifactAutoPreviewEnabled,
      )) {
        setCurrentAutoPreviewPendingTurnId(null);
        console.debug('[ArtifactPreview] skipped automatic preview: preference disabled.');
        return;
      }

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
    artifactAutoPreviewEnabled,
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
    if (isExportingImageRef.current) {
      // The image exporter owns the scroll position while it stitches chunks.
      return;
    }
    if (isNavigatingRef.current) {
      return;
    }
    if (!shouldAutoScrollRef.current) {
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
  const showPromptAuxiliaryBars = !remoteManaged && !(isArtifactPanelExpanded && isExpandedPromptInputHidden);
  const showExternalGoalStatusBar = Boolean(currentSession.goal && showPromptAuxiliaryBars);
  const showExternalSteerPreview = queuedSteerCount > 0 && showPromptAuxiliaryBars;
  const artifactPanelInnerWidth = artifactPanelIsOverlay ? '100%' : artifactPanelFrameWidth;
  const shouldShowTurnNavigationRail = railItems.length > 1 && isScrollable;
  const shouldShowScrollToBottom = isScrollable && (
    !isViewportAtSessionBottom
    || (!shouldAutoScroll && !isConversationSearchOpen)
  );
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
      if (!isSessionBusy) return null;
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
            showActivityIndicator
            activityStatusOverride={
              isContextMaintenance ? i18nService.t('coworkContextMaintenanceRunning') : null
            }
            showCopyButtons={!isStreaming}
            completedGoal={
              currentSession.goal?.status === CoworkGoalStatus.Complete
                ? currentSession.goal
                : null
            }
            planConfirmationMessageId={planConfirmationMessageId}
            onConfirmPlan={handleConfirmPlan}
            onAdjustPlan={handleAdjustPlan}
            searchTargetMessageId={activeConversationSearchMatch?.messageId}
            isStreamingTurn
          />
        </div>
      );
    }

    return turns.map((turn, index) => {
      const isLastTurn = index === turns.length - 1;
      // Persistent busy-state indicator at the insertion point of the
      // running turn (Codex/ChatGPT style: visible for the whole run).
      const showActivityIndicator = isSessionBusy && isLastTurn;
      const showAssistantBlock = turn.assistantItems.length > 0 || showActivityIndicator;
      // Always render last 3 turns (needed for streaming, auto-scroll, and smooth UX).
      // While exporting the conversation image, force-render every turn:
      // lazy placeholders have no export anchors and capture as blank blocks.
      const alwaysRender = index >= turns.length - 3
        || index === forcedRailTurnIndex
        || isExportingImage;

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
      // Subagents spawned in this turn that are still working keep the
      // turn's process unfolded until they finish.
      const turnHasRunningSubagents = turn.assistantItems.some(
        item => item.type === 'tool_group'
          && getToolGroupSubagents(item.group).some(subagent => subagent.status === 'running'),
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
                sessionId={sessionId}
                onReEdit={remoteManaged ? undefined : handleReEdit}
                onLocateSelectedText={handleLocateSelectedText}
                onOpenAnnotation={handleOpenMessageAnnotation}
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
                onDeployLocalService={handleDeployLocalServiceArtifact}
                onOpenHtmlFile={handleOpenHtmlFileInBrowser}
                onForkMessage={remoteManaged ? undefined : handleForkMessage}
                renderToolGroupOverride={(group) => {
                  const groupSubagents = getToolGroupSubagents(group);
                  if (groupSubagents.length === 0) return null;
                  return (
                    <SubagentSpawnCard
                      subagents={groupSubagents}
                      onSelectSubagent={handleSelectSubagent}
                    />
                  );
                }}
                showActivityIndicator={showActivityIndicator}
                activityStatusOverride={
                  isContextMaintenance ? i18nService.t('coworkContextMaintenanceRunning') : null
                }
                showCopyButtons={!isStreaming || !isLastTurn}
                hiddenSystemMessageId={enterpriseQuotaPromptMessageId}
                completedGoal={
                  isLastTurn && currentSession.goal?.status === CoworkGoalStatus.Complete
                    ? currentSession.goal
                    : null
                }
                planConfirmationMessageId={planConfirmationMessageId}
                onConfirmPlan={handleConfirmPlan}
                onAdjustPlan={handleAdjustPlan}
                searchTargetMessageId={activeConversationSearchMatch?.messageId}
                isStreamingTurn={isStreaming && isLastTurn}
                hasRunningSubagents={turnHasRunningSubagents}
              />
            </div>
          )}
        </LazyRenderTurn>
      );
    });
  };

  return (
    <ArtifactFileShareProvider sessionId={currentSession.id}>
      <div className="flex-1 flex flex-col h-full overflow-hidden">
      {/* Header — spans full width */}
      <div
        data-skin-session-titlebar="true"
        className={`draggable relative z-30 flex h-12 shrink-0 items-center justify-between overflow-visible border-b border-border bg-background ${
          isArtifactPanelExpanded ? 'pl-0 pr-4' : 'px-4'
        }`}
      >
        {/* Left side: Toggle buttons (when collapsed) + Title */}
        <div className="flex h-full flex-1 items-center gap-2 min-w-0">
          {isSidebarCollapsed && !isWindows && (
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
          <h1 className="text-sm leading-5 font-medium text-foreground truncate max-w-[360px]">
            {getSessionTitleForDisplay(currentSession.title) || i18nService.t('coworkNewSession')}
          </h1>
        </div>

        {isConversationSearchOpen ? (
          <CoworkConversationSearch
            query={conversationSearchQuery}
            status={conversationSearchStatus}
            errorReason={conversationSearchErrorReason}
            activeMatchIndex={activeConversationSearchMatchIndex}
            resultCount={conversationSearchMatches.length}
            isResultLimitReached={isConversationSearchResultLimitReached}
            focusRequestKey={conversationSearchFocusRequestKey}
            onQueryChange={setConversationSearchQuery}
            onNavigate={navigateConversationSearch}
            onClose={closeConversationSearch}
          />
        ) : (
          /* Right side: Artifact toggle */
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
                  {isAgentBrowserPreviewTabOpen && (
                    <div
                      data-artifact-preview-active={
                        !activeArtifactPreviewTab && activeSpecialPreviewTab === ArtifactSpecialTab.AgentBrowser
                          ? 'true'
                          : undefined
                      }
                      className={`non-draggable group flex h-7 max-w-[190px] items-center rounded-lg text-xs transition-colors ${
                        activeArtifactPreviewTab || activeSpecialPreviewTab !== ArtifactSpecialTab.AgentBrowser
                          ? 'text-secondary hover:bg-surface hover:text-foreground'
                          : 'bg-surface-raised text-foreground shadow-sm'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={handleActivateArtifactAgentBrowserTab}
                        className="relative flex min-w-0 items-center gap-1.5 px-2 text-left"
                        title={i18nService.t('agentBrowserTab')}
                      >
                        <ComputerDesktopIcon className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{i18nService.t('agentBrowserTab')}</span>
                        {hasUnreadAgentBrowserActivity && (
                          <span
                            className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                            title={i18nService.t('agentBrowserLiveActivity')}
                          />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleCloseArtifactAgentBrowserTab();
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
                  {isUserAttachmentPreviewTabOpen && (
                    <div
                      data-artifact-preview-active={
                        !activeArtifactPreviewTab && activeSpecialPreviewTab === ArtifactSpecialTab.UserAttachment
                          ? 'true'
                          : undefined
                      }
                      className={`non-draggable group flex h-7 max-w-[190px] items-center rounded-lg text-xs transition-colors ${
                        activeArtifactPreviewTab || activeSpecialPreviewTab !== ArtifactSpecialTab.UserAttachment
                          ? 'text-secondary hover:bg-surface hover:text-foreground'
                          : 'bg-surface-raised text-foreground shadow-sm'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={handleActivateArtifactUserAttachmentTab}
                        className="flex min-w-0 items-center gap-1.5 px-2 text-left"
                        title={i18nService.t('artifactUserAttachmentTab')}
                      >
                        <PaperClipIcon className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{i18nService.t('artifactUserAttachmentTab')}</span>
                      </button>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleCloseArtifactUserAttachmentTab();
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
                    <div
                      data-skin-artifact-add-tab="true"
                      className="z-20 flex h-full shrink-0 items-center bg-background pl-1 pr-1"
                    >
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
                  <div
                    data-skin-artifact-add-tab="true"
                    className="absolute inset-y-0 right-0 z-20 flex items-center bg-background pl-1 pr-1"
                  >
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
            onClick={handleOpenConversationSearch}
            className="non-draggable relative h-8 w-8 inline-flex items-center justify-center rounded-lg text-secondary hover:bg-surface-raised transition-colors"
            aria-label={i18nService.t('coworkConversationSearchOpen')}
            title={i18nService.t('coworkConversationSearchOpen')}
          >
            <SidebarSearchIcon className="h-[18px] w-[18px]" />
          </button>
          <button
            type="button"
            onClick={handleToggleArtifactPanel}
            className="non-draggable relative h-8 w-8 inline-flex items-center justify-center rounded-lg text-secondary hover:bg-surface-raised transition-colors"
            aria-label={i18nService.t('artifactPanelToggle')}
          >
            <ArtifactPanelIcon className="h-4 w-4" open={isPanelOpen} />
            {hasUnreadAgentBrowserActivity && (
              <span
                className="absolute right-1 top-1 h-2 w-2 rounded-full bg-primary ring-2 ring-background"
                title={i18nService.t('agentBrowserLiveActivity')}
              />
            )}
          </button>
          </div>
        )}
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
      {showExportOptions && createPortal(
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
        </div>,
        document.body
      )}

      {/* Export image progress overlay: a transparent input blocker so user
          scrolling cannot break chunk stitching, plus a status pill pinned to
          the window's top edge — above the capture rect, so it is never baked
          into the exported chunks. */}
      {exportImageProgress && createPortal(
        <div className="fixed inset-0 z-[10050]" style={{ cursor: 'progress' }}>
          <div className="absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-2.5 rounded-full border border-border bg-surface py-1.5 pl-4 pr-2 shadow-elevated">
            <div className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <span className="whitespace-nowrap text-xs font-medium text-foreground">
              {exportImageProgress.phase === 'loading'
                ? i18nService.t('coworkExportImagePreparing')
                : i18nService.t('coworkExportImageInProgress')}
              {exportImageProgress.phase !== 'saving'
                && exportImageProgress.current !== undefined
                && exportImageProgress.total !== undefined
                && exportImageProgress.total > 0
                && ` (${exportImageProgress.current}/${exportImageProgress.total})`}
            </span>
            <button
              type="button"
              onClick={handleCancelExportImage}
              className="shrink-0 rounded-full px-2 py-0.5 text-xs text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
            >
              {i18nService.t('cancel')}
            </button>
          </div>
        </div>,
        document.body
      )}

      {/* Content row: chat + artifact panel */}
      <div ref={contentRowRef} className="relative flex-1 flex overflow-hidden">
      <div
        ref={detailRootRef}
        className="relative flex-1 flex flex-col h-full min-w-0"
        style={{ minWidth: isArtifactPanelExpanded ? 0 : COWORK_DETAIL_MIN_WIDTH }}
      >
      <div className="relative z-10 flex-1 min-h-0">
        <div
          ref={scrollContainerRef}
          onScroll={handleMessagesScroll}
          onWheel={handleMessagesWheel}
          onMouseUp={handleAssistantTextSelection}
          className={`relative h-full min-h-0 overflow-y-auto pt-3${exportImageProgress ? ' cowork-export-capturing' : ''}`}
          style={{ scrollbarGutter: 'stable both-edges' }}
        >
          {selectedTextAction && !exportImageProgress && (
            <SelectedTextActionToolbar
              left={selectedTextAction.left}
              top={selectedTextAction.top}
              onAddToChat={handleAddSelectedText}
              onAskInSideChat={handleOpenSelectedTextInSideChat}
            />
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
        {shouldShowTurnNavigationRail && !exportImageProgress && (
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
        {shouldShowScrollToBottom && !exportImageProgress && (
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
        {minimizedPermission && (
          <div className={`${COWORK_DETAIL_CONTENT_CLASS} mb-2`}>
            <div
              className={`flex min-w-0 items-center gap-1 rounded-xl border p-1 text-sm shadow-subtle ${
                isMinimizedQuestionPermission
                  ? 'border-border bg-surface'
                  : 'border-amber-200 bg-amber-50/95 dark:border-amber-900/70 dark:bg-amber-950/35'
              }`}
            >
              <button
                type="button"
                onClick={onRestorePermission}
                disabled={!onRestorePermission}
                className={`flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
                  isMinimizedQuestionPermission
                    ? 'enabled:hover:bg-surface-raised'
                    : 'enabled:hover:bg-amber-100/70 dark:enabled:hover:bg-amber-900/40'
                }`}
                title={minimizedPermissionPreview}
              >
                {isMinimizedQuestionPermission ? (
                  <QuestionMarkCircleIcon className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                ) : (
                  <ExclamationTriangleIcon className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" aria-hidden="true" />
                )}
                <span
                  className={`shrink-0 font-medium ${
                    isMinimizedQuestionPermission ? 'text-foreground' : 'text-amber-900 dark:text-amber-100'
                  }`}
                >
                  {i18nService.t(
                    isMinimizedQuestionPermission ? 'coworkQuestionAwaitingAnswer' : 'coworkPermissionAwaiting'
                  )}
                </span>
                {!isMinimizedQuestionPermission && (
                  <span className="shrink-0 text-amber-700/80 dark:text-amber-200/75">
                    {minimizedPermission.toolName}
                  </span>
                )}
                <span
                  className={`min-w-0 flex-1 truncate ${
                    isMinimizedQuestionPermission
                      ? 'text-secondary'
                      : 'text-amber-800/85 dark:text-amber-100/80'
                  }`}
                >
                  {minimizedPermissionPreview}
                </span>
                {onRestorePermission && (
                  <span
                    className={`shrink-0 rounded-lg px-2.5 py-1 text-xs font-medium ${
                      isMinimizedQuestionPermission
                        ? 'bg-primary/10 text-primary'
                        : 'bg-amber-100 text-amber-900 dark:bg-amber-900/60 dark:text-amber-50'
                    }`}
                  >
                    {i18nService.t(
                      isMinimizedQuestionPermission ? 'coworkQuestionResume' : 'coworkPermissionRestore'
                    )}
                  </span>
                )}
              </button>
              {onRespondToPermission && (
                <button
                  type="button"
                  onClick={handleDenyMinimizedPermission}
                  className={`shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
                    isMinimizedQuestionPermission
                      ? 'text-secondary hover:bg-surface-raised hover:text-foreground'
                      : 'text-amber-800 hover:bg-amber-100 dark:text-amber-100 dark:hover:bg-amber-900/60'
                  }`}
                >
                  {i18nService.t('coworkDeny')}
                </button>
              )}
            </div>
          </div>
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
        <div ref={promptContentAnchorRef} className={COWORK_DETAIL_CONTENT_CLASS}>
          <EnterpriseQuotaPrompt signal={activeEnterpriseQuotaSignal} surface="task" />
          {btwThread && (
            <CoworkBtwFloatingPanel
              thread={btwThread}
              promptAnchorRef={promptContentAnchorRef}
              resolveLocalFilePath={resolveLocalFilePath}
              onClose={() => dispatch(closeBtwThread(btwThread.sessionId))}
              onClearEntries={() => dispatch(clearBtwEntries(btwThread.sessionId))}
              onDraftChange={draft => dispatch(setBtwDraft({
                sessionId: btwThread.sessionId,
                draft,
              }))}
              onSelectedTextSnippetsChange={snippets => dispatch(
                setBtwSelectedTextSnippets({
                  sessionId: btwThread.sessionId,
                  snippets,
                }),
              )}
              onLocateSelectedText={handleLocateSelectedText}
              onSubmit={handleSubmitBtwDraft}
              onStop={runId => void coworkService.abortBtw({
                sessionId: btwThread.sessionId,
                runId,
              })}
            />
          )}
          {showExternalGoalStatusBar && (
            <div className={`relative z-10 ${showExternalSteerPreview ? 'mb-1.5' : '-mb-px'}`}>
              <div ref={setGoalStatusBarPortalTarget} />
            </div>
          )}
          {showExternalSteerPreview && (
            <div className="relative z-10 -mb-px">
              <div ref={setSteerPreviewPortalTarget} />
            </div>
          )}
          <CoworkPromptInput
            ref={promptInputRef}
            onSubmit={onContinue}
            onStop={onStop}
            isStreaming={isSessionBusy}
            canSteer={isStreaming && !isContextBusy}
            placeholder={i18nService.t(remoteManaged ? 'coworkRemoteManagedPlaceholder' : 'coworkContinuePlaceholder')}
            disabled={remoteManaged}
            submitDisabled={Boolean(activeEnterpriseQuotaSignal)}
            size={isArtifactPanelExpanded ? 'compact' : 'large'}
            remoteManaged={remoteManaged}
            onManageSkills={remoteManaged ? undefined : onManageSkills}
            onManageKits={remoteManaged ? undefined : onManageKits}
            showModelSelector={true}
            showReadOnlyContext={!isArtifactPanelExpanded}
            showNewUserWelcomeLoginOverlay={isNewUserWelcomeSession}
            readOnlyContextTrailingText={isArtifactPanelExpanded ? undefined : i18nService.t('aiGeneratedDisclaimer')}
            workingDirectory={currentSession?.cwd ?? ''}
            contextAgentId={currentSession?.agentId}
            sessionId={currentSession?.id}
            goal={!remoteManaged ? currentSession?.goal : null}
            onGoalCommand={!remoteManaged && currentSession?.id ? handleGoalCommand : undefined}
            goalStatusBarPortalTarget={showExternalGoalStatusBar ? goalStatusBarPortalTarget : null}
            goalStatusBarAttached={!showExternalSteerPreview}
            steerPreviewPortalTarget={showExternalSteerPreview ? steerPreviewPortalTarget : null}
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
    {(shouldRenderArtifactPanel || Boolean(localServiceDeploymentRequest)) && (
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
              key={currentSession.id}
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
              localServiceDeploymentRequest={localServiceDeploymentRequest}
              browserHtmlArtifactId={browserHtmlPreviewArtifactId}
              onBrowserAddressChange={handleBrowserPreviewAddressChange}
              onBrowserUrlChange={handleBrowserPreviewUrlChange}
              onBrowserTitleChange={handleBrowserPreviewTitleChange}
              onBrowserLocalServiceContextChange={setSessionBrowserLocalServiceContext}
              onLocalServiceDeploymentRequestConsumed={handleLocalServiceDeploymentRequestConsumed}
              onOpenFileListTab={handleOpenArtifactFileListTab}
              onOpenBrowserTab={handleOpenArtifactBrowserTab}
              onOpenHtmlFileInBrowser={handleOpenHtmlFileInBrowser}
              agentBrowserPanel={browserDisplayMode === BrowserDisplayMode.InApp
                ? (
                    <AgentBrowserInAppPanel
                      sessionId={currentSession.id}
                      visible={isPanelOpen
                        && isArtifactPanelVisible
                        && !activeArtifactPreviewTab
                        && activeSpecialPreviewTab === ArtifactSpecialTab.AgentBrowser}
                    />
                  )
                : undefined}
              subagentPanel={(
                <SubagentPanelContent
                  subagents={subagents}
                  loading={subagentsLoading}
                  selectedSubagent={selectedSubagentForPanel}
                  onBackToList={() => setSelectedSubagent(null)}
                  onSelectSubagent={handleSelectSubagent}
                />
              )}
              userAttachmentPanel={(
                <UserAttachmentPanelContent
                  sessionId={currentSession.id}
                  payload={userAttachmentPreview}
                />
              )}
              onAnnotationSend={handleAnnotationSendRequest}
              onAddSelectedText={addSelectedTextSnippetToDraft}
              selectedTextEnabled={!remoteManaged}
            />
          </ArtifactPanelErrorBoundary>
        </div>
      </div>
    )}
      </div>
      </div>
    </ArtifactFileShareProvider>
  );
};

export default CoworkSessionDetail;
