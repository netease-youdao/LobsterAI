import { IMMessage } from './MsgServiceInterface';
import { V2NIMAIModelCallContent, V2NIMAIModelCallMessage, V2NIMAIModelConfigParams, V2NIMAIRAGInfo } from './V2NIMAIService';
import { V2NIMLoginClientType } from './V2NIMConst';
import { V2NIMConversationType } from './V2NIMConversationService';
import { V2NIMUpdateTeamInfoParams } from './V2NIMTeamService';
import type { NIMEBaseServiceClass } from './types';
/**
 * v2 消息模块
 *
 * 注: 使用 dist/esm 产物时，需要动态引入 V2NIMMessageService 后使用
 *
 * @example
 * ```
 * import { NIM, V2NIMMessageService } from 'nim-web-sdk-ng/dist/esm/nim'
 * NIM.registerService(V2NIMMessageService, 'V2NIMMessageService')
 * ```
 */
export interface V2NIMMessageService extends NIMEBaseServiceClass<V2NIMMessageListener>, V2NIMMessageExtendUtil, V2NIMMessageLogUtil {
}
export declare type V2NIMTextTranslateParams = {
    /** 需要翻译的文本信息 */
    text: string;
    /** 输入文本对应的语言， 如果不传则默认为自动识别，如果明确源语言类型则输入源语言类型标识，支持输入：“auto”， 表示自动识别 */
    sourceLanguage?: string;
    /** 文本翻译的目标语言 */
    targetLanguage: string;
};
export declare type V2NIMTextTranslationResult = {
    /** 翻译结果文本 */
    translatedText: string;
    /** 输入文本对应的语言 */
    sourceLanguage: string;
    /** 翻译结果文本对应的语言 */
    targetLanguage: string;
};
export declare class V2NIMMessageService {
    /**
     * 发送消息
     *
     * @param message 消息体, 由 V2NIMMessageCreator 的对应方法创建
     * @param conversationId 会话 id
     * @param params 发送消息相关配置参数
     * @param progress 发送消息进度回调. 作用于需要上传的文件，图片，音视频消息
     *
     * @example
     * ```js
     * let message = nim.V2NIMMessageCreator.createTextMessage('hello world')
     * const conversationId = nim.V2NIMConversationIdUtil.p2pConversationId('AI_ACCOUND_ID')
     * message = await nim.V2NIMMessageService.sendMessage(message, conversationId)
     * ```
     */
    sendMessage(message: V2NIMMessage, conversationId: string, params?: V2NIMSendMessageParams, progress?: (percentage: number) => void): Promise<V2NIMSendMessageResult>;
    /**
     * 回复消息
     *
     * @param message 需要发送的消息体, 由 V2NIMMessageCreator 的对应方法创建
     * @param replyMessage 被回复的消息
     * @param params 发送消息相关配置参数
     * @param progress 发送消息进度回调. 作用于需要上传的文件，图片，音视频消息
     */
    replyMessage(message: V2NIMMessage, replyMessage: V2NIMMessage, params?: V2NIMSendMessageParams, progress?: (percentage: number) => void): Promise<V2NIMSendMessageResult>;
    /**
     * 撤回消息
     *
     * @param message 需要撤回的消息
     * @param params 撤回消息相关参数
     */
    revokeMessage(message: V2NIMMessage, params?: V2NIMMessageRevokeParams): Promise<void>;
    /**
     * 删除单条消息
     *
     * 注: 操作成功后, SDK 会抛出事件 {@link V2NIMMessageListener.onMessageDeletedNotifications | V2NIMMessageListener.onMessageDeletedNotifications}
     *
     * @param message 需要删除的消息
     * @param serverExtension 扩展字段
     */
    deleteMessage(message: V2NIMMessage, serverExtension?: string): Promise<void>;
    /**
     * 批量删除消息
     *
     * 注: 操作成功后, SDK 会抛出事件 {@link V2NIMMessageListener.onMessageDeletedNotifications | V2NIMMessageListener.onMessageDeletedNotifications} <br/>
     * - 所删除的消息必须是同一会话的消息 <br/>
     * - 限制一次最多删除 50 条消息
     *
     * @param message 需要删除的消息
     * @param serverExtension 扩展字段
     */
    deleteMessages(messages: V2NIMMessage[], serverExtension?: string): Promise<void>;
    /**
     * 发送消息已读回执
     *
     * @param message 点对点会话收到的对方最后一条消息
     */
    sendP2PMessageReceipt(message: V2NIMMessage): Promise<void>;
    /**
     * 查询点对点消息已读回执
     * @param conversationId 会话 id
     */
    getP2PMessageReceipt(conversationId: string): Promise<V2NIMP2PMessageReadReceipt>;
    /**
     * 查询点对点消息是否对方已读
     *
     * @param message 需要查询的消息
     */
    isPeerRead(message: V2NIMMessage): boolean;
    /**
     * 发送群消息已读回执
     *
     * @param messages 需要发送已读回执的消息列表. 限制一批最多 50 个且所有消息必须属于同一个会话
     */
    sendTeamMessageReceipts(messages: V2NIMMessage[]): Promise<void>;
    /**
     * 获取群消息已读回执状态
     *
     * @param messages 获取群消息已读回执状态. 限制一批最多 50 个且所有消息必须属于同一个会话
     */
    getTeamMessageReceipts(messages: V2NIMMessage[]): Promise<V2NIMTeamMessageReadReceipt[]>;
    /**
     * 获取群消息已读回执状态详情
     *
     * @param messages 需要查询已读回执状态的消息. 限制一批最多 50 个且所有消息必须属于同一个会话
     */
    getTeamMessageReceiptDetail(messages: V2NIMMessage, memberAccountIds?: string[]): Promise<V2NIMTeamMessageReadReceiptDetail>;
    /**
     * 取消文件类消息的附件上传
     *
     * 注: 若成功取消, 则算为消息发送失败处理
     *
     * @param message 需要取消附件上传的消息体
     */
    cancelMessageAttachmentUpload(message: V2NIMMessage): Promise<void>;
    /**
     * 更新消息接口
     *
     * @param message 需要修改的消息
     * @param params 修改消息相关配置参数.
     * @returns 修改后的消息
     */
    modifyMessage(message: V2NIMMessage, params: V2NIMModifyMessageParams): Promise<V2NIMModifyMessageResult>;
    /**
     * 注册自定义消息附件解析器，解析 {@link V2NIMMessageType.V2NIM_MESSAGE_TYPE_CUSTOM | V2NIMMessageType.V2NIM_MESSAGE_TYPE_CUSTOM} 类消息的附件
     *
     * 注: 可以注册多个解析器, 后注册的优先级高，优先派发. 一旦某一个解析器返回了一个合法的 attachment 附件对象(即携带 raw 属性的一个对象)，则不继续派发给下一个解析器.
     *
     * @param parser 解析器.
     */
    registerCustomAttachmentParser(parser: V2NIMMessageCustomAttachmentParser): void;
    /**
     * 反注册自定义消息附件解析器
     *
     * 注: 要传递 registerCustomAttachmentParser 所注册的, 引用页相同的那个 parser 解析器, 才能正确反注册.
     *
     * @param parser 解析器函数
     */
    unregisterCustomAttachmentParser(parser: V2NIMMessageCustomAttachmentParser): void;
    /**
     * 停止流式输出
     * @param message 消息体
     * @param params 停止模式等入参
     */
    stopAIStreamMessage(message: V2NIMMessage, params: V2NIMMessageAIStreamStopParams): Promise<void>;
    /**
     * 重新生成 ai 消息
     *
     * 注: 若是流式消息, 必须等到流式分片输出完毕, 才允许调用此 API
     *
     * 此外他支持两种配置
     *
     * 1. 更新，新消息覆盖老消息---只允许更新3天内的消息
     * 2. 新消息，产生一条新消息
     *
     * @param message 需要重新输出的原始数字人消息
     * @param params 确定重新输出的操作类型
     */
    regenAIMessage(message: V2NIMMessage, params: V2NIMMessageAIRegenParams): Promise<void>;
    /**
     * 文本翻译
     *
     * @param params 翻译参数
     */
    translateText(params: V2NIMTextTranslateParams): Promise<V2NIMTextTranslationResult>;
}
/**
 * 自定义消息附件的解析器结构
 *
 * 解析器必须返回一个 {@link V2NIMMessageCustomAttachment | V2NIMMessageCustomAttachment} 类型的对象. SDK 会校验这个对象一定存在属性 "raw".
 *
 * 注: 开发者可以定义 V2NIMMessageCustomAttachment 类型的子类型
 *
 * @param subType 消息的 subType, 参见 {@link V2NIMMessage.subType | V2NIMMessage.subType}. 若消息中不存在 subType, 则默认值为 0.
 * @param attachRaw 消息的附件原始内容, raw 值. 开发者请小心它为空字符串的情况
 * @returns {@link V2NIMMessageCustomAttachment | V2NIMMessageCustomAttachment} 类型的对象. 开发者可以定义 V2NIMMessageCustomAttachment 类型的子类型.
 *
 * 注: 如果返回的对象中 raw 属性一定会被入参的 attachRaw 再次覆盖, 也就是说 raw 作为原始附件内容,  不允许修改.
 */
export declare type V2NIMMessageCustomAttachmentParser = (subType: number, attachRaw: string) => V2NIMMessageCustomAttachment;
export declare type V2NIMModifyMessageResult = {
    /**
     * 默认为 200
     *
     * 注: 如果此错误码为非 200，表示修改消息失败（比如触发了云端反垃圾）, 此时修改成功后的消息体返回为空
     */
    errorCode: number;
    /**
     * 修改成功后的消息体
     */
    message?: V2NIMMessage;
    /**
     * 云端反垃圾返回的结果
     */
    antispamResult?: string;
    /**
     * 客户端本地反垃圾结果
     */
    clientAntispamResult?: V2NIMClientAntispamResult;
};
/**
 * 消息记录查询模块
 *
 * 注: 使用 dist/esm 产物时，需要动态引入 V2NIMMessageLogUtil 后使用
 *
 * @example
 * ```
 * import { NIM, V2NIMMessageLogUtil } from 'nim-web-sdk-ng/dist/esm/nim'
 * NIM.registerService(V2NIMMessageLogUtil, 'V2NIMMessageLogUtil')
 * ```
 */
