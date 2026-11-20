/**
 * Layered IM Channel Registry (`Driver -> Adapter -> ChannelManager -> DSH Harness Bridge`).
 *
 * Strictly scoped to the 7 retained mainstream platforms:
 * Feishu, Weixin, DingTalk, WeCom, QQ, Telegram, Discord.
 */

import { randomUUID } from 'node:crypto';
import { DingTalkChannelDriver } from './drivers/dingtalk.mjs';
import { DiscordChannelDriver } from './drivers/discord.mjs';
import { FeishuChannelDriver } from './drivers/feishu.mjs';
import { QQChannelDriver } from './drivers/qq.mjs';
import { TelegramChannelDriver } from './drivers/telegram.mjs';
import { WeComChannelDriver } from './drivers/wecom.mjs';
import { WeixinChannelDriver } from './drivers/weixin.mjs';

export const RETAINED_IM_PLATFORMS = Object.freeze([
  'feishu',
  'weixin',
  'dingtalk',
  'wecom',
  'qq',
  'telegram',
  'discord',
]);

const DRIVER_FACTORIES = Object.freeze({
  feishu: (opts) => new FeishuChannelDriver(opts),
  weixin: (opts) => new WeixinChannelDriver(opts),
  dingtalk: (opts) => new DingTalkChannelDriver(opts),
  wecom: (opts) => new WeComChannelDriver(opts),
  qq: (opts) => new QQChannelDriver(opts),
  telegram: (opts) => new TelegramChannelDriver(opts),
  discord: (opts) => new DiscordChannelDriver(opts),
});

export function instanceKey(platform, instanceId) {
  return `${platform}:${instanceId}`;
}

export class ChannelManager {
  /**
   * @param {{
   *   ctx: unknown,
   *   bridgeNotify?: (payload: Record<string, unknown>) => Promise<void>,
   * }} options
   */
  constructor(options) {
    this.ctx = options.ctx;
    this.bridgeNotify = options.bridgeNotify;
    /** @type {Map<string, { driver: import('./drivers/base-driver.mjs').BaseChannelDriver, configHash: string, agentId: string, cwd?: string }>} */
    this.instances = new Map();
    /** @type {Map<string, string>} mapping `${platform}:${instanceId}:${chatId}` -> dshSessionId */
    this.chatSessions = new Map();
  }

  listStatus() {
    return [...this.instances.values()].map((entry) => ({
      ...entry.driver.getStatus(),
      agentId: entry.agentId,
    }));
  }

