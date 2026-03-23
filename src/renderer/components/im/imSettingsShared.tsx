/**
 * Shared types, constants, components and utility functions for IM Settings.
 * Extracted from IMSettings.tsx to support platform-specific sub-components.
 */
import React from 'react';
import { i18nService } from '../../services/i18n';
import type { IMPlatform, IMConnectivityCheck, IMConnectivityTestResult } from '../../types/im';

// ==================== Platform Metadata ====================

export const platformLogos: Record<IMPlatform, string> = {
  dingtalk: 'dingding.png',
  feishu: 'feishu.png',
  qq: 'qq_bot.jpeg',
  telegram: 'telegram.svg',
  discord: 'discord.svg',
  nim: 'nim.png',
  xiaomifeng: 'xiaomifeng.png',
  weixin: 'weixin.png',
  wecom: 'wecom.png',
  popo: 'popo.png',
};

export const IM_GUIDE_URLS: Partial<Record<IMPlatform, string>> = {
  dingtalk: 'https://lobsterai.youdao.com/#/docs/lobsterai_im_bot_config_guide/%E9%92%89%E9%92%89-im-%E6%9C%BA%E5%99%A8%E4%BA%BA%E9%85%8D%E7%BD%AE',
  feishu: 'https://lobsterai.youdao.com/#/docs/lobsterai_im_bot_config_guide/%E9%A3%9E%E4%B9%A6-im-%E6%9C%BA%E5%99%A8%E4%BA%BA%E9%85%8D%E7%BD%AE',
  wecom: 'https://lobsterai.youdao.com/#/docs/lobsterai_im_bot_config_guide/%E4%BC%81%E4%B8%9A%E5%BE%AE%E4%BF%A1%E6%9C%BA%E5%99%A8%E4%BA%BA%E9%85%8D%E7%BD%AE',
  qq: 'https://lobsterai.youdao.com/#/docs/lobsterai_im_bot_config_guide/qqqq-bot',
  telegram: 'https://lobsterai.youdao.com/#/en/docs/lobsterai_im_bot_config_guide/telegram-bot-configuration',
  discord: 'https://lobsterai.youdao.com/#/en/docs/lobsterai_im_bot_config_guide/discord-bot-configuration',
  weixin: 'https://lobsterai.youdao.com/#/docs/lobsterai_im_bot_config_guide/%E5%BE%AE%E4%BF%A1-im-%E6%9C%BA%E5%99%A8%E4%BA%BA%E9%85%8D%E7%BD%AE',
  popo: '',
};

// ==================== Shared Components ====================

/** Reusable guide card component for platform setup instructions */
export const PlatformGuide: React.FC<{
  title?: string;
  steps: string[];
  guideUrl?: string;
  guideLabel?: string;
}> = ({ title, steps, guideUrl, guideLabel }) => (
  <div className="mb-3 p-3 rounded-lg border border-dashed dark:border-claude-darkBorder/60 border-claude-border/60">
    {title && (
      <p className="text-xs text-claude-text dark:text-claude-darkText leading-relaxed mb-1.5 font-medium">{title}</p>
    )}
    <ol className="text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary space-y-1 list-decimal list-inside">
      {steps.map((step, i) => (
        <li key={i}>{step}</li>
      ))}
    </ol>
    {guideUrl && (
      <button
        type="button"
        onClick={() => {
          window.electron.shell.openExternal(guideUrl).catch((err: unknown) => {
            console.error('[IM] Failed to open guide URL:', err);
          });
        }}
        className="mt-2 text-xs font-medium text-claude-accentLight dark:text-claude-accentLight hover:text-claude-accent dark:hover:text-blue-200 underline underline-offset-2 transition-colors"
      >
        {guideLabel || i18nService.t('imViewGuide')}
      </button>
    )}
  </div>
);

// ==================== Style Constants ====================

export const verdictColorClass: Record<IMConnectivityTestResult['verdict'], string> = {
  pass: 'bg-green-500/15 text-green-600 dark:text-green-400',
  warn: 'bg-yellow-500/15 text-yellow-700 dark:text-yellow-300',
  fail: 'bg-red-500/15 text-red-600 dark:text-red-400',
};

export const checkLevelColorClass: Record<IMConnectivityCheck['level'], string> = {
  pass: 'text-green-600 dark:text-green-400',
  info: 'text-sky-600 dark:text-sky-400',
  warn: 'text-yellow-700 dark:text-yellow-300',
  fail: 'text-red-600 dark:text-red-400',
};

// ==================== Utility Functions ====================

/** Map of backend error messages to i18n keys */
const errorMessageI18nMap: Record<string, string> = {
  '账号已在其它地方登录': 'kickedByOtherClient',
};

/** Translate IM error messages using i18n when a mapping exists */
export function translateIMError(error: string | null): string {
  if (!error) return '';
  const i18nKey = errorMessageI18nMap[error];
  if (i18nKey) {
    return i18nService.t(i18nKey);
  }
  return error;
}

/** Deep-set a value in nested object by dot path (immutable) */
export function deepSet(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const keys = path.split('.');
  const result = { ...obj };
  let current: Record<string, unknown> = result;
  for (let i = 0; i < keys.length - 1; i++) {
    current[keys[i]] = { ...(current[keys[i]] as Record<string, unknown> || {}) };
    current = current[keys[i]] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
  return result;
}
