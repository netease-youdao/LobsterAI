/**
 * IM Gateway Manager
 * Unified manager for DingTalk, Feishu, NIM gateways
 * and Telegram, Discord, QQ, WeCom, Weixin, POPO, NeteaseBee via OpenClaw
 */

import Database from 'better-sqlite3';
import { EventEmitter } from 'events';
import * as path from 'path';

import { classifyErrorKey } from '../../common/coworkErrorClassify';
import type { CoworkStore } from '../coworkStore';
import { t } from '../i18n';
import type { CoworkRuntime } from '../libs/agentEngine/types';
import { fetchJsonWithTimeout } from './http';
import { IMChatHandler } from './imChatHandler';
import { IMCoworkHandler } from './imCoworkHandler';
import {
  buildDingTalkSendParamsFromRoute,
  buildDingTalkSessionKeyCandidates,
  type OpenClawDeliveryRoute,
  resolveManagedSessionDeliveryRoute,
  resolveOpenClawDeliveryRouteForSessionKeys,
} from './imDeliveryRoute';
import type {
  IMScheduledTaskCreationResult,
  ParsedIMScheduledTaskRequest,
} from './imScheduledTaskHandler';
import { createIMScheduledTaskRequestDetector } from './imScheduledTaskHandler';
import { IMStore } from './imStore';
import { NimGateway } from './nimGateway';
import {
  IMConnectivityCheck,
  IMConnectivityTestResult,
  IMConnectivityVerdict,
  IMGatewayConfig,
  IMGatewayStatus,
  IMMessage,
  NimInstanceConfig,
  Platform,
} from './types';

const DINGTALK_OPENCLAW_CHANNEL = 'dingtalk-connector';

const CONNECTIVITY_TIMEOUT_MS = 10_000;
const INBOUND_ACTIVITY_WARN_AFTER_MS = 2 * 60 * 1000;

type GatewayClientLike = {
  request: <T = Record<string, unknown>>(
    method: string,
    params?: unknown,
    opts?: { expectFinal?: boolean },
  ) => Promise<T>;
};

interface OpenClawSessionsListResult {
  sessions?: unknown[];
}

interface TelegramGetMeResponse {
  ok?: boolean;
  result?: {
    username?: string;
  };
  description?: string;
}

interface DiscordUserResponse {
  username?: string;
  discriminator?: string;
}

export interface IMGatewayManagerOptions {
  coworkRuntime?: CoworkRuntime;
  coworkStore?: CoworkStore;
  ensureCoworkReady?: () => Promise<void>;
  isOpenClawEngine?: () => boolean;
  syncOpenClawConfig?: () => Promise<void>;
  ensureOpenClawGatewayConnected?: () => Promise<void>;
  getOpenClawGatewayClient?: () => GatewayClientLike | null;
  ensureOpenClawGatewayReady?: () => Promise<void>;
  getOpenClawSessionKeysForCoworkSession?: (sessionId: string) => string[];
  createScheduledTask?: (params: {
    sessionId: string;
    message: IMMessage;
    request: ParsedIMScheduledTaskRequest;
  }) => Promise<IMScheduledTaskCreationResult>;
}

export class IMGatewayManager extends EventEmitter {
  private nimGateway: NimGateway;
  private imStore: IMStore;
  private chatHandler: IMChatHandler | null = null;
  private coworkHandler: IMCoworkHandler | null = null;
  private getLLMConfig: (() => Promise<any>) | null = null;
  private getSkillsPrompt: (() => Promise<string | null>) | null = null;
  private ensureCoworkReady: (() => Promise<void>) | null = null;
  private isOpenClawEngine: (() => boolean) | null = null;
  private syncOpenClawConfig: (() => Promise<void>) | null = null;
  private ensureOpenClawGatewayConnected: (() => Promise<void>) | null = null;
  private getOpenClawGatewayClient: (() => GatewayClientLike | null) | null = null;
  private ensureOpenClawGatewayReady: (() => Promise<void>) | null = null;
  private getOpenClawSessionKeysForCoworkSession: ((sessionId: string) => string[]) | null = null;
  private createScheduledTask:
    | ((params: {
        sessionId: string;
        message: IMMessage;
        request: ParsedIMScheduledTaskRequest;
      }) => Promise<IMScheduledTaskCreationResult>)
    | null = null;

  // Cowork dependencies
  private coworkRuntime: CoworkRuntime | null = null;
  private coworkStore: CoworkStore | null = null;


  // DingTalk direct HTTP API token cache
  private dingTalkAccessToken: string | null = null;
  private dingTalkAccessTokenExpiry = 0;

  constructor(db: Database.Database, options?: IMGatewayManagerOptions) {
    super();

    this.imStore = new IMStore(db);
    this.nimGateway = new NimGateway();

    // Store Cowork dependencies if provided
    if (options?.coworkRuntime && options?.coworkStore) {
      this.coworkRuntime = options.coworkRuntime;
      this.coworkStore = options.coworkStore;
    }
    this.ensureCoworkReady = options?.ensureCoworkReady ?? null;
    this.isOpenClawEngine = options?.isOpenClawEngine ?? null;
    this.syncOpenClawConfig = options?.syncOpenClawConfig ?? null;
    this.ensureOpenClawGatewayConnected = options?.ensureOpenClawGatewayConnected ?? null;
    this.getOpenClawGatewayClient = options?.getOpenClawGatewayClient ?? null;
    this.ensureOpenClawGatewayReady = options?.ensureOpenClawGatewayReady ?? null;
    this.getOpenClawSessionKeysForCoworkSession = options?.getOpenClawSessionKeysForCoworkSession ?? null;
    this.createScheduledTask = options?.createScheduledTask ?? null;

    // Forward gateway events
    this.setupGatewayEventForwarding();
  }

  /**
   * Set up event forwarding from gateways
   */
  private setupGatewayEventForwarding(): void {
    // DingTalk runs via OpenClaw; no direct gateway events to forward

    // NIM runs via OpenClaw; no direct gateway events to forward

    // netease-bee runs via OpenClaw; no direct gateway events to forward

    // QQ runs via OpenClaw; no direct gateway events to forward

    // WeCom runs via OpenClaw; no direct gateway events to forward

    // Weixin runs via OpenClaw; no direct gateway events to forward

    // POPO runs via OpenClaw; no direct gateway events to forward
  }

  /**
   * Reconnect all disconnected gateways
   * Called when network is restored via IPC event
   */
  reconnectAllDisconnected(): void {
    console.log('[IMGatewayManager] Reconnecting all disconnected gateways...');

    // DingTalk runs via OpenClaw; no direct reconnect needed

    // NIM runs via OpenClaw; no direct reconnect needed

    // netease-bee runs via OpenClaw; no direct reconnect needed

    // QQ runs via OpenClaw; no direct reconnection needed

    // WeCom runs via OpenClaw; no direct reconnection needed

    // Weixin runs via OpenClaw; no direct reconnection needed

    // POPO runs via OpenClaw; no direct reconnection needed
  }

  /**
   * Initialize the manager with LLM and skills providers
   */
  initialize(options: {
    getLLMConfig: () => Promise<any>;
    getSkillsPrompt?: () => Promise<string | null>;
  }): void {
    this.getLLMConfig = options.getLLMConfig;
    this.getSkillsPrompt = options.getSkillsPrompt ?? null;

    // Set up message handlers for gateways
    this.setupMessageHandlers();
  }

  /**
   * Set up message handlers for both gateways
   */
  private setupMessageHandlers(): void {
    const messageHandler = async (
      message: IMMessage,
      replyFn: (text: string) => Promise<void>
    ): Promise<void> => {
      // Persist notification target whenever we receive a message
      this.persistNotificationTarget(message.platform);

      try {
        let response: string;

        // Always use Cowork mode if handler is available
        if (this.coworkHandler) {
          if (this.ensureCoworkReady) {
            await this.ensureCoworkReady();
          }
          console.log('[IMGatewayManager] Using Cowork mode for message processing');
          response = await this.coworkHandler.processMessage(message);
        } else {
          // Fallback to regular chat handler
          if (!this.chatHandler) {
            this.updateChatHandler();
          }

          if (!this.chatHandler) {
            throw new Error('Chat handler not available');
          }

          response = await this.chatHandler.processMessage(message);
        }

        await replyFn(response);
      } catch (error: any) {
        console.error(`[IMGatewayManager] Error processing message: ${error.message}`);
        // Don't send "Replaced by a newer IM request" error to user, just log it
        if (error.message === 'Replaced by a newer IM request') {
          return;
        }
        // Send error message to user
        try {
          const errorKey = classifyErrorKey(error.message);
          const friendlyMessage = errorKey ? t(errorKey) : error.message;
          await replyFn(`${t('imErrorPrefix')}: ${friendlyMessage}`);
        } catch (replyError) {
          console.error(`[IMGatewayManager] Failed to send error reply: ${replyError}`);
        }
      }
    };

    this.nimGateway.setMessageCallback(messageHandler);
  }

  /**
   * Persist the notification target for a platform after receiving a message.
   */
  private persistNotificationTarget(platform: Platform): void {
    try {
      let target: any = null;
      if (platform === 'nim') {
        target = this.nimGateway.getNotificationTarget();
      }
      // WeCom runs via OpenClaw; notification target not managed locally
      // Weixin runs via OpenClaw; notification target not managed locally
      // POPO runs via OpenClaw; notification target not managed locally
      if (target != null) {
        this.imStore.setNotificationTarget(platform, target);
      }
    } catch (err: any) {
      console.warn(`[IMGatewayManager] Failed to persist notification target for ${platform}:`, err.message);
    }
  }

  /**
   * Restore notification target from SQLite after gateway starts.
   */
  private restoreNotificationTarget(platform: Platform): void {
    try {
      const target = this.imStore.getNotificationTarget(platform);
      if (target == null) return;

      if (platform === 'nim') {
        this.nimGateway.setNotificationTarget(target);
      }
      // WeCom runs via OpenClaw; notification target not managed locally
      // Weixin runs via OpenClaw; notification target not managed locally
      // POPO runs via OpenClaw; notification target not managed locally
      console.log(`[IMGatewayManager] Restored notification target for ${platform}`);
    } catch (err: any) {
      console.warn(`[IMGatewayManager] Failed to restore notification target for ${platform}:`, err.message);
    }
  }

  /**
   * Update chat handler with current settings
   */
  private updateChatHandler(): void {
    if (!this.getLLMConfig) {
      console.warn('[IMGatewayManager] LLM config provider not set');
      return;
    }

    const imSettings = this.imStore.getIMSettings();

    this.chatHandler = new IMChatHandler({
      getLLMConfig: this.getLLMConfig,
      getSkillsPrompt: this.getSkillsPrompt || undefined,
      imSettings,
    });

    // Update or create Cowork handler if dependencies are available
    this.updateCoworkHandler();
  }

  /**
   * Update or create Cowork handler
   * Always creates handler if dependencies are available (Cowork mode is always enabled for IM)
   */
  private updateCoworkHandler(): void {
    // Always create Cowork handler if we have the required dependencies
    if (this.coworkRuntime && this.coworkStore && !this.coworkHandler) {
      const detectScheduledTaskRequest = this.getLLMConfig && this.createScheduledTask
        ? createIMScheduledTaskRequestDetector({
            getLLMConfig: this.getLLMConfig,
          })
        : undefined;
      this.coworkHandler = new IMCoworkHandler({
        coworkRuntime: this.coworkRuntime,
        coworkStore: this.coworkStore,
        imStore: this.imStore,
        getSkillsPrompt: this.getSkillsPrompt || undefined,
        detectScheduledTaskRequest,
        createScheduledTask: this.createScheduledTask || undefined,
        sendAsyncReply: async (platform, conversationId, text) => {
          return this.sendConversationReply(platform, conversationId, text);
        },
      });
      console.log('[IMGatewayManager] Cowork handler created');
    }
  }

  // ==================== Configuration ====================
  getConfig(): IMGatewayConfig {
    return this.imStore.getConfig();
  }

  getIMStore(): IMStore {
    return this.imStore;
  }

  setConfig(config: Partial<IMGatewayConfig>, options?: { syncGateway?: boolean }): void {
    const previousConfig = this.imStore.getConfig();
    this.imStore.setConfig(config);

    // Update chat handler if settings changed
    if (config.settings) {
      this.updateChatHandler();
    }


    // NIM now runs via OpenClaw; config sync is handled by IPC handler

    // DingTalk now runs via OpenClaw; config sync is handled by IPC handler

    // Feishu now runs via OpenClaw; config sync is handled by IPC handler


    // Hot-update netease-bee config: sync OpenClaw config when credentials change.
    // Only perform sync when syncGateway is explicitly true (i.e. user clicked Save).
    if (options?.syncGateway && config['netease-bee']) {
      const oldNb = previousConfig['netease-bee'];
      const newNb = { ...oldNb, ...config['netease-bee'] };
      const credentialsChanged =
        newNb.clientId !== oldNb?.clientId ||
        newNb.secret !== oldNb?.secret;
      if (credentialsChanged) {
        console.log('[IMGatewayManager] netease-bee credentials changed, syncing OpenClaw config...');
        this.syncOpenClawConfig?.();
      }
    }

    // QQ runs via OpenClaw; config changes are synced via OpenClawConfigSync

    // WeCom runs via OpenClaw; config changes are synced via OpenClawConfigSync

    // Weixin runs via OpenClaw; config changes are synced via OpenClawConfigSync

    // POPO runs via OpenClaw; config changes are synced via OpenClawConfigSync

  }

