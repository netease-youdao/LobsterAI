import { V2NIMLoginClientType } from './V2NIMLoginService';
import type { NIMEBaseServiceClass } from './types';
/**
 * v2 订阅模块. 包含上下线状态订阅功能.
 *
 * 注: 使用 dist/esm 产物时，需要动态引入 V2NIMSubscriptionService 后使用
 *
 * @example
 * ```
 * import { NIM, V2NIMSubscriptionService } from 'nim-web-sdk-ng/dist/esm/nim'
 * NIM.registerService(V2NIMSubscriptionService, 'V2NIMSubscriptionService')
 * ```
 */
export declare class V2NIMSubscriptionService extends NIMEBaseServiceClass<V2NIMSubscribeListener> {
    /**
     * 订阅用户状态，包括在线状态，或自定义状态
     * 单次订阅人数最多100，如果有较多人数需要调用，需多次调用该接口
     * 如果同一账号多端重复订阅， 订阅有效期会默认后一次覆盖前一次时长
     * 总订阅人数最多3000， 被订阅人数3000，在线状态事件订阅是单向的
     */
    subscribeUserStatus(option: V2NIMSubscribeUserStatusOption): Promise<Array<string>>;
    /**
     * 取消订阅用户状态。返回值为取消订阅失败的用户列表
     */
    unsubscribeUserStatus(option: V2NIMUnsubscribeUserStatusOption): Promise<Array<string>>;
    /**
     * 发布用户自定义状态。如果默认在线状态不满足业务需求，可以发布自定义用户状态
     */
    publishCustomUserStatus(params: V2NIMCustomUserStatusParams): Promise<V2NIMCustomUserStatusPublishResult>;
    /**
     * 查询用户状态订阅关系。
     * 输入账号列表，查询自己订阅了哪些账号列表，返回订阅账号列表
     */
    queryUserStatusSubscriptions(accountIds: Array<string>): Promise<Array<V2NIMUserStatusSubscribeResult>>;
}
/**
 * 订阅模块的监听事件
 *
 * 注: 使用 dist/esm 产物时，需要动态引入 V2NIMSubscriptionService 后使用
 *
 * @example
 * ```
 * import { NIM, V2NIMSubscriptionService } from 'nim-web-sdk-ng/dist/esm/nim'
 * NIM.registerService(V2NIMSubscriptionService, 'V2NIMSubscriptionService')
 * ```
 */
export interface V2NIMSubscribeListener {
    /**
     * 其它用户状态变更，包括在线状态，和自定义状态
     * 同账号发布时，指定了多端同步的状态
     * 在线状态默认值为：登录：1; 登出：2; 断开连接： 3
     *
     * 在线状态事件会受推送的影响：如果应用被清理，但厂商推送（APNS、小米、华为、OPPO、VIVO、魅族、FCM）可达，则默认不会触发该用户断开连接的事件, 若开发者需要该种情况下视为离线，请前往网易云信控制台>选择应用>IM 即时通讯>功能配置>全局功能>在线状态订阅
     */
    onUserStatusChanged: [userStatusList: Array<V2NIMUserStatus>];
}
/**
 * 用户状态
 */
export interface V2NIMUserStatus {
    /**
     * 用户账号 ID
     */
    accountId: string;
    /**
     * 用户状态:
     * - 0: 未知
     * - 1: 登录
     * - 2: 登出
     * - 3: 断开连接
     * - 10000+: 自定义状态 （不包括10000，10000以内为预定义值)
     */
    statusType: number;
    /**
     * 用户发布状态对应的终端
     */
    clientType: V2NIMLoginClientType;
    /**
     * 用户状态发布的服务器时间
     */
    publishTime: number;
    /**
     * 每次发布时，会生成一个唯一id， 发布自定义事件时会生成该参数，如果id相同，表示同一个事件
     */
    uniqueId?: number;
    /**
     * 事件的有效期
     */
    duration?: number;
    /**
     * 用户发布状态时设置的扩展字段
     */
    extension?: string;
    /**
     * 获取预留状态中的配置信息，由服务端填入。JsonArray格式
     */
    serverExtension?: string;
}
/**
 * 订阅用户状态请求参数
 */
export interface V2NIMSubscribeUserStatusOption {
    /**
     * 订阅的成员列表， 为空返回参数错误，单次数量不超过100， 列表数量如果超限参数错误
     */
    accountIds: Array<string>;
    /**
     * 订阅的有效期，时间范围为 60~2592000，单位：秒。过期后需要重新订阅。如果未过期的情况下重复订阅，新设置的有效期会覆盖之前的有效期
     *
     * 默认值为 60
     */
    duration?: number;
    /**
     * 订阅后是否立即同步事件状态值， 默认为false。
     * 为true：表示立即同步当前状态值。30S内重复订阅，会忽略该参数
     */
    immediateSync?: boolean;
}
/**
 * 用户在线状态
 */
export declare const enum V2NIMUserStatusType {
    /**
     * 未知
     */
    V2NIM_USER_STATUS_TYPE_UNKNOWN = 0,
    /**
     * 登录
     */
    V2NIM_USER_STATUS_TYPE_LOGIN = 1,
    /**
     * 登出
     */
    V2NIM_USER_STATUS_TYPE_LOGOUT = 2,
    /**
     * 断开连接
     */
    V2NIM_USER_STATUS_TYPE_DISCONNECT = 3
}
/**
 * 取消订阅用户状态请求参数
 */
export interface V2NIMUnsubscribeUserStatusOption {
    /**
     * 取消订阅的成员列表，为空，则表示取消所有订阅的成员， 否则取消指定的成员。单次数量不超过100， 超过默认截取前100
     */
    accountIds: Array<string>;
}
/**
 * 自定义用户状态
 */
export interface V2NIMCustomUserStatusParams {
    /**
     * 自定义设置值： 10000以上，不包括一万， 一万以内为预定义值。小于1万，返回参数错误
     */
    statusType: number;
    /**
     * 状态的有效期，单位秒，范围为 60s 到 7days
     */
    duration?: number;
    /**
     * 用户发布状态时设置的扩展字段
     */
    extension?: string;
    /**
     * 用户发布状态时是否只广播给在线的订阅者。默认为 true
     */
    onlineOnly?: boolean;
    /**
     * 用户发布状态时是否需要多端同步。默认为 false
     */
    multiSync?: boolean;
}
export interface V2NIMUserStatusSubscribeResult {
    /**
     * 查询的用户账号
     */
    accountId: string;
    /**
     * 状态的有效期，单位秒，范围为 60s 到 30days
     */
    duration: number;
    /**
     * 我的订阅时间
     */
    subscribeTime: number;
}
export interface V2NIMCustomUserStatusPublishResult {
    /**
     * 发布自定义用户状态时， 内部生成的唯一ID
     */
    uniqueId: string;
    /**
     * 服务器针对该状态事件生成的ID
     */
    serverId: string;
    /**
     * 用户状态发布时的时间
     */
    publishTime: number;
}
