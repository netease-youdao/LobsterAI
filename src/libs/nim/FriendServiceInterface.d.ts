/**
 * 调用方式:
 * ```js
 * nim.friend.getFriends()
 * ```
 */
export interface FriendServiceInterface {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 获取当前用户的好友列表
     * @locale
     *
     * @locale en
     * Get friend list
     * @locale
     */
    getFriends(): Promise<FriendProfile[]>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 直接加为好友。直接加某个用户为好友后, 对方不需要确认, 直接成为当前登录用户的好友。
     *
     * #### 影响范围
     * - 被添加者收到 {@link ESystemMessageType.friendRequest} 类型的系统通知。通知的 `attach.type` 为 `addFriend`
     * - 多端同步账号收到 {@link IMEventInterface.syncFriend} 的事件通知。事件 `type` 为 `addFriend`
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/user/%E7%94%A8%E6%88%B7%E8%B5%84%E6%96%99%E4%B8%8E%E5%A5%BD%E5%8F%8B%E5%85%B3%E7%B3%BB.js" target="_blank">用户资料与好友关系</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * Add as friends directly
     *
     * After user A (the currently logged-in user) directly add user B as a friend, user B does not need to approve it and directly becomes the friend of user A.
     * User B will receive a system notification whose type is friendRequest and attach.type is addFriend.
     * The value of the “from” field of this type of system notification is the account of the sender (in this case, user A). And the value of the “to” field is the account of the receiver (in this case, user B).
     * @locale
     */
    addFriend(options: AddFriendOptions): Promise<FriendProfile>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 申请加为好友。用户在收到好友申请后, 通过 {@link FriendServiceInterface.passFriendApply | passFriendApply} 或 {@link FriendServiceInterface.rejectFriendApply | rejectFriendApply} 来处理好友申请。
     *
     * #### 影响范围
     * - 被添加者收到 {@link ESystemMessageType.friendRequest} 类型的系统通知。通知的 `attach.type` 为 `applyFriend`
     * - 多端同步账号收到 {@link IMEventInterface.syncFriend} 的事件通知。事件 `type` 为 `applyFriend`
     * @locale
     *
     * @locale en
     * Send a friend request
     *
     * After user A (sender) sends a friend to User B (receiver), user B will receive a system notification whose type is friendRequest and attach.type is applyFriend.
     * After receiving the friend request, user B can approve or reject the friend request.
     * @locale
     */
    applyFriend(options: ApplyFriendOptions): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 通过好友申请
     *
     * `A` 用户通过 {@link FriendServiceInterface.applyFriend | applyFriend} 向 `B` 用户发起好友申请, `B` 用户通过 {@link FriendServiceInterface.passFriendApply | passFriendApply} 同意好友申请
     *
     * #### 影响范围
     * - `A` 收到 {@link ESystemMessageType.friendRequest} 类型的系统通知。通知的 `attach.type` 为 `passFriendApply`
     * - `B` 收到 {@link IMEventInterface.updateSystemMessages} 的事件通知
     * - `B`的多端同步账号收到 {@link IMEventInterface.syncFriend} 的事件通知。事件 `type` 为 `passFriendApply`
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/user/%E7%94%A8%E6%88%B7%E8%B5%84%E6%96%99%E4%B8%8E%E5%A5%BD%E5%8F%8B%E5%85%B3%E7%B3%BB.js" target="_blank">用户资料与好友关系</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * Approve friend request
     *
     * After user B approves the friend request, user A will receive a system notification whose type is friendRequest, attach.type is passFriendApply,
     * @locale
     */
    passFriendApply(options: PassFriendApplyOptions): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 拒绝好友申请
     *
     * `A` 用户通过 {@link FriendServiceInterface.applyFriend | applyFriend} 向 `B` 用户发起好友申请, `B` 用户通过 {@link FriendServiceInterface.rejectFriendApply | rejectFriendApply} 拒绝好友申请
     *
     * #### 影响范围
     * - `A` 收到 {@link ESystemMessageType.friendRequest} 类型的系统通知。通知的 `attach.type` 为 `rejectFriendApply`
     * - `B` 收到 {@link IMEventInterface.updateSystemMessages} 的事件通知
     * - `B`的多端同步账号收到 {@link IMEventInterface.syncFriend} 的事件通知。事件 `type` 为 `rejectFriendApply`
     * @locale
     *
     * @locale en
     * Reject friend request
     *
     * After user B rejects the friend request, user A will receive a system notification whose type is friendRequest and attach.type is rejectFriendApply.
     * @locale
     */
    rejectFriendApply(options: RejectFriendApplyOptions): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 删除好友
     *
     * #### 影响范围
     * - 被删除者收到 {@link ESystemMessageType.deleteFriend} 类型的系统通知。通知的 `from` 为删除方的帐号, `to` 为被删除方的账号。
     * - 删除者多端同步账号收到 {@link IMEventInterface.syncFriend} 的事件通知。事件 `type` 为 `deleteFriend`
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/user/%E7%94%A8%E6%88%B7%E8%B5%84%E6%96%99%E4%B8%8E%E5%A5%BD%E5%8F%8B%E5%85%B3%E7%B3%BB.js" target="_blank">用户资料与好友关系</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * Delete friend
     *
     * After user B deletes user A from user B’s friend list, user A will receive a system notification whose type is deleteFriend.
     * The value of the “from” field of this type of system notification is the account of the person who deletes their friend (in this case, user B); and the value of the “to” field is the account of the deleted person (in this case, user A).
     * @locale
     */
    deleteFriend(options: DeleteFriendOptions): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 更新好友，只能更新备注和扩展字段
     *
     * #### 影响范围
     * - 多端同步账号收到 {@link IMEventInterface.syncFriend} 的事件通知。事件 `type` 为 `updateFriend`
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/user/%E7%94%A8%E6%88%B7%E8%B5%84%E6%96%99%E4%B8%8E%E5%A5%BD%E5%8F%8B%E5%85%B3%E7%B3%BB.js" target="_blank">用户资料与好友关系</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * Update friends
     *
     * Only remarks and extension fields can be updated.
     * @locale
     */
    updateFriend(options: UpdateFriendOptions): Promise<void>;
}
export declare const enum FriendProfileRelationShip {
    notFriend = 0,
    normalFriend = 1
}
export declare const enum FriendProfilePassRelationShip {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 直接加
     * @locale
     *
     * @locale en
     * Add friend without verification
     * @locale
     */
    add = 1,
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 请求加
     * @locale
     *
     * @locale en
     * Send a friend request
     * @locale
     */
    ask = 2,
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 同意加
     * @locale
     *
     * @locale en
     * Agree to be added as a friend
     * @locale
     */
    agree = 3
}
export interface FriendProfile {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 账号 accid
     * @locale
     *
     * @locale en
     * Account (accid)
     * @locale
     */
    account: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 备注
     * @locale
     *
     * @locale en
     * Alias
     * @locale
     */
    alias?: string;
    updateTime: number;
    createTime: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否有效，默认 true。为 true 代表是双方是彼此的朋友
     * @locale
     *
     * @locale en
     * Whether it is valid. A value of true indicates the two accounts are friends to each other.
     * @locale
     */
    valid: boolean;
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
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 服务端扩展字段，此字段客户端 sdk 只读，服务端 api 读写
     * @locale
     *
     * @locale en
     * Server extension field. For the client SDK, the field is read-only; for the server APIs, the field can be read and written.
     * @locale
     */
    serverex?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 主动好友关系（好友状态）
     * @locale
     *
     * @locale en
     * Friend status
     * @locale
     */
    relationShip?: FriendProfileRelationShip;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 被动好友关系（加此好友的验证类型）
     * @locale
     *
     * @locale en
     * Verification type for adding the person as a friend
     * @locale
     */
    passRelationShip?: FriendProfilePassRelationShip;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 此好友来源，默认 0
     * @locale
     *
     * @locale en
     * This friend source, default 0
     * @locale
     */
    source?: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 位运算扩展
     * @locale
     *
     * @locale en
     * Bit operation extension
     * @locale
     */
    bitsExtension?: number;
}
export interface AddFriendOptions {
    account: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 附言
     * @locale
     *
     * @locale en
     * Bit operation extension
     * @locale
     */
    ps?: string;
}
export interface ApplyFriendOptions {
    account: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 附言
     * @locale
     *
     * @locale en
     * Personal message for friend requests
     * @locale
     */
    ps?: string;
}
export interface PassFriendApplyOptions {
    account: string;
    ps: string;
}
export interface RejectFriendApplyOptions {
    account: string;
    ps: string;
}
export interface DeleteFriendOptions {
    account: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否要删除好友的备注
     *
     * @locale
     *
     * @locale en
     * Whether to delete the friend's alias
     * @locale
     */
    delAlias: boolean;
}
export interface UpdateFriendOptions {
    account: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 备注
     * @locale
     *
     * @locale en
     * Alias
     * @locale
     */
    alias: string;
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
