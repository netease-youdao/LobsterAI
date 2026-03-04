import { NIMECloudSession } from './CloudSessionServiceInterface';
import { NIMEModuleParamCloudStorageConfig } from './CloudStorageServiceInterface';
import { PushEvent } from './EventServiceInterface';
import { FriendProfile } from './FriendServiceInterface';
import { DeleteSelfMsgsResult, IMMessage, NIM_BroadcastMessage, TeamMsgReceipt, p2pMsgReceipt } from './MsgServiceInterface';
import { Session } from './SessionServiceInterface';
import { SuperTeam, SuperTeamMember, SuperTeamMemberType } from './SuperTeamServiceInterface';
import { SyncOptions } from './SyncServiceInterface';
import { SystemMessage, TSystemMessageStatus, TSystemMessageType } from './SystemMessageServiceInterface';
import { Team, TeamMember, TeamMemberType } from './TeamServiceInterface';
import { NIMServiceName, StrAnyObj } from './types';
import { Relations, UserNameCard } from './UserServiceInterface';
import { NIMEInstanceStatus, V1NIMLoginKickOptions, V1NIMLoginKickResult, V1NIMLoginListener, NIMEModuleParamV1Login } from './V1NIMLoginService';
import { V2NIMFriendServiceConfig } from './V2NIMFriendService';
import { NIMEModuleParamV2Login } from './V2NIMLoginService';
import { V2NIMTeamServiceConfig } from './V2NIMTeamService';
export interface NIMConstructor {
    new (options: NIMInitializeOptions, otherOptions?: NIMOtherOptions): NIMInterface;
}
export interface NIMInterface {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 更新初始化传入的第一参数的配置，在初始化完成后使用，在下一次建立连接时生效
     * @locale
     *
     * @locale en
     * Set the options for initialization. The settings are applied for the next connection
     * @locale
     */
    setOptions(options: NIMInitializeOptions): void;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 获取初始化传入的第一参数的配置. v10.8.10+ 支持
     * @locale
     *
     * @locale en
     * Get the options for initialization. v10.8.10+ supported
     * @locale
     */
    getOptions(): NIMInitializeOptions;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 销毁实例
     *
     * - 销毁当前 IM 实例，同时会退出登录状态，并断开websocket连接
     * - 移除所有监听事件，销毁部分内部变量，并且此实例再也无法调用 connect 恢复 IM 连接
     * @locale
     *
     * @locale en
     * Destroy the instance
     *
     * Destroy the current IM instance and log out at the same time, and disconnect the WebSocket connection
     * Remove all listening events, destroy some internal variables, and IM connection can no longer be restored for this instance by calling the connect API.
     * @locale
     */
    destroy(): Promise<void>;
    /**
     * @deprecated Obsolete since v1.0.0, please use {@link V1NIMLoginService.status | V1NIMLoginService.status}
     *
     * @Multi_Lang_Tag
     * @locale cn
     * 实例状态
     *
     * 注: v1.0.0 版本开始, 使用 V2NIMLoginService 模块登录的，这个属性彻底不支持了. 若使用的是原版登录的, 属性移动到了 V1NIMLoginService 中.
     * @locale
     *
     * @locale en
     * @locale
     */
    status: NIMEInstanceStatus;
    /**
     * @deprecated Obsolete since v1.0.0, please use {@link V1NIMLoginService.connect | V1NIMLoginService.connect}
     *
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
     * @deprecated Obsolete since v1.0.0, please use {@link V1NIMLoginService.disconnect | V1NIMLoginService.disconnect}
     *
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
     * @deprecated Obsolete since v1.0.0, please use {@link V1NIMLoginService.kick | V1NIMLoginService.kick}
     *
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
/**
 * @Multi_Lang_Tag
 * @locale cn
 * 类的静态方法
 * @locale
 *
 * @locale en
 * Static method
 * @locale
 */
export interface NIMInterfaceStatic {
    /**
     * 构造函数。多次运行会返回多个实例
     */
    new (options?: NIMInitializeOptions, otherOptions?: NIMOtherOptions): NIMInterface;
    /**
     * SDK 的版本号, 数字格式输出.
     */
    sdkVersion: number;
    /**
     * SDK 的版本号, 字符串格式输出.
     */
    sdkVersionFormat: string;
    /**
     * 单例模式获取实例。多次运行返回单个实例
     */
    getInstance(_options?: NIMInitializeOptions, _otherOptions?: NIMOtherOptions): NIMInterface;
    /**
     * 注册模块. 使用 dist/esm 产物时的 NIM 类专用
     *
     * 一般用户根据运行环境，选择不同的打包产物。这些产物预先注册了适配器，以及所有的模块
     * - 浏览器环境: NIM_BROWSER_SDK
     * - uniapp: NIM_UNIAPP_SDK
     * - 小程序: NIM_MINIAPP_SDK
     *
     * 若使用 使用 dist/esm 产物时，则需要手动设置适配器，以及注册模块
     *
     * @example
     * ```js
     * import { NIM, setAdapters, browserAdapters, V2NIMMessageService, V2NIMConversationService } from 'nim-web-sdk-ng/dist/esm'
     *
     * // 设置环境适配器-浏览器
     * setAdapters(browserAdapters)
     *
     * // 使用 dist/esm 产物时，IM 依赖的能力需要自行注册，而不用的模块最后能被 tree-shaking 掉。
     * NIM.registerService(V2NIMMessageService, 'V2NIMMessageService')
     * NIM.registerService(V2NIMConversationService, 'V2NIMConversationService')
     * ```
     * @param _serviceClass 模块类
     * @param _serviceName 标识的模块名
     */
    registerService(_serviceClass: any, _serviceName: NIMServiceName): void;
}
/**
 * @Multi_Lang_Tag
 * @locale cn
 * NIM 的构造函数初始化参数
 *
 * eg. NIM.getInstance({ ...NIMInitializeOptions })
 * @locale
 *
 * @locale en
 * Initialization parameters of NIM's constructor
 *
 * eg. NIM.getInstance({ ...NIMInitializeOptions })
 * @locale
 */
export interface NIMInitializeOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * app key, 向云信申请的产品标识
     * @locale
     */
    appkey: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 日志级别，默认为 off，即不输出任何日志
     *
     * - off: 不输出任何日志
     * - debug: 输出所有日志
     * - log: 输出 log、warn、 error 级别的日志
     * - warn: 输出 warn 和 error 级别的日志
     * - error: 输出 error 级别的日志
     * @locale
     *
     * @locale en
     * Log classification
     *
     * Available values, "off" | "error" | "warn" | "log" | "debug"
     * @locale
     */
    debugLevel?: string;
    /**
     * API 版本.
     *
     * 可选值: v1、v2. 默认 v1
     *
     * 从 SDK 版本 1.0.0 开始生效, 允许开发者手动传入来指定 API 的版本
     *
     * 当 API 版本被设置为 v2 后, 开发者只能通过 V2NIMLoginService 模块来登录, 并且返回的 error code 按照 v2 模式提供.
     *
     * 注: 此值只能在初始化时被指定一次，不能在实例存在时被修改. 想更换版本需要先销毁此实例重新创建.
     */
    apiVersion?: string;
    /**
     * 是否采用二进制的形式传输数据，仅在 apiVersion 为 v2 时生效，默认为 true
     */
    binaryWebsocket?: boolean;
    /**
     * @deprecated please use {@link NIMOtherOptions.V1NIMLoginServiceConfig | NIMOtherOptions.V1NIMLoginServiceConfig } instead
     */
    account?: string;
    /**
     * @deprecated please use {@link NIMOtherOptions.V1NIMLoginServiceConfig | NIMOtherOptions.V1NIMLoginServiceConfig } instead
     */
    token?: string;
    /**
     * @deprecated please use {@link NIMOtherOptions.V1NIMLoginServiceConfig | NIMOtherOptions.V1NIMLoginServiceConfig } instead
     */
    needReconnect?: boolean;
    /**
     * @deprecated please use {@link NIMOtherOptions.V1NIMLoginServiceConfig | NIMOtherOptions.V1NIMLoginServiceConfig } instead
     */
    reconnectionAttempts?: number;
    /**
     * @deprecated please use {@link NIMOtherOptions.V1NIMLoginServiceConfig | NIMOtherOptions.V1NIMLoginServiceConfig } instead
     */
    lbsUrls?: string[];
    /**
     * @deprecated please use {@link NIMOtherOptions.V1NIMLoginServiceConfig | NIMOtherOptions.V1NIMLoginServiceConfig } instead
     */
    linkUrl?: string;
    /**
     * @deprecated please use {@link NIMOtherOptions.V1NIMLoginServiceConfig | NIMOtherOptions.V1NIMLoginServiceConfig } instead
     */
    authType?: number;
    /**
     * @deprecated please use {@link NIMOtherOptions.V1NIMLoginServiceConfig | NIMOtherOptions.V1NIMLoginServiceConfig } instead
     */
    customClientType?: number;
    /**
     * @deprecated please use {@link NIMOtherOptions.V1NIMLoginServiceConfig | NIMOtherOptions.V1NIMLoginServiceConfig } instead
     */
    isFixedDeviceId?: boolean;
    /**
     * @deprecated please use {@link NIMOtherOptions.V1NIMLoginServiceConfig | NIMOtherOptions.V1NIMLoginServiceConfig } instead
     */
    xhrConnectTimeout?: number;
    /**
     * @deprecated please use {@link NIMOtherOptions.V1NIMLoginServiceConfig | NIMOtherOptions.V1NIMLoginServiceConfig } instead
     */
    socketConnectTimeout?: number;
    /**
     * @deprecated please use {@link NIMOtherOptions.abtestConfig | NIMOtherOptions.abtestConfig } instead
     */
    isAbtestEnable?: boolean;
    /**
     * @deprecated please use {@link NIMOtherOptions.abtestConfig | NIMOtherOptions.abtestConfig } instead
     */
    abtestUrl?: string;
    loginSDKTypeParamCompat?: boolean;
    /**
     * flutter 的版本号. v10.6.0+ 支持
     *
     * 注: 当是 flutter 开发环境时可以传这个字段, 用来向服务器标识 flutter SDK 的版本
     */
    flutterSdkVersion?: string;
    /**
     * 是否开启云端会话. 默认 false
     *
     * 注: 为 false 时, V2NIMConversationService, V2NIMConversationGroupService 模块无法使用. 请用 V2NIMLocalConversation 替代
     */
    enableV2CloudConversation?: boolean;
}
export interface NIMOtherOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * v2 登录模块的特殊配置
     *
     * 注: v2 登录模块需要在 1.0.0 版本开始支持
     * @locale
     */
    V2NIMLoginServiceConfig?: NIMEModuleParamV2Login;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * v1 登录模块的特殊配置
     *
     * 注: 这个配置在 1.0.0 版本开始支持. 用于接收原本在初始化第一个参数 {@link NIMInitializeOptions | NIMInitializeOptions} 的 account、token 等字段
     * @locale
     */
    V1NIMLoginServiceConfig?: NIMEModuleParamV1Login;
    /**
     * @deprecated please use {@link NIMOtherOptions.syncConfig | syncConfig} instead
     */
    syncOptions?: SyncOptions;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 同步模块的选项配置
     *
     * 注: 自 1.0.0 版本开始支持
     * @locale
     *
     * @locale en
     * Configuration for the synchronization module
     * @locale
     */
    syncConfig?: SyncOptions;
    /**
     * 同步模块的选项配置.
     *
     * 注: 若初始化第一参数中 apiVersion 是 v2 时, syncConfig 失效, 而 V2NIMSyncServiceConfig 生效.
     */
    V2NIMSyncServiceConfig?: SyncOptions;
    /**
     * 本地反垃圾词库的配置
     */
    V2NIMClientAntispamUtilConfig?: NIMEModuleParamV2NIMClientAntispamUtil;
    /**
     * v10 好友相关配置. v10.9.60+ 支持
     */
    V2NIMFriendServiceConfig?: V2NIMFriendServiceConfig;
    /**
     * v10 群相关配置. v10.9.70+ 支持
     */
    V2NIMTeamServiceConfig?: V2NIMTeamServiceConfig;
    /**
     * @deprecated 这个字段即将废弃，所有的属性被移入 {@link NIMOtherOptions.cloudStorageConfig} 中
     *
     * @Multi_Lang_Tag
     * @locale cn
     * 私有化配置相关参数
     * 这个参数仅在初始化有效，setOptions{@link NIMInterface.setOptions | setOptions}中不生效
     * @locale
     *
     * @locale en
     * On-premises deployment configuration parameter
     * This parameter is only effective during initialization and does not take effect in setOptions{@link NIMInterface.setOptions | setOptions}.
     * @locale
     */
    serverConfig?: ServerConfig;
    /**
     * @deprecated
     *
     * session 模块配置
     */
    sessionConfig?: {
        /**
         * 过滤函数: 由在线/同步/多端同步的消息触发的更新会话过程中，该函数判定这条消息是否允许被计入 session 的未读数
         *
         * 默认返回 true，该消息计入 session 未读数。
         *
         * #### 示例场景
         * <ul>
         * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/session/%E6%9C%AA%E8%AF%BB%E6%B6%88%E6%81%AF%E6%95%B0%E9%87%8F.js" target="_blank">未读消息数量</a></li>
         * </ul>
         */
        unreadCountFilterFn?: (_msg: IMMessage) => boolean;
        /**
         * 过滤函数: 由在线/同步/多端同步的消息触发的更新会话过程中，该函数判定这条消息是否允许被计入 session.lastMessage 的更新
         *
         * 默认返回 true，该消息计入 session.lastMessage 的更新。
         *
         * #### 示例场景
         * <ul>
         * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/session/%E6%9C%AA%E8%AF%BB%E6%B6%88%E6%81%AF%E6%95%B0%E9%87%8F.js" target="_blank">未读消息数量</a></li>
         * </ul>
         */
        lastMessageFilterFn?: (_msg: IMMessage) => boolean;
    };
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * cloud storage 模块配置
     * @locale
     *
     * @locale en
     * cloud storage config
     * @locale
     */
    cloudStorageConfig?: NIMEModuleParamCloudStorageConfig;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * SDK 上报收集数据的配置
     *
     * 注: v1.0.0 开始支持
     * @locale
     *
     * @locale en
     * Data reporting config
     * @locale
     */
    reporterConfig?: NIMOtherOptionsReporterConfig;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * ABtest 配置
     *
     * 注: v1.0.0 开始支持
     * @locale
     *
     * @locale en
     * ABTest configuration
     * @locale
     */
    abtestConfig?: NIMOtherOptionsAbtestConfig;
    /**
     * 日志模块的配置
     */
    loggerConfig?: NIMOtherOptionsLoggerConfig;
    /**
     * 私有化配置. v10.5.0+ 支持
     */
    privateConf?: NIMOtherOptionsPrivateConfig;
    /**
     * qchatChannel 的模块配置
     */
    qchatChannelConfig?: {
        /**
         * @Multi_Lang_Tag
         * @locale cn
         * 是否开启自动订阅，默认 false 关闭
         *
         * @locale
         *
         * @locale en
         * Whether automatic subscription is enabled. The default value is false.
         * @locale
         */
        autoSubscribe?: boolean;
    };
    /**
     * qchatMedia 的模块配置
     */
    qchatMediaConfig?: {
        /**
         * NERoom SDK
         *
         * QChatMedia 配合 NERoom SDK 使用
         */
        neroom?: any;
    };
}
export declare type NIMEModuleParamV2NIMClientAntispamUtil = {
    /**
     * 是否打开本地反垃圾. 默认为 false
     *
     * 注: 需要在 IM 控制台配置本地反垃圾词库. 本开关打开后将会在登录完成后下载反垃圾词库.
     */
    enable?: boolean;
};
export declare type NIMOtherOptionsLoggerConfig = {
    /**
     * 日志等级. 默认 off 关闭日志打印.
     *
     * 注: 分别是关闭日志打印 | 打印 error 日志 | 打印 warn 级别及以上 | 打印 log 级别及以上 | 打印 debug 级别及以上
     */
    debugLevel?: 'off' | 'error' | 'warn' | 'log' | 'debug';
    /**
     * 日志代理函数.
     *
     * 注: 拥有四个等级的日志输出方法. 所有日志经过这些方法代理.
     *
     * 注2: 代理函数的入参包含一个或者多个参数, 参数的类型为基础类型
     */
    logFunc?: {
        debug?: (...args: any) => void;
        log?: (...args: any) => void;
        warn?: (...args: any) => void;
        error?: (...args: any) => void;
    };
    /**
     * 持久日志存储是否打开. 默认 true 打开
     *
     * 注: 仅在浏览器与微信小程序环境里支持. 只会存储 log 级别及以上的日志
     */
    storageEnable?: boolean;
    /**
     * @deprecated 请替代使用 logDirPath 属性.
     */
    storageName?: string;
    /**
     * 持久存储日志的标识名(数据库名/文件名). v10.9.60+ 支持.
     *
     * 注: 仅在浏览器与微信小程序环境里支持. 默认为 nim_logs
     */
    logDirPath?: string;
    /**
     * 日志存储天数. v10.9.60+ 支持
     *
     * 注: 仅浏览器与 uniapp 编 APP 环境支持. 单位天, 最小值 1, 最大值 30. 默认值 10 天.
     */
    logRetentionDays?: number;
    /**
     * 日志存储大小. v10.9.60+ 支持
     *
     * 注: 仅在微信小程序环境与 uniapp 编 APP 环境里支持. 单位 MB, 最小值10, 最大 500MB. 默认值 200MB.
     */
    totalLogSizeInMB?: number;
    /**
     * 单个文件存储大小. v10.9.60+ 支持
     *
     * 注: 仅在微信小程序环境与 uniapp 编 APP 环境里支持. 单位 MB, 最小值 1, 最大值 200MB. 默认值 10MB.
     */
    maxLogFileSizeInMB?: number;
};
export declare type NIMOtherOptionsAbtestConfig = {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * ABtest 是否开启，默认 true 开启
     *
     * 注: 打开这个开关，在 sdk 内部会试探某些新功能的开启，建议开发者不要轻易设置它。
     * @locale
     *
     * @locale en
     * Whether Abtest is enabled. The default value is true
     *
     * Note: If you turn on the switch, the SDK attempts to enable certain new features. You are recommended not turn on it.
     * @locale
     */
    isAbtestEnable?: boolean;
    /**
     * abTest 服务器下发地址
     */
    abtestUrl?: string;
};
export declare type NIMOtherOptionsPrivateConfig = {
    /**
     * 私有化配置的 appkey.
     *
     * 注: 会覆盖初始化第一参数里的 appkey
     */
    appkey?: string;
    /**
     * lbs 地址
     */
    weblbsUrl?: string;
    /**
     * 默认的 tcp 连接地址
     */
    link_web?: string;
    /**
     * 上传地址
     */
    nos_uploader?: string;
    /**
     * 下载地址的格式
     */
    nos_downloader_v2?: string;
    /**
     * 下载地址是否启用 https 协议
     */
    nosSsl?: boolean;
    /**
     * cdn 加速域名的匹配格式: 接到消息后附件里的链接若匹配到 nos_accelerate_host, 会按这个格式替换
     */
    nos_accelerate?: string;
    /**
     * cdn 加速域名的命中域名. 如果为空字符串代表放弃 cdn 加速域名逻辑
     */
    nos_accelerate_host?: string;
    /**
     * 数据上报域名
     */
    compassDataEndpoint?: string;
    /**
     * 是否开启数据上报。默认开启
     */
    enableCompass?: boolean;
    /**
     * 其他无用的配置项
     */
    [key: string]: any;
};
/**
 * 上报配置
 */
