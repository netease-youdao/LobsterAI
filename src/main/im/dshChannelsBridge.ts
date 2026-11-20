// Bridges LobsterAI's SQLite `im_config` and `LobsterScheduler` proactive
// delivery to the `@lobsterai/dsh-channels` Cordis bundle running inside DSH.
//
// Strictly supports the 7 retained mainstream IM platforms:
// Feishu, Weixin, DingTalk, WeCom, QQ, Telegram, Discord.
// Retired platforms (POPO, NIM, NetEase Bee, Email) are never synced.

import {
  DSH_CHANNELS_ROUTE_PATH,
  RETAINED_IM_PLATFORM_LIST,
  type RetainedImPlatform,
} from '../../shared/dshEngine/hostConstants';
import type { DshHostManager } from '../libs/dsh/dshHostManager';
import { defaultHttpRequester, type DshHttpRequester } from '../libs/dsh/dshTypertClient';

export interface DshChannelInstanceConfig {
  platform: RetainedImPlatform;
  instanceId: string;
  enabled: boolean;
  agentId?: string;
  cwd?: string;
  config: Record<string, unknown>;
}

export interface DshChannelStatusItem {
  platform: RetainedImPlatform;
  instanceId: string;
  state: string;
  error: string | null;
  agentId?: string;
  botInfo?: Record<string, unknown> | null;
}

const RETAINED_SET = new Set<string>(RETAINED_IM_PLATFORM_LIST);

export function isRetainedImPlatform(platform: string): platform is RetainedImPlatform {
  return RETAINED_SET.has(platform.trim().toLowerCase());
}

/**
 * Filter arbitrary stored `im_config` entries down to the 7 retained platforms,
 * normalizing instance IDs and preserving `allowFrom` lists.
 */
export function filterRetainedChannelInstances(
  entries: Array<{
    platform: string;
    instanceId?: string;
    enabled?: boolean;
    agentId?: string;
    cwd?: string;
    config?: Record<string, unknown>;
  }>,
): {
  retained: DshChannelInstanceConfig[];
  skippedRetiredPlatforms: string[];
} {
  const retained: DshChannelInstanceConfig[] = [];
  const skippedRetiredPlatforms: string[] = [];

  for (const entry of entries) {
    const normalized = String(entry.platform || '').trim().toLowerCase();
    if (!isRetainedImPlatform(normalized)) {
      if (normalized && !skippedRetiredPlatforms.includes(normalized)) {
        skippedRetiredPlatforms.push(normalized);
      }
      continue;
    }
    retained.push({
      platform: normalized,
      instanceId: (entry.instanceId || 'default').trim() || 'default',
      enabled: entry.enabled !== false,
      ...(entry.agentId ? { agentId: entry.agentId } : {}),
      ...(entry.cwd ? { cwd: entry.cwd } : {}),
      config: entry.config ?? {},
    });
  }

  return { retained, skippedRetiredPlatforms };
}

export class DshChannelsBridge {
  private readonly hostManager: Pick<DshHostManager, 'isReady' | 'getClient' | 'getStatus'>;
  private readonly requester: DshHttpRequester;

  constructor(options: {
    hostManager: Pick<DshHostManager, 'isReady' | 'getClient' | 'getStatus'>;
    requester?: DshHttpRequester;
  }) {
    this.hostManager = options.hostManager;
    this.requester = options.requester ?? defaultHttpRequester;
  }

  async callChannels<TResult = Record<string, unknown>>(
    action: string,
    payload?: unknown,
  ): Promise<TResult> {
    if (!this.hostManager.isReady()) {
      throw new Error('DSH host is not ready for IM channels operation');
    }
    const client = this.hostManager.getClient();
    const origin = client.getOrigin();
    // Reuse DSH's authenticated session cookie via a thin call on /api/lobsterai/channels.
    // DshTypertClient stores cookie privately, so we expose a helper call on client or use
    // authenticated fetch; fall back cleanly if using a custom requester in tests.
    const rawCookie = (client as unknown as { cookieHeader?: string }).cookieHeader ?? '';
    const res = await this.requester(`${origin}${DSH_CHANNELS_ROUTE_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(rawCookie ? { cookie: rawCookie } : {}),
      },
      body: JSON.stringify({ action, payload }),
    });
    const parsed = JSON.parse(res.body) as { ok?: boolean; result?: TResult; error?: string };
    if (res.status < 200 || res.status >= 300 || parsed.ok !== true) {
      throw new Error(parsed.error || `DSH channels "${action}" failed with HTTP ${res.status}`);
    }
    return parsed.result as TResult;
  }

  async listStatus(): Promise<{ supportedPlatforms: RetainedImPlatform[]; statuses: DshChannelStatusItem[] }> {
    return this.callChannels('listStatus');
  }

  async syncInstances(
    entries: Array<{
      platform: string;
      instanceId?: string;
      enabled?: boolean;
      agentId?: string;
      cwd?: string;
      config?: Record<string, unknown>;
    }>,
  ): Promise<{
    started: string[];
    stopped: string[];
    errors: string[];
    skippedRetiredPlatforms: string[];
    statuses: DshChannelStatusItem[];
  }> {
    const { retained, skippedRetiredPlatforms } = filterRetainedChannelInstances(entries);
    const res = await this.callChannels<{
      started: string[];
      stopped: string[];
      errors: string[];
      statuses: DshChannelStatusItem[];
    }>('syncInstances', { instances: retained });
    return { ...res, skippedRetiredPlatforms };
  }

  async sendProactiveMessage(params: {
    platform: string;
    instanceId?: string;
    chatId: string;
    text: string;
    replyContext?: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    if (!isRetainedImPlatform(params.platform)) {
      throw new Error(`Platform "${params.platform}" is retired and no longer supported`);
    }
    return this.callChannels('send', params);
  }
}
