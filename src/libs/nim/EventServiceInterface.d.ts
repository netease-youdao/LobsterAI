import { EClientType } from './MsgServiceInterface';
/**
 * 调用方式:
 * ```js
 * nim.event.publishEvent(options)
 * ```
 */
export interface EventServiceInterface {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 发布某事件
     *
     * IM订阅事件分为两类:
     * - 在线状态订阅, 主要用于监听好友的在线状态。这类事件由IM服务器发送。初始化阶段，只有订阅监听的账户在线时，才会收到在线订阅事件
     *  - type = 1, value = 1: 用户在线
     *  - type = 1, value = 2: 用户登出
     *  - type = 1, value = 3: 用户断开连接
     * - 用户自定义事件。如果云信系统内置的在线状态事件无法满足应用需求，需要自定义事件时，可以使用 {@link EventServiceInterface.publishEvent | publishEvent} 来发布自定义事件。用户自定义的订阅事件必须为 type = 1, value >= 10000
     *
     * #### 影响范围
     * - 收到订阅事件的用户会收到 {@link IMEventInterface.pushEvents} 事件
     *
     * @example
     * ```js
     * nim.event.publishEvent({
     *   "type": 1,
     *   "value": 100003,
     *   "ext": "hello world",
     *    // 单位秒
     *   "validTime": 60,
     *   "broadcastType": 2,
     *   "sync": false
     * })
     *
     * // 监听此事件的其它用户
     * nim.on('pushEvents', function (events) {
     *  console.log('收到订阅事件', events)
     * })
     * ```
     *
     * @locale
     *
     * @locale en
     * Publish an event
     * @locale
     */
    publishEvent(options: PublishEventOptions): Promise<PublishEventResult>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 订阅指定用户的事件。无论是内置的在线状态事件或是自定义的事件，都需要通过该 API 订阅后才能接收。
     *
     * 订阅事件后，应用开发者通过 {@link IMEventInterface.pushEvents} 函数监听订阅事件。
     *
     * #### 注意
     * - 每个 IM 帐号最多可订阅 3000 个其他 IM 账号
     * - 同一 IM 账号在其他设备端订阅，会覆盖本端订阅有效期。因此建议各端订阅时长保持一致
     * - 在 30 秒内，对同一 IM 账号的同一事件的订阅，即使设置为立即同步服务，也不会下发目标事件
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/event/%E7%94%A8%E6%88%B7%E4%B8%8A%E7%BA%BF%E4%B8%8B%E7%BA%BF.js" target="_blank">用户上线下线</a></li>
     * </ul>
     *
     * @example
     * ```js
     * nim.event.subscribeEvent({
     *   "type": 1,
     *   "accounts": [
     *     "zk2"
     *   ],
     *   // 订阅有效期: 9000s
     *   "subscribeTime": 9000,
     *   "sync": true
     * })
     * ```
     * @locale
     *
     * @locale en
     * Subscribe to an event
     * @locale
     */
    subscribeEvent(options: SubscribeEventOptions): Promise<SubscribeEventResult>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 根据事件类型，以及订阅的账户列表，取消订阅
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/event/%E7%94%A8%E6%88%B7%E4%B8%8A%E7%BA%BF%E4%B8%8B%E7%BA%BF.js" target="_blank">用户上线下线</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * Unsubscribe from an event
     *
     * Combine unSubscribeEventsByAccounts and unSubscribeEventsByType of IM1
     * @locale
     */
    unSubscribeEvents(options: UnSubscribeEventsOptions): Promise<UnSubscribeEventsResult>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 按照事件类型，以及订阅的账户列表，查询订阅关系
     * @locale
     *
     * @locale en
     * Query subscribed events
     *
     * Combine querySubscribeEventsByAccounts and querySubscribeEventsByType of IM1
     * @locale
     */
    querySubscribeEvents(options: QuerySubscribeEventsOptions): Promise<MsgEventSubscribe[]>;
}
export interface MsgEventSubscribe {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 事件类型
     * @locale
     *
     * @locale en
     * Event type
     * @locale
     */
    type: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 订阅有效期，秒为单位
     * @locale
     *
     * @locale en
     * Subscription validity period (unit: seconds)
     * @locale
     */
    validTime: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否同步
     * @locale
     *
     * @locale en
     * Whether to synchronize subscriptions
     * @locale
     */
    sync: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 被订阅人（也就是事件发布人）的 accid
     * @locale
     *
     * @locale en
     * accid of the event publisher
     * @locale
     */
    to: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 订阅此事件的时间戳
     * @locale
     *
     * @locale en
     * Timestamp of event subscription
     * @locale
     */
    time: number;
}
export interface PublishEventOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 事件类型, 目前只有 1
     * @locale
     *
     * @locale en
     * Event type. Currently only 1.
     * @locale
     */
    type: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 事件状态/事件内容，由上层做自定义映射，value为10000以上(1-9999为云信预定义值，开发者不可使用，1代表上线，2代表下线，3代表断开连接)
     * @locale
     *
     * @locale en
     * Event status/event content, mapped by the upper layer. Valid value: 10,000 or more.
     * Note: 1 to 9999 are predefined values of CommsEase, which cannot be used by developers. 1 for online, 2 for offline, 3 for disconnected.
     * @locale
     */
    value: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 用户自定义事件扩展属性，最长256字节
     * @locale
     *
     * @locale en
     * User-defined event extension attributes (up to 256 bytes)
     * @locale
     */
    ext?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 发布事件的有效时间 单位秒 60s~7天(604800s)，默认7天
     * @locale
     *
     * @locale en
     * The valid time for publishing events (unit: second, valid range: 60 to 604,800 seconds, default value: 604,800 seconds)
     * @locale
     */
    validTime?: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 广播类型 1:仅在线 2:在线和离线
     * @locale
     *
     * @locale en
     * Broadcast Type: 1 indicates “Online Only”; 2 indicates “Online and Offline”.
     * @locale
     */
    broadcastType?: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否同步给自己。若同步给自己，则多端登录账户会收到 {@link IMEventInterface.pushEvents} 事件
     * @locale
     *
     * @locale en
     * Whether to synchronize to yourself
     * @locale
     */
    sync?: boolean;
}
export interface PublishEventResult {
    idClient: string;
    idServer: string;
    time: number;
}
export interface SubscribeEventOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 事件类型, 目前只有 1
     * @locale
     *
     * @locale en
     * Event type. Currently only 1.
     * @locale
     */
    type: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 订阅账户列表
     * @locale
     *
     * @locale en
     * List of subscription accounts
     * @locale
     */
    accounts: string[];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 订阅关系有效期。单位为秒
     * @locale
     *
     * @locale en
     * Subscription validity period
     * @locale
     */
    subscribeTime?: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 订阅后是否立即同步最新事件
     * @locale
     *
     * @locale en
     * Synchronize subscription events
     * @locale
     */
    sync?: boolean;
}
export interface SubscribeEventResult {
    failedAccounts: string[];
}
export interface UnSubscribeEventsOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 事件类型, 目前只有 1
     * @locale
     *
     * @locale en
     * Event type. Currently only 1.
     * @locale
     */
    type: number;
    accounts?: string[];
}
export interface UnSubscribeEventsResult {
    failedAccounts: string[];
}
export interface QuerySubscribeEventsOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 事件类型, 目前只有 1
     * @locale
     *
     * @locale en
     * Event type. Currently only 1.
     * @locale
     */
    type: number;
    /**
     * 订阅的账户ID
     */
    accounts?: string[];
}
export interface PushEvent {
    account: string;
    clientType: EClientType;
    ext: string;
    idClient: string;
    idServer: string;
    time: number;
    type: number;
    value: number;
}
