import type { NIMEBaseServiceClass } from './types';
/**
 * @example
 * ```js
 * nim.signaling.callEx(options)
 * ```
 */
export declare class SignalingServiceInterface extends NIMEBaseServiceClass<NIMESignalingEventInterface> {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 呼叫并加入频道: 创建一个频道, 己方加入，并邀请对方加入音视频的频道
     *
     * 注: 组合接口, 等效于 {@link SignalingServiceInterface.create | create} 创建频道 +  {@link SignalingServiceInterface.join | join} 加入频道 + {@link SignalingServiceInterface.invite | invite} 邀请他人进入频道
     *
     * - 频道存在默认有效期。若房间内存在成员，频道会自动延长有效期。
     *
     * #### 影响范围
     * - 被邀请人收到 {@link NIMESignalingEventInterface.signalingInvite | signalingInvite} 事件通知
     * @locale
     *
     * @locale en
     * Call a user to join a channel. The current user creates and joins a channel and the invited user is invited to join the channel.
     *
     * Note: this is a combined interface, equivalent to creating a channel, joining a channel, and inviting a user to join the channel.
     * @locale
     */
    callEx(options: NIMESignalingCallExOptions): Promise<NIMESignalingChannel>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 接受呼叫邀请，并加入频道
     *
     * - 收到 {@link NIMESignalingEventInterface.signalingInvite | signalingInvite} 事件通知后，调用此接口加入频道
     *
     * #### 影响范围
     * - 调用此接口后，邀请人收到 {@link NIMESignalingEventInterface.signalingAccept | signalingAccept} 事件通知
     * - 调用此接口后，频道内的成员收到 {@link NIMESignalingEventInterface.signalingJoin | signalingJoin} 事件通知
     * @locale
     *
     * @locale en
     * Accept a call
     *
     * Note: This interface responds to the callEx interface, the recipient accepts a call and join the channe;
     * @locale
     */
    joinAndAccept(options: NIMESignalingJoinAndAcceptOptions): Promise<NIMESignalingChannel>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * - 推荐使用复合接口 {@link SignalingServiceInterface.callEx | callEx} 替换此函数。
     *
     * 通过名称创建频道。注意创建房间后，需要调用 `join` 才可以加入房间。
     *
     * - 频道存在默认有效期。若房间内存在成员，频道会自动延长有效期。
     * - 函数返回结果为频道的基本信息。其它用户根据返回值的 channelInfo.channelId 加入房间
     * - 创建房间后，应用内所有用户可以通过 {@link SignalingServiceInterface.queryInfo | queryInfo} 查询房间信息
     * @locale
     *
     * @locale en
     * Create a channel
     * @locale
     */
    create(options: NIMESignalingCreateOptions): Promise<NIMESignalingChannel>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 关闭频道。已经关闭的房间无法再加入
     *
     * #### 影响范围
     * - 房间内其它用户会收到 {@link NIMESignalingEventInterface.signalingClose | signalingClose} 事件通知
     * @locale
     *
     * @locale en
     * Close a channel
     * @locale
     */
    close(options: NIMESignalingCloseOptions): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 通过频道名称(name)查询频道信息。返回结果包括频道基本信息，以及频道的在线成员列表。
     * @locale
     *
     * @locale en
     * Query the information about a channel
     * @locale
     */
    queryInfo(options: NIMESignalingQueryInfoOptions): Promise<NIMESignalingChannel>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 通过 channelId 加入频道。
     *
     * - 相同 uid 不能同时进入一个频道。也不允许同一个 IM 账号多处同时进入一个房间。
     *
     * #### 影响范围
     * - 加入频道后，已在房间中的用户会收到 {@link NIMESignalingEventInterface.signalingJoin | signalingJoin} 事件通知
     * @locale
     *
     * @locale en
     * Join a channel
     * @locale
     */
    join(options: NIMESignalingJoinOptions): Promise<NIMESignalingChannel>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 离开频道
     *
     * #### 影响范围
     * - 房间内其它用户会收到 {@link NIMESignalingEventInterface.signalingLeave | signalingLeave} 事件通知
     * @locale
     *
     * @locale en
     * Leave a channel
     * @locale
     */
    leave(options: NIMESignalingLeaveOptions): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 邀请某人进入频道。
     *
     * #### 影响范围
     * - 被邀请人会收到 {@link NIMESignalingEventInterface.signalingInvite | signalingInvite} 事件通知
     * - 被邀请人通过 {@link SignalingServiceInterface.joinAndAccept | joinAndAccept} 加入频道。
     * @locale
     *
     * @locale en
     * Invite a user to join a channel
     * @locale
     */
    invite(options: NIMESignalingInviteOptions): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 取消邀请
     *
     * #### 影响范围
     * - 被邀请人会收到 {@link NIMESignalingEventInterface.signalingCancelInvite | signalingCancelInvite} 事件通知
     * - 邀请人取消邀请后，被邀请人无法调用 {@link SignalingServiceInterface.joinAndAccept | joinAndAccept} 加入频道
     * @locale
     *
     * @locale en
     * Cancel an invitation
     * @locale
     */
    cancelInvite(options: NIMESignalingCancelInviteOptions): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 收到 {@link NIMESignalingEventInterface.signalingInvite | signalingInvite} 事件通知后，通过该函数拒绝进入频道的邀请。
     *
     * #### 影响范围
     * - 邀请人收到 {@link NIMESignalingEventInterface.signalingReject | signalingReject} 事件通知
     * @locale
     *
     * @locale en
     * Reject to join a channel
     * @locale
     */
    reject(options: NIMESignalingRejectOptions): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     *
     * @deprecated
     *
     * - 请使用 {@link SignalingServiceInterface.joinAndAccept | joinAndAccept} 替代此函数
     *
     * 接受进入频道的邀请
     * @locale
     *
     * @locale en
     * Accept the invitation to join a channel
     * @locale
     */
    accept(options: NIMESignalingAcceptOptions): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 发送自定义信令, 只有频道内的用户才可以接收指令
     *
     * ### 影响范围
     * - 信令接收方会收到 {@link NIMESignalingEventInterface.signalingCustomCommand | signalingCustomCommand} 事件通知
     * @locale
     *
     * @locale en
     * Send a custom signal
     * @locale
     */
    sendCustomCommand(options: NIMESignalingSendCustomCommandOptions): Promise<void>;
}
/**
 * @example
 * ```js
 * nim.signaling.on('signalingClose', function (result) {})
 * ```
 */
