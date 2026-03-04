import type { NIMEBaseServiceClass, V2NIMError } from './types';
import { V2NIMDataSyncDetail, V2NIMDataSyncLevel, V2NIMDataSyncState, V2NIMDataSyncType } from './SyncServiceInterface';
/**
 * V2NIMLoginService 模块接口定义
 *
 * 注: v1.0.0 版本开始支持
 */
export declare class V2NIMLoginService extends NIMEBaseServiceClass<V2NIMLoginListener> {
    /**
     * 建立连接，并且登录
     *
     * @param accountId account ID
     * @param token token
     * @param loginOption 登录的额外选项，会覆盖默认的选项。
     *
     * @example
     * ```typescript
     * // default and fixed token
     * try {
     *   await nim1.V2NIMLoginService.login("ACCOUNT_ID", "TOKEN", {
     *     "forceMode": false
     *   })
     * } catch (err) {
     *   // TODO failed, check code
     *   // console.log(err.code)
     * }
     *
     * // or dynamic token
     * try {
     *   await nim.V2NIMLoginService.login("ACCOUNT_ID", "", {
     *     "forceMode": false,
     *     "authType": 1, // V2NIMLoginAuthType.V2NIM_LOGIN_AUTH_TYPE_DYNAMIC_TOKEN
     *     "tokenProvider": function(accountId) {
     *       return Promise.resolve('YOUR_DYNAMIC_TOKEN')
     *     }
     *   })
     * } catch (err) {
     *   // TODO failed, check code
     *   // console.log(err.code)
     * }
     *
     * // or authentication with third-party
     * try {
     *   await nim.V2NIMLoginService.login("ACCOUNT_ID", "", {
     *     "forceMode": false,
     *     "authType": 2, // V2NIMLoginAuthType.V2NIM_LOGIN_AUTH_TYPE_THIRD_PARTY
     *     "loginExtensionProvider": function(accountId) {
     *       return Promise.resolve('YOUR_LOGIN_EXTENSION')
     *     }
     *   })
     * } catch (err) {
     *   // TODO failed, check code
     *   // console.log(err.code)
     * }
     * ```
     */
    login(accountId: string, token: string, loginOption?: V2NIMLoginOption): Promise<void>;
    /**
     * 断开连接。
     *
     * 退出登录状态，并断开 websocket 连接
     *
     * logout 完成后，实例不会被销毁，可再次 login 方法登录
     *
     * @example
     * ```typescript
     * try {
     *   await nim.V2NIMLoginService.logout()
     * } catch (err) {
     *   // TODO failed, check code
     *   // console.log(err.code)
     * }
     * ```
     */
    logout(): Promise<void>;
    /**
     * 获取聊天室 link 地址
     */
    getChatroomLinkAddress(roomId: string, miniProgram: boolean): Promise<Array<string>>;
    /**
     * 获取当前登录的用户账号 ID
     */
    getLoginUser(): string;
    /**
     * 获取当前登录状态
     */
    getLoginStatus(): V2NIMLoginStatus;
    /**
     * 获取连接状态
     */
    getConnectStatus(): V2NIMConnectStatus;
    /**
     * 获取当前数据同步项
     */
    getDataSync(): V2NIMDataSyncDetail[] | null;
    /**
     * 获取本账号的多端登录的其他端的信息
     *
     * 注: 返回的登录端信息里不包含本账号且本端的信息，想要获取本端的信息参照 {@link V2NIMLoginService.getCurrentLoginClient | V2NIMLoginService.getCurrentLoginClient}
     */
    getLoginClients(): V2NIMLoginClient[];
    /**
     * 获取本账号且本端的登录信息
     *
     * 注: 仅当登录为已登录成功时返回 V2NIMLoginClient 有效登录信息, 其他状态都返回空
     */
    getCurrentLoginClient(): V2NIMLoginClient | void;
    /**
     * 踢出当前用户从其它端登录上来的连接
     *
     * @example
     * ```typescript
     * const loginClients = nim.V2NIMLoginService.getLoginClients()
     * try {
     *   if (loginClients && loginClients.length > 0) {
     *     const loginClient = await nim.V2NIMLoginService.kickOffline(loginClients[0])
     *     // todo, success
     *   }
     * } catch (err) {
     *   // TODO failed, check code
     *   // console.log(err.code)
     * }
     * ```
     */
    kickOffline(client: V2NIMLoginClient): Promise<void>;
    /**
     * 获取自己被踢下线的原因
     */
    getKickedOfflineDetail(): V2NIMKickedOfflineDetail | null;
    /**
     * 设置断网重连的等待间隔函数.
     *
     * 接受一个函数作为运算等待间隔的函数, 开发者需要让这个函数返回一个数字作为新重连等待的间隔时间, 单位毫秒.
     *
     * 注, 触发时机: 在连接状态变更为 {@link V2NIMConnectStatus.V2NIM_CONNECT_STATUS_WAITING ｜ V2NIM_CONNECT_STATUS_WAITING} 时触发
     *
     * 注: 为了防止连接过于高频，当开发者在此函数返回小于 1000ms 的值时，SDK 将会在此值的基础上加 [200, 500]ms 的一个随机延迟.
     *
     * @param fn 回调函数. delay: SDK 默认的重连等待的间隔时间. 返回一个数字作为新的重连等待的间隔时间
     */
    setReconnectDelayProvider(fn: V2NIMReconnectDelayProvider): void;
    /**
     * @deprecated v10.9.40 版本开始废弃，改为SDK内部管理后台状态
     * 通知 SDK 应用程序是否可见. 其状态默认为 true.
     *
     * 注: 当不可见时 SDK 会做一些优化操作: 若意外断开后不会重连.
     *
     * 注: 适用场景有两个
     *
     * 1. 应用程序进出前后台; 设置为 false, 代表告知 SDK 其 app 已经处于退后台状态了. true 则处于前台
     * 2. 系统进出熄屏, 休眠, 睡眠状态. 设置为 false, 代表告知 SDK 已经处于熄屏, 休眠状态了. true 则从这个状态中恢复.
     *
     * 注: 当从 false 转为 true 时, sdk 会主动尝试一次重连.
     *
     * 背景: 在某些机型会发生在熄屏, 退后台的状态下, 网络受到了限制, 表现为长连接会意外断开, 定时器触发重连后, 不一会儿又会断开. 反复如此.
     *
     * @param isVisible 是否可见.
     */
    setAppVisibility(isVisible: boolean): void;
}
export declare type V2NIMReconnectDelayProvider = (delay: number) => number;
/**
 * V2NIMLoginDataSync 模块监听事件定义
 */
