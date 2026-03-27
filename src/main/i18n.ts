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
    channelPrefixFeishu: '飞书',
    channelPrefixDingtalk: '钉钉',
    channelPrefixWecom: '企微',
    channelPrefixNim: '云信',
    channelPrefixWeixin: '微信',
    // NIM chat type labels
    nimQChat: '圈组',
    nimGroup: '群聊',

    // Timeout hint
    taskTimedOut: '[任务超时] 任务因超过最大允许时长而被自动停止。你可以继续对话以从中断处继续。',

    // Feishu bot install
    feishuVerifyCredentialsFailed: '凭证验证失败，请检查 App ID 和 App Secret 是否正确',
    feishuVerifyFailed: '验证失败',

    // Cowork error messages (shared with renderer via classifyErrorKey)
    coworkErrorAuthInvalid: 'API 密钥无效或已过期，请检查配置。',
    coworkErrorInsufficientBalance: 'API 余额不足，请充值后重试。',
    coworkErrorInputTooLong: '输入内容过长，超出模型上下文限制。',
    coworkErrorCouldNotProcessPdf: '无法处理 PDF 文件。',
    coworkErrorModelNotFound: '请求的模型不存在或不可用。',
    coworkErrorGatewayDisconnected: 'AI 引擎连接中断，请重试。',
    coworkErrorServiceRestart: 'AI 引擎正在重启，请稍后重试。',
    coworkErrorGatewayDraining: 'AI 引擎正在重启中，请稍等片刻后重试。',
    coworkErrorNetworkError: '网络连接失败，请检查网络设置。',
    coworkErrorRateLimit: '请求过于频繁，请稍后再试。',
    coworkErrorContentFiltered: '内容未通过安全审核，请修改后重试。',
    coworkErrorServerError: '服务端出现错误，请稍后重试。',
    coworkErrorEngineNotReady: 'AI 引擎正在启动中，请稍等几秒后重试。',
    coworkErrorUnknown: '任务执行出错，请重试。如果问题持续出现，请检查模型配置。',
    imErrorPrefix: '处理消息时出错',

    // Skill manager errors
    skillErrNoSkillMd: '来源中未找到 SKILL.md',

    // Auth quota
    authPlanFree: '免费',
    authPlanStandard: '标准',
  },
  en: {
    // Tray menu
    trayShowWindow: 'Open LobsterAI',
    trayNewTask: 'New Task',
    traySettings: 'Settings',
    trayQuit: 'Quit',

    // Session titles
    cronSessionPrefix: 'Cron',
    channelPrefixFeishu: 'Feishu',
    channelPrefixDingtalk: 'DingTalk',
    channelPrefixWecom: 'WeCom',
    channelPrefixNim: 'NIM',
    channelPrefixWeixin: 'WeChat',
    // NIM chat type labels
    nimQChat: 'QChat',
    nimGroup: 'Group',

    // Timeout hint
    taskTimedOut: '[Task timed out] The task was automatically stopped because it exceeded the maximum allowed duration. You can continue the conversation to pick up where it left off.',

    // Feishu bot install
    feishuVerifyCredentialsFailed: 'Credential validation failed. Please check your App ID and App Secret.',
    feishuVerifyFailed: 'Verification failed',

    // Cowork error messages
    coworkErrorAuthInvalid: 'Invalid or expired API key. Please check your configuration.',
    coworkErrorInsufficientBalance: 'Insufficient API balance. Please top up and try again.',
    coworkErrorInputTooLong: 'Input too long, exceeding model context limit.',
    coworkErrorCouldNotProcessPdf: 'Unable to process the PDF file.',
    coworkErrorModelNotFound: 'The requested model does not exist or is unavailable.',
    coworkErrorGatewayDisconnected: 'AI engine connection lost. Please retry.',
    coworkErrorServiceRestart: 'AI engine is restarting. Please try again later.',
    coworkErrorGatewayDraining: 'AI engine is restarting. Please wait a moment and try again.',
    coworkErrorNetworkError: 'Network connection failed. Please check your network settings.',
    coworkErrorRateLimit: 'Too many requests. Please try again later.',
    coworkErrorContentFiltered: 'Content did not pass the safety review. Please modify and try again.',
    coworkErrorServerError: 'Server error occurred. Please try again later.',
    coworkErrorEngineNotReady: 'AI engine is starting up. Please wait a few seconds and try again.',
    coworkErrorUnknown: 'Task failed due to an unexpected error. Please retry. If the issue persists, check your model configuration.',
    imErrorPrefix: 'Error processing message',

    // Skill manager errors
    skillErrNoSkillMd: 'No SKILL.md found in source',

    // Auth quota
    authPlanFree: 'Free',
    authPlanStandard: 'Standard',
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