export interface NIMESignalingEventInterface {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 收到频道关闭事件
     * @locale
     *
     * @locale en
     * Event of closing a channel
     * @locale
     */
    signalingClose: [result: NIMESignalingCloseNotify];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 收到成员加入频道事件
     * @locale
     *
     * @locale en
     * event of a member joining a channel
     * @locale
     */
    signalingJoin: [result: NIMESignalingJoinNotify];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 收到邀请事件
     * @locale
     *
     * @locale en
     * Event of receiving an invitation
     * @locale
     */
    signalingInvite: [result: NIMESignalingInviteNotify];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 收到取消邀请事件
     * @locale
     *
     * @locale en
     * Event of canceling an invitation
     * @locale
     */
    signalingCancelInvite: [result: NIMESignalingCancelInviteNotify];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 收到拒绝邀请事件
     * @locale
     *
     * @locale en
     * Event of rejecting an invitation
     * @locale
     */
    signalingReject: [result: NIMESignalingRejectNotify];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 收到接受邀请事件
     * @locale
     *
     * @locale en
     * event of accepting an invitation
     * @locale
     */
    signalingAccept: [result: NIMESignalingAcceptNotify];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 收到退出频道事件
     * @locale
     *
     * @locale en
     * Event of leaving a channel
     * @locale
     */
    signalingLeave: [result: NIMESignalingLeaveNotify];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 收到自定义控制指令事件
     * @locale
     *
     * @locale en
     * Event of receiving a custom command
     * @locale
     */
    signalingCustomCommand: [result: NIMESignalingCustomCommandNotify];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 初始化时同步获取到已加入的频道列表，触发此事件
     * @locale
     *
     * @locale en
     *
     * @locale
     */
    singalingSyncChannels: [result: NIMESignalingChannel[]];
}
export declare const enum NIMEEnumSignalingType {
    /**
     * 音频
     */
    audio = 1,
    /**
     * 视频
     */
    video = 2,
    /**
     * 自定义
     */
    custom = 3
}
export interface NIMESignalingChannel {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 具体频道信息
     * @locale
     *
     * @locale en
     * Channel information
     * @locale
     */
    channelInfo: NIMESignalingChannelInfo;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 频道下的成员列表
     * @locale
     *
     * @locale en
     * List of members
     * @locale
     */
    memberList?: NIMESignalingChannelMemberInfo[];
}
export interface NIMESignalingJoinAndAcceptResult extends NIMESignalingChannel {
    /**
     * 呼叫状态.
     */
    callStatus?: number;
}
export interface NIMESignalingCallExResult extends NIMESignalingChannel {
    /**
     * 呼叫状态.
     */
    callStatus?: number;
}
export interface NIMESignalingChannelNertcInfo {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 云信 G2-RTC 的房间名. 是在创建频道的请求中携带的
     * @locale
     *
     * @locale en
     *
     * @locale
     */
    nertcChannelName?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 云信 G2-RTC 的 token 的有效期. 在创建频道的请求时携带, 表示token的过期时间
     *
     * 注: 单位秒, 默认10分钟
     * @locale
     *
     * @locale en
     * The validity period of the token for NIM G2-RTC, carried in the request for creating a channel and indicates the expiration time of the token.
     *
     * Note: Unit: seconds. The default is 10 minutes.
     * @locale
     */
    nertcTokenTtl?: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 云信 G2-RTC 的 token
     *
     * 注: 开发者可以使用该 token 加入 G2 的 RTC 房间
     * @locale
     *
     * @locale en
     * The token for NIM G2-RTC
     *
     * Note: You can use this token to join the G2-RTC room."
     * @locale
     */
    nertcToken?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 云信 G2-RTC 加入房间的响应内容
     *
     * 注: 这是一个 JSON 序列化字符串
     * @locale
     *
     * @locale en
     * Response content for joining the room in NIM G2-RTC.
     *
     * Note: This is a serialized JSON string.
     * @locale
     */
    nertcJoinRoomResponse?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 对应于invite协议的错误码：成功、不在线、推送不可达
     *
     * 注: 这是一个 JSON 序列化字符串
     * @locale
     *
     * @locale en
     * Error codes corresponding to the invite protocol: success, offline, push unreachable.
     *
     * Note: This is a serialized JSON string.
     * @locale
     */
    callStatus?: number;
}
export interface NIMESignalingChannelMemberInfo {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 受邀请者的账号 account id
     * @locale
     *
     * @locale en
     * The ID of an invited account
     * @locale
     */
    accid: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 自己在频道中对应的uid，大于零有效，无效时服务器会分配随机唯一的uid
     * @locale
     *
     * @locale en
     * The UID of the current user in the channel, valid if the value is greater than zero. If it is invalid, the server will assign a random unique UID.
     * @locale
     */
    uid: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 加入时间点
     * @locale
     *
     * @locale en
     * The time when a member joins a channel
     * @locale
     */
    createTime: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 失效时间点，失效即认为离开了频道
     * @locale
     *
     * @locale en
     * The expiration time, indicating when a member leaves a channel
     * @locale
     */
    expireTime: number;
}
export interface NIMESignalingChannelInfo {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 频道类型
     * @locale
     *
     * @locale en
     * Channel type
     * @locale
     */
    type: NIMEEnumSignalingType;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 频道名称
     * @locale
     *
     * @locale en
     * Channel name
     * @locale
     */
    name: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 频道id，唯一标识
     * @locale
     *
     * @locale en
     * The unique channel ID
     * @locale
     */
    channelId: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 扩展字段
     * @locale
     *
     * @locale en
     * the extension field
     * @locale
     */
    ext?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 创建时间点
     * @locale
     *
     * @locale en
     * The time when a channel is created
     * @locale
     */
    createTime: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 失效时间点
     * @locale
     *
     * @locale en
     * The expiration time
     * @locale
     */
    expireTime: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 创建者的账号 account id
     * @locale
     *
     * @locale en
     * The account ID of an owner
     * @locale
     */
    creatorAccid: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 该频道是否有效. 为 true 代表无效, 为 false 代表有效. 默认为 false
     * @locale
     *
     * @locale en
     * Whether the channel is valid
     * @locale
     */
    invalid?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 扩展的设置数据. 诸如 nertc 参数等
     * @locale
     *
     * @locale en
     * Extension data, such as nertc parameters
     * @locale
     */
    pluginSetting?: {
        /**
         * @Multi_Lang_Tag
         * @locale cn
         * G2 音视频频道的信息.
         *
         * 注: 若是使用呼叫接口 signalingCall 且传入了 nertcInfo 的参数的，则会存在
         * @locale
         *
         * @locale en
         *
         * @locale
         */
        nertcInfo?: NIMESignalingChannelNertcInfo;
    };
}
/**
 * @Multi_Lang_Tag
 * @locale cn
 * 呼叫并加入频道的入参
 * @locale
 *
 * @locale en
 * Parameters for the CallEx method
 * @locale
 */
