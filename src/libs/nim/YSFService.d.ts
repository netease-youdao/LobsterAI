import { NIMEBaseServiceClass } from './types';
import { V2NIMMessage, V2NIMSendMessageParams, V2NIMSendMessageResult } from './V2NIMMessageService';
import { V2NIMCustomNotification, V2NIMSendCustomNotificationParams } from './V2NIMNotificationService';
/**
 * 云商模块
 *
 * 注: 使用 dist/esm 产物时，需要动态引入 YSFService 后使用
 *
 * @example
 * ```
 * import { NIM, YSFService } from 'nim-web-sdk-ng/dist/esm/nim'
 * NIM.registerService(YSFService, 'YSFService')
 * ```
 */
export declare class YSFService extends NIMEBaseServiceClass<YSFListener> {
    /**
     * 发送消息
     *
     * @param message 消息体, 由 V2NIMMessageCreator 的对应方法创建
     * @param conversationId 会话 id
     * @param params 发送消息相关配置参数
     * @param progress 发送消息进度回调. 作用于需要上传的文件，图片，音视频消息
     */
    sendMessage(message: V2NIMMessage, conversationId: string, params?: V2NIMSendMessageParams, progress?: (percentage: number) => void): Promise<V2NIMSendMessageResult>;
    /**
     * 取消文件类消息的附件上传
     *
     * 注: 若成功取消, 则算为消息发送失败处理
     *
     * @param message 需要取消附件上传的消息体
     */
    cancelMessageAttachmentUpload(message: V2NIMMessage): Promise<void>;
    /**
     * 发送自定义通知
     *
     * @param conversationId 会话 id
     * @param content 通知内容
     * @param params 发送通知相关配置参数
     */
    sendCustomNotification(conversationId: string, content: string, params?: V2NIMSendCustomNotificationParams): Promise<void>;
}
/**
 * 云商模块的事件定义
 *
 * 注: 使用 dist/esm 产物时，需要动态引入 YSFService 后使用
 *
 * @example
 * ```
 * import { NIM, YSFService } from 'nim-web-sdk-ng/dist/esm/nim'
 * NIM.registerService(YSFService, 'YSFService')
 * ```
 */
export interface YSFListener {
    /**
     * 本端发送消息状态回调。
     *
     * 开发者通过监听 sendingState, 以及 attachmentUploadState 状态，可以实现消息发送状态的监听
     */
    onSendMessage: [message: V2NIMMessage];
    /**
     * 收到新消息
     */
    onReceiveMessages: [messages: V2NIMMessage[]];
    /**
     * 收到自定义通知
     */
    onReceiveCustomNotifications: [notifications: V2NIMCustomNotification[]];
}