export declare class V2NIMMessageLogUtil {
    /**
     * 查询历史消息
     *
     * 注: 分页接口，每次默认50条
     *
     * 注: 使用 dist/esm 产物时，需要动态引入 {@link V2NIMMessageLogUtil | V2NIMMessageLogUtil} 后使用
     *
     * @param option 查询消息配置选项
     */
    getMessageList(option: V2NIMMessageListOption): Promise<V2NIMMessage[]>;
    /**
     * 查询历史消息, 且提供分页锚点
     *
     * 注: 分页接口，每次默认50条
     *
     * 注: 使用 dist/esm 产物时，需要动态引入 {@link V2NIMMessageLogUtil | V2NIMMessageLogUtil} 后使用
     *
     * @param option 查询消息配置选项
     */
    getMessageListEx(option: V2NIMMessageListOption): Promise<V2NIMMessageListResult>;
    /**
     * 根据ID列表查询消息
     *
     * 注: 只查询本地数据库. web端不支持该接口
     *
     * 注: 使用 dist/esm 产物时，需要动态引入 {@link V2NIMMessageLogUtil | V2NIMMessageLogUtil} 后使用
     *
     * @param messageClientIds 消息 id 列表
     */
    /**
     * 根据 MessageRefer 列表查询消息
     *
     * 注: 使用 dist/esm 产物时，需要动态引入 {@link V2NIMMessageLogUtil | V2NIMMessageLogUtil} 后使用
     *
     * @param messageRefers 需要查询的消息Refer列表
     */
    getMessageListByRefers(messageRefers: V2NIMMessageRefer[]): Promise<V2NIMMessage[]>;
    /**
     * 清空会话历史消息
     *
     * 注: 使用 dist/esm 产物时，需要动态引入 {@link V2NIMMessageLogUtil | V2NIMMessageLogUtil} 后使用
     *
     * @param option 清空消息参数
     */
    clearHistoryMessage(option: V2NIMClearHistoryMessageOption): Promise<void>;
    /**
     * 仅清空会话漫游消息
     *
     * 注: 使用 dist/esm 产物时，需要动态引入 {@link V2NIMMessageLogUtil | V2NIMMessageLogUtil} 后使用
     *
     * @param conversationIds 会话 id 列表
     */
    clearRoamingMessage(conversationIds: string[]): Promise<void>;
}
/**
 * 消息扩展功能模块
 *
 * 注: 使用 dist/esm 产物时，需要动态引入 V2NIMMessageExtendUtil 后使用
 *
 * @example
 * ```
 * import { NIM, V2NIMMessageExtendUtil } from 'nim-web-sdk-ng/dist/esm/nim'
 * NIM.registerService(V2NIMMessageExtendUtil, 'V2NIMMessageExtendUtil')
 * ```
 */
export declare class V2NIMMessageExtendUtil {
    /**
     * pin 一条消息
     *
     * 注: 操作成功后, SDK 会抛出事件 {@link V2NIMMessageListener.onMessagePinNotification | V2NIMMessageListener.onMessagePinNotification}
     *
     * 注: 使用 dist/esm 产物时，需要动态引入 {@link V2NIMMessageExtendUtil | V2NIMMessageExtendUtil} 后使用
     *
     * @param message 需要被 pin 的消息体
     * @param serverExtension 扩展字段
     */
    pinMessage(message: V2NIMMessage, serverExtension?: string): Promise<void>;
    /**
     * 取消一条Pin消息
     *
     * 注: 使用 dist/esm 产物时，需要动态引入 {@link V2NIMMessageExtendUtil | V2NIMMessageExtendUtil} 后使用
     *
     * @param messageRefer 需要被取消 pin 的消息摘要
     * @param serverExtension 扩展字段
     */
    unpinMessage(messageRefer: V2NIMMessageRefer, serverExtension?: string): Promise<void>;
    /**
     * 更新一条 Pin 消息
     *
     * 注: 使用 dist/esm 产物时，需要动态引入 {@link V2NIMMessageExtendUtil | V2NIMMessageExtendUtil} 后使用
     *
     * @param message 需要被更新 pin 的消息体
     * @param serverExtension 扩展字段
     */
    updatePinMessage(message: V2NIMMessage, serverExtension?: string): Promise<void>;
    /**
     * 获取 pin 消息列表
     *
     * 注: 使用 dist/esm 产物时，需要动态引入 {@link V2NIMMessageExtendUtil | V2NIMMessageExtendUtil} 后使用
     *
     * @param conversationId 会话 ID
     */
    getPinnedMessageList(conversationId: string): Promise<V2NIMMessagePin[]>;
    /**
     * 添加快捷评论
     *
     * 注: 操作成功后, SDK 会抛出事件 {@link V2NIMMessageListener.onMessageQuickCommentNotification | V2NIMMessageListener.onMessageQuickCommentNotification}
     *
     * 注: 使用 dist/esm 产物时，需要动态引入 {@link V2NIMMessageExtendUtil | V2NIMMessageExtendUtil} 后使用
     *
     * @param message 被快捷评论的消息
     * @param index 快捷评论索引. 开发者可以本地构造映射关系, 例如 1 代表 笑脸;  2 代表大笑
     * @param serverExtension 扩展字段, 最大8个字符
     * @param pushConfig 快捷评论推送配置
     */
    addQuickComment(message: V2NIMMessage, index: number, serverExtension?: string, pushConfig?: V2NIMMessageQuickCommentPushConfig): Promise<void>;
    /**
     * 移除快捷评论
     *
     * 注: 使用 dist/esm 产物时，需要动态引入 {@link V2NIMMessageExtendUtil | V2NIMMessageExtendUtil} 后使用
     *
     * @param messageRefer 要移除快捷评论的消息摘要
     * @param index 快捷评论索引
     * @param serverExtension 扩展字段
     */
    removeQuickComment(messageRefer: V2NIMMessageRefer, index: number, serverExtension?: string): Promise<void>;
    /**
     * 获取快捷评论列表
     *
     * 注: 使用 dist/esm 产物时，需要动态引入 {@link V2NIMMessageExtendUtil | V2NIMMessageExtendUtil} 后使用
     *
     * @param message 需要查询快捷评论的消息列表
     * @returns 输出一个对象, key 为 messageClientId, value 为快捷评论列表
     */
    getQuickCommentList(message: V2NIMMessage[]): Promise<{
        [messageClientId: string]: V2NIMMessageQuickComment[];
    }>;
    /**
     * 添加一个收藏
     *
     * 注: 使用 dist/esm 产物时，需要动态引入 {@link V2NIMMessageExtendUtil | V2NIMMessageExtendUtil} 后使用
     *
     * @param params 添加收藏的相关参数
     */
    addCollection(params: V2NIMAddCollectionParams): Promise<V2NIMCollection>;
    /**
     * 移除相关收藏
     *
     * 注: 使用 dist/esm 产物时，需要动态引入 {@link V2NIMMessageExtendUtil | V2NIMMessageExtendUtil} 后使用
     *
     * @param collections 需要移除的相关收藏
     */
    removeCollections(collections: V2NIMCollection[]): Promise<number>;
    /**
     * 更新收藏扩展字段
     *
     * 注: 使用 dist/esm 产物时，需要动态引入 {@link V2NIMMessageExtendUtil | V2NIMMessageExtendUtil} 后使用
     *
     * @param collection 需要更新的收藏信息
     * @param serverExtension 扩展字段. 默认值为空字符串
     */
    updateCollectionExtension(collection: V2NIMCollection, serverExtension?: string): Promise<V2NIMCollection>;
    /**
     * 按条件分页获取收藏信息
     *
     * 注: 使用 dist/esm 产物时，需要动态引入 {@link V2NIMMessageExtendUtil | V2NIMMessageExtendUtil} 后使用
     *
     * @param option 查询参数
     * @deprecated 该方法即将废弃，请使用 {@link V2NIMMessageExtendUtil.getCollectionListExByOption | V2NIMMessageExtendUtil.getCollectionListExByOption}
     */
    getCollectionListByOption(option: V2NIMCollectionOption): Promise<V2NIMCollection[]>;
    /**
     * 按条件分页获取收藏信息
     *
     * 注: 使用 dist/esm 产物时，需要动态引入 {@link V2NIMMessageExtendUtil | V2NIMMessageExtendUtil} 后使用
     *
     * @param option 查询参数
     */
    getCollectionListExByOption(option: V2NIMCollectionOption): Promise<V2NIMCollectionListResult>;
    /**
     * 语音转文本
     *
     * 注: 使用 dist/esm 产物时，需要动态引入 {@link V2NIMMessageExtendUtil | V2NIMMessageExtendUtil} 后使用
     *
     * @param params 参数
     */
    voiceToText(params: V2NIMVoiceToTextParams): Promise<string>;
    /**
     * 检索云端的消息
     *
     * 注: 使用 dist/esm 产物时，需要动态引入 {@link V2NIMMessageExtendUtil | V2NIMMessageExtendUtil} 后使用
     *
     * @param searchParams 检索参数
     */
    searchCloudMessages(searchParams: V2NIMMessageSearchParams): Promise<V2NIMMessage[]>;
    /**
     * 检索云端的消息
     *
     * 注: 使用 dist/esm 产物时，需要动态引入 {@link V2NIMMessageExtendUtil | V2NIMMessageExtendUtil} 后使用
     *
     * @param searchParams 检索参数
     */
    searchCloudMessagesEx(searchParams: V2NIMMessageSearchExParams): Promise<V2NIMMessageSearchResult>;
    /**
     * 查询 thread 聊天云端消息列表
     *
     * 注: 使用 dist/esm 产物时，需要动态引入 {@link V2NIMMessageExtendUtil | V2NIMMessageExtendUtil} 后使用
     */
    getThreadMessageList(option: V2NIMThreadMessageListOption): Promise<V2NIMThreadMessageListResult>;
    /**
     * 设置消息过滤器. v10.9.0 开始支持
     *
     * 机制: 在收消息，拉取消息时, 加的一道过滤函数.
     *
     * 1. 过滤函数结果返回布尔值. 默认为 false 代表不过滤. 而 true 代表要过滤此消息
     * 2. 收消息场景, 若过滤了该消息, 将不触发收消息的事件, 也不会触发本地会话与群通知的相关计算.
     * 3. 拉取消息场景, 若过滤了该消息, 那拉取的返回结果不会包含被过滤的内容.
     * 4. 由于消息过滤器对每一条消息都会生效处理, 处于性能考虑, 所以不推荐在过滤器做重型的逻辑操作.
     *
     * 注: 这道机制是端测行为, 会对云端会话模块产生不可预知的影响, 只建议这个机制只能与本地会话模块配合使用.
     *
     * @param filter 过滤器, 只允许设置一个. 若传入为 null 或者 undefined 则将移除消息过滤器
     */
    setMessageFilter(filter: V2NIMMessageFilter | null | void): void;
}
/**
 * 消息构造类
 *
 * 注: 使用 dist/esm 产物时，只要引入了 {@link V2NIMMessageService | V2NIMMessageService}, 这个构造类就同样被包含了, 不需要再次注册.
 *
 * @example
 * ```
 * const message = nim.V2NIMMessageCreator.createTextMessage('hello world')
 * ```
 */
