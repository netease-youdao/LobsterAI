/**
 * Lightweight i18n module for the Electron main process.
 *
 * Mirrors the renderer's i18nService pattern but runs in Node (no DOM/window).
 * Keeps only the small subset of keys needed by main-process code
 * (tray menu, session titles, etc.).
 *
 * Usage:
 *   import { t, setLanguage } from './i18n';
 *   setLanguage('en');
 *   const label = t('trayShowWindow'); // "Open LobsterAI"
 */

export type LanguageType = 'zh' | 'en';

const translations: Record<LanguageType, Record<string, string>> = {
  zh: {
    // Tray menu
    trayShowWindow: '打开 LobsterAI',
    trayNewTask: '新建任务',
    traySettings: '设置',
    trayQuit: '退出',

    // Session titles (created by ChannelSessionSync)
    cronSessionPrefix: '定时',

    // Timeout hint
    taskTimedOut: '[任务超时] 任务因超过最大允许时长而被自动停止。你可以继续对话以从中断处继续。',

    // OpenClaw gateway status
    coworkOpenClawGateway: '正在启动 OpenClaw 网关...',
    coworkOpenClawRuntimeReady: 'OpenClaw runtime 已就绪。',
    coworkOpenClawRuntimeMissing: '未检测到内置 OpenClaw runtime（cfmind）。预期路径：',
    coworkOpenClawGatewayRunning: 'OpenClaw gateway 正在运行',
    coworkOpenClawEntryMissing: 'OpenClaw runtime 中缺少入口文件',
    coworkOpenClawGatewayTimeout: 'OpenClaw gateway 未能在规定时间内启动成功。',
    coworkOpenClawGatewayError: 'OpenClaw gateway 进程错误',
    coworkOpenClawGatewayExitedUnexpectedly: 'OpenClaw gateway 意外退出',
    coworkOpenClawWarmingUp: '首次启动：正在预热编译缓存...',
  },
  en: {
    // Tray menu
    trayShowWindow: 'Open LobsterAI',
    trayNewTask: 'New Task',
    traySettings: 'Settings',
    trayQuit: 'Quit',

    // Session titles
    cronSessionPrefix: 'Cron',

    // Timeout hint
    taskTimedOut: '[Task timed out] The task was automatically stopped because it exceeded the maximum allowed duration. You can continue the conversation to pick up where it left off.',

    // OpenClaw gateway status
    coworkOpenClawGateway: 'Starting OpenClaw gateway...',
    coworkOpenClawRuntimeReady: 'OpenClaw runtime is ready.',
    coworkOpenClawRuntimeMissing: 'Bundled OpenClaw runtime is missing. Expected:',
    coworkOpenClawGatewayRunning: 'OpenClaw gateway is running on',
    coworkOpenClawEntryMissing: 'OpenClaw entry file is missing in runtime',
    coworkOpenClawGatewayTimeout: 'OpenClaw gateway failed to become healthy in time.',
    coworkOpenClawGatewayError: 'OpenClaw gateway process error',
    coworkOpenClawGatewayExitedUnexpectedly: 'OpenClaw gateway exited unexpectedly',
    coworkOpenClawWarmingUp: 'First start: warming up compile cache...',
  },
};

let currentLanguage: LanguageType = 'zh';

/** Set the active language. Call this when app_config.language changes. */
export function setLanguage(language: LanguageType): void {
  currentLanguage = language;
}

export function getLanguage(): LanguageType {
  return currentLanguage;
}

/** Look up a translation key. Returns the key itself if no translation exists. */
export function t(key: string): string {
  return translations[currentLanguage][key]
    ?? translations[currentLanguage === 'zh' ? 'en' : 'zh'][key]
    ?? key;
}