  private async restartGateway(platform: Platform): Promise<void> {
    console.log(`[IMGatewayManager] Restarting ${platform} gateway...`);
    await this.stopGateway(platform);
    await this.startGateway(platform);
    console.log(`[IMGatewayManager] ${platform} gateway restarted successfully`);
  }

  // ==================== Status ====================
  getStatus(): IMGatewayStatus {
    const config = this.getConfig();
    // Telegram runs via OpenClaw; reflect enabled+configured state per instance
    const telegramStatus = {
      instances: (config.telegram?.instances || []).map(inst => ({
        instanceId: inst.instanceId,
        instanceName: inst.instanceName,
        connected: Boolean(inst.enabled && inst.botToken),
        startedAt: null as number | null,
        lastError: null as string | null,
        botUsername: null as string | null,
        lastInboundAt: null as number | null,
        lastOutboundAt: null as number | null,
      })),
    };
    // Discord runs via OpenClaw; reflect enabled+configured state per instance
    const discordStatus = {
      instances: (config.discord?.instances || []).map(inst => ({
        instanceId: inst.instanceId,
        instanceName: inst.instanceName,
        connected: Boolean(inst.enabled && inst.botToken),
        starting: false,
        startedAt: null as number | null,
        lastError: null as string | null,
        botUsername: null as string | null,
        lastInboundAt: null as number | null,
        lastOutboundAt: null as number | null,
      })),
    };
    // DingTalk runs via OpenClaw; reflect enabled+configured state per instance
    const dingtalkStatus = {
      instances: (config.dingtalk?.instances || []).map(inst => ({
        instanceId: inst.instanceId,
        instanceName: inst.instanceName,
        connected: Boolean(inst.enabled && inst.clientId && inst.clientSecret),
        startedAt: null as number | null,
        lastError: null as string | null,
        lastInboundAt: null as number | null,
        lastOutboundAt: null as number | null,
      })),
    };
    // Feishu runs via OpenClaw; reflect enabled+configured state per instance
    const feishuStatus = {
      instances: (config.feishu?.instances || []).map(inst => ({
        instanceId: inst.instanceId,
        instanceName: inst.instanceName,
        connected: Boolean(inst.enabled && inst.appId && inst.appSecret),
        startedAt: null as string | null,
        botOpenId: null as string | null,
        error: null as string | null,
        lastInboundAt: null as number | null,
        lastOutboundAt: null as number | null,
      })),
    };
    return {
      dingtalk: dingtalkStatus,
      feishu: feishuStatus,
      telegram: telegramStatus,
      qq: {
        instances: (config.qq?.instances || []).map(inst => ({
          instanceId: inst.instanceId,
          instanceName: inst.instanceName,
          connected: Boolean(inst.enabled && inst.appId && inst.appSecret),
          startedAt: null as number | null,
          lastError: null as string | null,
          lastInboundAt: null as number | null,
          lastOutboundAt: null as number | null,
        })),
      },
      discord: discordStatus,
      nim: {
        instances: (config.nim?.instances || []).map(inst => ({
          instanceId: inst.instanceId,
          instanceName: inst.instanceName,
          connected: Boolean(inst.enabled && ((inst.nimToken && inst.nimToken.trim()) || (inst.appKey && inst.account && inst.token))),
          startedAt: null as number | null,
          lastError: null as string | null,
          botAccount: inst.account || null,
          lastInboundAt: null as number | null,
          lastOutboundAt: null as number | null,
        })),
      },
      'netease-bee': (() => {
        const beeConfig = config['netease-bee'];
        return {
          connected: Boolean(beeConfig?.enabled && beeConfig?.clientId && beeConfig?.secret),
          startedAt: null as number | null,
          lastError: null as string | null,
          botAccount: null as string | null,
          lastInboundAt: null as number | null,
          lastOutboundAt: null as number | null,
        };
      })(),
      wecom: {
        instances: (config.wecom?.instances || []).map(inst => ({
          instanceId: inst.instanceId,
          instanceName: inst.instanceName,
          connected: Boolean(inst.enabled && inst.botId && inst.secret),
          startedAt: null as number | null,
          lastError: null as string | null,
          botId: inst.botId || null,
          lastInboundAt: null as number | null,
          lastOutboundAt: null as number | null,
        })),
      },
      weixin: {
        connected: Boolean(config.weixin?.enabled),
        startedAt: null as number | null,
        lastError: null as string | null,
        lastInboundAt: null as number | null,
        lastOutboundAt: null as number | null,
      },
      popo: {
        connected: Boolean(config.popo?.enabled && config.popo.appKey && config.popo.appSecret && config.popo.aesKey && (config.popo.connectionMode === 'websocket' || config.popo.token)),
        startedAt: null as number | null,
        lastError: null as string | null,
        lastInboundAt: null as number | null,
        lastOutboundAt: null as number | null,
      },
      email: {
        instances: (config.email?.instances || []).map(inst => ({
          instanceId: inst.instanceId,
          instanceName: inst.instanceName,
          connected: Boolean(inst.enabled && inst.email),
          startedAt: null as number | null,
          lastError: null as string | null,
          email: inst.email || null,
          transport: inst.transport || null,
          lastInboundAt: null as number | null,
          lastOutboundAt: null as number | null,
        })),
      },
    };
  }

  async testGateway(
    platform: Platform,
    configOverride?: Partial<IMGatewayConfig>
  ): Promise<IMConnectivityTestResult> {
    // Telegram always uses OpenClaw mode
    if (platform === 'telegram') {
      return this.testTelegramOpenClawConnectivity(configOverride);
    }

    // Discord always uses OpenClaw mode
    if (platform === 'discord') {
      return this.testDiscordOpenClawConnectivity(configOverride);
    }

    // Feishu always uses OpenClaw mode
    if (platform === 'feishu') {
      return this.testFeishuOpenClawConnectivity(configOverride);
    }

    // DingTalk always uses OpenClaw mode
    if (platform === 'dingtalk') {
      return this.testDingTalkOpenClawConnectivity(configOverride);
    }

    if (platform === 'nim') {
      return this.testNimOpenClawConnectivity(configOverride);
    }

    // WeCom always uses OpenClaw mode
    if (platform === 'wecom') {
      return this.testWecomOpenClawConnectivity(configOverride);
    }

    // Weixin always uses OpenClaw mode
    if (platform === 'weixin') {
      return this.testWeixinOpenClawConnectivity(configOverride);
    }

    // POPO always uses OpenClaw mode
    if (platform === 'popo') {
      return this.testPopoOpenClawConnectivity(configOverride);
    }

    // QQ always uses OpenClaw mode
    if (platform === 'qq') {
      return this.testQQOpenClawConnectivity(configOverride);
    }

    // NetEase Bee is an internal relay channel with no standalone gateway to test
    if (platform === 'netease-bee') {
      return {
        platform,
        testedAt: Date.now(),
        verdict: 'warn',
        checks: [{
          code: 'gateway_running',
          level: 'info',
          message: 'NetEase Bee channel does not support standalone connectivity testing.',
        }],
      };
    }

    // Email connectivity test (IMAP login or WS API key validation)
    if (platform === 'email') {
      return this.testEmailConnectivity(configOverride);
    }

    const config = this.buildMergedConfig(configOverride);
    const checks: IMConnectivityCheck[] = [];
    const testedAt = Date.now();

    const addCheck = (check: IMConnectivityCheck) => {
      checks.push(check);
    };

    const missingCredentials = this.getMissingCredentials(platform, config);
    if (missingCredentials.length > 0) {
      addCheck({
        code: 'missing_credentials',
        level: 'fail',
        message: t('imMissingCredentials', { fields: missingCredentials.join(', ') }),
        suggestion: t('imFillCredentials'),
      });

      return {
        platform,
        testedAt,
        verdict: 'fail',
        checks,
      };
    }

    try {
      const authMessage = await this.withTimeout(
        this.runAuthProbe(platform, config),
        CONNECTIVITY_TIMEOUT_MS,
        t('imAuthProbeTimeout')
      );
      addCheck({
        code: 'auth_check',
        level: 'pass',
        message: authMessage,
      });
    } catch (error: any) {
      addCheck({
        code: 'auth_check',
        level: 'fail',
        message: t('imAuthFailed', { error: error.message }),
        suggestion: t('imAuthFailedSuggestion'),
      });
      return {
        platform,
        testedAt,
        verdict: 'fail',
        checks,
      };
    }

    const status = this.getStatus();
    const p = platform as string;
    let enabled: boolean;
    if (p === 'qq') {
      enabled = config.qq?.instances?.some(i => i.enabled) ?? false;
    } else if (p === 'feishu') {
      enabled = config.feishu?.instances?.some(i => i.enabled) ?? false;
    } else if (p === 'dingtalk') {
      enabled = config.dingtalk?.instances?.some(i => i.enabled) ?? false;
    } else if (p === 'wecom') {
      enabled = config.wecom?.instances?.some(i => i.enabled) ?? false;
    } else {
      enabled = Boolean((config[platform] as { enabled?: boolean })?.enabled);
    }
    const connected = this.isConnected(platform);

    if (enabled && !connected) {
      addCheck({
        code: 'gateway_running',
        level: 'warn',
        message: t('imChannelEnabledNotConnected'),
        suggestion: t('imChannelEnabledNotConnectedSuggestion'),
      });
    } else {
      addCheck({
        code: 'gateway_running',
        level: connected ? 'pass' : 'info',
        message: connected ? t('imChannelRunning') : t('imChannelNotEnabled'),
        suggestion: connected ? undefined : t('imChannelNotEnabledSuggestion'),
      });
    }

    const startedAt = this.getStartedAtMs(platform, status);
    const lastInboundAt = this.getLastInboundAt(platform, status);
    const lastOutboundAt = this.getLastOutboundAt(platform, status);

    if (connected && startedAt && testedAt - startedAt >= INBOUND_ACTIVITY_WARN_AFTER_MS) {
      if (!lastInboundAt) {
        addCheck({
          code: 'inbound_activity',
          level: 'warn',
          message: t('imNoInboundAfter2Min'),
          suggestion: t('imNoInboundSuggestion'),
        });
      } else {
        addCheck({
          code: 'inbound_activity',
          level: 'pass',
          message: t('imInboundDetected'),
        });
      }
    } else if (connected) {
      addCheck({
        code: 'inbound_activity',
        level: 'info',
        message: t('imGatewayJustStarted'),
      });
    }

    if (connected && lastInboundAt) {
      if (!lastOutboundAt) {
        addCheck({
          code: 'outbound_activity',
          level: 'warn',
          message: t('imNoOutbound'),
          suggestion: t('imNoOutboundSuggestion'),
        });
      } else {
        addCheck({
          code: 'outbound_activity',
          level: 'pass',
          message: t('imOutboundDetected'),
        });
      }
    } else if (connected) {
      addCheck({
        code: 'outbound_activity',
        level: 'info',
        message: t('imNoInboundForOutboundCheck'),
      });
    }

    const lastError = this.getLastError(platform, status);
    if (lastError) {
      addCheck({
        code: 'platform_last_error',
        level: connected ? 'warn' : 'fail',
        message: t('imRecentError', { error: lastError }),
        suggestion: connected
          ? t('imRecentErrorConnectedSuggestion')
          : t('imRecentErrorDisconnectedSuggestion'),
      });
    }

    if (platform === 'qq') {
      addCheck({
        code: 'qq_guild_mention_hint',
        level: 'info',
        message: t('imQqOpenClawHint'),
        suggestion: t('imQqMentionHint'),
      });
    }

    return {
      platform,
      testedAt,
      verdict: this.calculateVerdict(checks),
      checks,
    };
  }

