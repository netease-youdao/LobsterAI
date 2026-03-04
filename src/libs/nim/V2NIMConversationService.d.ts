import type { NIMEBaseServiceClass, V2NIMError } from './types';
import { V2NIMMessageAttachment, V2NIMMessageRefer, V2NIMMessageRevokeType, V2NIMMessageSendingState, V2NIMMessageType } from './V2NIMMessageService';
/**
 * v2 会话模块
 *
 * 注: v10.8.10 版本后, 本模块接口默认关闭, 受初始化开关影响, 见初始化参数 {@link NIMInitializeOptions.enableV2CloudConversation | NIMInitializeOptions.enableV2CloudConversation}. 也可以用 {@link V2NIMLocalConversationService | V2NIMLocalConversationService} 的同名接口替代
 *
 * 注: 使用 dist/esm 产物时，需要动态引入 V2NIMConversationService 后使用, 见示例
 *
 * @example
 * ```
 * import { NIM, V2NIMConversationService } from 'nim-web-sdk-ng/dist/esm/nim'
 * NIM.registerService(V2NIMConversationService, 'V2NIMConversationService')
 * ```
 */
export declare class V2NIMConversationService extends NIMEBaseServiceClass<V2NIMConversationListener> {
    /**
     * 获取会话列表
     *
     * 注: v10.8.10 版本后, 本模块接口默认关闭, 受初始化开关影响, 见初始化参数 {@link NIMInitializeOptions.enableV2CloudConversation | NIMInitializeOptions.enableV2CloudConversation}. 也可以用 {@link V2NIMLocalConversationService | V2NIMLocalConversationService} 的同名接口替代
     *
     * @param offset 分页偏移量. 首页应传 0, 其他页数据使用返回的 offset
     * @param limit 分页拉取数量，不建议超过 100
     *
     * @example
     * ```typescript
     * const { offset, finished, conversationList } = await nim.V2NIMConversationService.getConversationList(0, 100)
     * ```
     */
    getConversationList(offset: number, limit: number): Promise<V2NIMConversationResult>;
    /**
     * 获取会话列表. 可以指定筛选条件，按会话类型，未读等
     *
     * 注: v10.8.10 版本后, 本模块接口默认关闭, 受初始化开关影响, 见初始化参数 {@link NIMInitializeOptions.enableV2CloudConversation | NIMInitializeOptions.enableV2CloudConversation}. 也可以用 {@link V2NIMLocalConversationService | V2NIMLocalConversationService} 的同名接口替代
     *
     * @param offset 会话标记. 首页应传 0, 其他页数据使用返回的 offset
     * @param limit 分页拉取数量, 不建议超过100
     * @param option 查询选项
     *
     * @example
     * ```typescript
     * const { offset, finished, conversationList } = await nim.V2NIMConversationService.getConversationListByOption(0, 100, {
     *   conversationTypes: [V2NIMConversationType.V2NIM_CONVERSATION_TYPE_P2P]
     *   onlyUnread: true,
     * })
     * ```
     */
    getConversationListByOption(offset: number, limit: number, option: V2NIMConversationOption): Promise<V2NIMConversationResult>;
    /**
     * 根据会话 id 获取单条会话
     *
     * 注: v10.8.10 版本后, 本模块接口默认关闭, 受初始化开关影响, 见初始化参数 {@link NIMInitializeOptions.enableV2CloudConversation | NIMInitializeOptions.enableV2CloudConversation}. 也可以用 {@link V2NIMLocalConversationService | V2NIMLocalConversationService} 的同名接口替代
     *
     * @param conversationId 会话 id
     *
     * @example
     * ```typescript
     * const data = await nim.V2NIMConversationService.getConversation("TARGET_CONVERSATION_ID")
     * ```
     */
    getConversation(conversationId: string): Promise<V2NIMConversation>;
    /**
     * 根据会话 id 获取会话列表
     *
     * 注: v10.8.10 版本后, 本模块接口默认关闭, 受初始化开关影响, 见初始化参数 {@link NIMInitializeOptions.enableV2CloudConversation | NIMInitializeOptions.enableV2CloudConversation}. 也可以用 {@link V2NIMLocalConversationService | V2NIMLocalConversationService} 的同名接口替代
     *
     * @param conversationIds 会话 id 列表
     *
     * @example
     * ```typescript
     * const datas = await nim.V2NIMConversationService.getConversationListByIds(["TARGET_CONVERSATION_ID", "TARGET_CONVERSATION_ID2"]])
     * ```
     */
    getConversationListByIds(conversationIds: string[]): Promise<V2NIMConversation[]>;
    /**
     * 创建会话
     *
     * 注: 会话 id 的值可以参见 {@link V2NIMConversationIdUtil | V2NIMConversationIdUtil}
     *
     * 注: 在操作成功且是有效的操作时, 会抛出事件 {@link V2NIMConversationListener.onConversationCreated | V2NIMConversationListener.onConversationCreated}
     *
     * 注: v10.8.10 版本后, 本模块接口默认关闭, 受初始化开关影响, 见初始化参数 {@link NIMInitializeOptions.enableV2CloudConversation | NIMInitializeOptions.enableV2CloudConversation}. 也可以用 {@link V2NIMLocalConversationService | V2NIMLocalConversationService} 的同名接口替代
     *
     * @param conversationId 会话 id
     *
     * @example
     * ```typescript
     * const datas = await nim.V2NIMConversationService.createConversation("CONVERSATION_ID")
     * ```
     */
    createConversation(conversationId: string): Promise<V2NIMConversation>;
    /**
     * 删除会话
     *
     * 注: 在操作成功且是有效的操作时, 会抛出事件 {@link V2NIMConversationListener.onConversationDeleted | V2NIMConversationListener.onConversationDeleted}
     *
     * 注: v10.8.10 版本后, 本模块接口默认关闭, 受初始化开关影响, 见初始化参数 {@link NIMInitializeOptions.enableV2CloudConversation | NIMInitializeOptions.enableV2CloudConversation}. 也可以用 {@link V2NIMLocalConversationService | V2NIMLocalConversationService} 的同名接口替代
     *
     * @param conversationId 会话 id
     * @param clearMessage 是否删除会话对应的历史消息. 默认为 false
     *
     * @example
     * ```typescript
     * await nim.V2NIMConversationService.deleteConversation("CONVERSATION_ID", true)
     * ```
     */
    deleteConversation(conversationId: string, clearMessage?: boolean): Promise<void>;
    /**
     * 批量删除会话
     *
     * 注: 在操作成功且是有效的操作时, 会抛出事件 {@link V2NIMConversationListener.onConversationDeleted | V2NIMConversationListener.onConversationDeleted}
     *
     * 注: v10.8.10 版本后, 本模块接口默认关闭, 受初始化开关影响, 见初始化参数 {@link NIMInitializeOptions.enableV2CloudConversation | NIMInitializeOptions.enableV2CloudConversation}. 也可以用 {@link V2NIMLocalConversationService | V2NIMLocalConversationService} 的同名接口替代
     *
     * @param conversationIds 会话 id 列表
     * @param clearMessage 是否删除会话对应的历史消息. 默认为 false
     * @returns 返回操作失败的列表，列表的对象包含会话 id 以及错误信息.
     *
     * @example
     * ```typescript
     * await nim.V2NIMConversationService.deleteConversationListByIds(["CONVERSATION_ID1", "CONVERSATION_ID2"], true)
     * ```
     */
    deleteConversationListByIds(conversationIds: string[], clearMessage?: boolean): Promise<V2NIMConversationOperationResult[]>;
    /**
     * 获取置顶会话列表
     *
     * @example
     * ```typescript
     * const datas = await nim.V2NIMConversationService.getStickTopConversationList()
     * ```
     */
    getStickTopConversationList(): Promise<V2NIMConversation[]>;
    /**
     * 置顶会话
     *
     * 注: 在操作成功且是有效的操作时, 则触发事件 {@link V2NIMConversationListener.onConversationChanged | V2NIMConversationListener.onConversationChanged}
     *
     * 注: v10.8.10 版本后, 本模块接口默认关闭, 受初始化开关影响, 见初始化参数 {@link NIMInitializeOptions.enableV2CloudConversation | NIMInitializeOptions.enableV2CloudConversation}. 也可以用 {@link V2NIMLocalConversationService | V2NIMLocalConversationService} 的同名接口替代
     *
     * @param conversationId 会话 id
     * @param stickTop 是否置顶. true: 置顶, false: 取消置顶.
     *
     * @example
     * ```typescript
     * await nim.V2NIMConversationService.stickTopConversation("CONVERSATION_ID", true)
     * ```
     */
    stickTopConversation(conversationId: string, stickTop: boolean): Promise<void>;
    /**
     * 更新会话
     *
     * 注: 在操作成功且是有效的操作时, 触发事件 {@link V2NIMConversationListener.onConversationChanged | V2NIMConversationListener.onConversationChanged}
     *
     * 注: v10.8.10 版本后, 本模块接口默认关闭, 受初始化开关影响, 见初始化参数 {@link NIMInitializeOptions.enableV2CloudConversation | NIMInitializeOptions.enableV2CloudConversation}.
     *
     * @param conversationId 会话 id
     * @param updateInfo 欲更新的信息
     *
     * @example
     * ```typescript
     * await nim.V2NIMConversationService.updateConversation("CONVERSATION_ID", {
     *  serverExtension: "This is a new text"
     * })
     * ```
     */
    updateConversation(conversationId: string, updateInfo: V2NIMConversationUpdate): Promise<void>;
    /**
     * 更新会话的本地扩展字段
     *
     * 注: 在操作成功且是有效的操作时, 触发事件 {@link V2NIMConversationListener.onConversationChanged | V2NIMConversationListener.onConversationChanged}
     *
     * 注: 字段只能存在内存里, 不能持久化存储. 登出或者重新初始化后 localExtension 都会再次成为空字符串.
     *
     * 注: v10.8.10 版本后, 本模块接口默认关闭, 受初始化开关影响, 见初始化参数 {@link NIMInitializeOptions.enableV2CloudConversation | NIMInitializeOptions.enableV2CloudConversation}. 也可以用 {@link V2NIMLocalConversationService | V2NIMLocalConversationService} 的同名接口替代
     *
     * @param conversationId 会话 id
     * @param localExtension 本地扩展信息
     *
     * @example
     * ```typescript
     * await nim.V2NIMConversationService.updateConversationLocalExtension("CONVERSATION_ID", 'newLocalExtension!'})
     * ```
     */
    updateConversationLocalExtension(conversationId: string, localExtension: string): Promise<void>;
    /**
     * 获取全部会话的总的未读数
     *
     * 注: web 端中的表现为, 计算内存里缓存的所有会话的未读数.
     *
     * 注: v10.8.10 版本后, 本模块接口默认关闭, 受初始化开关影响, 见初始化参数 {@link NIMInitializeOptions.enableV2CloudConversation | NIMInitializeOptions.enableV2CloudConversation}. 也可以用 {@link V2NIMLocalConversationService | V2NIMLocalConversationService} 的同名接口替代
     *
     * @example
     * ```typescript
     * const count = nim.V2NIMConversationService.getTotalUnreadCount()
     * ```
     */
    getTotalUnreadCount(): number;
    /**
     * 根据 id 列表获取会话的未读数
     *
     * 注: v10.8.10 版本后, 本模块接口默认关闭, 受初始化开关影响, 见初始化参数 {@link NIMInitializeOptions.enableV2CloudConversation | NIMInitializeOptions.enableV2CloudConversation}. 也可以用 {@link V2NIMLocalConversationService | V2NIMLocalConversationService} 的同名接口替代
     *
     * @param conversationIds 会话 id 列表
     *
     * @example
     * ```typescript
     * const counts = await nim.V2NIMConversationService.getUnreadCountByIds(["CONVERSATION_ID1,CONVERSATION_ID2"])
     * ```
     */
    getUnreadCountByIds(conversationIds: string[]): Promise<number>;
    /**
     * 根据过滤参数获取相应的未读信息
     *
     * 注: web 端中的表现为, 计算内存里缓存的符合条件的会话的未读数.
     *
     * 注: v10.8.10 版本后, 本模块接口默认关闭, 受初始化开关影响, 见初始化参数 {@link NIMInitializeOptions.enableV2CloudConversation | NIMInitializeOptions.enableV2CloudConversation}. 也可以用 {@link V2NIMLocalConversationService | V2NIMLocalConversationService} 的同名接口替代
     *
     * @param filter 过滤条件
     *
     * @example
     * ```ts
     * const unreadCounts = await nim.V2NIMConversationService.getUnreadCountByFilter({ ignoreMuted: true })
     * ```
     */
    getUnreadCountByFilter(filter: V2NIMConversationFilter): Promise<number>;
    /**
     * 清空所有会话总的未读数
     *
     * 注: 当该方法调用后，SDK 可能给开发者抛出以下的事件
     *
     * 注: v10.8.10 版本后, 本模块接口默认关闭, 受初始化开关影响, 见初始化参数 {@link NIMInitializeOptions.enableV2CloudConversation | NIMInitializeOptions.enableV2CloudConversation}. 也可以用 {@link V2NIMLocalConversationService | V2NIMLocalConversationService} 的同名接口替代
     *
     * {@link V2NIMConversationListener.onConversationChanged | V2NIMConversationListener.onConversationChanged} <br/>
     * {@link V2NIMConversationListener.onTotalUnreadCountChanged | V2NIMConversationListener.onTotalUnreadCountChanged} <br/>
     * {@link V2NIMConversationListener.onUnreadCountChangedByFilter | V2NIMConversationListener.onUnreadCountChangedByFilter}
     *
     * @example
     * ```ts
     * await nim.V2NIMConversationService.clearTotalUnreadCount()
     * ```
     */
    clearTotalUnreadCount(): Promise<void>;
    /**
     * 根据会话 id 列表清空相应会话的未读数
     *
     * 注: 当该方法调用后，SDK 可能给开发者抛出以下的事件
     *
     * 注: v10.8.10 版本后, 本模块接口默认关闭, 受初始化开关影响, 见初始化参数 {@link NIMInitializeOptions.enableV2CloudConversation | NIMInitializeOptions.enableV2CloudConversation}. 也可以用 {@link V2NIMLocalConversationService | V2NIMLocalConversationService} 的同名接口替代
     *
     * {@link V2NIMConversationListener.onConversationChanged | V2NIMConversationListener.onConversationChanged} <br/>
     * {@link V2NIMConversationListener.onTotalUnreadCountChanged | V2NIMConversationListener.onTotalUnreadCountChanged} <br/>
     * {@link V2NIMConversationListener.onUnreadCountChangedByFilter | V2NIMConversationListener.onUnreadCountChangedByFilter}
     *
     * @param conversationIds 会话 id 列表
     * @returns 返回操作失败结果的列表
     *
     * @example
     * ```ts
     * const results = await nim.V2NIMConversationService.clearUnreadCountByIds(["CONVERSATION_ID1", "CONVERSATION_ID2"])
     * ```
     */
    clearUnreadCountByIds(conversationIds: string[]): Promise<V2NIMConversationOperationResult[]>;
    /**
     * 清除对应指定分组下的会话的未读数
     *
     * 注: 当该方法调用后，SDK 可能给开发者抛出以下的事件
     *
     * 注: v10.8.10 版本后, 本模块接口默认关闭, 受初始化开关影响, 见初始化参数 {@link NIMInitializeOptions.enableV2CloudConversation | NIMInitializeOptions.enableV2CloudConversation}. 也可以用 {@link V2NIMLocalConversationService | V2NIMLocalConversationService} 的同名接口替代
     *
     * {@link V2NIMConversationListener.onConversationChanged | V2NIMConversationListener.onConversationChanged} <br/>
     * {@link V2NIMConversationListener.onTotalUnreadCountChanged | V2NIMConversationListener.onTotalUnreadCountChanged} <br/>
     * {@link V2NIMConversationListener.onUnreadCountChangedByFilter | V2NIMConversationListener.onUnreadCountChangedByFilter}
     *
     * @param groupId 指定的会话分组 id
     * @example
     * ```ts
     * await nim.V2NIMConversationService.clearUnreadCountByGroupId("GROUP_ID")
     * ```
     */
    clearUnreadCountByGroupId(groupId: string): Promise<void>;
    /**
     * 清除对应指定类型下的会话的未读数
     *
     * 注: 当该方法调用后，SDK 可能给开发者抛出以下的事件
     *
     * 注: v10.8.10 版本后, 本模块接口默认关闭, 受初始化开关影响, 见初始化参数 {@link NIMInitializeOptions.enableV2CloudConversation | NIMInitializeOptions.enableV2CloudConversation}. 也可以用 {@link V2NIMLocalConversationService | V2NIMLocalConversationService} 的同名接口替代
     *
     * {@link V2NIMConversationListener.onConversationChanged | V2NIMConversationListener.onConversationChanged} <br/>
     * {@link V2NIMConversationListener.onTotalUnreadCountChanged | V2NIMConversationListener.onTotalUnreadCountChanged} <br/>
     * {@link V2NIMConversationListener.onUnreadCountChangedByFilter | V2NIMConversationListener.onUnreadCountChangedByFilter}
     *
     * @param types 指定的会话类型列表
     * @example
     * ```ts
     * await nim.V2NIMConversationService.clearUnreadCountByTypes([V2NIMConst.V2NIMConversationType.V2NIM_CONVERSATION_TYPE_P2P])
     * ```
     */
    clearUnreadCountByTypes(types: V2NIMConversationType[]): Promise<void>;
    /**
     * 订阅指定过滤条件的会话未读数变化
     *
     * 注: 当订阅该条件后，该 filter 下的未读数发生变化时, 触发 {@link V2NIMConversationListener.onUnreadCountChangedByFilter | V2NIMConversationListener.onUnreadCountChangedByFilter} 事件
     *
     * 注: 同一种 filter 只能被订阅一次, 第二次的调用不会有任何效果
     *
     * 注: v10.8.10 版本后, 本模块接口默认关闭, 受初始化开关影响, 见初始化参数 {@link NIMInitializeOptions.enableV2CloudConversation | NIMInitializeOptions.enableV2CloudConversation}. 也可以用 {@link V2NIMLocalConversationService | V2NIMLocalConversationService} 的同名接口替代
     *
     * @param filter 过滤条件
     * @example
     * ```ts
     * // Eg. Subscribe to P2P conversation and ignore those muted conversation
     * nim.V2NIMConversationService.subscribeUnreadCountByFilter({
     *   conversationTypes: [V2NIMConst.V2NIMConversationType.V2NIM_CONVERSATION_TYPE_P2P];
     *   ignoreMuted: true;
     * })
     * ```
     */
    subscribeUnreadCountByFilter(filter: V2NIMConversationFilter): void;
    /**
     * 取消订阅指定过滤条件的会话未读变化
     *
     * 注: v10.8.10 版本后, 本模块接口默认关闭, 受初始化开关影响, 见初始化参数 {@link NIMInitializeOptions.enableV2CloudConversation | NIMInitializeOptions.enableV2CloudConversation}. 也可以用 {@link V2NIMLocalConversationService | V2NIMLocalConversationService} 的同名接口替代
     *
     * @param filter 过滤条件
     * @example
     * ```ts
     * // Eg. Subscribe to P2P conversation and ignore those muted conversation
     * const filter = {
     *   conversationTypes: [V2NIMConst.V2NIMConversationType.V2NIM_CONVERSATION_TYPE_P2P];
     *   ignoreMuted: true;
     * }
     * nim.V2NIMConversationService.subscribeUnreadCountByFilter(filter)
     * nim.V2NIMConversationService.unsubscribeUnreadCountByFilter(filter)
     * ```
     */
    unsubscribeUnreadCountByFilter(filter: V2NIMConversationFilter): void;
    /**
     * @deprecated 10.9.0 废弃. 请使用 V2NIMConversation 结构已经包含的 lastReadTime 属性.
     *
     * 取会话已读时间戳。自 10.3.0 版本开始支持
     *
     * 注: v10.8.10 版本后, 本模块接口默认关闭, 受初始化开关影响, 见初始化参数 {@link NIMInitializeOptions.enableV2CloudConversation | NIMInitializeOptions.enableV2CloudConversation}. 也可以用 {@link V2NIMLocalConversationService | V2NIMLocalConversationService} 的同名接口替代
     *
     * @param conversationId 会话id
     * @return 返回会话已读时间戳, 代表这个会话中本账号已读过在这个时间戳之前的所有消息
     * @example
     * ```ts
     * const readTime = await nim.V2NIMConversationService.getConversationReadTime("CONVERSATION_ID")
     * ```
     */
    getConversationReadTime(conversationId: string): Promise<number>;
    /**
     * @deprecated 10.9.0 废弃. 请使用 API clearUnreadCountByIds 替代.
     *
     * 标记会话已读时间戳. 自 10.3.0 版本开始支持
     *
     * 注: 当该方法调用后，SDK 可能给多端账户抛出以下的事件
     *
     * 注: v10.8.10 版本后, 本模块接口默认关闭, 受初始化开关影响, 见初始化参数 {@link NIMInitializeOptions.enableV2CloudConversation | NIMInitializeOptions.enableV2CloudConversation}. 也可以用 {@link V2NIMLocalConversationService | V2NIMLocalConversationService} 的同名接口替代
     *
     * {@link V2NIMConversationListener.onConversationReadTimeUpdated | V2NIMConversationListener.onConversationReadTimeUpdated} <br/>
     * @param conversationId 会话id
     * @return 返回会话已读时间戳, 代表这个会话中本账号已读过在这个时间戳之前的所有消息
     * @example
     * ```ts
     * const readTime = await nim.V2NIMConversationService.markConversationRead("CONVERSATION_ID")
     * ```
     */
    markConversationRead(conversationId: string): Promise<number>;
}
export declare type V2NIMConversationFilter = {
    /**
     * 会话类型列表
     *
     * 注: undefined, [] 空数组. 均表示这个条件不生效
     */
    conversationTypes?: V2NIMConversationType[];
    /**
     * 会话分组 Id
     */
    conversationGroupId?: string;
    /**
     * 是否过滤免打扰的会话类型. 默认 false
     */
    ignoreMuted?: boolean;
};
/**
 * 会话更新的入参
 */
