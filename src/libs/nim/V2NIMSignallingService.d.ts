import type { NIMEBaseServiceClass } from './types';
/**
 * v2 信令模块
 *
 * 注: 使用 dist/esm 产物时，需要动态引入 V2NIMSignallingService 后使用
 *
 * @example
 * ```
 * import { NIM, V2NIMSignallingService } from 'nim-web-sdk-ng/dist/esm/nim'
 * NIM.registerService(V2NIMSignallingService, 'V2NIMSignallingService')
 * ```
 */
export declare class V2NIMSignallingService extends NIMEBaseServiceClass<V2NIMSignallingListener> {
    /**
     * 直接呼叫对方加入房间
     *
     * 注: 这是一个组合接口, 实现了创建房间 createRoom + 自己加入房间 join + 邀请对方加入房间 invite 的功能.
     */
    call(params: V2NIMSignallingCallParams): Promise<V2NIMSignallingCallResult>;
    /**
     * 呼叫建立.
     *
     * 注: 这是一个组合接口, 包括加入信令频道房间， 同时接受对方呼叫
     *
     * @param params 接受呼叫参数
     */
    callSetup(params: V2NIMSignallingCallSetupParams): Promise<V2NIMSignallingCallSetupResult>;
    /**
     * 创建信令房间
     * @param channelType 频道类型
     * @param channelName 频道名称
     * @param channelExtension 频道相关扩展字段
     */
    createRoom(channelType: V2NIMSignallingChannelType, channelName?: string, channelExtension?: string): Promise<V2NIMSignallingChannelInfo>;
    /**
     * 关闭信令房间接口
     * @param channelId 频道ID
     * @param offlineEnabled 是否需要存离线消息。默认为 false
     * @param serverExtension 服务端扩展字段
     */
    closeRoom(channelId: string, offlineEnabled?: boolean, serverExtension?: string): Promise<void>;
    /**
     * 加入信令房间接口
     * @param params 加入信令房间参数
     */
    joinRoom(params: V2NIMSignallingJoinParams): Promise<V2NIMSignallingJoinResult>;
    /**
     * 离开信令房间接口
     * @param channelId 频道ID
     * @param offlineEnabled 是否需要存离线消息。默认为 false
     * @param serverExtension 服务端扩展字段
     */
    leaveRoom(channelId: string, offlineEnabled?: boolean, serverExtension?: string): Promise<void>;
    /**
     * 邀请成员加入信令房间接口
     * @param params 邀请成员加入信令房间接口参数
     */
    invite(params: V2NIMSignallingInviteParams): Promise<void>;
    /**
     * 取消之前的邀请成员加入信令房间接口
     * @param params 取消之前的邀请成员加入信令房间接口参数
     */
    cancelInvite(params: V2NIMSignallingCancelInviteParams): Promise<void>;
    /**
     * 拒绝别人的邀请加入信令房间请求
     * @param params 拒绝邀请加入信令房间接口参数
     */
    rejectInvite(params: V2NIMSignallingRejectInviteParams): Promise<void>;
    /**
     * 接受别人的邀请加入信令房间请求
     * @param params 接受邀请加入信令房间接口参数
     */
    acceptInvite(params: V2NIMSignallingAcceptInviteParams): Promise<void>;
    /**
     * 发送自定义控制指令
     *
     * 注: 可以发送给指定用户， 如果不指定， 则发送给信令房间内的所有人
     *
     * @param channelId 频道ID
     * @param receiverAccountId 接受者ID
     * @param serverExtension 服务端扩展字段
     */
    sendControl(channelId: string, receiverAccountId?: string, serverExtension?: string): Promise<void>;
    /**
     * 根据频道名称查询频道房间信息
     *
     * @param channelName 频道名称
     * @returns 频道房间信息
     */
    getRoomInfoByChannelName(channelName: string): Promise<V2NIMSignallingRoomInfo>;
}
export declare type V2NIMSignallingJoinResult = {
    /**
     * 频道房间相关信息
     */
    roomInfo: V2NIMSignallingRoomInfo;
    /**
     * 音视频房间相关信息
     */
    rtcInfo: V2NIMSignallingRtcInfo;
};
export declare type V2NIMSignallingAcceptInviteParams = {
    /**
     * 信令频道ID
     */
    channelId: string;
    /**
     * 邀请者账号ID
     */
    inviterAccountId: string;
    /**
     * 邀请者创建的请求ID，接受请求时需要填入邀请者填入的 ID，ID 从通知中获取
     */
    requestId: string;
    /**
     * 服务器扩展字段， 长度限制 4096 个字符
     */
    serverExtension?: string;
    /**
     * 是否需要存离线消息。默认 true
     */
    offlineEnabled?: boolean;
};
export declare type V2NIMSignallingRejectInviteParams = {
    /**
     * 信令频道ID
     */
    channelId: string;
    /**
     * 邀请者账号ID
     */
    inviterAccountId: string;
    /**
     * 邀请者创建的请求ID，拒绝请求时需要填入邀请者填入的 ID，ID 从通知中获取
     */
    requestId: string;
    /**
     * 服务器扩展字段， 长度限制 4096 个字符
     */
    serverExtension?: string;
    /**
     * 是否需要存离线消息。默认 true
     */
    offlineEnabled?: boolean;
};
/**
 * 取消之前的邀请成员加入信令房间请求参数
 */
