/**
 * IM Platform Constants — Single Source of Truth
 *
 * All IM platform identifiers, channel mappings, region groups, and UI metadata
 * are defined here as a unified registry. Both main and renderer processes
 * import from this module.
 *
 * When adding a new IM platform:
 * 1. Add one record to the DEFINITIONS array below
 *    — that's it, types and lookups are derived automatically.
 */

// ═══════════════════════════════════════════════════════
// 1. Definition Shape (for `as const satisfies` constraint)
// ═══════════════════════════════════════════════════════

interface PlatformDefInput {
  readonly id: string;
  readonly label: string;
  readonly region: 'china' | 'global';
  readonly channel: string;
  readonly channelAliases: readonly string[];
  readonly logo: string;
  readonly guideUrl: string;
}

// ═══════════════════════════════════════════════════════
// 2. Platform Definitions — the single source of truth
//    Array order = Chinese UI display order (CHINA first, then GLOBAL).
// ═══════════════════════════════════════════════════════

const DEFINITIONS = [
  // ── China ──
  {
    id: 'weixin',
    label: 'WeChat',
    region: 'china',
    channel: 'openclaw-weixin',
    channelAliases: [],
    logo: 'weixin.png',
    guideUrl:
      'https://lobsterai.youdao.com/#/docs/lobsterai_im_bot_config_guide/%E5%BE%AE%E4%BF%A1-im-%E6%9C%BA%E5%99%A8%E4%BA%BA%E9%85%8D%E7%BD%AE',
  },
  {
    id: 'dingtalk',
    label: 'DingTalk',
    region: 'china',
    channel: 'dingtalk-connector',
    channelAliases: ['dingtalk'],
    logo: 'dingding.png',
    guideUrl:
      'https://lobsterai.youdao.com/#/docs/lobsterai_im_bot_config_guide/%E9%92%89%E9%92%89-im-%E6%9C%BA%E5%99%A8%E4%BA%BA%E9%85%8D%E7%BD%AE',
  },
  {
    id: 'feishu',
    label: 'Feishu',
    region: 'china',
    channel: 'feishu',
    channelAliases: [],
    logo: 'feishu.png',
    guideUrl:
      'https://lobsterai.youdao.com/#/docs/lobsterai_im_bot_config_guide/%E9%A3%9E%E4%B9%A6-im-%E6%9C%BA%E5%99%A8%E4%BA%BA%E9%85%8D%E7%BD%AE',
  },
  {
    id: 'wecom',
    label: 'WeCom',
    region: 'china',
    channel: 'wecom',
    channelAliases: ['wecom-openclaw-plugin'],
    logo: 'wecom.png',
    guideUrl:
      'https://lobsterai.youdao.com/#/docs/lobsterai_im_bot_config_guide/%E4%BC%81%E4%B8%9A%E5%BE%AE%E4%BF%A1%E6%9C%BA%E5%99%A8%E4%BA%BA%E9%85%8D%E7%BD%AE',
  },
  {
    id: 'qq',
    label: 'QQ',
    region: 'china',
    channel: 'qqbot',
    channelAliases: [],
    logo: 'qq_bot.jpeg',
    guideUrl: 'https://lobsterai.youdao.com/#/docs/lobsterai_im_bot_config_guide/qqqq-bot',
  },
  {
    id: 'nim',
    label: 'NIM',
    region: 'china',
    channel: 'nim',
    channelAliases: [],
    logo: 'nim.png',
    guideUrl: '',
  },
  {
    id: 'netease-bee',
    label: 'NetEase Bee',
    region: 'china',
    channel: 'netease-bee',
    channelAliases: [],
    logo: 'netease-bee.png',
    guideUrl: '',
  },
  {
    id: 'popo',
    label: 'POPO',
    region: 'china',
    channel: 'moltbot-popo',
    channelAliases: ['popo'],
    logo: 'popo.png',
    guideUrl: '',
  },
  // ── Global ──
  {
    id: 'telegram',
    label: 'Telegram',
    region: 'global',
    channel: 'telegram',
    channelAliases: [],
    logo: 'telegram.svg',
    guideUrl:
      'https://lobsterai.youdao.com/#/en/docs/lobsterai_im_bot_config_guide/telegram-bot-configuration',
  },
  {
    id: 'discord',
    label: 'Discord',
    region: 'global',
    channel: 'discord',
    channelAliases: [],
    logo: 'discord.svg',
    guideUrl:
      'https://lobsterai.youdao.com/#/en/docs/lobsterai_im_bot_config_guide/discord-bot-configuration',
  },
  {
    id: 'email',
    label: 'Email',
    region: 'china',
    channel: 'email',
    channelAliases: ['clawemail', 'clawemail-email'],
    logo: 'email.svg',
    guideUrl: '',
  },
] as const satisfies readonly PlatformDefInput[];