export declare type V2NIMConversationUpdate = {
    /**
     * 更新本地扩展字段
     *
     * 注: web 端没有持久化存储, 内存中存储这个字段, 到下一次初始化时会被清空.
     */
    /**
     * 更新服务端扩展字段
     */
    serverExtension?: string;
};
/**
 * V2NIMConversationService 模块监听事件定义
 *
 * 注: 使用 dist/esm 产物时，需要动态引入 V2NIMConversationService 后使用
 * @example
 * ```
 * import { NIM, V2NIMConversationService } from 'nim-web-sdk-ng/dist/esm/nim'
 * NIM.registerService(V2NIMConversationService, 'V2NIMConversationService')
 * ```
 */
export interface V2NIMConversationListener {
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
    onConversationCreated: [conversation: V2NIMConversation];
    /**
     * 会话被删除
     */
    onConversationDeleted: [conversationIds: string[]];
    /**
     * 会话有更新
     *
     * 注: 诸如置顶, 免打扰更新, 扩展字段更新, 名称头像更新, 未读数变更等操作都会触发这个事件
     */
    onConversationChanged: [conversationList: V2NIMConversation[]];
    /**
     * 总未读数发生变化
     */
    onTotalUnreadCountChanged: [unreadCount: number];
    /**
     * 指定过滤条件的未读数发生变化
     */
    onUnreadCountChangedByFilter: [
        filter: V2NIMConversationFilter & {
            /**
             * 辅助的 filter 对象比较函数. 比对传入的 filter 和本次提供的 filter 是否相等
             *
             * @param filter 要比较的 filter
             */
            equals: (filter: V2NIMConversationFilter) => boolean;
        },
        unreadCount: number
    ];
    /**
     * 请使用 V2NIMConversation 结构已经包含的 lastReadTime 属性
     *
     * - 账号多端登录会话已读时间戳标记通知
     * - 账号A登录设备D1, D2,  D1会话已读时间戳标记，同步到D2成员
     */
    onConversationReadTimeUpdated: [conversationId: string, readTime: number];
}
/**
 * 会话类型的枚举
 */