export declare type V2NIMSignallingCancelInviteParams = {
    /**
     * 信令频道ID
     */
    channelId: string;
    /**
     * 被邀请者账号ID
     */
    inviteeAccountId: string;
    /**
     * 邀请者创建的请求ID，取消邀请时需要填入邀请者填入的 ID
     */
    requestId: string;
    /**
     * 服务器扩展字段， 长度限制 4096 个字符
     */
    serverExtension?: string;
    /**
     * 是否需要存离线消息。默认 true
     */
    offlineEnabled?: boolean;
    /**
     * 推送相关配置
     */
    pushConfig?: V2NIMSignallingPushConfig;
};
export declare type V2NIMSignallingInviteParams = {
    /**
     * 信令频道ID
     */
    channelId: string;
    /**
     * 被邀请者账号ID
     */
    inviteeAccountId: string;
    /**
     * 邀请者邀请的请求id，需要邀请者填写，之后取消邀请、拒绝、接受需要复用该 requestId
     */
    requestId: string;
    /**
     * 服务器扩展字段， 长度限制 4096 个字符
     */
    serverExtension?: string;
    /**
     * 信令相关配置
     */
    signallingConfig?: V2NIMSignallingConfig;
    /**
     * 推送相关配置
     */
    pushConfig?: V2NIMSignallingPushConfig;
};
export declare type V2NIMSignallingJoinParams = {
    /**
     * 信令频道ID, 唯一标识了该频道房间
     */
    channelId: string;
    /**
     * 服务器扩展字段， 长度限制 4096 个字符
     */
    serverExtension?: string;
    /**
     * 信令相关配置
     */
    signallingConfig?: V2NIMSignallingConfig;
    /**
     * 音视频相关参数配置
     */
    rtcConfig?: V2NIMSignallingRtcConfig;
};
/**
 * 接受呼叫请求回包
 */
export declare type V2NIMSignallingCallSetupResult = {
    /**
     * 频道房间相关信息
     */
    roomInfo: V2NIMSignallingRoomInfo;
    /**
     * 音视频房间相关信息
     */
    rtcInfo?: V2NIMSignallingRtcInfo;
    /**
     * 呼叫状态
     *
     * 注: 200 为 呼叫成功
     */
    callStatus?: number;
};
/**
 * 呼叫建立请求参数
 */
export declare type V2NIMSignallingCallSetupParams = {
    /**
     * 信令频道ID, 唯一标识了该频道房间
     */
    channelId: string;
    /**
     * 接受的呼叫者账号ID
     */
    callerAccountId: string;
    /**
     * 邀请者邀请的请求id，需要邀请者填写，之后取消邀请、拒绝、接受需要复用该 requestId
     */
    requestId: string;
    /**
     * 服务器扩展字段， 长度限制 4096 个字符
     */
    serverExtension?: string;
    /**
     * 信令相关配置
     */
    signallingConfig?: V2NIMSignallingConfig;
    /**
     * 音视频相关参数配置
     */
    rtcConfig?: V2NIMSignallingRtcConfig;
};
export declare type V2NIMSignallingCallResult = {
    /**
     * 频道房间相关信息
     */
    roomInfo: V2NIMSignallingRoomInfo;
    /**
     * 音视频房间相关信息
     */
    rtcInfo?: V2NIMSignallingRtcInfo;
    /**
     * 呼叫状态
     *
     * 注: 200 为 呼叫成功
     */
    callStatus?: number;
};
export declare type V2NIMSignallingRtcInfo = {
    /**
     * 进入音视频对应的 Token
     */
    rtcToken?: string;
    /**
     * 音视频房间 token 过期时间
     */
    rtcTokenTtl?: number;
    /**
     * 音视频SDK相关参数. JSON 格式化字符串
     */
    rtcParams?: string;
};
/**
 * V2NIMSignallingCallParams
 */
