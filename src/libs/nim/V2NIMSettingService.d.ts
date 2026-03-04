import type { NIMEBaseServiceClass, NIMEStrAnyObj } from './types';
import { V2NIMTeamType } from './V2NIMTeamService';
/**
 * 设置模块. 包含会话免打扰设置, 推送设置.
 *
 * 注: 使用 dist/esm 产物时，需要动态引入 V2NIMSettingService 后使用
 *
 * @example
 * ```
 * import { NIM, V2NIMSettingService } from 'nim-web-sdk-ng/dist/esm/nim'
 * NIM.registerService(V2NIMSettingService, 'V2NIMSettingService')
 * ```
 */
export declare class V2NIMSettingService extends NIMEBaseServiceClass<V2NIMSettingListener> {
    /**
     * 获取会话消息免打扰状态
     *
     * 注: 若会话类型为群, 则群消息免打扰模式为 {@link V2NIMTeamMessageMuteMode.V2NIM_TEAM_MESSAGE_MUTE_MODE_OFF | V2NIMTeamMessageMuteMode.V2NIM_TEAM_MESSAGE_MUTE_MODE_OFF} 返回为false. 其他的返回 true.
     *
     * 注: 会话免打扰属性与 user 和 team 有关联. 建议使用 dist/esm 产物时，额外动态引入 {@link V2NIMUserService | V2NIMUserService} 以及 {@link V2NIMTeamService | V2NIMTeamService}
     *
     * @param conversationId 会话 id
     * @return mute 是否被免打扰
     */
    getConversationMuteStatus(conversationId: string): boolean;
    /**
     * 设置群消息免打扰模式
     *
     * 注: 会话免打扰属性与 user 和 team 有关联. 建议使用 dist/esm 产物时，额外动态引入 {@link V2NIMUserService | V2NIMUserService} 以及 {@link V2NIMTeamService | V2NIMTeamService}
     *
     * @param teamId 群组ID
     * @param teamType 群组类型
     * @param muteMode 群消息免打扰模式
     */
    setTeamMessageMuteMode(teamId: string, teamType: V2NIMTeamType, muteMode: V2NIMTeamMessageMuteMode): Promise<void>;
    /**
     * 获取群消息免打扰模式
     *
     * 注: 会话免打扰属性与 user 和 team 有关联. 建议使用 dist/esm 产物时，额外动态引入 {@link V2NIMUserService | V2NIMUserService} 以及 {@link V2NIMTeamService | V2NIMTeamService}
     *
     * @param teamId 群组ID
     * @param teamType 群组类型
     * @return muteMode 群消息免打扰模式
     */
    getTeamMessageMuteMode(teamId: string, teamType: V2NIMTeamType): V2NIMTeamMessageMuteMode;
    /**
     * 获取我所在的群消息免打扰模式
     *
     * @param teamType 群组类型
     * @returns  key 为群组 ID，value 为群消息免打扰模式
     */
    getAllTeamMessageMuteMode(teamType: V2NIMTeamType): Promise<Record<string, V2NIMTeamMessageMuteMode>>;
    /**
     * 设置点对点消息免打扰模式
     *
     * 注: 会话免打扰属性与 user 和 team 有关联. 建议使用 dist/esm 产物时，额外动态引入 {@link V2NIMUserService | V2NIMUserService} 以及 {@link V2NIMTeamService | V2NIMTeamService}
     *
     * @param accountId 目标账号 ID
     * @param muteMode 设置用户的免打扰模式
     */
    setP2PMessageMuteMode(accountId: string, muteMode: V2NIMP2PMessageMuteMode): Promise<void>;
    /**
     * 获取用户消息免打扰模式
     *
     * 注: 会话免打扰属性与 user 和 team 有关联. 建议使用 dist/esm 产物时，额外动态引入 {@link V2NIMUserService | V2NIMUserService} 以及 {@link V2NIMTeamService | V2NIMTeamService}
     *
     * @param accountId 目标账号 ID
     * @return muteMode p2p 类型消息免打扰模式
     */
    getP2PMessageMuteMode(accountId: string): V2NIMP2PMessageMuteMode;
    /**
     * 获取点对点消息免打扰列表。
     *
     * 注: 会话免打扰属性与 user 有关联. 建议使用 dist/esm 产物时，额外动态引入 {@link V2NIMUserService | V2NIMUserService}
     *
     * 返回 V2NIMP2PMessageMuteMode 为 V2NIM_P2P_MESSAGE_MUTE_MODE_ON 的 accountId 列表。
     */
    getP2PMessageMuteList(): Promise<Array<string>>;
    /**
     * 设置应用前后台状态
     *
     * web端运行在移动端时，需要用户调用此接口告知应用的前后台状态
     *
     * 该函数仅在使用 uniapp 编译至 ios，或者 android 时有效，它告知服务器应用的前后台状态，服务器根据此状态调整推送策略
     *
     * @param isBackground 是否在后台
     * @param badge 应用图标上的未读数。当前仅 ios 使用
     */
    setAppBackground(isBackground: boolean, badge?: number): Promise<void>;
    /**
     * uniapp编译移动端应用时，调用该接口设置推送配置。该函数必须在 `login` 之前调用。
     *
     * 离线推送相关配置请参考文档：https://doc.yunxin.163.com/messaging-enhanced/docs/TE1NjY4Nzk?platform=uniapp
     *
     * @param plugin 推送插件
     * @param config 推送配置
     */
    setOfflinePushConfig(plugin: NIMEStrAnyObj, config: V2NIMOfflinePushConfig): void;
    /**
     * 设置当桌面端在线时，移动端是否需要推送
     *
     * @param need 桌面端在线时，移动端是否需要推送
     */
    setPushMobileOnDesktopOnline(need: boolean): Promise<void>;
    /**
     * 获取当桌面端在线时，移动端是否需要推送配置. v10.9.1 新增
     *
     * @returns boolean 桌面端在线时，移动端是否需要推送. true 为需要
     */
    getPushMobileOnDesktopOnline(): Promise<boolean>;
}
/**
 * 群消息免打扰模式
 */