// ═══════════════════════════════════════════════════════
// 3. Derived Types
// ═══════════════════════════════════════════════════════

export type Platform = (typeof DEFINITIONS)[number]['id'];
export type ChannelName =
  | (typeof DEFINITIONS)[number]['channel']
  | (typeof DEFINITIONS)[number]['channelAliases'][number];

// ═══════════════════════════════════════════════════════
// 4. Platform Definition Interface (public)
// ═══════════════════════════════════════════════════════

export interface PlatformDef {
  /** Internal platform identifier */
  readonly id: Platform;
  /** UI display name (for non-i18n contexts like scheduled task dropdowns) */
  readonly label: string;
  /** Region grouping */
  readonly region: 'china' | 'global';
  /** Primary OpenClaw channel */
  readonly channel: ChannelName;
  /** Additional channel aliases (e.g. wecom has both 'wecom' and 'wecom-openclaw-plugin') */
  readonly channelAliases: readonly ChannelName[];
  /** Logo filename relative to /im-logos/ in public assets */
  readonly logo: string;
  /** Setup guide URL (empty string if not yet available) */
  readonly guideUrl: string;
}

// ═══════════════════════════════════════════════════════
// 5. Registry Implementation
// ═══════════════════════════════════════════════════════

class PlatformRegistryImpl {
  private readonly defs: readonly PlatformDef[];
  private readonly platformIndex: ReadonlyMap<Platform, PlatformDef>;
  private readonly channelIndex: ReadonlyMap<string, PlatformDef>;
  private readonly _platforms: readonly Platform[];
  private readonly _channelSet: ReadonlySet<string>;

  constructor(definitions: readonly PlatformDef[]) {
    this.defs = definitions;

    const pIdx = new Map<Platform, PlatformDef>();
    const cIdx = new Map<string, PlatformDef>();
    const platforms: Platform[] = [];
    const channels = new Set<string>();

    for (const def of definitions) {
      pIdx.set(def.id, def);
      platforms.push(def.id);

      cIdx.set(def.channel, def);
      channels.add(def.channel);

      for (const alias of def.channelAliases) {
        cIdx.set(alias, def);
        channels.add(alias);
      }
    }

    this.platformIndex = pIdx;
    this.channelIndex = cIdx;
    this._platforms = platforms;
    this._channelSet = channels;
  }

  // ── Platform Lists ──

  /** All platform ids. Array order = UI display order. */
  get platforms(): readonly Platform[] {
    return this._platforms;
  }

  /** Platforms filtered by region, preserving definition order. */
  platformsByRegion(region: 'china' | 'global'): readonly Platform[] {
    return this.defs.filter(d => d.region === region).map(d => d.id);
  }

  // ── Single Platform Queries ──

  /** Get the full definition for a platform. */
  get(platform: Platform): PlatformDef {
    return this.platformIndex.get(platform)!;
  }

  /** Logo filename relative to /im-logos/. */
  logo(platform: Platform): string {
    return this.platformIndex.get(platform)!.logo;
  }

  /** Setup guide URL (empty string if not available). */
  guideUrl(platform: Platform): string {
    return this.platformIndex.get(platform)!.guideUrl;
  }

  /** Primary OpenClaw channel for a platform. */
  channelOf(platform: Platform): ChannelName {
    return this.platformIndex.get(platform)!.channel;
  }

  // ── Channel Queries ──

  /** Resolve a channel string to its platform. Returns undefined for unknown channels. */
  platformOfChannel(channel: string): Platform | undefined {
    return this.channelIndex.get(channel)?.id;
  }

  /** Check if a string is a known IM channel. */
  isIMChannel(channel: string): boolean {
    return this._channelSet.has(channel);
  }

  // ── UI Helpers ──

  /** Channel options for scheduled task delivery target dropdown. */
  channelOptions(): readonly { value: ChannelName; label: string }[] {
    return this.defs.map(d => ({ value: d.channel, label: d.label }));
  }
}

export const PlatformRegistry = new PlatformRegistryImpl(DEFINITIONS);
