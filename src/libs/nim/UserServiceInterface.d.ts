/**
 * 调用方式:
 * ```js
 * nim.user.setBlack(options)
 * ```
 */
export interface UserServiceInterface {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 加入黑名单/从黑名单移除。
     *
     * #### 影响范围
     * - 多端同步账号收到 {@link IMEventInterface.updateBlackList} 事件通知
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/user/%E9%BB%91%E5%90%8D%E5%8D%95.js" target="_blank">黑名单</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * Add/remove users from the blacklist
     * @locale
     */
    setBlack(options: UpdateRelationsOptions): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 加入静音列表/从静音列表移除
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/session/%E4%BC%9A%E8%AF%9D%E5%85%8D%E6%89%93%E6%89%B0.js" target="_blank">会话免打扰</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * Add/remove users from the mute list.
     * @locale
     */
    setMute(options: UpdateRelationsOptions): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 获取用户名片数组
     *
     * 注意：每次最多 150 个
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/session/%E4%BC%9A%E8%AF%9D%E5%A4%B4%E5%83%8F%E4%B8%8E%E5%90%8D%E7%A7%B0.js" target="_blank">会话头像与昵称</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * Get the array of users’ name cards.
     *
     * Note: Up to 150 name cards can be obtained at a time.
     * @locale
     */
    getUsersNameCardFromServer(options: GetUsersNameCardFromServerOptions): Promise<UserNameCard[]>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 更新我的名片
     *
     * #### 影响范围
     * - 多端同步账号收到 {@link IMEventInterface.updateMyNameCard} 事件通知
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/user/%E4%B8%AA%E4%BA%BA%E8%B5%84%E6%96%99.js" target="_blank">个人资料</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * Update my name card
     * @locale
     */
    updateMyNameCard(options: UpdateMyInfoOptions): Promise<UserNameCard>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 同时获取黑名单和静音列表
     * @locale
     *
     * @locale en
     * Get blacklist and mute list
     * @locale
     */
    getRelations(): Promise<Relations>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 获取黑名单
     * @locale
     *
     * @locale en
     * Get blacklist
     * @locale
     */
    getBlackList(): Promise<MarkedUserInfo[]>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 获取静音列表
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/session/%E4%BC%9A%E8%AF%9D%E5%85%8D%E6%89%93%E6%89%B0.js" target="_blank">会话免打扰</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * Get mute list
     * @locale
     */
    getMuteList(): Promise<MarkedUserInfo[]>;
}
export declare enum GenderMap {
    unknown = 0,
    male = 1,
    female = 2
}
export declare type Gender = keyof typeof GenderMap;
export interface UserNameCard {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * accid
     * @locale
     *
     * @locale en
     * account ID
     * @locale
     */
    account: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 昵称
     * @locale
     *
     * @locale en
     * Nickname
     * @locale
     */
    nick?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 头像
     * @locale
     *
     * @locale en
     * Avatar
     * @locale
     */
    avatar?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 签名
     * @locale
     *
     * @locale en
     * Signature
     * @locale
     */
    signature?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 性别
     * @locale
     *
     * @locale en
     * Gender
     * @locale
     */
    gender?: Gender;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 邮箱
     * @locale
     *
     * @locale en
     * Email
     * @locale
     */
    email?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 出生日期
     * @locale
     *
     * @locale en
     * Date of birth
     * @locale
     */
    birth?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 电话
     * @locale
     *
     * @locale en
     * Phone number
     * @locale
     */
    tel?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 扩展字段
     * @locale
     *
     * @locale en
     * Extension field
     * @locale
     */
    ext?: string;
    createTime: number;
    updateTime: number;
}
export interface GetUsersNameCardFromServerOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 账号列表
     *
     * 注意：每次最多 150 个
     * @locale
     *
     * @locale en
     * Account list
     *
     * Note: Up to 150 accounts are allowed at a time.
     * @locale
     */
    accounts: string[];
}
export interface UpdateMyInfoOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 昵称
     * @locale
     *
     * @locale en
     * Nickname
     * @locale
     */
    nick?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 头像
     * @locale
     *
     * @locale en
     * Avatar
     * @locale
     */
    avatar?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 签名
     * @locale
     *
     * @locale en
     * Signature
     * @locale
     */
    signature?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 性别
     * @locale
     *
     * @locale en
     * Gender
     * @locale
     */
    gender?: Gender;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 邮箱
     * @locale
     *
     * @locale en
     * Email
     * @locale
     */
    email?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 出生日期
     * @locale
     *
     * @locale en
     * Date of birth
     * @locale
     */
    birth?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 电话
     * @locale
     *
     * @locale en
     * Phone number
     * @locale
     */
    tel?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 扩展字段
     * @locale
     *
     * @locale en
     * Extension field
     * @locale
     */
    ext?: string;
}
export interface UpdateRelationsOptions {
    account: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * isAdd 为 true 时, 会将 account 确定这么设置（黑名单，静音）
     * 如果一个用户被加入了黑名单, 那么就不再会收到此用户发送的消息
     *
     * isAdd 为 false 时, 会将 account 取消设置
     * 如果一个用户被从黑名单移除, 那么可以收到此用户发送的消息
     * @locale
     *
     * @locale en
     * When isAdd is set to true, the account will be added to the blocklist or list of muted members.
     * If a user is added to the blacklist, you will no longer receive messages from this user.
     *
     * When isAdd is false, the account will be removed from the blacklist or mute list.
     * If a user is removed from the blacklist, you can receive messages from this user.
     * @locale
     */
    isAdd: boolean;
}
export interface MarkedUserInfo {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 账号 accid
     * @locale
     *
     * @locale en
     * Account ID
     * @locale
     */
    account: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否被静音
     * @locale
     *
     * @locale en
     * Whether the account is muted
     * @locale
     */
    isMuted?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否被拉入黑名单
     * @locale
     *
     * @locale en
     * Whether the account is added to the blocklist
     * @locale
     */
    isBlack?: boolean;
    createTime: number;
    updateTime: number;
}
export interface Relations {
    blackList: MarkedUserInfo[];
    muteList: MarkedUserInfo[];
}
