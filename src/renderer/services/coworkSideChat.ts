import type { CoworkImageAttachmentPayload } from '../../shared/cowork/imageAttachments';
import type { CoworkSelectedTextSnippet } from '../../shared/cowork/selectedText';
import type {
  CoworkSideChat,
  CoworkSideChatPermissionResult,
  CoworkSideChatSummary,
} from '../../shared/cowork/sideChat';
import { store } from '../store';
import {
  addSideChatPermission,
  appendSideChatMessage,
  clearSideChatComposer,
  closeSideChatTab,
  openSideChatTab,
  removeSideChat,
  resolveSideChatPermission,
  setSideChatDetail,
  setSideChatSelectedTextSnippets,
  setSideChatStatus,
  setSideChatSummaries,
  updateSideChatMessage,
  upsertSideChatSummary,
} from '../store/slices/sideChatSlice';

class CoworkSideChatService {
  private listenersInitialized = false;
  private cleanups: Array<() => void> = [];

  private get bridge() {
    return window.electron?.cowork?.sideChat;
  }

  initListeners(): void {
    if (this.listenersInitialized) return;
    const bridge = this.bridge;
    if (!bridge) return;
    this.listenersInitialized = true;

    this.cleanups.push(
      bridge.onStreamMessage((event) => {
        const state = store.getState();
        const isCurrentParent = state.cowork.currentSessionId === event.parentSessionId;
        const isActiveSideChat = state.sideChat.activeTabIdByParent[event.parentSessionId] === event.sideChatId;
        const isPanelOpen = state.artifact.isPanelOpen;
        store.dispatch(appendSideChatMessage({
          parentSessionId: event.parentSessionId,
          sideChatId: event.sideChatId,
          message: event.message,
          markUnread: !(isCurrentParent && isPanelOpen && isActiveSideChat),
        }));
      }),
      bridge.onStreamMessageUpdate((event) => {
        store.dispatch(updateSideChatMessage({
          sideChatId: event.sideChatId,
          messageId: event.messageId,
          content: event.content,
          metadata: event.metadata,
        }));
      }),
      bridge.onStreamStatus((event) => {
        store.dispatch(setSideChatStatus({
          parentSessionId: event.parentSessionId,
          sideChatId: event.sideChatId,
          status: event.status,
          error: event.error,
        }));
      }),
      bridge.onStreamMetaChanged((event) => {
        if (event.deleted) {
          store.dispatch(removeSideChat({
            parentSessionId: event.parentSessionId,
            sideChatId: event.sideChat.id,
          }));
          return;
        }
        store.dispatch(upsertSideChatSummary({
          parentSessionId: event.parentSessionId,
          sideChat: event.sideChat,
        }));
      }),
      bridge.onStreamPermission((request) => {
        store.dispatch(addSideChatPermission(request));
      }),
      bridge.onStreamPermissionResolved((event) => {
        store.dispatch(resolveSideChatPermission({
          sideChatId: event.sideChatId,
          requestId: event.requestId,
        }));
      }),
    );
  }

  destroyListeners(): void {
    for (const cleanup of this.cleanups) {
      cleanup();
    }
    this.cleanups = [];
    this.listenersInitialized = false;
  }

  async loadList(parentSessionId: string): Promise<CoworkSideChatSummary[]> {
    this.initListeners();
    if (!this.bridge) return [];
    const response = await this.bridge.list({ parentSessionId });
    if (!response.success || !Array.isArray(response.sideChats)) {
      return [];
    }
    store.dispatch(setSideChatSummaries({
      parentSessionId,
      sideChats: response.sideChats,
    }));
    return response.sideChats;
  }

  async loadDetail(sideChatId: string): Promise<CoworkSideChat | null> {
    this.initListeners();
    if (!this.bridge) return null;
    const response = await this.bridge.get({ sideChatId });
    if (!response.success || !response.sideChat) {
      return null;
    }
    store.dispatch(setSideChatDetail({
      sideChat: response.sideChat,
      pendingPermissions: response.pendingPermissions ?? [],
    }));
    return response.sideChat;
  }