export declare type V2NIMSignallingCallParams = {
    /**
     * 被呼叫者账号ID
     */
    calleeAccountId: string;
    /**
     * 邀请者邀请的请求id，需要邀请者填写，之后取消邀请、拒绝、接受需要复用该 requestId
     */
    requestId: string;
    /**
     * 频道类型
     */
    channelType: V2NIMSignallingChannelType;
    /**
     * 频道名称
     */
    channelName?: string;
    /**
     * 频道相关扩展字段
     */
    channelExtension?: string;
    /**
     * 服务器扩展字段， 长度限制 4096 个字符
     */
    serverExtension?: string;
    /**
     * 信令相关配置
     */
    signallingConfig?: V2NIMSignallingConfig;
    /**
     * 推送相关配置
     */
    pushConfig?: V2NIMSignallingPushConfig;
    /**
     * 音视频相关参数配置
     */
    rtcConfig?: V2NIMSignallingRtcConfig;
};
export declare type V2NIMSignallingConfig = {
    /**
     * 是否需要存离线消息。默认 true
     */
    offlineEnabled?: boolean;
    /**
     * 是否需要计未读。默认 true
     */
    unreadEnabled?: boolean;
    /**
     * 用户 uid
     */
    selfUid?: number;
};
export declare type V2NIMSignallingRtcConfig = {
    /**
     * 云信音视频房间频道名称.
     */
    rtcChannelName?: string;
    /**
     * 音视频房间 token 过期时间
     */
    rtcTokenTtl?: number;
    /**
     * 音视频SDK相关参数. JSON 格式化的字符串
     */
    rtcParams?: string;
};
export declare const enum V2NIMSignallingEventType {
    /**
     * 未知
     */
    V2NIM_SIGNALLING_EVENT_TYPE_UNKNOWN = 0,
    /**
     * 关闭信令频道房间
     */
    V2NIM_SIGNALLING_EVENT_TYPE_CLOSE = 1,
    /**
     * 加入信令频道房间
     */
    V2NIM_SIGNALLING_EVENT_TYPE_JOIN = 2,
    /**
     * 邀请加入信令频道房间
     */
    V2NIM_SIGNALLING_EVENT_TYPE_INVITE = 3,
    /**
     * 取消邀请加入信令频道房间
     */
    V2NIM_SIGNALLING_EVENT_TYPE_CANCEL_INVITE = 4,
    /**
     * 拒绝邀请
     */
    V2NIM_SIGNALLING_EVENT_TYPE_REJECT = 5,
    /**
     * 接受邀请
     */
    V2NIM_SIGNALLING_EVENT_TYPE_ACCEPT = 6,
    /**
     * 离开信令频道房间
     */
    V2NIM_SIGNALLING_EVENT_TYPE_LEAVE = 7,
    /**
     * 自定义控制命令
     */
    V2NIM_SIGNALLING_EVENT_TYPE_CONTROL = 8,
    /**
     * 用户被踢
     */
    V2NIM_SIGNALLING_EVENT_TYPE_KICK = 9
}
/**
 * 信令频道类型
 */
export declare const enum V2NIMSignallingChannelType {
    /**
     * 音频频道
     */
    V2NIM_SIGNALLING_CHANNEL_TYPE_AUDIO = 1,
    /**
     * 视频频道
     */
    V2NIM_SIGNALLING_CHANNEL_TYPE_VIDEO = 2,
    /**
     * 自定义频道
     */
    V2NIM_SIGNALLING_CHANNEL_TYPE_CUSTOM = 3
}
/**
 * 信令频道信息
 */
export declare type V2NIMSignallingChannelInfo = {
    /**
     * 信令频道名称， 如果请求时不传，则该字段为空
     */
    channelName?: string;
    /**
     * 信令频道ID， 唯一标识了该频道房间，后续主要以该字段作为请求标识
     */
    channelId: string;
    /**
     * 频道类型. 房间创建后跟频道类型绑定
     */
    channelType: V2NIMSignallingChannelType;
    /**
     * 频道是否有效. 自 10.8.0+ 支持
     */
    channelValid: boolean;
    /**
     * 频道相关扩展字段， 长度限制4096
     */
    channelExtension?: string;
    /**
     * 频道房间创建时间
     */
    createTime: number;
    /**
     * 频道房间过期时间
     */
    expireTime: number;
    /**
     * 创建者账号 ID
     */
    creatorAccountId: string;
};
/**
 * 信令事件
 */
