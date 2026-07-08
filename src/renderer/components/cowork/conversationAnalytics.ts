import { LogReporterAction, reportYdAnalyzer } from '../../services/logReporter';
import type { CoworkMessage } from '../../types/cowork';

type ConversationAnalyticsValue = string | number | boolean | null | undefined;

const logConversationAnalytics = (eventName: string, actionType: string): void => {
  const message = `Reporting ${eventName}: ${actionType}.`;
  console.debug(`[ConversationAnalytics] ${message}`);
  window.electron?.log?.fromRenderer?.('debug', 'ConversationAnalytics', message);
};

const joinValues = (values: string[]): string | undefined => {
  const normalized = values.map(value => value.trim()).filter(Boolean);
  return normalized.length > 0 ? normalized.join(',') : undefined;
};

const toOptionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;

export const bucketCount = (count: number): string => {
  if (count <= 0) return '0';
  if (count <= 3) return '1_3';
  if (count <= 10) return '4_10';
  if (count <= 30) return '11_30';
  return '30_plus';
};

export const bucketLength = (length: number): string => {
  if (length <= 0) return '0';
  if (length <= 100) return '1_100';
  if (length <= 500) return '101_500';
  if (length <= 2000) return '501_2000';
  if (length <= 10000) return '2001_10000';
  return '10000_plus';
};

export const bucketDistance = (distancePx: number): string => {
  if (distancePx <= 0) return '0';
  if (distancePx <= 500) return '1_500';
  if (distancePx <= 2000) return '501_2000';
  if (distancePx <= 8000) return '2001_8000';
  return '8000_plus';
};

export const getMessageContentLength = (message: CoworkMessage): number =>
  (message.content || '').length;

export const getMessageLineCount = (value: string): number =>
  value.length > 0 ? value.split('\n').length : 0;

export const getMessageCapabilityAnalyticsParams = (
  message: CoworkMessage,
): Record<string, ConversationAnalyticsValue> => {
  const metadata = message.metadata;
  const skillIds = Array.isArray(metadata?.skillIds) ? metadata.skillIds : [];
  const kitIds = Array.isArray(metadata?.kitIds) ? metadata.kitIds : [];
  const kitReferences = Array.isArray(metadata?.kitReferences) ? metadata.kitReferences : [];
  const imageAttachmentPreviews = Array.isArray(metadata?.imageAttachmentPreviews)
    ? metadata.imageAttachmentPreviews
    : [];
  const legacyImageAttachments = Array.isArray(metadata?.imageAttachments)
    ? metadata.imageAttachments
    : [];
  return {
    activeSkillCount: skillIds.length,
    activeSkillIds: joinValues(skillIds),
    activeKitCount: kitIds.length || kitReferences.length,
    activeKitIds: joinValues(kitIds.length > 0 ? kitIds : kitReferences.map(item => item.id)),
    hasAttachments: imageAttachmentPreviews.length > 0 || legacyImageAttachments.length > 0,
    imageAttachmentCount: imageAttachmentPreviews.length + legacyImageAttachments.length,
    hasModelLabel: Boolean(metadata?.modelId || metadata?.modelName || metadata?.providerKey),
    modelId: toOptionalString(metadata?.modelId),
    modelName: toOptionalString(metadata?.modelName),
    providerKey: toOptionalString(metadata?.providerKey),
  };
};

export interface ConversationMessageActionOptions {
  actionType: string;
  message: CoworkMessage;
  params?: Record<string, ConversationAnalyticsValue>;
}

export const reportConversationMessageAction = (options: ConversationMessageActionOptions): void => {
  const contentLength = getMessageContentLength(options.message);
  logConversationAnalytics('message action', options.actionType);
  void reportYdAnalyzer({
    action: LogReporterAction.ConversationMessageAction,
    surface: 'conversation',
    actionType: options.actionType,
    messageRole: options.message.type,
    messageContentLength: contentLength,
    messageContentLengthBucket: bucketLength(contentLength),
    ...getMessageCapabilityAnalyticsParams(options.message),
    ...options.params,
  });
};

export interface ConversationNavigationActionOptions {
  actionType: string;
  params?: Record<string, ConversationAnalyticsValue>;
}

export const reportConversationNavigationAction = (options: ConversationNavigationActionOptions): void => {
  logConversationAnalytics('navigation action', options.actionType);
  void reportYdAnalyzer({
    action: LogReporterAction.ConversationNavigationAction,
    surface: 'conversation',
    actionType: options.actionType,
    ...options.params,
  });
};

export interface ConversationBlockActionOptions {
  actionType: string;
  blockType: 'code' | 'thinking' | 'proposed_plan' | 'tool';
  params?: Record<string, ConversationAnalyticsValue>;
}

export const reportConversationBlockAction = (options: ConversationBlockActionOptions): void => {
  logConversationAnalytics('block action', options.actionType);
  void reportYdAnalyzer({
    action: LogReporterAction.ConversationBlockAction,
    surface: 'conversation',
    actionType: options.actionType,
    blockType: options.blockType,
    ...options.params,
  });
};