export declare const enum V2NIMConversationType {
    /** 未知 */
    V2NIM_CONVERSATION_TYPE_UNKNOWN = 0,
    /** 单聊 */
    V2NIM_CONVERSATION_TYPE_P2P = 1,
    /** 群聊 */
    V2NIM_CONVERSATION_TYPE_TEAM = 2,
    /** 超大群 */
    V2NIM_CONVERSATION_TYPE_SUPER_TEAM = 3
}
export declare type V2NIMConversationOption = {
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
    /**
     * 会话分组
     *
     * 注: undefined 表示条件不生效. 而 [] 空数组表示查询不存在分组的会话
     */
    conversationGroupIds?: string[];
};
/**
 * v2 会话结构
 */
export declare type V2NIMConversation = {
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
     * 会话分组
     */
    groupIds?: string[];
    /**
     * 本地扩展
     *
     * 注: web 端没有持久化存储, 内存中存储这个字段. 登出或者重新初始化后这个值都会再次成为空字符串.
     */
    localExtension: string;
    /**
     * 服务端扩展信息
     */
    serverExtension: string;
    /**
     * 会话中最新的消息
     */
    lastMessage?: V2NIMLastMessage | undefined;
    /**
     * 撤回通知.
     *
     * 注: 当消息状态为撤回时, lastMessage 为空, 可以参考这个撤回的通知.
     */
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
     */
    updateTime: number;
    /**
     * 上一会话已读时间点（暨上一次清理未读的时间点）
     */
    lastReadTime: number;
};
export declare type V2NIMConversationResult = {
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
    conversationList: V2NIMConversation[];
};
export declare type V2NIMConversationConfig = {};
/**
 * 会话 ID 工具类
 *
 * @example
 * ```typescript
 * nim.V2NIMConversationIdUtil
 * ```
 */