export declare const enum V2NIMTeamMessageMuteMode {
    /**
     * 群消息免打扰关闭
     */
    V2NIM_TEAM_MESSAGE_MUTE_MODE_OFF = 0,
    /**
     * 群消息免打扰开启
     */
    V2NIM_TEAM_MESSAGE_MUTE_MODE_ON = 1,
    /**
     * 发送者为普通成员的群消息免打扰开启
     */
    V2NIM_TEAM_MESSAGE_MUTE_MODE_NORMAL_ON = 2
}
/**
 * p2p 消息免打扰模式
 */
export declare const enum V2NIMP2PMessageMuteMode {
    /**
     * 点对点消息免打扰关闭
     */
    V2NIM_P2P_MESSAGE_MUTE_MODE_OFF = 0,
    /**
     * 点对点消息免打扰开启
     */
    V2NIM_P2P_MESSAGE_MUTE_MODE_ON = 1
}
/**
 * 设置模块的监听器
 *
 * 注: 使用 dist/esm 产物时，需要动态引入 V2NIMSettingService 后使用
 *
 * @example
 * ```
 * import { NIM, V2NIMSettingService } from 'nim-web-sdk-ng/dist/esm/nim'
 * NIM.registerService(V2NIMSettingService, 'V2NIMSettingService')
 * ```
 */
export interface V2NIMSettingListener {
    /**
     * 群消息免打扰模式变更
     */
    onTeamMessageMuteModeChanged: [teamId: string, teamType: V2NIMTeamType, muteMode: V2NIMTeamMessageMuteMode];
    /**
     * 点对点消息免打扰模式变更
     */
    onP2PMessageMuteModeChanged: [accountId: string, muteMode: V2NIMP2PMessageMuteMode];
    /**
     * ”当桌面端在线时，移动端是否需要推送“的状态回调
     */
    onPushMobileOnDesktopOnline: [need: boolean];
}
/**
 * 离线推送配置参数
 */
export interface V2NIMOfflinePushConfig {
    /**
     * 苹果推送配置，需要填写: certificateName
     */
    apns?: V2NIMManufacturerPushConfig;
    /**
     * 华为推送配置，需要填写: appId, certificateName
     */
    hwPush?: V2NIMManufacturerPushConfig;
    /**
     * 小米推送配置，需要填写: appId, appKey, certificateName
     */
    miPush?: V2NIMManufacturerPushConfig;
    /**
     * vivo推送配置，需要填写: appId, appKey, certificateName
     */
    vivoPush?: V2NIMManufacturerPushConfig;
    /**
     * oppo推送配置，需要填写: appId, appKey, certificateName, secret
     */
    oppoPush?: V2NIMManufacturerPushConfig;
    /**
     * 荣耀推送配置，需要填写: appId, appKey, certificateName
     */
    honorPush?: V2NIMManufacturerPushConfig;
    /**
     * fcm推送配置，需要填写: certificateName
     */
    fcmPush?: V2NIMManufacturerPushConfig;
    /**
     * 魅族推送配置，需要填写: appId, appKey, certificateName
     */
    mzPush?: V2NIMManufacturerPushConfig;
    /**
     * 鸿蒙推送配置. 只需要填写 certificateName. v10.9.75+ 支持
     */
    harmonyPush?: V2NIMManufacturerPushConfig;
}
export interface V2NIMManufacturerPushConfig {
    /**
     * 推送应用 AppId
     */
    appId?: string;
    /**
     * 推送应用 AppKey
     */
    appKey?: string;
    /**
     * 推送应用证书名。证书在云信后台上传
     */
    certificateName: string;
    /**
     * 推送应用密钥
     */
    secret?: string;
}
