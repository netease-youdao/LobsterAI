import { contextBridge, ipcRenderer, webFrame, webUtils } from 'electron';

import type { GenerateSessionTitleRequest } from '../common/sessionTitle';
import { IpcChannel as ScheduledTaskIpc } from '../scheduledTask/constants';
import type { ScheduledRunSessionRequest } from '../scheduledTask/types';
import { AccountMenuMoreIpc } from '../shared/accountMenuMore/constants';
import {
  type ActivityHostExecuteActionInput,
  type ActivityHostGetContextInput,
  type ActivityHostGetSlotInput,
  ActivityIpc,
} from '../shared/activity/constants';
import type { AgentModelSelectionMode, SubagentCollaborationMode } from '../shared/agent/constants';
import { AgentIpcChannel, AgentLegacyIdentityCleanupStatus } from '../shared/agent/constants';
import {
  AgentDraftErrorCode,
  type AgentDraftStreamChunk,
  type GenerateAgentDraftRequest,
  type GenerateAgentDraftResult,
} from '../shared/agent/draft';
import type { AgentModelSelection } from '../shared/agent/modelSelection';
import type { UsageContext } from '../shared/analytics/usage';
import { AppIpcChannel, WindowIpcChannel, type WindowZoomChangedPayload } from '../shared/app/constants';
import { AppSettingsIpc } from '../shared/appSettings/constants';
import { AppUpdateIpc } from '../shared/appUpdate/constants';
import {
  ArtifactWorkspaceIpc,
  type CreateBlankDocumentRequest,
  type CreateBlankDocumentResponse,
  type ListWorkspaceDirectoryRequest,
  type ListWorkspaceDirectoryResponse,
  type ProbeGitWorkspaceRequest,
  type ProbeGitWorkspaceResponse,
  type RenameArtifactFileRequest,
  type RenameArtifactFileResponse,
} from '../shared/artifactPreview/blankDocument';
import {
  type ArtifactBrowserWindowOpenEvent,
  ArtifactPreviewIpc,
} from '../shared/artifactPreview/constants';
import { MarkdownFileIpc, type SaveMarkdownFileRequest } from '../shared/artifactPreview/markdownEditing';
import { ReviewIpc, type ReviewScopeRequest } from '../shared/artifactPreview/reviewScopes';
import type { ReviewSourceRequest } from '../shared/artifactPreview/reviewSource';
import {
  AsrIpcChannel,
  type AsrRealtimeSessionRequest,
} from '../shared/asr/constants';
import {
  type AuthAccessState,
  AuthIpcChannel,
  type AuthLifecycleEvent,
  type AuthSessionChangedEvent,
} from '../shared/auth/constants';
import {
  type BrowserCredentialAvailabilityResponse,
  type BrowserCredentialDeleteRequest,
  BrowserCredentialIpc,
  type BrowserCredentialListResponse,
  type BrowserCredentialMutationResponse,
  type BrowserCredentialSaveRequest,
} from '../shared/browserCredentials/constants';
import {
  type AgentBrowserCredentialSavePromptRequest,
  type AgentBrowserHostMenuRequest,
  type AgentBrowserHostMenuResponse,
  type AgentBrowserHostNavigateRequest,
  type AgentBrowserHostPageRequest,
  type AgentBrowserHostRequest,
  type AgentBrowserHostResponse,
  type AgentBrowserHostSetViewRequest,
  type AgentBrowserHostStateEvent,
  type AgentBrowserHostZoomRequest,
  BrowserIpc,
} from '../shared/browserWebAccess/constants';
import type { BrowserPasskeyRequest } from '../shared/browserWebAccess/passkeys';
import { ClipboardIpc } from '../shared/clipboard/constants';
import { ContextCleanupIpcChannel } from '../shared/contextCleanup/constants';
import type { ContextCleanupTargetItem } from '../shared/contextCleanup/types';
import type { CoworkBrowserAnnotationMessageBatch } from '../shared/cowork/browserAnnotations';
import type {
  CoworkBtwAbortRequest,
  CoworkBtwAbortResponse,
  CoworkBtwEntry,
  CoworkBtwSubmitRequest,
  CoworkBtwSubmitResponse,
} from '../shared/cowork/btw';
import {
  CoworkIpcChannel,
  type CoworkMemoryStatus,
  type CoworkMemoryStatusFilter,
  type CoworkSessionsChangedPayload,
} from '../shared/cowork/constants';
import type { CoworkTurnUsage } from '../shared/cowork/llmTurnUsage';
import type { CoworkSearchMessageCursor } from '../shared/cowork/search';
import type { CoworkSessionFilterQuery } from '../shared/cowork/sessionFilter';
import {
  type CoworkSideChatActionResponse,
  type CoworkSideChatCreateRequest,
  type CoworkSideChatCreateResponse,
  type CoworkSideChatDeleteRequest,
  type CoworkSideChatGetResponse,
  CoworkSideChatIpcChannel,
  type CoworkSideChatListResponse,
  type CoworkSideChatPermissionRequest,
  type CoworkSideChatPromoteRequest,
  type CoworkSideChatPromoteResponse,
  type CoworkSideChatRenameRequest,
  type CoworkSideChatRenameResponse,
  type CoworkSideChatRespondPermissionRequest,
  type CoworkSideChatSendRequest,
  type CoworkSideChatStopRequest,
  type CoworkSideChatStreamMessageEvent,
  type CoworkSideChatStreamMessageUpdateEvent,
  type CoworkSideChatStreamMetaChangedEvent,
  type CoworkSideChatStreamPermissionResolvedEvent,
  type CoworkSideChatStreamStatusEvent,
} from '../shared/cowork/sideChat';
import {
  DataMigrationIpc,
  type DataMigrationPreviewRequest,
  type DataMigrationProgressEvent,
  type DataMigrationReinstallPluginsRequest,
  type DataMigrationRestoreRequest,
} from '../shared/dataMigration/constants';
import { type DecisionModelConfigUpdate, DecisionModelIpcChannel } from '../shared/decisionModel/constants';
import {
  type CompanionQuickAnswerEvent,
  type DesktopCompanionBridge,
  DesktopCompanionIpc,
  type DesktopCompanionSelection,
  type DesktopCompanionState,
} from '../shared/desktopCompanion/constants';
import { CompanionContextMenuIpc } from '../shared/desktopCompanion/contextMenu';
import { CompanionPermissionGuideIpc } from '../shared/desktopCompanion/permissionGuide';
import { CompanionResultIpc } from '../shared/desktopCompanion/results';
import { CompanionScreenshotIpc } from '../shared/desktopCompanion/screenshot';
import { DialogIpc } from '../shared/dialog/constants';
import { DshIpcChannel } from '../shared/dshEngine/constants';
import { DshHostIpc } from '../shared/dshEngine/hostConstants';
import {
  EnterpriseAccountIpcChannel,
  type EnterpriseQuotaRequestType,
} from '../shared/enterpriseAccount/constants';
import { type FeedbackInput,FeedbackIpc } from '../shared/feedback/constants';
import {
  type HtmlShareAccessMode,
  type HtmlShareAnalyticsInput,
  type HtmlShareConfigurableStatus,
  HtmlShareIpc,
  type HtmlShareSourceType,
  type HtmlShareStatus,
} from '../shared/htmlShare/constants';
import { type ImageCreationCatalog, ImageCreationIpc, type ImageExampleReference } from '../shared/imageCreation/constants';
import {
  KitIpcChannel,
  type KitReference,
  type KitSkillMetadata,
  type KitStoreResponse,
  type ResolvedKitCapabilities,
} from '../shared/kit/constants';
import { LibraryIpc } from '../shared/library/constants';
import type {
  LibraryArtifactCandidate,
  LibraryBackfillState,
  LibraryChangedPayload,
  LibraryCloudListOptions,
  LibraryFavoriteInput,
  LibraryGetLocalItemsInput,
  LibraryLocalListOptions,
  LibraryLocalTaskGroupsOptions,
  LibraryLocalTaskItemsOptions,
} from '../shared/library/types';
import {
  type ListLocalWebServicesOptions,
  type LocalWebService,
  LocalWebServicesIpc,
} from '../shared/localWebServices/constants';
import { LogIpc } from '../shared/logExport/constants';
import { McpIpcChannel } from '../shared/mcp/constants';
import type { McpToolDiscoveryRequest } from '../shared/mcp/toolDiscovery';
import type {
  MediaPreference,
  MediaPreferenceResult,
  MediaSelection,
  MediaType,
} from '../shared/media/defaultPolicy';
import { MigrationV2Ipc } from '../shared/migration/constants';
import { type ModelPresetId, ModelPresetIpc } from '../shared/modelPresets/constants';
import { NeteaseMailIpc } from '../shared/neteaseMail/constants';
import type { NeteaseMailAuthorizationOptions, NeteaseMailBridge, NeteaseMailConfirmationReference, NeteaseMailConfirmationRequest } from '../shared/neteaseMail/types';
import { OpenClawEngineIpc } from '../shared/openclawEngine/constants';
import { OpenClawUserConfigIpc } from '../shared/openclawUserConfig/constants';
import { PermissionIpcChannel } from '../shared/permissions/constants';
import type { Platform } from '../shared/platform';
import { type PptAssetRequest, type PptCatalog, PptCreationIpc, type PptPreparedFile } from '../shared/pptCreation/constants';
import { type PptCoverExportRequest, PptCoverIpc, type PptCoverRequest } from '../shared/pptCreation/cover';
import { ModelContextWindowIpc, type ModelContextWindowRequest } from '../shared/providers/modelContextWindow';
import {
  ProviderModelDiscoveryIpcChannel,
  type ProviderModelDiscoveryRequest,
} from '../shared/providers/modelDiscovery';
import type { ModelThinkingLevel } from '../shared/providers/modelThinking';
import {
  type ShareDeploymentAnalyzeProjectInput,
  type ShareDeploymentCreateNodeInput,
  type ShareDeploymentDetectCandidatesInput,
  type ShareDeploymentDownloadPersistenceInput,
  type ShareDeploymentGetByLocalServiceInput,
  ShareDeploymentIpc,
  type ShareDeploymentSelectPersistencePathInput,
} from '../shared/shareDeployment/constants';
import { type ShellGetBrowserAppsInput, ShellIpc } from '../shared/shell/constants';
import {
  type SiteAnalyticsOptions,
  type SiteDeploymentQuotaOptions,
  SiteIpc,
  type SiteListOptions,
  type SiteQuotaReservationInput,
  type SiteUpdateAccessModeInput,
  type SiteUpdateAccessStatusInput,
  type SiteUpdateTitleInput,
} from '../shared/site/constants';
import { type SkinBackdropVisibility, SkinIpc } from '../shared/skin/constants';
import type {
  SkinApplyResponse,
  SkinBindThemeResponse,
  SkinDeactivateResponse,
  SkinDeleteResponse,
  SkinGetActiveResponse,
  SkinListResponse,
  SkinSetBackdropVisibilityResponse,
} from '../shared/skin/types';
import { SubscriptionTrialIpc } from '../shared/subscriptionTrial/constants';
import { createMessageSpeechBridge } from './conversation/messageSpeechPreload';
import { createLanguageToolsBridge } from './desktopCompanion/languageToolsPreload';
import { createImageEditingBridge } from './imageEditingPreload';
import { NimQrLoginIpc } from './ipcHandlers/nimQrLogin';
import { createOfficeBridges } from './office/officePreloadBridges';
import { createWordPanelBridge } from './office/word/wordPanelPreloadBridge';
import { OpenClawSessionIpc } from './openclawSession/constants';
import { OpenClawSessionPolicyIpc } from './openclawSessionPolicy/constants';

// Apply per-window zoom only when the main process asks (after initial paint for the main window).
// Calling webFrame.setZoomFactor() unconditionally during preload on a hidden (`show: false`)
// window triggers Electron #51972 (40.x–43.x), suppressing `ready-to-show` permanently.
ipcRenderer.on(WindowIpcChannel.ApplyZoom, (_event, zoomFactor: unknown) => {
  if (typeof zoomFactor === 'number' && Number.isFinite(zoomFactor) && zoomFactor > 0) {
    webFrame.setZoomFactor(zoomFactor);
  }
});

