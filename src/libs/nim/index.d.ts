import { CloudStorageServiceInterface } from './CloudStorageServiceInterface';
import { EventServiceInterface } from './EventServiceInterface';
import { FriendServiceInterface } from './FriendServiceInterface';
import { MsgExtendServiceInterface } from './MsgExtendServiceInterface';
import { MsgLogServiceInterface } from './MsgLogServiceInterface';
import { MsgServiceInterface } from './MsgServiceInterface';
import { NIMInitializeOptions, NIMOtherOptions } from './NIMInterface';
import { PassThroughServiceInterface } from './PassThroughServiceInterface';
import { PluginServiceInterface } from './PluginServiceInterface';
import { SessionServiceInterface } from './SessionServiceInterface';
import { CloudSessionServiceInterface } from './CloudSessionServiceInterface';
import { SignalingServiceInterface } from './SignalingServiceInterface';
import { SuperTeamServiceInterface } from './SuperTeamServiceInterface';
import { SystemMessageServiceInterface } from './SystemMessageServiceInterface';
import { TeamServiceInterface } from './TeamServiceInterface';
import { UserServiceInterface } from './UserServiceInterface';
import { NIMServiceName } from './types';
import { NIMEInstanceStatus } from './V1NIMLoginService';
import { V2NIMConversationIdUtil, V2NIMConversationService } from './V2NIMConversationService';
import { DataStructureConverter, V2NIMClientAntispamUtil, V2NIMMessageAttachmentCreator, V2NIMMessageConverter, V2NIMMessageCreator, V2NIMMessageService } from './V2NIMMessageService';
import { V2NIMNotificationService } from './V2NIMNotificationService';
import { V2NIMStorageService } from './V2NIMStorageService';
import { V2NIMLoginService } from './V2NIMLoginService';
import { V2NIMConversationGroupService } from './V2NIMConversationGroupService';
import { V2NIMTeamService } from './V2NIMTeamService';
import { V2NIMFriendService } from './V2NIMFriendService';
import { V2NIMSettingService } from './V2NIMSettingService';
import { V2NIMUserService } from './V2NIMUserService';
import { OfflinePushServiceInterface } from './OfflinePushInterface';
import { V2NIMAIService } from './V2NIMAIService';
import { V2NIMSignallingService } from './V2NIMSignallingService';
import { V2NIMSubscriptionService } from './V2NIMSubscriptionService';
import { V2NIMPassthroughService } from './V2NIMPassthroughService';
import { YSFService } from './YSFService';
import { V2NIMLocalConversationService } from './V2NIMLocalConversationService';
export declare class V2NIM {
    /**
     * @deprecated
     * @Multi_Lang_Tag
     * @locale cn
     * 实例的状态
     * @locale
     *
     * @locale en
     * The status of an instance
     * @locale
     */
    status: NIMEInstanceStatus;
    /**
     * @deprecated
     * @Multi_Lang_Tag
     * @locale cn
     * 账号
     * @locale
     *
     * @locale en
     * Account
     * @locale
     */
    account: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 连接参数
     * @locale
     *
     * @locale en
     * Parameters of connections
     * @locale
     */
    options: NIMInitializeOptions;
    /**
     * @deprecated
     *
     * v1 模块即将废弃, 请使用 v2 模块 V2NIMMessageService
     */
    msg: MsgServiceInterface;
    /**
     * @deprecated
     *
     * v1 模块即将废弃, 请使用 v2 模块 V2NIMMessageService
     */
    msgLog: MsgLogServiceInterface;
    /**
     * @deprecated
     *
     * v1 模块即将废弃, 请使用 v2 模块 V2NIMConversationService
     */
    session: SessionServiceInterface;
    /**
     * @deprecated
     *
     * v1 模块即将废弃, 请使用 v2 模块 V2NIMConversationService
     */
    cloudSession: CloudSessionServiceInterface;
    /**
     * @deprecated
     *
     * v1 模块即将废弃, 请使用 v2 模块 V2NIMSignallingService
     */
    signaling: SignalingServiceInterface;
    /**
     * @deprecated
     *
     * v1 模块即将废弃, 请使用 v2 模块 V2NIMUserService
     */
    user: UserServiceInterface;
    /**
     * @deprecated
     *
     * v1 模块即将废弃, 请使用 v2 模块 V2NIMFriendService
     */
    friend: FriendServiceInterface;
    /**
     * @deprecated
     *
     * v1 模块即将废弃, 请使用 v2 模块 V2NIMNotificationService
     */
    systemMessage: SystemMessageServiceInterface;
    /**
     * @deprecated
     *
     * v1 模块即将废弃, 请使用 v2 模块 V2NIMTeamService
     */
    team: TeamServiceInterface;
    /**
     * @deprecated
     *
     * v1 模块即将废弃, 请使用 v2 模块 V2NIMSubscriptionService
     */
    event: EventServiceInterface;
    /**
     * @deprecated
     *
     * v1 模块即将废弃, 请使用 v2 模块 V2NIMMessageService
     */
    msgExtend: MsgExtendServiceInterface;
    /**
     * @deprecated
     *
     * v1 模块即将废弃, 请使用 v2 模块 V2NIMStorageService
     */
    cloudStorage: CloudStorageServiceInterface;
    /**
     * @deprecated
     */
    passThrough: PassThroughServiceInterface;
    /**
     * @deprecated
     *
     * v1 模块即将废弃, 请使用 v2 模块 V2NIMTeamService
     */
    superTeam: SuperTeamServiceInterface;
    offlinePush: OfflinePushServiceInterface;
    plugin: PluginServiceInterface;
    /** ---------- 辅助工具类 ----------- */
    V2NIMConversationIdUtil: V2NIMConversationIdUtil;
    V2NIMMessageCreator: V2NIMMessageCreator;
    V2NIMMessageAttachmentCreator: V2NIMMessageAttachmentCreator;
    V2NIMClientAntispamUtil: V2NIMClientAntispamUtil;
    DataStructureConverter: DataStructureConverter;
    V2NIMMessageConverter: V2NIMMessageConverter;
    /** ---------- 辅助工具类 end ----------- */
    /** 通知类 */
    V2NIMNotificationService: V2NIMNotificationService;
    V2NIMStorageService: V2NIMStorageService;
    /** ---------- 模块服务 ----------- */
    V2NIMLoginService: V2NIMLoginService;
    V2NIMLocalConversationService: V2NIMLocalConversationService;
    V2NIMConversationService: V2NIMConversationService;
    V2NIMConversationGroupService: V2NIMConversationGroupService;
    V2NIMMessageService: V2NIMMessageService;
    V2NIMTeamService: V2NIMTeamService;
    V2NIMUserService: V2NIMUserService;
    V2NIMFriendService: V2NIMFriendService;
    V2NIMSettingService: V2NIMSettingService;
    V2NIMAIService: V2NIMAIService;
    V2NIMSignallingService: V2NIMSignallingService;
    V2NIMSubscriptionService: V2NIMSubscriptionService;
    V2NIMPassthroughService: V2NIMPassthroughService;
    YSFService: YSFService;
    constructor(_options?: NIMInitializeOptions, _otherOptions?: NIMOtherOptions);
    /**
     * SDK 版本号-数字格式
     */
    static sdkVersion: number;
    /**
     * SDK 版本号-字符串格式
     */
    static sdkVersionFormat: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 注册模块. 使用 dist/esm 产物时的 NIM 类专用
     * @param _serviceClass 模块类
     * @param _serviceName 标识的模块名
     * @locale
     *
     * @locale en
     * Register a module in ESM for NIM class
     * @param _serviceClass module class
     * @param _serviceName Module name
     * @locale
     */
    static registerService(_serviceClass: any, _serviceName: NIMServiceName): void;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 单例模式获取实例
     * @locale
     *
     * @locale en
     * Get a singleton instance
     * @locale
     */
    static getInstance(_options?: NIMInitializeOptions, _otherOptions?: NIMOtherOptions): V2NIM;
}
export * as V2NIMConst from './V2NIMConst';
export default V2NIM;