export interface V2NIMLoginListener {
    /**
     * 登录状态变更通知
     *
     * @example
     * ```ts
     * // logout -> logining -> logined
     * nim.V2NIMLoginService.on("onLoginStatus", function (status: V2NIMLoginStatus) {
     *   switch (status) {
     *     // V2NIMLoginStatus.V2NIM_LOGIN_STATUS_LOGOUT
     *     case 0:
     *       console.log("status => logout")
     *       break;
     *     // V2NIMLoginStatus.V2NIM_LOGIN_STATUS_LOGINED
     *     case 1:
     *       console.log("status => logined")
     *       break;
     *     // V2NIMLoginStatus.V2NIM_LOGIN_STATUS_LOGINING
     *     case 2:
     *       console.log("status => logining")
     *       break;
     *   }
     * })
     * ```
     */
    onLoginStatus: [status: V2NIMLoginStatus];
    /**
     * 登录的鉴权失败通知
     *
     * 注: 登录状态 loginStatus 会从 {@link V2NIMLoginStatus.V2NIM_LOGIN_STATUS_LOGINING} 转移到 {@link V2NIMLoginStatus.V2NIM_LOGIN_STATUS_LOGOUT}
     *
     * @example
     * ```ts
     * nim.V2NIMLoginService.on("onLoginFailed", function (error: V2NIMError) {})
     * ```
     */
    onLoginFailed: [error: V2NIMError];
    /**
     * 被踢下线通知
     *
     * @example
     * ```ts
     * nim.V2NIMLoginService.on("onKickedOffline", function (detail: V2NIMKickedOfflineDetail) {})
     * ```
     */
    onKickedOffline: [detail: V2NIMKickedOfflineDetail];
    /**
     * 多端登陆通知
     *
     * @example
     * ```ts
     * nim.V2NIMLoginService.on("onLoginClientChanged", function (change: V2NIMLoginClientChange, clients: V2NIMLoginClient[]) {})
     * ```
     */
    onLoginClientChanged: [change: V2NIMLoginClientChange, clients: V2NIMLoginClient[]];
    /**
     * 登录的详情-连接状态变更
     *
     * 注: 连接状态 connectStatus 的任何变更都会触发这个事件
     *
     * @example
     * ```ts
     * // disconnected -> (if offline)waiting -> connecting -> connected
     * nim.V2NIMLoginService.on("onConnectStatus", function (status: V2NIMConnectStatus) {
     *   switch (status) {
     *     // V2NIMConnectStatus.V2NIM_CONNECT_STATUS_DISCONNECTED
     *     case 0:
     *       console.log("connectStatus => disconnected")
     *       break;
     *     // V2NIMConnectStatus.V2NIM_CONNECT_STATUS_CONNECTED
     *     case 1:
     *       console.log("connectStatus => connected")
     *       break;
     *     // V2NIMConnectStatus.V2NIM_CONNECT_STATUS_CONNECTING
     *     case 2:
     *       console.log("connectStatus => connecting")
     *       break;
     *     // V2NIMConnectStatus.V2NIM_CONNECT_STATUS_WAITING
     *     case 3:
     *       console.log("connectStatus => waiting for reconnect")
     *       break;
     *   }
     * })
     * ```
     */
    onConnectStatus: [status: V2NIMConnectStatus];
    /**
     * 登录的详情-长连接断开
     *
     * 注: 连接状态 connectStatus 从 {@link V2NIMConnectStatus.V2NIM_CONNECT_STATUS_CONNECTED} 转移到 {@link V2NIMConnectStatus.V2NIM_CONNECT_STATUS_DISCONNECTED}
     *
     * @example
     * ```ts
     * nim.V2NIMLoginService.on("onDisconnected", function (error: V2NIMError) {})
     * ```
     */
    onDisconnected: [error: V2NIMError];
    /**
     * 登录的详情-连接建立失败
     *
     * 注: 连接状态 connectStatus 从 {@link V2NIMConnectStatus.V2NIM_CONNECT_STATUS_CONNECTING} 转移到 {@link V2NIMConnectStatus.V2NIM_CONNECT_STATUS_DISCONNECTED}
     *
     * @example
     * ```ts
     * nim.V2NIMLoginService.on("onConnectFailed", function (error: V2NIMError) {})
     * ```
     */
    onConnectFailed: [error: V2NIMError];
    /**
     * 登录的详情-连接建立成功(2023/07/21 更新, 产品认为这个事件太啰嗦，去掉了)
     *
     * 注: 连接状态 connectStatus 从 {@link V2NIMConnectStatus.V2NIM_CONNECT_STATUS_CONNECTING} 转移到 {@link V2NIMConnectStatus.V2NIM_CONNECT_STATUS_CONNECTED}
     */
    /**
     * 登录的详情-连接建立中(2023/07/21 更新, 产品认为这个事件太啰嗦，去掉了)
     *
     * 注: 连接状态 connectStatus 从 {@link V2NIMConnectStatus.V2NIM_CONNECT_STATUS_DISCONNECTED} 或者是 {@link V2NIMConnectStatus.V2NIM_CONNECT_STATUS_WAITING} 转移到 {@link V2NIMConnectStatus.V2NIM_CONNECT_STATUS_CONNECTING}
     */
    /**
     * 登录的详情-数据同步完成的通知
     *
     * @param type 数据同步中的数据类型
     * @param state 同步状态
     * @param error 出现的错误
     *
     * @example
     * ```ts
     * nim.V2NIMLoginService.on("onDataSync", function (type: V2NIMDataSyncType, state: V2NIMDataSyncState, error?: V2NIMError) {})
     * ```
     */
    onDataSync: [type: V2NIMDataSyncType, state: V2NIMDataSyncState, error?: V2NIMError];
}
export declare type V2NIMLoginOption = {
    /**
     * 重试次数, 默认为 3
     *
     * 注: 这个参数仅能决定开发者主动调用 login 方法时尝试的 socket 连接次数，若是 sdk 进入了实例保持状态，遇到了断网重连的情况时，是会无限次数重连直到登出或者销毁的。
     */
    retryCount?: number;
    /**
     * API 登录的总超时时间。单位 ms, 默认 60000.
     *
     * 注: 这意味着这次调用 API 来发起登录，必须在默认 60000ms 内得到响应, 期间可能尝试了若干(小于 retryCount 数)次登录，
     */
    timeout?: number;
    /**
     * 强制登录模式, 默认为 false
     *
     * 注: 为 true 时, 登录阶段若达到账号的设备连接上限，则本端登录成功，挤掉其他设备登录端
     *
     * 注2: 为 false 时, 登录阶段若达到账号的设备连接上限，则本端登录响应 417 错误码而不是挤掉其他设备的。
     *
     * 注3: 在 sdk 进入断网自动重连的逻辑时, 本字段一直会被当作 false。
     */
    forceMode?: boolean;
    /**
     * 登录鉴权模式
     */
    authType?: V2NIMLoginAuthType;
    /**
     * 提供登录扩展信息
     *
     * 触发时机: 在连接完成且处在登录鉴权校验前触发。
     *
     * 注: 开发者需让这个函数返回一个新的字符串作为第三方登录的扩展信息。
     *
     * 若这个函数执行有异常，或者返回非预期的内容（即非字符串），则登录中止并抛出错误。
     * 建议开发者若传入异步函数，要控制好异步动作的超时时间
     */
    loginExtensionProvider?: V2NIMLoginExtensionProvider;
    /**
     * 刷新 token 的钩子函数。
     *
     * 触发时机: 在连接完成且处在登录鉴权校验前，且鉴权模式 {@link V2NIMLoginOption.authType | authType} 非静态 token 模式时触发。
     *
     * 注: 开发者需让这个函数返回一个新的字符串作为 token.
     *
     * 若这个函数执行有异常，或者返回非预期的内容（即非字符串），则登录中止并抛出错误。
     * 建议开发者若传入异步函数，要控制好异步动作的超时时间
     */
    tokenProvider?: V2NIMTokenProvider;
    /**
     * 要做数据同步的范围. 默认为 0.
     */
    syncLevel?: V2NIMDataSyncLevel;
    /**
     * 登录抄送相关配置
     */
    routeConfig?: V2NIMRouteConfig;
};
export declare type V2NIMRouteConfig = {
    /**
     * 是否需要路由消息抄送。默认 true
     *
     * 注: 抄送需要打开控制台抄送配置
     */
    routeEnabled?: boolean;
    /**
     * 环境变量，用于指向不同的抄送
     *
     * 注: 第三方回调等配置如果不填， 则使用控制台默认抄送地址
     */
    routeEnvironment?: string;
};
export declare type V2NIMTokenProvider = (accountId: string) => Promise<string> | string;
export declare type V2NIMLoginExtensionProvider = (accountId: string) => Promise<string> | string;
/**
 * 登录鉴权模式.
 */
