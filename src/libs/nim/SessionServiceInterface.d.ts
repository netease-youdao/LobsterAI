import { IMMessage, TMsgScene } from './MsgServiceInterface';
/**
 * 调用方式:
 * ```js
 * nim.session.getSession(options)
 * ```
 */
export interface SessionServiceInterface {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 根据 sessionId 从内存中获取会话
     *
     * 会话保存在内存中的 im 实例里。
     * @locale
     *
     * @locale en
     * Get a conversation from the memory based on sessionId.
     *
     * Conversations are kept in the IM instance in the memory.
     * @locale
     */
    getSession(options: SessionIdOptions): Session | void;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 获取内存中的会话列表，支持分页
     *
     * @deprecated
     *
     * 请使用 {@link SessionServiceInterface.getAllSessions} 代替该函数
     * @locale
     *
     * @locale en
     * Get the conversation list in the memory; support paging.
     * @locale
     */
    getSessions(options: GetSessionsOptions): Session[];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 获取内存中的全部会话列表
     * @locale
     *
     * @locale en
     * Get all the conversation list in the memory;
     * @locale
     */
    getAllSessions(): Session[];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 重置某个会话的未读数
     *
     * - 如果选中会话的未读数都是 0，则不会有任何效果
     * - 如果有会话未读数为 0，则会将其未读数置为 0，同时会收到多个 {@link IMEventInterface.updateSession | updateSession} 事件
     * - 多端同步用户也会收到 {@link IMEventInterface.updateSession | updateSession} 事件
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/session/%E6%9C%AA%E8%AF%BB%E6%B6%88%E6%81%AF%E6%95%B0%E9%87%8F.js" target="_blank">未读消息数量</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * Reset unread count for a conversation.
     *
     * If it is an existing conversation, the unread count of the conversation will be set to 0. In addition, the instance can receive the updateSession event. Once the instance receives the event, the unread count of the conversation will be updated.
     * Afterwards, this conversation will still update the unread count after receiving messages.
     * The updated unread count will be synchronized to other devices in the case of multi-device login.
     * @locale
     */
    resetSessionUnreadCount(options: SessionIdOptions): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 批量重置多个会话未读数
     *
     * - 如果所有选中会话的未读数都是 0，则不会有任何效果
     * - 如果有会话未读数为 0，则会将其未读数置为 0，同时会收到多个 {@link IMEventInterface.updateSession | updateSession} 事件
     * - 多端同步用户也会收到 {@link IMEventInterface.updateSession | updateSession} 事件
     *
     * 如果是已经存在的会话记录, 会将此会话未读数置为 0，并且实例能收到 updateSession 事件代表会话被更新
     * 之后此会话在收到消息之后依然会更新未读数
     * 会同步至多端登录的其他端
     *
     * @locale
     *
     * @locale en
     * Reset unread count for some conversation.
     *
     * If it is an existing conversation, the unread count of the conversation will be set to 0. In addition, the instance can receive the updateSession event. Once the instance receives the event, the unread count of the conversation will be updated.
     * Afterwards, this conversation will still update the unread count after receiving messages.
     * The updated unread count will be synchronized to other devices in the case of multi-device login.
     * You can reset up to ten sessions at a time
     * @locale
     */
    resetMultiSessionUnreadCount(options: NIM_SessionIdsOptions): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 重置所有会话的未读数
     *
     * - 如果所有会话的未读数都是 0，则不会有任何效果
     * - 如果有会话未读数为 0，则会将其未读数置为 0，同时会收到多个 {@link IMEventInterface.updateSession | updateSession} 事件
     * - 多端同步用户也会收到 {@link IMEventInterface.updateSession | updateSession} 事件
     *
     * @locale
     *
     * @locale en
     * Reset unread count for all conversations.
     *
     * If it is an existing conversation, the unread count of the conversation will be set to 0. In addition, the instance can receive the updateSession event. Once the instance receives the event, the unread count of the conversation will be updated.
     * After that, this conversation will still update the unread count when receiving messages.
     * The updated unread count will be synchronized to other devices in the case of multi-device login.
     * @locale
     */
    resetAllSessionsUnreadCount(): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 设置当前会话（废弃）
     *
     * 去掉这个接口，推荐客户以后调用不同的接口去实现。替代作法：
     * 1. 先调用 resetSessionUnreadCount + sendMsgReceipt 清除一遍会话和未读的意思，
     * 2. 然后让开发者记录当前激活的是哪个会话，每当收到 updateSession 事件，判断后调用 resetSessionUnreadCount 清除此会话未读数
     *
     * 会将此会话未读数置为 0，并且实例能收到 updateSession 事件代表会话被更新
     * 之后此会话在收到消息之后不会更新未读数
     * @locale
     *
     * @locale en
     * Set the current conversation (deprecated).
     *
     * The API is deprecated; it is recommended that you use the method below instead:
     * 1. Call resetSessionUnreadCount and sendMsgReceipt to clear the conversation and unread messages,
     * 2. Manually record the currently-activated conversation, and whenever you receive the updateSession event, call resetSessionUnreadCount to clear the unread count of the conversation.
     *
     * The unread count of the conversation will be set to 0. Once the instance receives the updateSession event, the conversation is updated.
     * After that, the conversation will NOT update the unread count when receiving messages.
     * @locale
     */
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 重置当前会话
     *
     * 同上，去掉这个接口
     *
     * 重置当前会话后, 所有会话在收到消息之后会更新未读数
     * @locale
     *
     * @locale en
     * Reset the current conversation.
     *
     * Same as above, remove this interface
     *
     * After resetting the current conversation, all conversations will update their unread count when receiving messages.
     * @locale
     */
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 删除 SDK 实例在内存中维护的会话。删除后，调用 {@link SessionServiceInterface.getAllSessions} 得到的结果不会包含此会话
     *
     * 设置 isSyncToServer 为 true 时，会发送协议清除漫游消息。其作用等效于 {@link MsgLogServiceInterface.deleteRoamingMsgs}
     * @locale
     *
     * @locale en
     * Delete the specified conversation, and there are parameters for determining whether to send a protocol to clear the roaming messages.
     * @locale
     */
    deleteSession(options: {
        id: string;
        isSyncToServer: boolean;
    }): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 删除 SDK 实例在内存中维护的会话列表。删除后，调用 {@link SessionServiceInterface.getAllSessions} 得到的结果为空
     * @locale
     *
     * @locale en
     * Delete the specified conversation, and there are parameters for determining whether to send a protocol to clear the roaming messages.
     * @locale
     */
    deleteAllSessionsFromLocal(): void;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 添加云端置顶的会话。
     *
     * ### 影响范围
     * - 多端同步账号收到 {@link IMEventInterface.updateSession} 事件
     * - 登录时，若设置 {@link SyncOptions.stickTopSessions} 为 true，则初始化的 {@link IMEventInterface.sessions} 会话中会包含置顶信息
     * @locale
     *
     * @locale en
     * Pinned session
     * @locale
     */
    addStickTopSession(options: NIM_AddStickTopSessionOptions): Promise<Session>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 取消云端置顶的会话。
     *
     * ### 影响范围
     * - 多端同步账号收到 {@link IMEventInterface.updateSession} 事件
     * - 取消置顶后，初始化的 {@link IMEventInterface.sessions} 事件中，会话中不包含置顶信息
     * @locale
     *
     * @locale en
     * Unpinned session
     * @locale
     */
    deleteStickTopSession(options: NIM_DeleteStickTopSessionOptions): Promise<Session>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 更新云端置顶的会话（目前仅能更新它的扩展字段）。
     *
     * ### 影响范围
     * - 多端同步账号收到 {@link IMEventInterface.updateSession} 事件
     * - 登录时，若设置 {@link SyncOptions.stickTopSessions} 为 true，则初始化的 {@link IMEventInterface.sessions} 会话中会包含置顶信息
     * @locale
     *
     * @locale en
     * Update a pinned session(extension field)
     * @locale
     */
    updateStickTopSession(options: NIM_UpdateStickTopSessionOptions): Promise<Session>;
}
export interface Session {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * sessionId
     *
     * 例如 p2p-cs1、team-113879441
     * @locale
     *
     * @locale en
     * sessionId
     *
     * Example: p2p-cs1, team-113879441
     * @locale
     */
    id: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 会话场景
     *
     * p2p 单聊
     *
     * team 群组
     *
     * superTeam 超大群
     * @locale
     *
     * @locale en
     * Conversation scene
     *
     * p2p: one-to-one chat
     *
     * team : group chat
     *
     * superTeam : supergroup chat
     * @locale
     */
    scene: TMsgScene;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 聊天对象,
     *
     * 若 scene 为 p2p 单聊，则 to 为聊天对象的账号
     *
     * 若 scene 为 team 或者 superTeam，则 to 为 群ID
     * @locale
     *
     * @locale en
     * Chat object,
     *
     * If the scene is one-to-one chat, the “to” field represents the account of the person that the user chats with.
     *
     * If the scene is group chat or supergroup chat, the “to” field represents the group ID.
     * @locale
     */
    to: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 未读数
     * @locale
     *
     * @locale en
     * Unread count
     * @locale
     */
    unread: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 上一条消息.
     *
     * 若 lastMsg 为 undefined ，那么代表这个会话从没有过消息，导致会话不完整. sdk 将过滤掉此会话, 不会回调给上层的开发者
     *
     * 若 lastMsg 为 null，lastMsg 为 null 则可能是撤回消息，也可能是清除了这个会话的历史消息
     * @locale
     *
     * @locale en
     * Previous message
     *
     * If lastMsg is undefined, it may have never received or sent messages and the conversation is incomplete. The sdk will filter out this session and will not call back to the upper developers
     *
     * If lastMsg is null, the message is recalled or the historical messages of this conversation are cleared.
     * @locale
     */
    lastMsg?: IMMessage | null;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 更新时间
     * @locale
     *
     * @locale en
     * Update time
     * @locale
     */
    updateTime: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 自己已读过的最近一条消息的时间
     *
     * 用于判别自己已读到哪条消息了
     * @locale
     *
     * @locale en
     * The time when you read the last message
     *
     * Used to determine which message you have read
     * @locale
     */
    ack?: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 自己还没读过的此会话消息。此字段不希望开发者处理。
     * @locale
     *
     * @locale en
     * The conversation message that you haven't read yet
     * @locale
     */
    unreadMsgs?: IMMessage[];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 聊天对象所读过的最近一条消息的时间
     *
     * p2p 会话特有，与 msg.time 对比就能得知某条消息是否被对方已读
     *
     * 被 API {@link MsgServiceInterface.sendMsgReceipt | sendMsgReceipt } 和 {@link MsgServiceInterface.sendTeamMsgReceipt | sendTeamMsgReceipt } 所更新
     * @locale
     *
     * @locale en
     * Time when the last message read by the user
     *
     * p2p chat specific properties，can compare it with msg.time to know whether a message has been read by the other party.
     * @locale
     */
    msgReceiptTime?: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 云端置顶会话信息。若开通了云端置顶会话功能，且这个会话的确被设置为置顶会话，此对象存在。
     * @locale
     *
     * @locale en
     * The information about a pinned session. If the pinning session feature is enabled, and the session is pinned
     * @locale
     */
    stickTopInfo?: NIM_StickTopSessionInfo;
}
export interface NIM_StickTopSessionInfo {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否置顶？
     * @locale
     *
     * @locale en
     * Whether a session is pinned
     * @locale
     */
    isStickOnTop: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 会话 id
     * @locale
     *
     * @locale en
     * Session ID
     * @locale
     */
    id: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 云端置顶的扩展信息
     * @locale
     *
     * @locale en
     * Extension field
     * @locale
     */
    ext: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 会话置顶的记录创建时间
     * @locale
     *
     * @locale en
     * The time when a session is pinned
     * @locale
     */
    createTime: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 会话置顶的记录更新时间
     * @locale
     *
     * @locale en
     * The time when a pinned session is updated
     * @locale
     */
    updateTime: number;
}
export interface GetSessionsOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 一页的限制数量，默认 100
     * @locale
     *
     * @locale en
     * Limit number on one page (default value: 100)
     * @locale
     */
    limit?: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 查询的上一批最后一条 sessionId
     * @locale
     *
     * @locale en
     * The last sessionId of the last batch of the query
     * @locale
     */
    lastSessionId?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否逆序获取
     *
     * 为 true 则逆序，获取 lastSessionId 所在记录之后的 limit 个
     * 为 false 则正序，获取 lastSessionId 所在记录之前的 limit 个
     * @locale
     *
     * @locale en
     * Whether to get it in reverse order
     *
     * If true, get the limit number of records after the one where the lastSessionId is located.
     * If false, get the limit number of records before the one where the lastSessionId is located.
     * @locale
     */
    desc?: boolean;
}
export interface SessionIdOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * sessionId
     *
     * 例如 p2p-cs1、team-113879441
     * @locale
     *
     * @locale en
     * sessionId
     *
     * Example p2p-cs1, team-113879441
     * @locale
     */
    id: string;
}
export interface NIM_UpdateStickTopSessionOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * sessionId
     *
     * 例如 p2p-cs1、team-113879441
     * @locale
     *
     * @locale en
     * sessionId
     *
     * Example p2p-cs1, team-113879441
     * @locale
     */
    id: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 云端置顶会话的扩展字段
     * @locale
     *
     * @locale en
     * extension field of a pinned session
     * @locale
     */
    ext: string;
}
export interface NIM_DeleteStickTopSessionOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * sessionId
     *
     * 例如 p2p-cs1、team-113879441
     * @locale
     *
     * @locale en
     * sessionId
     *
     * Example p2p-cs1, team-113879441
     * @locale
     */
    id: string;
}
export interface NIM_AddStickTopSessionOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * sessionId
     *
     * 例如 p2p-cs1、team-113879441
     * @locale
     *
     * @locale en
     * sessionId
     *
     * Example p2p-cs1, team-113879441
     * @locale
     */
    id: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 云端置顶会话的扩展字段
     * @locale
     *
     * @locale en
     * extension field of a pinned session
     * @locale
     */
    ext?: string;
}
export interface NIM_SessionIdsOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * sessionIds
     *
     * 例如 ['p2p-cs1', 'team-113879441']
     * @locale
     *
     * @locale en
     * Session IDs
     *
     * Example ['p2p-cs1', 'team-113879441']
     * @locale
     */
    ids: string[];
}