export interface V2NIMConversationIdUtil {
    /**
     * 构造点对点会话ID
     *
     * @param accountId 对方的账号 id
     * @returns 会话 id
     *
     * @example
     * ```typescript
     * const conversationId = nim.V2NIMConversationIdUtil.p2pConversationId('ACCOUND_ID')
     *
     * // conversationId usage, for example
     * const conversation = await nim.V2NIMConversationService.createConversation(conversationId)
     * ```
     */
    p2pConversationId(accountId: string): string;
    /**
     * 构造群会话ID
     *
     * @param teamId 群 id
     * @returns 会话 id
     *
     * @example
     * ```typescript
     * const conversationId = nim.V2NIMConversationIdUtil.teamConversationId('TEAM_ID')
     *
     * // conversationId usage, for example
     * const conversation = await nim.V2NIMConversationService.createConversation(conversationId)
     * ```
     */
    teamConversationId(teamId: string): string;
    /**
     * 构造超大群会话ID
     *
     * @param superTeamId 超大群 id
     * @returns 会话 id
     *
     * @example
     * ```typescript
     * const conversationId = nim.V2NIMConversationIdUtil.superTeamConversationId('SUPER_TEAM_ID')
     *
     * // conversationId usage, for example
     * const conversation = await nim.V2NIMConversationService.createConversation(conversationId)
     * ```
     */
    superTeamConversationId(superTeamId: string): string;
    /**
     * 解析会话类型
     *
     * @param conversationId 会话 id
     * @returns 会话类型
     *
     * @example
     * ```typescript
     * const conversationType = nim.V2NIMConversationIdUtil.parseConversationType('CONVERSATION_ID')
     * ```
     */
    parseConversationType(conversationId: string): V2NIMConversationType;
    /**
     * 解析会话目标账号
     *
     * @param conversationId 会话 id
     * @returns 点对点会话返回对方账号 id; 群会话返回群 id; 超大群会话返回超大群 id
     *
     * @example
     * ```typescript
     * const targetId = nim.V2NIMConversationIdUtil.parseConversationTargetId('CONVERSATION_ID')
     * ```
     */
    parseConversationTargetId(conversationId: string): string;
}
export declare type V2NIMConversationOperationResult = {
    /**
     * 会话 id
     */
    conversationId: string;
    /**
     * 错误信息
     */
    error: V2NIMError;
};
/**
 * 专供会话使用的最后一条消息的结构
 */