export declare class V2NIMMessageCreator {
    /**
     * 构造文本消息
     *
     * @param text 文本内容. 不允许为空字符串
     *
     * @example
     * ```
     * const message = nim.V2NIMMessageCreator.createTextMessage('hello world')
     * ```
     */
    createTextMessage(text: string): V2NIMMessage;
    /**
     * 构造图片消息
     *
     * 注: 使用 dist/esm 产物时，需要额外引入 {@link V2NIMStorageService | V2NIMStorageService}, 才能使用上传能力
     *
     * @param imageObj 图片文件. 浏览器环境请传入 File 对象, 小程序及 uniapp 环境请输入临时文件路径
     * @param name 文件显示名称
     * @param sceneName 场景名
     * @param width 图片宽度.
     * @param height 图片高度.
     */
    createImageMessage(imageObj: string | File, name?: string, sceneName?: string, width?: number, height?: number): V2NIMMessage;
    /**
     * 构造语音消息
     *
     * 注: 使用 dist/esm 产物时，需要额外引入 {@link V2NIMStorageService | V2NIMStorageService}, 才能使用上传能力
     *
     * @param audioObj 语音文件. 浏览器环境请传入 File 对象, 小程序及 uniapp 环境请输入临时文件路径
     * @param name 文件显示名称
     * @param sceneName 场景名
     * @param duration 音频时长
     */
    createAudioMessage(audioObj: string | File, name?: string, sceneName?: string, duration?: number): V2NIMMessage;
    /**
     * 构造视频消息
     *
     * 注: 使用 dist/esm 产物时，需要额外引入 {@link V2NIMStorageService | V2NIMStorageService}, 才能使用上传能力
     *
     * @param videoObj 视频文件. 浏览器环境请传入 File 对象, 小程序及 uniapp 环境请输入临时文件路径
     * @param name 文件显示名称
     * @param sceneName 场景名
     * @param duration 音频时长
     * @param width 视频宽度
     * @param height 视频高度
     */
    createVideoMessage(videoObj: string | File, name?: string, sceneName?: string, duration?: number, width?: number, height?: number): V2NIMMessage;
    /**
     * 构造文件消息
     *
     * 注: 使用 dist/esm 产物时，需要额外引入 {@link V2NIMStorageService | V2NIMStorageService}, 才能使用上传能力
     *
     * @param fileObj 文件. 浏览器环境请传入 File 对象, 小程序及 uniapp 环境请输入临时文件路径
     * @param name 文件显示名称
     * @param sceneName 场景名
     */
    createFileMessage(fileObj: string | File, name?: string, sceneName?: string): V2NIMMessage;
    /**
     * 构造地理位置消息
     *
     * @param latitude 纬度
     * @param longitude 经度
     * @param address 详细位置信息
     */
    createLocationMessage(latitude: number, longitude: number, address: string): V2NIMMessage;
    /**
     * 构造自定义消息消息
     *
     * @param text 文本
     * @param rawAttachment 自定义的附件内容
     */
    createCustomMessage(text: string, rawAttachment: string): V2NIMMessage;
    /**
     * 构造自定义消息消息. v10.5.0+ 支持
     *
     * @param attachment 自定义附件, 切记一定要有 raw 属性, 且是其他属性的序列化字符串. 示例 { raw: '{"test":123}', test: 123 }
     * @param subType 消息的子类型, 传入的值大于等于 0
     */
    createCustomMessageWithAttachment(attachment: V2NIMMessageCustomAttachment, subType?: number): V2NIMMessage;
    /**
     * 构造话单消息
     * @param type 话单类型， 业务自定义
     * @param channelId 话单频道ID
     * @param status 通话状态，业务自定义状态
     * @param durations 通话成员时长列表
     * @param text 话单描述
     */
    createCallMessage(type: number, channelId: string, status: number, durations: V2NIMMessageCallDuration[], text?: string): V2NIMMessage;
    /**
     * 构造转发消息，消息内容与原消息一样
     *
     * @param message 需要转发的消息体
     */
    createForwardMessage(message: V2NIMMessage): V2NIMMessage | null;
    /**
     * 构造提示消息
     *
     * @param text 提示文本
     */
    createTipsMessage(text: string): V2NIMMessage;
}
/**
 * 消息附件构造类
 *
 * 注: 使用 dist/esm 产物时，只要引入了 {@link V2NIMMessageService | V2NIMMessageService}, 这个构造类就同样被包含了, 不需要再次注册.
 *
 * @example
 * ```
 * const messageAttachment = nim.V2NIMMessageAttachmentCreator.createCustomMessageAttachment('{"a": 123}')
 * ```
 */
export declare class V2NIMMessageAttachmentCreator {
    /**
     * 构造地理位置消息的附件
     * @param latitude 纬度.
     * @param longitude 经度
     * @param address 详细位置信息. 允许传入空字符串
     */
    createLocationMessageAttachment(latitude: number, longitude: number, address: string): V2NIMMessageLocationAttachment;
    /**
     * 构造自定义消息的附件
     * @param rawAttachment 需要发送的附件内容
     */
    createCustomMessageAttachment(rawAttachment: string): V2NIMMessageAttachment;
}
/**
 * 客户端本地反垃圾工具类
 *
 * 注: 使用 dist/esm 产物时，只要引入了 {@link V2NIMMessageService | V2NIMMessageService}, 这个构造类就同样被包含了, 不需要再次注册.
 *
 * @example
 * ```
 * const result = nim.V2NIMClientAntispamUtil.checkTextAntispam('hujintao', '***')
 * ```
 */
export interface V2NIMClientAntispamUtil {
    /**
     * 对输入的文本进行本地反垃圾检查
     *
     * @param text 文本内容. 不允许为空字符串
     *
     * @example
     * ```
     * const result = nim.V2NIMClientAntispamUtil.checkTextAntispam('hujintao', '***')
     * ```
     */
    checkTextAntispam(text: string, replace?: string): V2NIMClientAntispamResult;
}
/**
 * 消息更新相关参数
 *
 * 可更新字段：subType， text， attachment， serverExtension
 */
export declare type V2NIMModifyMessageParams = {
    /**
     * 消息子类型.
     */
    subType?: number;
    /**
     * 消息内容
     */
    text?: string;
    /**
     * 消息附属附件.
     *
     * 注: 仅允许定位、tip、自定义消息去更新附件信息
     */
    attachment?: V2NIMMessageAttachment;
    /**
     * 消息服务端扩展. 请使用 JSON 序列化的字符串
     */
    serverExtension?: string;
    /**
     * 反垃圾相关配置
     */
    antispamConfig?: V2NIMMessageAntispamConfig;
    /**
     * 路由抄送相关配置
     */
    routeConfig?: V2NIMMessageRouteConfig;
    /**
     * 推送相关配置
     */
    pushConfig?: V2NIMMessagePushConfig;
    /**
     * 是否启用本地反垃圾. 默认 false
     *
     * - 只针对文本消息生效
     * - 发送消息时候，如果为 true，则先本地反垃圾检测，检测后返回 V2NIMClientAntispamOperateType
     *
     * 本地反垃圾有四种结果:
     * - 直接发送消息
     * - 发送替换后的文本
     * - 消息发送失败，返回本地错误码
     * - 消息正常发送，由服务器拦截
     */
    clientAntispamEnabled?: boolean;
    /**
     * 反垃圾命中后的替换文本
     */
    clientAntispamReplace?: string;
};
export declare type V2NIMMessageAttachment = V2NIMMessageAttachmentBase | V2NIMMessageFileAttachment | V2NIMMessageImageAttachment | V2NIMMessageAudioAttachment | V2NIMMessageVideoAttachment | V2NIMMessageLocationAttachment | V2NIMMessageNotificationAttachment | V2NIMMessageCallAttachment | V2NIMMessageCustomAttachment;
export declare type V2NIMMessage = {
    /**
     * 客户端消息ID。可以根据该字段确定消息是否重复
     */
    messageClientId: string;
    /**
     * 发送客户端类型
     */
    fromClientType?: V2NIMLoginClientType;
    /**
     * 服务器消息ID
     *
     * - 消息发送成功后，由服务器更新
     * - 发送成功之前只有客户端消息ID
     */
    messageServerId: string;
    /**
     * 消息创建时间，由服务器返回。在发送成功之前，消息创建时间为发送者本地时间
     */
    createTime: number;
    /**
     * 消息发送者账号
     */
    senderId: string;
    /**
     * 消息接收者账号
     */
    receiverId: string;
    /**
     * 消息所属会话类型
     *
     * 1: p2p
     * 2: team
     * 3: superTeam
     */
    conversationType: V2NIMConversationType;
    /**
     * @computed
     *
     * 会话 ID
     */
    conversationId: string;
    /**
     * @computed
     *
     * 消息发送者是否为自己
     */
    isSelf: boolean;
    /**
     *
     * 消息是否已删除
     */
    isDelete?: boolean;
    /**
     * 附件上传状态
     */
    attachmentUploadState?: V2NIMMessageAttachmentUploadState;
    /**
     * 消息发送状态. 未知(初始状态), 发送成功，发送失败，发送中。
     */
    sendingState: V2NIMMessageSendingState;
    /**
     * 消息类型
     */
    messageType: V2NIMMessageType;
    /**
     * 消息子类型
     */
    subType?: number;
    /**
     * 消息内容
     */
    text?: string;
    /**
     * 消息附属附件
     *
     * 注1: 附件的父级定义是 V2NIMMessageAttachmentBase, 其中包含了一个必定存在的 raw 属性
     *
     * 注2: 根据 {@link V2NIMMessage.messageType | V2NIMMessage.messageType} 的类型, 附件属性的定义类型也有区别: <br/>
     * 1. 文件消息: V2NIMMessageFileAttachment
     * 2. 图片消息: V2NIMMessageImageAttachment
     * 3. 语音消息: V2NIMMessageAudioAttachment
     * 4. 视频消息: V2NIMMessageVideoAttachment
     * 5. 位置消息: V2NIMMessageLocationAttachment
     * 6. 通知消息: V2NIMMessageNotificationAttachment
     * 7. 话单消息: V2NIMMessageCallAttachment
     *
     * 可以使用 as 类型断言, 或者类型保护处理联合类型时进行类型细化, 举个例子
     * @example
     * ```js
     * function testMessageAttachmentType(message: V2NIMMessage): void {
     *   if ('url' in message.attachment) {
     *     if ('width' in message.attachment) {
     *       if ('duration' in message.attachment) {
     *         // message.attachment 到这里就会自动推导出是 V2NIMMessageVideoAttachment 类型
     *       }
     *     }
     *   }
     * }
     * ```
     */
    attachment?: V2NIMMessageAttachment;
    /**
     * 消息服务端扩展
     */
    serverExtension?: string;
    /**
     * 第三方回调扩展字段
     */
    callbackExtension?: string;
    /**
     * 消息的更新时间. 默认 0
     */
    modifyTime?: number;
    /**
     * 该消息更新者账号
     */
    modifyAccountId?: string;
    /**
     * 消息相关配置
     */
    messageConfig?: V2NIMMessageConfig;
    /**
     * 推送相关配置
     */
    pushConfig?: V2NIMMessagePushConfig;
    /**
     * 消息路由配置
     */
    routeConfig?: V2NIMMessageRouteConfig;
    /**
     * 反垃圾相关配置
     */
    antispamConfig?: V2NIMMessageAntispamConfig;
    /**
     * 机器人相关配置
     */
    robotConfig?: V2NIMMessageRobotConfig;
    /**
     * Thread 消息引用
     *
     * 注: 仅回参时存在, 若作为发送接口的入参使用则无效
     */
    threadRoot?: V2NIMMessageRefer;
    /**
     * 回复消息引用
     */
    threadReply?: V2NIMMessageRefer;
    /**
     * 消息的状态相关
     *
     * 注: 仅回参时存在, 若作为发送接口的入参则无效
     */
    messageStatus: V2NIMMessageStatus;
    /**
     * AI 数字人相关
     */
    aiConfig?: V2NIMMessageAIConfig;
    /**
     * 流式输出消息相关
     */
    streamConfig?: V2NIMMessageStreamConfig;
    /**
     * 消息来源
     */
    messageSource?: V2NIMMessageSource;
};
export declare type V2NIMMessageStatus = {
    /**
     * 消息发送错误码
     *
     * 注: 包括如下情况是消息发送成功了, 但是会在这处出现错误码
     *
     * 1，本地命中发垃圾拦截
     * 2，本地发送超时
     * 3，服务器AI响应消息由于反垃圾失败返回
     * 4，服务器AI响应消息由于三方回调拦截返回
     * 5，4两种情况服务器默认下发消息类型为tips消息，同时下发消息错误码， 由端上拦截处理上抛界面
     * 6，被对方拉黑发送失败
     */
    errorCode: number;
};
/**
 * 发送消息时，与数字人相关的参数
 */
