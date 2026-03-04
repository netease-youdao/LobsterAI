/**
 * V1NIMLoginService 模块接口定义
 *
 * 注: v1.0.0 版本开始支持
 */
import { TClientType } from './MsgServiceInterface';
export interface V1NIMLoginService {
    /**
     * 实例状态
     */
    status: NIMEInstanceStatus;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 建立连接，并且登录
     * @locale
     *
     * @locale en
     * Establish a connection and log in
     * @locale
     */
    connect(): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 断开连接。
     *
     * 退出登录状态，并断开 websocket 连接
     * disconnect完成后，实例不会被销毁，可再次 connect 方法登录IM
     * @locale
     *
     * @locale en
     * Disconnect.
     *
     * Log out and disconnect the WebSocket connection.
     * After the disconnection completes, the instance will not be destroyed, you can log in to IM by the connect method again.
     * @locale
     */
    disconnect(): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 踢当前用户登录的其它端
     * @locale
     *
     * @locale en
     * Force the account logged in on other devices to go offline.
     * @locale
     */
    kick(options: V1NIMLoginKickOptions): Promise<V1NIMLoginKickResult>;
}
export interface V1NIMLoginListener {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 初始化成功登陆
     * @locale
     *
     * @locale en
     * Initialization succeeded and login
     * @locale
     */
    logined: [loginResult: V1NIMLoginServiceLoginResult];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 多端登陆通知
     * @locale
     *
     * @locale en
     * Multi-device login notification
     * @locale
     */
    multiPortLogin: [multiLoginResults: V1NIMLoginMultiPortLoginResult[]];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 被踢下线
     * @locale
     *
     * @locale en
     * The previous online device is forced by the SDK to go offline when the user logs onto the last device.
     * @locale
     */
    kicked: [kickedReason: V1NIMLoginKickedReason];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 开始自动重连
     * @locale
     *
     * @locale en
     * Start automatic reconnection
     * @locale
     */
    willReconnect: [params: V1NIMLoginWillReconnect];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 连接断开
     *
     * * 注: 此事件不包含被踢而断开的情况<br/>
     * v0.14.0 之前触发条件: 1. 手动断开。 2. 在连接断开后, 自动登录超过重试上限次数。<br/>
     * v0.14.0，包含本版本，更新触发条件: 1. 手动断开。2. 在连接断开后，自动登录超过重试上限次数。3. 登陆保持阶段第一次断开时触发
     * @locale
     *
     * @locale en
     * Disconnect
     * @locale
     */
    disconnect: [];
}
/**
 * @Multi_Lang_Tag
 * @locale cn
 * 实例的状态标识
 *
 * - unconnected: 尚未建立连接(初始化、主动登出、达到最大重连次数)
 * - connecting: 正在建立连接中
 * - connected: 已连接，尚未完成鉴权认证
 * - logined: 已连接, 并且完成了鉴权认证，可以正常开始发送协议
 * - waitReconnect: 等待重连中
 * - destroyed: 实例已经销毁
 * @locale
 *
 * @locale en
 * Status of the instance
 *
 * - unconnected: no connection has been established(Initialization, active logout, and maximum reconnection times)
 * - connecting: Establishing connection
 * - connected: Connected, authentication has not been completed
 * - logined: Connected and completed the authentication
 * - waitReconnect: Waiting for reconnection
 * - destroyed: The instance has been destroyed
 * @locale
 */
