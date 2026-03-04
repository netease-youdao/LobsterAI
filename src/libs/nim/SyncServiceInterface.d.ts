export interface SyncOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否同步用户信息。默认 true
     * @locale
     *
     * @locale en
     * Whether to synchronize user information. Default value: true
     * @locale
     */
    myInfo?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否同步离线消息和离线系统通知。默认 true
     * @locale
     *
     * @locale en
     * Whether to synchronize offline messages and offline system notifications. Default value: true
     * @locale
     */
    offlineMsgs?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否同步群列表。默认 true
     * @locale
     *
     * @locale en
     * Whether to synchronize the group list. Default value: true
     * @locale
     */
    teams?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否同步漫游消息。默认 true
     * @locale
     *
     * @locale en
     * Whether to synchronize roaming messages. Default value: true
     * @locale
     */
    roamingMsgs?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否同步黑名单和静音列表。默认 true
     * @locale
     *
     * @locale en
     * Whether to synchronize the blacklist and mute list. Default value: true
     * @locale
     */
    relations?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否同步好友列表。默认 true
     * @locale
     *
     * @locale en
     * Whether to synchronize the friend list. Default value: true
     * @locale
     */
    friends?: boolean;
    /**
     * 是否同步会话列表。默认 false。弃用
     */
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否同步好友的用户名片。默认 true
     * @locale
     *
     * @locale en
     * Whether to synchronize friends’ name cards. Default value: true
     * @locale
     */
    friendUsers?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否同步已读回执。默认 true
     * @locale
     *
     * @locale en
     * Whether to synchronize read receipts. Default value: true
     * @locale
     */
    msgReceipts?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否同步当前用户的所有群的群成员信息。默认 true
     * @locale
     *
     * @locale en
     * Whether to synchronize the current user’s member information in all groups. Default value: true
     * @locale
     */
    myTeamMembers?: boolean;
    /**
     * 桌面端在线时，移动端是否需要推送。默认 true
     */
    donnop?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否同步撤回消息离线和漫游通知。默认 true
     * @locale
     *
     * @locale en
     * Whether to synchronize the recalled messages. Default value: true
     * @locale
     */
    recallMsg?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否同步消息会话 ack，时间戳单位毫秒。自 10.7.0+ 默认 true, 之前版本默认 false
     *
     * 会话 ACK 代表本账号在此会话里读过的最新消息的时间戳
     * @locale
     *
     * @locale en
     * Whether to synchronize conversation ACK of the message (timestamp unit: milliseconds, default value: false)
     *
     * Conversation ACK represents the timestamp of the latest message read by the account in a conversation.
     * @locale
     */
    sessionAck?: boolean;
    /**
     * 是否同步机器人列表最后更新时间戳。默认false，弃用
     */
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否同步离线的广播消息，默认 false
     * @locale
     *
     * @locale en
     * Whether the broadcast messages that are received during offline are synchronized
     * @locale
     */
    broadcastMsgs?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否同步音视频独立信令，默认 false
     * @locale
     *
     * @locale en
     * @locale
     */
    avSignal?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否同步超大群信息，默认 true
     * @locale
     *
     * @locale en
     * Whether to synchronize supergroup information (default value: true)
     * @locale
     */
    superTeams?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否同步所在的超大群的群成员信息，默认 true
     * @locale
     *
     * @locale en
     * Whether to synchronize the group member information of the super group where it is located (default value: true)
     * @locale
     */
    mySuperTeamMembers?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否同步超大群漫游消息。默认 true
     * @locale
     *
     * @locale en
     * Whether to synchronize roaming messages in supergroup (default value: true)
     * @locale
     */
    superTeamRoamingMsgs?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否同步超大群撤回消息离线和漫游通知，默认 true
     * @locale
     *
     * @locale en
     * Whether to synchronize the recalled messages in the supergroup, the default value is true
     * @locale
     */
    deleteSuperTeamMsg?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否同步超大群会话 ack 位置列表，默认 false
     * @locale
     *
     * @locale en
     * Whether to synchronize the supergroup's conversation ACK (default value: false)
     * @locale
     */
    superTeamSessionAck?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否同步单向删除信息，默认 true
     * @locale
     *
     * @locale en
     * Whether to synchronize one-way delete information (default value: true)
     * @locale
     */
    deleteSelfMsgs?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否同步置顶会话信息，自 10.7.0+ 默认 true, 之前版本默认 false
     * @locale
     *
     * @locale en
     * Whether to synchronize information of pinned conversation (default value: false)
     * @locale
     */
    stickTopSessions?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否同步会话历史消息的删除信息。默认 true
     * @locale
     *
     * @locale en
     * Whether to synchronize the deletion information of the conversation's history messages (default value: true)
     * @locale
     */
    sessionHistoryMsgsDelete?: boolean;
    /**
     * 是否同步p2p, team 消息的修改信息。默认 true
     */
    p2pTeamModifyMessage?: boolean;
    /**
     * 是否同步 superTeam 消息的修改信息。默认 true
     */
    superTeamModifyMessage?: boolean;
    /**
     * 是否同步好友操作列表, 默认 false. v10.9.60+ 支持
     *
     * 注: 当传入初始化第二参数 V2NIMFriendServiceConfig.enableServerV2FriendAddApplication 为 true 时, 本开关也会随之开启.
     */
    friendOperatorList?: boolean;
    /**
     * 是否同步好友操作列表中被删除, 清空的项目, 默认 false. v10.9.70+ 支持
     *
     * 注: 当传入初始化第二参数 V2NIMFriendServiceConfig.enableServerV2FriendAddApplication 为 true 时, 本开关也会随之开启.
     */
    friendApplyInfoDeleteOrClear?: boolean;
    /**
     * 是否同步单聊已读回执, 默认 true. v10.9.60+ 支持
     */
    p2pMsgReceiptV2?: boolean;
    /**
     * 是否同步单聊 session-ack. 默认 true. v10.9.60+ 支持
     *
     * 会话 ACK 代表本账号在此会话里读过的最新消息的时间戳
     */
    /**
     * 是否同步群聊 session-ack. 默认 true. v10.9.60+ 支持
     *
     * 会话 ACK 代表本账号在此会话里读过的最新消息的时间戳
     */
    /**
     * 是否同步超级群聊 session-ack. 默认 true. v10.9.60+ 支持
     *
     * 会话 ACK 代表本账号在此会话里读过的最新消息的时间戳
     */
    /**
     * 是否同步群操作列表, 默认 false. v10.9.70+ 支持
     *
     * 注: 当传入初始化第二参数 V2NIMTeamServiceConfig.enableServerV2TeamJoinActionInfo 为 true 时, 本开关也会随之开启.
     */
    teamApplyList?: boolean;
    /**
     * 是否云商服专用的过滤消息。默认 false
     */
    filterMsgs?: boolean;
}
export declare const enum V2NIMDataSyncLevel {
    /**
     * 完全同步. 默认
     *
     * 注: web 端目前的“完全同步”就等同于“同步基础数据”，“完全同步”这个概念再未来会扩展到同步群成员与超级群成员。
     */
    V2NIM_DATA_SYNC_TYPE_LEVEL_FULL = 0,
    /**
     * 同步基础数据。
     */
    V2NIM_DATA_SYNC_TYPE_LEVEL_BASIC = 1
}
/**
 * 数据同步的类型
 */
export declare const enum V2NIMDataSyncType {
    /**
     * 同步主数据
     */
    V2NIM_DATA_SYNC_TYPE_MAIN = 1,
    /**
     * 同步群组成员
     */
    V2NIM_DATA_SYNC_TYPE_TEAM_MEMBER = 2,
    /**
     * 同步超大群组成员
     */
    V2NIM_DATA_SYNC_TYPE_SUPER_TEAM_MEMBER = 3
}
/**
 * 数据同步的状态
 */
export declare const enum V2NIMDataSyncState {
    /**
     * 等待同步
     */
    V2NIM_DATA_SYNC_STATE_WAITING = 1,
    /**
     * 同步中
     */
    V2NIM_DATA_SYNC_STATE_SYNCING = 2,
    /**
     * 同步完成
     */
    V2NIM_DATA_SYNC_STATE_COMPLETED = 3
}
export declare type V2NIMDataSyncDetail = {
    /**
     * 类型
     */
    type: V2NIMDataSyncType;
    /**
     * 状态
     */
    state: V2NIMDataSyncState;
};
