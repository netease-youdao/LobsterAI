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
    // DeepSeek Harness (experimental)
    dshWorkbenchTitle: 'DeepSeek Harness 工作台（实验）',
    dshPlanProviderName: '套餐',

    // Tray menu
    trayShowWindow: '打开 LobsterAI',
    trayNewTask: '新建任务',
    trayViewCompletedTask: '查看完成的任务',
    trayCompletedTaskTooltip: 'LobsterAI - {count} 个任务已完成',
    traySettings: '设置',
    trayQuit: '退出',

    // Quit confirmation (native dialog shown on user-initiated quit)
    appQuitConfirmTitle: '退出 LobsterAI？',
    appQuitConfirmDetail: 'LobsterAI 关闭期间，定时任务不会运行，也无法回复 IM 消息。',
    appQuitConfirmQuit: '退出',
    appQuitConfirmCancel: '取消',
    taskCompletionNotificationTitle: '任务已完成',
    taskCompletionNotificationBody: '有任务已完成，点击查看结果',
    taskCompletionOverlayDescription: '有任务已完成',
    permissionNotificationTitle: '等待你的确认',
    permissionNotificationBody: 'Agent 请求执行 {toolName}，等待你的确认',
    permissionNotificationBodyGeneric: 'Agent 请求执行操作，等待你的确认',
    questionNotificationTitle: '等待你的回答',
    questionNotificationBody: '需要你回答问题后才能继续',
    browserCredentialApprovalHeader: '保存的登录信息',
    browserCredentialApprovalTitle: '允许 Agent 自动登录',
    browserCredentialApprovalSubtitle: 'LobsterAI 将在隔离页面中填写，密码不会提供给 Agent。',
    browserCredentialApprovalQuestion: '是否允许 Agent 使用账号 {username} 登录 {origin}？',
    browserCredentialApprovalReason: 'Agent 给出的原因：{reason}',
    browserCredentialApprovalAllow: '允许并继续',
    browserCredentialApprovalAllowDescription: '自动填写已保存的账号密码并继续当前任务',
    browserCredentialApprovalDeny: '拒绝',
    browserCredentialApprovalDenyDescription: '不使用保存的登录信息',
    browserCredentialSelectionQuestion: '选择允许 Agent 用于登录 {origin} 的账号',
    browserCredentialSelectionTitle: '选择登录账号',
    browserCredentialSelectionSubtitle: '选定后，LobsterAI 将自动完成账号密码填写。',
    browserCredentialSelectionDescription: '使用该账号继续登录',
    contextMenuCut: '剪切',
    contextMenuCopy: '复制',
    contextMenuPaste: '粘贴',
    contextMenuSelectAll: '全选',
    agentBrowserMenuScreenshot: '截图',
    agentBrowserMenuNewBlankPage: '空白页',
    agentBrowserMenuZoom: '缩放',
    agentBrowserMenuZoomOut: '缩小',
    agentBrowserMenuResetZoom: '重置为 100%',
    agentBrowserMenuZoomIn: '放大',
    agentBrowserMenuClearCookies: '清除 Cookie',
    agentBrowserMenuClearCache: '清除缓存',
    agentBrowserMenuUnavailable: '浏览器窗口当前不可用。',
    agentBrowserRuntimeUnavailable: 'Agent 浏览器暂不可用，请稍后重试。',
    agentBrowserMenuOpenFailed: '无法打开浏览器菜单。',
    agentBrowserZoomFailed: '调整浏览器缩放失败。',

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
    taskOutputTruncated:
      '[输出未完成] 模型已达到本次输出长度上限。部分结果已保留，但任务未确认完成；你可以继续对话以从中断处继续。',

    // Feishu bot install
    feishuVerifyCredentialsFailed: '凭证验证失败，请检查 App ID 和 App Secret 是否正确',
    feishuVerifyFailed: '验证失败',

    // Cowork error messages (shared with renderer via classifyErrorKey)
    coworkErrorAuthInvalid: 'API 密钥无效或已过期，请检查配置。',
    coworkErrorLobsterAILoginExpired: '登录状态已过期，请重新登录后继续使用 LobsterAI 套餐模型。',
    coworkErrorOAuthInvalid: 'OAuth 授权已失效或权限不足，请重新授权后重试。',
    coworkErrorModelAccessDenied: '当前账号无权访问该模型，请切换模型或检查服务商账号权限。',
    coworkErrorQuotaExhausted:
      '积分额度已用完，请升级套餐后继续使用。[立即升级/充值](https://lobsterai.youdao.com/portal#/pricing)',
    coworkErrorFreeQuotaExhausted:
      '积分额度已用完，请升级套餐后继续使用。[立即升级/充值](https://lobsterai.youdao.com/portal#/pricing)',
    coworkErrorEnterpriseMemberQuotaExhausted: '当前团队成员周期额度已用完。',
    coworkErrorEnterprisePoolExhausted: '当前团队积分池已用完。',
    coworkErrorEnterpriseCreditBatchesExpired: '当前团队积分批次已全部过期。',
    coworkErrorInsufficientBalance: 'API 余额不足，请充值后重试。',
    coworkErrorInputTooLong: '输入内容过长，超出模型上下文限制。',
    coworkErrorMessageTooLarge:
      '本次消息过大，请减少附件、压缩图片或拆分提交。（单次整体需小于 30MB）',
    coworkErrorCouldNotProcessPdf: '无法处理 PDF 文件。',
    coworkErrorModelNotFound: '请求的模型不存在或不可用。',
    coworkGatewaySessionSyncTimeout: 'OpenClaw 引擎响应缓慢，消息尚未发送。请等待 1~2 分钟后重新发送；若频繁出现，请检查系统内存与磁盘占用，并将 LobsterAI 加入杀毒软件白名单。',
    coworkErrorTranscriptOversized: '该任务的历史记录过大。为保护 AI 引擎，本次消息未发送；请新建任务继续，原任务记录仍会保留。',
    coworkErrorGatewayHeapOutOfMemory: '本地 AI 引擎内存不足并已自动重启。当前任务可能过大，请等待恢复后在新任务中继续。',
    coworkErrorGatewayDisconnected: 'AI 引擎连接中断，请重试。',
    coworkErrorServiceRestart: 'AI 引擎正在重启，请稍后重试。',
    coworkErrorGatewayDraining: 'AI 引擎正在重启中，请稍等片刻后重试。',
    openClawConfigApplyPending: 'OpenClaw 正在应用配置，请稍后重试。',
    openClawConfigApplyOverdue:
      'OpenClaw 正在等待活动任务结束后应用配置。请完成或停止活动任务，然后重试。',
    coworkErrorModelResponseTimeout: '模型响应超时，请稍后重试。',
    coworkErrorNetworkError: '网络连接失败，请检查网络设置。',
    coworkErrorRateLimit: '请求过于频繁，请稍后再试。',
    coworkErrorModelOverloaded: '模型服务当前繁忙或容量不足，请稍后重试。',
    coworkErrorContentFiltered: '内容未通过安全审核，请修改后重试。',
    coworkErrorToolLoopBlocked:
      '检测到 AI 在重复执行同一个工具调用且没有新的进展（通常是在等待一个耗时较长的后台任务），本轮已被安全停止。后台任务可能仍在运行，可以继续发消息让 AI 接着处理。',
    coworkErrorServerError: '服务端出现错误，请稍后重试。',
    coworkErrorEngineNotReady: 'AI 引擎正在启动中，请稍等几秒后重试。',
    serverModelMetadataUnavailable: '套餐模型信息暂不可用，请刷新后重试。',
    serverModelRuntimeProfileUnsupported: '该套餐模型的任务兼容配置不受当前版本支持。',
    serverModelToolCallingUnavailable: '该模型尚未开放任务工具调用。',
    serverModelAgenticNotReady: '该模型正在进行任务能力验证，请稍后再试。',
    coworkErrorModelStreamEmptySseData:
      '模型流式响应格式异常：模型服务返回了空的 SSE data 帧。请稍后重试，或检查当前模型代理配置。',
    coworkErrorModelStreamOnlyEmptySseData:
      '模型流式响应一直为空：模型服务连续返回空的 SSE data 帧。请稍后重试，或检查当前模型代理配置。',
    coworkErrorUnknown: '任务执行出错，请重试。如果问题持续出现，请检查模型配置。',
    coworkBtwDisconnected: 'AI 引擎连接中断，顺便问问未能完成。',
    coworkBtwTimeout: '顺便问问等待回答超时，请重试。',
    coworkBtwInvalidResult: 'AI 引擎返回了无效的顺便问问结果。',
    coworkBtwFailed: '顺便问问回答失败，请重试。',
    coworkBtwRequestRequired: '会话、运行标识和问题不能为空。',
    coworkBtwInvalidIdentifier: '顺便问问的会话或运行标识无效。',
    coworkBtwQuestionRequired: '请输入顺便问问的问题。',
    coworkBtwSingleLine: '顺便问问暂时只支持单行问题。',
    coworkBtwResultTruncated: '（回答过长，已截断）',
    coworkBtwAlreadyPending: '当前对话已有一个正在回答的顺便问问。',
    coworkBtwRunConflict: '顺便问问的运行标识与现有任务冲突。',
    coworkBtwSessionNotFound: '找不到会话 {sessionId}。',
    coworkBtwUnavailable: '当前运行时暂不支持顺便问问。',
    coworkBtwSubmitFailed: '提交顺便问问失败。',
    coworkBtwNoPending: '找不到正在回答的顺便问问。',
    coworkBtwStopFailed: '停止顺便问问失败，请重试。',
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
    enterpriseAccountContextMismatchTitle: '团队身份已失效',
    enterpriseAccountContextMismatchMessage:
      '当前团队身份与登录凭证不一致。相关图片和视频任务已停止轮询，请重新登录或重新选择团队身份后再试。',
    enterpriseAccountContextMismatchConfirm: '知道了',
    authAccountChanged: '登录账号已发生变化，请重试。',
    authLoginRequired: '请先登录后再试。',
    mediaTaskAccountMismatch: '该媒体任务属于其他账号，无法操作。',
    enterpriseMediaQuotaUnavailable: '当前团队的媒体生成额度暂不可用。',

    // Data migration dialogs
    dataMigrationBackupDialogTitle: '备份 LobsterAI 数据',
    dataMigrationRestoreDialogTitle: '导入 LobsterAI 数据备份',
    dataMigrationBackupArchiveFilter: 'LobsterAI 备份包',
    dataMigrationAllFilesFilter: '所有文件',
    dataMigrationBackupBlockedByActiveWorkloads:
      '当前有正在运行的 Agent 或定时任务，请停止或等待任务完成后再备份。',
    dataMigrationRestoreProgressTitle: '正在导入 LobsterAI 数据',
    dataMigrationRestoreProgressDesc: '正在恢复备份并校验数据，完成后应用会自动重启。',
    dataMigrationRestoreProgressWarning: '请不要关闭应用或重启电脑，否则可能中断本次数据迁移。',

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

    htmlShareAccessModeUpdateFailed: '访问方式更新失败。',
    htmlShareStatusUpdateFailed: '分享开关更新失败。',
    nodeDeploymentAccessStatusApplyFailed: '服务已部署，但访问状态更新失败：{message}',

    'enterprise.updateBlocked': '版本更新由企业统一管理',
  },
  en: {
    // DeepSeek Harness (experimental)
    dshWorkbenchTitle: 'DeepSeek Harness Workbench (Experimental)',
    dshPlanProviderName: 'Plan',

    // Tray menu
    trayShowWindow: 'Open LobsterAI',
    trayNewTask: 'New Task',
    trayViewCompletedTask: 'View Completed Task',
    trayCompletedTaskTooltip: 'LobsterAI - {count} completed task(s)',
    traySettings: 'Settings',
    trayQuit: 'Quit',

    // Quit confirmation (native dialog shown on user-initiated quit)
    appQuitConfirmTitle: 'Quit LobsterAI?',
    appQuitConfirmDetail: 'While LobsterAI is closed, scheduled tasks will not run and IM messages will not be answered.',
    appQuitConfirmQuit: 'Quit',
    appQuitConfirmCancel: 'Cancel',
    taskCompletionNotificationTitle: 'Task Complete',
    taskCompletionNotificationBody: 'A task has finished. Click to view the result.',
    taskCompletionOverlayDescription: 'Task complete',
    permissionNotificationTitle: 'Waiting for Your Confirmation',
    permissionNotificationBody: 'The agent requests to run {toolName} and is waiting for your confirmation.',
    permissionNotificationBodyGeneric: 'The agent requests to run an action and is waiting for your confirmation.',
    questionNotificationTitle: 'Waiting for Your Answer',
    questionNotificationBody: 'Waiting for your answer to continue.',
    browserCredentialApprovalHeader: 'Saved login',
    browserCredentialApprovalTitle: 'Allow Agent sign-in',
    browserCredentialApprovalSubtitle: 'LobsterAI fills the isolated page without revealing the password to the Agent.',
    browserCredentialApprovalQuestion: 'Allow the Agent to sign in to {origin} as {username}?',
    browserCredentialApprovalReason: 'Reason from the Agent: {reason}',
    browserCredentialApprovalAllow: 'Allow and continue',
    browserCredentialApprovalAllowDescription: 'Fill the saved username and password and continue the current task',
    browserCredentialApprovalDeny: 'Deny',
    browserCredentialApprovalDenyDescription: 'Do not use the saved login',
    browserCredentialSelectionQuestion: 'Choose an account the Agent may use to sign in to {origin}',
    browserCredentialSelectionTitle: 'Choose a sign-in account',
    browserCredentialSelectionSubtitle: 'LobsterAI will fill the selected account automatically.',
    browserCredentialSelectionDescription: 'Continue with this account',
    contextMenuCut: 'Cut',
    contextMenuCopy: 'Copy',
    contextMenuPaste: 'Paste',
    contextMenuSelectAll: 'Select All',
    agentBrowserMenuScreenshot: 'Screenshot',
    agentBrowserMenuNewBlankPage: 'Blank page',
    agentBrowserMenuZoom: 'Zoom',
    agentBrowserMenuZoomOut: 'Zoom out',
    agentBrowserMenuResetZoom: 'Reset to 100%',
    agentBrowserMenuZoomIn: 'Zoom in',
    agentBrowserMenuClearCookies: 'Clear Cookie',
    agentBrowserMenuClearCache: 'Clear cache',
    agentBrowserMenuUnavailable: 'The browser window is unavailable.',
    agentBrowserRuntimeUnavailable: 'The Agent browser is temporarily unavailable. Try again later.',
    agentBrowserMenuOpenFailed: 'Failed to open the browser menu.',
    agentBrowserZoomFailed: 'Failed to adjust browser zoom.',

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
    taskOutputTruncated:
      '[Output incomplete] The model reached the output limit for this response. The partial result was preserved, but the task is not confirmed complete. Continue the conversation to resume.',

    // Feishu bot install
    feishuVerifyCredentialsFailed:
      'Credential validation failed. Please check your App ID and App Secret.',
    feishuVerifyFailed: 'Verification failed',

    // Cowork error messages
    coworkErrorAuthInvalid: 'Invalid or expired API key. Please check your configuration.',
    coworkErrorLobsterAILoginExpired:
      'Your login session has expired. Sign in again to continue using LobsterAI plan models.',
    coworkErrorOAuthInvalid: 'OAuth authorization is invalid or missing required access. Re-authenticate and try again.',
    coworkErrorModelAccessDenied: 'This account is not allowed to access the selected model. Switch models or check provider account permissions.',
    coworkErrorQuotaExhausted:
      'Your credits have been used up. Upgrade your plan to continue.\n\n[Upgrade or recharge](https://lobsterai.youdao.com/portal#/pricing)',
    coworkErrorFreeQuotaExhausted:
      'Your credits have been used up. Upgrade your plan to continue.\n\n[Upgrade or recharge](https://lobsterai.youdao.com/portal#/pricing)',
    coworkErrorEnterpriseMemberQuotaExhausted: 'The current team member period quota has been used up.',
    coworkErrorEnterprisePoolExhausted: 'The current team credit pool has been used up.',
    coworkErrorEnterpriseCreditBatchesExpired: 'All credit batches for the current team have expired.',
    coworkErrorInsufficientBalance: 'Insufficient API balance. Please top up and try again.',
    coworkErrorInputTooLong: 'Input too long, exceeding model context limit.',
    coworkErrorMessageTooLarge:
      'This message is too large. Reduce attachments, compress images, or split it up. (Keep each message under about 30 MB.)',
    coworkErrorCouldNotProcessPdf: 'Unable to process the PDF file.',
    coworkErrorModelNotFound: 'The requested model does not exist or is unavailable.',
    coworkGatewaySessionSyncTimeout: 'The OpenClaw engine is responding slowly and your message has not been sent. Please wait a minute or two and resend. If this happens frequently, check system memory and disk usage, and add LobsterAI to your antivirus allowlist.',
    coworkErrorTranscriptOversized: 'This task history is too large. The message was not sent to protect the AI engine. Continue in a new task; the original task will be preserved.',
    coworkErrorGatewayHeapOutOfMemory: 'The local AI engine ran out of memory and is restarting automatically. This task may be too large; wait for recovery and continue in a new task.',
    coworkErrorGatewayDisconnected: 'AI engine connection lost. Please retry.',
    coworkErrorServiceRestart: 'AI engine is restarting. Please try again later.',
    coworkErrorGatewayDraining: 'AI engine is restarting. Please wait a moment and try again.',
    openClawConfigApplyPending: 'OpenClaw is applying configuration. Please try again shortly.',
    openClawConfigApplyOverdue:
      'OpenClaw is waiting for active tasks to finish before applying configuration. Complete or stop the active tasks, then try again.',
    coworkErrorModelResponseTimeout: 'The model response timed out. Please try again.',
    coworkErrorNetworkError: 'Network connection failed. Please check your network settings.',
    coworkErrorRateLimit: 'Too many requests. Please try again later.',
    coworkErrorModelOverloaded:
      'The model service is temporarily busy or at capacity. Please try again later.',
    coworkErrorContentFiltered:
      'Content did not pass the safety review. Please modify and try again.',
    coworkErrorToolLoopBlocked:
      'This turn was stopped safely because the AI kept repeating the same tool call with no new progress (usually while waiting on a slow background task). The background task may still be running — send another message to continue.',
    coworkErrorServerError: 'Server error occurred. Please try again later.',
    coworkErrorEngineNotReady: 'AI engine is starting up. Please wait a few seconds and try again.',
    serverModelMetadataUnavailable:
      'Package model information is temporarily unavailable. Refresh and try again.',
    serverModelRuntimeProfileUnsupported:
      'This package model task profile is not supported by the current version.',
    serverModelToolCallingUnavailable:
      'Agent tool calling is not enabled for this model yet.',
    serverModelAgenticNotReady:
      'This model is still undergoing agent capability validation. Please try again later.',
    coworkErrorModelStreamEmptySseData:
      'Model stream format error: the model service returned an empty SSE data frame. Please retry later or check the current model proxy configuration.',
    coworkErrorModelStreamOnlyEmptySseData:
      'Model stream stayed empty: the model service kept returning empty SSE data frames. Please retry later or check the current model proxy configuration.',
    coworkErrorUnknown:
      'Task failed due to an unexpected error. Please retry. If the issue persists, check your model configuration.',
    coworkBtwDisconnected: 'The AI engine disconnected before the BTW side question completed.',
    coworkBtwTimeout: 'The BTW side question timed out. Please try again.',
    coworkBtwInvalidResult: 'The AI engine returned an invalid BTW side-question result.',
    coworkBtwFailed: 'The BTW side question failed. Please try again.',
    coworkBtwRequestRequired: 'Session, run id, and BTW side question are required.',
    coworkBtwInvalidIdentifier: 'The BTW session or run identifier is invalid.',
    coworkBtwQuestionRequired: 'Enter a BTW side question.',
    coworkBtwSingleLine: 'BTW side questions currently support one line only.',
    coworkBtwResultTruncated: '(Answer truncated because it was too long.)',
    coworkBtwAlreadyPending: 'This conversation already has a pending BTW side question.',
    coworkBtwRunConflict: 'The BTW side-question run id conflicts with an existing run.',
    coworkBtwSessionNotFound: 'Session {sessionId} was not found.',
    coworkBtwUnavailable: 'BTW side questions are unavailable in the current runtime.',
    coworkBtwSubmitFailed: 'Failed to submit the BTW side question.',
    coworkBtwNoPending: 'No pending BTW side question was found.',
    coworkBtwStopFailed: 'Failed to stop the BTW side question. Please try again.',
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
    enterpriseAccountContextMismatchTitle: 'Team identity expired',
    enterpriseAccountContextMismatchMessage:
      'Your team identity no longer matches the login credentials. Related image and video polling has stopped. Sign in again or choose a team identity before retrying.',
    enterpriseAccountContextMismatchConfirm: 'OK',
    authAccountChanged: 'The signed-in account changed. Try again.',
    authLoginRequired: 'Sign in and try again.',
    mediaTaskAccountMismatch: 'This media task belongs to another account.',
    enterpriseMediaQuotaUnavailable: 'Media generation quota is unavailable for this team.',

    // Data migration dialogs
    dataMigrationBackupDialogTitle: 'Back Up LobsterAI Data',
    dataMigrationRestoreDialogTitle: 'Import LobsterAI Data Backup',
    dataMigrationBackupArchiveFilter: 'LobsterAI Backup',
    dataMigrationAllFilesFilter: 'All Files',
    dataMigrationBackupBlockedByActiveWorkloads:
      'An agent or scheduled task is still running. Stop it or wait for it to finish before backing up.',
    dataMigrationRestoreProgressTitle: 'Importing LobsterAI data',
    dataMigrationRestoreProgressDesc:
      'Restoring the backup and validating data. LobsterAI will restart automatically when finished.',
    dataMigrationRestoreProgressWarning:
      'Do not close the app or restart the computer, or the migration may be interrupted.',

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

    htmlShareAccessModeUpdateFailed: 'Failed to update access mode.',
    htmlShareStatusUpdateFailed: 'Failed to update share access.',
    nodeDeploymentAccessStatusApplyFailed:
      'The service was deployed, but its access settings could not be updated: {message}',

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
