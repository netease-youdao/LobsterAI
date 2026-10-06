import {
  type Platform,
  PlatformRegistry,
} from '../../../shared/platform';
import { i18nService } from '../../services/i18n';

interface IMDisplayTitleResult {
  title: string;
  strippedPrefix: boolean;
}

const DEFAULT_ICON_CLASS_NAME = 'h-4 w-4 rounded-sm object-contain';

const IM_TITLE_PREFIXES: Record<Platform, readonly string[]> = {
  weixin: ['[微信]', '[WeChat]'],
  dingtalk: ['[钉钉]', '[DingTalk]'],
  feishu: ['[飞书]', '[Feishu]'],
  wecom: ['[企微]', '[企业微信]', '[WeCom]'],
  qq: ['[QQ]'],
  nim: ['[云信]', '[NIM]', '[NetEase IM]', '云信-', 'NIM-', 'NetEase IM-'],
  'netease-bee': ['[小蜜蜂]', '[Xiaomifeng]', '[NetEase Bee]', '[Netease Bee]'],
  popo: ['[POPO]'],
  telegram: ['[TG]', '[Telegram]'],
  discord: ['[Discord]'],
  email: ['[龙虾邮箱]', '[clawEmail]', '[邮件]', '[Email]'],
};

const IM_SESSION_ICON_SCALE_CLASS_NAMES: Partial<Record<Platform, string>> = {
  weixin: 'scale-90',
  dingtalk: 'scale-110',
  feishu: 'scale-[1.15]',
  wecom: 'scale-110',
  popo: 'scale-110',
};

const knownIMPlatforms = new Set<string>(PlatformRegistry.platforms);
const loggedUnknownPlatforms = new Set<string>();

function normalizeIMSessionPlatform(platform?: Platform | string | null): Platform | null {
  const normalized = platform?.trim();
  if (!normalized) return null;
  if (knownIMPlatforms.has(normalized)) return normalized as Platform;
  if (!loggedUnknownPlatforms.has(normalized)) {
    loggedUnknownPlatforms.add(normalized);
    console.warn('[IMSessionDisplay] Ignoring unknown IM platform for session list:', normalized);
  }
  return null;
}

export function getIMSessionDisplayTitle(
  title: string,
  platform?: Platform | string | null,
): IMDisplayTitleResult {
  const normalizedPlatform = normalizeIMSessionPlatform(platform);
  if (!normalizedPlatform) {
    return { title, strippedPrefix: false };
  }

  const prefixes = IM_TITLE_PREFIXES[normalizedPlatform] ?? [];
  for (const prefix of prefixes) {
    if (!title.startsWith(prefix)) continue;
    const stripped = title.slice(prefix.length).trimStart();
    if (!stripped) break;
    return { title: stripped, strippedPrefix: true };
  }

  return { title, strippedPrefix: false };
}

export function getIMSessionPlatformLogo(platform?: Platform | string | null): string | null {
  const normalizedPlatform = normalizeIMSessionPlatform(platform);
  if (!normalizedPlatform) return null;
  return PlatformRegistry.logo(normalizedPlatform);
}

export function getIMSessionPlatformIconClassName(platform?: Platform | string | null): string {
  const normalizedPlatform = normalizeIMSessionPlatform(platform);
  const scaleClassName = normalizedPlatform
    ? IM_SESSION_ICON_SCALE_CLASS_NAMES[normalizedPlatform]
    : null;
  return scaleClassName
    ? `${DEFAULT_ICON_CLASS_NAME} ${scaleClassName}`
    : DEFAULT_ICON_CLASS_NAME;
}

export function getIMSessionPlatformLabel(platform?: Platform | string | null): string | null {
  const normalizedPlatform = normalizeIMSessionPlatform(platform);
  if (!normalizedPlatform) return null;
  return i18nService.t(normalizedPlatform);
}