export declare type V2NIMMessageAIConfigParams = {
    /**
     * AI 数字人的账号
     */
    accountId: string;
    /**
     * 请求大模型的内容.
     */
    content?: V2NIMAIModelCallContent;
    /**
     * 上下文内容
     *
     * 注: 当前只支持文本消息
     */
    messages?: V2NIMAIModelCallMessage[];
    /**
     * 提示词变量占位符替换. JSON 序列化的字符串
     *
     * 注: 如果 V2NIMAIUser 中的 modelConfig.promptKeys 存在且数组长度不为 0 ，则必填.
     */
    promptVariables?: string;
    /**
     * 请求接口模型相关参数配置
     */
    modelConfigParams?: V2NIMAIModelConfigParams;
    /**
     * 是否是流式响应，默认 false
     */
    aiStream?: boolean;
};
/**
 * 数字人流式消息状态
 */
export declare const enum V2NIMMessageAIStreamStatus {
    /**
     * 流式过程中（本地状态，其他为服务器状态）
     */
    NIM_MESSAGE_AI_STREAM_STATUS_STREAMING = -1,
    /**
     * 非流式状态
     */
    NIM_MESSAGE_AI_STREAM_STATUS_NONE = 0,
    /**
     * 占位
     */
    NIM_MESSAGE_AI_STREAM_STATUS_PLACEHOLDER = 1,
    /**
     * 停止输出
     */
    NIM_MESSAGE_AI_STREAM_STATUS_CANCEL = 2,
    /**
     * 停止并更新
     */
    NIM_MESSAGE_AI_STREAM_STATUS_UPDATE = 3,
    /**
     * 输出完成
     */
    NIM_MESSAGE_AI_STREAM_STATUS_COMPLETE = 4,
    /**
     * 服务器异常终止
     */
    NIM_MESSAGE_AI_STREAM_STATUS_EXCEPTION = 5
}
/**
 * 流式消息分片信息
 */
export declare type V2NIMMessageAIStreamChunk = {
    /**
     * 数字人流式回复分片文本
     */
    content: string;
    /**
     * 数字人流式消息时间，即占位消息时间
     */
    messageTime: number;
    /**
     * 数字人流式消息当前分片时间
     * 注: chunkTime >= messageTime
     */
    chunkTime: number;
    /**
     * 类型，当前仅支持0表示文本
     */
    type: number;
    /**
     * 分片序号，从0开始
     */
    index: number;
};
/**
 * 消息体中的 AI 数字人相关配置
 */
export declare type V2NIMMessageAIConfig = {
    /**
     * AI 数字人的账号
     */
    accountId: string;
    /**
     * 该 AI 消息的询问和应答标识
     *
     * 0 表示普通消息<br/>
     * 1 表示是一个艾特数字人的消息<br/>
     * 2 表示是数字人响应艾特的消息
     */
    aiStatus?: V2NIMMessageAIStatus;
    /**
     * 数字人回复内容的引用资源列表
     */
    aiRAGs?: V2NIMAIRAGInfo[];
    /**
     * @deprecated please use {@link V2NIMMessage.streamConfig | V2NIMMessage.streamConfig}
     *
     * 是否是流式响应，默认false
     */
    aiStream: boolean;
    /**
     * @deprecated please use {@link V2NIMMessage.streamConfig | V2NIMMessage.streamConfig}
     *
     * 数字人流式消息状态
     */
    aiStreamStatus: V2NIMMessageAIStreamStatus;
    /**
     * @deprecated please use {@link V2NIMMessage.streamConfig | V2NIMMessage.streamConfig}
     *
     * 数字人流式消息最近一个分片
     *
     * 注意：流式过程中的消息text是将接收到的分片组装好之后的结果
     */
    aiStreamLastChunk?: V2NIMMessageAIStreamChunk;
};
/**
 * 停止流式输出操作类型
 */
export declare const enum V2NIMMessageAIStreamStopOpType {
    /**
     * 停止输出保持现状
     */
    V2NIM_MESSAGE_AI_STREAM_STOP_OP_DEFAULT = 0,
    /**
     * 停止并撤回消息
     */
    V2NIM_MESSAGE_AI_STREAM_STOP_OP_REVOKE = 1,
    /**
     * 停止并更新消息内容
     */
    V2NIM_MESSAGE_AI_STREAM_STOP_OP_UPDATE = 2
}
/**
 * 流式消息更新内容
 */
export declare type V2NIMMessageAIStreamUpdateContent = {
    /**
     * 更新的文本内容
     */
    msg: string;
    /**
     * 类型, 暂时只有 0, 代表文本，预留扩展能力
     */
    type: number;
};
/**
 * 停止数字人流式输出配置参数
 */
export declare type V2NIMMessageAIStreamStopParams = {
    /**
     * 停止流式消息的操作类型
     */
    operationType: V2NIMMessageAIStreamStopOpType;
    /**
     * 更新的消息内容，仅当operationType == V2NIM_MESSAGE_AI_STREAM_STOP_OP_UPDATE有效
     */
    updateContent?: string;
};
/**
 * 重新输出数字人消息操作类型
 */
export declare const enum V2NIMMessageAIRegenOpType {
    /**
     * 更新消息不会生成新消息
     */
    V2NIM_MESSAGE_AI_REGEN_OP_UPDATE = 1,
    /**
     * 生成一条新消息
     */
    V2NIM_MESSAGE_AI_REGEN_OP_NEW = 2
}
/**
 * 重新输出数字人消息配置参数
 */
export declare type V2NIMMessageAIRegenParams = {
    /**
     * 重新输出数字人消息操作类型
     */
    operationType: V2NIMMessageAIRegenOpType;
};
export declare const enum V2NIMMessageAIStatus {
    /**
     * 未知. 表示普通消息, 非 AI 消息
     */
    V2NIM_MESSAGE_AI_STATUS_UNKNOW = 0,
    /**
     * 表示是一个艾特数字人的消息
     */
    V2NIM_MESSAGE_AI_STATUS_AT = 1,
    /**
     * 表示是数字人响应艾特的消息
     */
    V2NIM_MESSAGE_AI_STATUS_RESPONSE = 2
}
/**
 * 消息模块的事件定义
 *
 * 注: 使用 dist/esm 产物时，需要动态引入 V2NIMMessageService 后使用
 *
 * @example
 * ```
 * import { NIM, V2NIMMessageService } from 'nim-web-sdk-ng/dist/esm/nim'
 * NIM.registerService(V2NIMMessageService, 'V2NIMMessageService')
 * ```
 */
