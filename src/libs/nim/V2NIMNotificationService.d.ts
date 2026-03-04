import { V2NIMConversationType } from './V2NIMConversationService';
import type { NIMEBaseServiceClass } from './types';
/**
 * v2 通知模块
 *
 * 注: 使用 dist/esm 产物时，需要动态引入 V2NIMNotificationService 后使用
 *
 * @example
 * ```
 * import { NIM, V2NIMNotificationService } from 'nim-web-sdk-ng/dist/esm/nim'
 * NIM.registerService(V2NIMNotificationService, 'V2NIMNotificationService')
 * ```
 */
export declare class V2NIMNotificationService extends NIMEBaseServiceClass<V2NIMNotificationListener> {
    /**
     * 发送自定义通知
     *
     * @param conversationId 会话 id
     * @param content 通知内容
     * @param params 发送通知相关配置参数
     */
    sendCustomNotification(conversationId: string, content: string, params?: V2NIMSendCustomNotificationParams): Promise<void>;
}
export interface V2NIMCustomNotification {
    /** 通知发送者账号 */
    senderId: string;
    /** 通知接收者账号 */
    receiverId: string;
    /** 会话类型 */
    conversationType: V2NIMConversationType;
    /** 时间戳 */
    timestamp: number;
    /** 通知内容 */
    content: string;
    /** 通知相关配置 */
    notificationConfig?: V2NIMNotificationConfig;
    /** 离线推送相关配置 */
    pushConfig?: V2NIMNotificationPushConfig;
    /** 反垃圾相关配置 */
    antispamConfig?: V2NIMNotificationAntispamConfig;
    /** 路由抄送相关配置 */
    routeConfig?: V2NIMNotificationRouteConfig;
}
export interface V2NIMSendCustomNotificationParams {
    /** 通知相关配置 */
    notificationConfig?: V2NIMNotificationConfig;
    /** 离线推送相关配置 */
    pushConfig?: V2NIMNotificationPushConfig;
    /** 反垃圾相关配置 */
    antispamConfig?: V2NIMNotificationAntispamConfig;
    /** 路由抄送相关配置 */
    routeConfig?: V2NIMNotificationRouteConfig;
}
export interface V2NIMNotificationConfig {
    /** 是否需要存离线通知 */
    offlineEnabled?: boolean;
    /** 是否需要计算通知未读 */
    unreadEnabled?: boolean;
    /** 消息id，用于查询系统通知日志 */
    clientNotificationId?: string;
}
export interface V2NIMNotificationPushConfig {
    /** 是否需要推送 */
    pushEnabled?: boolean;
    /** 是否需要推送通知发送者昵称 */
    pushNickEnabled?: boolean;
    /** 推送文案 */
    pushContent?: string;
    /** 推送数据 */
    pushPayload?: string;
    /** 强制推送 */
    forcePush?: boolean;
    /** 强制推送文案 */
    forcePushContent?: string;
    /**
     * 强制推送目标账号
     *
     * 注: 不存在则代表着强推给所有人. 空数组代表没有强推目标. 数组有值代表强推给指定的若干个账号
     */
    forcePushAccountIds: string[];
}
export interface V2NIMNotificationAntispamConfig {
    /** 指定消息是否需要经过安全通 */
    antispamEnabled?: boolean;
    /** 开发者自定义的反垃圾字段，content必须是json格式 */
    antispamCustomNotification?: string;
}
export interface V2NIMNotificationRouteConfig {
    /** 是否需要抄送 */
    routeEnabled?: boolean;
    /** 环境变量。用于指向不同的抄送，第三方回调设置 */
    routeEnvironment?: string;
}
/**
 * 通知模块的监听事件
 *
 * 注: 使用 dist/esm 产物时，需要动态引入 V2NIMNotificationService 后使用
 *
 * @example
 * ```
 * import { NIM, V2NIMNotificationService } from 'nim-web-sdk-ng/dist/esm/nim'
 * NIM.registerService(V2NIMNotificationService, 'V2NIMNotificationService')
 * ```
 */
export interface V2NIMNotificationListener {
    /**
     * 收到自定义通知
     */
    onReceiveCustomNotifications: [customNotification: V2NIMCustomNotification[]];
    /**
     * 收到广播通知
     */
    onReceiveBroadcastNotifications: [broadcastNotification: V2NIMBroadcastNotification[]];
}
export interface V2NIMBroadcastNotification {
    /** 广播 ID */
    id: string;
    /** 发送者账号 */
    senderId: string;
    /** 时间 */
    timestamp: number;
    /** 广播通知内容 */
    content: string;
}
export declare type V2NIMNotificationServiceConfig = {
    /**
     * v1 兼容模式. 默认为 true
     */
    compatibleWithV1?: boolean;
};