export declare type V2NIMSignallingEvent = {
    /**
     * 信令频道事件类型
     */
    eventType: V2NIMSignallingEventType;
    /**
     * 信令频道房间相关信息
     */
    channelInfo: V2NIMSignallingChannelInfo;
    /**
     * 操作者ID. 即通知的来源账号ID
     */
    operatorAccountId: string;
    /**
     * 服务器扩展字段，长度限制 4096.
     */
    serverExtension?: string;
    /**
     * 操作的时间点
     */
    time: number;
    /**
     * 被邀请者账号ID，以下场景包含该字段
     *
     * 1. 邀请加入信令频道房间
     * 2. 取消邀请加入信令频道房间
     */
    inviteeAccountId?: string;
    /**
     * 邀请者账号ID，以下场景包含该字段
     *
     * 1. 对方拒绝邀请，
     * 2. 对方接受邀请
     */
    inviterAccountId?: string;
    /**
     * 本次请求发起产生的请求ID,  以下场景包含该字段
     *
     * 1. 邀请加入信令房间
     * 2. 拒绝邀请
     * 3. 接受邀请
     * 4. 取消邀请
     */
    requestId?: string;
    /**
     * 推送相关配置， 以下场景包含该字段，可能为空，依赖于发起方
     *
     * 1. 邀请加入信令房间
     */
    pushConfig?: V2NIMSignallingPushConfig;
    /**
     * 是否需要计未读。默认为 true
     */
    unreadEnabled?: boolean;
    /**
     * 成员信息. 以下场景包含该字段
     *
     * 1. 成员加入房间事件包括该信息
     */
    member?: V2NIMSignallingMember;
};
export declare type V2NIMSignallingRoomInfo = {
    /**
     * 频道房间相关信息.
     */
    channelInfo: V2NIMSignallingChannelInfo;
    /**
     * 成员列表信息
     */
    members: V2NIMSignallingMember[];
};
/**
 * 推送相关配置
 */
export declare type V2NIMSignallingPushConfig = {
    /**
     * 是否需要推送。默认值 true
     */
    pushEnabled?: boolean;
    /**
     * 推送标题. pushEnabled 为 true 必填
     */
    pushTitle?: string;
    /**
     * 推送文案. pushEnabled 为 true 必填
     */
    pushContent?: string;
    /**
     * 推送数据. pushEnabled 为 true 必填
     */
    pushPayload?: string;
};
/**
 * 成员相关信息
 */
export declare type V2NIMSignallingMember = {
    /**
     * 成员账号ID
     */
    accountId: string;
    /**
     * 成员 uid
     */
    uid: number;
    /**
     * 用户加入信令频道房间时间
     */
    joinTime: number;
    /**
     * 用户信令频道房间过期时间
     */
    expireTime: number;
    /**
     * 成员操作的设备ID
     */
    deviceId: string;
};
/**
 * 信令模块的监听定义
 *
 * 注: 使用 dist/esm 产物时，需要动态引入 V2NIMSignallingService 后使用
 *
 * @example
 * ```
 * import { NIM, V2NIMSignallingService } from 'nim-web-sdk-ng/dist/esm/nim'
 * NIM.registerService(V2NIMSignallingService, 'V2NIMSignallingService')
 * ```
 */
export interface V2NIMSignallingListener {
    /**
     * 在线事件回调, 包括以下情形:
     *
     * 1. 关闭房间
     * 2. 加入房间
     * 3. 离开房间
     * 4. 邀请加入房间
     * 5. 取消邀请加入房间
     * 6. 拒绝加入邀请
     * 7. 接受加入邀请
     * 8. 控制事件
     */
    onOnlineEvent: [event: V2NIMSignallingEvent];
    /**
     * 离线事件回调, 包括以下情形:
     *
     * 1. 关闭房间
     * 2. 加入房间
     * 3. 离开房间
     * 4. 邀请加入房间
     * 5. 取消邀请加入房间
     * 6. 拒绝加入邀请
     * 7. 接受加入邀请
     * 8. 控制事件
     */
    onOfflineEvent: [events: V2NIMSignallingEvent[]];
    /**
     * 多端事件操作同步回调. 来自本账号的其他端所触发的事件, 包含以下情形:
     *
     * 1. 拒绝加入邀请
     * 2. 接受加入邀请
     */
    onMultiClientEvent: [event: V2NIMSignallingEvent];
    /**
     * 用户登录SDK后，同步获取到的当前未退出的信令频道列表
     */
    onSyncRoomInfoList: [roomInfoList: V2NIMSignallingRoomInfo[]];
}
export declare type V2NIMSiganllingServiceConfig = {
    /**
     * 是否兼容 v1 格式, 默认 true
     *
     * 注: 若兼容 v1，那么有 v1 模块去标记 ack 足够了；
     */
    compatibleWithV1?: boolean;
};