  /**
   * Reconcile running IM channel instances against the desired list from
   * LobsterAI's SQLite `im_config`.
   *
   * @param {Array<{ platform: string, instanceId: string, enabled?: boolean, agentId?: string, cwd?: string, config: Record<string, unknown> }>} desiredList
   */
  async syncInstances(desiredList) {
    const desiredKeys = new Set();
    const started = [];
    const errors = [];

    for (const item of Array.isArray(desiredList) ? desiredList : []) {
      if (!item || typeof item !== 'object' || item.enabled === false) continue;
      const platform = String(item.platform || '').trim().toLowerCase();
      const instanceId = String(item.instanceId || 'default').trim();
      const factory = DRIVER_FACTORIES[platform];
      if (!factory) {
        errors.push(`Unsupported or retired IM platform: ${platform}`);
        continue;
      }

      const key = instanceKey(platform, instanceId);
      desiredKeys.add(key);
      const configHash = JSON.stringify({
        agentId: item.agentId || 'main',
        cwd: item.cwd || '',
        config: item.config || {},
      });

      const existing = this.instances.get(key);
      if (existing && existing.configHash === configHash) {
        continue;
      }
      if (existing) {
        await existing.driver.stop().catch(() => {});
        this.instances.delete(key);
      }

      const agentId = String(item.agentId || 'main');
      const driver = factory({
        instanceId,
        config: item.config || {},
        onInbound: (msg) => this.handleInbound(msg, agentId, item.cwd),
        onStatus: (status) => {
          void this.bridgeNotify?.({
            type: 'status',
            platform,
            instanceId,
            status,
          });
        },
      });

      this.instances.set(key, {
        driver,
        configHash,
        agentId,
        cwd: item.cwd,
      });

      try {
        await driver.start();
        started.push(key);
      } catch (error) {
        errors.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Stop instances removed or disabled.
    const stopped = [];
    for (const [key, entry] of [...this.instances.entries()]) {
      if (desiredKeys.has(key)) continue;
      await entry.driver.stop().catch(() => {});
      this.instances.delete(key);
      stopped.push(key);
    }

    return {
      supportedPlatforms: [...RETAINED_IM_PLATFORMS],
      started,
      stopped,
      errors,
      statuses: this.listStatus(),
    };
  }

  /**
   * Proactively deliver a message to a bound IM chat (used by LobsterScheduler
   * and manual test sends).
   */
  async send({ platform, instanceId = 'default', chatId, text, replyContext }) {
    const key = instanceKey(String(platform).toLowerCase(), String(instanceId));
    const entry = this.instances.get(key);
    if (!entry) {
      throw new Error(`IM channel instance "${key}" is not running`);
    }
    return entry.driver.sendMessage({ chatId: String(chatId), text: String(text || ''), replyContext }).then((res) => {
      entry.driver.markOutbound();
      return res;
    });
  }

  async handleInbound(msg, agentId, cwd) {
    const key = instanceKey(String(msg.platform || '').toLowerCase(), String(msg.instanceId || 'default'));
    this.instances.get(key)?.driver.markInbound();

    // Prefer Electron host's Cowork/DshRuntimeAdapter pipeline when connected so
    // IM conversations get sidebar sessions, virtual model resolution, agent
    // persona/skills binding, and full credit/turn tracking.
    const bridgeResult = await this.bridgeNotify?.({
      type: 'inbound',
      ...msg,
      agentId,
      cwd,
    });
    if (bridgeResult && bridgeResult.handled === true) {
      return;
    }

    const fallbackPromptText = typeof msg.text === 'string' ? msg.text.trim() : '';
    if (!fallbackPromptText) {
      return;
    }

    const chatKey = `${msg.platform}:${msg.instanceId}:${msg.chatId}`;
    const controller = this.ctx.get?.('sessionController');
    if (!controller) {
      return;
    }

    let sessionId = this.chatSessions.get(chatKey);
    if (!sessionId) {
      const created = await controller.create({ ...(cwd ? { cwd } : {}) });
      sessionId = created.sessionId;
      this.chatSessions.set(chatKey, sessionId);
      await this.bridgeNotify?.({
        type: 'session-mapped',
        platform: msg.platform,
        instanceId: msg.instanceId,
        chatId: msg.chatId,
        dshSessionId: sessionId,
        agentId,
      });
    }

    const abort = new AbortController();
    const followStream = controller.follow(
      {
        address: { kind: 'session', sessionId },
        assistantStream: true,
        activate: true,
      },
      abort.signal,
    );

    const chunks = [];
    const collectTask = (async () => {
      for await (const frame of followStream) {
        if (frame.type === 'assistant-stream' && frame.frame?.type === 'chunk') {
          const chunk = frame.frame.chunk;
          if (chunk?.type === 'text-delta') {
            const delta = typeof chunk.text === 'string'
              ? chunk.text
              : (typeof chunk.delta === 'string' ? chunk.delta : '');
            if (delta) chunks.push(delta);
          }
        } else if (frame.type === 'event' && frame.event?.type === 'turn/end') {
          break;
        }
      }
    })();

    await controller.prompt(
      {
        sessionId,
        requestId: randomUUID(),
        content: [{ type: 'text', text: fallbackPromptText }],
        mode: 'queue',
      },
      abort.signal,
    );

    await collectTask;
    abort.abort();

    const replyText = chunks.join('').trim();
    if (replyText) {
      await this.send({
        platform: msg.platform,
        instanceId: msg.instanceId,
        chatId: msg.chatId,
        text: replyText,
        replyContext: msg.replyContext,
      });
    }
  }

  async dispose() {
    for (const entry of this.instances.values()) {
      await entry.driver.stop().catch(() => {});
    }
    this.instances.clear();
  }
}
