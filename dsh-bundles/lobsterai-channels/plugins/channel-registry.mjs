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

/**
 * Resolve a running IM channel instance entry from `instances` map:
 * 1. Exact `${platform}:${instanceId}` match.
 * 2. When a non-default `instanceId` (such as an 8-char UUID prefix stored in
 *    `delivery.accountId`) is provided, match a unique running instance whose
 *    full instanceId starts with that prefix (exact-case first, case-insensitive fallback).
 * 3. When `instanceId` is omitted/empty/`default`, match the sole running
 *    instance for `platform` (legacy single-instance compatibility).
 *
 * @template T
 * @param {Map<string, T>} instances
 * @param {string} platform
 * @param {string | undefined | null} instanceId
 * @returns {T}
 */
export function resolveChannelInstanceEntry(instances, platform, instanceId) {
  const normalizedPlatform = String(platform || '').trim().toLowerCase();
  const rawInstanceId = instanceId == null ? '' : String(instanceId).trim();
  const requestedId = rawInstanceId || 'default';
  const exactKey = instanceKey(normalizedPlatform, requestedId);

  const exact = instances.get(exactKey);
  if (exact) {
    return exact;
  }

  const keyPrefix = `${normalizedPlatform}:`;
  /** @type {Array<{ instanceId: string, entry: T }>} */
  const platformEntries = [];
  for (const [key, entry] of instances.entries()) {
    if (key.startsWith(keyPrefix)) {
      platformEntries.push({ instanceId: key.slice(keyPrefix.length), entry });
    }
  }

  if (rawInstanceId && rawInstanceId !== 'default') {
    let matches = platformEntries.filter((item) => item.instanceId.startsWith(rawInstanceId));
    if (matches.length === 0) {
      const lowerPrefix = rawInstanceId.toLowerCase();
      matches = platformEntries.filter((item) => item.instanceId.toLowerCase().startsWith(lowerPrefix));
    }
    if (matches.length === 1) {
      return matches[0].entry;
    }
    if (matches.length > 1) {
      throw new Error(
        `IM channel instance "${exactKey}" is ambiguous (${matches.length} matching instances running)`,
      );
    }
    throw new Error(`IM channel instance "${exactKey}" is not running`);
  }

  if (platformEntries.length === 1) {
    return platformEntries[0].entry;
  }
  if (platformEntries.length > 1) {
    throw new Error(
      `IM channel instance "${exactKey}" is not running (${platformEntries.length} instances exist for "${normalizedPlatform}"; specify instanceId)`,
    );
  }
  throw new Error(`IM channel instance "${exactKey}" is not running`);
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
    /** @type {Array<{ key: string, driver: import('./drivers/base-driver.mjs').BaseChannelDriver }>} */
    const toStart = [];

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
      toStart.push({ key, driver });
    }

    // Stop instances removed or disabled before/while starting new ones.
    const stopped = [];
    const stopTasks = [];
    for (const [key, entry] of [...this.instances.entries()]) {
      if (desiredKeys.has(key)) continue;
      this.instances.delete(key);
      stopped.push(key);
      stopTasks.push(entry.driver.stop().catch(() => {}));
    }

    const startResults = await Promise.allSettled([
      ...stopTasks.map(async (task) => {
        await task;
        return null;
      }),
      ...toStart.map(async ({ key, driver }) => {
        try {
          await driver.start();
          return { key, ok: true };
        } catch (error) {
          return {
            key,
            ok: false,
            error: `${key}: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }),
    ]);

    for (const settled of startResults) {
      if (settled.status !== 'fulfilled' || !settled.value) continue;
      if (settled.value.ok) {
        started.push(settled.value.key);
      } else if (settled.value.error) {
        errors.push(settled.value.error);
      }
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
    const entry = resolveChannelInstanceEntry(this.instances, platform, instanceId);
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
