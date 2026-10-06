import type { KitReference, ResolvedKitCapabilities } from '../kit/constants';
import type { CoworkBrowserAnnotationMessageBatch } from './browserAnnotations';
import type { CoworkImageAttachmentPayload } from './imageAttachments';
import type { CoworkSelectedTextSnippet } from './selectedText';

export const CoworkSteerStatus = {
  Pending: 'pending',
  Accepted: 'accepted',
  Rejected: 'rejected',
} as const;
export type CoworkSteerStatus = typeof CoworkSteerStatus[keyof typeof CoworkSteerStatus];

export const CoworkSteerRejectReason = {
  NoActiveTurn: 'no_active_turn',
  NotStreaming: 'not_streaming',
  ContextMaintenance: 'context_maintenance',
  RuntimeUnsupported: 'runtime_unsupported',
  RuntimeRejected: 'runtime_rejected',
  EmptyInput: 'empty_input',
  Unknown: 'unknown',
} as const;
export type CoworkSteerRejectReason =
  typeof CoworkSteerRejectReason[keyof typeof CoworkSteerRejectReason];

export interface CoworkSteerRequest {
  sessionId: string;
  text: string;
  clientSteerId: string;
}

export interface CoworkSteerResponse {
  success: boolean;
  status: CoworkSteerStatus;
  clientSteerId: string;
  error?: string;
  reason?: CoworkSteerRejectReason;
}

export interface CoworkPendingSteer {
  id: string;
  sessionId: string;
  ownerAccountKey: string | null;
  accountGeneration: number;
  text: string;
  attachments?: CoworkSteerAttachment[];
  imageAttachments?: CoworkImageAttachmentPayload[];
  selectedTextSnippets?: CoworkSelectedTextSnippet[];
  browserAnnotations?: CoworkBrowserAnnotationMessageBatch[];
  modelSupportsImage?: boolean;
  skillPrompt?: string;
  selectedSkillIds?: string[];
  activeSkillIds?: string[];
  runtimeSkillIds?: string[];
  kitIds?: string[];
  kitReferences?: KitReference[];
  resolvedKitCapabilities?: ResolvedKitCapabilities;
  mediaSelection?: CoworkQueuedMediaSelection;
  status: CoworkSteerStatus;
  createdAt: number;
  updatedAt: number;
  error?: string;
  reason?: CoworkSteerRejectReason;
}

export interface CoworkSteerAttachment {
  path: string;
  name: string;
  isImage?: boolean;
  isDirectory?: boolean;
  dataUrl?: string;
}

export interface CoworkQueuedMediaSelection {
  mode: 'auto' | 'image' | 'video' | 'none';
  modelId?: string;
  modelName?: string;
  imageModelId?: string;
  videoModelId?: string;
}