  // ==================== Gateway Control ====================
  async startGateway(platform: Platform): Promise<void> {
    const config = this.getConfig();

    // Ensure chat handler is ready
    this.updateChatHandler();

    if (platform === 'dingtalk') {
      // DingTalk runs via OpenClaw gateway (dingtalk-connector plugin)
      console.log('[IMGatewayManager] DingTalk in OpenClaw mode, syncing config instead of starting direct gateway');
      await this.syncOpenClawConfig?.();
      await this.ensureOpenClawGatewayConnected?.();
      return;
    } else if (platform === 'feishu') {
      // Feishu runs via OpenClaw gateway (feishu-openclaw-plugin)
      console.log('[IMGatewayManager] Feishu in OpenClaw mode, syncing config instead of starting direct gateway');
      await this.syncOpenClawConfig?.();
      await this.ensureOpenClawGatewayConnected?.();
      return;
    } else if (platform === 'telegram') {
      // Telegram always runs via OpenClaw gateway
      console.log('[IMGatewayManager] Telegram in OpenClaw mode, syncing config instead of starting direct gateway');
      await this.syncOpenClawConfig?.();
      // Connect the gateway WebSocket so channel events (e.g. Telegram messages) are received
      await this.ensureOpenClawGatewayConnected?.();
      return;
    } else if (platform === 'discord') {
      // Discord runs via OpenClaw gateway
      console.log('[IMGatewayManager] Discord in OpenClaw mode, syncing config instead of starting direct gateway');
      await this.syncOpenClawConfig?.();
      await this.ensureOpenClawGatewayConnected?.();
      return;
    } else if (platform === 'nim') {
      // NIM runs via OpenClaw gateway (openclaw-nim plugin)
      console.log('[IMGatewayManager] NIM in OpenClaw mode, syncing config instead of starting direct gateway');
      await this.syncOpenClawConfig?.();
      await this.ensureOpenClawGatewayConnected?.();
      return;
    } else if (platform === 'netease-bee') {
      // netease-bee runs via OpenClaw gateway
      console.log('[IMGatewayManager] netease-bee in OpenClaw mode, syncing config instead of starting direct gateway');
      await this.syncOpenClawConfig?.();
      await this.ensureOpenClawGatewayConnected?.();
      return;
    } else if (platform === 'qq') {
      // QQ runs via OpenClaw gateway (qqbot plugin)
      console.log('[IMGatewayManager] QQ in OpenClaw mode, syncing config instead of starting direct gateway');
      await this.syncOpenClawConfig?.();
      await this.ensureOpenClawGatewayConnected?.();
      return;
    } else if (platform === 'wecom') {
      // WeCom runs via OpenClaw gateway (wecom-openclaw-plugin)
      console.log('[IMGatewayManager] WeCom in OpenClaw mode, syncing config instead of starting direct gateway');
      await this.syncOpenClawConfig?.();
      await this.ensureOpenClawGatewayConnected?.();
      return;
    } else if (platform === 'weixin') {
      // Weixin runs via OpenClaw gateway (weixin-openclaw-plugin)
      console.debug('[IMGatewayManager] Weixin in OpenClaw mode, syncing config instead of starting direct gateway');
      await this.syncOpenClawConfig?.();
      await this.ensureOpenClawGatewayConnected?.();
      return;
    } else if (platform === 'popo') {
      // POPO runs via OpenClaw gateway (moltbot-popo plugin)
      console.log('[IMGatewayManager] POPO in OpenClaw mode, syncing config instead of starting direct gateway');
      await this.syncOpenClawConfig?.();
      await this.ensureOpenClawGatewayConnected?.();
      return;
    }

    // Restore persisted notification target
    this.restoreNotificationTarget(platform);
  }

  async stopGateway(platform: Platform): Promise<void> {
    if (platform === 'dingtalk') {
      // DingTalk runs via OpenClaw gateway
      console.log('[IMGatewayManager] DingTalk in OpenClaw mode, syncing disabled config');
      await this.syncOpenClawConfig?.();
      return;
    } else if (platform === 'feishu') {
      // Feishu runs via OpenClaw gateway
      console.log('[IMGatewayManager] Feishu in OpenClaw mode, syncing disabled config');
      await this.syncOpenClawConfig?.();
      return;
    } else if (platform === 'telegram') {
      // Telegram always runs via OpenClaw gateway
      console.log('[IMGatewayManager] Telegram in OpenClaw mode, syncing disabled config');
      await this.syncOpenClawConfig?.();
      return;
    } else if (platform === 'discord') {
      // Discord runs via OpenClaw gateway
      console.log('[IMGatewayManager] Discord in OpenClaw mode, syncing disabled config');
      await this.syncOpenClawConfig?.();
      return;
    } else if (platform === 'nim') {
      // NIM runs via OpenClaw gateway
      console.log('[IMGatewayManager] NIM in OpenClaw mode, syncing disabled config');
      await this.syncOpenClawConfig?.();
      return;
    } else if (platform === 'netease-bee') {
      // netease-bee runs via OpenClaw gateway
      console.log('[IMGatewayManager] netease-bee in OpenClaw mode, syncing disabled config');
      await this.syncOpenClawConfig?.();
      return;
    } else if (platform === 'qq') {
      // QQ runs via OpenClaw gateway
      console.log('[IMGatewayManager] QQ in OpenClaw mode, syncing disabled config');
      await this.syncOpenClawConfig?.();
      return;
    } else if (platform === 'wecom') {
      // WeCom runs via OpenClaw gateway
      console.log('[IMGatewayManager] WeCom in OpenClaw mode, syncing disabled config');
      await this.syncOpenClawConfig?.();
      return;
    } else if (platform === 'weixin') {
      // Weixin runs via OpenClaw gateway
      console.debug('[IMGatewayManager] Weixin in OpenClaw mode, syncing disabled config');
      await this.syncOpenClawConfig?.();
      return;
    } else if (platform === 'popo') {
      // POPO runs via OpenClaw gateway
      console.log('[IMGatewayManager] POPO in OpenClaw mode, syncing disabled config');
      await this.syncOpenClawConfig?.();
      return;
    }
  }

  /**
   * Start all enabled gateways.
   *
   * OpenClaw platforms (dingtalk/feishu/telegram/discord/qq/wecom/weixin/popo/nim) are batched
   * so that `syncOpenClawConfig` + `ensureOpenClawGatewayConnected` are called
   * only **once** regardless of how many OpenClaw platforms are enabled.
   * This avoids N serial gateway restarts which cause message loss, Telegram
   * `getUpdates` conflicts, and rate-limit issues.
   */
  async startAllEnabled(): Promise<void> {
    const config = this.getConfig();

    // Ensure chat handler is ready (called once instead of per-platform)
    this.updateChatHandler();

    // --- OpenClaw platforms: collect and batch into a single sync ---

    const openClawPlatformsToStart: Platform[] = [];

    const dingtalkInstances = config.dingtalk?.instances || [];
    if (dingtalkInstances.some(i => i.enabled && i.clientId && i.clientSecret)) {
      openClawPlatformsToStart.push('dingtalk');
    }
    const feishuInstances = config.feishu?.instances || [];
    if (feishuInstances.some(i => i.enabled && i.appId && i.appSecret)) {
      openClawPlatformsToStart.push('feishu');
    }
    const telegramInstances = config.telegram?.instances || [];
    if (telegramInstances.some(i => i.enabled && i.botToken)) {
      openClawPlatformsToStart.push('telegram');
    }
    const discordInstances = config.discord?.instances || [];
    if (discordInstances.some(i => i.enabled && i.botToken)) {
      openClawPlatformsToStart.push('discord');
    }
    const qqInstances = config.qq?.instances || [];
    if (qqInstances.some(i => i.enabled && i.appId && i.appSecret)) {
      openClawPlatformsToStart.push('qq');
    }
    const wecomInstances = config.wecom?.instances || [];
    if (wecomInstances.some(i => i.enabled && i.botId && i.secret)) {
      openClawPlatformsToStart.push('wecom');
    }
    if (config.weixin?.enabled) {
      openClawPlatformsToStart.push('weixin');
    }
    if (config.popo?.enabled && config.popo?.appKey && config.popo?.appSecret && config.popo?.aesKey && (config.popo.connectionMode === 'websocket' || config.popo.token)) {
      openClawPlatformsToStart.push('popo');
    }
    const nimInstances = config.nim?.instances || [];
    if (nimInstances.some(i => i.enabled && ((i.nimToken && i.nimToken.trim()) || (i.appKey && i.account && i.token)))) {
      openClawPlatformsToStart.push('nim');
    }
    if (config['netease-bee']?.enabled && config['netease-bee']?.clientId && config['netease-bee']?.secret) {
      openClawPlatformsToStart.push('netease-bee');
    }

    if (openClawPlatformsToStart.length > 0) {
      console.log(`[IMGatewayManager] Starting OpenClaw platforms in batch: ${openClawPlatformsToStart.join(', ')}`);
      try {
        await this.syncOpenClawConfig?.();
        await this.ensureOpenClawGatewayConnected?.();
      } catch (error: any) {
        console.error(`[IMGatewayManager] Failed to start OpenClaw platforms: ${error.message}`);
      }
    }
  }

  async stopAll(): Promise<void> {
    // All platforms run via OpenClaw; nothing to stop directly
  }

  isAnyConnected(): boolean {
    return false;
  }

  isConnected(platform: Platform): boolean {
    if (platform === 'dingtalk') {
      // DingTalk runs via OpenClaw; consider it connected when any instance is enabled and configured
      const config = this.getConfig();
      const dingtalkInstances = config.dingtalk?.instances || [];
      return dingtalkInstances.some(i => i.enabled && i.clientId && i.clientSecret);
    }
    if (platform === 'feishu') {
      // Feishu runs via OpenClaw; consider it connected when any instance is enabled and configured
      const config = this.getConfig();
      const feishuInstances = config.feishu?.instances || [];
      return feishuInstances.some(i => i.enabled && i.appId && i.appSecret);
    }
    if (platform === 'telegram') {
      // Telegram runs via OpenClaw; consider it connected when any instance is enabled and configured
      const config = this.getConfig();
      const telegramInstances = config.telegram?.instances || [];
      return telegramInstances.some(i => i.enabled && i.botToken);
    }
    if (platform === 'discord') {
      // Discord runs via OpenClaw; consider it connected when any instance is enabled and configured
      const config = this.getConfig();
      const discordInstances = config.discord?.instances || [];
      return discordInstances.some(i => i.enabled && i.botToken);
    }
    if (platform === 'nim') {
      // NIM runs via OpenClaw; consider it connected when enabled and configured
      const config = this.getConfig();
      const nimInstances = config.nim?.instances || [];
      return nimInstances.some(i => i.enabled && ((i.nimToken && i.nimToken.trim()) || (i.appKey && i.account && i.token)));
    }
    if (platform === 'netease-bee') {
      // netease-bee runs via OpenClaw; status comes from OpenClaw
      const config = this.getConfig();
      return Boolean(config['netease-bee']?.enabled && config['netease-bee']?.clientId && config['netease-bee']?.secret);
    }
    if (platform === 'qq') {
      // QQ runs via OpenClaw; consider it connected when any instance is enabled and configured
      const config = this.getConfig();
      const qqInstances = config.qq?.instances || [];
      return qqInstances.some(i => i.enabled && i.appId && i.appSecret);
    }
    if (platform === 'wecom') {
      // WeCom runs via OpenClaw; consider it connected when any instance is enabled and configured
      const config = this.getConfig();
      const wecomInstances = config.wecom?.instances || [];
      return wecomInstances.some(i => i.enabled && i.botId && i.secret);
    }
    if (platform === 'weixin') {
      const config = this.getConfig();
      return Boolean(config.weixin?.enabled);
    }
    if (platform === 'popo') {
      // POPO runs via OpenClaw; consider it connected when enabled and configured
      const config = this.getConfig();
      return Boolean(config.popo?.enabled && config.popo.appKey && config.popo.appSecret && config.popo.aesKey && (config.popo.connectionMode === 'websocket' || config.popo.token));
    }
    return false;
  }

  async sendNotification(platform: Platform, text: string): Promise<boolean> {
    if (!this.isConnected(platform)) {
      console.warn(`[IMGatewayManager] Cannot send notification: ${platform} is not connected`);
      return false;
    }

    try {
      if (platform === 'nim') {
        // NIM runs via OpenClaw; notifications not yet supported via plugin
        console.log('[IMGatewayManager] NIM notification via OpenClaw not yet supported');
      } else if (platform === 'qq') {
        // QQ runs via OpenClaw; notifications are handled by the qqbot plugin
        console.log('[IMGatewayManager] QQ notification via OpenClaw not yet supported');
      } else if (platform === 'wecom') {
        // WeCom runs via OpenClaw; notifications are handled by the wecom-openclaw-plugin
        console.log('[IMGatewayManager] WeCom notification via OpenClaw not yet supported');
      } else if (platform === 'weixin') {
        // Weixin runs via OpenClaw; notifications are handled by the weixin-openclaw-plugin
        console.debug('[IMGatewayManager] Weixin notification via OpenClaw not yet supported');
      } else if (platform === 'popo') {
        // POPO runs via OpenClaw; notifications are handled by the moltbot-popo plugin
        console.log('[IMGatewayManager] POPO notification via OpenClaw not yet supported');
      } else if (platform === 'netease-bee') {
        // netease-bee runs via OpenClaw; notifications not yet supported
        console.log('[IMGatewayManager] netease-bee notification via OpenClaw not yet supported');
      }
      return true;
    } catch (error: any) {
      console.error(`[IMGatewayManager] Failed to send notification via ${platform}:`, error.message);
      return false;
    }
  }

  async sendNotificationWithMedia(platform: Platform, text: string): Promise<boolean> {
    if (!this.isConnected(platform)) {
      console.warn(`[IMGatewayManager] Cannot send notification: ${platform} is not connected`);
      return false;
    }

    try {
      if (platform === 'nim') {
        // NIM runs via OpenClaw; notifications not yet supported via plugin
        console.log('[IMGatewayManager] NIM notification with media via OpenClaw not yet supported');
      } else if (platform === 'qq') {
        // QQ runs via OpenClaw; notifications are handled by the qqbot plugin
        console.log('[IMGatewayManager] QQ notification with media via OpenClaw not yet supported');
      } else if (platform === 'wecom') {
        // WeCom runs via OpenClaw; notifications are handled by the wecom-openclaw-plugin
        console.log('[IMGatewayManager] WeCom notification with media via OpenClaw not yet supported');
      } else if (platform === 'weixin') {
        // Weixin runs via OpenClaw; notifications are handled by the weixin-openclaw-plugin
        console.debug('[IMGatewayManager] Weixin notification with media via OpenClaw not yet supported');
      } else if (platform === 'popo') {
        // POPO runs via OpenClaw; notifications are handled by the moltbot-popo plugin
        console.log('[IMGatewayManager] POPO notification with media via OpenClaw not yet supported');
      } else if (platform === 'netease-bee') {
        // netease-bee runs via OpenClaw; notifications not yet supported
        console.log('[IMGatewayManager] netease-bee notification via OpenClaw not yet supported');
      }
      return true;
    } catch (error: any) {
      console.error(`[IMGatewayManager] Failed to send notification with media via ${platform}:`, error.message);
      return false;
    }
  }