export interface V2NIMMessageListener {
    /**
     * 本端发送消息状态回调。
     *
     * 开发者通过监听 sendingState, 以及 attachmentUploadState 状态，可以实现消息发送状态的监听
     */
    onSendMessage: [message: V2NIMMessage];
    /**
     * 收到新消息
     */
    onReceiveMessages: [messages: V2NIMMessage[]];
    /**
     * 收到点对点消息的已读回执
     */
    onReceiveP2PMessageReadReceipts: [readReceipts: V2NIMP2PMessageReadReceipt[]];
    /**
     * 收到高级群消息的已读回执
     */
    onReceiveTeamMessageReadReceipts: [readReceipts: V2NIMTeamMessageReadReceipt[]];
    /**
     * 收到消息撤回回调
     */
    onMessageRevokeNotifications: [notification: V2NIMMessageRevokeNotification[]];
    /**
     * 收到消息被删除通知
     */
    onMessageDeletedNotifications: [notification: V2NIMMessageDeletedNotification[]];
    /**
     * 清空会话历史消息通知
     */
    onClearHistoryNotifications: [notification: V2NIMClearHistoryNotification[]];
    /**
     * 收到消息 pin 状态更新
     */
    onMessagePinNotification: [notification: V2NIMMessagePinNotification];
    /**
     * 收到消息快捷评论更新
     */
    onMessageQuickCommentNotification: [notification: V2NIMMessageQuickCommentNotification];
    /**
     * 收到消息更新事件
     *
     * 1. 收到更新消息在线同步通知
     * 2. 收到更新消息多端同步通知
     * 3. 收到更新消息漫游通知
     */
    onReceiveMessagesModified: [messages: V2NIMMessage[]];
}
export declare type V2NIMMessageServiceConfig = {
    /**
     * v1 兼容模式. 默认为 true
     */
    compatibleWithV1?: boolean;
};
export declare type V2NIMMessageConfig = {
    /**
     * 是否需要消息(群消息)已读回执。默认为 false
     */
    readReceiptEnabled?: boolean;
    /**
     * 是否需要在服务端保存历史消息。默认为 true
     */
    historyEnabled?: boolean;
    /**
     * 是否需要漫游消息。默认为 true
     */
    roamingEnabled?: boolean;
    /**
     * 是否需要发送方多端在线同步消息。默认为 true
     */
    onlineSyncEnabled?: boolean;
    /**
     * 是否需要存离线消息。默认为 true
     */
    offlineEnabled?: boolean;
    /**
     * 是否需要计算会话的最后一条消息属性。默认为 true
     */
    lastMessageUpdateEnabled?: boolean;
    /**
     * 是否需要计算未读数。默认为 true
     */
    unreadEnabled?: boolean;
};
export interface V2NIMSendMessageParams {
    messageConfig?: V2NIMMessageConfig;
    routeConfig?: V2NIMMessageRouteConfig;
    pushConfig?: V2NIMMessagePushConfig;
    antispamConfig?: V2NIMMessageAntispamConfig;
    robotConfig?: V2NIMMessageRobotConfig;
    /**
     * 请求大模型的相关参数
     */
    aiConfig?: V2NIMMessageAIConfigParams;
    /**
     * 群定向消息相关配置
     */
    targetConfig?: V2NIMMessageTargetConfig;
    /**
     * 是否启用本地反垃圾. 默认 false
     *
     * - 只针对文本消息生效
     * - 发送消息时候，如果为 true，则先本地反垃圾检测，检测后返回 V2NIMClientAntispamOperateType
     *
     * 本地反垃圾有四种结果:
     * - 直接发送消息
     * - 发送替换后的文本
     * - 消息发送失败，返回本地错误码
     * - 消息正常发送，由服务器拦截
     */
    clientAntispamEnabled?: boolean;
    /**
     * 反垃圾命中后的替换文本
     */
    clientAntispamReplace?: string;
}
export interface V2NIMMessageRouteConfig {
    /**
     * 是否需要路由消息（抄送）。默认为 true
     */
    routeEnabled?: boolean;
    /**
     * 环境变量，用于指向不同的抄送，第三方回调等配置
     */
    routeEnvironment?: string;
}
export interface V2NIMMessagePushConfig {
    /**
     * 是否需要推送消息。默认为 true
     */
    pushEnabled?: boolean;
    /**
     * 是否需要推送消息发送者昵称。默认 true
     */
    pushNickEnabled?: boolean;
    /**
     * 推送文案
     */
    pushContent?: string;
    /**
     * 推送自定义 pushPayload
     */
    pushPayload?: string;
    /**
     * 是否需要强制推送，忽略用户消息提醒相关设置。该设置仅在群聊时有效。默认为 false
     */
    forcePush?: boolean;
    /**
     * 强制推送文案。该设置仅在群聊时有效
     */
    forcePushContent?: string;
    /**
     * 强制推送目标账号列表。该设置仅在群聊时有效
     *
     * 注: 不存在则代表着强推给所有人. 空数组代表没有强推目标. 数组有值代表强推给指定的若干个账号
     */
    forcePushAccountIds?: string[];
}
export interface V2NIMMessageAntispamConfig {
    /**
     * 指定消息是否需要经过安全通。默认为 true
     *
     * 对于已开通安全通的用户有效，默认消息都会走安全通，如果对单条消息设置 enable 为 false，则此消息不会走安全通
     */
    antispamEnabled?: boolean;
    /**
     * 指定易盾业务id
     */
    antispamBusinessId?: string;
    /**
     * 自定义消息中需要反垃圾的内容，仅当消息类型为自定义消息时有效
     *
     * 内容必须为 json 格式，格式如下:
     * ```js
     * {
     *   // 1 文本 2 图片 3 视频
     *   "type": 1
     *   // 文本内容；图片地址；视频地址
     *   "data": ""
     * }
     * ````
     */
    antispamCustomMessage?: string;
    /**
     * 易盾反作弊，辅助检测数据，json格式
     */
    antispamCheating?: string;
    /**
     * 易盾反垃圾，增强检测数据，json格式
     */
    antispamExtension?: string;
}
export interface V2NIMMessageRobotConfig {
    /**
     * 机器人账号，对应控制台提前设置好的机器人
     * 仅在群聊中有效，点对点聊天室中该字段会被忽略
     */
    accountId?: string;
    /**
     * 机器人消息话题
     */
    topic?: string;
    /**
     * 机器人具体功能，用户可以自定义输入
     */
    function?: string;
    /**
     * 机器人自定义内容
     */
    customContent?: string;
}
export interface V2NIMMessageTargetConfig {
    /**
     * 定向消息接收者账号列表
     */
    receiverIds: string[];
    /**
     * true 表示接收者为 receiverIds 内的成员，false 表示除 receiverIds 的其它成员接收。超级群场景下 inclusive 必须为 true。
     */
    inclusive: boolean;
    /**
     * 新成员是否可以查看该定向消息, 默认为 false
     */
    newMemberVisible?: boolean;
}
export interface V2NIMMessageRefer {
    /**
     * 发送方账号 id
     */
    senderId: string;
    /**
     * 接收方账号 id
     */
    receiverId: string;
    /**
     * 客户端消息 id
     */
    messageClientId: string;
    /**
     * 服务器消息 id
     */
    messageServerId: string;
    /**
     * 创建时间
     */
    createTime: number;
    /**
     * 会话类型
     */
    conversationType: V2NIMConversationType;
    /**
     * @computed
     * 会话 ID
     */
    conversationId: string;
}
/**
 * 发送消息的返回值
 */
export interface V2NIMSendMessageResult {
    message: V2NIMMessage;
    /**
     * 第三方回调扩展字段，透传字段
     */
    callbackExtension?: string;
    /**
     * 反垃圾返回的结果
     */
    antispamResult?: string;
    /**
     * 客户端反垃圾结果
     */
    clientAntispamResult?: V2NIMClientAntispamResult;
}
/**
 *  消息检索单条会话的返回结果
 */
export interface V2NIMMessageSearchItem {
    /** 会话 ID */
    conversationId: string;
    /** 消息列表 */
    messages: V2NIMMessage[];
    /** 消息数量 */
    count: number;
}
/**
 * 检索返回结果
 */
export interface V2NIMMessageSearchResult {
    /**
     * 满足检索条件的所有消息数量
     */
    count: number;
    /**
     * 检索到的消息列表
     */
    items: V2NIMMessageSearchItem[];
    /**
     * 下一页的 token
     */
    nextPageToken?: string;
    /**
     * 是否还有下一页， 10.9.0 新增
     */
    hasMore: boolean;
}
export declare const enum V2NIMMessageType {
    /** 未知，不合法 */
    V2NIM_MESSAGE_TYPE_INVALID = -1,
    /** 0 文本 */
    V2NIM_MESSAGE_TYPE_TEXT = 0,
    /** 1 图片 */
    V2NIM_MESSAGE_TYPE_IMAGE = 1,
    /** 2 语音 */
    V2NIM_MESSAGE_TYPE_AUDIO = 2,
    /** 3 视频 */
    V2NIM_MESSAGE_TYPE_VIDEO = 3,
    /** 4 位置 */
    V2NIM_MESSAGE_TYPE_LOCATION = 4,
    /** 5 通知 */
    V2NIM_MESSAGE_TYPE_NOTIFICATION = 5,
    /** 6 文件 */
    V2NIM_MESSAGE_TYPE_FILE = 6,
    /** 7 音视频通话 */
    V2NIM_MESSAGE_TYPE_AVCHAT = 7,
    /** 10 提示 */
    V2NIM_MESSAGE_TYPE_TIPS = 10,
    /** 11 机器人 */
    V2NIM_MESSAGE_TYPE_ROBOT = 11,
    /** 12 话单 */
    V2NIM_MESSAGE_TYPE_CALL = 12,
    /** 100 自定义 */
    V2NIM_MESSAGE_TYPE_CUSTOM = 100
}
export declare const enum V2NIMSearchKeywordMatchType {
    /** 或匹配 */
    V2NIM_SEARCH_KEYWORD_MATCH_TYPE_OR = 0,
    /** 且匹配 */
    V2NIM_SEARCH_KEYWORD_MATCH_TYPE_AND = 1
}
export declare const enum V2NIMSearchDirection {
    /** 表示时间从新到老查询 */
    V2NIM_SEARCH_DIRECTION_BACKWARD = 0,
    /** 表示时间从老到新查询 */
    V2NIM_SEARCH_DIRECTION_FORWARD = 1
}
export declare type V2NIMGenericFileAttachment = V2NIMMessageFileAttachment | V2NIMMessageImageAttachment | V2NIMMessageAudioAttachment | V2NIMMessageVideoAttachment;
/**
 * 消息附件的父类定义
 */
export interface V2NIMMessageAttachmentBase {
    /**
     * 原始的附件内容。只有自定义消息类型的附件才会有
     *
     * 注: 一般是一个 JSON 序列化后的字符串, 但是 SDK 不会校验它.
     */
    raw?: string;
}
/**
 * 文件附件属性
 */
export interface V2NIMMessageFileAttachment extends V2NIMMessageAttachmentBase {
    /**
     * 浏览器上传时，得到 DOM 指向的 File 对象。该参数和 path 二选一
     */
    file?: File;
    /**
     * 小程序上传时，得到的临时文件路径。该参数和 file 二选一
     */
    path?: string;
    /**
     * 文件大小
     */
    size: number;
    /**
     * 文件上传后的 URL 路径
     */
    url: string;
    /**
     * 文件 md5.
     *
     * 注: 仅在浏览器环境支持 File 对象时有效
     */
    md5?: string;
    /**
     * 文件扩展名
     */
    ext: string;
    /**
     * 文件显示名称
     */
    name: string;
    /**
     * 文件存储场景
     */
    sceneName: string;
    /**
     * 附件上传状态
     */
    uploadState: V2NIMMessageAttachmentUploadState;
}
/**
 * 图片附件属性
 */
