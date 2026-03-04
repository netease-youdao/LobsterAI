import { V2NIMUser } from './V2NIMUserService';
import type { NIMEBaseServiceClass } from './types';
/**
 * v2 好友模块
 *
 * 注: 使用 dist/esm 产物时，需要动态引入 V2NIMFriendService 后使用
 *
 * @example
 * ```
 * import { NIM, V2NIMFriendService } from 'nim-web-sdk-ng/dist/esm/nim'
 * NIM.registerService(V2NIMFriendService, 'V2NIMFriendService')
 * ```
 */
export declare class V2NIMFriendService extends NIMEBaseServiceClass<V2NIMFriendListener> {
    /**
     * 添加/申请好友
     * @param accountId 好友 ID
     * @param params 申请相关参数
     */
    addFriend(accountId: string, params: V2NIMFriendAddParams): Promise<void>;
    /**
     * 删除好友
     *
     * @param accountId 好友 ID
     * @param params 删除相关参数
     */
    deleteFriend(accountId: string, params: V2NIMFriendDeleteParams): Promise<void>;
    /**
     * 接受好友申请
     *
     * @param application 好友申请信息
     */
    acceptAddApplication(application: V2NIMFriendAddApplication): Promise<void>;
    /**
     * 拒绝好友申请
     *
     * @param application 好友申请信息
     * @param postscript 拒绝时的附言
     */
    rejectAddApplication(application: V2NIMFriendAddApplication, postscript?: string): Promise<void>;
    /**
     * 设置好友信息
     *
     * @param accountId 好友 ID
     * @param params  设置好友信息参数
     */
    setFriendInfo(accountId: string, params: V2NIMFriendSetParams): Promise<void>;
    /**
     * 获取好友列表
     */
    getFriendList(): Promise<V2NIMFriend[]>;
    /**
     * 根据账号 ID 获取好友信息
     *
     * @param accountIds 好友 ID 列表
     */
    getFriendByIds(accountIds: string[]): Promise<V2NIMFriend[]>;
    /**
     * 根据账号 ID 检查好友状态
     * @param accountIds 好友 ID列表
     */
    checkFriend(accountIds: string[]): Promise<V2NIMCheckFriendResult>;
    /**
     * 获取申请添加好友列表通知
     */
    getAddApplicationList(option: V2NIMFriendAddApplicationQueryOption): Promise<V2NIMFriendAddApplicationResult>;
    /**
     * 设置所有好友申请为已读
     */
    setAddApplicationRead(): Promise<void>;
    /**
     * 设置好友申请已读. v10.9.20+ 支持
     *
     * 注: 自 v10.9.60+ 此 API 明确含义将对此目标记录及其之前的记录都标记为已读.
     *
     * @param application 申请添加好友的相关信息. 若不传代表将所有好友申请设置为已读
     */
    setAddApplicationReadEx(application?: V2NIMFriendAddApplication): Promise<void>;
    /**
     * 获取未读的好友申请数量
     */
    getAddApplicationUnreadCount(): Promise<number>;
    /**
     * 清空所有好友申请
     *
     * @example
     * ```
     * await nim.V2NIMFriendService.clearAllAddApplication()
     * ```
     */
    clearAllAddApplication(): Promise<void>;
    /**
     * 清空好友申请. v10.9.60+ 支持
     *
     * @param option 清空条件
     */
    clearAllAddApplicationEx(option?: V2NIMFriendClearAddApplicationOption): Promise<void>;
    /**
     * 删除好友申请
     *
     * 注: 会删除相同申请者的所有申请记录
     *
     * @param applicationInfo 好友申请记录
     */
    deleteAddApplication(applicationInfo: V2NIMFriendAddApplication): Promise<void>;
    /**
     * 根据关键词搜索好友
     * @param option 搜索好友的条件
     */
    searchFriendByOption(option: V2NIMFriendSearchOption): Promise<V2NIMFriend[]>;
}
export declare type V2NIMFriendClearAddApplicationOption = {
    /**
     * 时间戳，默认当前时间戳，会删除这个时间之前的所有记录
     */
    timestamp?: number;
    /**
     * 好友申请类型，默认全部 V2NIMFriendAddApplicationType.V2NIM_FRIEND_ADD_APPLICATION_TYPE_ALL
     *
     * 注: 本接口不能支持选项 V2NIMFriendAddApplicationType.V2NIM_FRIEND_ADD_APPLICATION_TYPE_LEGACY
     */
    type?: V2NIMFriendAddApplicationType;
};
/**
 * 好友信息，协议文档：https://docs.popo.netease.com/team/pc/MMC/pageDetail/d1f9d84a362d4e3db698a920e0bb9fac
 */
