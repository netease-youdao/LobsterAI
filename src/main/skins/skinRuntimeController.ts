import type { InstalledKitRecord } from '../../shared/kit/constants';
import { SkinToolName, SkinWorkflowKind } from '../../shared/skin/constants';
import type { MediaSelectionState } from '../mediaGenerationPolicy';
import type { MediaAttachmentRefMain } from '../mediaGenerationReferences';
import { SkinMediaBridge } from './skinMediaBridge';
import { SkinStore } from './skinStore';
import type { SkinToolRequest, SkinToolResult } from './skinToolHandler';
import {
  type PreparedSkinWorkflowTurn,
  type PrepareSkinWorkflowTurnInput,
  SkinWorkflowRegistry,
} from './skinWorkflowRegistry';

export interface SkinRuntimeControllerOptions {
  rootDir: string;
  getInstalledKits: () => Record<string, InstalledKitRecord>;
  getParentSessionId: (sessionId: string) => string | null;
  resolveSessionId: (sessionKey: string) => string | null;
  resolveMediaSelection: (sessionId: string | null) => MediaSelectionState | undefined;
  resolveMediaReferences?: (sessionId: string | null) => MediaAttachmentRefMain[] | undefined;
  onChanged?: () => void;
}

export class SkinRuntimeController {
  readonly store: SkinStore;
  private readonly workflowRegistry: SkinWorkflowRegistry;
  private readonly mediaBridge: SkinMediaBridge;

  constructor(options: SkinRuntimeControllerOptions) {
    this.store = new SkinStore({ rootDir: options.rootDir });
    this.workflowRegistry = new SkinWorkflowRegistry({
      getInstalledKits: options.getInstalledKits,
      getParentSessionId: options.getParentSessionId,
    });
    this.mediaBridge = new SkinMediaBridge({
      store: this.store,
      workflowRegistry: this.workflowRegistry,
      resolveSessionId: options.resolveSessionId,
      resolveMediaSelection: options.resolveMediaSelection,
      resolveMediaReferences: options.resolveMediaReferences,
      onChanged: options.onChanged,
    });
  }

  prepareTurn(input: PrepareSkinWorkflowTurnInput): PreparedSkinWorkflowTurn {
    return this.workflowRegistry.prepareTurn(input);
  }

  isSkinWorkflow(sessionId: string | null): boolean {
    return this.workflowRegistry.resolve(sessionId)?.state.workflowKind === SkinWorkflowKind.SkinPack;
  }

  handlesTool(tool: string): boolean {
    return tool === SkinToolName.Manage;
  }

  handleToolRequest(request: SkinToolRequest): Promise<SkinToolResult> {
    return this.mediaBridge.handleToolRequest(request);
  }

  preflightLobsterImageGeneration(
    sessionId: string | null,
    selection: MediaSelectionState | undefined,
  ): Promise<SkinToolResult | null> {
    return this.mediaBridge.preflightLobsterImageGeneration(sessionId, selection);
  }

  handleRuntimeComplete(sessionId: string): void {
    this.workflowRegistry.handleRuntimeComplete(sessionId);
  }

  handleRuntimeError(sessionId: string): void {
    this.workflowRegistry.handleRuntimeError(sessionId);
  }

  handleSessionDeleted(sessionId: string): void {
    this.workflowRegistry.handleSessionDeleted(sessionId);
  }
}
