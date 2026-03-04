import type { NIMEBaseServiceClass, V2NIMError } from './types';
import { V2NIMConversationType, V2NIMLastMessage } from './V2NIMConversationService';
/**
 * v2 本地会话模块. 自 10.8.0 开始支持
 *
 * 注: 使用 dist/esm 产物时，需要动态引入 V2NIMLocalConversationService 后使用
 * @example
 * ```
 * import { NIM, V2NIMLocalConversationService } from 'nim-web-sdk-ng/dist/esm/nim'
 * NIM.registerService(V2NIMLocalConversationService, 'V2NIMLocalConversationService')
 * ```
 */
export declare class V2NIMLocalConversationService extends NIMEBaseServiceClass<V2NIMLocalConversationListener> {
    /**
     * 获取会话列表
     *
     * @param offset 分页偏移量. 首页应传 0, 其他页数据使用返回的 offset
     * @param limit 分页拉取数量，不建议超过 100
     *
     * @example
     * ```ts
     * const { offset, finished, conversationList } = await nim.V2NIMLocalConversationService.getConversationList(0, 100)
     * ```
     */
    getConversationList(offset: number, limit: number): Promise<V2NIMLocalConversationResult>;
    /**
     * 获取会话列表. 可以指定筛选条件，按会话类型，未读等
     *
     * @param offset 会话标记. 首页应传 0, 其他页数据使用返回的 offset
     * @param limit 分页拉取数量, 不建议超过100
     * @param option 查询选项
     *
     * @example
     * ```ts
     * const { offset, finished, conversationList } = await nim.V2NIMLocalConversationService.getConversationListByOption(0, 100, {
     *   conversationTypes: [V2NIMConst.V2NIMConversationType.V2NIM_CONVERSATION_TYPE_P2P]
     *   onlyUnread: true,
     * })
     * ```
     */
    getConversationListByOption(offset: number, limit: number, option: V2NIMLocalConversationOption): Promise<V2NIMLocalConversationResult>;
    /**
     * 根据会话 id 获取单条会话
     *
     * @param conversationId 会话 id
     *
     * @example
     * ```ts
     * const data = await nim.V2NIMLocalConversationService.getConversation("TARGET_CONVERSATION_ID")
     * ```
     */
    getConversation(conversationId: string): Promise<V2NIMLocalConversation>;
    /**
     * 根据会话 id 获取会话列表
     *
     * @param conversationIds 会话 id 列表
     *
     * @example
     * ```ts
     * const datas = await nim.V2NIMLocalConversationService.getConversationListByIds(["TARGET_CONVERSATION_ID", "TARGET_CONVERSATION_ID2"]])
     * ```
     */
    getConversationListByIds(conversationIds: string[]): Promise<V2NIMLocalConversation[]>;
    /**
     * 创建会话
     *
     * 注: 会话 id 的值可以参见 {@link V2NIMConversationIdUtil | V2NIMConversationIdUtil}
     *
     * 注: 在操作成功且是有效的操作时, 会抛出事件 {@link V2NIMLocalConversationListener.onConversationCreated | V2NIMConversationListener.onConversationCreated}
     *
     * 注: 所以此次创建的会话仅仅存于内存中, 不会持久存储, 除非这个会话存在消息.
     *
     * @param conversationId 会话 id
     *
     * @example
     * ```ts
     * const datas = await nim.V2NIMLocalConversationService.createConversation("CONVERSATION_ID")
     * ```
     */
    createConversation(conversationId: string): Promise<V2NIMLocalConversation>;
    /**
     * 删除会话
     *
     * 注: 在操作成功且是有效的操作时, 会抛出事件 {@link V2NIMLocalConversationListener.onConversationDeleted | V2NIMConversationListener.onConversationDeleted}
     *
     * 注: 如果需要删除云端的漫游/历史消息, 则需要调用 {@link V2NIMMessageService.clearHistoryMessage | V2NIMMessageService.clearHistoryMessage}
     *
     * @param conversationId 会话 id
     * @param clearMessage 是否删除会话对应的本地缓存的历史消息. 默认为 false.
     *
     * @example
     * ```ts
     * await nim.V2NIMLocalConversationService.deleteConversation("CONVERSATION_ID", true)
     * ```
     */
    deleteConversation(conversationId: string, clearMessage?: boolean): Promise<void>;
    /**
     * 批量删除会话
     *
     * 注: 在操作成功且是有效的操作时, 会抛出事件 {@link V2NIMLocalConversationListener.onConversationDeleted | V2NIMLocalConversationListener.onConversationDeleted}
     *
     * 注: 如果需要删除云端的漫游/历史消息, 则需要调用 {@link V2NIMMessageService.clearHistoryMessage | V2NIMMessageService.clearHistoryMessage}
     *
     * @param conversationIds 会话 id 列表
     * @param clearMessage 是否删除会话对应的历史消息. 默认为 false
     * @returns 返回操作失败的列表，列表的对象包含会话 id 以及错误信息.
     *
     * @example
     * ```ts
     * await nim.V2NIMLocalConversationService.deleteConversationListByIds(["CONVERSATION_ID1", "CONVERSATION_ID2"], true)
     * ```
     */
    deleteConversationListByIds(conversationIds: string[], clearMessage?: boolean): Promise<V2NIMLocalConversationOperationResult[]>;
    /**
     * 获取置顶会话列表
     *
     * @example
     * ```ts
     * const datas = await nim.V2NIMLocalConversationService.getStickTopConversationList()
     * ```
     */
    getStickTopConversationList(): Promise<V2NIMLocalConversation[]>;
    /**
     * 置顶会话
     *
     * 注: 在操作成功且是有效的操作时, 则触发事件 {@link V2NIMLocalConversationListener.onConversationChanged | V2NIMLocalConversationListener.onConversationChanged}
     *
     * @param conversationId 会话 id
     * @param stickTop 是否置顶. true: 置顶, false: 取消置顶.
     *
     * @example
     * ```ts
     * await nim.V2NIMLocalConversationService.stickTopConversation("CONVERSATION_ID", true)
     * ```
     */
    stickTopConversation(conversationId: string, stickTop: boolean): Promise<void>;
    /**
     * 更新会话的本地扩展字段
     *
     * 注: 在操作成功且是有效的操作时, 触发事件 {@link V2NIMLocalConversationListener.onConversationChanged | V2NIMLocalConversationListener.onConversationChanged}
     *
     * 注2: 字段只能存在内存里, 不能持久化存储. 登出或者重新初始化后 localExtension 都会再次成为空字符串.
     *
     * @param conversationId 会话 id
     * @param localExtension 本地扩展信息
     *
     * @example
     * ```ts
     * await nim.V2NIMLocalConversationService.updateConversationLocalExtension("CONVERSATION_ID", 'newLocalExtension!'})
     * ```
     */
    updateConversationLocalExtension(conversationId: string, localExtension: string): Promise<void>;
    /**
     * 获取全部会话的总的未读数
     *
     * 注: web 端中的表现为, 计算内存里缓存的所有会话的未读数.
     *
     * @example
     * ```ts
     * const count = nim.V2NIMLocalConversationService.getTotalUnreadCount()
     * ```
     */
    getTotalUnreadCount(): number;
    /**
     * 根据 id 列表获取会话的未读数
     *
     * @param conversationIds 会话 id 列表
     *
     * @example
     * ```ts
     * const unreadCounts = await nim.V2NIMLocalConversationService.getUnreadCountByIds(["CONVERSATION_ID1,CONVERSATION_ID2"])
     * ```
     */
    getUnreadCountByIds(conversationIds: string[]): Promise<number>;
    /**
     * 根据过滤参数获取相应的未读信息
     *
     * 注: web 端中的表现为, 计算内存里缓存的符合条件的会话的未读数.
     *
     * @param filter 过滤条件
     *
     * @example
     * ```ts
     * const unreadCounts = await nim.V2NIMLocalConversationService.getUnreadCountByFilter({ ignoreMuted: true })
     * ```
     */
    getUnreadCountByFilter(filter: V2NIMLocalConversationFilter): Promise<number>;
    /**
     * 清空所有会话总的未读数
     *
     * 注: 当该方法调用后，SDK 可能给开发者抛出以下的事件
     *
     * {@link V2NIMLocalConversationListener.onConversationChanged | V2NIMLocalConversationListener.onConversationChanged} <br/>
     * {@link V2NIMLocalConversationListener.onTotalUnreadCountChanged | V2NIMLocalConversationListener.onTotalUnreadCountChanged} <br/>
     * {@link V2NIMLocalConversationListener.onUnreadCountChangedByFilter | V2NIMLocalConversationListener.onUnreadCountChangedByFilter}
     *
     * @example
     * ```ts
     * await nim.V2NIMLocalConversationService.clearTotalUnreadCount()
     * ```
     */
    clearTotalUnreadCount(): Promise<void>;
    /**
     * 根据会话 id 列表清空相应会话的未读数
     *
     * 注: 当该方法调用后，SDK 可能给开发者抛出以下的事件
     *
     * {@link V2NIMLocalConversationListener.onConversationChanged | V2NIMLocalConversationListener.onConversationChanged} <br/>
     * {@link V2NIMLocalConversationListener.onTotalUnreadCountChanged | V2NIMLocalConversationListener.onTotalUnreadCountChanged} <br/>
     * {@link V2NIMLocalConversationListener.onUnreadCountChangedByFilter | V2NIMLocalConversationListener.onUnreadCountChangedByFilter}
     *
     * @param conversationIds 会话 id 列表
     * @returns 返回操作失败结果的列表
     *
     * @example
     * ```ts
     * const results = await nim.V2NIMLocalConversationService.clearUnreadCountByIds(["CONVERSATION_ID1", "CONVERSATION_ID2"])
     * ```
     */
    clearUnreadCountByIds(conversationIds: string[]): Promise<V2NIMLocalConversationOperationResult[]>;
    /**
     * 清除对应指定类型下的会话的未读数
     *
     * 注: 当该方法调用后，SDK 可能给开发者抛出以下的事件
     *
     * {@link V2NIMLocalConversationListener.onConversationChanged | V2NIMLocalConversationListener.onConversationChanged} <br/>
     * {@link V2NIMLocalConversationListener.onTotalUnreadCountChanged | V2NIMLocalConversationListener.onTotalUnreadCountChanged} <br/>
     * {@link V2NIMLocalConversationListener.onUnreadCountChangedByFilter | V2NIMLocalConversationListener.onUnreadCountChangedByFilter}
     *
     * @param types 指定的会话类型列表
     *
     * @example
     * ```ts
     * await nim.V2NIMLocalConversationService.clearUnreadCountByTypes([V2NIMConst.V2NIMConversationType.V2NIM_CONVERSATION_TYPE_P2P])
     * ```
     */
    clearUnreadCountByTypes(types: V2NIMConversationType[]): Promise<void>;
    /**
     * 订阅指定过滤条件的会话未读数变化
     *
     * 注1: 当订阅该条件后，该 filter 下的未读数发生变化时, 触发 {@link V2NIMLocalConversationListener.onUnreadCountChangedByFilter | V2NIMLocalConversationListener.onUnreadCountChangedByFilter} 事件
     *
     * 注2: 同一种 filter 只能被订阅一次, 第二次的调用不会有任何效果
     *
     * @param filter 过滤条件
     * @example
     * ```ts
     * // Eg. Subscribe to P2P conversation and ignore those muted conversation
     * nim.V2NIMLocalConversationService.subscribeUnreadCountByFilter({
     *   conversationTypes: [V2NIMConst.V2NIMConversationType.V2NIM_CONVERSATION_TYPE_P2P];
     *   ignoreMuted: true;
     * })
     * ```
     */
    subscribeUnreadCountByFilter(filter: V2NIMLocalConversationFilter): void;
    /**
     * 取消订阅指定过滤条件的会话未读变化
     *
     * @param filter 过滤条件
     * @example
     * ```ts
     * // Eg. Subscribe to P2P conversation and ignore those muted conversation
     * const filter = {
     *   conversationTypes: [V2NIMConst.V2NIMConversationType.V2NIM_CONVERSATION_TYPE_P2P];
     *   ignoreMuted: true;
     * }
     * nim.V2NIMLocalConversationService.subscribeUnreadCountByFilter(filter)
     * nim.V2NIMLocalConversationService.unsubscribeUnreadCountByFilter(filter)
     * ```
     */
    unsubscribeUnreadCountByFilter(filter: V2NIMLocalConversationFilter): void;
    /**
     * 获取会话已读时间戳。
     *
     * @param conversationId 会话id
     * @return 返回会话已读时间戳, 代表这个会话中本账号已读过在这个时间戳之前的所有消息
     * @example
     * ```ts
     * const readTime = await nim.V2NIMLocalConversationService.getConversationReadTime("CONVERSATION_ID")
     * ```
     */
    getConversationReadTime(conversationId: string): Promise<number>;
    /**
     * 标记会话已读时间戳
     *
     * 注: 当该方法调用后，SDK 可能给多端账户抛出以下的事件
     *
     * {@link V2NIMLocalConversationListener.onConversationReadTimeUpdated | V2NIMLocalConversationListener.onConversationReadTimeUpdated} <br/>
     * @param conversationId 会话id
     * @return 返回会话已读时间戳, 代表这个会话中本账号已读过在这个时间戳之前的所有消息
     * @example
     * ```ts
     * const readTime = await nim.V2NIMLocalConversationService.markConversationRead("CONVERSATION_ID")
     * ```
     */
    markConversationRead(conversationId: string): Promise<number>;
    /**
     * 设置当前正在聊天的会话. v10.9.40+ 支持
     *
     * 注: 不传, 或者传入为空字符串, 代表取消设置.
     *
     * 注2: 若设置了某个会话为当前正在聊天, 则收到该会话消息所触发的会话变更的未读数不会累加, 且此类情况的总未读数也不累加. 此时 web sdk 将定时向服务器标记已读时间戳.
     *
     * 注3: 若设置了一个未读数大于 0 的会话, 会当即触发会话变更事件及总未读数变更事件.
     *
     * @param conversationId 会话 id
     */
    setCurrentConversation(conversationId?: string): void;
}
export declare type V2NIMLocalConversationFilter = {
    /**
     * 会话类型列表
     *
     * 注: undefined, [] 空数组. 均表示这个条件不生效
     */
    conversationTypes?: V2NIMConversationType[];
    /**
     * 是否过滤免打扰的会话类型. 默认 false
     */
    ignoreMuted?: boolean;
};
export declare type V2NIMLocalConversationOperationResult = {
    /**
     * 会话 id
     */
    conversationId: string;
    /**
     * 错误信息
     */
    error?: V2NIMError;
};
export declare type V2NIMLocalConversationOption = {
    /**
     * 查询的会话类型
     *
     * 注: undefined 或者 [] 空数组. 均表示这个条件不生效
     */
    conversationTypes?: V2NIMConversationType[];
    /**
     * 是否仅查询包含未读数的会话. 默认 false
     *
     * 注: false 不限制, 可查询所有的会话. true 只查询包含未读数的会话.
     */
    onlyUnread?: boolean;
};
export declare type V2NIMLocalConversationConfig = {};
/**
 * v2 本地会话结构
 */