export interface NIMESignalingCallExOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 频道类型
     * @locale
     *
     * @locale en
     * Channel type
     * @locale
     */
    type: NIMEEnumSignalingType;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 频道名称.
     *
     * 注: 不填写会随机生成一个 name
     * @locale
     *
     * @locale en
     * Channel name
     *
     * Note: a random name is generated if unspecified
     * @locale
     */
    name?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 扩展字段
     * @locale
     *
     * @locale en
     * extension field
     * @locale
     */
    ext?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 自己在频道中对应的uid，大于零有效，无效时服务器会分配随机唯一的uid
     * @locale
     *
     * @locale en
     * The UID of the current user in the channel, valid if the value is greater than zero. If it is invalid, the server will assign a random unique UID.
     * @locale
     */
    uid?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 受邀请者的账号 account id
     * @locale
     *
     * @locale en
     * The account of an invited user
     * @locale
     */
    toAccid: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 邀请者邀请的请求id，需要邀请者填写，之后取消邀请、拒绝、接受需要复用该 requestId
     * @locale
     *
     * @locale en
     * The request ID for the invitation specified by the inviter. This request ID will be reused for cancelling, rejecting or accepting the invitation later.
     * @locale
     */
    requestId: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 该操作的附加信息，透传给受邀请者
     *
     * 接收者通过 {@link NIMESignalingEventInterface.signalingInvite | signalingInvite} 事件回调的 `metaData.ext` 属性读取其它用户设置的该属性
     * @locale
     *
     * @locale en
     * additional message, delivered to others without processing
     * @locale
     */
    attachExt?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否存入离线消息。默认 false
     *
     * 若设置为 true，则离线用户上线时，会收到对应消息通知。
     * @locale
     *
     * @locale en
     * Whether messages are stored for offline users. The default value is false.
     * @locale
     */
    needOffline?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 插件数据设置
     * @locale
     *
     * @locale en
     * Plugin setting
     * @locale
     */
    pluginSetting: {
        /**
         * @Multi_Lang_Tag
         * @locale cn
         * G2-RTC 音视频属性
         * @locale
         *
         * @locale en
         * G2-RTC audio and video properties
         * @locale
         */
        nertcInfo?: NIMESignalingCallNertcInfo;
    };
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 推送属性
     * @locale
     *
     * @locale en
     * The properties of a push notification
     * @locale
     */
    pushInfo?: NIMESignalingPushInfo;
}
export interface NIMESignalingCallNertcInfo {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 云信 G2-RTC 的房间名. 是在创建频道的请求中携带的
     * @locale
     *
     * @locale en
     * Room name, carried when creating a channel
     * @locale
     */
    nertcChannelName?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 云信 G2-RTC 的 token 的有效期. 在创建频道的请求时携带, 表示token的过期时间
     *
     * 注: 单位秒, 默认10分钟
     * @locale
     *
     * @locale en
     * The validity period of the token for NIM G2-RTC, carried in the request for creating a channel and indicates the expiration time of the token.
     *
     * Note: Unit: seconds. The default is 10 minutes.
     * @locale
     */
    nertcTokenTtl?: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 透传给云信 G2-RTC 加入房间的请求参数
     *
     * 注: 这是一个 JSON 序列化字符串
     * @locale
     *
     * @locale en
     * The request parameters for joining the room in NIM G2-RTC that are transparently transmitted.
     *
     * Note: This is a serialized JSON string
     * @locale
     */
    nertcJoinRoomQueryParamMap?: string;
}
export interface NIMESignalingJoinAndAcceptOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 频道 id
     * @locale
     *
     * @locale en
     * Channel ID
     * @locale
     */
    channelId: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 邀请者的账号 account id
     * @locale
     *
     * @locale en
     * The account of an invited user
     * @locale
     */
    fromAccid: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 邀请者邀请的请求id，需要邀请者填写，之后取消邀请、拒绝、接受需要复用该 requestId
     * @locale
     *
     * @locale en
     * The request ID for the invitation specified by the inviter. This request ID will be reused for cancelling, rejecting or accepting the invitation later.
     * @locale
     */
    requestId: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 该操作的附加信息，透传给其他人
     *
     * 接收者通过 {@link NIMESignalingEventInterface.signalingAccept | signalingAccept} 事件回调的 `metaData.ext` 属性读取其它用户设置的该属性
     * @locale
     *
     * @locale en
     * additional message, delivered to others without processing
     * @locale
     */
    attachExt?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否存入离线消息。默认 false
     *
     * 若设置为 true，则离线用户上线时，会收到对应消息通知。
     * @locale
     *
     * @locale en
     * Whether messages are stored for offline users. The default value is false.
     * @locale
     */
    needOffline?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 接受邀请后，自己在频道中对应的uid。大于零有效，无效时服务器会分配随机唯一的uid
     * @locale
     *
     * @locale en
     * The UID of the current user in the channel after accepting the invitation. It is valid if greater than zero. If invalid, the server will assign a random and unique UID
     * @locale
     */
    uid?: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 插件数据设置
     * @locale
     *
     * @locale en
     * plugin setting
     * @locale
     */
    pluginSetting: {
        /**
         * @Multi_Lang_Tag
         * @locale cn
         * G2-RTC 音视频属性
         * @locale
         *
         * @locale en
         * G2-RTC audio and video information
         * @locale
         */
        nertcInfo?: NIMESignalingCallNertcInfo;
    };
}
/**
 * @Multi_Lang_Tag
 * @locale cn
 * 创建频道的入参
 * @locale
 *
 * @locale en
 * The parameter used to create a channel
 * @locale
 */