export declare type V2NIMFriend = {
    /**
     * 好友 ID
     */
    accountId: string;
    /**
     * 好友备注名
     */
    alias?: string;
    /**
     * 服务器扩展字段
     */
    serverExtension: string;
    /**
     * 用户扩展字段
     */
    customerExtension: string;
    /**
     * 创建时间
     */
    createTime?: number;
    /**
     * 更新时间
     */
    updateTime?: number;
    /**
     * 好友来源。目前默认都是0
     */
    source?: number;
    /**
     * 好友关系。预留字段，后期实现单向好友关系时使用
     */
    /**
     * 方向好友关系。预留字段，后期实现单向好友关系时使用
     */
    /**
     * 扩展字段。预留字段
     */
    /**
     * @computed
     *
     * 所关联的用户信息
     */
    userProfile?: V2NIMUser;
};
export declare const enum V2NIMFriendAddMode {
    /**
     * 直接加为好友
     */
    V2NIM_FRIEND_MODE_TYPE_ADD = 1,
    /**
     * 请求加为好友
     */
    V2NIM_FRIEND_MODE_TYPE_APPLY = 2
}
export declare type V2NIMFriendAddParams = {
    /**
     * 添加好友模式
     */
    addMode: V2NIMFriendAddMode;
    /**
     * 添加/申请好友时的附言
     */
    postscript: string;
};
/**
 * 申请添加好友的相关信息
 */
export declare type V2NIMFriendAddApplication = {
    /**
     * 申请者账户
     */
    applicantAccountId: string;
    /**
     * 被申请人账户
     */
    recipientAccountId: string;
    /**
     * 操作者账号
     */
    operatorAccountId: string;
    /**
     * 操作时添加的附言
     */
    postscript?: string;
    /**
     * 操作的状态
     */
    status: V2NIMFriendAddApplicationStatus;
    /**
     * 操作的时间
     */
    timestamp: number;
    /**
     * 是否已读
     */
    read: boolean;
    /**
     * 记录ID. v10.9.60+ 支持
     */
    serverId: string;
    /**
     * 变更的时间. v10.9.60+ 支持
     */
    updateTimestamp: number;
    /**
     * 附言历史. v10.9.60+ 支持
     */
    postscriptHistory?: V2NIMPostscript[];
};
export declare type V2NIMPostscript = {
    /**
     * 产生附言的账号
     */
    fromAccount: string;
    /**
     * 附言产生的时间
     */
    time: number;
    /**
     * 附言内容
     */
    content: string;
};
/**
 * 好友添加操作的类型
 */
export declare const enum V2NIMFriendAddApplicationType {
    /**
     * 兼容老版本模式
     */
    V2NIM_FRIEND_ADD_APPLICATION_TYPE_LEGACY = 0,
    /**
     * 我发起的好友申请
     */
    V2NIM_FRIEND_ADD_APPLICATION_TYPE_FROM_SELF = 1,
    /**
     * 我收到的好友申请
     */
    V2NIM_FRIEND_ADD_APPLICATION_TYPE_TO_SELF = 2,
    /**
     * 所有好友申请
     */
    V2NIM_FRIEND_ADD_APPLICATION_TYPE_ALL = 3
}
/**
 * 好友申请的处理状态
 */