  private async testTelegramOpenClawConnectivity(
    configOverride?: Partial<IMGatewayConfig>
  ): Promise<IMConnectivityTestResult> {
    const checks: IMConnectivityCheck[] = [];
    const testedAt = Date.now();
    const platform: Platform = 'telegram';

    // Resolve the Telegram config — pick first enabled instance with a botToken
    const mergedConfig = this.buildMergedConfig(configOverride);
    const instances = mergedConfig.telegram?.instances || [];
    const tgInstance = instances.find(i => i.enabled && i.botToken) || instances[0];
    const botToken = tgInstance?.botToken || '';

    // Check 1: Bot token present
    if (!botToken) {
      checks.push({
        code: 'missing_credentials',
        level: 'fail',
        message: t('imTelegramMissingBotToken'),
        suggestion: t('imTelegramFillBotToken'),
      });
      return { platform, testedAt, verdict: 'fail', checks };
    }

    // Check 2: Auth probe via Telegram API (getMe)
    try {
      const response = await this.withTimeout(
        fetchJsonWithTimeout<TelegramGetMeResponse>(
          `https://api.telegram.org/bot${botToken}/getMe`,
          {},
          CONNECTIVITY_TIMEOUT_MS
        ),
        CONNECTIVITY_TIMEOUT_MS,
        t('imAuthProbeTimeout')
      );
      if (response?.ok && response.result?.username) {
        checks.push({
          code: 'auth_check',
          level: 'pass',
          message: t('imTelegramAuthPassed', { username: response.result.username }),
        });
      } else {
        checks.push({
          code: 'auth_check',
          level: 'fail',
          message: t('imTelegramAuthFailed', { error: response?.description || t('imTelegramAuthFailedUnknown') }),
          suggestion: t('imTelegramCheckToken'),
        });
        return { platform, testedAt, verdict: 'fail', checks };
      }
    } catch (error: any) {
      checks.push({
        code: 'auth_check',
        level: 'fail',
        message: t('imTelegramAuthFailed', { error: error.message }),
        suggestion: t('imTelegramCheckTokenNetwork'),
      });
      return { platform, testedAt, verdict: 'fail', checks };
    }

    // Check 3: OpenClaw Gateway running
    checks.push({
      code: 'gateway_running',
      level: 'info',
      message: t('imTelegramOpenClawHint'),
    });

    const verdict: IMConnectivityVerdict = checks.some(c => c.level === 'fail')
      ? 'fail'
      : checks.some(c => c.level === 'warn')
        ? 'warn'
        : 'pass';

    return { platform, testedAt, verdict, checks };
  }

  private async testDiscordOpenClawConnectivity(
    configOverride?: Partial<IMGatewayConfig>
  ): Promise<IMConnectivityTestResult> {
    const checks: IMConnectivityCheck[] = [];
    const testedAt = Date.now();
    const platform: Platform = 'discord';

    const mergedConfig = this.buildMergedConfig(configOverride);
    const discordInstances = mergedConfig.discord?.instances || [];
    const dcConfig = discordInstances.find(i => i.enabled) || discordInstances[0];
    const botToken = dcConfig?.botToken || '';

    // Check 1: Bot token present
    if (!botToken) {
      checks.push({
        code: 'missing_credentials',
        level: 'fail',
        message: t('imDiscordMissingBotToken'),
        suggestion: t('imDiscordFillBotToken'),
      });
      return { platform, testedAt, verdict: 'fail', checks };
    }

    // Check 2: Auth probe via Discord API (/users/@me)
    try {
      const response = await this.withTimeout(
        fetchJsonWithTimeout<DiscordUserResponse>(
          'https://discord.com/api/v10/users/@me',
          { headers: { Authorization: `Bot ${botToken}` } },
          CONNECTIVITY_TIMEOUT_MS
        ),
        CONNECTIVITY_TIMEOUT_MS,
        t('imAuthProbeTimeout')
      );
      const username = response?.username
        ? `${response.username}${response.discriminator && response.discriminator !== '0' ? `#${response.discriminator}` : ''}`
        : 'unknown';
      checks.push({
        code: 'auth_check',
        level: 'pass',
        message: t('imDiscordAuthPassed', { username }),
      });
    } catch (error: any) {
      checks.push({
        code: 'auth_check',
        level: 'fail',
        message: t('imDiscordAuthFailed', { error: error.message }),
        suggestion: t('imDiscordCheckTokenNetwork'),
      });
      return { platform, testedAt, verdict: 'fail', checks };
    }

    // Check 3: OpenClaw Gateway running info
    checks.push({
      code: 'gateway_running',
      level: 'info',
      message: t('imDiscordOpenClawHint'),
    });

    // Check 4: Group mention hint
    checks.push({
      code: 'discord_group_requires_mention',
      level: 'info',
      message: t('imDiscordGroupMention'),
    });

    const verdict: IMConnectivityVerdict = checks.some(c => c.level === 'fail')
      ? 'fail'
      : checks.some(c => c.level === 'warn')
        ? 'warn'
        : 'pass';

    return { platform, testedAt, verdict, checks };
  }

  private async testFeishuOpenClawConnectivity(
    configOverride?: Partial<IMGatewayConfig>
  ): Promise<IMConnectivityTestResult> {
    const checks: IMConnectivityCheck[] = [];
    const testedAt = Date.now();
    const platform: Platform = 'feishu';

    const mergedConfig = this.buildMergedConfig(configOverride);
    const feishuInstances = mergedConfig.feishu?.instances || [];
    const fsConfig = feishuInstances.find(i => i.enabled) || feishuInstances[0];

    // Check 1: Credentials present
    if (!fsConfig?.appId || !fsConfig?.appSecret) {
      const missing: string[] = [];
      if (!fsConfig?.appId) missing.push('appId');
      if (!fsConfig?.appSecret) missing.push('appSecret');
      checks.push({
        code: 'missing_credentials',
        level: 'fail',
        message: t('imMissingCredentials', { fields: missing.join(', ') }),
        suggestion: t('imFeishuFillAppIdSecret'),
      });
      return { platform, testedAt, verdict: 'fail', checks };
    }

    // Check 2: Auth probe via Feishu API
    try {
      const Lark = await import('@larksuiteoapi/node-sdk');
      const domain = this.resolveFeishuDomain(fsConfig.domain, Lark);
      const client = new Lark.Client({
        appId: fsConfig.appId,
        appSecret: fsConfig.appSecret,
        appType: Lark.AppType.SelfBuild,
        domain,
      });
      const response: any = await client.request({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
      });
      if (response.code !== 0) {
        throw new Error(response.msg || `code ${response.code}`);
      }
      const botName = response.data?.app_name ?? response.data?.bot?.app_name ?? 'unknown';
      checks.push({
        code: 'auth_check',
        level: 'pass',
        message: t('imFeishuAuthPassed', { botName }),
      });
    } catch (error: any) {
      checks.push({
        code: 'auth_check',
        level: 'fail',
        message: t('imFeishuAuthFailed', { error: error.message }),
        suggestion: t('imFeishuCheckAppIdSecret'),
      });
      return { platform, testedAt, verdict: 'fail', checks };
    }

    // Check 3: OpenClaw Gateway running info
    checks.push({
      code: 'gateway_running',
      level: 'info',
      message: t('imFeishuOpenClawHint'),
    });

    // Check 4: Group mention hint
    checks.push({
      code: 'feishu_group_requires_mention',
      level: 'info',
      message: t('imFeishuGroupMention'),
      suggestion: t('imFeishuGroupMentionSuggestion'),
    });

    // Check 5: Event subscription hint
    checks.push({
      code: 'feishu_event_subscription_required',
      level: 'info',
      message: t('imFeishuEventSubscription'),
      suggestion: t('imFeishuEventSubscriptionSuggestion'),
    });

    const verdict: IMConnectivityVerdict = checks.some(c => c.level === 'fail')
      ? 'fail'
      : checks.some(c => c.level === 'warn')
        ? 'warn'
        : 'pass';

    return { platform, testedAt, verdict, checks };
  }

  private async testDingTalkOpenClawConnectivity(
    configOverride?: Partial<IMGatewayConfig>
  ): Promise<IMConnectivityTestResult> {
    const checks: IMConnectivityCheck[] = [];
    const testedAt = Date.now();
    const platform: Platform = 'dingtalk';

    const mergedConfig = this.buildMergedConfig(configOverride);
    const dingtalkInstances = mergedConfig.dingtalk?.instances || [];
    const dtConfig = dingtalkInstances.find(i => i.enabled) || dingtalkInstances[0];

    // Check 1: Credentials present
    if (!dtConfig?.clientId || !dtConfig?.clientSecret) {
      const missing: string[] = [];
      if (!dtConfig?.clientId) missing.push('clientId');
      if (!dtConfig?.clientSecret) missing.push('clientSecret');
      checks.push({
        code: 'missing_credentials',
        level: 'fail',
        message: t('imMissingCredentials', { fields: missing.join(', ') }),
        suggestion: t('imDingtalkFillClientIdSecret'),
      });
      return { platform, testedAt, verdict: 'fail', checks };
    }

    // Check 2: Auth probe via DingTalk API
    try {
      const tokenUrl = `https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(dtConfig.clientId)}&appsecret=${encodeURIComponent(dtConfig.clientSecret)}`;
      const resp = await this.withTimeout(
        fetchJsonWithTimeout<{ errcode?: number; errmsg?: string; access_token?: string }>(tokenUrl, {}, CONNECTIVITY_TIMEOUT_MS),
        CONNECTIVITY_TIMEOUT_MS,
        t('imAuthProbeTimeout')
      );
      if (resp.errcode && resp.errcode !== 0) {
        throw new Error(resp.errmsg || `errcode ${resp.errcode}`);
      }
      checks.push({
        code: 'auth_check',
        level: 'pass',
        message: t('imDingtalkAuthPassed'),
      });
    } catch (error: any) {
      checks.push({
        code: 'auth_check',
        level: 'fail',
        message: t('imDingtalkAuthFailed', { error: error.message }),
        suggestion: t('imDingtalkCheckClientIdSecret'),
      });
      return { platform, testedAt, verdict: 'fail', checks };
    }

    // Check 3: OpenClaw Gateway running info
    checks.push({
      code: 'gateway_running',
      level: 'info',
      message: t('imDingtalkOpenClawHint'),
    });

    // Check 4: Bot membership hint
    checks.push({
      code: 'dingtalk_bot_membership_hint',
      level: 'info',
      message: t('imDingtalkBotMembership'),
      suggestion: t('imDingtalkBotMembershipSuggestion'),
    });

    const verdict: IMConnectivityVerdict = checks.some(c => c.level === 'fail')
      ? 'fail'
      : checks.some(c => c.level === 'warn')
        ? 'warn'
        : 'pass';

    return { platform, testedAt, verdict, checks };
  }

  private async testWecomOpenClawConnectivity(
    configOverride?: Partial<IMGatewayConfig>
  ): Promise<IMConnectivityTestResult> {
    const checks: IMConnectivityCheck[] = [];
    const testedAt = Date.now();
    const platform: Platform = 'wecom';

    const mergedConfig = this.buildMergedConfig(configOverride);
    const wecomInstances = mergedConfig.wecom?.instances || [];
    const wcConfig = wecomInstances.find(i => i.enabled) || wecomInstances[0];

    // Check 1: Credentials present
    if (!wcConfig?.botId || !wcConfig?.secret) {
      const missing: string[] = [];
      if (!wcConfig?.botId) missing.push('botId');
      if (!wcConfig?.secret) missing.push('secret');
      checks.push({
        code: 'missing_credentials',
        level: 'fail',
        message: t('imMissingCredentials', { fields: missing.join(', ') }),
        suggestion: t('imWecomFillBotIdSecret'),
      });
      return { platform, testedAt, verdict: 'fail', checks };
    }

    // Check 2: Config completeness passes
    checks.push({
      code: 'auth_check',
      level: 'pass',
      message: t('imWecomConfigReady', { botId: wcConfig.botId }),
    });

    // Check 3: OpenClaw Gateway running info
    checks.push({
      code: 'gateway_running',
      level: 'info',
      message: t('imWecomOpenClawHint'),
    });

    const verdict: IMConnectivityVerdict = checks.some(c => c.level === 'fail')
      ? 'fail'
      : checks.some(c => c.level === 'warn')
        ? 'warn'
        : 'pass';

    return { platform, testedAt, verdict, checks };
  }