export interface NIMESignalingCreateOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 频道类型
     *
     * number 类型:
     * - 1: 音频频道
     * - 2: 视频频道
     * - 3: 自定义频道
     * @locale
     *
     * @locale en
     * Channel type
     * @locale
     */
    type: NIMEEnumSignalingType;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 频道名称
     *
     * 注: 不填写会随机生成一个 name
     * @locale
     *
     * @locale en
     * Channel name
     *
     * note: a random name is generated if unspecified
     * @locale
     */
    name?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 扩展字段。该字段会等于 `channelInfo.ext` 属性
     * @locale
     *
     * @locale en
     * extension field
     * @locale
     */
    ext?: string;
}
/**
 * @Multi_Lang_Tag
 * @locale cn
 * 关闭频道的入参
 * @locale
 *
 * @locale en
 * The parameter of closing a channel
 * @locale
 */
export interface NIMESignalingCloseOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 频道 id
     * @locale
     *
     * @locale en
     * Channel ID
     * @locale
     */
    channelId: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 该操作的附加信息，透传给其他人
     *
     * 接收者通过 {@link NIMESignalingEventInterface.signalingClose | signalingClose} 事件回调的 `metaData.ext` 属性读取其它用户设置的该属性
     * @locale
     *
     * @locale en
     * additional message, delivered to others without processing
     * @locale
     */
    attachExt?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否存入离线消息。默认 false
     *
     * 若设置为 true，则离线用户上线时，会收到对应消息通知。
     * @locale
     *
     * @locale en
     * Whether messages are stored for offline users. The default value is false.
     * @locale
     */
    needOffline?: boolean;
}
/**
 * @Multi_Lang_Tag
 * @locale cn
 * 查询频道信息的入参
 * @locale
 *
 * @locale en
 * Parameter for querying the channel information
 * @locale
 */
export interface NIMESignalingQueryInfoOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 频道名
     * @locale
     *
     * @locale en
     * Channel name
     * @locale
     */
    name: string;
}
/**
 * @Multi_Lang_Tag
 * @locale cn
 * 加入频道的入参
 * @locale
 *
 * @locale en
 * Parameter for joining a channel
 * @locale
 */
export interface NIMESignalingJoinOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 频道 id
     * @locale
     *
     * @locale en
     * Channel ID
     * @locale
     */
    channelId: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 该操作的附加信息，透传给其他人。
     *
     * 接收者通过 {@link NIMESignalingEventInterface.signalingJoin | signalingJoin} 事件回调的 `metaData.ext` 属性读取其它用户设置的该属性
     * @locale
     *
     * @locale en
     * additional message, delivered to others without processing
     * @locale
     */
    attachExt?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 自己在频道中对应的uid，大于零有效，无效时服务器会分配随机唯一的uid。不能有多个用户用同一个 uid 进入房间
     * @locale
     *
     * @locale en
     * The UID of the current user in the channel, valid if the value is greater than zero. If it is invalid, the server will assign a random unique UID.
     * @locale
     */
    uid?: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否存入离线消息。默认 false。
     *
     * 若设置为 true，则离线用户上线时，会收到对应消息通知。
     * @locale
     *
     * @locale en
     * Whether messages are stored for offline users. The default value is false.
     * @locale
     */
    needOffline?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 扩展的设置数据. 诸如 nertc 参数等
     * @locale
     *
     * @locale en
     * Extension data, such as nertc parameters
     * @locale
     */
    pluginSetting?: {
        /**
         * @Multi_Lang_Tag
         * @locale cn
         * G2 音视频频道的信息.
         *
         * 注: 若是使用呼叫接口 signalingCall 且传入了 nertcInfo 的参数的，则会存在
         * @locale
         *
         * @locale en
         *
         * @locale
         */
        nertcInfo?: NIMESignalingChannelNertcInfo;
    };
}
/**
 * @Multi_Lang_Tag
 * @locale cn
 * 离开频道的入参
 * @locale
 *
 * @locale en
 * Parameter for leaving a channel
 * @locale
 */
export interface NIMESignalingLeaveOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 频道 id
     * @locale
     *
     * @locale en
     * Channel ID
     * @locale
     */
    channelId: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 该操作的附加信息，透传给其他人
     *
     * 接收者通过 {@link NIMESignalingEventInterface.signalingLeave | signalingLeave} 事件回调的 `metaData.ext` 属性读取其它用户设置的该属性
     * @locale
     *
     * @locale en
     * additional message, delivered to others without processing
     * @locale
     */
    attachExt?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否存入离线消息。默认 false
     *
     * 若设置为 true，则离线用户上线时，会收到对应消息通知。
     * @locale
     *
     * @locale en
     * Whether messages are stored for offline users. The default value is false.
     * @locale
     */
    needOffline?: boolean;
}
/**
 * @Multi_Lang_Tag
 * @locale cn
 * 邀请加入频道的入参
 * @locale
 *
 * @locale en
 * Parameter for joining a channel
 * @locale
 */