export interface V2NIMMessageImageAttachment extends V2NIMMessageFileAttachment {
    /**
     * 图片宽度
     */
    width: number;
    /**
     * 图片高度
     */
    height: number;
}
/**
 * 语音附件属性
 */
export interface V2NIMMessageAudioAttachment extends V2NIMMessageFileAttachment {
    /**
     * 音频时长
     */
    duration: number;
}
/**
 * 视频附件属性
 */
export interface V2NIMMessageVideoAttachment extends V2NIMMessageFileAttachment {
    /**
     * 视频时长
     */
    duration: number;
    /**
     * 视频宽度
     */
    width: number;
    /**
     * 视频高度
     */
    height: number;
}
/**
 * 位置附件属性
 */
export interface V2NIMMessageLocationAttachment extends V2NIMMessageAttachmentBase {
    /**
     * 纬度
     */
    latitude: number;
    /**
     * 经度
     */
    longitude: number;
    /**
     * 详细位置信息
     */
    address: string;
}
export interface V2NIMMessageCallAttachment extends V2NIMMessageAttachmentBase {
    /**
     * 话单类型， 业务自定义
     */
    type: number;
    /**
     * 话单频道ID
     */
    channelId: string;
    /**
     * 通话状态，业务自定义状态
     */
    status: number;
    /**
     * 通话成员时长列表
     */
    durations: V2NIMMessageCallDuration[];
    /**
     * 话单描述
     */
    text: string;
}
export interface V2NIMMessageCustomAttachment extends V2NIMMessageAttachmentBase {
    raw: string;
}
/**
 * 消息通知中，群信息变更项
 */
declare type V2NIMUpdatedTeamInfo = V2NIMUpdateTeamInfoParams & {
    /**
     * 客户自定义扩展
     *
     * 注: 这个字段仅由 openApi 发请求设置. 而 SDK 只是透传这个字段.
     */
    customerExtension?: string;
};
export interface V2NIMMessageNotificationAttachment extends V2NIMMessageAttachmentBase {
    /**
     * 通知类型
     */
    type: V2NIMMessageNotificationType;
    /**
     * 扩展字段
     */
    serverExtension?: string;
    /**
     * targetIds: 被操作者 id 列表
     */
    targetIds?: string[];
    /**
     * 群成员是否被禁言
     */
    chatBanned?: boolean;
    /**
     * 消息通知中，群信息变更项
     */
    updatedTeamInfo?: V2NIMUpdatedTeamInfo;
}
export declare const enum V2NIMMessageNotificationType {
    /** 未定义通知类型 */
    V2NIM_MESSAGE_NOTIFICATION_TYPE_UNDEFINED = -1,
    /** 群拉人 */
    V2NIM_MESSAGE_NOTIFICATION_TYPE_TEAM_INVITE = 0,
    /** 群踢人 */
    V2NIM_MESSAGE_NOTIFICATION_TYPE_TEAM_KICK = 1,
    /** 退出群 */
    V2NIM_MESSAGE_NOTIFICATION_TYPE_TEAM_LEAVE = 2,
    /** 更新群信息 */
    V2NIM_MESSAGE_NOTIFICATION_TYPE_TEAM_UPDATE_TINFO = 3,
    /** 群解散 */
    V2NIM_MESSAGE_NOTIFICATION_TYPE_TEAM_DISMISS = 4,
    /** 群申请加入通过 */
    V2NIM_MESSAGE_NOTIFICATION_TYPE_TEAM_APPLY_PASS = 5,
    /** 移交群主 */
    V2NIM_MESSAGE_NOTIFICATION_TYPE_TEAM_OWNER_TRANSFER = 6,
    /** 添加管理员 */
    V2NIM_MESSAGE_NOTIFICATION_TYPE_TEAM_ADD_MANAGER = 7,
    /** 移除管理员 */
    V2NIM_MESSAGE_NOTIFICATION_TYPE_TEAM_REMOVE_MANAGER = 8,
    /** 接受邀请进群 */
    V2NIM_MESSAGE_NOTIFICATION_TYPE_TEAM_INVITE_ACCEPT = 9,
    /** 禁言群成员 */
    V2NIM_MESSAGE_NOTIFICATION_TYPE_TEAM_BANNED_TEAM_MEMBER = 10,
    /** 群拉人 */
    V2NIM_MESSAGE_NOTIFICATION_TYPE_SUPER_TEAM_INVITE = 401,
    /** 群踢人 */
    V2NIM_MESSAGE_NOTIFICATION_TYPE_SUPER_TEAM_KICK = 402,
    /** 退出群 */
    V2NIM_MESSAGE_NOTIFICATION_TYPE_SUPER_TEAM_LEAVE = 403,
    /** 更新群信息 */
    V2NIM_MESSAGE_NOTIFICATION_TYPE_SUPER_TEAM_UPDATE_TINFO = 404,
    /** 解散群 */
    V2NIM_MESSAGE_NOTIFICATION_TYPE_SUPER_TEAM_DISMISS = 405,
    /** 群申请加入通过 */
    V2NIM_MESSAGE_NOTIFICATION_TYPE_SUPER_TEAM_APPLY_PASS = 410,
    /** 移交群主 */
    V2NIM_MESSAGE_NOTIFICATION_TYPE_SUPER_TEAM_OWNER_TRANSFER = 406,
    /** 添加管理员 */
    V2NIM_MESSAGE_NOTIFICATION_TYPE_SUPER_TEAM_ADD_MANAGER = 407,
    /** 移除管理员 */
    V2NIM_MESSAGE_NOTIFICATION_TYPE_SUPER_TEAM_REMOVE_MANAGER = 408,
    /** 接受邀请进群 */
    V2NIM_MESSAGE_NOTIFICATION_TYPE_SUPER_TEAM_INVITE_ACCEPT = 411,
    /** 禁言群成员 */
    V2NIM_MESSAGE_NOTIFICATION_TYPE_SUPER_TEAM_BANNED_TEAM_MEMBER = 409
}
export declare const enum V2NIMMessageAttachmentUploadState {
    /** 未知，不存在附件，或者不需要存储的附件 */
    V2NIM_MESSAGE_ATTACHMENT_UPLOAD_STATE_UNKNOWN = 0,
    /** 上传成功 */
    V2NIM_MESSAGE_ATTACHMENT_UPLOAD_STATE_SUCCESS = 1,
    /** 上传失败 */
    V2NIM_MESSAGE_ATTACHMENT_UPLOAD_STATE_FAILED = 2,
    /** 上传中 */
    V2NIM_MESSAGE_ATTACHMENT_UPLOAD_STATE_UPLOADING = 3
}
export declare const enum V2NIMMessageSendingState {
    /** 未知，如果消息不是从这个端发送的 */
    V2NIM_MESSAGE_SENDING_STATE_UNKNOWN = 0,
    /** 发送成功 */
    V2NIM_MESSAGE_SENDING_STATE_SUCCEEDED = 1,
    /** 发送失败 */
    V2NIM_MESSAGE_SENDING_STATE_FAILED = 2,
    /** 发送中 */
    V2NIM_MESSAGE_SENDING_STATE_SENDING = 3
}
export declare const enum V2NIMQueryDirection {
    /** 按时间戳从大到小查询 */
    V2NIM_QUERY_DIRECTION_DESC = 0,
    /** 按时间戳从小到大查询 */
    V2NIM_QUERY_DIRECTION_ASC = 1
}
/**
 * 查询历史消息接口参数
 */
export interface V2NIMMessageListOption {
    /**
     * 会话 id
     */
    conversationId: string;
    /**
     * 根据消息类型查询会话。若为空，或者为空列表，则查询所有消息类型
     */
    messageTypes?: V2NIMMessageType[];
    /**
     * 消息查询开始时间，闭区间
     */
    beginTime?: number;
    /**
     * 消息查询结束时间，闭区间
     */
    endTime?: number;
    /**
     * 每次查询条数。默认为 50
     */
    limit?: number;
    /**
     * 锚点消息，根据锚点消息查询，不包含该消息
     */
    anchorMessage?: V2NIMMessage;
    /** *
     * 查询方向
     */
    direction?: V2NIMQueryDirection;
}
export declare const enum V2NIMClearHistoryMode {
    /**
     * 同时删除云端和本地的消息
     */
    V2NIM_CLEAR_HISTORY_MODE_ALL = 0,
    /**
     * 仅删除本地, 因 Web 端无数据库, 本地特指内存. v10.9.1+ 支持
     *
     * 注: 在该模式下清除后, 调用获取历史消息 API, 仍旧拉取能拉取到历史消息.
     *
     * 注: 在该模式下清除后, 若重新初始化同步依旧能得到消息数据, 从而产生本地会话.
     */
    V2NIM_CLEAR_HISTORY_MODE_LOCAL = 1,
    /**
     * 仅删除本地且历史消息不恢复, 因 Web 端无数据库, 本地特指内存. v10.9.1+ 支持
     *
     * 注: 在该模式下清除后, 记录清除时间. 调用获取历史消息 API, 比清除时间早的消息将被端测过滤掉, 不返回.
     *
     * 注: 在该模式下清除后, 若重新初始化同步依旧从而产生本地会话.
     */
    V2NIM_CLEAR_HISTORY_MODE_LOCAL_IRREPARABLY = 2
}
/**
 * 清空历史消息接口参数
 */
