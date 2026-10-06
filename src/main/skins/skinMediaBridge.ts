import {
  SKIN_ASSET_SLOTS,
  SkinToolAction,
  SkinWorkflowKind,
} from '../../shared/skin/constants';
import {
  MediaSelectionMode,
  type MediaSelectionState,
} from '../mediaGenerationPolicy';
import type { SkinStore } from './skinStore';
import {
  createSkinToolHandler,
  type SkinToolRequest,
  type SkinToolResult,
} from './skinToolHandler';
import type { SkinWorkflowRegistry } from './skinWorkflowRegistry';

export interface SkinMediaBridgeOptions {
  store: SkinStore;
  workflowRegistry: SkinWorkflowRegistry;
  resolveSessionId: (sessionKey: string) => string | null;
  resolveMediaSelection: (sessionId: string | null) => MediaSelectionState | undefined;
  onChanged?: () => void;
}

const workflowError = (message: string, code: string): SkinToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
  details: { status: 'failed', code },
});

const readRequestedSkinId = (args: Record<string, unknown>): string => {
  if (typeof args.skinId === 'string') return args.skinId.trim();
  if (typeof args.draftId === 'string') return args.draftId.trim();
  return '';
};

export class SkinMediaBridge {
  private readonly skinToolHandler: ReturnType<typeof createSkinToolHandler>;

  constructor(private readonly options: SkinMediaBridgeOptions) {
    this.skinToolHandler = createSkinToolHandler({
      store: options.store,
      isWorkflowAllowed: (sessionKey) => {
        const sessionId = options.resolveSessionId(sessionKey);
        return options.workflowRegistry.resolve(sessionId)?.state.workflowKind
          === SkinWorkflowKind.SkinPack;
      },
      onChanged: options.onChanged,
    });
  }

  async handleToolRequest(request: SkinToolRequest): Promise<SkinToolResult> {
    const sessionId = this.options.resolveSessionId(request.context.sessionKey);
    const resolved = this.options.workflowRegistry.resolve(sessionId);
    if (!sessionId || resolved?.state.workflowKind !== SkinWorkflowKind.SkinPack) {
      return workflowError(
        'Skin management is available only inside the AI Skin Designer workflow.',
        'workflow_not_allowed',
      );
    }

    const { state } = resolved;
    const action = typeof request.args.action === 'string' ? request.args.action : '';
    const requestedSkinId = readRequestedSkinId(request.args);

    if (action === SkinToolAction.CreateDraft && state.draftSkinId) {
      return workflowError('This workflow already has a skin draft.', 'draft_already_created');
    }
    if (
      action !== SkinToolAction.CreateDraft
      && action !== SkinToolAction.Deactivate
      && !state.draftSkinId
    ) {
      return workflowError('Create the skin draft before continuing.', 'draft_required');
    }
    if (
      action !== SkinToolAction.CreateDraft
      && requestedSkinId
      && state.draftSkinId
      && requestedSkinId !== state.draftSkinId
    ) {
      return workflowError('The skinId does not belong to this workflow.', 'skin_id_mismatch');
    }

    const result = await this.skinToolHandler(request);
    if (!result.isError && action === SkinToolAction.CreateDraft) {
      const skinId = typeof result.details?.skinId === 'string'
        ? result.details.skinId
        : undefined;
      if (skinId) this.options.workflowRegistry.recordDraft(sessionId, skinId);
    }
    if (
      !result.isError
      && (action === SkinToolAction.Apply || action === SkinToolAction.Deactivate)
    ) {
      this.options.workflowRegistry.finishWorkflow(sessionId);
    }
    return result;
  }

  async preflightLobsterImageGeneration(
    sessionId: string | null,
    selection: MediaSelectionState | undefined,
  ): Promise<SkinToolResult | null> {
    const resolved = this.options.workflowRegistry.resolve(sessionId);
    if (
      !sessionId
      || resolved?.state.workflowKind !== SkinWorkflowKind.SkinPack
      || selection?.mode !== MediaSelectionMode.Image
    ) {
      return null;
    }

    const { state } = resolved;
    if (!state.draftSkinId) {
      return workflowError(
        'Create the skin draft before generating its first asset.',
        'draft_required',
      );
    }
    const draft = await this.options.store.getSkin(state.draftSkinId);
    if (!draft) {
      return workflowError('The skin draft no longer exists.', 'skin_not_found');
    }
    if (SKIN_ASSET_SLOTS.every(slot => draft.assets[slot])) {
      return workflowError(
        'All required skin slots are already registered. Apply the skin to continue.',
        'skin_assets_complete',
      );
    }
    return null;
  }
}