export declare const enum V2NIMFriendAddApplicationStatus {
    /**
     * 未处理
     */
    V2NIM_FRIEND_ADD_APPLICATION_STATUS_INIT = 0,
    /**
     * 已同意
     */
    V2NIM_FRIEND_ADD_APPLICATION_STATUS_AGREED = 1,
    /**
     * 已拒绝
     */
    V2NIM_FRIEND_ADD_APPLICATION_STATUS_REJECTED = 2,
    /**
     * 已过期
     */
    V2NIM_FRIEND_ADD_APPLICATION_STATUS_EXPIRED = 3,
    /**
     * 对方直接添加你为好友
     */
    V2NIM_FRIEND_ADD_APPLICATION_STATUS_DIRECT_ADD = 4
}
export declare const enum V2NIMFriendDeletionType {
    /**
     * 自己删除好友
     */
    V2NIM_FRIEND_DELETION_TYPE_BY_SELF = 1,
    /**
     * 被好友删除
     */
    V2NIM_FRIEND_DELETION_TYPE_BY_PEER = 2
}
export declare type V2NIMFriendDeleteParams = {
    /**
     * 是否同步删除前设置的备注
     *
     * false：不同步删除备注
     * true: 同步删除备注
     */
    deleteAlias: boolean;
};
export declare type V2NIMFriendSetParams = {
    /**
     * 别名
     */
    alias?: string;
    /**
     * 扩展字段
     */
    serverExtension?: string;
};
/**
 * 申请添加好友相关信息查询参数
 */
export declare type V2NIMFriendAddApplicationQueryOption = {
    /**
     * 分页位置。首次查询传0，下一次传上一次返回的offset。查询结果不包含offset位置
     */
    offset?: number;
    /**
     * 查询数量, 默认50
     */
    limit?: number;
    /**
     * 要查询的状态列表
     * 如果列表为空，或者不传，表示查询所有状态
     */
    status?: Array<V2NIMFriendAddApplicationStatus>;
    /**
     * 好友申请类型. 默认值为兼容老版本模式 V2NIMFriendAddApplicationType.V2NIM_FRIEND_ADD_APPLICATION_TYPE_LEGACY
     */
    type?: V2NIMFriendAddApplicationType;
};
export declare type V2NIMFriendAddApplicationResult = {
    infos: Array<V2NIMFriendAddApplication>;
    offset: number;
    finished: boolean;
};
export declare const enum V2NIMFriendVerifyType {
    /**
     * 直接加为好友
     */
    V2NIM_FRIEND_VERIFY_TYPE_ADD = 1,
    /**
     * 请求加为好友
     */
    V2NIM_FRIEND_VERIFY_TYPE_APPLY = 2,
    /**
     * 同意添加好友
     */
    V2NIM_FRIEND_VERIFY_TYPE_ACCEPT = 3,
    /**
     * 拒绝添加好友
     */
    V2NIM_FRIEND_VERIFY_TYPE_REJECT = 4
}
/**
 * 好友模块的事件定义
 *
 * 注: 使用 dist/esm 产物时，需要动态引入 V2NIMFriendService 后使用
 *
 * @example
 * ```
 * import { NIM, V2NIMFriendService } from 'nim-web-sdk-ng/dist/esm/nim'
 * NIM.registerService(V2NIMFriendService, 'V2NIMFriendService')
 * ```
 */
export interface V2NIMFriendListener {
    /**
     * 已添加好友
     */
    onFriendAdded: [friend: V2NIMFriend];
    /**
     * 已删除好友
     */
    onFriendDeleted: [accountId: string, deletionType: V2NIMFriendDeletionType];
    /**
     * 收到好友申请
     */
    onFriendAddApplication: [application: V2NIMFriendAddApplication];
    /**
     * 好友申请被拒绝的通知
     */
    onFriendAddRejected: [rejection: V2NIMFriendAddApplication];
    /**
     * 好友信息更新
     */
    onFriendInfoChanged: [friend: V2NIMFriend];
}
export interface V2NIMCheckFriendResult {
    [accountId: string]: boolean;
}
export declare type V2NIMFriendSearchOption = {
    /**
     * 查询的关键词，默认搜索好友备注。可以指定是否同时搜索用户账号
     */
    keyword: string;
    /**
     * 是否检索昵称。默认为 true
     */
    searchAlias?: boolean;
    /**
     * 是否同时搜索用户账号。默认值为 false
     */
    searchAccountId?: boolean;
};
export declare type V2NIMFriendServiceConfig = {
    /**
     * 是否开启服务端好友申请记录功能. 默认为 false，即不开启。
     */
    enableServerV2FriendAddApplication?: boolean;
};
