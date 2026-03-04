import { EMsgType, IMMessage, TMsgScene, TMsgType } from './MsgServiceInterface';
/**
 * 调用方式:
 * ```js
 * nim.msgLog.deleteRoamingMsgs(options)
 * ```
 */
export interface MsgLogServiceInterface {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 批量删除服务器上某些会话的漫游消息。只支持 p2p 消息和 team 群消息，不支持 superTeam 超级群消息
     *
     * 删除后，消息的历史记录仍可以查询到
     *
     * 要想让下次同步时不再接到这个会话:
     * 1. resetSessionUnreadCount 重置过这个会话的已读信息
     * 2. deleteRoamingMsgs 删除服务器漫游消息
     * @locale
     *
     * @locale en
     * Bulk delete roaming messages of certain conversations on the server.
     *
     * Note: To stop receiving this conversation the next time you sync, perform the two steps below.
     * 1. Call resetSessionUnreadCount to reset the unread count of the conversation.
     * 2. Call deleteRoamingMsgs to delete roaming messages on the server.
     * @locale
     */
    deleteRoamingMsgs(options: SessionIdListOptions): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 获取存储在云信服务端的历史消息。由参数beginTime和endTime来控制时间范围。
     *
     * - 若要通过关键词查询消息，请参考 {@link MsgLogServiceInterface.ftsCloudMsgLogs}
     *
     * #### 注意事项
     * - 该接口应该在收到 `syncdone` 事件之后再调用，否则会话的未读数可能会不准确
     * - 当reverse为false时, 后续查询的endTime，应设置为上次查询的最后一条消息的time字段
     * - 当reverse为true时, 后续查询的beginTime，应设置为上次查询的最后一条消息的time字段
     * - 为了避免设置边界值时，得到重复的消息，可以在固定时间，切换分页查询时，设置 lastMsgId 为上一次查询最后一条消息的 idServer 字段
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/message/%E6%B6%88%E6%81%AF%E9%98%9F%E5%88%97%E7%BB%B4%E6%8A%A4.js" target="_blank">消息队列维护</a></li>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/session/%E6%9F%A5%E8%AF%A2%E5%8E%86%E5%8F%B2%E6%B6%88%E6%81%AF.js" target="_blank">查询历史消息</a></li>
     * </ul>
     *
     * @example
     * ```js
     * const store = {sessionMsgs: {}}
     *
     * async function loadMoreMsgOfSession(scene, to, limit) {
     *    const sessionId = `${scene}-${to}`
     *    store.sessionMsgs[sessionId] = store.sessionMsgs[sessionId] || {
     *      msgArr: [],
     *      fetching: false,
     *      complete: false
     *    }
     *
     *    // 已经拉到了所有历史消息，或者正在拉取历史消息，则不重复拉取
     *    if (store.sessionMsgs[sessionId].complete || store.sessionMsgs[sessionId].fetching) {
     *      return
     *    }
     *
     *    const msgArr = store.sessionMsgs[sessionId].msgArr
     *    const lastMsg = msgArr[msgArr.length - 1]
     *
     *    const params = {
     *        // 返回的结果按时间降序排列
     *        asc: false,
     *        scene: scene,
     *        to: to,
     *        beginTime: 0,
     *        limit: limit,
     *        endTime: lastMsg ? lastMsg.time : 0,
     *        // 从endTime开始往前查找
     *        reverse: false
     *    }
     *
     *    // 设置分割线
     *    // 该参数主要作用是避免有多个消息的时间等于 endTime，或者 beginTime，导致重复拉取
     *    if (lastMsg) {
     *        params.lastMsgId = lastMsg.idServer
     *    }
     *
     *    store.sessionMsgs[sessionId].fetching = true
     *    try {
     *        const msgs = await nim.msgLog.getHistoryMsgs(params)
     *        store.sessionMsgs[sessionId].fetching = false
     *        store.sessionMsgs[sessionId].msgArr = msgArr.concat(msgs)
  
     *        // 拉取的消息长度 < 分页长度，因此 complete = true
     *        if (msgs.length < limit) {
     *            store.sessionMsgs[sessionId].complete = true
     *        }
     *    } catch(err) {
     *        console.error('loadMoreMsgOfSession Error: ', err)
     *        store.sessionMsgs[sessionId].fetching = false
     *    }
     * }
     * ```
     *
     * @locale
     *
     * @locale en
     * Get the historical messages from the cloud.
     *
     * This interface is used for obtaining historical messages within a period.
     * @locale
     */
    getHistoryMsgs(options: GetHistoryMsgsOptions): Promise<IMMessage[]>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 删除某个会话的云端历史消息记录，以及漫游消息记录
     *
     * - 注意，该函数和 {@link MsgServiceInterface.deleteSelfMsgs} 一样，删除后，仅影响当前用户能否查询到该消息
     *
     * #### 影响范围
     * - 触发当前客户端的 {@link IMEventInterface.updateSession | updateSession} 回调函数
     * - 若入参中设置 isSyncSelf = true，还会触发当前账号多端同步设备的 {@link IMEventInterface.updateSession | updateSession} 以及 {@link IMEventInterface.clearServerHistoryMsgs | clearServerHistoryMsgs} 事件
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/session/%E5%88%A0%E9%99%A4%E4%BC%9A%E8%AF%9D.js" target="_blank">删除会话</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * Delete historical messages of a conversation from the cloud.
     * @locale
     */
    clearHistoryMsgsFromServer(options: ClearHistoryMsgsFromServerOptions): Promise<{
        timetag: number;
    }>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 云端消息全文检索
     *
     * @example
     * ```js
     * // 搜索最近一个月内，包含关键字 hello 的文本消息
     * const t = Date.now() - 24 * 60 * 60 * 1000 * 30
     * const res = await nim.msgLog.ftsCloudMsgLogs({
     *    keyword: 'hello',
     *    fromTime: t,
     *    msglogsLimit: 20,
     *    msgTypeList: ['text'],
     *    orderRule: 'DESC'
     * })
     * ```
     * @locale
     *
     * @locale en
     * Global search for message history in the cloud
     * @locale
     */
    ftsCloudMsgLogs(options: NIMEFtsMsgLogsOptions): Promise<IMMessage[]>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 云端消息全文检索，按会话维度进行聚合。
     *
     * 注意返回的结果会先根据 会话排序，然后相同会话的消息根据时间排序
     *
     * - 该接口可以限制返回的会话数量。使用 sessionLimit 字段控制
     * - 该接口可以限制每个会话中，返回的匹配消息数量。使用 msglogsLimit 字段控制
     * - 返回的结果会先根据会话排序，再根据消息时间排序
     *
     * ```js
     * // 搜索最近一个月内，包含关键字 hello 的文本消息
     * // 最多返回 10 个会话，且每个会话返回的结果数量不超过 5 条
     * const t = Date.now() - 24 * 60 * 60 * 1000 * 30
     * const res = await nim.msgLog.ftsCloudMsgLogsAggWithSession({
     *    keyword: 'hello',
     *    fromTime: t,
     *    msglogsLimit: 5,
     *    sessionLimit: 10,
     *    msgTypeList: ['text'],
     *    orderRule: 'DESC'
     * })
     * ```
     * @locale
     *
     * @locale en
     * Full-text search for message history in the cloud and return in aggregate data by session
     * @locale
     */
    ftsCloudMsgLogsAggWithSession(options: NIMEFtsCloudMsgLogsAggWithSessionOptions): Promise<IMMessage[]>;
}
/**
 * @Multi_Lang_Tag
 * @locale cn
 * 云端消息全文检索(按会话进行聚合)的接口入参定义
 * @locale
 *
 * @locale en
 * Paramter for Full-text search for message history in the cloud
 * @locale
 */