export interface V2NIMClearHistoryMessageOption {
    /**
     * 会话 id
     */
    conversationId: string;
    /**
     * 是否需要删除漫游消息。默认为 true
     */
    deleteRoam?: boolean;
    /**
     * 是否需要通知其它多端同步账户, 默认不同步
     */
    onlineSync?: boolean;
    /**
     * 扩展字段。多端同步时会同步到其它端
     */
    serverExtension?: string;
    /**
     * 清空历史消息模式
     * - 0: 同时删除云端和本地
     * - 1: 仅删除本地, 云端拉取可以恢复
     * 默认为 0
     */
    clearMode?: V2NIMClearHistoryMode;
}
export interface V2NIMMessageRevokeParams {
    /**
     * 附言
     */
    postscript?: string;
    /**
     * 扩展消息
     */
    serverExtension?: string;
    /**
     * 推送文案
     */
    pushContent?: string;
    /**
     * 推送自定义 pushPayload
     */
    pushPayload?: string;
    /**
     * 路由抄送地址
     */
    env?: string;
}
export interface V2NIMMessageRevokeNotification {
    /**
     * 被撤回消息的摘要信息
     */
    messageRefer: V2NIMMessageRefer;
    /**
     * 扩展信息
     */
    serverExtension?: string;
    /**
     * 消息撤回者账号
     */
    revokeAccountId: string;
    /**
     * 附言
     */
    postscript?: string;
    /**
     * 消息撤回类型
     */
    revokeType: V2NIMMessageRevokeType;
    /**
     * 第三方回调传入的自定义扩展字段
     */
    callbackExtension?: string;
}
export declare const enum V2NIMMessageRevokeType {
    /** 未定义 */
    V2NIM_MESSAGE_REVOKE_TYPE_UNDEFINED = 0,
    /** p2p 双向撤回 */
    V2NIM_MESSAGE_REVOKE_TYPE_P2P_BOTHWAY = 1,
    /** 群消息 双向撤回 */
    V2NIM_MESSAGE_REVOKE_TYPE_TEAM_BOTHWAY = 2,
    /** 超大群消息 双向撤回 */
    V2NIM_MESSAGE_REVOKE_TYPE_SUPERTEAM_BOTHWAY = 3,
    /** p2p 单向撤回 */
    V2NIM_MESSAGE_REVOKE_TYPE_P2P_ONEWAY = 4,
    /** 群消息 单向撤回 */
    V2NIM_MESSAGE_REVOKE_TYPE_TEAM_ONEWAY = 5
}
/**
 * p2p 会话已读回执通知
 */
export interface V2NIMP2PMessageReadReceipt {
    /**
     * 会话id
     */
    conversationId: string;
    /**
     * 已读回执时间
     */
    timestamp: number;
}
/**
 * 群消息已读回执通知
 */
export interface V2NIMTeamMessageReadReceipt {
    /**
     * 会话id
     */
    conversationId: string;
    /**
     * 服务器消息id
     */
    messageServerId: string;
    /**
     * 客户端消息id
     */
    messageClientId: string;
    /**
     * 群消息已读人数
     */
    readCount: number;
    /**
     * 群消息未读人数
     */
    unreadCount: number;
    /**
     * 群消息最新已读账号
     */
    latestReadAccount?: string;
}
/**
 * 群消息已读回执详情
 */
export interface V2NIMTeamMessageReadReceiptDetail {
    /** 群消息已读回执 */
    readReceipt: V2NIMTeamMessageReadReceipt;
    /** 已读账号列表 */
    readAccountList: string[];
    /** 未读账号列表 */
    unreadAccountList: string[];
}
/**
 * pin消息通知数据结构
 */
export interface V2NIMMessagePinNotification {
    pinState: V2NIMMessagePinState;
    pin: {
        /**
         * 被 Pin 消息的消息摘要
         */
        messageRefer: V2NIMMessageRefer;
        /**
         * 操作者 id
         */
        operatorId: string;
        /**
         * 扩展字段
         */
        serverExtension: string;
        /**
         * 创建时间。如果是 updatePinMessage, unpinMessage，则没有这个值
         */
        createTime?: number;
        /**
         * 更新时间
         */
        updateTime: number;
    };
}
export declare const enum V2NIMMessagePinState {
    /** 未pin */
    V2NIM_MESSAGE_PIN_STATE_NOT_PINNED = 0,
    /** 已pin */
    V2NIM_MESSAGE_PIN_STATE_PINNED = 1,
    /** 已pin 状态更新 */
    V2NIM_MESSAGE_PIN_STATE_UPDATED = 2
}
export declare const enum V2NIMMessageQuickCommentType {
    /** 添加 */
    V2NIM_QUICK_COMMENT_STATE_ADD = 1,
    /** 移除 */
    V2NIM_QUICK_COMMENT_STATE_REMOVE = 2
}
/**
 * 快捷评论通知数据结构
 */
export interface V2NIMMessageQuickCommentNotification {
    /**
     * 操作类型
     */
    operationType: V2NIMMessageQuickCommentType;
    /**
     * 消息相关的快捷评论
     */
    quickComment: V2NIMMessageQuickComment;
}
/**
 * 客户端反垃圾检查结果
 */
export interface V2NIMClientAntispamResult {
    /**
     * 客户端反垃圾文本命中后操作类型
     */
    operateType: V2NIMClientAntispamOperateType;
    /**
     * 替换后的文本
     */
    replacedText: string;
}
export declare const enum V2NIMClientAntispamOperateType {
    /** 无操作 */
    V2NIM_CLIENT_ANTISPAM_OPERATE_NONE = 0,
    /** 命中后，本地替换 */
    V2NIM_CLIENT_ANTISPAM_OPERATE_REPLACE = 1,
    /** 命中后，本地屏蔽，拒绝发送此消息 */
    V2NIM_CLIENT_ANTISPAM_OPERATE_CLIENT_SHIELD = 2,
    /** 命中后，消息可以发送，服务器屏蔽，即不会转发给其它用户 */
    V2NIM_CLIENT_ANTISPAM_OPERATE_SERVER_SHIELD = 3
}
/**
 * Pin 消息具体内容
 */
export interface V2NIMMessagePin {
    /**
     * 被 pin 的消息
     */
    messageRefer: V2NIMMessageRefer;
    /**
     * 操作者 ID
     */
    opeartorId: string;
    /**
     * 扩展字段
     */
    serverExtension?: string;
    /**
     * 创建时间
     */
    createTime: number;
    /**
     * 更新时间
     */
    updateTime: number;
}
/**
 * 快捷评论推送配置
 */
export interface V2NIMMessageQuickCommentPushConfig {
    /**
     * 是否需要推送消息。默认为 true
     */
    pushEnabled?: boolean;
    /**
     * 是否需要推送角标。默认为 true
     */
    needBadge?: boolean;
    /**
     * 推送标题
     */
    title?: string;
    /**
     * 推送内容
     */
    pushContent?: string;
    /**
     * 推送自定义 pushPayload
     */
    pushPayload?: string;
}
/**
 * 获取某条消息的快捷评论列表
 */
export interface V2NIMMessageQuickComment {
    /**
     * 快捷评论指向的消息
     */
    messageRefer: V2NIMMessageRefer;
    /**
     * 操作者 ID
     */
    operatorId: string;
    /**
     * 评论类型
     */
    index: number;
    /**
     * 扩展字段
     */
    serverExtension: string;
    /**
     * 创建时间
     */
    createTime: number;
    /**
     * 推送配置
     */
    pushConfig?: V2NIMMessageQuickCommentPushConfig;
}
/**
 * 添加收藏消息
 */
export interface V2NIMAddCollectionParams {
    /** 收藏索引，必须大于0，可以按该字段分类 */
    collectionType: number;
    /** 收藏数据 */
    collectionData: string;
    /** 扩展字段 */
    serverExtension?: string;
    /**
     * 去重唯一ID， 如果ID相同， 则不会新增收藏，只更新之前的收藏内容
     * @since 10.2.6
     */
    uniqueId?: string;
}
/**
 * 收藏数据模型
 */
export interface V2NIMCollection {
    /** 收藏信息服务器 ID，由服务器返回 */
    collectionId: string;
    /** 收藏索引 */
    collectionType: number;
    /** 收藏数据 */
    collectionData: string;
    /** 扩展字段 */
    serverExtension?: string;
    /** 创建时间 */
    createTime: number;
    /** 更新时间 */
    updateTime: number;
    /**
     * 去重唯一ID， 如果ID相同， 则不会新增收藏，只更新之前的收藏内容
     * @since 10.2.6
     */
    uniqueId?: string;
}
/**
 * 分页查询收藏返回内容
 */
export interface V2NIMCollectionListResult {
    /** 总收藏条数 */
    totalCount: number;
    /** 本次分页查询返回的收藏列表 */
    collectionList: V2NIMCollection[];
}
/**
 * 查询收藏信息的参数
 */