export declare type NIMEInstanceStatus = 'unconnected' | 'connecting' | 'connected' | 'logined' | 'waitReconnect' | 'destroyed';
export interface V1NIMLoginKickOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 要踢掉的端的设备号数组
     *
     * 端设备号能在 multiPortLogin 多端登陆事件里拿到
     * @locale
     *
     * @locale en
     * Array of IDs of the devices to be forced to go offline
     *
     * The device ID can be obtained in the {@link IMEventInterface.multiPortLogin | multiPortLogin} event.
     * @locale
     */
    deviceIds: string[];
}
export interface V1NIMLoginKickResult {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 成功被踢掉的设备号数组
     * @locale
     *
     * @locale en
     * Array of IDs of devices that were forced to go offline
     * @locale
     */
    deviceIds: string[];
}
export interface V1NIMLoginServiceLoginResult {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 连接id
     * @locale
     *
     * @locale en
     * connection ID
     * @locale
     */
    connectionId: string;
    ip: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 端口
     * @locale
     *
     * @locale en
     * Port
     * @locale
     */
    port: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 上一次登陆的设备 id
     * @locale
     *
     * @locale en
     * ID of the device that the user logged onto last time
     * @locale
     */
    lastLoginDeviceId?: string;
    country?: string;
    appkey?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 自定义登陆标签
     * @locale
     *
     * @locale en
     * Custom login tag
     * @locale
     */
    customTag?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * AOS 推荐推送配置信息
     * @locale
     *
     * @locale en
     * Recommended AOS push notification configurations
     * @locale
     */
    aosPushInfo?: {
        pushType?: number;
        hasTokenPreviously?: boolean;
    };
}
export interface V1NIMLoginMultiPortLoginResult {
    account: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * socket 连接 id
     * @locale
     *
     * @locale en
     * Socket connection ID
     * @locale
     */
    connectionId: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 设备id
     * @locale
     *
     * @locale en
     * Device ID
     * @locale
     */
    deviceId: string;
    ip: string;
    mac: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否在线
     * @locale
     *
     * @locale en
     * Online or offline
     * @locale
     */
    online: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 系统版本
     * @locale
     *
     * @locale en
     * System version
     * @locale
     */
    os: string;
    time: number;
    type: TClientType;
}
export interface V1NIMLoginKickedReason {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 未知 | 互斥类型的客户端互踢-不允许同一个帐号在多个地方同时登录 | 服务器端发起踢客户端指令-被服务器踢了 | 被自己账号所在的其他端踢掉 | 被悄悄踢掉, 表示这个链接已经废掉了
     * @locale
     *
     * @locale en
     * Unknown | force offline logic for multi-device login – a user is not allowed to use one account to log onto multiple devices at the same time | The server initiates a force offline command - the server forces the user to go offline on the previous device| Force go offline without notice; it means that the link is deprecated.
     * @locale
     */
    reason: 'unknow' | 'samePlatformKick' | 'serverKick' | 'otherPlatformKick' | 'silentlyKick';
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 原因的详细描述
     * @locale
     *
     * @locale en
     * Detailed description for the reason
     * @locale
     */
    message: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 踢了本链接的那个客户端的类型
     * @locale
     *
     * @locale en
     * The type of the client that force logs out the current device
     * @locale
     */
    clientType: TClientType;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 踢了本链接的那个客户端的自定义端类型
     * @locale
     *
     * @locale en
     * The custom type of the client that force logs out the current device
     * @locale
     */
    customClientType: number;
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
}
export interface V1NIMLoginWillReconnect {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 重试次数
     * @locale
     *
     * @locale en
     * Number of reconnection
     * @locale
     */
    retryCount: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 重试间隔
     * @locale
     *
     * @locale en
     * Reconnection interval
     * @locale
     */
    duration: number;
}
export interface NIMEModuleParamV1Login {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 账号 id
     *
     * 注: v1 版登录接口需要在初始化时传入 account
     * @locale
     *
     * @locale en
     * @locale
     */
    account?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 认证 token
     *
     * 注: v1 版登录接口需要在初始化时传入 token
     * @locale
     *
     * @locale en
     * @locale
     */
    token?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否需要自动重连，默认为 true
     * @locale
     *
     * @locale en
     * Whether automatic reconnection is required, the default value is true.
     * @locale
     */
    needReconnect?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 自动重连尝试次数
     * @locale
     *
     * @locale en
     * Automatic reconnection attempts
     * @locale
     */
    reconnectionAttempts?: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * lbs 地址，默认为云信公网提供的链接。SDK 连接时会向 lbs 地址请求得到 socket 连接地址。
     *
     * 注：为了防止 lbs 链接被网络运营商劫持，开发者可以传入自己代理的地址做备份，['公网地址', '代理地址']
     * @locale
     *
     * @locale en
     * Location Based Services (LBS) address. Its default value is the link provided by the CommsEase public network. When the SDK connects, SDK will request the socket address from the LBS address.
     *
     * Note: To prevent the LBS link from being hijacked by the network operator, the developer can pass in their proxy address for backup, ['public network address', 'proxy address']
     * @locale
     */
    lbsUrls?: string[];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * socket 备用地址，当 lbs 请求失败时，尝试直接连接 socket 备用地址。
     *
     * 注：优先级最高的是 lbs 地址下发的 socket 连接地址，
     * 次为开发者在此填的 socket 备用地址（如果不填这个字段， SDK 会有内部默认的备用地址）
     * @locale
     *
     * @locale en
     * Alternative socket address, used when the request for LBS address fails.
     *
     * Note: The socket address sent from the LBS address is of the highest priority.
     * The alternative socket address entered by the developer is of the second-highest priority. If it is not entered, the default alternative address will be adopted.
     * @locale
     */
    linkUrl?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * token 的认证模式，默认 0.
     *
     * 0：token 是固定的
     *
     * 1：token 是动态的，有过期时间。token过期后已登录状态的连接不受影响，但之后的登录需使用新 token。
     *
     * 2：账号和 token 由开发者的服务校验，云信服务器收到登录请求后会转发至开发者服务器，并将其校验结果返回
     * @locale
     *
     * @locale en
     * The authentication mode. The default value is 0.
     *
     * 0：the token is fixed.
     *
     * 1: the token is dynamic and has an expiration time. Connections in a logged-in state are not affected after the token expires, but subsequent logins require a new token.
     *
     * 2: the account and token are verified by the app server. After the NIM server receives the login request, it will forward it to the app server and return the verification result.
     *
     * @locale
     */
    authType?: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 自定义的客户端类型
     * @locale
     *
     * @locale en
     * Custom client type
     * @locale
     */
    customClientType?: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否 deviceId 需要固定下来。默认 false。
     *
     * true：sdk 随机对设备生成一个设备标识并存入 localstorage 缓存起来，也就是说一个浏览器来说所有 SDK 实例连接都被认为是共同的设备。
     *
     * false：每一个 sdk 实例连接时，使用随机的字符串作为设备标识，相当于每个实例采用的不同的设备连接上来的。
     *
     * 注意：这个参数会影响多端互踢的策略。有关于多端互踢策略的配置可以参见服务器文档。
     * @locale
     *
     * @locale en
     * Whether deviceId is fixed, the default value is false.
     *
     * true：SDK randomly generates a device identifier and stores into the LocalStorage cache, all SDK instances are considered to be common devices for a browser.
     *
     * false：When each SDK instance is connected, the random string is used as a device identifier and different devices are used in each instance.
     *
     * Note: This parameter will affect the strategy of multi-device forced logout. For configurations about multi-device forced logout strategies, see the server documentation.
     * @locale
     */
    isFixedDeviceId?: boolean;
    /**
     * 建立连接时的 xhr 请求的超时时间。默认为 8000
     */
    xhrConnectTimeout?: number;
    /**
     * 建立 socket 长连接的超时时间。默认为 8000 ms
     */
    socketConnectTimeout?: number;
    /**
     * Websocket 连接是否使用 wss 协议，默认 true.
     *
     * 注: 传 false 将允许 LBS 和 Websocket 连接使用 http 和 ws 协议. 不推荐使用.
     */
    linkSSL?: boolean;
}