export declare type NIMOtherOptionsReporterConfig = {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 指南针是否开启，默认是 true
     * @locale
     *
     * @locale en
     * Whether compass is enabled. The default value is true
     * @locale
     */
    enableCompass?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 指南针数据默认端点
     * @locale
     *
     * @locale en
     * Default endpoint for compass data
     * @locale
     */
    compassDataEndpoint?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * @deprecated
     * 是否开启数据上报，默认是true
     * @locale
     *
     * @locale en
     * @deprecated
     * Whether data reporting is enabled. The default value is true
     * @locale
     */
    isDataReportEnable?: boolean;
};
export interface ServerConfig {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * NOS上传地址（直传）
     * 小程序、UniApp上传地址
     * @locale
     *
     * @locale en
     * Address of NOS upload (direct transfer)
     * MiniApp, UniApp upload address
     * @locale
     */
    commonUploadHost?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 小程序、UniApp上传地址备用域名
     * @locale
     *
     * @locale en
     * MiniApp, UniApp upload backup address array
     * @locale
     */
    commonUploadHostBackupList?: string[];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * NOS上传地址（分片）。默认为: 'https://wannos-web.127.net'
     * @locale
     *
     * @locale en
     * NOS upload address (chunk)
     * @locale
     */
    chunkUploadHost?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 发送文件消息中文件的url的通配符地址，默认的地址为：'https://{host}/{object}'
     * @locale
     *
     * @locale en
     * Wildcard address of the file URL in the file message, for example: 'https://{host}/{object}'.
     * @locale
     */
    uploadReplaceFormat?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 接收到文件消息的替换模版
     * 这个是用来接到消息后，要按一定模式替换掉文件链接的。给予一个安全下载链接。
     * 例：'https://{bucket}-nosdn.netease.im/{object}'
     * @locale
     *
     * @locale en
     * The template for the URL of the received file of a file message
     * If a file messages is received, the URL of a file is replaced with a specified patten for a secured download URL
     * Example: 'https://{bucket}-nosdn.netease.im/{object}'
     * @locale
     */
    downloadUrl?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 收到哪些host地址，需要替换成downloadUrl，例：收到nos.netease.com/{bucket}/{obj}
     * @locale
     *
     * @locale en
     * The received addresses to be replaced with downloadUrl, for example: nos.netease.com/{bucket}/{obj}.
     * @locale
     */
    downloadHostList?: string[];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 服务器下发的域名存在，并且对象前缀匹配成功，那么强行替换为`${protocol}${serverCdnDomain}/${decodePath.slice(prefixIndex)}`
     * @locale
     *
     * @locale en
     * If the domain name issued by the server exists and the object prefix matches, it will be forcibly replaced with `${protocol}${serverCdnDomain}/${decodePath.slice(prefixIndex)}`
     * @locale
     */
    nosCdnEnable?: boolean;
    /**
     * NOS 上传专用的cdn配置
     */
    cdn?: {
        /**
         * 默认的文件下载地址的域名，替代上文中 {@link serverConfig.uploadReplaceFormat} 中的 host。
         */
        defaultCdnDomain: string;
        /**
         * 文件下载地址的域名，用于替换上文中 {@link serverConfig.uploadReplaceFormat} 中的 host。默认会从服务器中获取这个下载地址的域名配置。
         */
        cdnDomain: string;
        /**
         * 桶名。默认是 nim
         */
        bucket: string;
        /**
         * 匹配前缀
         */
        objectNamePrefix: string;
    };
}
/**
 * Example：
 *
 * const instance = new SDK()
 *
 * instance.on('logined', loginResult => { console.log(loginResult.connectionId) }
 */