  async createSideChat(options: {
    parentSessionId: string;
    title?: string;
    forkedFromMessageId?: string | null;
    initialSnippets?: CoworkSelectedTextSnippet[];
    openTab?: boolean;
  }): Promise<CoworkSideChat | null> {
    this.initListeners();
    if (!this.bridge) return null;
    const response = await this.bridge.create({
      parentSessionId: options.parentSessionId,
      title: options.title,
      forkedFromMessageId: options.forkedFromMessageId ?? null,
    });
    if (!response.success || !response.sideChat) {
      return null;
    }
    store.dispatch(setSideChatDetail({ sideChat: response.sideChat, pendingPermissions: [] }));
    if (options.initialSnippets && options.initialSnippets.length > 0) {
      store.dispatch(setSideChatSelectedTextSnippets({
        sideChatId: response.sideChat.id,
        snippets: options.initialSnippets,
      }));
    }
    if (options.openTab !== false) {
      store.dispatch(openSideChatTab({
        parentSessionId: options.parentSessionId,
        sideChatId: response.sideChat.id,
        activate: true,
      }));
    }
    return response.sideChat;
  }

  async sendMessage(options: {
    parentSessionId: string;
    sideChatId: string;
    prompt: string;
    displayPrompt?: string;
    selectedTextSnippets?: CoworkSelectedTextSnippet[];
    imageAttachments?: CoworkImageAttachmentPayload[];
    modelOverride?: string | null;
    thinkingLevel?: string | null;
  }): Promise<{ success: boolean; error?: string }> {
    this.initListeners();
    if (!this.bridge) {
      return { success: false, error: 'Side chat bridge unavailable' };
    }
    const response = await this.bridge.sendMessage(options);
    if (response.success) {
      store.dispatch(clearSideChatComposer(options.sideChatId));
    }
    return response;
  }

  async stop(parentSessionId: string, sideChatId: string): Promise<boolean> {
    if (!this.bridge) return false;
    const response = await this.bridge.stop({ parentSessionId, sideChatId });
    return response.success;
  }

  async rename(parentSessionId: string, sideChatId: string, title: string): Promise<boolean> {
    if (!this.bridge) return false;
    const response = await this.bridge.rename({ parentSessionId, sideChatId, title });
    if (response.success && response.sideChat) {
      store.dispatch(upsertSideChatSummary({ parentSessionId, sideChat: response.sideChat }));
      return true;
    }
    return false;
  }

  async delete(parentSessionId: string, sideChatId: string): Promise<boolean> {
    if (!this.bridge) return false;
    const response = await this.bridge.delete({ parentSessionId, sideChatId });
    if (response.success) {
      store.dispatch(removeSideChat({ parentSessionId, sideChatId }));
      return true;
    }
    return false;
  }

  async promote(parentSessionId: string, sideChatId: string): Promise<{ success: boolean; sessionId?: string; error?: string }> {
    if (!this.bridge) {
      return { success: false, error: 'Side chat bridge unavailable' };
    }
    const response = await this.bridge.promote({ parentSessionId, sideChatId });
    if (response.success) {
      store.dispatch(closeSideChatTab({ parentSessionId, sideChatId }));
    }
    return response;
  }

  async respondPermission(options: {
    parentSessionId: string;
    sideChatId: string;
    requestId: string;
    result: CoworkSideChatPermissionResult;
  }): Promise<boolean> {
    if (!this.bridge) return false;
    const response = await this.bridge.respondPermission(options);
    if (response.success) {
      store.dispatch(resolveSideChatPermission({
        sideChatId: options.sideChatId,
        requestId: options.requestId,
      }));
    }
    return response.success;
  }
}

export const coworkSideChatService = new CoworkSideChatService();