  private async testWeixinOpenClawConnectivity(
    configOverride?: Partial<IMGatewayConfig>
  ): Promise<IMConnectivityTestResult> {
    const checks: IMConnectivityCheck[] = [];
    const testedAt = Date.now();
    const platform: Platform = 'weixin';

    const mergedConfig = this.buildMergedConfig(configOverride);
    const wxConfig = mergedConfig.weixin;

    // Weixin has no credentials; just check if enabled
    if (!wxConfig?.enabled) {
      checks.push({
        code: 'gateway_running',
        level: 'info',
        message: t('imWeixinNotEnabled'),
        suggestion: t('imWeixinEnableSuggestion'),
      });
      return { platform, testedAt, verdict: 'pass', checks };
    }

    // Config completeness passes (no credentials needed)
    checks.push({
      code: 'auth_check',
      level: 'pass',
      message: t('imWeixinConfigReady'),
    });

    // OpenClaw Gateway running info
    checks.push({
      code: 'gateway_running',
      level: 'info',
      message: t('imWeixinOpenClawHint'),
    });

    const verdict: IMConnectivityVerdict = checks.some(c => c.level === 'fail')
      ? 'fail'
      : checks.some(c => c.level === 'warn')
        ? 'warn'
        : 'pass';

    return { platform, testedAt, verdict, checks };
  }

  /**
   * Start Weixin QR code login via OpenClaw Gateway RPC.
   * Returns the QR code data URL and a session key for polling.
   */
  async weixinQrLoginStart(): Promise<{ qrDataUrl?: string; message: string; sessionKey?: string }> {
    const client = this.getOpenClawGatewayClient?.();
    if (!client) {
      await this.ensureOpenClawGatewayReady?.();
      const retryClient = this.getOpenClawGatewayClient?.();
      if (!retryClient) {
        return { message: 'OpenClaw Gateway is not running. Please start OpenClaw engine first.' };
      }
      return this.doWeixinQrLoginStart(retryClient);
    }
    return this.doWeixinQrLoginStart(client);
  }

  private async doWeixinQrLoginStart(client: GatewayClientLike): Promise<{ qrDataUrl?: string; message: string; sessionKey?: string }> {
    try {
      const result = await client.request<{ qrDataUrl?: string; message: string; sessionKey?: string }>(
        'web.login.start',
        { force: true, timeoutMs: 300000, verbose: true },
      );
      console.log('[IMGatewayManager] Weixin QR login start result:', result.message);
      return result;
    } catch (err) {
      console.error('[IMGatewayManager] Weixin QR login start failed:', err);
      return { message: `Failed to start Weixin login: ${String(err)}` };
    }
  }

  /**
   * Wait for Weixin QR code scan completion via OpenClaw Gateway RPC.
   */
  async weixinQrLoginWait(accountId?: string): Promise<{ connected: boolean; message: string; accountId?: string }> {
    const client = this.getOpenClawGatewayClient?.();
    if (!client) {
      return { connected: false, message: 'OpenClaw Gateway is not connected.' };
    }
    try {
      const result = await client.request<{ connected: boolean; message: string; accountId?: string }>(
        'web.login.wait',
        { timeoutMs: 480000, ...(accountId ? { accountId } : {}) },
      );
      console.log('[IMGatewayManager] Weixin QR login wait result:', JSON.stringify({ connected: result.connected, message: result.message, accountId: result.accountId }));
      if (result.connected) {
        // Sync config and restart gateway so the weixin channel starts with
        // the newly saved account credentials. The gateway's web.login.wait
        // handler called context.startChannel, but the channel may not fully
        // initialize without a proper config-driven restart.
        await this.syncOpenClawConfig?.();
        await this.ensureOpenClawGatewayConnected?.();
      }
      return result;
    } catch (err) {
      console.error('[IMGatewayManager] Weixin QR login wait failed:', err);
      return { connected: false, message: `Login failed: ${String(err)}` };
    }
  }

  // ---------------------------------------------------------------------------
  // POPO QR code login (direct HTTP polling, no OpenClaw gateway RPC)
  // ---------------------------------------------------------------------------

  private static readonly POPO_QRCODE_BASE_URL =
    'https://f2e.popo.netease.com/polymers/lobster-bot-h5/?pp_htb=1&pp_back_type=cross&taskToken=';
  private static readonly POPO_POLLING_API =
    'https://open.popo.netease.com/open-apis/no-auth/openclaw/v1/polling';
  private static readonly POPO_COMPLETE_API =
    'https://open.popo.netease.com/open-apis/no-auth/openclaw/v1/completed';
  private static readonly POPO_POLLING_INTERVAL_MS = 5_000;
  private static readonly POPO_POLLING_TIMEOUT_MS = 10 * 60_000;

  /**
   * Start POPO QR code login: generate a taskToken and return the QR URL.
   */
  popoQrLoginStart(): { qrUrl: string; taskToken: string; timeoutMs: number } {
    const { randomUUID } = require('crypto') as typeof import('crypto');
    const taskToken = randomUUID();
    const timeout = Date.now() + IMGatewayManager.POPO_POLLING_TIMEOUT_MS;
    const qrUrl = `${IMGatewayManager.POPO_QRCODE_BASE_URL}${taskToken}&timeout=${timeout}`;
    console.log('[IMGatewayManager] POPO QR login started, taskToken:', taskToken);
    return { qrUrl, taskToken, timeoutMs: IMGatewayManager.POPO_POLLING_TIMEOUT_MS };
  }

  /**
   * Poll POPO backend for QR scan result. Blocks until credentials are returned or timeout.
   * Returns { success, appKey, appSecret, aesKey } on success.
   */
  async popoQrLoginPoll(taskToken: string): Promise<{
    success: boolean;
    appKey?: string;
    appSecret?: string;
    aesKey?: string;
    message: string;
  }> {
    const deadline = Date.now() + IMGatewayManager.POPO_POLLING_TIMEOUT_MS;

    while (Date.now() < deadline) {
      try {
        const url = `${IMGatewayManager.POPO_POLLING_API}?taskToken=${taskToken}`;
        const resp = await fetch(url, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(8_000),
        });
        if (resp.ok) {
          const data = await resp.json() as {
            data?: { status?: string; result?: { appKey?: string; appSecret?: string; aesKey?: string } };
          };
          if (data?.data?.status === 'CREATED' && data.data.result) {
            const { appKey, appSecret, aesKey } = data.data.result;
            if (appKey && appSecret && aesKey) {
              console.log('[IMGatewayManager] POPO QR login got credentials');
              // Notify server that setup is complete (best-effort)
              void this.popoQrNotifyComplete(taskToken);
              return { success: true, appKey, appSecret, aesKey, message: 'POPO 机器人绑定成功！' };
            }
          }
        }
      } catch {
        // Ignore individual poll errors, keep trying
      }
      await new Promise(r => setTimeout(r, IMGatewayManager.POPO_POLLING_INTERVAL_MS));
    }