export interface NIMESignalingInviteOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 频道 id
     * @locale
     *
     * @locale en
     * Channel ID
     * @locale
     */
    channelId: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 受邀请者的账号 account id
     * @locale
     *
     * @locale en
     * The account of an invited user
     * @locale
     */
    toAccid: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 邀请者邀请的请求id，需要邀请者填写，之后取消邀请、拒绝、接受需要复用该 requestId
     * @locale
     *
     * @locale en
     * The request ID for the invitation specified by the inviter. This request ID will be reused for cancelling, rejecting or accepting the invitation later.
     * @locale
     */
    requestId: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 该操作的附加信息，透传给受邀请者
     *
     * 接收者通过 {@link NIMESignalingEventInterface.signalingInvite | signalingInvite} 事件回调的 `metaData.ext` 属性读取其它用户设置的该属性
     * @locale
     *
     * @locale en
     * additional message, delivered to others without processing
     * @locale
     */
    attachExt?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否存入离线消息。默认 false
     *
     * 若设置为 true，则离线用户上线时，会收到对应消息通知。
     * @locale
     *
     * @locale en
     * Whether messages are stored for offline users. The default value is false
     * @locale
     */
    needOffline?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 推送属性。若不填写，则默认不推送通知
     * @locale
     *
     * @locale en
     * Properties of push notifications
     * @locale
     */
    pushInfo?: NIMESignalingPushInfo;
}
export interface NIMESignalingPushInfo {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否需要推送，默认false
     * @locale
     *
     * @locale en
     * Whether a push notification is required for a message. The default value is false.
     * @locale
     */
    needPush?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 推送标题
     * @locale
     *
     * @locale en
     * The title of a push notification
     * @locale
     */
    pushTitle?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 推送内容
     * @locale
     *
     * @locale en
     * The body of a push notification
     * @locale
     */
    pushContent: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 推送自定义字段
     * @locale
     *
     * @locale en
     * The custom field of a push notification
     * @locale
     */
    pushPayload?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否计入未读计数, 默认为 true
     * @locale
     *
     * @locale en
     * Whether a push notification is counted as unread. The default value is true.
     * @locale
     */
    needPushBadge?: boolean;
}
export interface NIMESignalingCancelInviteOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 频道 id
     * @locale
     *
     * @locale en
     * Channel ID
     * @locale
     */
    channelId: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 受邀请者的账号 account id
     * @locale
     *
     * @locale en
     * The account of an invited user
     * @locale
     */
    toAccid: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 邀请者邀请的请求id，需要邀请者填写，之后取消邀请、拒绝、接受需要复用该 requestId
     * @locale
     *
     * @locale en
     * The request ID for the invitation specified by the inviter. This request ID will be reused for cancelling, rejecting or accepting the invitation later.
     * @locale
     */
    requestId: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 该操作的附加信息，透传给受邀请者
     *
     * 接收者通过 {@link NIMESignalingEventInterface.signalingCancelInvite | signalingCancelInvite} 事件回调的 `metaData.ext` 属性读取其它用户设置的该属性
     * @locale
     *
     * @locale en
     * additional message, delivered to others without processing
     * @locale
     */
    attachExt?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否存入离线消息。默认 false
     *
     * 若设置为 true，则离线用户上线时，会收到对应消息通知。
     * @locale
     *
     * @locale en
     * Whether messages are stored for offline users. The default value is false.
     * @locale
     */
    needOffline?: boolean;
}
export interface NIMESignalingRejectOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 频道 id
     * @locale
     *
     * @locale en
     * Channel ID
     * @locale
     */
    channelId: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 邀请者的账号 account id
     * @locale
     *
     * @locale en
     * The account of an invited user
     * @locale
     */
    fromAccid: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 邀请者邀请的请求id，需要邀请者填写，之后取消邀请、拒绝、接受需要复用该 requestId
     * @locale
     *
     * @locale en
     * The request ID for the invitation specified by the inviter. This request ID will be reused for cancelling, rejecting or accepting the invitation later.
     * @locale
     */
    requestId: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 该操作的附加信息，透传给其他人
     *
     * 接收者通过 {@link NIMESignalingEventInterface.signalingReject | signalingReject} 事件回调的 `metaData.ext` 属性读取其它用户设置的该属性
     * @locale
     *
     * @locale en
     * additional message, delivered to others without processing
     * @locale
     */
    attachExt?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否存入离线消息。默认 false
     *
     * 若设置为 true，则离线用户上线时，会收到对应消息通知。
     * @locale
     *
     * @locale en
     * Whether messages are stored for offline users. The default value is false.
     * @locale
     */
    needOffline?: boolean;
}
export interface NIMESignalingAcceptOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 频道 id
     * @locale
     *
     * @locale en
     * Channel ID
     * @locale
     */
    channelId: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 邀请者的账号 account id
     * @locale
     *
     * @locale en
     * The account of an invited user
     * @locale
     */
    fromAccid: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 邀请者邀请的请求id，需要邀请者填写，之后取消邀请、拒绝、接受需要复用该 requestId
     * @locale
     *
     * @locale en
     * The request ID for the invitation specified by the inviter. This request ID will be reused for cancelling, rejecting or accepting the invitation later.
     * @locale
     */
    requestId: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 该操作的附加信息，透传给其他人
     *
     * 接收者通过 {@link NIMESignalingEventInterface.signalingAccept | signalingAccept} 事件回调的 `metaData.ext` 属性读取其它用户设置的该属性
     * @locale
     *
     * @locale en
     * additional message, delivered to others without processing
     * @locale
     */
    attachExt?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否存入离线消息。默认 false
     *
     * 若设置为 true，则离线用户上线时，会收到对应消息通知。
     * @locale
     *
     * @locale en
     * Whether messages are stored for offline users. The default value is false.
     * @locale
     */
    needOffline?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 接受邀请后，是否直接加入频道。默认为 false
     * @locale
     *
     * @locale en
     * Whether to directly join the channel after accepting the invitation. The default is false
     * @locale
     */
    autoJoin?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 接受邀请后，自己在频道中对应的uid。大于零有效，无效时服务器会分配随机唯一的uid
     * @locale
     *
     * @locale en
     * The UID of the current user in the channel after accepting the invitation. It is valid if greater than zero. If invalid, the server will assign a random and unique UID
     * @locale
     */
    uid?: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 接受邀请后，加入频道的操作附加信息，将在加入频道通知中带给其他频道成员
     * @locale
     *
     * @locale en
     * Additional information for joining the channel after accepting the invitation. The notification are sent to other channel members when joining the channel.
     * @locale
     */
    joinAttachExt?: string;
}
export interface NIMESignalingSendCustomCommandOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 频道 id
     * @locale
     *
     * @locale en
     * Channel ID
     * @locale
     */
    channelId: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 要通知的目标账号(account id)。如果不传则通知所有人
     * @locale
     *
     * @locale en
     * The target account of a notification, send all members if unspecified
     * @locale
     */
    toAccid?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 该操作的附加信息，透传给其他人
     *
     * 接收者通过 {@link NIMESignalingEventInterface.signalingCustomCommand | signalingCustomCommand} 事件回调的 `metaData.ext` 属性读取其它用户设置的该属性
     * @locale
     *
     * @locale en
     * additional message, delivered to others without processing
     * @locale
     */
    attachExt?: string;
}
/**
 * @Multi_Lang_Tag
 * @locale cn
 * 频道的事件类型，包含在线，同步，离线等
 * @locale
 *
 * @locale en
 * The event type, including online, synchronization, offline
 * @locale
 */
