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
 *   const msg = t('imMissingCredentials', { fields: 'appId, appSecret' });
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
    coworkDefaultSessionTitle: '新对话',
    cronSessionPrefix: '定时',
    channelPrefixFeishu: '飞书',
    channelPrefixDingtalk: '钉钉',
    channelPrefixWecom: '企微',
    channelPrefixNim: '云信',
    channelPrefixWeixin: '微信',
    channelPrefixNeteaseBee: '小蜜蜂',
    channelPrefixEmail: '邮件',
    // NIM chat type labels
    nimQChat: '圈组',
    nimGroup: '群聊',

    // Timeout hint
    taskTimedOut: '[任务超时] 任务因超过最大允许时长而被自动停止。你可以继续对话以从中断处继续。',
    imSessionStoppedReply: '任务已被手动停止。你可以继续发送消息开始新的对话。',

    // Thinking-only hint
    taskThinkingOnly:
      '[模型未输出内容] 模型已完成思考但未生成可见回复。你可以继续对话，让模型重新输出结果。',

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

    // Exec approval continuation
    execApprovalApproved: '用户已确认执行该命令，请检查执行结果并继续。',
    execApprovalDenied: '用户已拒绝执行该命令。',

    // Skill manager errors
    skillErrNoSkillMd: '来源中未找到 SKILL.md',
    skillErrInvalidSource:
      '无效的技能来源。支持 owner/repo、仓库链接、npm 包名、ClawHub 链接或 GitHub tree/blob 链接。',
    skillErrClawhubNotFound: '在 ClawHub 上未找到该技能，请检查链接是否正确。',
    skillErrClawhubDownloadFailed: '从 ClawHub 下载技能失败，请稍后重试。',

    // Auth quota
    authPlanFree: '免费',
    authPlanStandard: '标准',

    // ── IM connectivity test messages ───────────────────────────────────
    // Common
    imMissingCredentials: '缺少必要配置项: {fields}',
    imFillCredentials: '请补全配置后重新测试连通性。',
    imAuthProbeTimeout: '鉴权探测超时',
    imAuthFailed: '鉴权失败: {error}',
    imAuthFailedSuggestion: '请检查 ID/Secret/Token 是否正确，且机器人权限已开通。',
    imChannelEnabledNotConnected: 'IM 渠道已启用但当前未连接。',
    imChannelEnabledNotConnectedSuggestion: '请检查网络、机器人配置和平台侧事件开关。',
    imChannelRunning: 'IM 渠道已启用且运行正常。',
    imChannelNotEnabled: 'IM 渠道当前未启用。',
    imChannelNotEnabledSuggestion: '请点击对应 IM 渠道胶囊按钮启用该渠道。',
    imNoInboundAfter2Min: '已连接超过 2 分钟，但尚未收到任何入站消息。',
    imNoInboundSuggestion: '请确认机器人已在目标会话中，或按平台规则 @机器人 触发消息。',
    imInboundDetected: '已检测到入站消息。',
    imGatewayJustStarted: '网关刚启动，入站活动检查将在 2 分钟后更准确。',
    imNoOutbound: '已收到消息，但尚未观察到成功回发。',
    imNoOutboundSuggestion: '请检查消息发送权限、机器人可见范围和会话回包权限。',
    imOutboundDetected: '已检测到成功回发消息。',
    imNoInboundForOutboundCheck: '尚未收到可用于评估回发能力的入站消息。',
    imRecentError: '最近错误: {error}',
    imRecentErrorConnectedSuggestion: '当前已连接，但建议修复该错误避免后续中断。',
    imRecentErrorDisconnectedSuggestion: '该错误可能阻断对话，请优先修复后重试。',
    imConfigIncomplete: '配置不完整',
    imUnknownPlatform: '未知平台。',

    // QQ
    imQqOpenClawHint: 'QQ 通过 OpenClaw 运行时运行，Bot 将在 OpenClaw Gateway 启动后自动连接。',
    imQqMentionHint: '频道中需 @机器人 触发对话，也支持私信和群聊。',
    imQqAuthPassed: 'QQ 鉴权通过（AccessToken 已获取）。',
    imEmailImapAuthPassed: 'IMAP 邮箱登录验证通过。',
    imEmailImapAuthFailed: 'IMAP 邮箱登录验证失败',
    imEmailWsAuthPassed: 'API Key 已配置。',
    imQqAccessTokenFailed: '获取 AccessToken 失败',
    imQqFillAppIdSecret: '请补全 AppID 和 AppSecret 后重新测试连通性。',
    imQqAuthFailed: 'QQ 鉴权失败: {error}',
    imQqCheckAppIdSecret: '请检查 AppID 和 AppSecret 是否正确，且机器人权限已开通。',

    // Telegram
    imTelegramMissingBotToken: '缺少必要配置项: botToken',
    imTelegramFillBotToken: '请补全 Bot Token 后重新测试连通性。',
    imTelegramAuthPassed: 'Telegram Bot 鉴权通过: @{username}',
    imTelegramAuthFailed: 'Telegram Bot 鉴权失败: {error}',
    imTelegramAuthFailedUnknown: '未知错误',
    imTelegramCheckToken: '请检查 Bot Token 是否正确。',
    imTelegramCheckTokenNetwork: '请检查 Bot Token 是否正确，且网络通畅。',
    imTelegramOpenClawHint:
      'Telegram 通过 OpenClaw 运行时运行，Bot 将在 OpenClaw Gateway 启动后自动连接。',

    // Discord
    imDiscordMissingBotToken: '缺少必要配置项: botToken',
    imDiscordFillBotToken: '请补全 Bot Token 后重新测试连通性。',
    imDiscordAuthPassed: 'Discord Bot 鉴权通过（Bot: {username}）。',
    imDiscordAuthFailed: 'Discord Bot 鉴权失败: {error}',
    imDiscordCheckTokenNetwork: '请检查 Bot Token 是否正确，且网络通畅。',
    imDiscordOpenClawHint:
      'Discord 通过 OpenClaw 运行时运行，Bot 将在 OpenClaw Gateway 启动后自动连接。',
    imDiscordGroupMention: 'Discord 群聊中仅响应 @机器人的消息。',

    // Feishu
    imFeishuFillAppIdSecret: '请补全 App ID 和 App Secret 后重新测试连通性。',
    imFeishuAuthPassed: '飞书鉴权通过（Bot: {botName}）',
    imFeishuAuthFailed: '飞书鉴权失败: {error}',
    imFeishuCheckAppIdSecret: '请检查 App ID 和 App Secret 是否正确。',
    imFeishuOpenClawHint:
      '飞书通过 OpenClaw 运行时运行，Bot 将在 OpenClaw Gateway 启动后自动连接。',
    imFeishuGroupMention: '飞书群聊中仅响应 @机器人的消息。',
    imFeishuGroupMentionSuggestion: '请在群聊中使用 @机器人 + 内容触发对话。',
    imFeishuEventSubscription: '飞书需要开启消息事件订阅（im.message.receive_v1）才能收消息。',
    imFeishuEventSubscriptionSuggestion: '请在飞书开发者后台确认事件订阅、权限和发布状态。',
    imFeishuAuthPassedWithBot: '飞书鉴权通过（Bot: {botName}）。',

    // DingTalk
    imDingtalkFillClientIdSecret: '请补全 Client ID 和 Client Secret 后重新测试连通性。',
    imDingtalkAuthPassed: '钉钉鉴权通过。',
    imDingtalkAuthFailed: '钉钉鉴权失败: {error}',
    imDingtalkCheckClientIdSecret:
      '请检查 Client ID 和 Client Secret 是否正确，且机器人权限已开通。',
    imDingtalkOpenClawHint:
      '钉钉通过 OpenClaw 运行时运行，Bot 将在 OpenClaw Gateway 启动后自动连接。',
    imDingtalkBotMembership: '钉钉机器人需被加入目标会话并具备发言权限。',
    imDingtalkBotMembershipSuggestion: '请确认机器人在目标会话中，且企业权限配置允许收发消息。',

    // WeCom
    imWecomFillBotIdSecret: '请补全 Bot ID 和 Secret 后重新测试连通性。',
    imWecomConfigReady: '企业微信配置已就绪（Bot ID: {botId}）。',
    imWecomOpenClawHint:
      '企业微信通过 OpenClaw 运行时运行，Bot 将在 OpenClaw Gateway 启动后自动连接。',
    imWecomConfigReadyOpenClaw: '企业微信配置已就绪（Bot ID: {botId}），通过 OpenClaw 运行。',

    // Weixin
    imWeixinNotEnabled: '微信渠道当前未启用。',
    imWeixinEnableSuggestion: '请启用微信渠道后重新测试连通性。',
    imWeixinConfigReady: '微信配置已就绪。',
    imWeixinOpenClawHint:
      '微信通过 OpenClaw 运行时运行，Bot 将在 OpenClaw Gateway 启动后自动连接。',
    imWeixinConfigReadyOpenClaw: '微信配置已就绪，通过 OpenClaw 运行。',

    // NIM
    imNimFillCredentials: '请补全 AppKey、Account 和 Token 后重新测试连通性。',
    imNimConfigReady: '云信配置已就绪（Account: {account}）。',
    imNimOpenClawHint: '云信通过 OpenClaw 运行时运行，Bot 将在 OpenClaw Gateway 启动后自动连接。',
    imNimP2pOnly: '云信 IM 当前仅支持 P2P（私聊）消息。',
    imNimP2pOnlySuggestion: '请通过私聊方式向机器人账号发送消息触发对话。',

    // Xiaomifeng
    imNeteaseBeeConfigReady: '小蜜蜂配置已就绪（Client ID: {clientId}）。',

    // POPO
    imPopoFillWebhookCredentials: '请补全 appKey、appSecret、token 和 aesKey 后重新测试连通性。',
    imPopoFillWsCredentials: '请补全 appKey、appSecret 和 aesKey 后重新测试连通性。',
    imPopoConfigReady: 'POPO 配置已就绪。',
    imPopoOpenClawHint: 'POPO 通过 OpenClaw 运行时运行，Bot 将在 OpenClaw Gateway 启动后自动连接。',
    imPopoConfigReadyOpenClaw: 'POPO 配置已就绪，通过 OpenClaw 运行。',

    // Email Channel
    emailSettings: '邮件设置',
    emailInstance: '邮箱账号',
    addEmailInstance: '添加邮箱账号',
    emailInstanceName: '账号名称',
    emailInstanceNamePlaceholder: '例如：工作邮箱',
    emailAddress: '邮箱地址',
    emailAddressPlaceholder: 'user@example.com',
    emailPassword: '密码',
    emailPasswordPlaceholder: '邮箱密码或应用专用密码',
    emailApiKey: 'API Key',
    emailApiKeyPlaceholder: 'ck_live_xxxxxxxx',
    getApiKey: '获取 API Key',
    apiKeyHint: '点击「获取 API Key」按钮在浏览器中完成邮箱验证',
    emailTransportMode: '传输模式',
    emailTransportImap: 'IMAP/SMTP（传统模式）',
    emailTransportWs: 'WebSocket（安全模式，无需密码）',
    emailAgentBinding: '绑定 Agent',
    emailAgentBindingHint: '该邮箱的所有邮件对话将路由到选定的 Agent',
    emailAllowFrom: '允许的发件人（白名单）',
    emailAllowFromPlaceholder: 'user@example.com\n*.trusted-domain.com\n*@company.com',
    emailAllowFromHint: '支持通配符，每行一个。留空表示接受所有发件人。',
    emailAdvancedOptions: '高级选项',
    emailImapSmtpConfig: 'IMAP/SMTP 服务器配置',
    emailImapHost: 'IMAP Host',
    emailImapPort: 'IMAP Port',
    emailSmtpHost: 'SMTP Host',
    emailSmtpPort: 'SMTP Port',
    emailServerConfigHint: '留空则自动根据邮箱域名推断',
    emailReplyStrategy: '回复策略',
    emailReplyMode: '回复模式',
    emailReplyModeImmediate: '立即发送（流式，每个块一封邮件）',
    emailReplyModeAccumulated: '累积发送（流式，缓冲后一封邮件）',
    emailReplyModeComplete: '完成后发送（等待完整回复）',
    emailReplyTo: '回复范围',
    emailReplyToSender: '仅回复发件人',
    emailReplyToAll: '回复发件人 + 所有收件人',
    emailA2aConfig: 'Agent-to-Agent 配置',
    emailA2aEnabled: '启用 A2A',
    emailA2aAgentDomains: 'Agent 域名',
    emailA2aAgentDomainsPlaceholder: 'agents.example.com',
    emailA2aAgentDomainsHint: '允许进行 Agent 协作的域名，每行一个',
    emailA2aMaxTurns: 'A2A最大往返次数',
    emailConnectivityFailAlert: '连通性测试失败，请检查配置',
    emailConnected: '已连接',
    emailDisconnected: '未连接',
    emailSaveSuccess: '配置已保存',
    emailSaveError: '保存失败',
    emailValidationError: '配置验证失败',
    emailMaxInstancesExceeded: '最多支持 {count} 个邮箱账号',
    emailDuplicateEmail: '邮箱地址「{email}」重复',
    emailDuplicateInstanceId: '实例 ID「{id}」重复',
    emailInvalidEmail: '邮箱地址格式不正确',
    emailMissingPassword: '实例「{name}」使用 IMAP 模式但未填写密码',
    emailMissingApiKey: '实例「{name}」使用 WebSocket 模式但未填写 API Key',
    emailInvalidApiKey: '实例「{name}」的 API Key 格式不正确（应以 ck_ 开头）',
    emailGatewayRestarting: '正在重启 OpenClaw Gateway...',
    emailDeleteConfirm: '确定要删除邮箱账号「{name}」吗？',
    emailEnterValidEmailFirst: '请先填写有效的邮箱地址',
    emailVerifyInBrowserAndPaste: '请在浏览器中完成验证，然后将 API Key 粘贴回来',
    testConnection: '测试连接',
    emailTestSuccess: '连接测试成功！',
    emailTestFailed: '连接测试失败：{error}',

    'enterprise.updateBlocked': '版本更新由企业统一管理',
  },
  en: {
    // Tray menu
    trayShowWindow: 'Open LobsterAI',
    trayNewTask: 'New Task',
    traySettings: 'Settings',
    trayQuit: 'Quit',

    // Session titles
    coworkDefaultSessionTitle: 'New Chat',
    cronSessionPrefix: 'Cron',
    channelPrefixFeishu: 'Feishu',
    channelPrefixDingtalk: 'DingTalk',
    channelPrefixWecom: 'WeCom',
    channelPrefixNim: 'NIM',
    channelPrefixWeixin: 'WeChat',
    channelPrefixNeteaseBee: 'Xiaomifeng',
    channelPrefixEmail: 'Email',
    // NIM chat type labels
    nimQChat: 'QChat',
    nimGroup: 'Group',

    // Timeout hint
    taskTimedOut:
      '[Task timed out] The task was automatically stopped because it exceeded the maximum allowed duration. You can continue the conversation to pick up where it left off.',
    imSessionStoppedReply:
      'The task was manually stopped. You can send a new message to start a fresh conversation.',

    // OAuth flow messages
    qwenOAuthRequestingDeviceCode: 'Requesting device authorization code...',
    qwenOAuthOpeningBrowser: 'Opening browser for authorization...',
    qwenOAuthWaitingForUser: 'Waiting for user authorization...',
    qwenOAuthSuccess: 'OAuth authorization successful',
    qwenOAuthFailed: 'OAuth authorization failed',
    qwenOAuthTimeout: 'OAuth authorization timeout',
    // Thinking-only hint
    taskThinkingOnly:
      '[No output] The model finished thinking but did not generate a visible reply. You can continue the conversation to ask it to output the result.',

    // Feishu bot install
    feishuVerifyCredentialsFailed:
      'Credential validation failed. Please check your App ID and App Secret.',
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
    coworkErrorContentFiltered:
      'Content did not pass the safety review. Please modify and try again.',
    coworkErrorServerError: 'Server error occurred. Please try again later.',
    coworkErrorEngineNotReady: 'AI engine is starting up. Please wait a few seconds and try again.',
    coworkErrorUnknown:
      'Task failed due to an unexpected error. Please retry. If the issue persists, check your model configuration.',
    imErrorPrefix: 'Error processing message',

    // Exec approval continuation
    execApprovalApproved:
      'The user approved the command execution. Please check the result and continue.',
    execApprovalDenied: 'The user denied the command execution.',

    // Skill manager errors
    skillErrNoSkillMd: 'No SKILL.md found in source',
    skillErrInvalidSource:
      'Invalid skill source. Use owner/repo, repo URL, npm package spec, ClawHub URL, or a GitHub tree/blob URL.',
    skillErrClawhubNotFound: 'Skill not found on ClawHub. Please check the URL.',
    skillErrClawhubDownloadFailed: 'Failed to download skill from ClawHub. Please try again later.',

    // Auth quota
    authPlanFree: 'Free',
    authPlanStandard: 'Standard',

    // ── IM connectivity test messages ───────────────────────────────────
    // Common
    imMissingCredentials: 'Missing required configuration: {fields}',
    imFillCredentials: 'Please complete the configuration and test connectivity again.',
    imAuthProbeTimeout: 'Authentication probe timed out',
    imAuthFailed: 'Authentication failed: {error}',
    imAuthFailedSuggestion:
      'Please check that your ID/Secret/Token are correct and that bot permissions are enabled.',
    imChannelEnabledNotConnected: 'IM channel is enabled but not currently connected.',
    imChannelEnabledNotConnectedSuggestion:
      'Please check the network, bot configuration, and platform-side event settings.',
    imChannelRunning: 'IM channel is enabled and running normally.',
    imChannelNotEnabled: 'IM channel is not currently enabled.',
    imChannelNotEnabledSuggestion: 'Please click the IM channel toggle button to enable it.',
    imNoInboundAfter2Min: 'Connected for over 2 minutes but no inbound messages received.',
    imNoInboundSuggestion:
      'Please verify the bot is in the target conversation, or @mention the bot per platform rules.',
    imInboundDetected: 'Inbound messages detected.',
    imGatewayJustStarted:
      'Gateway just started; inbound activity check will be more accurate after 2 minutes.',
    imNoOutbound: 'Messages received but no successful outbound reply observed.',
    imNoOutboundSuggestion:
      'Please check message send permissions, bot visibility scope, and reply permissions.',
    imOutboundDetected: 'Successful outbound reply detected.',
    imNoInboundForOutboundCheck:
      'No inbound messages received yet to evaluate outbound capability.',
    imRecentError: 'Recent error: {error}',
    imRecentErrorConnectedSuggestion:
      'Currently connected, but fixing this error is recommended to prevent future interruptions.',
    imRecentErrorDisconnectedSuggestion:
      'This error may block conversations. Please fix it and retry.',
    imConfigIncomplete: 'Configuration incomplete',
    imUnknownPlatform: 'Unknown platform.',

    // QQ
    imQqOpenClawHint:
      'QQ runs via OpenClaw runtime. The bot will connect automatically when OpenClaw Gateway starts.',
    imQqMentionHint:
      '@mention the bot in channels to start a conversation. Direct messages and group chats are also supported.',
    imQqAuthPassed: 'QQ authentication passed (AccessToken obtained).',
    imEmailImapAuthPassed: 'IMAP email login verification passed.',
    imEmailImapAuthFailed: 'IMAP email login verification failed',
    imEmailWsAuthPassed: 'API Key configured.',
    imQqAccessTokenFailed: 'Failed to obtain AccessToken',
    imQqFillAppIdSecret: 'Please provide the AppID and AppSecret and test connectivity again.',
    imQqAuthFailed: 'QQ authentication failed: {error}',
    imQqCheckAppIdSecret:
      'Please check that the AppID and AppSecret are correct and that bot permissions are enabled.',

    // Telegram
    imTelegramMissingBotToken: 'Missing required configuration: botToken',
    imTelegramFillBotToken: 'Please provide the Bot Token and test connectivity again.',
    imTelegramAuthPassed: 'Telegram Bot authentication passed: @{username}',
    imTelegramAuthFailed: 'Telegram Bot authentication failed: {error}',
    imTelegramAuthFailedUnknown: 'Unknown error',
    imTelegramCheckToken: 'Please check that the Bot Token is correct.',
    imTelegramCheckTokenNetwork:
      'Please check that the Bot Token is correct and the network is reachable.',
    imTelegramOpenClawHint:
      'Telegram runs via OpenClaw runtime. The bot will connect automatically when OpenClaw Gateway starts.',

    // Discord
    imDiscordMissingBotToken: 'Missing required configuration: botToken',
    imDiscordFillBotToken: 'Please provide the Bot Token and test connectivity again.',
    imDiscordAuthPassed: 'Discord Bot authentication passed (Bot: {username}).',
    imDiscordAuthFailed: 'Discord Bot authentication failed: {error}',
    imDiscordCheckTokenNetwork:
      'Please check that the Bot Token is correct and the network is reachable.',
    imDiscordOpenClawHint:
      'Discord runs via OpenClaw runtime. The bot will connect automatically when OpenClaw Gateway starts.',
    imDiscordGroupMention: 'Discord only responds to @mentioned messages in group chats.',

    // Feishu
    imFeishuFillAppIdSecret:
      'Please provide the App ID and App Secret and test connectivity again.',
    imFeishuAuthPassed: 'Feishu authentication passed (Bot: {botName})',
    imFeishuAuthFailed: 'Feishu authentication failed: {error}',
    imFeishuCheckAppIdSecret: 'Please check that the App ID and App Secret are correct.',
    imFeishuOpenClawHint:
      'Feishu runs via OpenClaw runtime. The bot will connect automatically when OpenClaw Gateway starts.',
    imFeishuGroupMention: 'Feishu only responds to @mentioned messages in group chats.',
    imFeishuGroupMentionSuggestion:
      'Please @mention the bot in group chats to start a conversation.',
    imFeishuEventSubscription:
      'Feishu requires the message event subscription (im.message.receive_v1) to receive messages.',
    imFeishuEventSubscriptionSuggestion:
      'Please verify event subscriptions, permissions, and publish status in the Feishu Developer Console.',
    imFeishuAuthPassedWithBot: 'Feishu authentication passed (Bot: {botName}).',

    // DingTalk
    imDingtalkFillClientIdSecret:
      'Please provide the Client ID and Client Secret and test connectivity again.',
    imDingtalkAuthPassed: 'DingTalk authentication passed.',
    imDingtalkAuthFailed: 'DingTalk authentication failed: {error}',
    imDingtalkCheckClientIdSecret:
      'Please check that the Client ID and Client Secret are correct and that bot permissions are enabled.',
    imDingtalkOpenClawHint:
      'DingTalk runs via OpenClaw runtime. The bot will connect automatically when OpenClaw Gateway starts.',
    imDingtalkBotMembership:
      'The DingTalk bot must be added to the target conversation with messaging permissions.',
    imDingtalkBotMembershipSuggestion:
      'Please verify the bot is in the target conversation and enterprise permissions allow sending and receiving messages.',

    // WeCom
    imWecomFillBotIdSecret: 'Please provide the Bot ID and Secret and test connectivity again.',
    imWecomConfigReady: 'WeCom configuration is ready (Bot ID: {botId}).',
    imWecomOpenClawHint:
      'WeCom runs via OpenClaw runtime. The bot will connect automatically when OpenClaw Gateway starts.',
    imWecomConfigReadyOpenClaw:
      'WeCom configuration is ready (Bot ID: {botId}), running via OpenClaw.',

    // Weixin
    imWeixinNotEnabled: 'WeChat channel is not currently enabled.',
    imWeixinEnableSuggestion: 'Please enable the WeChat channel and test connectivity again.',
    imWeixinConfigReady: 'WeChat configuration is ready.',
    imWeixinOpenClawHint:
      'WeChat runs via OpenClaw runtime. The bot will connect automatically when OpenClaw Gateway starts.',
    imWeixinConfigReadyOpenClaw: 'WeChat configuration is ready, running via OpenClaw.',

    // NIM
    imNimFillCredentials:
      'Please provide the AppKey, Account, and Token and test connectivity again.',
    imNimConfigReady: 'NIM configuration is ready (Account: {account}).',
    imNimOpenClawHint:
      'NIM runs via OpenClaw runtime. The bot will connect automatically when OpenClaw Gateway starts.',
    imNimP2pOnly: 'NIM currently only supports P2P (direct) messages.',
    imNimP2pOnlySuggestion:
      'Please send a direct message to the bot account to start a conversation.',

    // Netease Bee
    imNeteaseBeeConfigReady: 'Netease Bee configuration is ready (Client ID: {clientId}).',

    // POPO
    imPopoFillWebhookCredentials:
      'Please provide the appKey, appSecret, token, and aesKey and test connectivity again.',
    imPopoFillWsCredentials:
      'Please provide the appKey, appSecret, and aesKey and test connectivity again.',
    imPopoConfigReady: 'POPO configuration is ready.',
    imPopoOpenClawHint:
      'POPO runs via OpenClaw runtime. The bot will connect automatically when OpenClaw Gateway starts.',
    imPopoConfigReadyOpenClaw: 'POPO configuration is ready, running via OpenClaw.',

    // Email Channel
    emailSettings: 'Email Settings',
    emailInstance: 'Email Account',
    addEmailInstance: 'Add Email Account',
    emailInstanceName: 'Account Name',
    emailInstanceNamePlaceholder: 'e.g., Work Email',
    emailAddress: 'Email Address',
    emailAddressPlaceholder: 'user@example.com',
    emailPassword: 'Password',
    emailPasswordPlaceholder: 'Email password or app-specific password',
    emailApiKey: 'API Key',
    emailApiKeyPlaceholder: 'ck_live_xxxxxxxx',
    getApiKey: 'Get API Key',
    apiKeyHint: 'Click "Get API Key" to verify your email in browser',
    emailTransportMode: 'Transport Mode',
    emailTransportImap: 'IMAP/SMTP (Traditional)',
    emailTransportWs: 'WebSocket (Secure, no password required)',
    emailAgentBinding: 'Agent Binding',
    emailAgentBindingHint: 'All email conversations will be routed to the selected Agent',
    emailAllowFrom: 'Allowed Senders (Whitelist)',
    emailAllowFromPlaceholder: 'user@example.com\n*.trusted-domain.com\n*@company.com',
    emailAllowFromHint: 'Supports wildcards, one per line. Empty = accept all senders.',
    emailAdvancedOptions: 'Advanced Options',
    emailImapSmtpConfig: 'IMAP/SMTP Server Configuration',
    emailImapHost: 'IMAP Host',
    emailImapPort: 'IMAP Port',
    emailSmtpHost: 'SMTP Host',
    emailSmtpPort: 'SMTP Port',
    emailServerConfigHint: 'Leave empty to auto-detect from email domain',
    emailReplyStrategy: 'Reply Strategy',
    emailReplyMode: 'Reply Mode',
    emailReplyModeImmediate: 'Immediate (streaming, one email per block)',
    emailReplyModeAccumulated: 'Accumulated (streaming, buffered)',
    emailReplyModeComplete: 'Complete (wait for full response)',
    emailReplyTo: 'Reply Recipients',
    emailReplyToSender: 'Sender only',
    emailReplyToAll: 'Sender + all recipients',
    emailA2aConfig: 'Agent-to-Agent Configuration',
    emailA2aEnabled: 'Enable A2A',
    emailA2aAgentDomains: 'Agent Domains',
    emailA2aAgentDomainsPlaceholder: 'agents.example.com',
    emailA2aAgentDomainsHint: 'Domains allowed for agent collaboration, one per line',
    emailA2aMaxTurns: 'A2A Max Ping-Pong Turns',
    emailConnectivityFailAlert: 'Connectivity test failed, please check your configuration',
    emailConnected: 'Connected',
    emailDisconnected: 'Disconnected',
    emailSaveSuccess: 'Configuration saved',
    emailSaveError: 'Save failed',
    emailValidationError: 'Configuration validation failed',
    emailMaxInstancesExceeded: 'Maximum {count} email accounts supported',
    emailDuplicateEmail: 'Email address "{email}" is duplicated',
    emailDuplicateInstanceId: 'Instance ID "{id}" is duplicated',
    emailInvalidEmail: 'Invalid email address format',
    emailMissingPassword: 'Instance "{name}" uses IMAP mode but password is missing',
    emailMissingApiKey: 'Instance "{name}" uses WebSocket mode but API Key is missing',
    emailInvalidApiKey: 'Instance "{name}" has invalid API Key format (should start with ck_)',
    emailGatewayRestarting: 'Restarting OpenClaw Gateway...',
    emailDeleteConfirm: 'Delete email account "{name}"?',
    emailEnterValidEmailFirst: 'Please enter a valid email address first',
    emailVerifyInBrowserAndPaste:
      'Please complete verification in browser, then paste API Key here',
    testConnection: 'Test Connection',
    emailTestSuccess: 'Connection test successful!',
    emailTestFailed: 'Connection test failed: {error}',

    'enterprise.updateBlocked': 'Updates are managed by enterprise',
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

/**
 * Look up a translation key and optionally interpolate `{param}` placeholders.
 * Returns the key itself if no translation exists.
 *
 *   t('imMissingCredentials', { fields: 'appId, appSecret' })
 *   // => "缺少必要配置项: appId, appSecret"
 */
export function t(key: string, params?: Record<string, string | number>): string {
  let text =
    translations[currentLanguage][key] ??
    translations[currentLanguage === 'zh' ? 'en' : 'zh'][key] ??
    key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(`{${k}}`, String(v));
    }
  }
  return text;
}