// 暴露安全的 API 到渲染进程
contextBridge.exposeInMainWorld('electron', {
  messageSpeech: createMessageSpeechBridge(),
  desktopCompanion: {
    reportAnalytics: event => ipcRenderer.invoke(DesktopCompanionIpc.ReportAnalytics, event),
    startLogin: request => ipcRenderer.invoke(DesktopCompanionIpc.LoginStart, request),
    ...createLanguageToolsBridge(),
    openResult: sessionId => ipcRenderer.invoke(CompanionResultIpc.Open, sessionId),
    hideResult: () => ipcRenderer.invoke(CompanionResultIpc.Hide),
    dismissResult: sessionId => ipcRenderer.invoke(CompanionResultIpc.Dismiss, sessionId),
    pinResult: pinned => ipcRenderer.invoke(CompanionResultIpc.Pin, pinned),
    getRecentTasks: () => ipcRenderer.invoke(CompanionResultIpc.Recent),
    setResultPassThrough: passThrough => ipcRenderer.invoke(CompanionResultIpc.PassThrough, passThrough),
    getScreenshotFrame: () => ipcRenderer.invoke(CompanionScreenshotIpc.GetFrame),
    screenshotReady: () => ipcRenderer.invoke(CompanionScreenshotIpc.Ready),
    finishScreenshot: rect => ipcRenderer.invoke(CompanionScreenshotIpc.Finish, rect),
    getPermissionGuide: () => ipcRenderer.invoke(CompanionPermissionGuideIpc.Info),
    proceedPermissionGuide: () => ipcRenderer.invoke(CompanionPermissionGuideIpc.Proceed),
    closePermissionGuide: () => ipcRenderer.invoke(CompanionPermissionGuideIpc.Close),
    dragPermissionGuideApp: () => ipcRenderer.send(CompanionPermissionGuideIpc.Drag),
    relaunchForPermission: () => ipcRenderer.invoke(CompanionPermissionGuideIpc.Relaunch),
    getState: () => ipcRenderer.invoke(DesktopCompanionIpc.GetState),
    setPreferences: patch => ipcRenderer.invoke(DesktopCompanionIpc.SetPreferences, patch),
    getSelectionExcludedApps: () => ipcRenderer.invoke(DesktopCompanionIpc.GetSelectionExcludedApps),
    setDraft: draft => ipcRenderer.invoke(DesktopCompanionIpc.SetDraft, draft),
    selectSession: id => ipcRenderer.invoke(DesktopCompanionIpc.SelectSession, id),
    toggleOrb: fromPointer => ipcRenderer.invoke(DesktopCompanionIpc.ToggleOrb, fromPointer),
    togglePanel: () => ipcRenderer.invoke(DesktopCompanionIpc.TogglePanel),
    hidePanel: () => ipcRenderer.invoke(DesktopCompanionIpc.HidePanel),
    openMain: id => ipcRenderer.invoke(DesktopCompanionIpc.OpenMain, id),
    openMainPage: page => ipcRenderer.invoke(DesktopCompanionIpc.OpenMainPage, page),
    consumeMainPage: () => ipcRenderer.invoke(DesktopCompanionIpc.ConsumeMainPage),
    onMainPageRequested: callback => {
      const handler = () => callback();
      ipcRenderer.on(DesktopCompanionIpc.MainPageRequested, handler);
      return () => ipcRenderer.removeListener(DesktopCompanionIpc.MainPageRequested, handler);
    },
    showContextMenu: () => ipcRenderer.invoke(DesktopCompanionIpc.ContextMenu),
    runContextMenuItem: id => ipcRenderer.invoke(CompanionContextMenuIpc.Run, id),
    contextMenuReady: id => ipcRenderer.invoke(CompanionContextMenuIpc.Ready, id),
    dismissContextMenu: () => ipcRenderer.invoke(CompanionContextMenuIpc.Dismiss),
    drag: (phase, grab) => ipcRenderer.send(DesktopCompanionIpc.Drag, { phase, grab }),
    orbFileDrag: (phase, kinds) => ipcRenderer.send(DesktopCompanionIpc.OrbFileDrag, { phase, kinds }),
    orbHover: hovering => ipcRenderer.send(DesktopCompanionIpc.OrbHover, hovering),
    setStagePassThrough: passThrough => ipcRenderer.send(DesktopCompanionIpc.StagePassThrough, passThrough),
    taskStarted: sessionId => ipcRenderer.invoke(DesktopCompanionIpc.TaskStarted, sessionId),
    taskUpdated: () => ipcRenderer.send(DesktopCompanionIpc.TaskUpdated),
    setPanelPassThrough: passThrough => ipcRenderer.send(DesktopCompanionIpc.PanelPassThrough, passThrough),
    setPanelLoginVisible: visible => ipcRenderer.send(DesktopCompanionIpc.PanelLoginVisible, visible),
    panelReady: revision => ipcRenderer.invoke(DesktopCompanionIpc.PanelReady, revision),
    stageCommand: command => ipcRenderer.invoke(DesktopCompanionIpc.StageCommand, command),
    resizeSurface: size => ipcRenderer.send(DesktopCompanionIpc.ResizeSurface, size),
    selectionCommand: command => ipcRenderer.invoke(DesktopCompanionIpc.SelectionCommand, command),
    startQuickAnswer: request => ipcRenderer.invoke(DesktopCompanionIpc.QuickAnswerStart, request),
    abortQuickAnswer: requestId => ipcRenderer.invoke(DesktopCompanionIpc.QuickAnswerAbort, requestId),
    requestPermission: permission => ipcRenderer.invoke(DesktopCompanionIpc.RequestPermission, permission),
    copyText: text => ipcRenderer.invoke(DesktopCompanionIpc.CopyText, text),
    runContextAction: request => ipcRenderer.invoke(DesktopCompanionIpc.RunContextAction, request),
    dismissContextClipboard: fingerprint => ipcRenderer.invoke(DesktopCompanionIpc.DismissContextClipboard, fingerprint),
    onChanged: callback => {
      const handler = (_event: Electron.IpcRendererEvent, state: DesktopCompanionState) => callback(state);
      ipcRenderer.on(DesktopCompanionIpc.Changed, handler);
      return () => ipcRenderer.removeListener(DesktopCompanionIpc.Changed, handler);
    },
    onSelection: callback => {
      const handler = (_event: Electron.IpcRendererEvent, selection: DesktopCompanionSelection | null) => callback(selection);
      ipcRenderer.on(DesktopCompanionIpc.Selection, handler);
      return () => ipcRenderer.removeListener(DesktopCompanionIpc.Selection, handler);
    },
    onQuickAnswer: callback => {
      const handler = (_event: Electron.IpcRendererEvent, event: CompanionQuickAnswerEvent) => callback(event);
      ipcRenderer.on(DesktopCompanionIpc.QuickAnswerEvent, handler);
      return () => ipcRenderer.removeListener(DesktopCompanionIpc.QuickAnswerEvent, handler);
    },
  } satisfies DesktopCompanionBridge,
  platform: process.platform,
  arch: process.arch,
  store: {
    get: (key: string) => ipcRenderer.invoke('store:get', key),
    set: (key: string, value: any) => ipcRenderer.invoke('store:set', key, value),
    remove: (key: string) => ipcRenderer.invoke('store:remove', key),
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    setEnabled: (options: { id: string; enabled: boolean }) =>
      ipcRenderer.invoke('skills:setEnabled', options),
    delete: (id: string) => ipcRenderer.invoke('skills:delete', id),
    download: (source: string) => ipcRenderer.invoke('skills:download', source),
    upgrade: (skillId: string, downloadUrl: string) =>
      ipcRenderer.invoke('skills:upgrade', skillId, downloadUrl),
    confirmInstall: (pendingId: string, action: string) =>
      ipcRenderer.invoke('skills:confirmInstall', pendingId, action),
    getRoot: () => ipcRenderer.invoke('skills:getRoot'),
    autoRoutingPrompt: () => ipcRenderer.invoke('skills:autoRoutingPrompt'),
    getConfig: (skillId: string) => ipcRenderer.invoke('skills:getConfig', skillId),
    setConfig: (skillId: string, config: Record<string, string>) =>
      ipcRenderer.invoke('skills:setConfig', skillId, config),
    getEmailAccountsConfig: (skillId: string) =>
      ipcRenderer.invoke('skills:getEmailAccountsConfig', skillId),
    setEmailAccountsConfig: (skillId: string, config: unknown) =>
      ipcRenderer.invoke('skills:setEmailAccountsConfig', skillId, config),
    testEmailAccountConnectivity: (skillId: string, account: unknown) =>
      ipcRenderer.invoke('skills:testEmailAccountConnectivity', skillId, account),
    testEmailConnectivity: (skillId: string, config: Record<string, string>) =>
      ipcRenderer.invoke('skills:testEmailConnectivity', skillId, config),
    fetchMarketplace: () => ipcRenderer.invoke('skills:fetchMarketplace'),
    detectFromOpenClaw: () => ipcRenderer.invoke('skills:detectFromOpenClaw'),
    syncFromOpenClaw: () => ipcRenderer.invoke('skills:syncFromOpenClaw'),
    refreshPluginSkillIds: () => ipcRenderer.invoke('skills:refreshPluginSkillIds'),
    onChanged: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('skills:changed', handler);
      return () => ipcRenderer.removeListener('skills:changed', handler);
    },
  },
  mcp: {
    neteaseMail: {
      getAvailability: (reference?: NeteaseMailConfirmationReference) => ipcRenderer.invoke(NeteaseMailIpc.Availability, reference),
      authorize: (options?: NeteaseMailAuthorizationOptions) => ipcRenderer.invoke(NeteaseMailIpc.Authorize, options),
      cancelAuthorization: () => ipcRenderer.invoke(NeteaseMailIpc.CancelAuthorization),
      disconnect: () => ipcRenderer.invoke(NeteaseMailIpc.Disconnect),
      resolveConfirmation: (request: NeteaseMailConfirmationRequest) => ipcRenderer.invoke(NeteaseMailIpc.ResolveConfirmation, request),
    } satisfies NeteaseMailBridge,
    list: () => ipcRenderer.invoke(McpIpcChannel.List),
    create: (data: any) => ipcRenderer.invoke(McpIpcChannel.Create, data),
    update: (id: string, data: any) => ipcRenderer.invoke(McpIpcChannel.Update, id, data),
    delete: (id: string) => ipcRenderer.invoke(McpIpcChannel.Delete, id),
    deleteByRegistryId: (registryId: string) =>
      ipcRenderer.invoke(McpIpcChannel.DeleteByRegistryId, registryId),
    setEnabled: (options: { id: string; enabled: boolean }) =>
      ipcRenderer.invoke(McpIpcChannel.SetEnabled, options),
    setEnabledByRegistryId: (options: { registryId: string; enabled: boolean }) =>
      ipcRenderer.invoke(McpIpcChannel.SetEnabledByRegistryId, options),
    retryLaunchResolution: (id: string) => ipcRenderer.invoke(McpIpcChannel.RetryLaunchResolution, id),
    listTools: (request: McpToolDiscoveryRequest) => ipcRenderer.invoke(McpIpcChannel.ListTools, request),
    fetchMarketplace: () => ipcRenderer.invoke(McpIpcChannel.FetchMarketplace),
    connectQichacha: () => ipcRenderer.invoke(McpIpcChannel.ConnectQichacha),
    oauthLogin: (id: string) => ipcRenderer.invoke(McpIpcChannel.OAuthLogin, id),
    oauthCancel: (id: string) => ipcRenderer.invoke(McpIpcChannel.OAuthCancel, id),
    oauthLogout: (id: string) => ipcRenderer.invoke(McpIpcChannel.OAuthLogout, id),
    oauthStatus: () => ipcRenderer.invoke(McpIpcChannel.OAuthStatus),
    onChanged: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(McpIpcChannel.Changed, handler);
      return () => ipcRenderer.removeListener(McpIpcChannel.Changed, handler);
    },
  },
  kits: {
    fetchStore: (): Promise<KitStoreResponse> => ipcRenderer.invoke(KitIpcChannel.FetchStore),
    install: (params: {
      kitId: string;
      bundleUrl: string;
      version: string;
      skillListIds: string[];
      skillList?: KitSkillMetadata[];
      mcpServers?: unknown[] | null;
      connectors?: unknown[] | null;
    }) =>
      ipcRenderer.invoke('kits:install', params),
    uninstall: (kitId: string) => ipcRenderer.invoke('kits:uninstall', kitId),
    listInstalled: () => ipcRenderer.invoke('kits:listInstalled'),
  },
  skin: {
    getActive: (): Promise<SkinGetActiveResponse> => ipcRenderer.invoke(SkinIpc.GetActive),
    list: (): Promise<SkinListResponse> => ipcRenderer.invoke(SkinIpc.List),
    apply: (skinId: string, boundThemeId?: string): Promise<SkinApplyResponse> =>
      ipcRenderer.invoke(SkinIpc.Apply, skinId, boundThemeId),
    bindTheme: (skinId: string, themeId: string): Promise<SkinBindThemeResponse> =>
      ipcRenderer.invoke(SkinIpc.BindTheme, skinId, themeId),
    setBackdropVisibility: (
      skinId: string,
      visibility: SkinBackdropVisibility,
    ): Promise<SkinSetBackdropVisibilityResponse> =>
      ipcRenderer.invoke(SkinIpc.SetBackdropVisibility, skinId, visibility),
    deactivate: (): Promise<SkinDeactivateResponse> => ipcRenderer.invoke(SkinIpc.Deactivate),
    delete: (skinId: string): Promise<SkinDeleteResponse> => ipcRenderer.invoke(SkinIpc.Delete, skinId),
    onChanged: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(SkinIpc.Changed, handler);
      return () => ipcRenderer.removeListener(SkinIpc.Changed, handler);
    },
  },
  permissions: {
    checkCalendar: () => ipcRenderer.invoke(PermissionIpcChannel.CheckCalendar),
    requestCalendar: () => ipcRenderer.invoke(PermissionIpcChannel.RequestCalendar),
  },
  enterprise: {
    getConfig: () => ipcRenderer.invoke('enterprise:getConfig'),
  },
  enterpriseAccount: {
    getContext: () => ipcRenderer.invoke(EnterpriseAccountIpcChannel.GetContext),
    getIdentities: () => ipcRenderer.invoke(EnterpriseAccountIpcChannel.GetIdentities),
    requestQuotaIncrease: (enterpriseId: number, requestType: EnterpriseQuotaRequestType) => (
      ipcRenderer.invoke(EnterpriseAccountIpcChannel.RequestQuotaIncrease, enterpriseId, requestType)
    ),
    onContextInvalidated: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(EnterpriseAccountIpcChannel.ContextInvalidated, handler);
      return () => ipcRenderer.removeListener(EnterpriseAccountIpcChannel.ContextInvalidated, handler);
    },
  },
  api: {
    // 普通 API 请求（非流式）
    fetch: (options: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
    }) => ipcRenderer.invoke('api:fetch', options),

    // 流式 API 请求
    stream: (options: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
      requestId: string;
    }) => ipcRenderer.invoke('api:stream', options),

    // 取消流式请求
    cancelStream: (requestId: string) => ipcRenderer.invoke('api:stream:cancel', requestId),

    // 监听流式数据
    onStreamData: (requestId: string, callback: (chunk: string) => void) => {
      const handler = (_event: any, chunk: string) => callback(chunk);
      ipcRenderer.on(`api:stream:${requestId}:data`, handler);
      return () => ipcRenderer.removeListener(`api:stream:${requestId}:data`, handler);
    },

    // 监听流式完成
    onStreamDone: (requestId: string, callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(`api:stream:${requestId}:done`, handler);
      return () => ipcRenderer.removeListener(`api:stream:${requestId}:done`, handler);
    },

    // 监听流式错误
    onStreamError: (requestId: string, callback: (error: string) => void) => {
      const handler = (_event: any, error: string) => callback(error);
      ipcRenderer.on(`api:stream:${requestId}:error`, handler);
      return () => ipcRenderer.removeListener(`api:stream:${requestId}:error`, handler);
    },

    // 监听流式取消
    onStreamAbort: (requestId: string, callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(`api:stream:${requestId}:abort`, handler);
      return () => ipcRenderer.removeListener(`api:stream:${requestId}:abort`, handler);
    },
  },
  ipcRenderer: {
    send: (channel: string, ...args: any[]) => {
      ipcRenderer.send(channel, ...args);
    },
    on: (channel: string, func: (...args: any[]) => void) => {
      const handler = (_event: any, ...args: any[]) => func(...args);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
  },
  window: {
    minimize: () => ipcRenderer.send('window-minimize'),
    toggleMaximize: () => ipcRenderer.send('window-maximize'),
    close: () => ipcRenderer.send('window-close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    isFullscreen: () => ipcRenderer.invoke(WindowIpcChannel.IsFullscreen),
    showSystemMenu: (position: { x: number; y: number }) =>
      ipcRenderer.send('window:showSystemMenu', position),
    onZoomChanged: (callback: (payload: WindowZoomChangedPayload) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: WindowZoomChangedPayload) => callback(payload);
      ipcRenderer.on(WindowIpcChannel.ZoomChanged, handler);
      return () => ipcRenderer.removeListener(WindowIpcChannel.ZoomChanged, handler);
    },
    onStateChanged: (
      callback: (state: {
        isMaximized: boolean;
        isFullscreen: boolean;
        isFocused: boolean;
      }) => void,
    ) => {
      const handler = (
        _event: any,
        state: { isMaximized: boolean; isFullscreen: boolean; isFocused: boolean },
      ) => callback(state);
      ipcRenderer.on('window:state-changed', handler);
      return () => ipcRenderer.removeListener('window:state-changed', handler);
    },
  },
  checkApiConfig: () => ipcRenderer.invoke('check-api-config'),
  generateSessionTitle: (request: GenerateSessionTitleRequest) =>
    ipcRenderer.invoke(CoworkIpcChannel.GenerateSessionTitle, request),
  getRecentCwds: (limit?: number) => ipcRenderer.invoke('get-recent-cwds', limit),
  dsh: {
    getState: () => ipcRenderer.invoke(DshIpcChannel.GetState),
    getConfig: () => ipcRenderer.invoke(DshIpcChannel.GetConfig),
    setEnabled: (enabled: boolean) => ipcRenderer.invoke(DshIpcChannel.SetEnabled, enabled),
    openWorkbench: () => ipcRenderer.invoke(DshIpcChannel.OpenWorkbench),
    stop: () => ipcRenderer.invoke(DshIpcChannel.Stop),
  },
  decisionModel: {
    getConfig: () => ipcRenderer.invoke(DecisionModelIpcChannel.GetConfig),
    saveConfig: (update: DecisionModelConfigUpdate) => ipcRenderer.invoke(DecisionModelIpcChannel.SaveConfig, update),
    testConnection: (draft: DecisionModelConfigUpdate) =>
      ipcRenderer.invoke(DecisionModelIpcChannel.TestConnection, draft),
  },
  contextCleanup: {
    scan: (options?: { idleDays?: number }) => ipcRenderer.invoke(ContextCleanupIpcChannel.Scan, options),
    apply: (items: ContextCleanupTargetItem[]) => ipcRenderer.invoke(ContextCleanupIpcChannel.Apply, items),
    undo: (undoToken: string) => ipcRenderer.invoke(ContextCleanupIpcChannel.Undo, undoToken),
    dismiss: () => ipcRenderer.invoke(ContextCleanupIpcChannel.Dismiss),
  },
  providerModels: {
    discover: (request: ProviderModelDiscoveryRequest) =>
      ipcRenderer.invoke(ProviderModelDiscoveryIpcChannel.Discover, request),
  },
  openclaw: {
    engine: {
      getStatus: () => ipcRenderer.invoke(OpenClawEngineIpc.GetStatus),
      install: () => ipcRenderer.invoke(OpenClawEngineIpc.Install),
      retryInstall: () => ipcRenderer.invoke(OpenClawEngineIpc.RetryInstall),
      restartGateway: () => ipcRenderer.invoke(OpenClawEngineIpc.RestartGateway),
      repairGatewayState: () => ipcRenderer.invoke(OpenClawEngineIpc.RepairGatewayState),
      repairLoopbackFirewall: () => ipcRenderer.invoke(OpenClawEngineIpc.RepairLoopbackFirewall),
      onProgress: (callback: (status: any) => void) => {
        const handler = (_event: any, status: any) => callback(status);
        ipcRenderer.on(OpenClawEngineIpc.OnProgress, handler);
        return () => ipcRenderer.removeListener(OpenClawEngineIpc.OnProgress, handler);
      },
    },
    sessionPolicy: {
      get: () => ipcRenderer.invoke(OpenClawSessionPolicyIpc.Get),
      set: (config: { keepAlive: '1d' | '7d' | '30d' | '365d' }) =>
        ipcRenderer.invoke(OpenClawSessionPolicyIpc.Set, config),
    },
    userConfig: {
      getStatus: () => ipcRenderer.invoke(OpenClawUserConfigIpc.GetStatus),
      setEnabled: (enabled: boolean) => ipcRenderer.invoke(OpenClawUserConfigIpc.SetEnabled, enabled),
      openFile: () => ipcRenderer.invoke(OpenClawUserConfigIpc.OpenFile),
      revealFile: () => ipcRenderer.invoke(OpenClawUserConfigIpc.RevealFile),
      apply: () => ipcRenderer.invoke(OpenClawUserConfigIpc.Apply),
    },
    session: {
      patch: (options: {
        sessionId: string;
        patch: {
          model?: string | null;
          thinkingLevel?: string | null;
          reasoningLevel?: string | null;
          elevatedLevel?: string | null;
          responseUsage?: 'off' | 'tokens' | 'full' | null;
          sendPolicy?: 'allow' | 'deny' | null;
        };
      }) => ipcRenderer.invoke(OpenClawSessionIpc.Patch, options),
    },
    browser: {
      getHostState: (request?: AgentBrowserHostRequest): Promise<AgentBrowserHostResponse> =>
        ipcRenderer.invoke(BrowserIpc.GetHostState, request),
      setHostView: (request: AgentBrowserHostSetViewRequest): Promise<AgentBrowserHostResponse> =>
        ipcRenderer.invoke(BrowserIpc.SetHostView, request),
      navigateHost: (request: AgentBrowserHostNavigateRequest): Promise<AgentBrowserHostResponse> =>
        ipcRenderer.invoke(BrowserIpc.NavigateHost, request),
      goBackHost: (request?: AgentBrowserHostRequest): Promise<AgentBrowserHostResponse> =>
        ipcRenderer.invoke(BrowserIpc.GoBackHost, request),
      goForwardHost: (request?: AgentBrowserHostRequest): Promise<AgentBrowserHostResponse> =>
        ipcRenderer.invoke(BrowserIpc.GoForwardHost, request),
      reloadHost: (request?: AgentBrowserHostRequest): Promise<AgentBrowserHostResponse> =>
        ipcRenderer.invoke(BrowserIpc.ReloadHost, request),
      stopHost: (request?: AgentBrowserHostRequest): Promise<AgentBrowserHostResponse> =>
        ipcRenderer.invoke(BrowserIpc.StopHost, request),
      createHostPage: (request?: AgentBrowserHostRequest): Promise<AgentBrowserHostResponse> =>
        ipcRenderer.invoke(BrowserIpc.CreateHostPage, request),
      selectHostPage: (request: AgentBrowserHostPageRequest): Promise<AgentBrowserHostResponse> =>
        ipcRenderer.invoke(BrowserIpc.SelectHostPage, request),
      closeHostPage: (request: AgentBrowserHostPageRequest): Promise<AgentBrowserHostResponse> =>
        ipcRenderer.invoke(BrowserIpc.CloseHostPage, request),
      showHostMenu: (request: AgentBrowserHostMenuRequest): Promise<AgentBrowserHostMenuResponse> =>
        ipcRenderer.invoke(BrowserIpc.ShowHostMenu, request),
      captureHostScreenshot: (request?: AgentBrowserHostRequest): Promise<AgentBrowserHostResponse> =>
        ipcRenderer.invoke(BrowserIpc.CaptureHostScreenshot, request),
      setHostZoom: (request: AgentBrowserHostZoomRequest): Promise<AgentBrowserHostResponse> =>
        ipcRenderer.invoke(BrowserIpc.SetHostZoom, request),
      clearHostCookies: (request?: AgentBrowserHostRequest): Promise<AgentBrowserHostResponse> =>
        ipcRenderer.invoke(BrowserIpc.ClearHostCookies, request),
      clearHostCache: (request?: AgentBrowserHostRequest): Promise<AgentBrowserHostResponse> =>
        ipcRenderer.invoke(BrowserIpc.ClearHostCache, request),
      dismissCredentialLoginStatus: (
        request?: AgentBrowserHostRequest,
      ): Promise<AgentBrowserHostResponse> =>
        ipcRenderer.invoke(BrowserIpc.DismissCredentialLoginStatus, request),
      resolveCredentialSavePrompt: (
        request: AgentBrowserCredentialSavePromptRequest,
      ): Promise<AgentBrowserHostResponse> =>
        ipcRenderer.invoke(BrowserIpc.ResolveCredentialSavePrompt, request),
      resolvePasskey: (request: BrowserPasskeyRequest): Promise<AgentBrowserHostResponse> =>
        ipcRenderer.invoke(BrowserIpc.ResolvePasskey, request),
      onHostState: (callback: (event: AgentBrowserHostStateEvent) => void) => {
        const handler = (_event: Electron.IpcRendererEvent, hostEvent: AgentBrowserHostStateEvent) =>
          callback(hostEvent);
        ipcRenderer.on(BrowserIpc.HostState, handler);
        return () => ipcRenderer.removeListener(BrowserIpc.HostState, handler);
      },
      credentials: {
        getAvailability: (): Promise<BrowserCredentialAvailabilityResponse> =>
          ipcRenderer.invoke(BrowserCredentialIpc.GetAvailability),
        requestAccess: (): Promise<BrowserCredentialAvailabilityResponse> =>
          ipcRenderer.invoke(BrowserCredentialIpc.RequestAccess),
        list: (): Promise<BrowserCredentialListResponse> =>
          ipcRenderer.invoke(BrowserCredentialIpc.List),
        save: (request: BrowserCredentialSaveRequest): Promise<BrowserCredentialMutationResponse> =>
          ipcRenderer.invoke(BrowserCredentialIpc.Save, request),
        delete: (request: BrowserCredentialDeleteRequest): Promise<BrowserCredentialMutationResponse> =>
          ipcRenderer.invoke(BrowserCredentialIpc.Delete, request),
      },
    },
    dataMigration: {
      backup: () =>
        ipcRenderer.invoke(DataMigrationIpc.Backup),
      pickRestoreArchive: () =>
        ipcRenderer.invoke(DataMigrationIpc.PickRestoreArchive),
      preview: (request: DataMigrationPreviewRequest) =>
        ipcRenderer.invoke(DataMigrationIpc.Preview, request),
      restore: (request?: DataMigrationRestoreRequest) =>
        ipcRenderer.invoke(DataMigrationIpc.Restore, request),
      getLastRestoreResult: () =>
        ipcRenderer.invoke(DataMigrationIpc.GetLastRestoreResult),
      reinstallPlugins: (request: DataMigrationReinstallPluginsRequest) =>
        ipcRenderer.invoke(DataMigrationIpc.ReinstallPlugins, request),
      onProgress: (callback: (event: DataMigrationProgressEvent) => void) => {
        const listener = (_event: Electron.IpcRendererEvent, payload: DataMigrationProgressEvent) => {
          callback(payload);
        };
        ipcRenderer.on(DataMigrationIpc.Progress, listener);
        return () => {
          ipcRenderer.removeListener(DataMigrationIpc.Progress, listener);
        };
      },
    },
  },
  agents: {
    list: async () => {
      const result = await ipcRenderer.invoke(AgentIpcChannel.List);
      return result?.success ? result.agents : [];
    },
    get: async (id: string) => {
      const result = await ipcRenderer.invoke(AgentIpcChannel.Get, id);
      return result?.success ? result.agent : null;
    },
    create: async (request: {
      id?: string;
      name: string;
      description?: string;
      systemPrompt?: string;
      identity?: string;
      model?: string;
      thinkingLevel?: string;
      workingDirectory?: string;
      icon?: string;
      skillIds?: string[];
      subagentCollaborationMode?: SubagentCollaborationMode;
      subagentAllowAgentIds?: string[];
      source?: string;
      presetId?: string;
    }) => {
      const result = await ipcRenderer.invoke(AgentIpcChannel.Create, request);
      return result?.success ? result.agent : null;
    },
    update: async (
      id: string,
      updates: {
        name?: string;
        description?: string;
        systemPrompt?: string;
        identity?: string;
        model?: string;
        modelSelectionMode?: AgentModelSelectionMode;
        thinkingLevel?: string;
        workingDirectory?: string;
        icon?: string;
        skillIds?: string[];
        subagentCollaborationMode?: SubagentCollaborationMode;
        subagentAllowAgentIds?: string[];
        enabled?: boolean;
        pinned?: boolean;
        sortOrder?: number | null;
      },
    ) => {
      const result = await ipcRenderer.invoke(AgentIpcChannel.Update, id, updates);
      return result?.success ? result.agent : null;
    },
    reorder: async (agentIds: string[]) => {
      const result = await ipcRenderer.invoke(AgentIpcChannel.Reorder, agentIds);
      return result?.success ? result.agents : null;
    },
    cleanupLegacyIdentityBlock: async (id: string) => {
      const result = await ipcRenderer.invoke(AgentIpcChannel.CleanupLegacyIdentityBlock, id);
      return result?.result ?? {
        status: AgentLegacyIdentityCleanupStatus.Failed,
        error: result?.error || 'Failed to clean legacy identity block',
      };
    },
    delete: async (id: string) => {
      const result = await ipcRenderer.invoke(AgentIpcChannel.Delete, id);
      return result?.success ? result.deleted : false;
    },
    generateDraft: async (request: GenerateAgentDraftRequest): Promise<GenerateAgentDraftResult> => {
      const result = await ipcRenderer.invoke(AgentIpcChannel.GenerateDraft, request);
      if (result && typeof result === 'object' && 'success' in result) {
        return result as GenerateAgentDraftResult;
      }
      return {
        success: false,
        errorCode: AgentDraftErrorCode.RequestFailed,
        error: 'Failed to generate agent draft',
      };
    },
    cancelDraft: async (requestId: string): Promise<boolean> => {
      return Boolean(await ipcRenderer.invoke(AgentIpcChannel.CancelDraft, requestId));
    },
    onDraftChunk: (callback: (chunk: AgentDraftStreamChunk) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, chunk: AgentDraftStreamChunk) => {
        if (chunk && typeof chunk.requestId === 'string') {
          callback(chunk);
        }
      };
      ipcRenderer.on(AgentIpcChannel.GenerateDraftChunk, listener);
      return () => {
        ipcRenderer.removeListener(AgentIpcChannel.GenerateDraftChunk, listener);
      };
    },
    presets: async () => {
      const result = await ipcRenderer.invoke(AgentIpcChannel.Presets);
      return result?.success ? result.presets : [];
    },
    presetTemplates: async () => {
      const result = await ipcRenderer.invoke(AgentIpcChannel.PresetTemplates);
      if (!result?.success) throw new Error(result?.error || 'Failed to load preset templates');
      return result.presets;
    },
    expertCatalog: async () => {
      const result = await ipcRenderer.invoke(AgentIpcChannel.ExpertCatalog);
      if (!result?.success) throw new Error(result?.error || 'Failed to load expert catalog');
      return result.catalog;
    },
    upgradePreset: (agentId: string, revision: number) => ipcRenderer.invoke(AgentIpcChannel.UpgradePreset, agentId, revision),
    dismissPresetUpdate: (agentId: string, revision: number) => ipcRenderer.invoke(AgentIpcChannel.DismissPresetUpdate, agentId, revision),
    isExpertBusy: (agentId: string) => ipcRenderer.invoke(AgentIpcChannel.IsExpertBusy, agentId),
    addPreset: async (presetId: string, modelSelection?: AgentModelSelection) => {
      const result = await ipcRenderer.invoke(AgentIpcChannel.AddPreset, presetId, modelSelection);
      if (!result?.success) throw new Error(result?.error || 'Failed to add preset agent');
      return result.agent;
    },
    onChanged: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(AgentIpcChannel.Changed, handler);
      return () => ipcRenderer.removeListener(AgentIpcChannel.Changed, handler);
    },
  },
  cowork: {
    // Session management
    startSession: (options: {
      submissionId?: string;
      pptCover?: PptCoverRequest;
      analytics?: UsageContext;
      prompt: string;
      cwd?: string;
      systemPrompt?: string;
      title?: string;
      activeSkillIds?: string[];
      inheritedSkillIds?: string[];
      runtimeSkillIds?: string[];
      kitIds?: string[];
      kitReferences?: KitReference[];
      resolvedKitCapabilities?: ResolvedKitCapabilities;
      selectedTextSnippets?: Array<{ id: string; text: string; sourceMessageId?: string; sourceMessageType?: 'assistant' | 'artifact_markdown' | 'artifact_text' | 'artifact_sheet' | 'artifact_word' | 'artifact_slides'; sourceId?: string; sourceType?: 'assistant' | 'artifact_markdown' | 'artifact_text' | 'artifact_sheet' | 'artifact_word' | 'artifact_slides'; sourceTitle?: string; sourcePath?: string; artifactId?: string; createdAt: number; startOffset?: number; endOffset?: number }>;
      browserAnnotations?: CoworkBrowserAnnotationMessageBatch[];
      agentId?: string;
      modelOverride?: string;
      modelPresetId?: ModelPresetId;
      thinkingLevel?: string;
      imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string; sizeBytes?: number; localPath?: string; previewMimeType?: string; previewBase64Data?: string }>;
      mediaSelection?: MediaSelection; mediaReferences?: Array<{ token: string; mediaType: string; index: number; fileId: string; fileName: string; mimeType: string; localPath?: string; remoteUrl?: string; dataUrl?: string; role?: string }>;
    }) => ipcRenderer.invoke(CoworkIpcChannel.SessionStart, options),
    editMessage: (request: import('../shared/cowork/messageEdit').CoworkMessageEditRequest) => ipcRenderer.invoke(CoworkIpcChannel.EditMessage, request),
    getMessageEdit: (sessionId: string) => ipcRenderer.invoke(CoworkIpcChannel.GetMessageEdit, sessionId),
    checkMessageEdit: (request: { sessionId: string; messageId: string }) => ipcRenderer.invoke(CoworkIpcChannel.CheckMessageEdit, request),
    recoverMessageEdit: (request: { sessionId: string; operationId: string }) => ipcRenderer.invoke(CoworkIpcChannel.RecoverMessageEdit, request),
    switchMessageVersion: (request: import('../shared/cowork/messageEdit').CoworkMessageVersionSwitchRequest) => ipcRenderer.invoke(CoworkIpcChannel.SwitchMessageVersion, request),
    continueSession: (options: {
      retryMessageId?: string;
      submissionId?: string;
      analytics?: UsageContext;
      sessionId: string;
      prompt: string;
      systemPrompt?: string;
      activeSkillIds?: string[];
      inheritedSkillIds?: string[];
      runtimeSkillIds?: string[];
      kitIds?: string[];
      kitReferences?: KitReference[];
      resolvedKitCapabilities?: ResolvedKitCapabilities;
      selectedTextSnippets?: Array<{ id: string; text: string; sourceMessageId?: string; sourceMessageType?: 'assistant' | 'artifact_markdown' | 'artifact_text' | 'artifact_sheet' | 'artifact_word' | 'artifact_slides'; sourceId?: string; sourceType?: 'assistant' | 'artifact_markdown' | 'artifact_text' | 'artifact_sheet' | 'artifact_word' | 'artifact_slides'; sourceTitle?: string; sourcePath?: string; artifactId?: string; createdAt: number; startOffset?: number; endOffset?: number }>;
      browserAnnotations?: CoworkBrowserAnnotationMessageBatch[];
      imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string; sizeBytes?: number; localPath?: string; previewMimeType?: string; previewBase64Data?: string }>;
      mediaSelection?: MediaSelection;
      mediaReferences?: Array<{
        token: string;
        mediaType: string;
        index: number;
        fileId: string;
        fileName: string;
        mimeType: string;
        localPath?: string;
        remoteUrl?: string;
        dataUrl?: string; role?: string;
      }>;
    }) => ipcRenderer.invoke(CoworkIpcChannel.SessionContinue, options),
    submitBtw: (options: CoworkBtwSubmitRequest): Promise<CoworkBtwSubmitResponse> =>
      ipcRenderer.invoke(CoworkIpcChannel.SubmitBtw, options),
    abortBtw: (options: CoworkBtwAbortRequest): Promise<CoworkBtwAbortResponse> =>
      ipcRenderer.invoke(CoworkIpcChannel.AbortBtw, options),
    sideChat: {
      list: (options: { parentSessionId: string }): Promise<CoworkSideChatListResponse> =>
        ipcRenderer.invoke(CoworkSideChatIpcChannel.List, options),
      get: (options: { sideChatId: string }): Promise<CoworkSideChatGetResponse> =>
        ipcRenderer.invoke(CoworkSideChatIpcChannel.Get, options),
      create: (options: CoworkSideChatCreateRequest): Promise<CoworkSideChatCreateResponse> =>
        ipcRenderer.invoke(CoworkSideChatIpcChannel.Create, options),
      sendMessage: (options: CoworkSideChatSendRequest): Promise<CoworkSideChatActionResponse> =>
        ipcRenderer.invoke(CoworkSideChatIpcChannel.SendMessage, options),
      stop: (options: CoworkSideChatStopRequest): Promise<CoworkSideChatActionResponse> =>
        ipcRenderer.invoke(CoworkSideChatIpcChannel.Stop, options),
      rename: (options: CoworkSideChatRenameRequest): Promise<CoworkSideChatRenameResponse> =>
        ipcRenderer.invoke(CoworkSideChatIpcChannel.Rename, options),
      delete: (options: CoworkSideChatDeleteRequest): Promise<CoworkSideChatActionResponse> =>
        ipcRenderer.invoke(CoworkSideChatIpcChannel.Delete, options),
      promote: (options: CoworkSideChatPromoteRequest): Promise<CoworkSideChatPromoteResponse> =>
        ipcRenderer.invoke(CoworkSideChatIpcChannel.Promote, options),
      respondPermission: (options: CoworkSideChatRespondPermissionRequest): Promise<CoworkSideChatActionResponse> =>
        ipcRenderer.invoke(CoworkSideChatIpcChannel.RespondPermission, options),
      onStreamMessage: (callback: (data: CoworkSideChatStreamMessageEvent) => void) => {
        const handler = (_event: Electron.IpcRendererEvent, data: CoworkSideChatStreamMessageEvent) => callback(data);
        ipcRenderer.on(CoworkSideChatIpcChannel.StreamMessage, handler);
        return () => ipcRenderer.removeListener(CoworkSideChatIpcChannel.StreamMessage, handler);
      },
      onStreamMessageUpdate: (callback: (data: CoworkSideChatStreamMessageUpdateEvent) => void) => {
        const handler = (_event: Electron.IpcRendererEvent, data: CoworkSideChatStreamMessageUpdateEvent) => callback(data);
        ipcRenderer.on(CoworkSideChatIpcChannel.StreamMessageUpdate, handler);
        return () => ipcRenderer.removeListener(CoworkSideChatIpcChannel.StreamMessageUpdate, handler);
      },
      onStreamStatus: (callback: (data: CoworkSideChatStreamStatusEvent) => void) => {
        const handler = (_event: Electron.IpcRendererEvent, data: CoworkSideChatStreamStatusEvent) => callback(data);
        ipcRenderer.on(CoworkSideChatIpcChannel.StreamStatus, handler);
        return () => ipcRenderer.removeListener(CoworkSideChatIpcChannel.StreamStatus, handler);
      },
      onStreamMetaChanged: (callback: (data: CoworkSideChatStreamMetaChangedEvent) => void) => {
        const handler = (_event: Electron.IpcRendererEvent, data: CoworkSideChatStreamMetaChangedEvent) => callback(data);
        ipcRenderer.on(CoworkSideChatIpcChannel.StreamMetaChanged, handler);
        return () => ipcRenderer.removeListener(CoworkSideChatIpcChannel.StreamMetaChanged, handler);
      },
      onStreamPermission: (callback: (data: CoworkSideChatPermissionRequest) => void) => {
        const handler = (_event: Electron.IpcRendererEvent, data: CoworkSideChatPermissionRequest) => callback(data);
        ipcRenderer.on(CoworkSideChatIpcChannel.StreamPermission, handler);
        return () => ipcRenderer.removeListener(CoworkSideChatIpcChannel.StreamPermission, handler);
      },
      onStreamPermissionResolved: (callback: (data: CoworkSideChatStreamPermissionResolvedEvent) => void) => {
        const handler = (_event: Electron.IpcRendererEvent, data: CoworkSideChatStreamPermissionResolvedEvent) => callback(data);
        ipcRenderer.on(CoworkSideChatIpcChannel.StreamPermissionResolved, handler);
        return () => ipcRenderer.removeListener(CoworkSideChatIpcChannel.StreamPermissionResolved, handler);
      },
    },
    submitSteer: (options: { sessionId: string; text: string; clientSteerId: string }) =>
      ipcRenderer.invoke(CoworkIpcChannel.SubmitSteer, options),
    runGoalCommand: (options: { sessionId: string; command: string }) =>
      ipcRenderer.invoke(CoworkIpcChannel.GoalCommand, options),
    refreshTurnUsage: (options: { sessionId: string; messageId: string }): Promise<CoworkTurnUsage | null> =>
      ipcRenderer.invoke(CoworkIpcChannel.RefreshTurnUsage, options),
    stopSession: (sessionId: string) =>
      ipcRenderer.invoke(CoworkIpcChannel.StopSession, sessionId),
    deleteSession: (sessionId: string) => ipcRenderer.invoke(CoworkIpcChannel.DeleteSession, sessionId),
    deleteSessions: (sessionIds: string[]) =>
      ipcRenderer.invoke(CoworkIpcChannel.DeleteSessions, sessionIds),
    setSessionPinned: (options: { sessionId: string; pinned: boolean }) =>
      ipcRenderer.invoke('cowork:session:pin', options),
    reorderPinnedSessions: (options: { sessionIds: string[] }) =>
      ipcRenderer.invoke(CoworkIpcChannel.ReorderPinnedSessions, options),
    renameSession: (options: { sessionId: string; title: string }) =>
      ipcRenderer.invoke(CoworkIpcChannel.RenameSession, options),
    forkSession: (options: {
      sessionId: string;
      forkedFromMessageId?: string | null;
      title?: string;
    }) => ipcRenderer.invoke(CoworkIpcChannel.ForkSession, options),
    getSession: (sessionId: string) => ipcRenderer.invoke(CoworkIpcChannel.GetSession, sessionId),
    markSessionViewed: (sessionId: string) =>
      ipcRenderer.invoke(CoworkIpcChannel.MarkSessionViewed, sessionId),
    setActiveSession: (sessionId: string | null) =>
      ipcRenderer.invoke(CoworkIpcChannel.SetActiveSession, sessionId),
    seedNewUserWelcomeTask: (options: { title: string; content: string }) =>
      ipcRenderer.invoke(CoworkIpcChannel.SeedNewUserWelcomeTask, options),
    notifyOpenSessionFromNotificationReady: () =>
      ipcRenderer.invoke(CoworkIpcChannel.OpenSessionFromNotificationReady),
    remoteManaged: (sessionId: string) =>
      ipcRenderer.invoke('cowork:session:remoteManaged', sessionId),
    listSessions: (options?: {
      limit?: number;
      offset?: number;
      agentId?: string;
      searchQuery?: string;
      pinnedFirst?: boolean;
    }) => ipcRenderer.invoke(CoworkIpcChannel.ListSessions, options),
    getSessionMessages: (options: { sessionId: string; limit?: number; offset?: number }) =>
      ipcRenderer.invoke('cowork:session:getMessages', options),
    getSessionSearchMessages: (options: {
      sessionId: string;
      limit?: number;
      offset?: number;
      cursor?: CoworkSearchMessageCursor;
      knownTotal?: number;
    }) =>
      ipcRenderer.invoke(CoworkIpcChannel.GetSessionSearchMessages, options),
    searchSessionContent: (options: { query: string; limit?: number; agentId?: string }) =>
      ipcRenderer.invoke(CoworkIpcChannel.SearchSessionContent, options),
    listFilteredSessions: (query: CoworkSessionFilterQuery) =>
      ipcRenderer.invoke(CoworkIpcChannel.ListFilteredSessions, query),
    getSessionMessageRailIndex: (sessionId: string) =>
      ipcRenderer.invoke(CoworkIpcChannel.GetSessionMessageRailIndex, sessionId),
    getContextUsage: (sessionId: string) =>
      ipcRenderer.invoke('cowork:session:contextUsage', sessionId),
    compactContext: (sessionId: string) =>
      ipcRenderer.invoke('cowork:session:compactContext', sessionId),
    exportResultImage: (options: {
      rect: { x: number; y: number; width: number; height: number };
      defaultFileName?: string;
    }) => ipcRenderer.invoke('cowork:session:exportResultImage', options),
    captureImageChunk: (options: {
      rect: { x: number; y: number; width: number; height: number };
    }) => ipcRenderer.invoke('cowork:session:captureImageChunk', options),
    saveResultImage: (options: { pngBase64: string; defaultFileName?: string }) =>
      ipcRenderer.invoke('cowork:session:saveResultImage', options),
    exportSessionText: (options: {
      content: string;
      defaultFileName?: string;
      fileExtension?: string;
    }) => ipcRenderer.invoke('cowork:session:exportText', options),
    exportSessionDiagnostics: (options: { sessionId: string }) =>
      ipcRenderer.invoke(CoworkIpcChannel.ExportSessionDiagnostics, options),

    // Subagent tracking
    getSubTaskHistory: (options: {
      parentSessionId: string;
      agentId: string;
      sessionKey?: string;
    }) => ipcRenderer.invoke(CoworkIpcChannel.SubTaskHistory, options),
    listSubagentSessions: (parentSessionId: string) =>
      ipcRenderer.invoke(CoworkIpcChannel.SubagentList, { parentSessionId }),
    listSubagentSessionsByAgent: (options: { agentId: string; limit?: number; offset?: number }) =>
      ipcRenderer.invoke(CoworkIpcChannel.SubagentListByAgent, options),
    deleteSubagentSession: (options: { parentSessionId: string; runId: string }) =>
      ipcRenderer.invoke(CoworkIpcChannel.SubagentDelete, options),

    // Media task management
    cancelMediaTask: (taskId: string) =>
      ipcRenderer.invoke(CoworkIpcChannel.CancelMediaTask, taskId),

    // Permission handling
    respondToPermission: (options: { requestId: string; result: any }) =>
      ipcRenderer.invoke(CoworkIpcChannel.PermissionRespond, options),

    // Configuration
    getConfig: () => ipcRenderer.invoke('cowork:config:get'),
    setConfig: (config: {
      workingDirectory?: string;
      executionMode?: 'auto' | 'local' | 'sandbox';
      agentEngine?: 'dsh';
      memoryEnabled?: boolean;
      memoryImplicitUpdateEnabled?: boolean;
      memoryLlmJudgeEnabled?: boolean;
      memoryGuardLevel?: 'strict' | 'standard' | 'relaxed';
      memoryUserMemoriesMaxItems?: number;
      skipMissedJobs?: boolean;
      openClawHeartbeatEnabled?: boolean;
      openClawSkillReviewEnabled?: boolean;
      openClawMemoryFlushEnabled?: boolean;
      embeddingEnabled?: boolean;
      embeddingProvider?: string;
      embeddingModel?: string;
      embeddingLocalModelPath?: string;
      embeddingVectorWeight?: number;
      embeddingRemoteBaseUrl?: string;
      embeddingRemoteApiKey?: string;
    }) => ipcRenderer.invoke(CoworkIpcChannel.ConfigSet, config),

    // Session temp storage (.cowork-temp) maintenance
    getTempStorageUsage: () => ipcRenderer.invoke(CoworkIpcChannel.TempStorageUsage),
    cleanTempStorage: (options?: { cwds?: string[] }) =>
      ipcRenderer.invoke(CoworkIpcChannel.TempStorageClean, options),
    listMemoryEntries: (input?: {
      agentId?: string;
      query?: string;
      status?: CoworkMemoryStatusFilter;
      includeDeleted?: boolean;
      limit?: number;
      offset?: number;
    }) => ipcRenderer.invoke(CoworkIpcChannel.MemoryListEntries, input),
    createMemoryEntry: (input: {
      agentId?: string;
      text: string;
      section?: string;
      confidence?: number;
      isExplicit?: boolean;
    }) => ipcRenderer.invoke(CoworkIpcChannel.MemoryCreateEntry, input),
    updateMemoryEntry: (input: {
      agentId?: string;
      id: string;
      text?: string;
      confidence?: number;
      status?: CoworkMemoryStatus;
      isExplicit?: boolean;
    }) => ipcRenderer.invoke(CoworkIpcChannel.MemoryUpdateEntry, input),
    deleteMemoryEntry: (input: { agentId?: string; id: string }) =>
      ipcRenderer.invoke(CoworkIpcChannel.MemoryDeleteEntry, input),
    deleteMemoryEntries: (input: { agentId?: string; ids: string[] }) =>
      ipcRenderer.invoke(CoworkIpcChannel.MemoryDeleteEntries, input),
    getMemoryStats: (options?: { agentId?: string }) =>
      ipcRenderer.invoke(CoworkIpcChannel.MemoryGetStats, options),
    readMemoryFileRaw: (options?: { agentId?: string }) =>
      ipcRenderer.invoke(CoworkIpcChannel.MemoryReadRaw, options),
    writeMemoryFileRaw: (input: { agentId?: string; content: string }) =>
      ipcRenderer.invoke(CoworkIpcChannel.MemoryWriteRaw, input),
    readBootstrapFile: (filename: string, options?: { agentId?: string }) =>
      ipcRenderer.invoke(CoworkIpcChannel.BootstrapRead, filename, options),
    writeBootstrapFile: (filename: string, content: string, options?: { agentId?: string }) =>
      ipcRenderer.invoke(CoworkIpcChannel.BootstrapWrite, filename, content, options),
    // Stream event listeners
    onStreamMessage: (callback: (data: { sessionId: string; message: any; beforeMessageId?: string }) => void) => {
      const handler = (_event: any, data: { sessionId: string; message: any; beforeMessageId?: string }) => callback(data);
      ipcRenderer.on('cowork:stream:message', handler);
      return () => ipcRenderer.removeListener('cowork:stream:message', handler);
    },
    onStreamMessageUpdate: (
      callback: (data: {
        sessionId: string;
        messageId: string;
        content: string;
        metadata?: Record<string, unknown>;
      }) => void,
    ) => {
      const handler = (
        _event: any,
        data: {
          sessionId: string;
          messageId: string;
          content: string;
          metadata?: Record<string, unknown>;
        },
      ) => callback(data);
      ipcRenderer.on('cowork:stream:messageUpdate', handler);
      return () => ipcRenderer.removeListener('cowork:stream:messageUpdate', handler);
    },
    onMediaStatusPollUpdate: (callback: (data: { sessionId: string; toolCallId: string; details: Record<string, unknown> }) => void) => {
      const handler = (_event: any, data: { sessionId: string; toolCallId: string; details: Record<string, unknown> }) => callback(data);
      ipcRenderer.on(CoworkIpcChannel.MediaStatusPollUpdate, handler);
      return () => ipcRenderer.removeListener(CoworkIpcChannel.MediaStatusPollUpdate, handler);
    },
    onStreamSessionStatus: (callback: (data: { sessionId: string; status: string }) => void) => {
      const handler = (_event: any, data: { sessionId: string; status: string }) => callback(data);
      ipcRenderer.on('cowork:stream:sessionStatus', handler);
      return () => ipcRenderer.removeListener('cowork:stream:sessionStatus', handler);
    },
    onStreamContextUsage: (callback: (data: { sessionId: string; usage: any }) => void) => {
      const handler = (_event: any, data: { sessionId: string; usage: any }) => callback(data);
      ipcRenderer.on('cowork:stream:contextUsage', handler);
      return () => ipcRenderer.removeListener('cowork:stream:contextUsage', handler);
    },
    onStreamGoal: (callback: (data: { sessionId: string; goal: any }) => void) => {
      const handler = (_event: any, data: { sessionId: string; goal: any }) => callback(data);
      ipcRenderer.on(CoworkIpcChannel.StreamGoal, handler);
      return () => ipcRenderer.removeListener(CoworkIpcChannel.StreamGoal, handler);
    },
    onStreamTurnUsage: (
      callback: (data: { sessionId: string; messageId: string; turnUsage: CoworkTurnUsage }) => void,
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: { sessionId: string; messageId: string; turnUsage: CoworkTurnUsage },
      ) => callback(data);
      ipcRenderer.on(CoworkIpcChannel.StreamTurnUsage, handler);
      return () => ipcRenderer.removeListener(CoworkIpcChannel.StreamTurnUsage, handler);
    },
    onStreamBtwResult: (
      callback: (data: { sessionId: string; result: CoworkBtwEntry }) => void,
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: { sessionId: string; result: CoworkBtwEntry },
      ) => callback(data);
      ipcRenderer.on(CoworkIpcChannel.StreamBtwResult, handler);
      return () => ipcRenderer.removeListener(CoworkIpcChannel.StreamBtwResult, handler);
    },
    onStreamContextMaintenance: (
      callback: (data: { sessionId: string; active: boolean }) => void,
    ) => {
      const handler = (_event: any, data: { sessionId: string; active: boolean }) => callback(data);
      ipcRenderer.on('cowork:stream:contextMaintenance', handler);
      return () => ipcRenderer.removeListener('cowork:stream:contextMaintenance', handler);
    },
    onStreamPermission: (callback: (data: { sessionId: string; request: any }) => void) => {
      const handler = (_event: any, data: { sessionId: string; request: any }) => callback(data);
      ipcRenderer.on('cowork:stream:permission', handler);
      return () => ipcRenderer.removeListener('cowork:stream:permission', handler);
    },
    getPendingQuestions: () => ipcRenderer.invoke(CoworkIpcChannel.GetPendingQuestions),
    mediaConfirmation: (command: import('../shared/media/confirmation').MediaConfirmationCommand) =>
      ipcRenderer.invoke(CoworkIpcChannel.MediaConfirmation, command),
    onStreamPermissionDismiss: (callback: (data: { requestId: string }) => void) => {
      const handler = (_event: any, data: { requestId: string }) => callback(data);
      ipcRenderer.on(CoworkIpcChannel.StreamPermissionDismiss, handler);
      return () => ipcRenderer.removeListener(CoworkIpcChannel.StreamPermissionDismiss, handler);
    },
    onStreamComplete: (
      callback: (data: { sessionId: string; claudeSessionId: string | null }) => void,
    ) => {
      const handler = (_event: any, data: { sessionId: string; claudeSessionId: string | null }) =>
        callback(data);
      ipcRenderer.on('cowork:stream:complete', handler);
      return () => ipcRenderer.removeListener('cowork:stream:complete', handler);
    },
    onStreamError: (callback: (data: { sessionId: string; error: string }) => void) => {
      const handler = (_event: any, data: { sessionId: string; error: string }) => callback(data);
      ipcRenderer.on('cowork:stream:error', handler);
      return () => ipcRenderer.removeListener('cowork:stream:error', handler);
    },
    onSessionsChanged: (callback: (data?: CoworkSessionsChangedPayload) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data?: CoworkSessionsChangedPayload) => callback(data);
      ipcRenderer.on(CoworkIpcChannel.SessionsChanged, handler);
      return () => ipcRenderer.removeListener(CoworkIpcChannel.SessionsChanged, handler);
    },
    onSessionModelOverrideChanged: (
      callback: (data: { sessionId: string; modelOverride: string }) => void,
    ) => {
      const handler = (_event: any, data: { sessionId: string; modelOverride: string }) => callback(data);
      ipcRenderer.on(CoworkIpcChannel.SessionModelOverrideChanged, handler);
      return () => ipcRenderer.removeListener(CoworkIpcChannel.SessionModelOverrideChanged, handler);
    },
    onOpenSessionFromNotification: (callback: (data: { sessionId: string }) => void) => {
      const handler = (_event: any, data: { sessionId: string }) => callback(data);
      ipcRenderer.on(CoworkIpcChannel.OpenSessionFromNotification, handler);
      return () => ipcRenderer.removeListener(CoworkIpcChannel.OpenSessionFromNotification, handler);
    },
  },
  workspaceReview: {
    read: (input: ReviewScopeRequest) => ipcRenderer.invoke(ReviewIpc.Read, input),
    source: (input: ReviewSourceRequest) => ipcRenderer.invoke(ReviewIpc.Source, input),
  },
  dialog: {
    selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),
    selectFile: (options?: {
      title?: string;
      filters?: { name: string; extensions: string[] }[];
    }) => ipcRenderer.invoke('dialog:selectFile', options),
    selectFiles: (options?: {
      title?: string;
      filters?: { name: string; extensions: string[] }[];
    }) => ipcRenderer.invoke('dialog:selectFiles', options),
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
    saveInlineFile: (options: {
      dataBase64: string;
      fileName?: string;
      mimeType?: string;
      cwd?: string;
    }) => ipcRenderer.invoke('dialog:saveInlineFile', options),
    readFileAsDataUrl: (filePath: string) =>
      ipcRenderer.invoke('dialog:readFileAsDataUrl', filePath),
    statFile: (filePath: string) =>
      ipcRenderer.invoke(DialogIpc.StatFile, filePath),
    readTextFile: (filePath: string) =>
      ipcRenderer.invoke(DialogIpc.ReadTextFile, filePath),
    saveFileCopy: (filePath: string) =>
      ipcRenderer.invoke(DialogIpc.SaveFileCopy, filePath),
    generateThumbnail: (request: import('../shared/library/thumbnail').LibraryThumbnailGenerateRequest) =>
      ipcRenderer.invoke(DialogIpc.GenerateThumbnail, request),
    cancelThumbnail: (requestId: string) =>
      ipcRenderer.invoke(DialogIpc.CancelThumbnail, requestId),
    showMessageBox: (options: {
      message: string;
      type?: 'none' | 'info' | 'error' | 'question' | 'warning';
      title?: string;
    }) => ipcRenderer.invoke('dialog:showMessageBox', options),
  },
  shell: {
    openPath: (filePath: string) => ipcRenderer.invoke(ShellIpc.OpenPath, filePath),
    showItemInFolder: (filePath: string) => ipcRenderer.invoke(ShellIpc.ShowItemInFolder, filePath),
    openExternal: (url: string) => ipcRenderer.invoke(ShellIpc.OpenExternal, url),
    openHtmlInBrowser: (htmlContent: string) =>
      ipcRenderer.invoke(ShellIpc.OpenHtmlInBrowser, htmlContent),
    getAppsForFile: (filePath: string) => ipcRenderer.invoke(ShellIpc.GetAppsForFile, filePath),
    getBrowserApps: (options?: ShellGetBrowserAppsInput) =>
      ipcRenderer.invoke(ShellIpc.GetBrowserApps, options),
    openPathWithApp: (filePath: string, appPath: string) =>
      ipcRenderer.invoke(ShellIpc.OpenPathWithApp, filePath, appPath),
    openUrlWithApp: (url: string, appPath: string) =>
      ipcRenderer.invoke(ShellIpc.OpenUrlWithApp, url, appPath),
  },
  clipboard: {
    writeText: (text: string) =>
      ipcRenderer.invoke(ClipboardIpc.WriteText, text),
    writeTextAndHtml: (content: { text: string; html: string }) =>
      ipcRenderer.invoke(ClipboardIpc.WriteTextAndHtml, content),
    writeImageFromFile: (filePath: string) =>
      ipcRenderer.invoke(ClipboardIpc.WriteImageFromFile, filePath),
    writeImageFromDataUrl: (dataUrl: string) =>
      ipcRenderer.invoke(ClipboardIpc.WriteImageFromDataUrl, dataUrl),
  },
  htmlShare: {
    createFromHtmlFile: (options: {
      sessionId: string;
      artifactId: string;
      filePath: string;
      title: string;
      accessMode?: HtmlShareAccessMode;
    }) => ipcRenderer.invoke(HtmlShareIpc.CreateFromHtmlFile, options),
    updateFromHtmlFile: (options: {
      shareId: string;
      sessionId: string;
      artifactId: string;
      filePath: string;
      title: string;
      currentStatus?: HtmlShareStatus;
      accessMode?: HtmlShareAccessMode;
    }) => ipcRenderer.invoke(HtmlShareIpc.UpdateFromHtmlFile, options),
    getByHtmlFile: (options: { filePath: string }) =>
      ipcRenderer.invoke(HtmlShareIpc.GetByHtmlFile, options),
    createFromArtifactFile: (options: {
      sourceType: HtmlShareSourceType;
      sessionId: string;
      artifactId: string;
      title: string;
      accessMode?: HtmlShareAccessMode;
      fileName?: string;
      filePath?: string;
      content?: string;
      remoteUrl?: string;
    }) => ipcRenderer.invoke(HtmlShareIpc.CreateFromArtifactFile, options),
    updateFromArtifactFile: (options: {
      sourceType: HtmlShareSourceType;
      shareId: string;
      sessionId: string;
      artifactId: string;
      title: string;
      accessMode?: HtmlShareAccessMode;
      fileName?: string;
      filePath?: string;
      content?: string;
      remoteUrl?: string;
      currentStatus?: HtmlShareStatus;
    }) => ipcRenderer.invoke(HtmlShareIpc.UpdateFromArtifactFile, options),
    getByArtifactFile: (options: {
      sourceType: HtmlShareSourceType;
      sessionId?: string;
      artifactId?: string;
      filePath?: string;
    }) => ipcRenderer.invoke(HtmlShareIpc.GetByArtifactFile, options),
    createFromGeneratedVideo: (options: {
      taskId: string;
      outputIndex: number;
      sessionId: string;
      artifactId: string;
      title: string;
      accessMode?: HtmlShareAccessMode;
    }) => ipcRenderer.invoke(HtmlShareIpc.CreateFromGeneratedVideo, options),
    getGeneratedVideoSource: (options: { taskId: string; outputIndex: number }) =>
      ipcRenderer.invoke(HtmlShareIpc.GetGeneratedVideoSource, options),
    resolveLegacyGeneratedVideoSource: (options: { resultUrl: string }) =>
      ipcRenderer.invoke(HtmlShareIpc.ResolveLegacyGeneratedVideoSource, options),
    getBySource: (options: {
      sourceType: HtmlShareSourceType;
      clientSourceKey: string;
    }) => ipcRenderer.invoke(HtmlShareIpc.GetBySource, options),
    updateStatus: (options: { shareId: string; status: HtmlShareConfigurableStatus }) =>
      ipcRenderer.invoke(HtmlShareIpc.UpdateStatus, options),
    updateAccessMode: (options: { shareId: string; accessMode: HtmlShareAccessMode }) =>
      ipcRenderer.invoke(HtmlShareIpc.UpdateAccessMode, options),
    disable: (shareId: string) => ipcRenderer.invoke(HtmlShareIpc.Disable, shareId),
    deletePermanently: (shareId: string) =>
      ipcRenderer.invoke(HtmlShareIpc.DeletePermanently, shareId),
    get: (shareId: string) => ipcRenderer.invoke(HtmlShareIpc.Get, shareId),
    getQuota: () => ipcRenderer.invoke(HtmlShareIpc.GetQuota),
    getTrialPolicy: () => ipcRenderer.invoke(HtmlShareIpc.GetTrialPolicy),
    getAnalytics: (options: HtmlShareAnalyticsInput) =>
      ipcRenderer.invoke(HtmlShareIpc.GetAnalytics, options),
  },
  shareDeployment: {
    detectProjectCandidates: (options: ShareDeploymentDetectCandidatesInput) =>
      ipcRenderer.invoke(ShareDeploymentIpc.DetectProjectCandidates, options),
    analyzeProjectDirectory: (options: ShareDeploymentAnalyzeProjectInput) =>
      ipcRenderer.invoke(ShareDeploymentIpc.AnalyzeProjectDirectory, options),
    selectPersistencePath: (options: ShareDeploymentSelectPersistencePathInput) =>
      ipcRenderer.invoke(ShareDeploymentIpc.SelectPersistencePath, options),
    createNodeDeployment: (options: ShareDeploymentCreateNodeInput) =>
      ipcRenderer.invoke(ShareDeploymentIpc.CreateNodeDeployment, options),
    get: (deploymentId: string) => ipcRenderer.invoke(ShareDeploymentIpc.Get, deploymentId),
    getByLocalService: (options: ShareDeploymentGetByLocalServiceInput) =>
      ipcRenderer.invoke(ShareDeploymentIpc.GetByLocalService, options),
    getPersistence: (deploymentId: string) =>
      ipcRenderer.invoke(ShareDeploymentIpc.GetPersistence, deploymentId),
    downloadPersistenceArchive: (options: ShareDeploymentDownloadPersistenceInput) =>
      ipcRenderer.invoke(ShareDeploymentIpc.DownloadPersistenceArchive, options),
  },
  sites: {
    list: (options: SiteListOptions = {}) => ipcRenderer.invoke(SiteIpc.List, options),
    get: (shareId: string) => ipcRenderer.invoke(SiteIpc.Get, shareId),
    updateTitle: (input: SiteUpdateTitleInput) => ipcRenderer.invoke(SiteIpc.UpdateTitle, input),
    updateAccessMode: (input: SiteUpdateAccessModeInput) =>
      ipcRenderer.invoke(SiteIpc.UpdateAccessMode, input),
    updateAccessStatus: (input: SiteUpdateAccessStatusInput) =>
      ipcRenderer.invoke(SiteIpc.UpdateAccessStatus, input),
    delete: (shareId: string) => ipcRenderer.invoke(SiteIpc.Delete, shareId),
    getAnalytics: (shareId: string, options: SiteAnalyticsOptions = {}) =>
      ipcRenderer.invoke(SiteIpc.GetAnalytics, shareId, options),
    getDeploymentQuota: (options: SiteDeploymentQuotaOptions = {}) =>
      ipcRenderer.invoke(SiteIpc.GetDeploymentQuota, options),
    createQuotaReservation: (input: SiteQuotaReservationInput) =>
      ipcRenderer.invoke(SiteIpc.CreateQuotaReservation, input),
    releaseQuotaReservation: (reservationId: string) =>
      ipcRenderer.invoke(SiteIpc.ReleaseQuotaReservation, reservationId),
  },
  library: {
    listLocal: (options: LibraryLocalListOptions = {}) =>
      ipcRenderer.invoke(LibraryIpc.ListLocal, options),
    listLocalTaskGroups: (options: LibraryLocalTaskGroupsOptions = {}) =>
      ipcRenderer.invoke(LibraryIpc.ListLocalTaskGroups, options),
    listLocalTaskItems: (options: LibraryLocalTaskItemsOptions) =>
      ipcRenderer.invoke(LibraryIpc.ListLocalTaskItems, options),
    listCloud: (options: LibraryCloudListOptions = {}) =>
      ipcRenderer.invoke(LibraryIpc.ListCloud, options),
    getLocalItems: (input: LibraryGetLocalItemsInput) =>
      ipcRenderer.invoke(LibraryIpc.GetLocalItems, input),
    getLocalDetail: (itemId: string) =>
      ipcRenderer.invoke(LibraryIpc.GetLocalDetail, itemId),
    recordCandidates: (candidates: LibraryArtifactCandidate[]) =>
      ipcRenderer.invoke(LibraryIpc.RecordCandidates, candidates),
    addLocalFiles: (filePaths: string[]) =>
      ipcRenderer.invoke(LibraryIpc.AddLocalFiles, filePaths),
    setFavorite: (input: LibraryFavoriteInput) =>
      ipcRenderer.invoke(LibraryIpc.SetFavorite, input),
    openLocal: (itemId: string) => ipcRenderer.invoke(LibraryIpc.OpenLocal, itemId),
    revealLocal: (itemId: string) => ipcRenderer.invoke(LibraryIpc.RevealLocal, itemId),
    repairIndex: () => ipcRenderer.invoke(LibraryIpc.RepairIndex),
    getIndexStatus: () => ipcRenderer.invoke(LibraryIpc.GetIndexStatus),
    getBackfillState: () => ipcRenderer.invoke(LibraryIpc.GetBackfillState),
    setBackfillState: (state: LibraryBackfillState) =>
      ipcRenderer.invoke(LibraryIpc.SetBackfillState, state),
    onChanged: (callback: (payload: LibraryChangedPayload) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: LibraryChangedPayload) => {
        callback(payload);
      };
      ipcRenderer.on(LibraryIpc.Changed, handler);
      return () => ipcRenderer.removeListener(LibraryIpc.Changed, handler);
    },
  },
  asr: {
    createRealtimeSession: (options: AsrRealtimeSessionRequest) =>
      ipcRenderer.invoke(AsrIpcChannel.CreateRealtimeSession, options),
  },
  artifact: {
    imageEditing: createImageEditingBridge(ipcRenderer),
    office: createOfficeBridges(ipcRenderer),
    wordPanel: createWordPanelBridge(ipcRenderer),
    markdown: {
      read: (filePath: string) => ipcRenderer.invoke(MarkdownFileIpc.Read, filePath),
      save: (request: SaveMarkdownFileRequest) => ipcRenderer.invoke(MarkdownFileIpc.Save, request),
      setHasUnsafeEdits: (hasUnsafeEdits: boolean) => ipcRenderer.send(MarkdownFileIpc.SetUnsafeEdits, hasUnsafeEdits),
    },
    watchFile: (filePath: string) => ipcRenderer.invoke(ArtifactPreviewIpc.WatchFile, filePath),
    unwatchFile: (filePath: string) => ipcRenderer.invoke(ArtifactPreviewIpc.UnwatchFile, filePath),
    onFileChanged: (callback: (data: { filePath: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: { filePath: string }) =>
        callback(data);
      ipcRenderer.on(ArtifactPreviewIpc.FileChanged, handler);
      return () => {
        ipcRenderer.removeListener(ArtifactPreviewIpc.FileChanged, handler);
      };
    },
    onBrowserWindowOpen: (callback: (data: ArtifactBrowserWindowOpenEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: ArtifactBrowserWindowOpenEvent) =>
        callback(data);
      ipcRenderer.on(ArtifactPreviewIpc.BrowserWindowOpen, handler);
      return () => {
        ipcRenderer.removeListener(ArtifactPreviewIpc.BrowserWindowOpen, handler);
      };
    },
    createPreviewSession: (filePath: string) =>
      ipcRenderer.invoke(ArtifactPreviewIpc.CreateSession, filePath),
    createOfficePreviewSession: (filePath: string) =>
      ipcRenderer.invoke(ArtifactPreviewIpc.CreateOfficeSession, filePath),
    destroyPreviewSession: (sessionId: string) =>
      ipcRenderer.invoke(ArtifactPreviewIpc.DestroySession, sessionId),
    clearBrowserCookies: async () => {
      try {
        return await ipcRenderer.invoke(ArtifactPreviewIpc.ClearBrowserCookies);
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    clearBrowserCache: async () => {
      try {
        return await ipcRenderer.invoke(ArtifactPreviewIpc.ClearBrowserCache);
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    saveBrowserAnnotationAsset: (input: unknown) =>
      ipcRenderer.invoke(ArtifactPreviewIpc.SaveBrowserAnnotationAsset, input),
    readBrowserAnnotationAsset: (input: unknown) =>
      ipcRenderer.invoke(ArtifactPreviewIpc.ReadBrowserAnnotationAsset, input),
    deleteBrowserAnnotationAsset: (input: unknown) =>
      ipcRenderer.invoke(ArtifactPreviewIpc.DeleteBrowserAnnotationAsset, input),
    deleteBrowserAnnotationBatchAssets: (input: unknown) =>
      ipcRenderer.invoke(ArtifactPreviewIpc.DeleteBrowserAnnotationBatchAssets, input),
    listLocalWebServices: (options?: ListLocalWebServicesOptions) =>
      ipcRenderer.invoke(LocalWebServicesIpc.List, options) as Promise<LocalWebService[]>,
    createBlankDocument: (request: CreateBlankDocumentRequest) =>
      ipcRenderer.invoke(ArtifactWorkspaceIpc.CreateBlankDocument, request) as Promise<CreateBlankDocumentResponse>,
    probeGitWorkspace: (request?: ProbeGitWorkspaceRequest) =>
      ipcRenderer.invoke(ArtifactWorkspaceIpc.ProbeGitWorkspace, request ?? {}) as Promise<ProbeGitWorkspaceResponse>,
    renameFile: (request: RenameArtifactFileRequest) =>
      ipcRenderer.invoke(ArtifactWorkspaceIpc.RenameFile, request) as Promise<RenameArtifactFileResponse>,
    listWorkspaceDirectory: (request?: ListWorkspaceDirectoryRequest) =>
      ipcRenderer.invoke(ArtifactWorkspaceIpc.ListDirectory, request ?? {}) as Promise<ListWorkspaceDirectoryResponse>,
  },
  autoLaunch: {
    get: () => ipcRenderer.invoke(AppSettingsIpc.GetAutoLaunch),
    set: (enabled: boolean) => ipcRenderer.invoke(AppSettingsIpc.SetAutoLaunch, enabled),
  },
  preventSleep: {
    get: () => ipcRenderer.invoke(AppSettingsIpc.GetPreventSleep),
    set: (enabled: boolean) => ipcRenderer.invoke(AppSettingsIpc.SetPreventSleep, enabled),
  },
  quitConfirmation: {
    get: () => ipcRenderer.invoke(AppSettingsIpc.GetQuitConfirmation),
    set: (enabled: boolean) => ipcRenderer.invoke(AppSettingsIpc.SetQuitConfirmation, enabled),
  },
  appInfo: {
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    getSystemLocale: () => ipcRenderer.invoke('app:getSystemLocale'),
    getKeyfromAttribution: () => ipcRenderer.invoke(AppIpcChannel.GetKeyfromAttribution),
    relaunch: () => ipcRenderer.invoke('app:relaunch'),
    openSystemNotificationSettings: () =>
      ipcRenderer.invoke(AppIpcChannel.OpenSystemNotificationSettings),
  },
  openWith: {
    consumePaths: () => ipcRenderer.invoke(AppIpcChannel.ConsumeOpenWithPaths),
    onPathsAvailable: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(AppIpcChannel.OpenWithPathsAvailable, handler);
      return () => ipcRenderer.removeListener(AppIpcChannel.OpenWithPathsAvailable, handler);
    },
  },
  feedback: {
    submit: (input: FeedbackInput) => ipcRenderer.invoke(FeedbackIpc.Submit, input),
  },
  subscriptionTrial: {
    status: () => ipcRenderer.invoke(SubscriptionTrialIpc.Status),
  },
  accountMenuMore: {
    get: () => ipcRenderer.invoke(AccountMenuMoreIpc.Get),
  },
  activity: {
    getSlot: (input: ActivityHostGetSlotInput) =>
      ipcRenderer.invoke(ActivityIpc.HostGetSlot, input),
    getContext: (input: ActivityHostGetContextInput) =>
      ipcRenderer.invoke(ActivityIpc.HostGetContext, input),
    executeAction: (input: ActivityHostExecuteActionInput) =>
      ipcRenderer.invoke(ActivityIpc.HostExecuteAction, input),
  },
  appUpdate: {
    getState: () => ipcRenderer.invoke(AppUpdateIpc.GetState),
    checkNow: (options?: { manual?: boolean; userId?: string | null }) =>
      ipcRenderer.invoke(AppUpdateIpc.CheckNow, options),
    retryDownload: () => ipcRenderer.invoke(AppUpdateIpc.RetryDownload),
    installReady: () => ipcRenderer.invoke(AppUpdateIpc.InstallReady),
    getCompletedUpdate: () => ipcRenderer.invoke(AppUpdateIpc.GetCompletedUpdate),
    getActiveWorkloads: () => ipcRenderer.invoke(AppUpdateIpc.GetActiveWorkloads),
    onStateChanged: (callback: (data: any) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on(AppUpdateIpc.StateChanged, handler);
      return () => ipcRenderer.removeListener(AppUpdateIpc.StateChanged, handler);
    },
  },
  log: {
    getPath: () => ipcRenderer.invoke('log:getPath'),
    openFolder: () => ipcRenderer.invoke('log:openFolder'),
    exportZip: () => ipcRenderer.invoke(LogIpc.ExportZip),
    fromRenderer: (level: string, tag: string, message: string) =>
      ipcRenderer.send('log:fromRenderer', level, tag, message),
  },
  im: {
    // Configuration
    getConfig: () => ipcRenderer.invoke('im:config:get'),
    setConfig: (
      config: any,
      options?: { syncGateway?: boolean; restartGatewayIfRunning?: boolean; markRestartOnSave?: boolean },
    ) => ipcRenderer.invoke('im:config:set', config, options),
    syncConfig: () => ipcRenderer.invoke('im:config:sync'),

    // Gateway control
    startGateway: (platform: Platform) => ipcRenderer.invoke('im:gateway:start', platform),
    stopGateway: (platform: Platform) => ipcRenderer.invoke('im:gateway:stop', platform),
    testGateway: (platform: Platform, configOverride?: any) =>
      ipcRenderer.invoke('im:gateway:test', platform, configOverride),

    // Status
    getStatus: () => ipcRenderer.invoke('im:status:get'),
    getLocalIp: () => ipcRenderer.invoke('im:getLocalIp') as Promise<string>,
    // OpenClaw config schema
    getOpenClawConfigSchema: () => ipcRenderer.invoke('im:openclaw:config-schema'),

    // Weixin QR login
    weixinQrLoginStart: () => ipcRenderer.invoke('im:weixin:qr-login-start'),
    weixinQrLoginWait: (sessionKey?: string) =>
      ipcRenderer.invoke('im:weixin:qr-login-wait', sessionKey),

    // POPO QR login
    popoQrLoginStart: () => ipcRenderer.invoke('im:popo:qr-login-start'),
    popoQrLoginPoll: (taskToken: string) => ipcRenderer.invoke('im:popo:qr-login-poll', taskToken),

    // POPO Multi-Instance
    addPopoInstance: (name: string) => ipcRenderer.invoke('im:popo:instance:add', name),
    deletePopoInstance: (instanceId: string) =>
      ipcRenderer.invoke('im:popo:instance:delete', instanceId),
    setPopoInstanceConfig: (
      instanceId: string,
      config: Record<string, unknown>,
      options?: { syncGateway?: boolean; restartGatewayIfRunning?: boolean; markRestartOnSave?: boolean },
    ) => ipcRenderer.invoke('im:popo:instance:config:set', instanceId, config, options),

    // Pairing
    listPairingRequests: (platform: string) => ipcRenderer.invoke('im:pairing:list', platform),
    approvePairingCode: (platform: string, code: string) =>
      ipcRenderer.invoke('im:pairing:approve', platform, code),
    rejectPairingRequest: (platform: string, code: string) =>
      ipcRenderer.invoke('im:pairing:reject', platform, code),

    // DingTalk Multi-Instance
    addDingTalkInstance: (name: string) => ipcRenderer.invoke('im:dingtalk:instance:add', name),
    deleteDingTalkInstance: (instanceId: string) =>
      ipcRenderer.invoke('im:dingtalk:instance:delete', instanceId),
    setDingTalkInstanceConfig: (
      instanceId: string,
      config: any,
      options?: { syncGateway?: boolean; restartGatewayIfRunning?: boolean; markRestartOnSave?: boolean },
    ) => ipcRenderer.invoke('im:dingtalk:instance:config:set', instanceId, config, options),

    // NIM Multi-Instance
    addNimInstance: (name: string) => ipcRenderer.invoke('im:nim:instance:add', name),
    deleteNimInstance: (instanceId: string) =>
      ipcRenderer.invoke('im:nim:instance:delete', instanceId),
    setNimInstanceConfig: (
      instanceId: string,
      config: any,
      options?: { syncGateway?: boolean; restartGatewayIfRunning?: boolean; markRestartOnSave?: boolean },
    ) =>
      ipcRenderer.invoke('im:nim:instance:config:set', instanceId, config, options),
    nimQrLoginStart: () => ipcRenderer.invoke(NimQrLoginIpc.Start),
    nimQrLoginPoll: (uuid: string) => ipcRenderer.invoke(NimQrLoginIpc.Poll, uuid),

    // QQ Multi-Instance
    addQQInstance: (name: string) => ipcRenderer.invoke('im:qq:instance:add', name),
    deleteQQInstance: (instanceId: string) =>
      ipcRenderer.invoke('im:qq:instance:delete', instanceId),
    setQQInstanceConfig: (instanceId: string, config: any, options?: { syncGateway?: boolean; restartGatewayIfRunning?: boolean; markRestartOnSave?: boolean }) =>
      ipcRenderer.invoke('im:qq:instance:config:set', instanceId, config, options),

    // Feishu Multi-Instance
    addFeishuInstance: (name: string) => ipcRenderer.invoke('im:feishu:instance:add', name),
    deleteFeishuInstance: (instanceId: string) =>
      ipcRenderer.invoke('im:feishu:instance:delete', instanceId),
    setFeishuInstanceConfig: (
      instanceId: string,
      config: any,
      options?: { syncGateway?: boolean; restartGatewayIfRunning?: boolean; markRestartOnSave?: boolean },
    ) => ipcRenderer.invoke('im:feishu:instance:config:set', instanceId, config, options),

    // Email Multi-Instance
    addEmailInstance: (name: string) => ipcRenderer.invoke('im:email:instance:add', name),
    deleteEmailInstance: (instanceId: string) =>
      ipcRenderer.invoke('im:email:instance:delete', instanceId),
    setEmailInstanceConfig: (
      instanceId: string,
      config: any,
      options?: { syncGateway?: boolean; restartGatewayIfRunning?: boolean; markRestartOnSave?: boolean },
    ) => ipcRenderer.invoke('im:email:instance:config:set', instanceId, config, options),

    // WeCom Multi-Instance
    addWecomInstance: (name: string) => ipcRenderer.invoke('im:wecom:instance:add', name),
    deleteWecomInstance: (instanceId: string) =>
      ipcRenderer.invoke('im:wecom:instance:delete', instanceId),
    setWecomInstanceConfig: (
      instanceId: string,
      config: any,
      options?: { syncGateway?: boolean; restartGatewayIfRunning?: boolean; markRestartOnSave?: boolean },
    ) => ipcRenderer.invoke('im:wecom:instance:config:set', instanceId, config, options),

    // Telegram Multi-Instance
    addTelegramInstance: (name: string) => ipcRenderer.invoke('im:telegram:instance:add', name),
    deleteTelegramInstance: (instanceId: string) =>
      ipcRenderer.invoke('im:telegram:instance:delete', instanceId),
    setTelegramInstanceConfig: (
      instanceId: string,
      config: any,
      options?: { syncGateway?: boolean; restartGatewayIfRunning?: boolean; markRestartOnSave?: boolean },
    ) => ipcRenderer.invoke('im:telegram:instance:config:set', instanceId, config, options),

    // Discord Multi-Instance
    addDiscordInstance: (name: string) => ipcRenderer.invoke('im:discord:instance:add', name),
    deleteDiscordInstance: (instanceId: string) =>
      ipcRenderer.invoke('im:discord:instance:delete', instanceId),
    setDiscordInstanceConfig: (
      instanceId: string,
      config: any,
      options?: { syncGateway?: boolean; restartGatewayIfRunning?: boolean; markRestartOnSave?: boolean },
    ) => ipcRenderer.invoke('im:discord:instance:config:set', instanceId, config, options),

    // Event listeners
    onStatusChange: (callback: (status: any) => void) => {
      const handler = (_event: any, status: any) => callback(status);
      ipcRenderer.on('im:status:change', handler);
      return () => ipcRenderer.removeListener('im:status:change', handler);
    },
    onMessageReceived: (callback: (message: any) => void) => {
      const handler = (_event: any, message: any) => callback(message);
      ipcRenderer.on('im:message:received', handler);
      return () => ipcRenderer.removeListener('im:message:received', handler);
    },
  },
  scheduledTasks: {
    // Task CRUD
    list: () => ipcRenderer.invoke(ScheduledTaskIpc.List),
    get: (id: string) => ipcRenderer.invoke(ScheduledTaskIpc.Get, id),
    create: (input: any) => ipcRenderer.invoke(ScheduledTaskIpc.Create, input),
    update: (id: string, input: any) => ipcRenderer.invoke(ScheduledTaskIpc.Update, id, input),
    delete: (id: string) => ipcRenderer.invoke(ScheduledTaskIpc.Delete, id),
    toggle: (id: string, enabled: boolean) =>
      ipcRenderer.invoke(ScheduledTaskIpc.Toggle, id, enabled),

    // Execution
    runManually: (id: string) => ipcRenderer.invoke(ScheduledTaskIpc.RunManually, id),
    resendWeixinReport: (taskId: string, runId: string) =>
      ipcRenderer.invoke(ScheduledTaskIpc.ResendWeixinReport, taskId, runId),
    stop: (id: string) => ipcRenderer.invoke(ScheduledTaskIpc.Stop, id),

    // Run history
    listRuns: (taskId: string, limit?: number, offset?: number, filter?: any) =>
      ipcRenderer.invoke(ScheduledTaskIpc.ListRuns, taskId, limit, offset, filter),
    countRuns: (taskId: string) => ipcRenderer.invoke(ScheduledTaskIpc.CountRuns, taskId),
    listAllRuns: (limit?: number, offset?: number, filter?: any) =>
      ipcRenderer.invoke(ScheduledTaskIpc.ListAllRuns, limit, offset, filter),
    resolveSession: (input: string | ScheduledRunSessionRequest) =>
      ipcRenderer.invoke(ScheduledTaskIpc.ResolveSession, input),

    // Delivery channels
    listChannels: () => ipcRenderer.invoke(ScheduledTaskIpc.ListChannels),
    listChannelConversations: (channel: string, accountId?: string, filterAccountId?: string) =>
      ipcRenderer.invoke(
        ScheduledTaskIpc.ListChannelConversations,
        channel,
        accountId,
        filterAccountId,
      ),

    // Stream event listeners
    onStatusUpdate: (callback: (data: any) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on(ScheduledTaskIpc.StatusUpdate, handler);
      return () => ipcRenderer.removeListener(ScheduledTaskIpc.StatusUpdate, handler);
    },
    onRunUpdate: (callback: (data: any) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on(ScheduledTaskIpc.RunUpdate, handler);
      return () => ipcRenderer.removeListener(ScheduledTaskIpc.RunUpdate, handler);
    },
    onRefresh: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(ScheduledTaskIpc.Refresh, handler);
      return () => ipcRenderer.removeListener(ScheduledTaskIpc.Refresh, handler);
    },
  },
  networkStatus: {
    send: (status: 'online' | 'offline') => ipcRenderer.send('network:status-change', status),
  },
  modelContextWindows: {
    get: (request: ModelContextWindowRequest) => ipcRenderer.invoke(ModelContextWindowIpc.Get, request),
    set: (request: ModelContextWindowRequest, tokens: number | null) => ipcRenderer.invoke(ModelContextWindowIpc.Set, request, tokens),
  },
  modelPresets: {
    available: () => ipcRenderer.invoke(ModelPresetIpc.Available),
    getPreferences: () => ipcRenderer.invoke(ModelPresetIpc.GetPreferences),
    setPreference: (agentId: string, presetId: ModelPresetId | null, thinkingLevel?: ModelThinkingLevel) => ipcRenderer.invoke(ModelPresetIpc.SetPreference, agentId, presetId, thinkingLevel),
    selectSession: (sessionId: string, presetId: ModelPresetId, thinkingLevel?: ModelThinkingLevel) => ipcRenderer.invoke(ModelPresetIpc.SelectSession, sessionId, presetId, thinkingLevel),
  },
  auth: {
    getAccessState: (): Promise<AuthAccessState> => ipcRenderer.invoke(AuthIpcChannel.GetAccessState),
    login: (loginUrl?: string) => ipcRenderer.invoke(AuthIpcChannel.Login, { loginUrl }),
    cancelLogin: () => ipcRenderer.invoke(AuthIpcChannel.CancelLogin),
    exchange: (code: string) => ipcRenderer.invoke(AuthIpcChannel.Exchange, { code }),
    getUser: () => ipcRenderer.invoke(AuthIpcChannel.GetUser),
    getCachedSnapshot: () => ipcRenderer.invoke(AuthIpcChannel.GetCachedSnapshot),
    getQuota: () => ipcRenderer.invoke(AuthIpcChannel.GetQuota),
    logout: () => ipcRenderer.invoke(AuthIpcChannel.Logout),
    refreshToken: () => ipcRenderer.invoke(AuthIpcChannel.RefreshToken),
    getAccessToken: () => ipcRenderer.invoke(AuthIpcChannel.GetAccessToken),
    getModels: () => ipcRenderer.invoke(AuthIpcChannel.GetModels),
    getPricingCatalog: () => ipcRenderer.invoke(AuthIpcChannel.GetPricingCatalog),
    getProfileSummary: () => ipcRenderer.invoke(AuthIpcChannel.GetProfileSummary),
    claimCreditsFinalReward: (campaignCode: string) =>
      ipcRenderer.invoke(AuthIpcChannel.ClaimCreditsFinalReward, { campaignCode }),
    getActiveClientBanner: () => ipcRenderer.invoke(AuthIpcChannel.GetActiveClientBanner),
    getActiveClientBanners: () => ipcRenderer.invoke(AuthIpcChannel.GetActiveClientBanners),
    getClientBannerSnapshot: (placement?: string) => ipcRenderer.invoke(AuthIpcChannel.GetClientBannerSnapshot, placement),
    getPendingCallback: () => ipcRenderer.invoke(AuthIpcChannel.GetPendingCallback),
    onCallback: (callback: (data: { code: string }) => void) => {
      const handler = (_event: any, data: { code: string }) => callback(data);
      ipcRenderer.on(AuthIpcChannel.Callback, handler);
      return () => ipcRenderer.removeListener(AuthIpcChannel.Callback, handler);
    },
    onQuotaChanged: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(AuthIpcChannel.QuotaChanged, handler);
      return () => ipcRenderer.removeListener(AuthIpcChannel.QuotaChanged, handler);
    },
    onCreditsActivity: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(AuthIpcChannel.CreditsActivity, handler);
      return () => ipcRenderer.removeListener(AuthIpcChannel.CreditsActivity, handler);
    },
    onSessionChanged: (callback: (event: AuthSessionChangedEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: AuthSessionChangedEvent) => callback(data);
      ipcRenderer.on(AuthIpcChannel.SessionChanged, handler);
      return () => ipcRenderer.removeListener(AuthIpcChannel.SessionChanged, handler);
    },
    onLifecycleEvent: (callback: (event: AuthLifecycleEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: AuthLifecycleEvent) => callback(data);
      ipcRenderer.on(AuthIpcChannel.LifecycleEvent, handler);
      return () => ipcRenderer.removeListener(AuthIpcChannel.LifecycleEvent, handler);
    },
    onAccessStateChanged: (callback: (state: AuthAccessState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: AuthAccessState) => callback(data);
      ipcRenderer.on(AuthIpcChannel.AccessStateChanged, handler);
      return () => ipcRenderer.removeListener(AuthIpcChannel.AccessStateChanged, handler);
    },
  },
  imageCreation: {
    getCatalog: () => ipcRenderer.invoke(ImageCreationIpc.GetCatalog) as Promise<ImageCreationCatalog>,
    getReference: (exampleId: string) => ipcRenderer.invoke(ImageCreationIpc.GetReference, exampleId) as Promise<ImageExampleReference>,
  },
  pptCreation: {
    getCatalog: () => ipcRenderer.invoke(PptCreationIpc.GetCatalog) as Promise<PptCatalog>,
    getAsset: (request: PptAssetRequest) => ipcRenderer.invoke(PptCreationIpc.GetAsset, request) as Promise<PptPreparedFile>,
    getCoverTemplate: (request: PptCoverRequest) => ipcRenderer.invoke(PptCoverIpc.Template, request) as Promise<{ imageBase64: string }>,
    exportCover: (request: PptCoverExportRequest) => ipcRenderer.invoke(PptCoverIpc.Export, request) as Promise<PptPreparedFile>,
  },
  media: {
    getPreferences: (owner: string) =>
      ipcRenderer.invoke(CoworkIpcChannel.GetMediaPreferences, owner) as Promise<MediaPreferenceResult>,
    setPreference: (owner: string, type: MediaType, preference: MediaPreference) =>
      ipcRenderer.invoke(CoworkIpcChannel.SetMediaPreference, owner, type, preference) as Promise<MediaPreferenceResult>,
    getModels: (type: 'image' | 'video') =>
      ipcRenderer.invoke(CoworkIpcChannel.GetMediaModels, type) as Promise<{ success: boolean; models?: unknown[]; error?: string }>,
    getTaskStatus: (taskId: number, type: 'image' | 'video') =>
      ipcRenderer.invoke('media:getTaskStatus', taskId, type) as Promise<{ success: boolean; task?: unknown; error?: string }>,
  },
  feishu: {
    install: {
      qrcode: (isLark: boolean) =>
        ipcRenderer.invoke('feishu:install:qrcode', { isLark }) as Promise<{
          url: string;
          deviceCode: string;
          interval: number;
          expireIn: number;
        }>,
      poll: (deviceCode: string) =>
        ipcRenderer.invoke('feishu:install:poll', { deviceCode }) as Promise<{
          done: boolean;
          appId?: string;
          appSecret?: string;
          domain?: string;
          error?: string;
        }>,
      verify: (appId: string, appSecret: string) =>
        ipcRenderer.invoke('feishu:install:verify', { appId, appSecret }) as Promise<{
          success: boolean;
          error?: string;
        }>,
    },
  },
  dingtalk: {
    install: {
      qrcode: () =>
        ipcRenderer.invoke('dingtalk:install:qrcode') as Promise<{
          url: string;
          deviceCode: string;
          interval: number;
          expireIn: number;
        }>,
      poll: (deviceCode: string) =>
        ipcRenderer.invoke('dingtalk:install:poll', { deviceCode }) as Promise<{
          done: boolean;
          clientId?: string;
          clientSecret?: string;
          error?: string;
        }>,
      verify: (clientId: string, clientSecret: string) =>
        ipcRenderer.invoke('dingtalk:install:verify', { clientId, clientSecret }) as Promise<{
          success: boolean;
          error?: string;
        }>,
    },
  },
  githubCopilot: {
    requestDeviceCode: () =>
      ipcRenderer.invoke('github-copilot:request-device-code') as Promise<{
        userCode: string;
        verificationUri: string;
        deviceCode: string;
        interval: number;
        expiresIn: number;
      }>,
    pollForToken: (deviceCode: string, interval: number, expiresIn: number) =>
      ipcRenderer.invoke('github-copilot:poll-for-token', {
        deviceCode,
        interval,
        expiresIn,
      }) as Promise<{
        success: boolean;
        token?: string;
        githubUser?: string;
        baseUrl?: string;
        error?: string;
      }>,
    cancelPolling: () => ipcRenderer.invoke('github-copilot:cancel-polling') as Promise<void>,
    signOut: () => ipcRenderer.invoke('github-copilot:sign-out') as Promise<void>,
    refreshToken: () =>
      ipcRenderer.invoke('github-copilot:refresh-token') as Promise<{
        success: boolean;
        token?: string;
        baseUrl?: string;
        error?: string;
      }>,
    onTokenUpdated: (callback: (data: { token: string; baseUrl: string }) => void) => {
      const handler = (_event: unknown, data: { token: string; baseUrl: string }) => callback(data);
      ipcRenderer.on('github-copilot:token-updated', handler);
      return () => ipcRenderer.removeListener('github-copilot:token-updated', handler);
    },
  },
  openaiCodexOAuth: {
    start: () =>
      ipcRenderer.invoke('openai-codex-oauth:start') as Promise<
        | { success: true; email: string | null; accountId: string | null; expiresAt: number }
        | { success: false; error: string }
      >,
    cancel: () => ipcRenderer.invoke('openai-codex-oauth:cancel') as Promise<void>,
    logout: () => ipcRenderer.invoke('openai-codex-oauth:logout') as Promise<void>,
    status: () =>
      ipcRenderer.invoke('openai-codex-oauth:status') as Promise<
        | { loggedIn: true; email: string | null; accountId: string | null; expiresAt: number }
        | { loggedIn: false }
      >,
  },
  xaiOAuth: {
    start: () =>
      ipcRenderer.invoke('xai-oauth:start') as Promise<
        | { success: true; email: string | null; flow: 'browser' | 'device-code' }
        | { success: false; error: string }
      >,
    cancel: () => ipcRenderer.invoke('xai-oauth:cancel') as Promise<void>,
    logout: () => ipcRenderer.invoke('xai-oauth:logout') as Promise<void>,
    status: () =>
      ipcRenderer.invoke('xai-oauth:status') as Promise<{
        loggedIn: boolean;
        email?: string;
        displayName?: string;
        expiresAt?: number;
      }>,
    onDeviceCode: (
      callback: (info: {
        userCode: string;
        verificationUri: string;
        verificationUriComplete?: string;
        expiresInMs: number;
      }) => void,
    ) => {
      const handler = (
        _event: unknown,
        info: {
          userCode: string;
          verificationUri: string;
          verificationUriComplete?: string;
          expiresInMs: number;
        },
      ) => callback(info);
      ipcRenderer.on('xai-oauth:device-code', handler);
      return () => ipcRenderer.removeListener('xai-oauth:device-code', handler);
    },
  },
  dshHost: {
    getStatus: () => ipcRenderer.invoke(DshHostIpc.GetStatus),
    getSessionRecovery: (sessionId: string) => ipcRenderer.invoke(DshHostIpc.GetSessionRecovery, sessionId),
    onConnectionChanged: (listener: () => void) => {
      const notify = () => listener();
      ipcRenderer.on(DshHostIpc.ConnectionChanged, notify);
      return () => { ipcRenderer.removeListener(DshHostIpc.ConnectionChanged, notify); };
    },
    restart: () => ipcRenderer.invoke(DshHostIpc.Restart),
    getWebUrl: () => ipcRenderer.invoke(DshHostIpc.GetWebUrl),
    openEcosystemView: (routeHash?: string) => ipcRenderer.invoke(DshHostIpc.OpenEcosystemView, routeHash),
    closeEcosystemView: () => ipcRenderer.invoke(DshHostIpc.CloseEcosystemView),
    listPlugins: () => ipcRenderer.invoke(DshHostIpc.ListPlugins),
    inspectPlugin: (request: string | { spec: string; registry?: string | null }) =>
      ipcRenderer.invoke(DshHostIpc.InspectPlugin, request),
    installPlugin: (
      request: string | {
        spec: string;
        registry?: string | null;
        approvedBuilds?: string[];
        enabled?: boolean;
        requestId?: string;
      },
    ) => ipcRenderer.invoke(DshHostIpc.InstallPlugin, request),
    cancelPluginInstall: (requestId: string) =>
      ipcRenderer.invoke(DshHostIpc.CancelPluginInstall, requestId),
    removePlugin: (packageName: string) => ipcRenderer.invoke(DshHostIpc.RemovePlugin, packageName),
    setPluginEnabled: (packageName: string, enabled: boolean) =>
      ipcRenderer.invoke(DshHostIpc.SetPluginEnabled, packageName, enabled),
    checkPluginVersions: (request: string | { name: string; registry?: string | null }) =>
      ipcRenderer.invoke(DshHostIpc.CheckPluginVersions, request),
    updatePlugin: (request: {
      name: string;
      version: string;
      registry?: string | null;
      spec?: string;
      requestId?: string;
    }) => ipcRenderer.invoke(DshHostIpc.UpdatePlugin, request),
    onPluginUpdateState: (listener: (progress: { requestId: string; step: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: { requestId: string; step: string }) =>
        listener(progress);
      ipcRenderer.on(DshHostIpc.PluginUpdateState, handler);
      return () => {
        ipcRenderer.removeListener(DshHostIpc.PluginUpdateState, handler);
      };
    },
    onPluginsChanged: (listener: (change: { reason?: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, change: { reason?: string }) =>
        listener(change ?? {});
      ipcRenderer.on(DshHostIpc.PluginsChanged, handler);
      return () => {
        ipcRenderer.removeListener(DshHostIpc.PluginsChanged, handler);
      };
    },
    getPluginRegistries: () => ipcRenderer.invoke(DshHostIpc.GetPluginRegistries),
    pickLocalPluginDir: () => ipcRenderer.invoke(DshHostIpc.PickLocalPluginDir),
    openProfileDir: () => ipcRenderer.invoke(DshHostIpc.OpenProfileDir),
    copyCliShimCommand: () => ipcRenderer.invoke(DshHostIpc.CopyCliShimCommand),
    getPermissionPreset: (sessionId?: string) => ipcRenderer.invoke(DshHostIpc.GetPermissionPreset, sessionId),
    setPermissionPreset: (preset: string, sessionId?: string) =>
      ipcRenderer.invoke(DshHostIpc.SetPermissionPreset, { preset, ...(sessionId ? { sessionId } : {}) }),
  },
  migrationV2: {
    getReport: () => ipcRenderer.invoke(MigrationV2Ipc.GetReport),
    dismissReport: () => ipcRenderer.invoke(MigrationV2Ipc.DismissReport),
    openBackupDir: () => ipcRenderer.invoke(MigrationV2Ipc.OpenBackupDir),
  },
});