export interface IMEventInterface {
    /**
     * @deprecated since 1.0.0, please use {@link V1NIMLoginListener.logined | V1NIMLoginListener.logined } instead
     *
     * @Multi_Lang_Tag
     * @locale cn
     * 初始化成功登陆
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/event/%E7%94%A8%E6%88%B7%E4%B8%8A%E7%BA%BF%E4%B8%8B%E7%BA%BF.js" target="_blank">用户上线下线</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * Initialization succeeded and login
     * @locale
     */
    logined: V1NIMLoginListener['logined'];
    /**
     * @deprecated since 1.0.0, please use {@link V1NIMLoginListener.multiPortLogin | V1NIMLoginListener.multiPortLogin } instead
     *
     * @Multi_Lang_Tag
     * @locale cn
     * 多端登陆通知
     * @locale
     *
     * @locale en
     * Multi-device login notification
     * @locale
     */
    multiPortLogin: V1NIMLoginListener['multiPortLogin'];
    /**
     * @deprecated since 1.0.0, please use {@link V1NIMLoginListener.kicked | V1NIMLoginListener.kicked } instead
     *
     * @Multi_Lang_Tag
     * @locale cn
     * 被踢下线
     * @locale
     *
     * @locale en
     * The previous online device is forced by the SDK to go offline when the user logs onto the last device.
     * @locale
     */
    kicked: V1NIMLoginListener['kicked'];
    /**
     * @deprecated since 1.0.0, please use {@link V1NIMLoginListener.willReconnect | V1NIMLoginListener.willReconnect } instead
     *
     * @Multi_Lang_Tag
     * @locale cn
     * 开始自动重连
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/connect/%E5%8A%A8%E6%80%81token.js" target="_blank">动态token</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * Start automatic reconnection
     * @locale
     */
    willReconnect: V1NIMLoginListener['willReconnect'];
    /**
     * @deprecated since 1.0.0, please use {@link V1NIMLoginListener.disconnect | V1NIMLoginListener.disconnect } instead
     *
     * @Multi_Lang_Tag
     * @locale cn
     * 连接断开
     *
     * 注: 此事件不包含被踢而断开的情况<br/>
     * v0.14.0 之前触发条件: 1. 手动断开。 2. 在连接断开后, 自动登录超过重试上限次数。<br/>
     * v0.14.0，包含本版本，更新触发条件: 1. 手动断开。2. 在连接断开后，自动登录超过重试上限次数。3. 登陆保持阶段第一次断开时触发
     * @locale
     *
     * @locale en
     * Disconnect
     * @locale
     */
    disconnect: V1NIMLoginListener['disconnect'];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 收到消息
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/message/%E6%B6%88%E6%81%AF%E9%98%9F%E5%88%97%E7%BB%B4%E6%8A%A4.js" target="_blank">消息队列维护</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * Received the message
     * @locale
     */
    msg: [msg: IMMessage];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 收到广播消息（在线或者离线同步收到均会触发）
     * @locale
     *
     * @locale en
     * Received the broadcast message
     * @locale
     */
    broadcastMsgs: [msgs: NIM_BroadcastMessage[]];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 调用 {@link MsgServiceInterface.deleteSelfMsgs | deleteSelfMsgs}后，账号的多端登录实例会收到此通知
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/message/%E5%8D%95%E5%90%91%E5%88%A0%E9%99%A4%E6%B6%88%E6%81%AF.js" target="_blank">单向删除消息</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * Received notification on the one-way deletion of a message.
     * @locale
     */
    deleteSelfMsgs: [result: DeleteSelfMsgsResult[]];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 在初始化同步/多端同步时，收到了清除历史消息的通知
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/session/%E5%88%A0%E9%99%A4%E4%BC%9A%E8%AF%9D.js" target="_blank">删除会话</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * Received a notification of clearing the message history during initialization/synchronization across devices.
     * @locale
     */
    clearServerHistoryMsgs: [
        result: {
            /**
             * @Multi_Lang_Tag
             * @locale cn
             * 会话 id
             * @locale
             *
             * @locale en
             * Session ID
             * @locale
             */
            sessionId: string;
            /**
             * @Multi_Lang_Tag
             * @locale cn
             * 清除的时刻
             * @locale
             *
             * @locale en
             * Time when a session is cleared
             * @locale
             */
            time: number;
        }[]
    ];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 收到了代理消息（透传的）
     * @locale
     *
     * @locale en
     * Received transparently-transmitted proxy message.
     * @locale
     */
    proxyMsg: [proxyMsg: TProxyMsg];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 同步时收到了漫游消息
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/message/%E6%B6%88%E6%81%AF%E9%98%9F%E5%88%97%E7%BB%B4%E6%8A%A4.js" target="_blank">消息队列维护</a></li>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/session/%E5%B7%B2%E8%AF%BB%E5%9B%9E%E6%89%A7-%E5%8D%95%E8%81%8A.js" target="_blank">已读回执-单聊</a></li>
     * </ul>
     *
     * @locale
     *
     * @locale en
     * Received roaming messages during the synchronization.
     * @locale
     */
    syncRoamingMsgs: [syncRoamingMsgsResult: SyncRoamingMsgsResult];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 同步时收到了离线消息
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/message/%E6%B6%88%E6%81%AF%E9%98%9F%E5%88%97%E7%BB%B4%E6%8A%A4.js" target="_blank">消息队列维护</a></li>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/session/%E5%B7%B2%E8%AF%BB%E5%9B%9E%E6%89%A7-%E5%8D%95%E8%81%8A.js" target="_blank">已读回执-单聊</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * Received offline messages during the synchronization.
     * @locale
     */
    syncOfflineMsgs: [syncRoamingMsgsResult: SyncOfflineMsgsResult];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 同步时收到了个人信息
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/user/%E4%B8%AA%E4%BA%BA%E8%B5%84%E6%96%99.js" target="_blank">个人资料</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * Received profile information during the synchronization.
     * @locale
     */
    syncMyNameCard: [syncMyNameCardResult: UserNameCard];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 同步完成事件
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/session/%E5%B7%B2%E8%AF%BB%E5%9B%9E%E6%89%A7-%E5%8D%95%E8%81%8A.js" target="_blank">已读回执-单聊</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * Synchronization completed.
     * @locale
     */
    syncdone: [];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 同步时收到了会话
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/message/%E6%B6%88%E6%81%AF%E9%98%9F%E5%88%97%E7%BB%B4%E6%8A%A4.js" target="_blank">消息队列维护</a></li>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/session/%E4%BC%9A%E8%AF%9D%E5%A4%B4%E5%83%8F%E4%B8%8E%E5%90%8D%E7%A7%B0.js" target="_blank">会话头像与昵称</a></li>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/session/%E4%BC%9A%E8%AF%9D%E6%8E%92%E5%BA%8F.js" target="_blank">会话排序</a></li>
     * </ul>
     *
     * @locale
     *
     * @locale en
     * Received conversations during synchronization.
     * @locale
     */
    sessions: [sessions: Session[]];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 多端同步收到的远端会话变更
     * @locale
     *
     * @locale en
     * @locale
     */
    multiSyncUpdateCloudSession: [session: NIMECloudSession];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 同步收到的关系，包括黑名单和静音列表
     * @locale
     *
     * @locale en
     * Received relationship information during synchronization, including the blacklist and mute list.
     * @locale
     */
    relations: [relations: Relations];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 收到了更新个人信息通知
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/user/%E4%B8%AA%E4%BA%BA%E8%B5%84%E6%96%99.js" target="_blank">个人资料</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * Received a notification to update the personal profile information.
     * @locale
     */
    updateMyNameCard: [myNameCard: UserNameCard];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 收到了黑名单更新通知
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/user/%E9%BB%91%E5%90%8D%E5%8D%95.js" target="_blank">黑名单</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * Received a notification to update blacklist.
     * @locale
     */
    updateBlackList: [
        updateBlackListResult: {
            account: string;
            isAdd: boolean;
        }
    ];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 收到了静音列表更新通知
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/session/%E4%BC%9A%E8%AF%9D%E5%85%8D%E6%89%93%E6%89%B0.js" target="_blank">会话免打扰</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * Received a notification to update the mute list.
     * @locale
     */
    updateMuteList: [
        updateMuteListResult: {
            account: string;
            isAdd: boolean;
        }
    ];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 在线时收到了系统通知
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/message/p2p%E6%AD%A3%E5%9C%A8%E8%BE%93%E5%85%A5.js" target="_blank">p2p正在输入</a></li>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/message/%E6%92%A4%E5%9B%9E%E6%B6%88%E6%81%AF.js" target="_blank">撤回消息</a></li>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/sysmsg/%E7%B3%BB%E7%BB%9F%E9%80%9A%E7%9F%A5.js" target="_blank">系统通知</a></li>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/user/%E7%94%A8%E6%88%B7%E8%B5%84%E6%96%99%E4%B8%8E%E5%A5%BD%E5%8F%8B%E5%85%B3%E7%B3%BB.js" target="_blank">用户资料与好友关系</a></li>
     * </ul>
     *
     * @locale
     *
     * @locale en
     * Received system notifications when online.
     * @locale
     */
    sysMsg: [sysMsg: SystemMessage];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 同步漫游/离线时收到的系统消息
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/sysmsg/%E7%B3%BB%E7%BB%9F%E9%80%9A%E7%9F%A5.js" target="_blank">系统通知</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * System notifications received during the synchronization of roaming/offline messages
     * @locale
     */
    syncSysMsgs: [sysMsgs: SystemMessage[]];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 多端同步时收到了好友相关的资料
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/user/%E7%94%A8%E6%88%B7%E8%B5%84%E6%96%99%E4%B8%8E%E5%A5%BD%E5%8F%8B%E5%85%B3%E7%B3%BB.js" target="_blank">用户资料与好友关系</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * Received friend-related information during multi-device synchronization.
     * @locale
     */
    syncFriend: [result: IMEventSyncFriendResult];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 同步时收到了好友相关资料
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/user/%E7%94%A8%E6%88%B7%E8%B5%84%E6%96%99%E4%B8%8E%E5%A5%BD%E5%8F%8B%E5%85%B3%E7%B3%BB.js" target="_blank">用户资料与好友关系</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * Received friend-related information during synchronization
     * @locale
     */
    friends: [friends: FriendProfile[]];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 同步时收到了其他用户相关资料
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/session/%E4%BC%9A%E8%AF%9D%E5%A4%B4%E5%83%8F%E4%B8%8E%E5%90%8D%E7%A7%B0.js" target="_blank">会话头像与昵称</a></li>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/user/%E7%94%A8%E6%88%B7%E8%B5%84%E6%96%99%E4%B8%8E%E5%A5%BD%E5%8F%8B%E5%85%B3%E7%B3%BB.js" target="_blank">用户资料与好友关系</a></li>
     * </ul>
     *
     *
     * @locale
     *
     * @locale en
     * Received other user-related information during synchronization.
     * @locale
     */
    users: [users: UserNameCard[]];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 收到了系统消息
     * @locale
     *
     * @locale en
     * Received a system notification.
     * @locale
     */
    updateSystemMessages: [
        result: {
            idServer: string;
            from: string;
            state: TSystemMessageStatus;
            type: TSystemMessageType;
        }[]
    ];
    /**
     * 收到了系统消息未读数更新
     * 只当开启 db 时，再考虑系统消息未读数的事件
     */
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 收到了订阅事件
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/event/%E7%94%A8%E6%88%B7%E4%B8%8A%E7%BA%BF%E4%B8%8B%E7%BA%BF.js" target="_blank">用户上线下线</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * Received subscription events.
     * @locale
     */
    pushEvents: [events: PushEvent[]];
    /**
     * @deprecated 这个字段即将废弃，所有的属性被移入 {@link IMEventInterface.msgReceipts} 中
     * @Multi_Lang_Tag
     * @locale cn
     * 收到了群已读
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/session/%E5%B7%B2%E8%AF%BB%E5%9B%9E%E6%89%A7-%E7%BE%A4.js" target="_blank">已读回执-群</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * Received the message receipt of the group message.
     * @locale
     */
    teamMsgReceipts: [msgReceipts: TeamMsgReceipt[]];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 收到了消息已读，包含单聊和群聊
     *
     * @example
     * ```
     * nim.on('msgReceipts', msgReceipts => {
     *    for (let _ of msgReceipts) {
     *      // getMsgsBySessionIds 这个是开发者自行维护的函数
     *      const msgArr = getMsgsBySessionIds(_.sessionId)
     *      for (let msg of msgArr) {
     *        // 只有自己发送的消息才需要标记已读回执
     *        if (msg.scene === 'p2p' && msg.from === myAccount && msg.time < Number(_.msgReceiptTime)) {
     *          // 消息已被对端阅读
     *          msg.status = 'receipt'
     *        }
     *      }
     *    }
     * })
     * ```
     * @locale
     *
     * @locale en
     * Received the message receipt of the group message.
     * @locale
     */
    msgReceipts: [msgReceipts: TeamMsgReceipt[] | p2pMsgReceipt[]];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 会话更新
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/session/%E4%BC%9A%E8%AF%9D%E5%A4%B4%E5%83%8F%E4%B8%8E%E5%90%8D%E7%A7%B0.js" target="_blank">会话头像与昵称</a></li>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/session/%E4%BC%9A%E8%AF%9D%E6%8E%92%E5%BA%8F.js" target="_blank">会话排序</a></li>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/session/%E5%B7%B2%E8%AF%BB%E5%9B%9E%E6%89%A7-%E5%8D%95%E8%81%8A.js" target="_blank">已读回执-单聊</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * Update conversation.
     * @locale
     */
    updateSession: [session: Session];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 收到了初始化同步的群
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/session/%E4%BC%9A%E8%AF%9D%E5%A4%B4%E5%83%8F%E4%B8%8E%E5%90%8D%E7%A7%B0.js" target="_blank">会话头像与昵称</a></li>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/team/%E7%BE%A4%E6%88%90%E5%91%98%E7%AE%A1%E7%90%86.js" target="_blank">群成员管理</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * Received the group synchronized from initialization.
     * @locale
     */
    teams: [teams: Team[]];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 收到了多端同步创建群的情况
     *
     * owner 群的所有者
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/team/%E7%BE%A4%E6%88%90%E5%91%98%E7%AE%A1%E7%90%86.js" target="_blank">群成员管理</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * Received the event that group(s) was created simultaneously on multiple devices.
     *
     * owner refers to the group owner
     * @locale
     */
    createTeam: [team: Team, owner: StrAnyObj];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 收到了多端同步来更新群成员的情况
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/team/%E6%88%91%E5%9C%A8%E7%BE%A4%E5%86%85%E4%BF%A1%E6%81%AF.js" target="_blank">我在群内信息</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * Received the event that group members were updated simultaneously on multiple devices.
     * @locale
     */
    updateTeamMember: [member: TeamMember];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 收到了群的更新信息
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/session/%E4%BC%9A%E8%AF%9D%E5%A4%B4%E5%83%8F%E4%B8%8E%E5%90%8D%E7%A7%B0.js" target="_blank">会话头像与昵称</a></li>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/team/%E7%BE%A4%E9%9D%99%E9%9F%B3.js" target="_blank">群静音</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * Received group updates.
     * @locale
     */
    updateTeam: [team: Team];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 收到了群成员的更新
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/team/%E7%BE%A4%E6%88%90%E5%91%98%E7%AE%A1%E7%90%86.js" target="_blank">群成员管理</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * Received group member updates.
     * @locale
     */
    addTeamMembers: [
        addTeamMembersResult: {
            team: Team;
            accounts: string[];
            members: TeamMember[];
        }
    ];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 收到了群管理员的更新
     * @locale
     *
     * @locale en
     * Received group administrator updates.
     * @locale
     */
    updateTeamManagers: [updateTeamManagersResult: TUpdateTeamManagersResult];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 收到了转让群
     * @locale
     *
     * @locale en
     * Received the information on group transfer.
     * @locale
     */
    transferTeam: [tranferTeamResult: TTransferTeamResult];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 收到成员离群，例如成员 A 调用了 leaveTeam 离群，其他成员会收到这个事件。
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/team/%E7%BE%A4%E6%88%90%E5%91%98%E7%AE%A1%E7%90%86.js" target="_blank">群成员管理</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * Received a notification on the leave of a group member. For example, when member A calls leaveTeam to leave a group, other members will receive this event.
     * @locale
     */
    removeTeamMembers: [
        result: {
            team: Team;
            accounts: string[];
        }
    ];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 触发了解散群
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/team/%E7%BE%A4%E6%88%90%E5%91%98%E7%AE%A1%E7%90%86.js" target="_blank">群成员管理</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * Trigger the disbanding of the group
     * @locale
     */
    dismissTeam: [
        result: {
            teamId: string;
        }
    ];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 收到了更新群成员静音
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/team/%E7%BE%A4%E9%9D%99%E9%9F%B3.js" target="_blank">群静音</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * Received updates on the group’s mute list.
     * @locale
     */
    updateTeamMembersMute: [result: TUpdateTeamMembersMute];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 收到了初始化同步的群
     * @locale
     *
     * @locale en
     * Received the group synchronized from initialization.
     * @locale
     */
    superTeams: [teams: SuperTeam[]];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 收到了多端同步创建群的情况
     *
     * owner 群的所有者
     * @locale
     *
     * @locale en
     * Received the event that group(s) was created simultaneously on multiple devices.
     *
     * owner refers to the group owner
     * @locale
     */
    createSuperTeam: [team: SuperTeam, owner: StrAnyObj];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 超级群更新
     * @locale
     *
     * @locale en
     * Supergroup update
     * @locale
     */
    updateSuperTeam: [team: SuperTeam];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 超级群添加
     * @locale
     *
     * @locale en
     * Add members to supergroup
     * @locale
     */
    addSuperTeamMembers: [
        result: {
            team: SuperTeam;
            accounts: string[];
            members: SuperTeamMember[];
        }
    ];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 移除超级群成员
     * @locale
     *
     * @locale en
     * Remove supergroup members。
     * @locale
     */
    removeSuperTeamMembers: [
        result: {
            team: SuperTeam;
            accounts: string[];
        }
    ];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 超级群管理员更新
     * @locale
     *
     * @locale en
     * Update supergroup administrator information.
     * @locale
     */
    updateSuperTeamManagers: [updateSuperTeamManagersResult: TUpdateSuperTeamManagersResult];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 触发转让超级群事件
     * @locale
     *
     * @locale en
     * Trigger the Transfer Supergroup event.
     * @locale
     */
    transferSuperTeam: [
        result: {
            team: SuperTeam;
            from: {
                id: string;
                account: string;
                type: SuperTeamMemberType;
                updateTime: number;
            };
            to: {
                id: string;
                account: string;
                type: SuperTeamMemberType;
                updateTime: number;
            };
        }
    ];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 收到了当前账号所在群的成员信息。在同步阶段以及在本端和其它端修改自己的群成员信息时会触发此事件。
     *
     * 已废弃。请使用 `updateTeamMember` 事件替代该事件
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/session/%E4%BC%9A%E8%AF%9D%E5%85%8D%E6%89%93%E6%89%B0.js" target="_blank">会话免打扰</a></li>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/team/%E6%88%91%E5%9C%A8%E7%BE%A4%E5%86%85%E4%BF%A1%E6%81%AF.js" target="_blank">我再群内信息</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * The member information of the group to which the current account belongs has been received. This event will be triggered during the synchronization phase and when the group member information of the local end and other ends is modified.
     * @locale
     */
    myTeamMembers: [teamMembers: Partial<TeamMember>[]];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 超级群成员静音事件
     * @locale
     *
     * @locale en
     * Update mute status of supergroup member
     * @locale
     */
    updateSuperTeamMembersMute: [
        result: {
            team: SuperTeam;
            accounts: string[];
            members: {
                id: string;
                account: string;
                teamId: string;
                mute: boolean;
                updateTime: number;
            }[];
            mute: boolean;
        }
    ];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 超级群成员更新的多端同步
     * @locale
     *
     * @locale en
     * Multi-device synchronization of supergroup member information
     * @locale
     */
    updateSuperTeamMember: [teamMember: SuperTeamMember];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 超级群解散
     * @locale
     *
     * @locale en
     * Disband supergroup.
     * @locale
     */
    dismissSuperTeam: [result: {
        teamId: string;
    }];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 多端同步更新远端会话，cloudSession 模块专属
     * @locale
     *
     * @locale en
     * Update the sessions in the cloud across multiple devices. dedicated for the cloudSession module
     * @locale
     */
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 收到了当前账号所在超级群的成员信息。在同步阶段以及在本端和其它端修改自己超级群的成员信息时会触发此事件。
     * @locale
     *
     * @locale en
     * The member information of the supergroup to which the current account belongs has been received. This event will be triggered during the synchronization phase and when the supergroup member information of the local end and other ends is modified.
     * @locale
     */
    mySuperTeamMembers: [superTeamMembers: Partial<SuperTeamMember>[]];
    /**
     * 其他用户资料更新回调
     *
     * ## 触发时机
     * 当收到其他用户发来的消息时，如果该用户资料中有更新，或之前从未同步过该用户资料，SDK 会触发该回调并返回该用户的最新资料。
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/session/%E4%BC%9A%E8%AF%9D%E5%A4%B4%E5%83%8F%E4%B8%8E%E5%90%8D%E7%A7%B0.js" target="_blank">会话头像与昵称</a></li>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/user/%E7%94%A8%E6%88%B7%E8%B5%84%E6%96%99%E4%B8%8E%E5%A5%BD%E5%8F%8B%E5%85%B3%E7%B3%BB.js" target="_blank">用户资料与好友关系</a></li>
     * </ul>
     *
     */
    updateUserInfo: UserNameCard;
}
export interface IMEventSyncFriendResult {
    type: string;
    friend?: FriendProfile;
    account?: string;
}
export interface SyncRoamingMsgsResult {
    timetag: number;
    sessionId: string;
    msgs: IMMessage[];
}
export interface SyncOfflineMsgsResult {
    timetag: number;
    sessionId: string;
    msgs: IMMessage[];
}
export interface TUpdateTeamMembersMute {
    team: Team;
    accounts: string[];
    members: {
        id: string;
        account: string;
        teamId: string;
        mute: boolean;
        updateTime: number;
    }[];
    mute: boolean;
}
export interface TProxyMsg {
    from: string;
    body: string;
    time: number;
}
export interface TUpdateTeamManagersResult {
    team: {
        teamId: string;
        memberUpdateTime: number;
    };
    accounts: string[];
    isManager: boolean;
    members: {
        id: string;
        type: TeamMemberType;
        account: string;
        updateTime: number;
    }[];
}
export interface TUpdateSuperTeamManagersResult {
    team: {
        teamId: string;
        memberUpdateTime: number;
    };
    accounts: string[];
    isManager: boolean;
    members: {
        id: string;
        account: string;
        type: SuperTeamMemberType;
        updateTime: number;
    }[];
}
export interface TTransferTeamResult {
    team: Team;
    from: {
        id: string;
        account: string;
        type: TeamMemberType;
        updateTime: number;
    };
    to: {
        id: string;
        account: string;
        type: TeamMemberType;
        updateTime: number;
    };
}