export declare const enum V2NIMLoginAuthType {
    /**
     * 静态 token. 默认方式
     */
    V2NIM_LOGIN_AUTH_TYPE_DEFAULT = 0,
    /**
     * 动态 token
     */
    V2NIM_LOGIN_AUTH_TYPE_DYNAMIC_TOKEN = 1,
    /**
     * 需要第三方回调鉴权
     */
    V2NIM_LOGIN_AUTH_TYPE_THIRD_PARTY = 2
}
export declare const enum V2NIMLoginStatus {
    /**
     * 未登录
     *
     * 注: 初始状态也是未登录.
     */
    V2NIM_LOGIN_STATUS_LOGOUT = 0,
    /**
     * 已登录
     */
    V2NIM_LOGIN_STATUS_LOGINED = 1,
    /**
     * 登录中
     */
    V2NIM_LOGIN_STATUS_LOGINING = 2,
    /**
     * 处在退避间隔中
     *
     * 注: 这是一个中间状态, SDK 将会在这个状态下等待一段时间后再次尝试登录
     */
    V2NIM_LOGIN_STATUS_UNLOGIN = 3
}
/**
 * 登录的端的信息定义
 */
export declare type V2NIMLoginClient = {
    /**
     * 类型
     */
    type: V2NIMLoginClientType;
    /**
     * 操作系统
     */
    os: string;
    /**
     * 登录时间
     */
    timestamp: number;
    /**
     * 自定义信息，最大 32 个字符
     */
    customTag?: string;
    /**
     * 自定义登录端类型
     *
     * 注: 小程序, uniapp, 浏览器, h5 等更为细致的环境区分, 可以通过该字段区分, 开发者请自行做个映射
     */
    customClientType?: number;
    /**
     * 端 id
     */
    clientId: string;
    /**
     * 登录 ip.
     */
    clientIP?: string;
};
export declare const enum V2NIMLoginClientType {
    /**
     * 未知类型
     */
    V2NIM_LOGIN_CLIENT_TYPE_UNKNOWN = 0,
    /**
     * Android
     */
    V2NIM_LOGIN_CLIENT_TYPE_ANDROID = 1,
    /**
     * iOS
     */
    V2NIM_LOGIN_CLIENT_TYPE_IOS = 2,
    /**
     * PC
     */
    V2NIM_LOGIN_CLIENT_TYPE_PC = 4,
    /**
     * Windows phone
     */
    V2NIM_LOGIN_CLIENT_TYPE_WP = 8,
    /**
     * WEB
     */
    V2NIM_LOGIN_CLIENT_TYPE_WEB = 16,
    /**
     * REST API
     */
    V2NIM_LOGIN_CLIENT_TYPE_RESTFUL = 32,
    /**
     * Mac OS
     */
    V2NIM_LOGIN_CLIENT_TYPE_MAC_OS = 64,
    /**
     * HarmonyOS
     */
    V2NIM_LOGIN_CLIENT_TYPE_HARMONY_OS = 65
}
export declare type V2NIMKickedOfflineDetail = {
    /**
     * 原因
     */
    reason: V2NIMKickedOfflineReason;
    /**
     * 描述
     */
    reasonDesc: string;
    /**
     * 客户端类型
     */
    clientType: V2NIMLoginClientType;
    /**
     * 自定义客户端类型
     */
    customClientType: number;
};
export declare const enum V2NIMKickedOfflineReason {
    /**
     * 被另外一个客户端踢下线 (互斥客户端一端登录挤掉上一个登录中的客户端)
     */
    V2NIM_KICKED_OFFLINE_REASON_CLIENT_EXCLUSIVE = 1,
    /**
     * 被服务器踢下线
     */
    V2NIM_KICKED_OFFLINE_REASON_SERVER = 2,
    /**
     * 被另外一个客户端手动调用 API 去踢下线
     */
    V2NIM_KICKED_OFFLINE_REASON_CLIENT = 3,
    /**
     * 被另外一个端静默的踢下线, 该端是同账号且同设备的.
     *
     * 注: 类型 4 是类型 1 的特化，并且是 Web 端专有的类型。
     */
    V2NIM_KICKED_OFFLINE_REASON_CLIENT_QUIETLY = 4
}
export declare const enum V2NIMLoginClientChange {
    /**
     * 端列表刷新
     */
    V2NIM_LOGIN_CLIENT_CHANGE_LIST = 1,
    /**
     * 端登录
     */
    V2NIM_LOGIN_CLIENT_CHANGE_LOGIN = 2,
    /**
     * 端登出
     */
    V2NIM_LOGIN_CLIENT_CHANGE_LOGOUT = 3
}
export declare const enum V2NIMConnectStatus {
    /**
     * 未连接
     */
    V2NIM_CONNECT_STATUS_DISCONNECTED = 0,
    /**
     * 已连接
     */
    V2NIM_CONNECT_STATUS_CONNECTED = 1,
    /**
     * 连接中
     */
    V2NIM_CONNECT_STATUS_CONNECTING = 2,
    /**
     * 等待重连中
     */
    V2NIM_CONNECT_STATUS_WAITING = 3
}
export declare type V2NIMWaitingToConnectEvent = {
    /**
     * 重试次数
     */
    retryCount: number;
    /**
     * 重试间隔
     */
    duration: number;
};
export declare type NIMEModuleParamV2Login = {
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
     * 是否 deviceId 需要固定下来。默认 false。
     *
     * true：sdk 随机对设备生成一个设备标识并存入 localstorage 缓存起来，也就是说一个浏览器来说所有 SDK 实例连接都被认为是共同的设备。
     *
     * false：每一个 sdk 实例连接时，使用随机的字符串作为设备标识，相当于每个实例采用的不同的设备连接上来的。
     *
     * 注意：这个参数会影响多端互踢的策略。有关于多端互踢策略的配置可以参见服务器文档。
     */
    isFixedDeviceId?: boolean;
    /**
     * 自定义客户端类型，大于0
     */
    customClientType?: number;
    /**
     * 客户端自定义 tag, 登录时多端同步该字段，最大32个字符
     */
    customTag?: string;
    /**
     * Websocket 连接是否使用 wss 协议，默认 true.
     *
     * 注: 传 false 将允许 LBS 和 Websocket 连接使用 http 和 ws 协议. 不推荐使用.
     */
    linkSSL?: boolean;
};