export declare type V2NIMLastMessage = {
    /**
     * 消息状态. 正常, 已撤回, 已回溯
     */
    lastMessageState: V2NIMLastMessageState;
    /**
     * 最后一条消息的摘要
     */
    messageRefer: V2NIMMessageRefer;
    /**
     * 消息类型
     *
     * 注: 当消息状态为正常时, 该字段存在
     */
    messageType?: V2NIMMessageType;
    /**
     * 消息子类型
     *
     * 注: 当消息状态为正常时, 该字段存在
     */
    subType?: number;
    /**
     * 消息发送状态. 发送成功，发送失败，发送中。
     *
     * 注: 只有消息的发送方的本端存在这个字段
     */
    sendingState?: V2NIMMessageSendingState;
    /**
     * 消息的文本内容
     *
     * 注: 当消息状态为已撤回时, 该字段的含义是撤回通知的附言, postscript.
     */
    text?: string;
    /**
     * 消息附属附件
     *
     * 注: 当消息状态为正常时, 该字段存在
     */
    attachment?: V2NIMMessageAttachment;
    /**
     * 消息撤回者账号
     *
     * 注: 当消息状态为已撤回时，该字段存在
     */
    revokeAccountId?: string;
    /**
     * 消息撤回类型
     */
    revokeType?: V2NIMMessageRevokeType;
    /**
     * 消息服务端扩展
     */
    serverExtension?: string;
    /**
     * 第三方回调传入的自定义扩展字段
     */
    callbackExtension?: string;
    /**
     * 该消息的发送者名称
     *
     * 注1: 若最后一条消息被撤回, 则为撤回者相关名称.
     *
     * 注2: 该名称的规则优先级: 该好友的备注(若是好友关系) > 该群成员的昵称(若是群消息) > 该用户的昵称.
     *
     * 注3: 若当前账号就是发送者, 那么这个字段不存在.
     */
    senderName?: string;
};
export declare const enum V2NIMLastMessageState {
    /**
     * 默认状态
     *
     * 注: 本地会话只有这个状态, 没有其他的
     */
    V2NIM_MESSAGE_STATUS_DEFAULT = 0,
    /**
     * 已撤回
     *
     * 注: 云端消息被撤回时, 会将消息状态置为已撤回.
     */
    V2NIM_MESSAGE_STATUS_REVOKE = 1,
    /**
     * 被回溯
     *
     * 注: 当云端会话的最新消息被删除时, 需要回溯找到此时真正的最新消息
     */
    V2NIM_MESSAGE_STATUS_BACKFILL = 2
}