export interface V2NIMCollectionOption {
    /** 开始时间，默认为 0 */
    beginTime?: number;
    /** 结束时间，默认为当前服务器时间 */
    endTime?: number;
    /**
     * 查询锚点
     *
     * - 如果 anchor 为空，则以 beginTime, endTime 为准
     * - 如果 anchor 不为空
     *  - 如果 direction 为 DESC
     *    - 如果 endTime 不为 0，则必须等于 anchor 时间，否则报错
     *    - endTime 为 0，则以 anchor 时间为准
     *  - 如果 direction 为 ASC
     *    - 如果 beginTime 不为 0，则必须等于 anchor 时间，否则报错
     *    - beginTime 为 0，则以 anchor 时间为准
     * - 查询结果不包括 anchor
     */
    anchorCollection?: V2NIMCollection;
    /** 查询方向 */
    direction?: V2NIMQueryDirection;
    /** 分页限制数量 */
    limit?: number;
    /** 收藏类型。默认为 0。填 0 表示查询所有类型 */
    collectionType?: number;
}
export interface V2NIMMessageSearchParams {
    /** 搜索关键字 */
    keyword: string;
    /** 搜索开始时间 */
    beginTime?: number;
    /** 搜索结束时间 */
    endTime?: number;
    /**
     * 检索的会话数量，默认为 0
     * - 如果为 0，返回结果不按会话分组
     * - 如果不为0，返回结果按会话分组
     *
     * 该参数不同会影响是使用 7_26, 还是 7_27 接口
     */
    conversationLimit?: number;
    /**
     * 返回的最大消息条数，默认为 20
     */
    messageLimit?: number;
    /**
     * 返回结果排序规则
     */
    sortOrder?: V2NIMSortOrder;
    /**
     * p2p账号列表，最大20个，超过20个返回参数错误
     */
    p2pAccountIds?: string[];
    /**
     * 群组id列表，最大20个，超过20个返回参数错误
     */
    teamIds?: string[];
    /**
     * 检索的发送账号列表，最大20个，超过20个返回参数错误
     */
    senderAccountIds: string[];
    /**
     * 检索的消息类型
     */
    messageTypes?: V2NIMMessageType[];
    /**
     * 检索的消息子类型
     */
    messageSubtypes?: number[];
}
export interface V2NIMMessageSearchExParams {
    /**
     * 搜索 “全部会话” 还是搜索 “指定的会话”
     * - conversationID 为空（undefined），搜索全部会话
     * - conversationID 不为空，搜索指定的会话
     */
    conversationId?: string;
    /**
     * 关键字列表，最多支持 5 个。undefined 和size==0 都表示为空
     * - 当消息发送者以及消息类型均未指定时，必须设置关键字列表
     * - 否则，关键字列表可以为空
     */
    keywordList?: string[];
    /**
     * 关键字列表匹配类型
     * - 0：“或” 关系搜索
     * - 1：“与” 关系搜索
     */
    keywordMatchType?: V2NIMSearchKeywordMatchType;
    /**
     * 消息发送者列表，最多支持 5 个。undefined 和size==0 都表示没有指定人数
     */
    senderAccountIds?: string[];
    /**
     * 消息类型列表
     * - 为undefined或空列表， 则表示查询所有消息类型
     * - 关键字不为空时， 不支持检索通知类消息
     * - 非文本消息，只检索对应检索字段，如果检索字段为空则该消息不会被检索到
     */
    messageTypes?: V2NIMMessageType[];
    /**
     * 消息子类型列表
     * - 为undefined或空列表， 则表示查询所有消息子类型
     * - 关键字不为空时，不支持检索通知类消息
     * - 非文本消息，只检索对应检索字段，如果检索字段为空则该消息不会被检索到
     */
    messageSubtypes?: number[];
    /**
     * 搜索开始时间， 默认为 0（从现在开始搜索）。UTC 时间戳，单位：毫秒
     */
    searchStartTime?: number;
    /**
     * 从起始时间点开始的过去时间范围，默认为 0（不限制时间范围）。24 x 60 x 60 x 1000 代表过去一天，单位：毫秒
     */
    searchTimePeriod?: number;
    /**
     * 搜索的数量，最大100
     */
    limit?: number;
    /**
     * 检索方向
     * - 0 从新到老
     * - 1 从老到新
     */
    direction?: V2NIMSearchDirection;
    /**
     * 搜索的起始位置，第一次填写空字符串，续拉时填写上一次返回的 V2NIMMessageSearchResult 中的 nextPageToken
     */
    pageToken?: string;
}
export declare const enum V2NIMSortOrder {
    /** 按时间从大到小排序 */
    V2NIM_SORT_ORDER_DESC = 0,
    /** 按时间从小到大排序 */
    V2NIM_SORT_ORDER_ASC = 1
}
export interface V2NIMMessageDeletedNotification {
    /** 被删除的消息的摘要 */
    messageRefer: V2NIMMessageRefer;
    /** 被删除的时间 */
    deleteTime: number;
    /** 扩展字段 */
    serverExtension?: string;
}
/**
 * http://doc.hz.netease.com/display/MMC/SystemMsgType
 */
export declare const enum V2NIMSystemMessageType {
    /** p2p 会话撤回消息 */
    P2P_DELETE_MSG = 7,
    /** team 会话撤回消息 */
    TEAM_DELETE_MSG = 8,
    /** superTeam 会话撤回消息 */
    SUPERTEAM_DELETE_MSG = 12,
    /** p2p 单向撤回消息。发送方无感知，接收方消息被清除 */
    P2P_ONE_WAY_DELETE_MSG = 13,
    /** team 单向撤回消息。发送方无感知，接收方消息被清除 */
    TEAM_ONE_WAY_DELETE_MSG = 14,
    /** p2p 透传消息 */
    CUSTOM_P2P_MSG = 100,
    /** team 透传消息 */
    CUSTOM_TEAM_MSG = 101,
    /** superTeam 透传消息 */
    CUSTOM_SUPERTEAM_MSG = 103
}
export interface V2NIMClearHistoryNotification {
    conversationId: string;
    deleteTime: number;
    serverExtension?: string;
}
export interface V2NIMVoiceToTextParams {
    /**
     * 本地语音文件路径
     *
     * 注1: 适用于小程序, uniapp 等没有 file 对象的环境 <br/>
     * 注2: voiceUrl, file, voicePath 只需要选填一个
     */
    voicePath?: string;
    /**
     * web 端特有的本地文件对象
     *
     * 注1: 适用于浏览器 <br/>
     * 注2: voiceUrl, file, voicePath 只需要选填一个
     */
    file?: File;
    /**
     * 音频文件的 url.
     *
     * 注1: voiceUrl, file, voicePath 只需要选填一个 <br>
     * 注2: 若无现成的音视频 url，则会从 file 或者 voicePath 中上传并获取音频文件的 url.
     */
    voiceUrl?: string;
    /**
     * 语音时长，单位毫秒
     */
    duration: number;
    /** 音频类型 */
    mimeType?: string;
    /** 采样频率 */
    sampleRate?: string;
    /** 文件存储场景 */
    sceneName?: string;
}
/**
 * v1 和 v2 消息转解析的工具
 *
 * 注: 使用 dist/esm 产物时, 这个模块不存在, 接口无法使用
 */
export declare class DataStructureConverter {
    /**
     * 工具函数。将 V2 消息转化为 V1 消息
     */
    messageConvertToV1: (message: V2NIMMessage) => IMMessage;
    /**
     * 工具函数。将 V1 消息转化为 V2 消息
     */
    messageConvertToV2: (message: IMMessage) => V2NIMMessage;
}
/**
 * 消息序列化与反序列化工具
 *
 * 注: 使用 dist/esm 产物时，需要动态引入 V2NIMMessageConverter 后使用
 *
 * @example
 * ```
 * import { NIM, V2NIMMessageConverter } from 'nim-web-sdk-ng/dist/esm/nim'
 * NIM.registerService(V2NIMMessageConverter, 'V2NIMMessageConverter')
 * ```
 */
export declare class V2NIMMessageConverter {
    /**
     * 工具函数。将消息序列化为字符串
     */
    messageSerialization: (message: V2NIMMessage) => string | null;
    /**
     * 工具函数。将消息字符串反序列化为消息
     */
    messageDeserialization: (message: string) => V2NIMMessage | null;
}
export interface V2NIMThreadMessageListOption {
    /**
     * 需要查询的消息引用。该消息必须为 thread 的根消息，否则查询失败
     */
    messageRefer: V2NIMMessageRefer;
    /**
     * 查询开始时间。默认从 0 开始查询
     */
    beginTime?: number;
    /**
     * 查询结束时间，默认开始时间 + 1小时
     */
    endTime?: number;
    /**
     * 查询消息数量，默认为 50
     */
    limit?: number;
    /**
     * 查询方向，默认为 DESC
     */
    direction?: V2NIMQueryDirection;
    /**
     * 锚点消息ServerId, 该消息必须处于端点，暨消息时间必须等于beginTime或endTime。
     * 如果是合法的消息id则表示排除该消息，否则不排除
     */
    excludeMessageServerId?: string;
}
export interface V2NIMThreadMessageListResult {
    /**
     * 根消息
     */
    message: V2NIMMessage;
    /**
     * 获取 thread 聊天里面最后一条消息的时间戳
     */
    timestamp: number;
    /**
     * 获取 thread 聊天里的总回复数，thread 消息不计入总数
     */
    replyCount: number;
    /**
     * 消息回复列表
     */
    replyList: V2NIMMessage[];
}
export interface V2NIMMessageCallDuration {
    /**
     * 话单对应成员的账号ID
     */
    accountId: string;
    /**
     * 通话时长
     */
    duration: number;
}
/**
 * 查询消息列表返回数据结构
 *
 * 注: API getMessageListEx 的回参.
 */
export declare type V2NIMMessageListResult = {
    /**
     * 本地查询的消息列表
     */
    messages: V2NIMMessage[];
    /**
     * 分页锚点消息.
     *
     * 注: 如果该字段为空，则表示无消息返回, 即没有下一页.
     */
    anchorMessage: V2NIMMessage | null;
};
/**
 * 消息过滤器定义
 */
export declare type V2NIMMessageFilter = {
    /**
     * 过滤函数.
     * @param message 回调一个消息体
     * @returns 返回布尔值. 为 true 代表确认要过滤这条消息, 为 false 代表不忽略这条消息. 默认为 false.
     */
    shouldIgnore: (message: V2NIMMessage) => boolean;
};
export declare type V2NIMMessageStreamConfig = {
    /**
     * 流式消息状态
     */
    status: V2NIMMessageStreamStatus;
    /**
     * 流式消息最近一个分片
     *
     * 注: 流式过程中才有该字段，最终完整消息无此字段
     */
    lastChunk?: V2NIMMessageStreamChunk;
    /**
     * 引用资源列表. v10.9.50+ 支持
     */
    rags?: V2NIMAIRAGInfo[];
};
/**
 * 流式消息状态
 */
export declare const enum V2NIMMessageStreamStatus {
    /**
     * 流式过程中（本地状态，其他为服务器状态）
     */
    NIM_MESSAGE_STREAM_STATUS_STREAMING = -1,
    /**
     * 非流式状态
     */
    NIM_MESSAGE_STREAM_STATUS_NONE = 0,
    /**
     * 占位
     */
    NIM_MESSAGE_STREAM_STATUS_PLACEHOLDER = 1,
    /**
     * 停止输出
     */
    NIM_MESSAGE_STREAM_STATUS_CANCEL = 2,
    /**
     * 停止并更新
     */
    NIM_MESSAGE_AI_STREAM_STATUS_UPDATE = 3,
    /**
     * 输出完成
     */
    NIM_MESSAGE_STREAM_STATUS_COMPLETE = 4,
    /**
     * 服务器异常终止
     */
    NIM_MESSAGE_STREAM_STATUS_EXCEPTION = 5
}
/**
 * 流式消息分片信息
 */
export declare type V2NIMMessageStreamChunk = {
    /**
     * 流式回复分片文本
     */
    content: string;
    /**
     * 流式消息时间，即占位消息时间
     */
    messageTime: number;
    /**
     * 流式消息当前分片时间
     *
     * 注: chunkTime >= messageTime
     */
    chunkTime: number;
    /**
     * 类型，当前仅支持0表示文本
     */
    type: number;
    /**
     * 分片序号，从0开始
     */
    index: number;
};
/**
 * 消息来源
 */
export declare const enum V2NIMMessageSource {
    /**
     * 未知
     */
    V2NIM_MESSAGE_SOURCE_UNKNOWN = 0,
    /**
     * 在线
     */
    V2NIM_MESSAGE_SOURCE_ONLINE = 1,
    /**
     * 离线
     */
    V2NIM_MESSAGE_SOURCE_OFFLINE = 2,
    /**
     * 漫游
     */
    V2NIM_MESSAGE_SOURCE_ROAMING = 3
}
export {};
