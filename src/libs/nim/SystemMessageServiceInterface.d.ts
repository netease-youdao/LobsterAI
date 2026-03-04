import { StrAnyObj } from './types';
/**
 * 调用方式:
 * ```js
 * nim.systemMessage.sendCustomSysMsg(options)
 * ```
 */
export interface SystemMessageServiceInterface {
    /**
     * 标记系统通知为已收到（sdk 自己托管不需要暴露给用户）
     *
     * SDK 在收到系统通知后会更新系统通知未读数, 开发者需要调用此接口来通知 SDK 将某条系统通知标记为已读状态, 标记后会触发 updateSystemMessages 事件
     */
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 发送自定义系统通知
     *
     * 开发者可以向其他用户或群发送自定义通知。自定义系统通知和自定义消息的区别如下:
     * - 自定义消息属于消息, 会存储在云信的消息数据库中, 需要跟其他消息一同展现给用户。
     * - 自定义系统通知属于系统通知, 用于第三方通知自己, SDK 不会解析这些通知, SDK 仅仅负责传递这些通知。
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/message/p2p%E6%AD%A3%E5%9C%A8%E8%BE%93%E5%85%A5.js" target="_blank">p2p正在输入</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * Send custom system notifications
     *
     * You can send custom system notifications to other users or groups.
     * The difference between custom system notifications and custom messages is as follows:
     * Custom messages are a type of messages, which will be stored in CommsEase’s message database. Custom messages need to be displayed to users together with other messages.
     * Custom system notifications are special system notifications and are used by third parties to notify themselves. The SDK will not parse these notifications and it is only responsible for delivering these notifications.
     * @locale
     */
    sendCustomSysMsg(options: SendCustomSysMsgOptions): Promise<void>;
}
export declare enum ESystemMessageStatus {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 默认,未读
     * @locale
     *
     * @locale en
     * Default, unread
     * @locale
     */
    none = 0,
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 收到消息,通过
     * @locale
     *
     * @locale en
     * Friend request accepted
     * @locale
     */
    pass = 1,
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 收到消息,拒绝
     * @locale
     *
     * @locale en
     * Fiend request rejected
     * @locale
     */
    decline = 2,
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 收到消息,已读。
     *
     * 开启 DB 才能支持这个状态
     * @locale
     *
     * @locale en
     * Friend request has been read
     *
     * Not supported currently
     * @locale
     */
    read = 3,
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 已删。db 里删了这个接口会出现。
     *
     * 开启 DB 才能支持这个状态
     * @locale
     *
     * @locale en
     * Friend request has been deleted. The status will appear only when the request is deleted from the database
     *
     * Not supported currently.
     * @locale
     */
    deleted = 4,
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 已失效..多端同步，这一端操作了，另一端标已失效
     *
     * 开启 DB 才能支持这个状态
     * @locale
     *
     * @locale en
     * Friend request has been invalid in the multi-device synchronization scenario (friend request has been operated on one device, so the request turns invalid on other devices)
     *
     * Not supported currently
     * @locale
     */
    invalid = 5
}
export declare type TSystemMessageStatus = keyof typeof ESystemMessageStatus;
export declare enum ESysMsgFeature {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 默认
     * @locale
     *
     * @locale en
     * Default
     * @locale
     */
    default = 0,
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 离线消息
     * @locale
     *
     * @locale en
     * Offline system notification
     * @locale
     */
    leave = 1,
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 漫游消息
     * @locale
     *
     * @locale en
     * Roaming system notification
     * @locale
     */
    roam = 2
    /**
     * 同步消息
     */
    /**
     * 透传消息
     */
}
export declare type TSysMsgFeature = keyof typeof ESysMsgFeature;
export declare enum ESystemMessageType {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * team 相关
     * (某人)申请入群
     * @locale
     *
     * @locale en
     * Group related
     * (someone) requests to join the group
     * @locale
     */
    applyTeam = 0,
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * team 相关
     * (管理员)拒绝申请入群
     * @locale
     *
     * @locale en
     * team related
     * (Admin) rejects the request to join the group
     * @locale
     */
    rejectTeamApply = 1,
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * team 相关
     * (管理员)邀请某人
     * @locale
     *
     * @locale en
     * team related
     * (Admin) invites someone
     * @locale
     */
    teamInvite = 2,
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * team 相关
     * (某人)拒绝邀请
     * @locale
     *
     * @locale en
     * team related
     * (Someone) declines the invitation to join the group
     * @locale
     */
    rejectTeamInvite = 3,
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * friend 相关
     *
     * 好友申请
     *
     * 此系统消息的 attach.type 会标识它是
     * addFriend, applyFriend, passFriendApply, rejectFriendApply
     * 中的一种来做区分
     * @locale
     *
     * @locale en
     * friend related
     *
     * Friend requests
     *
     * attach.type of the system notification will mark the system notification as one of the following:
     * addFriend, applyFriend, passFriendApply, rejectFriendApply
     * @locale
     */
    friendRequest = 5,
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * friend 相关
     *
     * 删除好友
     * @locale
     *
     * @locale en
     * friend related
     *
     * Friend deleted
     * @locale
     */
    deleteFriend = 6,
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * msg 相关
     * 撤回消息
     * @locale
     *
     * @locale en
     * msg related
     * Message recalled
     * @locale
     */
    recallMsgP2p = 7,
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * msg 相关
     * 撤回群消息
     * @locale
     *
     * @locale en
     * msg related
     * Group message recalled
     * @locale
     */
    recallMsgTeam = 8,
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * msg 相关
     * 撤回超大群消息
     * @locale
     *
     * @locale en
     * msg related
     * Message of super group recalled
     * @locale
     */
    recallMsgSuperTeam = 12,
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * msg 相关
     * 单向删除点对点消息
     * @locale
     *
     * @locale en
     * msg related
     * One-way deletion of message in one-to-one chat
     * @locale
     */
    deleteMsgP2pOneWay = 13,
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * msg 相关
     * 单向删除群消息
     * @locale
     *
     * @locale en
     * msg related
     * One-way deletion of group message
     * @locale
     */
    deleteMsgTeamOneWay = 14,
    applySuperTeam = 15,
    rejectSuperTeamApply = 16,
    superTeamInvite = 17,
    rejectSuperTeamInvite = 18,
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 自定义系统通知相关
     * @locale
     *
     * @locale en
     * Custom system notification related
     * @locale
     */
    customP2p = 100,
    customTeam = 101,
    customSuperTeam = 103
}
export declare type TSystemMessageType = keyof typeof ESystemMessageType;
export interface TSysMsgPushInfo {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否需要推送。默认为 false
     * @locale
     *
     * @locale en
     * Whether to push notifications
     * @locale
     */
    needPush?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否要做消息计数(推送的角标)
     * @locale
     *
     * @locale en
     * Whether to count unread notifications (count displayed as app icon’s subscript)
     * @locale
     */
    needPushBadge?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 需要推送昵称
     * @locale
     *
     * @locale en
     * Whether to push nickname
     * @locale
     */
    needPushNick?: boolean;
    /**
     * 推送需要前缀，缺省 false
     */
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 推送文本，不填则不推送
     * @locale
     *
     * @locale en
     * Whether to push text (if no value set, the text will not be pushed)
     * @locale
     */
    pushContent?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 自定义的推送属性，长度2048
     * @locale
     *
     * @locale en
     * Custom push attributes, length: 2,048 bytes
     * @locale
     */
    pushPayload?: string;
}
export interface TSystemMessageAntiSpamInfo {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * (功能暂时不开放)是否需要使用自定义反垃圾字段 antiSpamContent, 缺省false
     * 注：此字段与 antiSpamContent 联合起来使用
     * @locale
     *
     * @locale en
     * (The function is temporarily unavailable) Whether you need to use the custom anti-spam field antiSpamContent, (default: false)
     * Note: This field should be used together with antiSpamContent.
     * @locale
     */
    needAntiSpam?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * (可选)开发者自定义的反垃圾字段。格式如 '{"type":1,"data":"YOUR_DATA_KEY"}'
     * @locale
     *
     * @locale en
     * (Optional) Developer-defined anti-spam field. Format: '{"type":1,"data":"YOUR_DATA_KEY"}'
     * @locale
     */
    antiSpamContent?: string;
}
export interface TSysMsgRecallMsgInfo {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 消息撤回需要透传给回客户端用的字段
     * @locale
     *
     * @locale en
     * Message ID (generated on the application side) of the recalled message
     * @locale
     */
    idClient: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 要撤回消息的server_msgid
     * @locale
     *
     * @locale en
     * ID (generated on the IM server) of the recalled message
     * @locale
     */
    idServer: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 撤回消息的createtime
     * @locale
     *
     * @locale en
     * Create time of the recalled message
     * @locale
     */
    createTime: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 要撤回消息发送者的nick
     * @locale
     *
     * @locale en
     * Nickname of the sender of the recalled message
     * @locale
     */
    fromNick: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 执行操作的账号，例如群管理员撤回消息，填写管理员 account id
     * @locale
     *
     * @locale en
     * The account that performs the recall operation. For example, if a group member recalls the message, fills in the group member’s accid
     * @locale
     */
    opeAccount?: string;
}
export interface TSysMsgSetting {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 自定义消息是否存入离线
     *
     * true 若目标用户不在线, 会在其上线后推送过去。
     * false 只发送给在线用户, 比如说 “正在输入” 这种即时通知。
     *
     * 注意：该参数只对点对点自定义系统通知有效, 对群自定义系统通知无效, 群自定义系统通知只会发给在线的群成员, 不会存离线消息。
     * @locale
     *
     * @locale en
     * Whether to store the offline custom system notifications
     *
     * true: If the target user is offline, custom system notifications will be pushed to them after they are online.
     * false: Custom system notifications will only be sent to online users, such as the real-time notification "typing in progress".
     *
     * Note: This parameter is only valid for one-to-one custom system notifications, not for group custom system notifications. Group custom system notifications will only be sent to online group members, and the offline ones will not be stored.
     * @locale
     */
    needSaveOffline?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * (可选) 指向自定义抄送的配置
     * @locale
     *
     * @locale en
     * (Optional) custom data synchronization configuration
     * @locale
     */
    envConfig?: string;
    /**
     * 该消息是否抄送。默认按照app的路由开关。
     *
     * 注：消息路由，又称消息抄送，App 的消息在云信通道中经过的同时会抄送一份到 App 自己的服务器用于备案等；
     */
    isRoutable?: boolean;
}
export interface SystemMessage {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 时间戳
     * @locale
     *
     * @locale en
     * Timestamp
     * @locale
     */
    time: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 系统通知类型
     *
     * 群有关的如 teamInvite、rejectTeamInvite、applyTeam ...
     * 好友的如 applyFriend、passFriendApply、rejectFriendApply....
     * 超大群的略
     * 其他的撤回消息、自定义的系统通知等类型。
     * @locale
     *
     * @locale en
     * System notification type
     *
     * Group related: such as teamInvite, rejectTeamInvite, applyTeam...
     * Friend related: such as applyFriend, passFriendApply, rejectFriendApply....
     * Recalled message, custom system notifications, etc.
     * @locale
     */
    type: TSystemMessageType;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 系统通知的目标, 账号或者群ID
     * @locale
     *
     * @locale en
     * Target of system notification: account or group ID
     * @locale
     */
    to: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 系统通知的来源, 账号或者群ID
     * @locale
     *
     * @locale en
     * Source of the system notification: account or group ID
     * @locale
     */
    from: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 内建系统通知的 idServer
     * @locale
     *
     * @locale en
     * ID (generated by the IM server) of the built-in system notification
     * @locale
     */
    idServer: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 系统通知的状态
     * @locale
     *
     * @locale en
     * System notification status
     * @locale
     */
    state?: TSystemMessageStatus;
    /**
     * 自定义系系统通知的场景, 参考消息场景。使用 type 就能区分它是什么，不需要 scene！
     */
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 内建系统通知的附言
     * @locale
     *
     * @locale en
     * Postscript for built-in system notifications
     * @locale
     */
    content?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 内建系统通知的附加信息
     * @locale
     *
     * @locale en
     * Additional information for built-in system notifications
     * @locale
     */
    attach?: StrAnyObj;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 执行操作的账号，例如群管理员撤回消息，那就是管理员 accid
     * @locale
     *
     * @locale en
     * The account that operates. For example, if a group admin recalls the message, the account is the group admin’s accid.
     * @locale
     */
    opeAccount?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 服务器第三方回调的扩展字段
     * @locale
     *
     * @locale en
     * Extension fields for server’s third-party callbacks
     * @locale
     */
    callbackExt?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 通知属性
     * @locale
     *
     * @locale en
     * Notification attributes
     * @locale
     */
    feature: TSysMsgFeature;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 撤回消息的相关字段
     * @locale
     *
     * @locale en
     * Fields related to the recalled messages
     * @locale
     */
    recallMessageInfo?: TSysMsgRecallMsgInfo;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 推送设置
     * @locale
     *
     * @locale en
     * Push settings
     * @locale
     */
    pushInfo?: TSysMsgPushInfo;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 反垃圾设置
     * @locale
     *
     * @locale en
     * Anti-spam settings
     * @locale
     */
    antiSpamInfo?: TSystemMessageAntiSpamInfo;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 通知的其他相关字段
     * @locale
     *
     * @locale en
     * Other fields related to system notifications
     * @locale
     */
    setting?: TSysMsgSetting;
}
export interface SendCustomSysMsgOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 通知的目标, 账号或者群ID
     * @locale
     *
     * @locale en
     * Target of system notification: account or group ID
     * @locale
     */
    to: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 系统通知类型
     * 自定义消息只能选择 'customP2p' | 'customTeam' | 'customSuperTeam'
     * @locale
     *
     * @locale en
     * System notification type
     * For custom system notifications, only customTeam ' | ' customSuperTeam ' can be selected.
     * @locale
     */
    type: 'customP2p' | 'customTeam' | 'customSuperTeam';
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 内建系统通知的附加信息, JSON 格式化的字符串
     * @locale
     *
     * @locale en
     * Additional information for built-in system notifications (JSON formatted string)
     * @locale
     */
    attach: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 消息其他相关字段
     * @locale
     *
     * @locale en
     * Other related fields
     * @locale
     */
    setting?: TSysMsgSetting;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 推送相关字段设置
     * @locale
     *
     * @locale en
     * Push related field
     * @locale
     */
    pushInfo?: TSysMsgPushInfo;
}
