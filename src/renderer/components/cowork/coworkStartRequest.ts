import type { CoworkBrowserAnnotationMessageBatch } from '../../../shared/cowork/browserAnnotations';
import type { CoworkSelectedTextSnippet } from '../../../shared/cowork/selectedText';
import type { CoworkCapabilitySelection } from '../../services/coworkCapabilitySelection';
import {
  CoworkCollaborationMode,
  type CoworkImageAttachment,
  type CoworkStartOptions,
  type OpenClawEngineStatus,
} from '../../types/cowork';
import type { MediaAttachmentRef } from '../../types/mediaGeneration';
import { buildCoworkSystemPrompt } from './skillSystemPrompt';

/** Why a new session cannot start right now, checked before anything is sent. */
export const CoworkStartBlock = {
  EnterpriseQuota: 'enterprise-quota',
  EngineNotReady: 'engine-not-ready',
  ModelBillingSide: 'model-billing-side',
} as const;
export type CoworkStartBlock = typeof CoworkStartBlock[keyof typeof CoworkStartBlock];

export const COWORK_START_BLOCK_MESSAGE_KEYS: Record<CoworkStartBlock, string> = {
  [CoworkStartBlock.EnterpriseQuota]: 'enterpriseQuotaHomeSubmitBlocked',
  [CoworkStartBlock.EngineNotReady]: 'coworkErrorEngineNotReady',
  [CoworkStartBlock.ModelBillingSide]: 'agentModelInvalidHint',
};

export function isOpenClawReadyForSession(status: OpenClawEngineStatus | null): boolean {
  if (!status) return false;
  return status.phase === 'running' || status.phase === 'ready';
}

/** An unknown engine status does not block: the start request reports its own failure. */
export function resolveCoworkStartBlock(input: {
  blockingQuotaReason: unknown;
  engineStatus: OpenClawEngineStatus | null;
  crossesBillingSide: boolean;
}): CoworkStartBlock | null {
  if (input.blockingQuotaReason) return CoworkStartBlock.EnterpriseQuota;
  if (input.engineStatus && !isOpenClawReadyForSession(input.engineStatus)) return CoworkStartBlock.EngineNotReady;
  if (input.crossesBillingSide) return CoworkStartBlock.ModelBillingSide;
  return null;
}

export interface CoworkStartRequestInput {
  prompt: string;
  title: string;
  skillPrompt?: string;
  configSystemPrompt?: string;
  /** Kits selected in the composer when it was submitted. */
  kitIds: string[];
  /** The selected skills and kits, resolved with buildCoworkCapabilitySelection. */
  capabilities: CoworkCapabilitySelection;
  collaborationMode: CoworkCollaborationMode;
  cwd: string;
  agentId: string;
  modelRef: string;
  thinkingLevel?: CoworkStartOptions['thinkingLevel'];
  imageAttachments?: CoworkImageAttachment[];
  mediaSelection?: CoworkStartOptions['mediaSelection'];
  mediaReferences?: MediaAttachmentRef[];
  selectedTextSnippets?: CoworkSelectedTextSnippet[];
  browserAnnotations?: CoworkBrowserAnnotationMessageBatch[];
}

export interface CoworkStartPlan {
  options: CoworkStartOptions;
  isPlanMode: boolean;
  /** Skills shown on the first message. */
  displaySkillIds: string[];
  displayKitIds: string[];
  /** Skills the run loads; Plan Mode loads none. */
  runtimeSkillIds: string[];
  /** Plan Mode dropped selected skills or kits from the run. */
  suppressedCapabilities: boolean;
}

/** Builds the startSession request a home composer submits. */
export function buildCoworkStartPlan(input: CoworkStartRequestInput): CoworkStartPlan {
  const { directSkillIds, runtimeSkillIds, kitReferences, resolvedKitCapabilities } = input.capabilities;
  const isPlanMode = input.collaborationMode === CoworkCollaborationMode.Plan;
  const displayKitIds = input.kitIds;
  const effectiveRuntimeSkillIds = isPlanMode ? [] : runtimeSkillIds;
  return {
    isPlanMode,
    displaySkillIds: directSkillIds,
    displayKitIds,
    runtimeSkillIds: effectiveRuntimeSkillIds,
    suppressedCapabilities: isPlanMode && (directSkillIds.length > 0 || runtimeSkillIds.length > 0 || displayKitIds.length > 0),
    options: {
      prompt: input.prompt,
      title: input.title,
      cwd: input.cwd || undefined,
      // OpenClaw loads skills natively via skills.load.extraDirs, so only the
      // selected skills' prompt is combined with the configured system prompt.
      systemPrompt: buildCoworkSystemPrompt(input.skillPrompt, input.configSystemPrompt),
      activeSkillIds: directSkillIds.length > 0 ? directSkillIds : undefined,
      runtimeSkillIds: isPlanMode ? [] : (effectiveRuntimeSkillIds.length > 0 ? effectiveRuntimeSkillIds : undefined),
      kitIds: displayKitIds.length > 0 ? displayKitIds : undefined,
      kitReferences: displayKitIds.length > 0 ? kitReferences : undefined,
      resolvedKitCapabilities: displayKitIds.length > 0 ? resolvedKitCapabilities : undefined,
      agentId: input.agentId,
      modelOverride: input.modelRef,
      thinkingLevel: input.thinkingLevel,
      imageAttachments: input.imageAttachments,
      mediaSelection: input.mediaSelection && input.mediaSelection.mode !== 'none' ? input.mediaSelection : undefined,
      mediaReferences: input.mediaReferences,
      selectedTextSnippets: input.selectedTextSnippets,
      browserAnnotations: input.browserAnnotations,
    },
  };
}