export declare const enum NIMEEnumSignalingEventType {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 1 频道关闭
     * @locale
     *
     * @locale en
     * 1 Close a channel
     * @locale
     */
    kClose = 1,
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 2 加入频道
     * @locale
     *
     * @locale en
     * 2 Join a channel
     * @locale
     */
    kJoin = 2,
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 3 邀请加入频道
     * @locale
     *
     * @locale en
     * 3 invite a user to join a channel
     * @locale
     */
    kInvite = 3,
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 4 取消邀请加入频道
     * @locale
     *
     * @locale en
     * 4 cancel an invitation to join a channel
     * @locale
     */
    kCancelInvite = 4,
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 5 拒绝加入频道
     * @locale
     *
     * @locale en
     * 5 reject to join a channel
     * @locale
     */
    kReject = 5,
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 6 接受加入频道邀请
     * @locale
     *
     * @locale en
     * 6 accept an invitation to join a channel
     * @locale
     */
    kAccept = 6,
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 7 离开
     * @locale
     *
     * @locale en
     * 7 leave a channel
     * @locale
     */
    kLeave = 7,
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 8 自定义
     * @locale
     *
     * @locale en
     * 8 custom event
     * @locale
     */
    kCustom = 8
}
/**
 * @Multi_Lang_Tag
 * @locale cn
 * 信令通知的特征值定义
 * @locale
 *
 * @locale en
 * @locale
 */
export declare const enum NIMEEnumSignalingNotificationFeature {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 0 在线
     * @locale
     *
     * @locale en
     * 0 online
     * @locale
     */
    kDefault = 0,
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 1 离线
     * @locale
     *
     * @locale en
     * 1 offline
     * @locale
     */
    kLeave = 1,
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 3 多端同步
     * @locale
     *
     * @locale en
     * 3 synchronization
     * @locale
     */
    kSelfSync = 3
}
/**
 * @Multi_Lang_Tag
 * @locale cn
 * 信令通知消息元数据定义
 * @locale
 *
 * @locale en
 * @locale
 */
export interface NIMESignalingNotifyMeta {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 通知类型
     * @locale
     *
     * @locale en
     * Notification type
     * @locale
     */
    eventType: NIMEEnumSignalingEventType;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 频道的信息
     * @locale
     *
     * @locale en
     * Channel information
     * @locale
     */
    channelInfo: NIMESignalingChannelInfo;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 该通知的特征值
     * @locale
     *
     * @locale en
     * Notification feature
     * @locale
     */
    feature: NIMEEnumSignalingNotificationFeature;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 该操作的扩展字段
     * @locale
     *
     * @locale en
     * The extension field
     * @locale
     */
    ext?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 该操作的时间戳
     * @locale
     *
     * @locale en
     * the timestamp of the operation
     * @locale
     */
    time: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 该通知的消息 id
     * @locale
     *
     * @locale en
     * Message ID
     * @locale
     */
    msgId: string;
}
/**
 * @Multi_Lang_Tag
 * @locale cn
 * 频道关闭的通知数据
 * @locale
 *
 * @locale en
 * The notification of closing a channel
 * @locale
 */
export interface NIMESignalingCloseNotify {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 操作人的账号 (account id)
     * @locale
     *
     * @locale en
     * The account of an operator
     * @locale
     */
    fromAccid: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 通知的元数据
     * @locale
     *
     * @locale en
     * The metadata of a notification
     * @locale
     */
    metaData: NIMESignalingNotifyMeta;
}
/**
 * @Multi_Lang_Tag
 * @locale cn
 * 加入频道的通知数据
 * @locale
 *
 * @locale en
 * Notification of joining a channel
 * @locale
 */
export interface NIMESignalingJoinNotify {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 加入成员的账号名
     * @locale
     *
     * @locale en
     * The member information used to get the UID.
     * @locale
     */
    fromAccid: string;
    /**
     * 成员在房间里的基本信息
     */
    member: NIMESignalingChannelMemberInfo;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 通知的元数据
     * @locale
     *
     * @locale en
     * The metadata of a notification
     * @locale
     */
    metaData: NIMESignalingNotifyMeta;
}
/**
 * @Multi_Lang_Tag
 * @locale cn
 * 邀请加入频道的通知数据
 * @locale
 *
 * @locale en
 * The metadata of an notification sent for an invitation
 * @locale
 */
