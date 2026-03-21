/**
 * IM Gateway Manager
 * Unified manager for DingTalk, Feishu, NIM, Xiaomifeng gateways
 * and Telegram, Discord, QQ, WeCom, POPO via OpenClaw
 */

import { EventEmitter } from 'events';
import * as path from 'path';
import { t } from '../i18n';
import { NimGateway } from './nimGateway';
import { XiaomifengGateway } from './xiaomifengGateway';
import { IMChatHandler } from './imChatHandler';
import { IMCoworkHandler } from './imCoworkHandler';
import { IMStore } from './imStore';
import type {
  IMScheduledTaskCreationResult,
  ParsedIMScheduledTaskRequest,
} from './imScheduledTaskHandler';
import { createIMScheduledTaskRequestDetector } from './imScheduledTaskHandler';
import {
  buildDingTalkSessionKeyCandidates,
  buildDingTalkSendParamsFromRoute,
  type OpenClawDeliveryRoute,
  resolveManagedSessionDeliveryRoute,
  resolveOpenClawDeliveryRouteForSessionKeys,
} from './imDeliveryRoute';
import { fetchJsonWithTimeout } from './http';
import {
  IMGatewayConfig,
  IMGatewayStatus,
  IMPlatform,
  IMMessage,
  IMConnectivityCheck,
  IMConnectivityTestResult,
  IMConnectivityVerdict,
} from './types';
import type { Database } from 'sql.js';
import type { CoworkRuntime } from '../libs/agentEngine/types';
import type { CoworkStore } from '../coworkStore';
import { classifyErrorKey } from '../../common/coworkErrorClassify';
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
  private xiaomifengGateway: XiaomifengGateway;
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

  constructor(db: Database, saveDb: () => void, options?: IMGatewayManagerOptions) {
    super();

    this.imStore = new IMStore(db, saveDb);
    this.nimGateway = new NimGateway();
    this.xiaomifengGateway = new XiaomifengGateway();

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

    // Xiaomifeng events
    this.xiaomifengGateway.on('status', () => {
      this.emit('statusChange', this.getStatus());
    });
    this.xiaomifengGateway.on('connected', () => {
      this.emit('statusChange', this.getStatus());
    });
    this.xiaomifengGateway.on('disconnected', () => {
      this.emit('statusChange', this.getStatus());
    });
    this.xiaomifengGateway.on('error', (error) => {
      this.emit('error', { platform: 'xiaomifeng', error });
      this.emit('statusChange', this.getStatus());
    });
    this.xiaomifengGateway.on('message', (message: IMMessage) => {
      this.emit('message', message);
    });

    // QQ runs via OpenClaw; no direct gateway events to forward

    // WeCom runs via OpenClaw; no direct gateway events to forward

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

    if (this.xiaomifengGateway && !this.xiaomifengGateway.isConnected()) {
      console.log('[IMGatewayManager] Reconnecting Xiaomifeng...');
      this.xiaomifengGateway.reconnectIfNeeded();
    }

    // QQ runs via OpenClaw; no direct reconnection needed

    // WeCom runs via OpenClaw; no direct reconnection needed

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
    this.xiaomifengGateway.setMessageCallback(messageHandler);
  }

  /**
   * Persist the notification target for a platform after receiving a message.
   */
  private persistNotificationTarget(platform: IMPlatform): void {
    try {
      let target: any = null;
      if (platform === 'nim') {
        target = this.nimGateway.getNotificationTarget();
      }
      // WeCom runs via OpenClaw; notification target not managed locally
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
  private restoreNotificationTarget(platform: IMPlatform): void {
    try {
      const target = this.imStore.getNotificationTarget(platform);
      if (target == null) return;

      if (platform === 'nim') {
        this.nimGateway.setNotificationTarget(target);
      }
      // WeCom runs via OpenClaw; notification target not managed locally
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


    // Hot-update Xiaomifeng config: restart if credential fields changed.
    // Only perform hot-restart when syncGateway is explicitly true (i.e. user clicked Save).
    if (options?.syncGateway && config.xiaomifeng && this.xiaomifengGateway) {
      const oldXmf = previousConfig.xiaomifeng;
      const newXmf = { ...oldXmf, ...config.xiaomifeng };
      const credentialsChanged =
        newXmf.clientId !== oldXmf.clientId ||
        newXmf.secret !== oldXmf.secret;
      const gatewayShouldBeActive =
        Boolean(newXmf.enabled && newXmf.clientId && newXmf.secret);

      // Check if gateway is connected OR actively reconnecting (has pending timer)
      const isActiveOrReconnecting = this.xiaomifengGateway.isRunning() || this.xiaomifengGateway.isReconnecting();
      if (credentialsChanged && gatewayShouldBeActive) {
        if (isActiveOrReconnecting) {
          console.log('[IMGatewayManager] Xiaomifeng credentials changed, restarting gateway...');
          this.restartGateway('xiaomifeng').catch((err) => {
            console.error('[IMGatewayManager] Failed to restart Xiaomifeng after config change:', err.message);
          });
        } else {
          console.log('[IMGatewayManager] Xiaomifeng credentials changed, starting gateway...');
          this.startGateway('xiaomifeng').catch((err) => {
            console.error('[IMGatewayManager] Failed to start Xiaomifeng after config change:', err.message);
          });
        }
      }
    }

    // QQ runs via OpenClaw; config changes are synced via OpenClawConfigSync

    // WeCom runs via OpenClaw; config changes are synced via OpenClawConfigSync

    // POPO runs via OpenClaw; config changes are synced via OpenClawConfigSync

  }

  private async restartGateway(platform: IMPlatform): Promise<void> {
    console.log(`[IMGatewayManager] Restarting ${platform} gateway...`);
    await this.stopGateway(platform);
    await this.startGateway(platform);
    console.log(`[IMGatewayManager] ${platform} gateway restarted successfully`);
  }

  // ==================== Status ====================
  getStatus(): IMGatewayStatus {
    const config = this.getConfig();
    // Telegram runs via OpenClaw; reflect enabled+configured state as connected
    const tgConfig = config.telegram;
    const telegramStatus = {
      connected: Boolean(tgConfig?.enabled && tgConfig.botToken),
      startedAt: null as number | null,
      lastError: null as string | null,
      botUsername: null as string | null,
      lastInboundAt: null as number | null,
      lastOutboundAt: null as number | null,
    };
    // Discord runs via OpenClaw; reflect enabled+configured state as connected
    const dcConfig = config.discord;
    const discordStatus = {
      connected: Boolean(dcConfig?.enabled && dcConfig.botToken),
      starting: false,
      startedAt: null as number | null,
      lastError: null as string | null,
      botUsername: null as string | null,
      lastInboundAt: null as number | null,
      lastOutboundAt: null as number | null,
    };
    // DingTalk runs via OpenClaw; reflect enabled+configured state as connected
    const dtConfig = config.dingtalk;
    const dingtalkStatus = {
      connected: Boolean(dtConfig?.enabled && dtConfig.clientId && dtConfig.clientSecret),
      startedAt: null as number | null,
      lastError: null as string | null,
      lastInboundAt: null as number | null,
      lastOutboundAt: null as number | null,
    };
    // Feishu runs via OpenClaw; reflect enabled+configured state as connected
    const fsConfig = config.feishu;
    const feishuStatus = {
      connected: Boolean(fsConfig?.enabled && fsConfig.appId && fsConfig.appSecret),
      startedAt: null as string | null,
      botOpenId: null as string | null,
      error: null as string | null,
      lastInboundAt: null as number | null,
      lastOutboundAt: null as number | null,
    };
    return {
      dingtalk: dingtalkStatus,
      feishu: feishuStatus,
      telegram: telegramStatus,
      qq: {
        connected: Boolean(config.qq?.enabled && config.qq.appId && config.qq.appSecret),
        startedAt: null as number | null,
        lastError: null as string | null,
        lastInboundAt: null as number | null,
        lastOutboundAt: null as number | null,
      },
      discord: discordStatus,
      nim: (() => {
        const nmConfig = config.nim;
        return {
          connected: Boolean(nmConfig?.enabled && nmConfig.appKey && nmConfig.account && nmConfig.token),
          startedAt: null as number | null,
          lastError: null as string | null,
          botAccount: nmConfig?.account || null,
          lastInboundAt: null as number | null,
          lastOutboundAt: null as number | null,
        };
      })(),
      xiaomifeng: this.xiaomifengGateway.getStatus(),
      wecom: {
        connected: Boolean(config.wecom?.enabled && config.wecom.botId && config.wecom.secret),
        startedAt: null as number | null,
        lastError: null as string | null,
        botId: config.wecom?.botId || null,
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
    };
  }

  async testGateway(
    platform: IMPlatform,
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

    // POPO always uses OpenClaw mode
    if (platform === 'popo') {
      return this.testPopoOpenClawConnectivity(configOverride);
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
        message: `缺少必要配置项: ${missingCredentials.join(', ')}`,
        suggestion: '请补全配置后重新测试连通性。',
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
        '鉴权探测超时'
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
        message: `鉴权失败: ${error.message}`,
        suggestion: '请检查 ID/Secret/Token 是否正确，且机器人权限已开通。',
      });
      return {
        platform,
        testedAt,
        verdict: 'fail',
        checks,
      };
    }

    const status = this.getStatus();
    const enabled = Boolean(config[platform]?.enabled);
    const connected = this.isConnected(platform);

    if (enabled && !connected) {
      addCheck({
        code: 'gateway_running',
        level: 'warn',
        message: 'IM 渠道已启用但当前未连接。',
        suggestion: '请检查网络、机器人配置和平台侧事件开关。',
      });
    } else {
      addCheck({
        code: 'gateway_running',
        level: connected ? 'pass' : 'info',
        message: connected ? 'IM 渠道已启用且运行正常。' : 'IM 渠道当前未启用。',
        suggestion: connected ? undefined : '请点击对应 IM 渠道胶囊按钮启用该渠道。',
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
          message: '已连接超过 2 分钟，但尚未收到任何入站消息。',
          suggestion: '请确认机器人已在目标会话中，或按平台规则 @机器人 触发消息。',
        });
      } else {
        addCheck({
          code: 'inbound_activity',
          level: 'pass',
          message: '已检测到入站消息。',
        });
      }
    } else if (connected) {
      addCheck({
        code: 'inbound_activity',
        level: 'info',
        message: '网关刚启动，入站活动检查将在 2 分钟后更准确。',
      });
    }

    if (connected && lastInboundAt) {
      if (!lastOutboundAt) {
        addCheck({
          code: 'outbound_activity',
          level: 'warn',
          message: '已收到消息，但尚未观察到成功回发。',
          suggestion: '请检查消息发送权限、机器人可见范围和会话回包权限。',
        });
      } else {
        addCheck({
          code: 'outbound_activity',
          level: 'pass',
          message: '已检测到成功回发消息。',
        });
      }
    } else if (connected) {
      addCheck({
        code: 'outbound_activity',
        level: 'info',
        message: '尚未收到可用于评估回发能力的入站消息。',
      });
    }

    const lastError = this.getLastError(platform, status);
    if (lastError) {
      addCheck({
        code: 'platform_last_error',
        level: connected ? 'warn' : 'fail',
        message: `最近错误: ${lastError}`,
        suggestion: connected
          ? '当前已连接，但建议修复该错误避免后续中断。'
          : '该错误可能阻断对话，请优先修复后重试。',
      });
    }

    if (platform === 'qq') {
      addCheck({
        code: 'qq_guild_mention_hint',
        level: 'info',
        message: 'QQ 通过 OpenClaw 运行时运行，Bot 将在 OpenClaw Gateway 启动后自动连接。',
        suggestion: '频道中需 @机器人 触发对话，也支持私信和群聊。',
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
  async startGateway(platform: IMPlatform): Promise<void> {
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
    } else if (platform === 'xiaomifeng') {
      await this.xiaomifengGateway.start(config.xiaomifeng);
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

  async stopGateway(platform: IMPlatform): Promise<void> {
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
    } else if (platform === 'xiaomifeng') {
      await this.xiaomifengGateway.stop();
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
   * OpenClaw platforms (dingtalk/feishu/telegram/discord/qq/wecom/popo/nim) are batched
   * so that `syncOpenClawConfig` + `ensureOpenClawGatewayConnected` are called
   * only **once** regardless of how many OpenClaw platforms are enabled.
   * This avoids N serial gateway restarts which cause message loss, Telegram
   * `getUpdates` conflicts, and rate-limit issues.
   */
  async startAllEnabled(): Promise<void> {
    const config = this.getConfig();

    // Ensure chat handler is ready (called once instead of per-platform)
    this.updateChatHandler();

    // --- Non-OpenClaw platforms: start independently ---

    if (config.xiaomifeng?.enabled && config.xiaomifeng?.clientId && config.xiaomifeng?.secret) {
      try {
        await this.startGateway('xiaomifeng');
      } catch (error: any) {
        console.error(`[IMGatewayManager] Failed to start Xiaomifeng: ${error.message}`);
      }
    }

    // --- OpenClaw platforms: collect and batch into a single sync ---

    const openClawPlatformsToStart: IMPlatform[] = [];

    if (config.dingtalk.enabled && config.dingtalk.clientId && config.dingtalk.clientSecret) {
      openClawPlatformsToStart.push('dingtalk');
    }
    if (config.feishu.enabled && config.feishu.appId && config.feishu.appSecret) {
      openClawPlatformsToStart.push('feishu');
    }
    if (config.telegram?.enabled && config.telegram.botToken) {
      openClawPlatformsToStart.push('telegram');
    }
    if (config.discord.enabled && config.discord.botToken) {
      openClawPlatformsToStart.push('discord');
    }
    if (config.qq?.enabled && config.qq?.appId && config.qq?.appSecret) {
      openClawPlatformsToStart.push('qq');
    }
    if (config.wecom?.enabled && config.wecom?.botId && config.wecom?.secret) {
      openClawPlatformsToStart.push('wecom');
    }
    if (config.popo?.enabled && config.popo?.appKey && config.popo?.appSecret && config.popo?.aesKey && (config.popo.connectionMode === 'websocket' || config.popo.token)) {
      openClawPlatformsToStart.push('popo');
    }
    if (config.nim?.enabled && config.nim.appKey && config.nim.account && config.nim.token) {
      openClawPlatformsToStart.push('nim');
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
    await Promise.all([
      this.xiaomifengGateway.stop(),
    ]);
  }

  isAnyConnected(): boolean {
    return this.xiaomifengGateway.isConnected();
  }

  isConnected(platform: IMPlatform): boolean {
    if (platform === 'dingtalk') {
      // DingTalk runs via OpenClaw; consider it connected when enabled and configured
      const config = this.getConfig();
      return Boolean(config.dingtalk?.enabled && config.dingtalk.clientId && config.dingtalk.clientSecret);
    }
    if (platform === 'telegram') {
      // Telegram runs via OpenClaw; consider it connected when enabled and configured
      const config = this.getConfig();
      return Boolean(config.telegram?.enabled && config.telegram.botToken);
    }
    if (platform === 'discord') {
      // Discord runs via OpenClaw; consider it connected when enabled and configured
      const config = this.getConfig();
      return Boolean(config.discord?.enabled && config.discord.botToken);
    }
    if (platform === 'nim') {
      // NIM runs via OpenClaw; consider it connected when enabled and configured
      const config = this.getConfig();
      return Boolean(config.nim?.enabled && config.nim.appKey && config.nim.account && config.nim.token);
    }
    if (platform === 'xiaomifeng') {
      return this.xiaomifengGateway.isConnected();
    }
    if (platform === 'qq') {
      // QQ runs via OpenClaw; consider it connected when enabled and configured
      const config = this.getConfig();
      return Boolean(config.qq?.enabled && config.qq.appId && config.qq.appSecret);
    }
    if (platform === 'wecom') {
      // WeCom runs via OpenClaw; consider it connected when enabled and configured
      const config = this.getConfig();
      return Boolean(config.wecom?.enabled && config.wecom.botId && config.wecom.secret);
    }
    if (platform === 'popo') {
      // POPO runs via OpenClaw; consider it connected when enabled and configured
      const config = this.getConfig();
      return Boolean(config.popo?.enabled && config.popo.appKey && config.popo.appSecret && config.popo.aesKey && (config.popo.connectionMode === 'websocket' || config.popo.token));
    }
    return false;
  }

  async sendNotification(platform: IMPlatform, text: string): Promise<boolean> {
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
      } else if (platform === 'popo') {
        // POPO runs via OpenClaw; notifications are handled by the moltbot-popo plugin
        console.log('[IMGatewayManager] POPO notification via OpenClaw not yet supported');
      } else if (platform === 'xiaomifeng') {
        await this.xiaomifengGateway.sendNotification(text);
      }
      return true;
    } catch (error: any) {
      console.error(`[IMGatewayManager] Failed to send notification via ${platform}:`, error.message);
      return false;
    }
  }

  async sendNotificationWithMedia(platform: IMPlatform, text: string): Promise<boolean> {
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
      } else if (platform === 'popo') {
        // POPO runs via OpenClaw; notifications are handled by the moltbot-popo plugin
        console.log('[IMGatewayManager] POPO notification with media via OpenClaw not yet supported');
      } else if (platform === 'xiaomifeng') {
        await this.xiaomifengGateway.sendNotificationWithMedia(text);
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
    const platform: IMPlatform = 'telegram';

    // Resolve the Telegram config (now TelegramOpenClawConfig type)
    const mergedConfig = this.buildMergedConfig(configOverride);
    const tgConfig = mergedConfig.telegram;
    const botToken = tgConfig?.botToken || '';

    // Check 1: Bot token present
    if (!botToken) {
      checks.push({
        code: 'missing_credentials',
        level: 'fail',
        message: '缺少必要配置项: botToken',
        suggestion: '请补全 Bot Token 后重新测试连通性。',
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
        '鉴权探测超时'
      );
      if (response?.ok && response.result?.username) {
        checks.push({
          code: 'auth_check',
          level: 'pass',
          message: `Telegram Bot 鉴权通过: @${response.result.username}`,
        });
      } else {
        checks.push({
          code: 'auth_check',
          level: 'fail',
          message: `Telegram Bot 鉴权失败: ${response?.description || '未知错误'}`,
          suggestion: '请检查 Bot Token 是否正确。',
        });
        return { platform, testedAt, verdict: 'fail', checks };
      }
    } catch (error: any) {
      checks.push({
        code: 'auth_check',
        level: 'fail',
        message: `Telegram Bot 鉴权失败: ${error.message}`,
        suggestion: '请检查 Bot Token 是否正确，且网络通畅。',
      });
      return { platform, testedAt, verdict: 'fail', checks };
    }

    // Check 3: OpenClaw Gateway running
    checks.push({
      code: 'gateway_running',
      level: 'info',
      message: 'Telegram 通过 OpenClaw 运行时运行，Bot 将在 OpenClaw Gateway 启动后自动连接。',
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
    const platform: IMPlatform = 'discord';

    const mergedConfig = this.buildMergedConfig(configOverride);
    const dcConfig = mergedConfig.discord;
    const botToken = dcConfig?.botToken || '';

    // Check 1: Bot token present
    if (!botToken) {
      checks.push({
        code: 'missing_credentials',
        level: 'fail',
        message: '缺少必要配置项: botToken',
        suggestion: '请补全 Bot Token 后重新测试连通性。',
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
        '鉴权探测超时'
      );
      const username = response?.username
        ? `${response.username}${response.discriminator && response.discriminator !== '0' ? `#${response.discriminator}` : ''}`
        : 'unknown';
      checks.push({
        code: 'auth_check',
        level: 'pass',
        message: `Discord Bot 鉴权通过（Bot: ${username}）。`,
      });
    } catch (error: any) {
      checks.push({
        code: 'auth_check',
        level: 'fail',
        message: `Discord Bot 鉴权失败: ${error.message}`,
        suggestion: '请检查 Bot Token 是否正确，且网络通畅。',
      });
      return { platform, testedAt, verdict: 'fail', checks };
    }

    // Check 3: OpenClaw Gateway running info
    checks.push({
      code: 'gateway_running',
      level: 'info',
      message: 'Discord 通过 OpenClaw 运行时运行，Bot 将在 OpenClaw Gateway 启动后自动连接。',
    });

    // Check 4: Group mention hint
    checks.push({
      code: 'discord_group_requires_mention',
      level: 'info',
      message: 'Discord 群聊中仅响应 @机器人的消息。',
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
    const platform: IMPlatform = 'feishu';

    const mergedConfig = this.buildMergedConfig(configOverride);
    const fsConfig = mergedConfig.feishu;

    // Check 1: Credentials present
    if (!fsConfig?.appId || !fsConfig?.appSecret) {
      const missing: string[] = [];
      if (!fsConfig?.appId) missing.push('appId');
      if (!fsConfig?.appSecret) missing.push('appSecret');
      checks.push({
        code: 'missing_credentials',
        level: 'fail',
        message: `缺少必要配置项: ${missing.join(', ')}`,
        suggestion: '请补全 App ID 和 App Secret 后重新测试连通性。',
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
        message: `飞书鉴权通过（Bot: ${botName}）`,
      });
    } catch (error: any) {
      checks.push({
        code: 'auth_check',
        level: 'fail',
        message: `飞书鉴权失败: ${error.message}`,
        suggestion: '请检查 App ID 和 App Secret 是否正确。',
      });
      return { platform, testedAt, verdict: 'fail', checks };
    }

    // Check 3: OpenClaw Gateway running info
    checks.push({
      code: 'gateway_running',
      level: 'info',
      message: '飞书通过 OpenClaw 运行时运行，Bot 将在 OpenClaw Gateway 启动后自动连接。',
    });

    // Check 4: Group mention hint
    checks.push({
      code: 'feishu_group_requires_mention',
      level: 'info',
      message: '飞书群聊中仅响应 @机器人的消息。',
      suggestion: '请在群聊中使用 @机器人 + 内容触发对话。',
    });

    // Check 5: Event subscription hint
    checks.push({
      code: 'feishu_event_subscription_required',
      level: 'info',
      message: '飞书需要开启消息事件订阅（im.message.receive_v1）才能收消息。',
      suggestion: '请在飞书开发者后台确认事件订阅、权限和发布状态。',
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
    const platform: IMPlatform = 'dingtalk';

    const mergedConfig = this.buildMergedConfig(configOverride);
    const dtConfig = mergedConfig.dingtalk;

    // Check 1: Credentials present
    if (!dtConfig?.clientId || !dtConfig?.clientSecret) {
      const missing: string[] = [];
      if (!dtConfig?.clientId) missing.push('clientId');
      if (!dtConfig?.clientSecret) missing.push('clientSecret');
      checks.push({
        code: 'missing_credentials',
        level: 'fail',
        message: `缺少必要配置项: ${missing.join(', ')}`,
        suggestion: '请补全 Client ID 和 Client Secret 后重新测试连通性。',
      });
      return { platform, testedAt, verdict: 'fail', checks };
    }

    // Check 2: Auth probe via DingTalk API
    try {
      const tokenUrl = `https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(dtConfig.clientId)}&appsecret=${encodeURIComponent(dtConfig.clientSecret)}`;
      const resp = await this.withTimeout(
        fetchJsonWithTimeout<{ errcode?: number; errmsg?: string; access_token?: string }>(tokenUrl, {}, CONNECTIVITY_TIMEOUT_MS),
        CONNECTIVITY_TIMEOUT_MS,
        '鉴权探测超时'
      );
      if (resp.errcode && resp.errcode !== 0) {
        throw new Error(resp.errmsg || `errcode ${resp.errcode}`);
      }
      checks.push({
        code: 'auth_check',
        level: 'pass',
        message: '钉钉鉴权通过。',
      });
    } catch (error: any) {
      checks.push({
        code: 'auth_check',
        level: 'fail',
        message: `钉钉鉴权失败: ${error.message}`,
        suggestion: '请检查 Client ID 和 Client Secret 是否正确，且机器人权限已开通。',
      });
      return { platform, testedAt, verdict: 'fail', checks };
    }

    // Check 3: OpenClaw Gateway running info
    checks.push({
      code: 'gateway_running',
      level: 'info',
      message: '钉钉通过 OpenClaw 运行时运行，Bot 将在 OpenClaw Gateway 启动后自动连接。',
    });

    // Check 4: Bot membership hint
    checks.push({
      code: 'dingtalk_bot_membership_hint',
      level: 'info',
      message: '钉钉机器人需被加入目标会话并具备发言权限。',
      suggestion: '请确认机器人在目标会话中，且企业权限配置允许收发消息。',
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
    const platform: IMPlatform = 'wecom';

    const mergedConfig = this.buildMergedConfig(configOverride);
    const wcConfig = mergedConfig.wecom;

    // Check 1: Credentials present
    if (!wcConfig?.botId || !wcConfig?.secret) {
      const missing: string[] = [];
      if (!wcConfig?.botId) missing.push('botId');
      if (!wcConfig?.secret) missing.push('secret');
      checks.push({
        code: 'missing_credentials',
        level: 'fail',
        message: `缺少必要配置项: ${missing.join(', ')}`,
        suggestion: '请补全 Bot ID 和 Secret 后重新测试连通性。',
      });
      return { platform, testedAt, verdict: 'fail', checks };
    }

    // Check 2: Config completeness passes
    checks.push({
      code: 'auth_check',
      level: 'pass',
      message: `企业微信配置已就绪（Bot ID: ${wcConfig.botId}）。`,
    });

    // Check 3: OpenClaw Gateway running info
    checks.push({
      code: 'gateway_running',
      level: 'info',
      message: '企业微信通过 OpenClaw 运行时运行，Bot 将在 OpenClaw Gateway 启动后自动连接。',
    });

    const verdict: IMConnectivityVerdict = checks.some(c => c.level === 'fail')
      ? 'fail'
      : checks.some(c => c.level === 'warn')
        ? 'warn'
        : 'pass';

    return { platform, testedAt, verdict, checks };
  }

  private async testNimOpenClawConnectivity(
    configOverride?: Partial<IMGatewayConfig>
  ): Promise<IMConnectivityTestResult> {
    const checks: IMConnectivityCheck[] = [];
    const testedAt = Date.now();
    const platform: IMPlatform = 'nim';

    const mergedConfig = this.buildMergedConfig(configOverride);
    const nimConfig = mergedConfig.nim;

    if (!nimConfig?.appKey || !nimConfig?.account || !nimConfig?.token) {
      const missing: string[] = [];
      if (!nimConfig?.appKey) missing.push('appKey');
      if (!nimConfig?.account) missing.push('account');
      if (!nimConfig?.token) missing.push('token');
      checks.push({
        code: 'missing_credentials',
        level: 'fail',
        message: `缺少必要配置项: ${missing.join(', ')}`,
        suggestion: '请补全 AppKey、Account 和 Token 后重新测试连通性。',
      });
      return { platform, testedAt, verdict: 'fail', checks };
    }

    checks.push({
      code: 'auth_check',
      level: 'pass',
      message: `云信配置已就绪（Account: ${nimConfig.account}）。`,
    });

    checks.push({
      code: 'gateway_running',
      level: 'info',
      message: '云信通过 OpenClaw 运行时运行，Bot 将在 OpenClaw Gateway 启动后自动连接。',
    });

    checks.push({
      code: 'nim_p2p_only_hint',
      level: 'info',
      message: '云信 IM 当前仅支持 P2P（私聊）消息。',
      suggestion: '请通过私聊方式向机器人账号发送消息触发对话。',
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
    const platform: IMPlatform = 'popo';

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
        message: `缺少必要配置项: ${missing.join(', ')}`,
        suggestion: isWebhookMode
          ? '请补全 appKey、appSecret、token 和 aesKey 后重新测试连通性。'
          : '请补全 appKey、appSecret 和 aesKey 后重新测试连通性。',
      });
      return { platform, testedAt, verdict: 'fail', checks };
    }

    // Check 2: Config completeness passes
    checks.push({
      code: 'auth_check',
      level: 'pass',
      message: 'POPO 配置已就绪。',
    });

    // Check 3: OpenClaw Gateway running info
    checks.push({
      code: 'gateway_running',
      level: 'info',
      message: 'POPO 通过 OpenClaw 运行时运行，Bot 将在 OpenClaw Gateway 启动后自动连接。',
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
      dingtalk: { ...current.dingtalk, ...(configOverride.dingtalk || {}) },
      feishu: { ...current.feishu, ...(configOverride.feishu || {}) },
      qq: { ...current.qq, ...(configOverride.qq || {}) },
      telegram: { ...current.telegram, ...(configOverride.telegram || {}) },
      discord: { ...current.discord, ...(configOverride.discord || {}) },
      nim: { ...current.nim, ...(configOverride.nim || {}) },
      xiaomifeng: { ...current.xiaomifeng, ...(configOverride.xiaomifeng || {}) },
      wecom: { ...current.wecom, ...(configOverride.wecom || {}) },
      popo: { ...current.popo, ...(configOverride.popo || {}) },
      settings: { ...current.settings, ...(configOverride.settings || {}) },
    };
  }

  private getMissingCredentials(platform: IMPlatform, config: IMGatewayConfig): string[] {
    if (platform === 'dingtalk') {
      const fields: string[] = [];
      if (!config.dingtalk.clientId) fields.push('clientId');
      if (!config.dingtalk.clientSecret) fields.push('clientSecret');
      return fields;
    }
    if (platform === 'feishu') {
      const fields: string[] = [];
      if (!config.feishu.appId) fields.push('appId');
      if (!config.feishu.appSecret) fields.push('appSecret');
      return fields;
    }
    if (platform === 'telegram') {
      return config.telegram.botToken ? [] : ['botToken'];
    }
    if (platform === 'nim') {
      const fields: string[] = [];
      if (!config.nim.appKey) fields.push('appKey');
      if (!config.nim.account) fields.push('account');
      if (!config.nim.token) fields.push('token');
      return fields;
    }
    if (platform === 'xiaomifeng') {
      const fields: string[] = [];
      if (!config.xiaomifeng?.clientId) fields.push('clientId');
      if (!config.xiaomifeng?.secret) fields.push('secret');
      return fields;
    }
    if (platform === 'qq') {
      const fields: string[] = [];
      if (!config.qq?.appId) fields.push('appId');
      if (!config.qq?.appSecret) fields.push('appSecret');
      return fields;
    }
    if (platform === 'wecom') {
      const fields: string[] = [];
      if (!config.wecom?.botId) fields.push('botId');
      if (!config.wecom?.secret) fields.push('secret');
      return fields;
    }
    if (platform === 'popo') {
      const fields: string[] = [];
      if (!config.popo?.appKey) fields.push('appKey');
      if (!config.popo?.appSecret) fields.push('appSecret');
      if ((config.popo?.connectionMode ?? 'websocket') === 'webhook' && !config.popo?.token) fields.push('token');
      if (!config.popo?.aesKey) fields.push('aesKey');
      return fields;
    }
    return config.discord.botToken ? [] : ['botToken'];
  }

  private async runAuthProbe(platform: IMPlatform, config: IMGatewayConfig): Promise<string> {
    if (platform === 'dingtalk') {
      const tokenUrl = `https://oapi.dingtalk.com/gettoken?appkey=${encodeURIComponent(config.dingtalk.clientId)}&appsecret=${encodeURIComponent(config.dingtalk.clientSecret)}`;
      const resp = await fetchJsonWithTimeout<{ errcode?: number; errmsg?: string }>(tokenUrl, {}, CONNECTIVITY_TIMEOUT_MS);
      if (resp.errcode && resp.errcode !== 0) {
        throw new Error(resp.errmsg || `errcode ${resp.errcode}`);
      }
      return '钉钉鉴权通过。';
    }

    if (platform === 'feishu') {
      const Lark = await import('@larksuiteoapi/node-sdk');
      const domain = this.resolveFeishuDomain(config.feishu.domain, Lark);
      const client = new Lark.Client({
        appId: config.feishu.appId,
        appSecret: config.feishu.appSecret,
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
      return `飞书鉴权通过（Bot: ${botName}）。`;
    }

    if (platform === 'nim') {
      const { appKey, account, token } = config.nim;
      if (!appKey || !account || !token) {
        throw new Error('配置不完整');
      }
      return `云信配置已就绪（Account: ${account}）。`;
    }

    if (platform === 'xiaomifeng') {
      // 小蜜蜂使用网易云信 NIM SDK，鉴权是通过 SDK 登录验证的
      // 这里我们只做配置完整性检查，实际登录验证在 start 时进行
      const { clientId, secret } = config.xiaomifeng;
      if (!clientId || !secret) {
        throw new Error('配置不完整');
      }
      return `小蜜蜂配置已就绪（Client ID: ${clientId}）。`;
    }

    if (platform === 'wecom') {
      const { botId, secret } = config.wecom;
      if (!botId || !secret) {
        throw new Error('配置不完整');
      }
      return `企业微信配置已就绪（Bot ID: ${botId}），通过 OpenClaw 运行。`;

    }

    if (platform === 'popo') {
      const { appKey, appSecret, token, aesKey, connectionMode } = config.popo;
      const isWebhook = (connectionMode ?? 'websocket') === 'webhook';
      if (!appKey || !appSecret || !aesKey || (isWebhook && !token)) {
        throw new Error('配置不完整');
      }
      return 'POPO 配置已就绪，通过 OpenClaw 运行。';
    }

    if (platform === 'qq') {
      const { appId, appSecret } = config.qq;
      if (!appId || !appSecret) {
        throw new Error('配置不完整');
      }
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
        throw new Error(tokenResponse.message || '获取 AccessToken 失败');
      }
      return `QQ 鉴权通过（AccessToken 已获取）。`;
    }

    return '未知平台。';
  }


  async sendConversationReply(platform: IMPlatform, conversationId: string, text: string): Promise<boolean> {
    try {
      switch (platform) {
        case 'dingtalk': {
          const target = await this.resolveDingTalkConversationReplyTarget(conversationId)
            ?? this.parseDingTalkConversationTarget(conversationId);
          if (!target) {
            // Fallback: try to extract userId directly from conversationId (raw peerId).
            const fallbackUserId = conversationId.trim();
            if (!fallbackUserId) {
              console.warn(`[IMGatewayManager] Cannot resolve DingTalk target from conversationId: ${conversationId}`);
              return false;
            }
            return this.sendDingTalkDirectHttp(fallbackUserId, text);
          }
          // Extract userId from target string like "user:0146552636218419"
          const userId = target.target.startsWith('user:')
            ? target.target.slice(5)
            : target.target;
          return this.sendDingTalkDirectHttp(userId, text);
        }
        case 'nim':
          console.log('[IMGatewayManager] NIM conversation reply via OpenClaw not yet supported');
          return false;
        case 'xiaomifeng':
          await this.xiaomifengGateway.sendConversationNotification(conversationId, text);
          return true;
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
    const dtConfig = this.imStore.getDingTalkOpenClawConfig();
    if (!dtConfig.clientId || !dtConfig.clientSecret) {
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
    platform: IMPlatform,
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
      dingtalkSessionKeys: this.collectSessionKeysByChannel(sessions, 'dingtalk-connector'),
      resolved: resolveOpenClawDeliveryRouteForSessionKeys(candidateSessionKeys, sessions)
        ?? resolveManagedSessionDeliveryRoute(normalizedCoworkSessionId, sessions),
    };
  }

  private cacheConversationReplyRoute(
    platform: IMPlatform,
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
          channel: 'dingtalk-connector',
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

  private getStartedAtMs(platform: IMPlatform, status: IMGatewayStatus): number | null {
    if (platform === 'feishu') {
      return status.feishu.startedAt ? Date.parse(status.feishu.startedAt) : null;
    }
    if (platform === 'dingtalk') return status.dingtalk.startedAt;
    if (platform === 'telegram') return status.telegram.startedAt;
    if (platform === 'nim') return status.nim.startedAt;
    if (platform === 'xiaomifeng') return status.xiaomifeng.startedAt;
    if (platform === 'qq') return status.qq.startedAt;
    if (platform === 'wecom') return status.wecom.startedAt;
    if (platform === 'popo') return status.popo.startedAt;
    return status.discord.startedAt;
  }

  private getLastInboundAt(platform: IMPlatform, status: IMGatewayStatus): number | null {
    if (platform === 'dingtalk') return status.dingtalk.lastInboundAt;
    if (platform === 'feishu') return status.feishu.lastInboundAt;
    if (platform === 'telegram') return status.telegram.lastInboundAt;
    if (platform === 'nim') return status.nim.lastInboundAt;
    if (platform === 'xiaomifeng') return status.xiaomifeng.lastInboundAt;
    if (platform === 'qq') return status.qq.lastInboundAt;
    if (platform === 'wecom') return status.wecom.lastInboundAt;
    if (platform === 'popo') return status.popo.lastInboundAt;
    return status.discord.lastInboundAt;
  }

  private getLastOutboundAt(platform: IMPlatform, status: IMGatewayStatus): number | null {
    if (platform === 'dingtalk') return status.dingtalk.lastOutboundAt;
    if (platform === 'feishu') return status.feishu.lastOutboundAt;
    if (platform === 'telegram') return status.telegram.lastOutboundAt;
    if (platform === 'nim') return status.nim.lastOutboundAt;
    if (platform === 'xiaomifeng') return status.xiaomifeng.lastOutboundAt;
    if (platform === 'qq') return status.qq.lastOutboundAt;
    if (platform === 'wecom') return status.wecom.lastOutboundAt;
    if (platform === 'popo') return status.popo.lastOutboundAt;
    return status.discord.lastOutboundAt;
  }

  private getLastError(platform: IMPlatform, status: IMGatewayStatus): string | null {
    if (platform === 'dingtalk') return status.dingtalk.lastError;
    if (platform === 'feishu') return status.feishu.error;
    if (platform === 'telegram') return status.telegram.lastError;
    if (platform === 'nim') return status.nim.lastError;
    if (platform === 'xiaomifeng') return status.xiaomifeng.lastError;
    if (platform === 'qq') return status.qq.lastError;
    if (platform === 'wecom') return status.wecom.lastError;
    if (platform === 'popo') return status.popo.lastError;
    return status.discord.lastError;
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

  private calculateVerdict(checks: IMConnectivityCheck[]): IMConnectivityVerdict {
    if (checks.some((check) => check.level === 'fail')) {
      return 'fail';
    }
    if (checks.some((check) => check.level === 'warn')) {
      return 'warn';
    }
    return 'pass';
  }
}