    console.warn('[IMGatewayManager] POPO QR login poll timed out');
    return { success: false, message: '扫码超时，请重试。' };
  }

  private async popoQrNotifyComplete(taskToken: string): Promise<void> {
    try {
      const url = `${IMGatewayManager.POPO_COMPLETE_API}?taskToken=${taskToken}`;
      await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      console.warn('[IMGatewayManager] POPO QR notify complete failed (non-critical)');
    }
  }

  private async testNimOpenClawConnectivity(
    configOverride?: Partial<IMGatewayConfig>
  ): Promise<IMConnectivityTestResult> {
    const checks: IMConnectivityCheck[] = [];
    const testedAt = Date.now();
    const platform: Platform = 'nim';

    const mergedConfig = this.buildMergedConfig(configOverride);
    const nimConfig = (mergedConfig.nim?.instances || []).find((inst) =>
      Boolean((inst.nimToken && inst.nimToken.trim()) || inst.enabled || inst.appKey || inst.account || inst.token)
    );

    if (!nimConfig || (!nimConfig.nimToken && (!nimConfig.appKey || !nimConfig.account || !nimConfig.token))) {
      const missing: string[] = [];
      if (!nimConfig?.nimToken) {
        if (!nimConfig?.appKey) missing.push('appKey');
        if (!nimConfig?.account) missing.push('account');
        if (!nimConfig?.token) missing.push('token');
      }
      checks.push({
        code: 'missing_credentials',
        level: 'fail',
        message: t('imMissingCredentials', { fields: missing.join(', ') }),
        suggestion: t('imNimFillCredentials'),
      });
      return { platform, testedAt, verdict: 'fail', checks };
    }

    checks.push({
      code: 'auth_check',
      level: 'pass',
      message: t('imNimConfigReady', { account: nimConfig.account }),
    });

    checks.push({
      code: 'gateway_running',
      level: 'info',
      message: t('imNimOpenClawHint'),
    });

    checks.push({
      code: 'nim_p2p_only_hint',
      level: 'info',
      message: t('imNimP2pOnly'),
      suggestion: t('imNimP2pOnlySuggestion'),
    });

    const verdict: IMConnectivityVerdict = checks.some(c => c.level === 'fail')
      ? 'fail'
      : checks.some(c => c.level === 'warn')
        ? 'warn'
        : 'pass';

    return { platform, testedAt, verdict, checks };
  }

  /**
   * Test POPO connectivity when running via OpenClaw runtime.
   * Validates config completeness; actual connection is handled by OpenClaw.
   */
  private async testPopoOpenClawConnectivity(
    configOverride?: Partial<IMGatewayConfig>
  ): Promise<IMConnectivityTestResult> {
    const checks: IMConnectivityCheck[] = [];
    const testedAt = Date.now();
    const platform: Platform = 'popo';

    const mergedConfig = this.buildMergedConfig(configOverride);
    const popoConfig = mergedConfig.popo;

    // Check 1: Credentials present
    const isWebhookMode = (popoConfig?.connectionMode ?? 'websocket') === 'webhook';
    const missing: string[] = [];
    if (!popoConfig?.appKey) missing.push('appKey');
    if (!popoConfig?.appSecret) missing.push('appSecret');
    if (isWebhookMode && !popoConfig?.token) missing.push('token');
    if (!popoConfig?.aesKey) missing.push('aesKey');
    if (missing.length > 0) {
      checks.push({
        code: 'missing_credentials',
        level: 'fail',
        message: t('imMissingCredentials', { fields: missing.join(', ') }),
        suggestion: isWebhookMode
          ? t('imPopoFillWebhookCredentials')
          : t('imPopoFillWsCredentials'),
      });
      return { platform, testedAt, verdict: 'fail', checks };
    }

    // Check 2: Config completeness passes
    checks.push({
      code: 'auth_check',
      level: 'pass',
      message: t('imPopoConfigReady'),
    });

    // Check 3: OpenClaw Gateway running info
    checks.push({
      code: 'gateway_running',
      level: 'info',
      message: t('imPopoOpenClawHint'),
    });

    const verdict: IMConnectivityVerdict = checks.some(c => c.level === 'fail')
      ? 'fail'
      : checks.some(c => c.level === 'warn')
        ? 'warn'
        : 'pass';

    return { platform, testedAt, verdict, checks };
  }

  private async testQQOpenClawConnectivity(
    configOverride?: Partial<IMGatewayConfig>
  ): Promise<IMConnectivityTestResult> {
    const checks: IMConnectivityCheck[] = [];
    const testedAt = Date.now();
    const platform: Platform = 'qq';

    const mergedConfig = this.buildMergedConfig(configOverride);
    const qqInstances = mergedConfig.qq?.instances || [];
    const qqConfig = qqInstances.find(i => i.enabled) || qqInstances[0];

    // Check 1: Credentials present
    if (!qqConfig?.appId || !qqConfig?.appSecret) {
      const missing: string[] = [];
      if (!qqConfig?.appId) missing.push('appId');
      if (!qqConfig?.appSecret) missing.push('appSecret');
      checks.push({
        code: 'missing_credentials',
        level: 'fail',
        message: t('imMissingCredentials', { fields: missing.join(', ') }),
        suggestion: t('imQqFillAppIdSecret'),
      });
      return { platform, testedAt, verdict: 'fail', checks };
    }

    // Check 2: Auth probe via QQ Bot API
    try {
      const tokenResponse = await this.withTimeout(
        fetchJsonWithTimeout<{ access_token?: string; expires_in?: number; code?: number; message?: string }>(
          'https://bots.qq.com/app/getAppAccessToken',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ appId: qqConfig.appId, clientSecret: qqConfig.appSecret }),
          },
          CONNECTIVITY_TIMEOUT_MS
        ),
        CONNECTIVITY_TIMEOUT_MS,
        t('imAuthProbeTimeout')
      );
      if (!tokenResponse.access_token) {
        throw new Error(tokenResponse.message || t('imQqAccessTokenFailed'));
      }
      checks.push({
        code: 'auth_check',
        level: 'pass',
        message: t('imQqAuthPassed'),
      });
    } catch (error: any) {
      checks.push({
        code: 'auth_check',
        level: 'fail',
        message: t('imQqAuthFailed', { error: error.message }),
        suggestion: t('imQqCheckAppIdSecret'),
      });
      return { platform, testedAt, verdict: 'fail', checks };
    }

    // Check 3: OpenClaw Gateway running info
    checks.push({
      code: 'gateway_running',
      level: 'info',
      message: t('imQqOpenClawHint'),
    });

    // Check 4: Mention hint
    checks.push({
      code: 'qq_mention_hint',
      level: 'info',
      message: t('imQqMentionHint'),
    });

    const verdict: IMConnectivityVerdict = checks.some(c => c.level === 'fail')
      ? 'fail'
      : checks.some(c => c.level === 'warn')
        ? 'warn'
        : 'pass';

    return { platform, testedAt, verdict, checks };
  }



  private buildMergedConfig(configOverride?: Partial<IMGatewayConfig>): IMGatewayConfig {
    const current = this.getConfig();
    if (!configOverride) {
      return current;
    }
    return {
      ...current,
      ...configOverride,
      dingtalk: configOverride.dingtalk || current.dingtalk,
      feishu: configOverride.feishu || current.feishu,
      qq: configOverride.qq || current.qq,
      telegram: configOverride.telegram || current.telegram,
      discord: configOverride.discord || current.discord,
      nim: { ...current.nim, ...(configOverride.nim || {}) },
      'netease-bee': { ...current['netease-bee'], ...(configOverride['netease-bee'] || {}) },
      wecom: configOverride.wecom || current.wecom,
      weixin: { ...current.weixin, ...(configOverride.weixin || {}) },
      popo: { ...current.popo, ...(configOverride.popo || {}) },
      settings: { ...current.settings, ...(configOverride.settings || {}) },
    };
  }

  private getMissingCredentials(platform: Platform, config: IMGatewayConfig): string[] {
    if (platform === 'dingtalk') {
      const dingtalkInstances = config.dingtalk?.instances || [];
      const dtInst = dingtalkInstances.find(i => i.enabled);
      if (!dtInst) return ['clientId', 'clientSecret'];
      const fields: string[] = [];
      if (!dtInst.clientId) fields.push('clientId');
      if (!dtInst.clientSecret) fields.push('clientSecret');
      return fields;
    }
    if (platform === 'feishu') {
      const feishuInstances = config.feishu?.instances || [];
      const fsInst = feishuInstances.find(i => i.enabled);
      if (!fsInst) return ['appId', 'appSecret'];
      const fields: string[] = [];
      if (!fsInst.appId) fields.push('appId');
      if (!fsInst.appSecret) fields.push('appSecret');
      return fields;
    }
    if (platform === 'telegram') {
      const telegramInstances = config.telegram?.instances || [];
      const tgInst = telegramInstances.find(i => i.enabled);
      if (!tgInst) return ['botToken'];
      return tgInst.botToken ? [] : ['botToken'];
    }
    if (platform === 'nim') {
      const nimInstances = config.nim?.instances || [];
      const nimInst = nimInstances.find(i => i.enabled);
      if (!nimInst) return ['appKey', 'account', 'token'];
      const fields: string[] = [];
      if (!nimInst.nimToken) {
        if (!nimInst.appKey) fields.push('appKey');
        if (!nimInst.account) fields.push('account');
        if (!nimInst.token) fields.push('token');
      }
      return fields;
    }
    if (platform === 'netease-bee') {
      const fields: string[] = [];
      if (!config['netease-bee']?.clientId) fields.push('clientId');
      if (!config['netease-bee']?.secret) fields.push('secret');
      return fields;
    }
    if (platform === 'qq') {
      const qqInstances = config.qq?.instances || [];
      const qqInst = qqInstances.find(i => i.enabled);
      if (!qqInst) return ['appId', 'appSecret'];
      const fields: string[] = [];
      if (!qqInst.appId) fields.push('appId');
      if (!qqInst.appSecret) fields.push('appSecret');
      return fields;
    }
    if (platform === 'wecom') {
      const wecomInstances = config.wecom?.instances || [];
      const wcInst = wecomInstances.find(i => i.enabled);
      if (!wcInst) return ['botId', 'secret'];
      const fields: string[] = [];
      if (!wcInst.botId) fields.push('botId');
      if (!wcInst.secret) fields.push('secret');
      return fields;
    }
    if (platform === 'weixin') {
      // Weixin has no credentials; nothing to check
      return [];
    }
    if (platform === 'popo') {
      const fields: string[] = [];
      if (!config.popo?.appKey) fields.push('appKey');
      if (!config.popo?.appSecret) fields.push('appSecret');
      if ((config.popo?.connectionMode ?? 'websocket') === 'webhook' && !config.popo?.token) fields.push('token');
      if (!config.popo?.aesKey) fields.push('aesKey');
      return fields;
    }
    const discordInstances = config.discord?.instances || [];
    const dcInst = discordInstances.find(i => i.enabled);
    return dcInst?.botToken ? [] : ['botToken'];
  }

  private async runAuthProbe(platform: Platform, config: IMGatewayConfig): Promise<string> {
    if (platform === 'dingtalk') {
      const dingtalkInstances = config.dingtalk?.instances || [];
      const dtInst = dingtalkInstances.find(i => i.enabled && i.clientId && i.clientSecret);
      if (!dtInst) {
        throw new Error(t('imConfigIncomplete'));
      }
      const tokenUrl = `https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(dtInst.clientId)}&appsecret=${encodeURIComponent(dtInst.clientSecret)}`;
      const resp = await fetchJsonWithTimeout<{ errcode?: number; errmsg?: string }>(tokenUrl, {}, CONNECTIVITY_TIMEOUT_MS);
      if (resp.errcode && resp.errcode !== 0) {
        throw new Error(resp.errmsg || `errcode ${resp.errcode}`);
      }
      return t('imDingtalkAuthPassed');
    }

    if (platform === 'feishu') {
      const feishuInstances = config.feishu?.instances || [];
      const fsInst = feishuInstances.find(i => i.enabled && i.appId && i.appSecret);
      if (!fsInst) {
        throw new Error(t('imConfigIncomplete'));
      }
      const Lark = await import('@larksuiteoapi/node-sdk');
      const domain = this.resolveFeishuDomain(fsInst.domain, Lark);
      const client = new Lark.Client({
        appId: fsInst.appId,
        appSecret: fsInst.appSecret,
        appType: Lark.AppType.SelfBuild,
        domain,
      });
      const response: any = await client.request({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
      });
      if (response.code !== 0) {
        throw new Error(response.msg || `code ${response.code}`);
      }
      const botName = response.data?.app_name ?? response.data?.bot?.app_name ?? 'unknown';
      return t('imFeishuAuthPassedWithBot', { botName });
    }

    if (platform === 'nim') {
      const nimInst = (config.nim?.instances || []).find(i => i.enabled && ((i.nimToken && i.nimToken.trim()) || (i.appKey && i.account && i.token)));
      if (!nimInst) {
        throw new Error(t('imConfigIncomplete'));
      }
      return t('imNimConfigReady', { account: nimInst.account });
    }

    if (platform === 'netease-bee') {
      const nbConfig = config['netease-bee'];
      const clientId = nbConfig?.clientId;
      const secret = nbConfig?.secret;
      if (!clientId || !secret) {
        throw new Error(t('imConfigIncomplete'));
      }
      return t('imNeteaseBeeConfigReady', { clientId });
    }

    if (platform === 'wecom') {
      const wecomInstances = config.wecom?.instances || [];
      const wcInst = wecomInstances.find(i => i.enabled && i.botId && i.secret);
      if (!wcInst) {
        throw new Error(t('imConfigIncomplete'));
      }
      return t('imWecomConfigReadyOpenClaw', { botId: wcInst.botId });

    }

    if (platform === 'weixin') {
      // Weixin has no credentials to probe; just confirm enabled
      return t('imWeixinConfigReadyOpenClaw');
    }

    if (platform === 'popo') {
      const { appKey, appSecret, token, aesKey, connectionMode } = config.popo;
      const isWebhook = (connectionMode ?? 'websocket') === 'webhook';
      if (!appKey || !appSecret || !aesKey || (isWebhook && !token)) {
        throw new Error(t('imConfigIncomplete'));
      }
      return t('imPopoConfigReadyOpenClaw');
    }

    if (platform === 'qq') {
      const qqInstances = config.qq?.instances || [];
      const qqInst = qqInstances.find(i => i.enabled && i.appId && i.appSecret);
      if (!qqInst) {
        throw new Error(t('imConfigIncomplete'));
      }
      const { appId, appSecret } = qqInst;
      // Verify credentials by requesting an AccessToken directly via HTTP
      // This avoids starting a full WebSocket connection just for auth check
      const tokenResponse = await fetchJsonWithTimeout<{ access_token?: string; expires_in?: number; code?: number; message?: string }>(
        'https://bots.qq.com/app/getAppAccessToken',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appId, clientSecret: appSecret }),
        },
        CONNECTIVITY_TIMEOUT_MS
      );
      if (!tokenResponse.access_token) {
        throw new Error(tokenResponse.message || t('imQqAccessTokenFailed'));
      }
      return t('imQqAuthPassed');
    }

    return t('imUnknownPlatform');
  }


  async sendConversationReply(platform: Platform, conversationId: string, text: string): Promise<boolean> {
    try {
      switch (platform) {
        default:
          return this.sendNotificationWithMedia(platform, text);
      }
    } catch (error) {
      console.error(`[IMGatewayManager] Failed to send conversation reply for ${platform}:${conversationId}:`, error);
      return false;
    }
  }

  // ─── DingTalk direct HTTP API ──────────────────────────────────────────────

  private async getDingTalkAccessToken(clientId: string, clientSecret: string): Promise<string> {
    const now = Date.now();
    if (this.dingTalkAccessToken && this.dingTalkAccessTokenExpiry > now + 60_000) {
      return this.dingTalkAccessToken;
    }

    const resp = await fetchJsonWithTimeout<{
      accessToken?: string;
      expireIn?: number;
    }>('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appKey: clientId, appSecret: clientSecret }),
    }, 10_000);

    if (!resp.accessToken) {
      throw new Error('DingTalk accessToken response missing token');
    }

    this.dingTalkAccessToken = resp.accessToken;
    this.dingTalkAccessTokenExpiry = now + ((resp.expireIn ?? 7200) * 1000);
    return this.dingTalkAccessToken;
  }

  private async sendDingTalkDirectHttp(userId: string, text: string): Promise<boolean> {
    const dtInstances = this.imStore.getDingTalkInstances();
    const dtConfig = dtInstances.find(i => i.enabled && i.clientId && i.clientSecret);
    if (!dtConfig?.clientId || !dtConfig?.clientSecret) {
      console.warn('[IMGatewayManager] DingTalk direct send skipped: missing clientId/clientSecret');
      return false;
    }

    const token = await this.getDingTalkAccessToken(dtConfig.clientId, dtConfig.clientSecret);

    // Auto-detect markdown vs plain text.
    const hasMarkdown = /^[#*>\-]|[*_`#\[\]]/.test(text) || text.includes('\n');
    const msgKey = hasMarkdown ? 'sampleMarkdown' : 'sampleText';
    const msgParam = hasMarkdown
      ? { title: text.split('\n')[0].replace(/^[#*\s\->]+/, '').slice(0, 20) || 'Message', text }
      : { content: text };

    const body = {
      robotCode: dtConfig.clientId,
      userIds: [userId],
      msgKey,
      msgParam: JSON.stringify(msgParam),
    };

    console.log('[IMGatewayManager] DingTalk direct HTTP send', JSON.stringify({
      userId,
      msgKey,
      textLength: text.length,
    }));

    const resp = await fetchJsonWithTimeout<{
      processQueryKey?: string;
      message?: string;
    }>('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
      method: 'POST',
      headers: {
        'x-acs-dingtalk-access-token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }, 10_000);

    if (resp.processQueryKey) {
      console.log(`[IMGatewayManager] DingTalk direct send success: processQueryKey=${resp.processQueryKey}`);
      return true;
    }

    console.warn('[IMGatewayManager] DingTalk direct send unexpected response:', JSON.stringify(resp));
    return false;
  }
  async primeConversationReplyRoute(
    platform: Platform,
    conversationId: string,
    coworkSessionId: string,
  ): Promise<void> {
    if (platform !== 'dingtalk') {
      return;
    }

    try {
      const lookup = await this.lookupDingTalkConversationReplyRoute(conversationId, coworkSessionId);
      const resolved = lookup?.resolved;
      if (resolved) {
        this.cacheConversationReplyRoute('dingtalk', conversationId, resolved.route);
        const sendParams = buildDingTalkSendParamsFromRoute(resolved.route);
        console.log('[IMGatewayManager] Primed DingTalk reply route', JSON.stringify({
          conversationId,
          coworkSessionId: lookup.coworkSessionId,
          sessionKey: resolved.sessionKey,
          channel: resolved.route.channel,
          target: sendParams?.target ?? resolved.route.to,
          accountId: sendParams?.accountId ?? resolved.route.accountId ?? null,
        }));
        return;
      }

      // Fallback: construct route from session key JSON context.
      // When the OpenClaw session lacks deliveryContext (e.g. cron-triggered runs),
      // the session key itself may embed a JSON SessionContext with all needed info.
      const fallbackRoute = this.buildDingTalkRouteFromSessionKeys(
        lookup?.candidateSessionKeys ?? [],
      );
      if (fallbackRoute) {
        this.cacheConversationReplyRoute('dingtalk', conversationId, fallbackRoute.route);
        console.log('[IMGatewayManager] Primed DingTalk reply route from session key context', JSON.stringify({
          conversationId,
          coworkSessionId,
          sessionKey: fallbackRoute.sessionKey,
          channel: fallbackRoute.route.channel,
          target: fallbackRoute.route.to,
          accountId: fallbackRoute.route.accountId ?? null,
        }));
      }
    } catch (error: any) {
      console.warn(
        `[IMGatewayManager] Failed to prime DingTalk reply route for ${conversationId}:`,
        error?.message || error,
      );
    }
  }

  private async resolveDingTalkConversationReplyTarget(
    conversationId: string,
  ): Promise<{ accountId?: string; target: string } | null> {
    let lookup: Awaited<ReturnType<IMGatewayManager['lookupDingTalkConversationReplyRoute']>> = null;
    try {
      lookup = await this.lookupDingTalkConversationReplyRoute(conversationId);
    } catch (error: any) {
      console.warn(
        `[IMGatewayManager] Failed to query OpenClaw DingTalk reply route for ${conversationId}:`,
        error?.message || error,
      );
    }

    if (!lookup?.resolved) {
      if (lookup) {
        console.warn(
          `[IMGatewayManager] No OpenClaw delivery route found for DingTalk session ${lookup.coworkSessionId}`,
          JSON.stringify({
            conversationId,
            candidateSessionKeys: lookup.candidateSessionKeys,
            dingtalkSessionKeys: lookup.dingtalkSessionKeys,
          }),
        );
      }

      const cachedRoute = this.imStore.getConversationReplyRoute('dingtalk', conversationId);
      if (cachedRoute) {
        const cachedSendParams = buildDingTalkSendParamsFromRoute(cachedRoute);
        if (cachedSendParams) {
          console.log('[IMGatewayManager] Reused cached DingTalk reply route', JSON.stringify({
            conversationId,
            channel: cachedRoute.channel,
            target: cachedSendParams.target,
            accountId: cachedSendParams.accountId ?? null,
          }));
          return cachedSendParams;
        }
      }

      // Fallback: construct route from session key JSON context when OpenClaw
      // session lacks deliveryContext (common for cron-triggered runs).
      const fallbackRoute = this.buildDingTalkRouteFromSessionKeys(
        lookup?.candidateSessionKeys ?? [],
      );
      if (fallbackRoute) {
        this.cacheConversationReplyRoute('dingtalk', conversationId, fallbackRoute.route);
        const fallbackSendParams = buildDingTalkSendParamsFromRoute(fallbackRoute.route);
        if (fallbackSendParams) {
          console.log('[IMGatewayManager] Resolved DingTalk reply route from session key context', JSON.stringify({
            conversationId,
            sessionKey: fallbackRoute.sessionKey,
            channel: fallbackRoute.route.channel,
            target: fallbackSendParams.target,
            accountId: fallbackSendParams.accountId ?? null,
          }));
          return fallbackSendParams;
        }
      }

      return null;
    }

    const { resolved } = lookup;
    this.cacheConversationReplyRoute('dingtalk', conversationId, resolved.route);

    const sendParams = buildDingTalkSendParamsFromRoute(resolved.route);
    if (!sendParams) {
      console.warn(
        `[IMGatewayManager] OpenClaw route for ${resolved.sessionKey} is not a DingTalk route: ${resolved.route.channel}`,
      );
      return null;
    }

    console.log('[IMGatewayManager] Resolved DingTalk reply route', JSON.stringify({
      conversationId,
      coworkSessionId: lookup.coworkSessionId,
      sessionKey: resolved.sessionKey,
      channel: resolved.route.channel,
      target: sendParams.target,
      accountId: sendParams.accountId ?? null,
    }));
    return sendParams;
  }

  private async lookupDingTalkConversationReplyRoute(
    conversationId: string,
    coworkSessionId?: string,
  ): Promise<{
    coworkSessionId: string;
    candidateSessionKeys: string[];
    dingtalkSessionKeys: string[];
    resolved: { sessionKey: string; route: OpenClawDeliveryRoute } | null;
  } | null> {
    const normalizedCoworkSessionId = coworkSessionId?.trim()
      || this.imStore.getSessionMapping(conversationId, 'dingtalk')?.coworkSessionId
      || '';
    if (!normalizedCoworkSessionId) {
      return null;
    }

    const result = await this.requestOpenClawGateway<OpenClawSessionsListResult>('sessions.list', {
      includeGlobal: true,
      includeUnknown: true,
      limit: 200,
    });
    const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
    const candidateSessionKeys = [
      ...(this.getOpenClawSessionKeysForCoworkSession?.(normalizedCoworkSessionId) ?? []),
      ...buildDingTalkSessionKeyCandidates(conversationId),
    ];

    return {
      coworkSessionId: normalizedCoworkSessionId,
      candidateSessionKeys,
      dingtalkSessionKeys: this.collectSessionKeysByChannel(sessions, DINGTALK_OPENCLAW_CHANNEL),
      resolved: resolveOpenClawDeliveryRouteForSessionKeys(candidateSessionKeys, sessions)
        ?? resolveManagedSessionDeliveryRoute(normalizedCoworkSessionId, sessions),
    };
  }

  private cacheConversationReplyRoute(
    platform: Platform,
    conversationId: string,
    route: OpenClawDeliveryRoute,
  ): void {
    this.imStore.setConversationReplyRoute(platform, conversationId, route);
  }

  private collectSessionKeysByChannel(sessions: unknown[], channel: string): string[] {
    const normalizedChannel = channel.trim().toLowerCase();
    const matches: string[] = [];
    for (const entry of sessions) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const key = typeof record.key === 'string' ? record.key.trim() : '';
      if (!key) {
        continue;
      }
      const deliveryContext = record.deliveryContext;
      const deliveryChannel = deliveryContext && typeof deliveryContext === 'object' && !Array.isArray(deliveryContext)
        ? (typeof (deliveryContext as Record<string, unknown>).channel === 'string'
          ? ((deliveryContext as Record<string, unknown>).channel as string)
          : undefined)
        : undefined;
      const lastChannel = typeof record.lastChannel === 'string' ? record.lastChannel : undefined;
      const routeChannel = (deliveryChannel ?? lastChannel ?? '').trim().toLowerCase();
      if (routeChannel !== normalizedChannel && !key.toLowerCase().includes(normalizedChannel)) {
        continue;
      }
      matches.push(key);
      if (matches.length >= 12) {
        break;
      }
    }
    return matches;
  }

  private parseDingTalkConversationTarget(
    conversationId: string,
  ): { accountId?: string; target: string } | null {
    const parts = conversationId.split(':').filter(Boolean);
    if (parts.length < 2) {
      return null;
    }

    const accountId = parts[0]?.trim();
    if (!accountId) {
      return null;
    }

    // The dingtalk-connector plugin uses "__default__" as an internal account
    // lookup key.  The send API expects this key (or undefined for default),
    // NOT the actual clientId.  Omit it so the plugin uses its default account.
    const resolvedAccountId = accountId === '__default__' ? undefined : accountId;

    if ((parts[1] === 'user' || parts[1] === 'group') && parts[2]) {
      return {
        accountId: resolvedAccountId,
        target: `${parts[1]}:${parts.slice(2).join(':')}`,
      };
    }

    const senderId = parts[1]?.trim();
    if (!senderId) {
      return null;
    }

    return {
      accountId: resolvedAccountId,
      target: `user:${senderId}`,
    };
  }

  private buildDingTalkRouteFromSessionKeys(
    sessionKeys: string[],
  ): { sessionKey: string; route: OpenClawDeliveryRoute } | null {
    for (const sessionKey of sessionKeys) {
      const jsonIdx = sessionKey.indexOf(':{');
      if (jsonIdx < 0) {
        continue;
      }
      const jsonStr = sessionKey.slice(jsonIdx + 1);
      let ctx: Record<string, unknown>;
      try {
        ctx = JSON.parse(jsonStr);
      } catch {
        continue;
      }
      if (!ctx || typeof ctx.channel !== 'string') {
        continue;
      }
      const channel = (ctx.channel as string).trim().toLowerCase();
      if (channel !== 'dingtalk-connector' && channel !== 'dingtalk') {
        continue;
      }

      // Determine the target address from the session context.
      const chatType = typeof ctx.chattype === 'string' ? ctx.chattype : 'direct';
      const peerId = typeof ctx.peerid === 'string' ? (ctx.peerid as string).trim() : '';
      const ctxConversationId = typeof ctx.conversationid === 'string' ? (ctx.conversationid as string).trim() : '';
      if (!peerId && !ctxConversationId) {
        continue;
      }

      const to = chatType === 'group'
        ? `group:${ctxConversationId || peerId}`
        : `user:${peerId || ctxConversationId}`;

      // Keep the original accountId from the session context (e.g. '__default__').
      // The dingtalk-connector plugin uses this as an account lookup key, NOT the clientId.
      // When accountId is '__default__', omit it so the plugin uses its default account.
      let accountId = typeof ctx.accountid === 'string' ? (ctx.accountid as string).trim() : undefined;
      if (!accountId || accountId === '__default__') {
        accountId = undefined;
      }

      return {
        sessionKey,
        route: {
          channel: DINGTALK_OPENCLAW_CHANNEL,
          to,
          ...(accountId ? { accountId } : {}),
        },
      };
    }
    return null;
  }

  /**
   * Fetch the OpenClaw config schema (JSON Schema + uiHints) from the gateway.
   * Returns { schema, uiHints } or null if the gateway is unavailable.
   */
  async getOpenClawConfigSchema(): Promise<{ schema: Record<string, unknown>; uiHints: Record<string, Record<string, unknown>> } | null> {
    try {
      return await this.requestOpenClawGateway<{ schema: Record<string, unknown>; uiHints: Record<string, Record<string, unknown>> }>('config.schema', {});
    } catch (err: any) {
      console.warn('[IMGatewayManager] Failed to fetch config.schema from OpenClaw gateway:', err.message);
      return null;
    }
  }

  private async requestOpenClawGateway<T = Record<string, unknown>>(
    method: string,
    params?: unknown,
  ): Promise<T> {
    let client = this.getOpenClawGatewayClient?.() ?? null;
    if (!client) {
      await this.ensureOpenClawGatewayReady?.();
      client = this.getOpenClawGatewayClient?.() ?? null;
    }
    if (!client) {
      throw new Error('OpenClaw gateway client is unavailable.');
    }
    return client.request<T>(method, params);
  }

  private resolveFeishuDomain(domain: string, Lark: any): any {
    if (domain === 'lark') return Lark.Domain.Lark;
    if (domain === 'feishu') return Lark.Domain.Feishu;
    return domain.replace(/\/+$/, '');
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutError: string): Promise<T> {
    let timeoutId: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<T>((_resolve, reject) => {
      timeoutId = setTimeout(() => reject(new Error(timeoutError)), timeoutMs);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    });
  }

  private getStartedAtMs(platform: Platform, status: IMGatewayStatus): number | null {
    if (platform === 'feishu') {
      const startedAt = status.feishu.instances?.[0]?.startedAt;
      return startedAt ? Date.parse(startedAt) : null;
    }
    if (platform === 'dingtalk') return status.dingtalk.instances?.[0]?.startedAt ?? null;
    if (platform === 'telegram') return status.telegram.instances?.[0]?.startedAt ?? null;
    if (platform === 'nim') return status.nim.instances?.[0]?.startedAt ?? null;
    if (platform === 'netease-bee') return status['netease-bee'].startedAt;
    if (platform === 'qq') return status.qq.instances?.[0]?.startedAt ?? null;
    if (platform === 'wecom') return status.wecom.instances?.[0]?.startedAt ?? null;
    if (platform === 'weixin') return status.weixin.startedAt;
    if (platform === 'popo') return status.popo.startedAt;
    return status.discord.instances?.[0]?.startedAt ?? null;
  }

  private getLastInboundAt(platform: Platform, status: IMGatewayStatus): number | null {
    if (platform === 'dingtalk') return status.dingtalk.instances?.[0]?.lastInboundAt ?? null;
    if (platform === 'feishu') return status.feishu.instances?.[0]?.lastInboundAt ?? null;
    if (platform === 'telegram') return status.telegram.instances?.[0]?.lastInboundAt ?? null;
    if (platform === 'nim') return status.nim.instances?.[0]?.lastInboundAt ?? null;
    if (platform === 'netease-bee') return status['netease-bee'].lastInboundAt;
    if (platform === 'qq') return status.qq.instances?.[0]?.lastInboundAt ?? null;
    if (platform === 'wecom') return status.wecom.instances?.[0]?.lastInboundAt ?? null;
    if (platform === 'weixin') return status.weixin.lastInboundAt;
    if (platform === 'popo') return status.popo.lastInboundAt;
    return status.discord.instances?.[0]?.lastInboundAt ?? null;
  }

  private getLastOutboundAt(platform: Platform, status: IMGatewayStatus): number | null {
    if (platform === 'dingtalk') return status.dingtalk.instances?.[0]?.lastOutboundAt ?? null;
    if (platform === 'feishu') return status.feishu.instances?.[0]?.lastOutboundAt ?? null;
    if (platform === 'telegram') return status.telegram.instances?.[0]?.lastOutboundAt ?? null;
    if (platform === 'nim') return status.nim.instances?.[0]?.lastOutboundAt ?? null;
    if (platform === 'netease-bee') return status['netease-bee'].lastOutboundAt;
    if (platform === 'qq') return status.qq.instances?.[0]?.lastOutboundAt ?? null;
    if (platform === 'wecom') return status.wecom.instances?.[0]?.lastOutboundAt ?? null;
    if (platform === 'weixin') return status.weixin.lastOutboundAt;
    if (platform === 'popo') return status.popo.lastOutboundAt;
    return status.discord.instances?.[0]?.lastOutboundAt ?? null;
  }

  private getLastError(platform: Platform, status: IMGatewayStatus): string | null {
    if (platform === 'dingtalk') return status.dingtalk.instances?.[0]?.lastError ?? null;
    if (platform === 'feishu') return status.feishu.instances?.[0]?.error ?? null;
    if (platform === 'telegram') return status.telegram.instances?.[0]?.lastError ?? null;
    if (platform === 'nim') return status.nim.instances?.[0]?.lastError ?? null;
    if (platform === 'netease-bee') return status['netease-bee'].lastError;
    if (platform === 'qq') return status.qq.instances?.[0]?.lastError ?? null;
    if (platform === 'wecom') return status.wecom.instances?.[0]?.lastError ?? null;
    if (platform === 'weixin') return status.weixin.lastError;
    if (platform === 'popo') return status.popo.lastError;
    return status.discord.instances?.[0]?.lastError ?? null;
  }

  // ==================== Feishu Bot Install Helpers ====================

  /** Lazy-load and cache the feishu-auth module (avoid repeated dynamic import overhead). */
  private _feishuAuthModule: any = null;
  private async getFeishuAuthModule() {
    if (!this._feishuAuthModule) {
      this._feishuAuthModule = await import('@larksuite/openclaw-lark-tools/dist/utils/feishu-auth.js');
    }
    return this._feishuAuthModule;
  }

  /**
   * Start the Feishu Device Flow onboarding: init + begin.
   * Returns data needed to render a QR code in the UI.
   * Also caches isLark so that pollFeishuInstall uses the correct domain.
   */
  private _feishuInstallIsLark = false;
  async startFeishuInstallQrcode(isLark: boolean): Promise<{
    url: string;
    deviceCode: string;
    interval: number;
    expireIn: number;
  }> {
    const { FeishuAuth } = await this.getFeishuAuthModule();
    this._feishuInstallIsLark = isLark;
    const auth = new FeishuAuth();
    auth.setDomain(isLark);
    await auth.init();
    const resp = await auth.begin();
    return {
      url: resp.verification_uri_complete,
      deviceCode: resp.device_code,
      interval: resp.interval ?? 5,
      expireIn: resp.expire_in ?? 300,
    };
  }

  /**
   * Poll Feishu Device Flow for the result of a QR code scan.
   * Uses the domain set during startFeishuInstallQrcode to ensure consistency.
   */
  async pollFeishuInstall(deviceCode: string): Promise<{
    done: boolean;
    appId?: string;
    appSecret?: string;
    domain?: string;
    error?: string;
  }> {
    const { FeishuAuth } = await this.getFeishuAuthModule();
    const auth = new FeishuAuth();
    auth.setDomain(this._feishuInstallIsLark);
    const resp = await auth.poll(deviceCode);
    if (resp.error) {
      if (resp.error === 'authorization_pending' || resp.error === 'slow_down') {
        return { done: false };
      }
      return { done: false, error: resp.error_description || resp.error };
    }
    if (resp.client_id && resp.client_secret) {
      const domain = resp.user_info?.tenant_brand === 'lark' ? 'lark' : 'feishu';
      return { done: true, appId: resp.client_id, appSecret: resp.client_secret, domain };
    }
    return { done: false };
  }

  /**
   * Validate existing Feishu app credentials (App ID + App Secret).
   */
  async verifyFeishuCredentials(appId: string, appSecret: string): Promise<{
    success: boolean;
    error?: string;
  }> {
    const { validateAppCredentials } = await this.getFeishuAuthModule();
    try {
      const valid = await validateAppCredentials(appId, appSecret);
      if (valid) {
        return { success: true };
      }
      return { success: false, error: t('feishuVerifyCredentialsFailed') };
    } catch (err: any) {
      return { success: false, error: err?.message || t('feishuVerifyFailed') };
    }
  }

  // ==================== DingTalk Bot Install Helpers ====================

  private static readonly DINGTALK_REGISTRATION_BASE_URL = 'https://oapi.dingtalk.com';
  private static readonly DINGTALK_REGISTRATION_SOURCE = 'DING_DWS_CLAW';

  /**
   * Start the DingTalk Device Flow onboarding: init + begin.
   * Returns data needed to render a QR code in the UI.
   */
  async startDingTalkInstallQrcode(): Promise<{
    url: string;
    deviceCode: string;
    interval: number;
    expireIn: number;
  }> {
    const baseUrl = IMGatewayManager.DINGTALK_REGISTRATION_BASE_URL;
    const source = IMGatewayManager.DINGTALK_REGISTRATION_SOURCE;

    // Step 1: init — obtain nonce
    const initResp = await fetch(`${baseUrl}/app/registration/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source }),
    });
    const initData = await initResp.json() as { errcode: number; errmsg?: string; nonce?: string };
    if (initData.errcode !== 0 || !initData.nonce) {
      throw new Error(initData.errmsg || 'DingTalk registration init failed');
    }

    // Step 2: begin — obtain device_code + QR url
    const beginResp = await fetch(`${baseUrl}/app/registration/begin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce: initData.nonce }),
    });
    const beginData = await beginResp.json() as {
      errcode: number;
      errmsg?: string;
      device_code?: string;
      verification_uri_complete?: string;
      interval?: number;
      expires_in?: number;
    };
    if (beginData.errcode !== 0 || !beginData.device_code || !beginData.verification_uri_complete) {
      throw new Error(beginData.errmsg || 'DingTalk registration begin failed');
    }

    return {
      url: beginData.verification_uri_complete,
      deviceCode: beginData.device_code,
      interval: beginData.interval ?? 5,
      expireIn: beginData.expires_in ?? 600,
    };
  }

  /**
   * Poll DingTalk Device Flow for the result of a QR code scan.
   */
  async pollDingTalkInstall(deviceCode: string): Promise<{
    done: boolean;
    clientId?: string;
    clientSecret?: string;
    error?: string;
  }> {
    const baseUrl = IMGatewayManager.DINGTALK_REGISTRATION_BASE_URL;
    const pollResp = await fetch(`${baseUrl}/app/registration/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: deviceCode }),
    });
    const pollData = await pollResp.json() as {
      errcode: number;
      errmsg?: string;
      status?: string;
      client_id?: string;
      client_secret?: string;
      fail_reason?: string;
    };
    if (pollData.errcode !== 0) {
      return { done: false, error: pollData.errmsg || 'poll error' };
    }
    const status = (pollData.status ?? '').toUpperCase();
    if (status === 'SUCCESS' && pollData.client_id && pollData.client_secret) {
      return { done: true, clientId: pollData.client_id, clientSecret: pollData.client_secret };
    }
    if (status === 'FAIL') {
      return { done: false, error: pollData.fail_reason || 'authorization failed' };
    }
    if (status === 'EXPIRED') {
      return { done: false, error: 'authorization expired' };
    }
    // WAITING or other — keep polling
    return { done: false };
  }

  /**
   * Validate existing DingTalk app credentials (Client ID + Client Secret).
   */
  async verifyDingTalkCredentials(clientId: string, clientSecret: string): Promise<{
    success: boolean;
    error?: string;
  }> {
    try {
      const resp = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appKey: clientId, appSecret: clientSecret }),
      });
      const data = await resp.json() as { accessToken?: string; code?: string; message?: string };
      if (data.accessToken) {
        return { success: true };
      }
      return { success: false, error: data.message || t('dingtalkVerifyCredentialsFailed') };
    } catch (err: unknown) {
      return { success: false, error: (err instanceof Error ? err.message : undefined) || t('dingtalkVerifyFailed') };
    }
  }

  private calculateVerdict(checks: IMConnectivityCheck[]): IMConnectivityVerdict {
    if (checks.some((check) => check.level === 'fail')) {
      return 'fail';
    }
    if (checks.some((check) => check.level === 'warn')) {
      return 'warn';
    }
    return 'pass';
  }

  private async testEmailConnectivity(
    configOverride?: Partial<IMGatewayConfig>,
  ): Promise<IMConnectivityTestResult> {
    const checks: IMConnectivityCheck[] = [];
    const testedAt = Date.now();
    const platform: Platform = 'email';

    const mergedConfig = this.buildMergedConfig(configOverride);
    const emailInstances = mergedConfig.email?.instances || [];
    const inst = emailInstances.find(i => i.enabled) || emailInstances[0];

    if (!inst) {
      checks.push({
        code: 'missing_credentials',
        level: 'fail',
        message: t('imMissingCredentials', { fields: 'email' }),
      });
      return { platform, testedAt, verdict: 'fail', checks };
    }

    if (!inst.email) {
      checks.push({
        code: 'missing_credentials',
        level: 'fail',
        message: t('imMissingCredentials', { fields: 'email address' }),
      });
      return { platform, testedAt, verdict: 'fail', checks };
    }

    if (inst.transport === 'imap') {
      // IMAP mode: test IMAP login via raw TLS socket
      const missing: string[] = [];
      if (!inst.password) missing.push('password');
      if (!inst.imapHost) missing.push('IMAP host');
      if (missing.length > 0) {
        checks.push({
          code: 'missing_credentials',
          level: 'fail',
          message: t('imMissingCredentials', { fields: missing.join(', ') }),
        });
        return { platform, testedAt, verdict: 'fail', checks };
      }

      try {
        const tls = await import('tls');
        await new Promise<void>((resolve, reject) => {
          let greeted = false;
          let settled = false;
          const timer = setTimeout(() => {
            if (!settled) {
              settled = true;
              socket.destroy();
              reject(new Error(t('imAuthProbeTimeout')));
            }
          }, CONNECTIVITY_TIMEOUT_MS);

          const socket = tls.connect({
            host: inst.imapHost,
            port: inst.imapPort || 993,
            rejectUnauthorized: true,
          });

          let buffer = '';
          socket.on('data', (data: Buffer) => {
            buffer += data.toString();
            const lines = buffer.split('\r\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (!line) continue;

              // Wait for server greeting before sending LOGIN
              if (!greeted && line.startsWith('* OK')) {
                greeted = true;
                const tag = 'A001';
                const loginCmd = `${tag} LOGIN "${inst.email}" "${inst.password}"\r\n`;
                socket.write(loginCmd);
                continue;
              }

              // Check LOGIN response
              if (greeted && line.startsWith('A001')) {
                clearTimeout(timer);
                socket.destroy();
                if (!settled) {
                  settled = true;
                  if (line.includes('OK')) {
                    resolve();
                  } else {
                    reject(new Error(line.replace(/^A001\s*/, '')));
                  }
                }
                return;
              }
            }
          });

          socket.on('error', (err: Error) => {
            clearTimeout(timer);
            if (!settled) { settled = true; reject(err); }
          });
          socket.on('close', () => {
            clearTimeout(timer);
            if (!settled) { settled = true; reject(new Error('Connection closed')); }
          });
        });
        checks.push({
          code: 'auth_check',
          level: 'pass',
          message: t('imEmailImapAuthPassed'),
        });
      } catch (error: any) {
        checks.push({
          code: 'auth_check',
          level: 'fail',
          message: `${t('imEmailImapAuthFailed')}: ${error.message}`,
          suggestion: t('imAuthFailedSuggestion'),
        });
        return { platform, testedAt, verdict: 'fail', checks };
      }
    } else if (inst.transport === 'ws') {
      // WS mode: validate API Key by exchanging for IM token
      if (!inst.apiKey) {
        checks.push({
          code: 'missing_credentials',
          level: 'fail',
          message: t('imMissingCredentials', { fields: 'API Key' }),
        });
        return { platform, testedAt, verdict: 'fail', checks };
      }

      try {
        const result = await this.withTimeout(
          fetchJsonWithTimeout<{ success?: boolean; message?: string; code?: number }>(
            'https://claw.163.com/claw-api-gateway/open/v1/mail/auth/im-token',
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${inst.apiKey}`,
              },
              body: JSON.stringify({ uid: inst.email }),
            },
            CONNECTIVITY_TIMEOUT_MS,
          ),
          CONNECTIVITY_TIMEOUT_MS,
          t('imAuthProbeTimeout'),
        );
        if (!result.success) {
          throw new Error(result.message || `API returned code ${result.code}`);
        }
        checks.push({
          code: 'auth_check',
          level: 'pass',
          message: t('imEmailWsAuthPassed'),
        });
      } catch (error: any) {
        checks.push({
          code: 'auth_check',
          level: 'fail',
          message: `${t('imAuthFailed', { error: error.message })}`,
          suggestion: t('imAuthFailedSuggestion'),
        });
        return { platform, testedAt, verdict: 'fail', checks };
      }
    }

    // Gateway running status
    const status = this.getStatus();
    const emailStatus = status.email?.instances?.find(
      (s: { instanceId: string }) => s.instanceId === inst.instanceId,
    );
    const connected = emailStatus?.connected ?? false;

    if (inst.enabled && !connected) {
      checks.push({
        code: 'gateway_running',
        level: 'warn',
        message: t('imChannelEnabledNotConnected'),
        suggestion: t('imChannelEnabledNotConnectedSuggestion'),
      });
    } else {
      checks.push({
        code: 'gateway_running',
        level: connected ? 'pass' : 'info',
        message: connected ? t('imChannelRunning') : t('imChannelNotEnabled'),
      });
    }

    return { platform, testedAt, verdict: this.calculateVerdict(checks), checks };
  }
}