export interface NIMESignalingInviteNotify {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 操作者的账号
     * @locale
     *
     * @locale en
     * The account of an operator
     * @locale
     */
    fromAccid: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 被邀请者的账号
     * @locale
     *
     * @locale en
     * The account of an invited user
     * @locale
     */
    toAccid: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 邀请者邀请的请求 id，用于被邀请者回传 requestId 作对应的回应操作
     * @locale
     *
     * @locale en
     * The request ID for an invitation is used by the invitee to respond to the invitation with the corresponding operation
     * @locale
     */
    requestId: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 邀请信息对应的推送属性
     * @locale
     *
     * @locale en
     * Information about a push notification
     * @locale
     */
    pushInfo: NIMESignalingPushInfo;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 通知的元数据
     * @locale
     *
     * @locale en
     * The metadata of a notification
     * @locale
     */
    metaData: NIMESignalingNotifyMeta;
}
/**
 * @Multi_Lang_Tag
 * @locale cn
 * 取消邀请事件的通知数据
 * @locale
 *
 * @locale en
 * The notification of canceling an invitation
 * @locale
 */
export interface NIMESignalingCancelInviteNotify {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 操作者的账号
     * @locale
     *
     * @locale en
     * The account of an operator
     * @locale
     */
    fromAccid: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 被邀请者的账号
     * @locale
     *
     * @locale en
     * The account of an invited user
     * @locale
     */
    toAccid: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 邀请者邀请的请求 id，用于被邀请者回传 requestId 作对应的回应操作
     * @locale
     *
     * @locale en
     * The request ID for an invitation is used by the invitee to respond to the invitation with the corresponding operation
     * @locale
     */
    requestId: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 通知的元数据
     * @locale
     *
     * @locale en
     * The metadata of a notification
     * @locale
     */
    metaData: NIMESignalingNotifyMeta;
}
/**
 * @Multi_Lang_Tag
 * @locale cn
 * 拒绝邀请事件通知信息
 * @locale
 *
 * @locale en
 * Notification of rejecting an invitation
 * @locale
 */
export interface NIMESignalingRejectNotify {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 操作者的账号 ID
     * @locale
     *
     * @locale en
     * Operator's account ID
     * @locale
     */
    fromAccid: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 邀请者的账号
     * @locale
     *
     * @locale en
     * The account of an inviter
     * @locale
     */
    toAccid: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 邀请者邀请的请求 id，用于被邀请者回传 requestId 作对应的回应操作
     * @locale
     *
     * @locale en
     * The request ID for an invitation is used by the invitee to respond to the invitation with the corresponding operation
     * @locale
     */
    requestId: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 通知的元数据
     * @locale
     *
     * @locale en
     * The metadata of a notification
     * @locale
     */
    metaData: NIMESignalingNotifyMeta;
}
/**
 * @Multi_Lang_Tag
 * @locale cn
 * 同意邀请事件通知信息
 * @locale
 *
 * @locale en
 * Notification of accepting an invitation
 * @locale
 */
export interface NIMESignalingAcceptNotify {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 操作者的账号 ID
     * @locale
     *
     * @locale en
     * Operator's account ID
     * @locale
     */
    fromAccid: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 邀请者的账号
     * @locale
     *
     * @locale en
     * The account of an inviter
     * @locale
     */
    toAccid: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 邀请者邀请的请求 id，用于被邀请者回传 requestId 作对应的回应操作
     * @locale
     *
     * @locale en
     * The request ID for an invitation is used by the invitee to respond to the invitation with the corresponding operation
     * @locale
     */
    requestId: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 通知的元数据
     * @locale
     *
     * @locale en
     * The metadata of a notification
     * @locale
     */
    metaData: NIMESignalingNotifyMeta;
}
/**
 * @Multi_Lang_Tag
 * @locale cn
 * 退出频道事件通知信息
 * @locale
 *
 * @locale en
 * Notification of leaving a channel
 * @locale
 */
export interface NIMESignalingLeaveNotify {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 操作者账号
     * @locale
     *
     * @locale en
     * The account of an operator
     * @locale
     */
    fromAccid: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 通知的元数据
     * @locale
     *
     * @locale en
     * The metadata of a notification
     * @locale
     */
    metaData: NIMESignalingNotifyMeta;
}
/**
 * @Multi_Lang_Tag
 * @locale cn
 * 自定义的控制事件通知信息
 * @locale
 *
 * @locale en
 * Notification of Custom command events
 * @locale
 */
export interface NIMESignalingCustomCommandNotify {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 操作者账号
     * @locale
     *
     * @locale en
     * The account of an operator
     * @locale
     */
    fromAccid: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 通知的元数据
     * @locale
     *
     * @locale en
     * The metadata of a notification
     * @locale
     */
    metaData: NIMESignalingNotifyMeta;
}
