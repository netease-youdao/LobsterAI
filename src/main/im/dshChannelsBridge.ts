// Bridges LobsterAI's SQLite `im_config` and `LobsterScheduler` proactive
// delivery to the `@lobsterai/dsh-channels` Cordis bundle running inside DSH.
//
// Platform support is defined by RETAINED_IM_PLATFORM_LIST.

import {
  DSH_CHANNELS_ROUTE_PATH,
  DshChannelsAction,
  RETAINED_IM_PLATFORM_LIST,
  type RetainedImPlatform,
} from '../../shared/dshEngine/hostConstants';
import type { WeixinQrPollStatus } from '../../shared/im/weixin';
import { PlatformRegistry } from '../../shared/platform';
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
  startedAt?: number | null;
  lastInboundAt?: number | null;
  lastOutboundAt?: number | null;
}

export interface DshWeixinQrStartResponse {
  qrcode: string;
  qrcode_img_content: string;
  qrDataUrl?: string;
}

export interface DshWeixinQrPollResponse {
  status: WeixinQrPollStatus | string;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

const RETAINED_SET = new Set<string>(RETAINED_IM_PLATFORM_LIST);

export function isRetainedImPlatform(platform: string): platform is RetainedImPlatform {
  return RETAINED_SET.has(platform.trim().toLowerCase());
}

/**
 * Filter arbitrary stored `im_config` entries down to the retained platforms,
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

  isReady(): boolean {
    return this.hostManager.isReady();
  }

  async callChannels<TResult = Record<string, unknown>>(
    action: string,
    payload?: unknown,
    signal?: AbortSignal,
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
      signal,
    });
    let parsed: { ok?: boolean; result?: TResult; error?: string } | null = null;
    try {
      parsed = JSON.parse(res.body) as { ok?: boolean; result?: TResult; error?: string };
    } catch {
      parsed = null;
    }
    if (res.status < 200 || res.status >= 300 || parsed?.ok !== true) {
      throw new Error(parsed?.error || `DSH channels "${action}" failed with HTTP ${res.status}`);
    }
    return parsed.result as TResult;
  }

  async listStatus(): Promise<{ supportedPlatforms: RetainedImPlatform[]; statuses: DshChannelStatusItem[] }> {
    return this.callChannels(DshChannelsAction.ListStatus);
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
    }>(DshChannelsAction.SyncInstances, { instances: retained });
    return { ...res, skippedRetiredPlatforms };
  }

  async sendProactiveMessage(params: {
    platform: string;
    instanceId?: string;
    chatId: string;
    text: string;
    replyContext?: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const rawPlatform = params.platform.trim().toLowerCase();
    const resolvedPlatform = PlatformRegistry.platformOfChannel(rawPlatform) ?? rawPlatform;
    if (!isRetainedImPlatform(resolvedPlatform)) {
      throw new Error(`Platform "${params.platform}" is retired and no longer supported`);
    }
    return this.callChannels(DshChannelsAction.Send, { ...params, platform: resolvedPlatform });
  }

  async weixinQrStart(params?: {
    baseUrl?: string;
    botType?: string;
    localTokenList?: string[];
  }): Promise<DshWeixinQrStartResponse> {
    return this.callChannels<DshWeixinQrStartResponse>(DshChannelsAction.WeixinQrStart, params ?? {});
  }

  async weixinQrPoll(
    params: {
      qrcode: string;
      baseUrl?: string;
      timeoutMs?: number;
    },
    signal?: AbortSignal,
  ): Promise<DshWeixinQrPollResponse> {
    return this.callChannels<DshWeixinQrPollResponse>(DshChannelsAction.WeixinQrPoll, params, signal);
  }
}