export declare type V2NIMLocalConversation = {
    /**
     * 会话 id
     */
    conversationId: string;
    /**
     * 会话类型
     */
    type: V2NIMConversationType;
    /**
     * @computed
     *
     * 会话名称. 拼接字段
     */
    name?: string;
    /**
     * @computed
     *
     * 头像. 拼接字段
     */
    avatar?: string;
    /**
     * @computed
     *
     * 是否免打扰. 拼接字段
     */
    mute?: boolean;
    /**
     * 是否置顶
     */
    stickTop: boolean;
    /**
     * 本地扩展
     *
     * 注: web 端没有持久化存储, 内存中存储这个字段. 登出或者重新初始化后这个值都会再次成为空字符串.
     */
    localExtension: string;
    /**
     * 会话中最新的消息
     */
    lastMessage?: V2NIMLastMessage | null;
    /**
     * 会话的未读消息计数
     */
    unreadCount: number;
    /**
     * 排序时间戳
     */
    sortOrder: number;
    /**
     * 会话创建时间戳
     */
    createTime: number;
    /**
     * 更新时间戳
     *
     * 注: 仅当最近消息(收发消息,撤回消息), 置顶状态变更时, 更新时间才会得到更新
     */
    updateTime: number;
};
export declare type V2NIMLocalConversationResult = {
    /**
     * 下一页起点的偏移量
     */
    offset: number;
    /**
     * 数据是否已拉取完毕
     *
     * 注: finished 为 true 代表数据已经拉取完毕, offset 也将返回 0
     */
    finished: boolean;
    /**
     * 会话列表
     */
    conversationList: V2NIMLocalConversation[];
};
export interface V2NIMLocalConversationListener {
    /**
     * 会话模块的数据同步开始
     */
    onSyncStarted: [];
    /**
     * 会话模块的数据同步结束
     *
     * 注: 建议开发者若要使用会话模块的数据, 在收到这个事件后再去使用, 以保证数据的完整性.
     */
    onSyncFinished: [];
    /**
     * 会话模块的数据同步失败
     */
    onSyncFailed: [error: V2NIMError];
    /**
     * 会话被创建
     */
    onConversationCreated: [conversation: V2NIMLocalConversation];
    /**
     * 会话被删除
     */
    onConversationDeleted: [conversationIds: string[]];
    /**
     * 会话有更新
     *
     * 注: 诸如置顶, 免打扰更新, 扩展字段更新, 名称头像更新, 未读数变更等操作都会触发这个事件
     */
    onConversationChanged: [conversationList: V2NIMLocalConversation[]];
    /**
     * 总未读数发生变化
     */
    onTotalUnreadCountChanged: [unreadCount: number];
    /**
     * 指定过滤条件的未读数发生变化
     */
    onUnreadCountChangedByFilter: [
        filter: V2NIMLocalConversationFilter & {
            /**
             * 辅助的 filter 对象比较函数. 比对传入的 filter 和本次提供的 filter 是否相等
             *
             * @param filter 要比较的 filter
             */
            equals: (filter: V2NIMLocalConversationFilter) => boolean;
        },
        unreadCount: number
    ];
    /**
     * - 账号多端登录会话已读时间戳标记通知
     * - 账号A登录设备D1, D2,  D1会话已读时间戳标记，同步到D2成员
     */
    onConversationReadTimeUpdated: [conversationId: string, readTime: number];
}
