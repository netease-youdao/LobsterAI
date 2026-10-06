import {
  SKIN_ASSET_SLOTS,
  type SkinAssetSlot,
  SkinToolAction,
  SkinWorkflowKind,
} from '../../shared/skin/constants';
import { parseSkinPresentation } from '../../shared/skin/presentation';
import { presentSkin } from './skinPresentation';
import { SkinStore, SkinStoreError } from './skinStore';

export interface SkinToolRequest {
  args: Record<string, unknown>;
  context: {
    sessionKey: string;
    toolCallId: string;
  };
}

export interface SkinToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  details?: Record<string, unknown>;
}

export interface SkinToolHandlerOptions {
  store: SkinStore;
  isWorkflowAllowed: (sessionKey: string) => boolean;
  onChanged?: () => void;
}

const errorResult = (message: string, code: string): SkinToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
  details: {
    status: 'failed',
    code,
  },
});

const readOptionalString = (value: unknown): string | undefined => (
  typeof value === 'string' && value.trim() ? value.trim() : undefined
);

const readSkinId = (args: Record<string, unknown>): string | undefined => (
  readOptionalString(args.skinId) ?? readOptionalString(args.draftId)
);

const isSkinAssetSlot = (value: unknown): value is SkinAssetSlot => (
  typeof value === 'string' && SKIN_ASSET_SLOTS.includes(value as SkinAssetSlot)
);

export function createSkinToolHandler(
  options: SkinToolHandlerOptions,
): (request: SkinToolRequest) => Promise<SkinToolResult> {
  return async (request) => {
    if (!options.isWorkflowAllowed(request.context.sessionKey)) {
      return errorResult(
        'Skin management is available only inside the AI Skin Designer workflow.',
        'workflow_not_allowed',
      );
    }

    const action = readOptionalString(request.args.action);
    try {
      if (action === SkinToolAction.CreateDraft) {
        const presentation = request.args.presentation === undefined
          ? undefined
          : parseSkinPresentation(request.args.presentation);
        if (request.args.presentation !== undefined && !presentation) {
          return errorResult(
            'presentation must use the supported immersive shell schema and accessible colors.',
            'invalid_arguments',
          );
        }
        const skin = await options.store.createDraft({
          name: readOptionalString(request.args.name),
          baseThemeId: readOptionalString(request.args.baseThemeId),
          workflowKind: SkinWorkflowKind.SkinPack,
          ...(presentation ? { presentation } : {}),
        });
        const presented = presentSkin(skin);
        return {
          content: [{
            type: 'text',
            text: `Skin draft created. skinId: ${skin.id}`,
          }],
          details: {
            status: skin.status,
            skinId: skin.id,
            skin: presented,
          },
        };
      }

      if (action === SkinToolAction.RegisterAsset) {
        const skinId = readSkinId(request.args);
        const slot = request.args.slot;
        const source = readOptionalString(request.args.sourcePath);
        if (!skinId || !isSkinAssetSlot(slot) || !source) {
          return errorResult(
            'skinId, a supported slot, and sourcePath are required for register_asset.',
            'invalid_arguments',
          );
        }
        await options.store.registerAsset({ skinId, slot, source });
        const skin = await options.store.getSkin(skinId);
        if (!skin) return errorResult('Skin does not exist.', 'skin_not_found');
        const presented = presentSkin(skin);
        return {
          content: [{
            type: 'text',
            text: `Registered ${slot} for skin ${skinId}. Status: ${skin.status}.`,
          }],
          details: {
            status: skin.status,
            skinId,
            slot,
            skin: presented,
          },
        };
      }

      if (action === SkinToolAction.Status) {
        const skinId = readSkinId(request.args);
        if (!skinId) return errorResult('skinId is required for status.', 'invalid_arguments');
        const skin = await options.store.getSkin(skinId);
        if (!skin) return errorResult('Skin does not exist.', 'skin_not_found');
        const presented = presentSkin(skin);
        return {
          content: [{
            type: 'text',
            text: `Skin ${skinId} status: ${skin.status}. Registered slots: ${Object.keys(skin.assets).join(', ') || 'none'}.`,
          }],
          details: {
            status: skin.status,
            skinId,
            skin: presented,
          },
        };
      }

      if (action === SkinToolAction.Apply) {
        const skinId = readSkinId(request.args);
        if (!skinId) return errorResult('skinId is required for apply.', 'invalid_arguments');
        const skin = await options.store.apply(skinId);
        const presented = presentSkin(skin);
        options.onChanged?.();
        return {
          content: [{ type: 'text', text: `Skin ${skinId} was applied.` }],
          details: {
            status: 'applied',
            skinId,
            skin: presented,
          },
        };
      }

      if (action === SkinToolAction.Deactivate) {
        await options.store.deactivate();
        options.onChanged?.();
        return {
          content: [{ type: 'text', text: 'The active skin was deactivated.' }],
          details: { status: 'deactivated' },
        };
      }

      return errorResult('Unsupported skin management action.', 'unsupported_action');
    } catch (error) {
      if (error instanceof SkinStoreError) {
        return errorResult(error.message, error.code);
      }
      return errorResult(
        error instanceof Error ? error.message : 'Skin management failed.',
        'internal_error',
      );
    }
  };
}