export interface NIMEFtsCloudMsgLogsAggWithSessionOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 关键字
     * @locale
     *
     * @locale en
     * Keyword
     * @locale
     */
    keyword: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 起始时间。默认0，从最早的时候开始查
     * @locale
     *
     * @locale en
     * Start time: The default value is 0, indicating search starts from the earliest time.
     * @locale
     */
    fromTime?: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 截止时间。默认0，代表不限制。
     * @locale
     *
     * @locale en
     * End time: The default value is 0, indicating no restrictions.
     * @locale
     */
    toTime?: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 返回的最大会话数量限制。默认 10
     * @locale
     *
     * @locale en
     * Message count limit: The default value is 10.
     * @locale
     */
    sessionLimit?: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 单个会话返回的消息数量限制。默认 5
     * @locale
     *
     * @locale en
     * The limit of messages in a session. The default value is 5.
     * @locale
     */
    msglogsLimit?: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 查询的时间排序规则。默认 DESC 按消息时间降序。可选 ASC 升序
     * @locale
     *
     * @locale en
     * Time sorting order for the query: Default is NIMEnumFtsMsgLogsOrder.DESC, which means sorting messages by descending order of message time. Optional value is NIMEnumFtsMsgLogsOrder.ASC for ascending order.
     * @locale
     */
    orderRule?: TFtsMsgLogsOrder;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * P2P 会话过滤的列表，最大长度 20。传入会话（p2p-accid1）的 account  示例：['accid1', 'accid2', 'accid3']
     * @locale
     *
     * @locale en
     * P2P conversation filtering list with a maximum length of 20. Pass in accounts (e.g. p2p-accid1). Example: ['accid1', 'accid2', 'accid3'].
     * @locale
     */
    p2pSessionList?: string[];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群会话过滤的列表，最大长度 20。传入群号（team-146694936），示例：['146694936', '13897']
     * @locale
     *
     * @locale en
     * Group conversation filtering list with a maximum length of 20. Pass in team IDs (e.g. team-146694936). Example: ['146694936', '13897'].
     * @locale
     */
    teamSessionList?: string[];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 消息发送者过滤的列表，最大长度 20。account 列表  示例：['accid1', 'accid2', 'accid3']
     * @locale
     *
     * @locale en
     * Message sender filtering list with a maximum length of 20. Pass in accounts. Example: ['accid1', 'accid2', 'accid3'].
     * @locale
     */
    senderList?: string[];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 消息类型过滤  示例：[EMsgType.text, EMsgType.image]
     * @locale
     *
     * @locale en
     * Message type for filtering. Example: [EMsgType.text, EMsgType.image].
     * @locale
     */
    msgTypeList?: (keyof typeof EMsgType)[];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 消息子类型过滤，此类型开发者在发送消息时可自定义，且格式为大于0的整数。示例：[1, 2]
     * @locale
     *
     * @locale en
     * Message subtype for filtering. Developers can customize this type when sending messages, and the format is a positive integer. Example: [1, 2].
     * @locale
     */
    msgSubTypeList?: number[];
}
/**
 * @Multi_Lang_Tag
 * @locale cn
 * 云端消息全文检索的入参
 * @locale
 *
 * @locale en
 * Parameters for full-text search on message history in the cloud
 * @locale
 */
export interface NIMEFtsMsgLogsOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 关键字
     * @locale
     *
     * @locale en
     * Keyword
     * @locale
     */
    keyword: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 起始时间。默认0，从最早的时候开始查
     * @locale
     *
     * @locale en
     * Start time: The default value is 0, indicating search starts from the earliest time.
     * @locale
     */
    fromTime?: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 截止时间。默认0，代表不限制。
     * @locale
     *
     * @locale en
     * End time: The default value is 0, indicating no restrictions.
     * @locale
     */
    toTime?: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 消息数量限制。默认 10
     * @locale
     *
     * @locale en
     * Message count limit: The default value is 10.
     * @locale
     */
    msglogsLimit?: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 查询的方向，以及返回结果的排序方向。默认为 DESC
     *
     * - 若选择 ASC，则从开始时间开始查找，直到查到结束时间，或者查到 msglogsLimit 条消息为止。返回结果生序排列
     * - 若选择 DESC，则从结束时间开始查找，直到查到开始时间，或者查到 msglogsLimit 条消息为止。返回结果降序排列
     * @locale
     *
     * @locale en
     * Time sorting order for the query: Default is NIMEnumFtsMsgLogsOrder.DESC, which means sorting messages by descending order of message time. Optional value is NIMEnumFtsMsgLogsOrder.ASC for ascending order.
     * @locale
     */
    orderRule?: TFtsMsgLogsOrder;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * P2P 会话过滤的列表，最大长度 20。传入会话（p2p-accid1）的 account  示例：['accid1', 'accid2', 'accid3']
     * @locale
     *
     * @locale en
     * P2P conversation filtering list with a maximum length of 20. Pass in accounts (e.g. p2p-accid1). Example: ['accid1', 'accid2', 'accid3'].
     * @locale
     */
    p2pSessionList?: string[];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群会话过滤的列表，最大长度 20。传入群号（team-146694936），示例：['146694936', '13897']
     * @locale
     *
     * @locale en
     * Group conversation filtering list with a maximum length of 20. Pass in team IDs (e.g. team-146694936). Example: ['146694936', '13897'].
     * @locale
     */
    teamSessionList?: string[];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 消息发送者过滤的列表，最大长度 20。account 列表  示例：['accid1', 'accid2', 'accid3']
     * @locale
     *
     * @locale en
     * Message sender filtering list with a maximum length of 20. Pass in accounts. Example: ['accid1', 'accid2', 'accid3'].
     * @locale
     */
    senderList?: string[];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 消息类型过滤  示例：["text", "image"]
     * @locale
     *
     * @locale en
     * Message type for filtering. Example: [EMsgType.text, EMsgType.image].
     * @locale
     */
    msgTypeList?: (keyof typeof EMsgType)[];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 消息子类型过滤，此类型开发者在发送消息时可自定义，且格式为大于0的整数。示例：[1, 2]
     * @locale
     *
     * @locale en
     * Message subtype filtering. Developers can customize this type when sending messages, and the format is a positive integer. Example: [1, 2].
     * @locale
     */
    msgSubTypeList?: number[];
}
export declare enum NIMEnumFtsMsgLogsOrder {
    ASC = 1,
    DESC = 2
}
export declare type TFtsMsgLogsOrder = keyof typeof NIMEnumFtsMsgLogsOrder;
export interface SessionIdListOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * sessionId 数组
     *
     * 例如 p2p-cs1、team-113879441
     * @locale
     *
     * @locale en
     * sessionId (array)
     *
     * Example: p2p-cs1, team-113879441
     * @locale
     */
    ids: string[];
}
export interface GetHistoryMsgsOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 场景
     * @locale
     *
     * @locale en
     * Scenes
     * @locale
     */
    scene: TMsgScene;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 聊天对象, 账号或者群id
     * @locale
     *
     * @locale en
     * The person that the user chats with, account, or group ID
     * @locale
     */
    to: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 开始时间戳, 精确到 ms, 默认为 0
     * @locale
     *
     * @locale en
     * Start timestamp (accurate to ms). Default value: 0
     * @locale
     */
    beginTime?: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 结束时间戳, 精确到 ms, 默认为服务器的当前时间
     * @locale
     *
     * @locale en
     * End timestamp (accurate to ms). Defaults value: the server's current time
     * @locale
     */
    endTime?: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 上次查询的最后一条消息的 idServer, 第一次不填
     * @locale
     *
     * @locale en
     * Message ID (generated by the IM server) of the last message that was searched for. Not required for the first time.
     * @locale
     */
    lastMsgId?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 本次查询的消息数量限制, 最多 100 条, 默认 100 条
     * @locale
     *
     * @locale en
     * The limit (100) of the number of messages for the current query. The default value is also 100.
     * @locale
     */
    limit?: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否为反向查询，默认 false
     *
     * false 表示从 endTime 开始往前查找历史消息;
     * true 表示从 beginTime 开始往后查找历史消息
     * @locale
     *
     * @locale en
     * Whether to sort in ascending order
     *
     * false: the returned messages are sorted in descending order by time.
     * true: the returned messages are sorted in ascending order by time.
     * @locale
     */
    reverse?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否为升序排序
     *
     * false 表示返回的消息按时间降序排序;
     * true 表示按时间升序排序
     * @locale
     *
     * @locale en
     * Whether to sort in ascending order
     *
     * false: the returned messages are sorted in descending order by time.
     * true: the returned messages are sorted in ascending order by time.
     * @locale
     */
    asc?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 消息类型列表，默认全部消息类型
     * @locale
     *
     * @locale en
     * Message types. Default value: all message types
     * @locale
     */
    msgTypes?: TMsgType[];
}
export interface ClearHistoryMsgsFromServerOptions {
    scene: TMsgScene;
    /**
     * 会话的对象。
     *
     * - 如果是单聊，to 为另一端的 account。
     * - 如果是群聊，to 为群id
     */
    to: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 扩展字段
     * @locale
     *
     * @locale en
     * Extension field
     * @locale
     */
    ext?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否多端同步
     * @locale
     *
     * @locale en
     * Whether to enable multi-device synchronization
     * @locale
     */
    isSyncSelf?: boolean;
}
