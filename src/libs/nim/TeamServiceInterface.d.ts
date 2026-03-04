/**
 * 调用方式:
 * ```js
 * nim.team.getTeamInfo(options)
 * ```
 */
export interface TeamServiceInterface {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 获取群基本信息。除了创建群时的信息外，还包括 `memberNum`, `mute`, `muteType`, `owner` 等字段
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/session/%E4%BC%9A%E8%AF%9D%E5%A4%B4%E5%83%8F%E4%B8%8E%E5%90%8D%E7%A7%B0.js" target="_blank">会话头像与昵称</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * Get group information
     * @locale
     */
    getTeamInfo(options: {
        teamId: string;
    }): Promise<Team>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 获取群列表
     * @locale
     *
     * @locale en
     * Get group list
     *
     * When there is no local datebase, all groups on the server will be obtained.
     * @locale
     */
    getTeams(): Promise<Team[]>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 根据群 ID 获取群列表
     * @locale
     *
     * @locale en
     * Get group list by group ID
     * @locale
     */
    getTeamsById(options: {
        teamIds: string[];
    }): Promise<GetTeamsByIdResult>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 创建普通群或者高级群。
     *
     * #### 普通群与高级群
     * - 推荐使用高级群
     * - 普通群没有群简介/群公告/群加入方式/群被邀请模式/群邀请模式/群信息修改权限/群信息自定义字段修改权限等等
     * - 普通群成员入群后，需要有新消息才能够看到群，接收到群通知等
     *
     * #### 高级群申请入群鉴权方式{@link CreateTeamOptions.joinMode}
     * - needVerify: 需要管理员同意。默认为`needVerify`
     * - noVerify: 无需管理员同意
     * - rejectAll: 不允许入群邀请
     *
     * #### 高级群被邀请时的鉴权方式{@link CreateTeamOptions.beInviteMode}
     * - needVerify: 需要被邀请成员同意后入群。默认为`needVerify`
     * - noVerify: 不需要验证。被邀请成员直接进群
     *
     * #### 高级群邀请者权限设置{@link CreateTeamOptions.inviteMode}
     * - manager: 管理员邀请。默认为`manager`
     * - all: 所有人都可以邀请
     *
     * #### 高级群信息修改权限设置{@link CreateTeamOptions.updateTeamMode}
     * - manager: 管理员修改。默认为`manager`
     * - all: 所有人都可以修改
     *
     * #### 高级群信息自定义字段修改权限设置{@link CreateTeamOptions.updateExtMode}
     * - manager: 管理员修改。默认为`manager`
     * - all: 所有人都可以修改
     *
     * #### 影响范围:
     * - 如果 `beInviteMode` == `noVerify`:
     *   - 被邀请者和创建者都收到 {@link IMEventInterface.addTeamMembers | addTeamMembers} 事件
     *   - 被邀请者和创建者都收到 {@link IMEventInterface.msg | msg} 事件，其内容是 `attach.type == addTeamMembers` 的通知消息
     * - 如果 `beInviteMode` == `needVerify`:
     *   - 被邀请者收到 {@link IMEventInterface.sysMsg | sysMsg}，其 type 为 'teamInvite'
     * - 多端同步账号还会收到 {@link IMEventInterface.createTeam | createTeam} 事件
     * @locale
     *
     * @locale en
     * Create a group
     *
     * Normal groups cannot set the group joining method
     *
     * For advanced groups, the group joining method is ' needVerify ' by default
     *
     * For advanced groups, the invitee verification mode is ' needVerify ' by default
     *
     * For advanced groups, the group invitation mode is 'manager' by default.
     *
     * For advanced groups, the group information modification permission is 'manager' by default.
     *
     * For advanced groups, the permission for modifying group information custom field is 'manager' by default.
     *
     * Invited group members will receive a group notification and the event {@link IMEventInterface.addTeamMembers | addTeamMembers } will be triggered. After that, they will see the group after someone speaks and receive the event {@link IMEventInterface.teams | teams}.
     *
     * After the user accepts the invitation to join the group, all group members will receive a group notification and the event {@link IMEventInterface.addTeamMembers | addTeamMembers } will be triggered.
     *
     * After the user rejects the invitation to join the group, the inviter will receive a system notification and the event {@link IMEventInterface.sysMsg | sysMsg }, whose type is ' rejectTeamInvite ', will be triggered.
     * @locale
     */
    createTeam(options: CreateTeamOptions): Promise<Team>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 解散群，群主可操作
     *
     * #### 影响范围:
     * - 所有群成员收到群解散事件: {@link IMEventInterface.dismissTeam | dismissTeam}
     * - 所有群成员会收到通知消息{@link IMEventInterface.msg | msg}:
     *   - msg.type: 'notification'
     *   - msg.from: 群主账号
     *   - msg.to: 群id
     *   - msg.attach.type: 'dismissTeam'
     * @locale
     *
     * @locale en
     * Disband the group. Only the group owner can perform this operation.
     *
     * After the group is disbanded, all group members will receive a group notification and the event {@link IMEventInterface.dismissTeam | dismissTeam } will be triggered.
     * @locale
     */
    dismissTeam(options: {
        teamId: string;
    }): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 主动退群。注意群主不能主动退群。若群主要退群，请使用 {@link TeamServiceInterface.transferTeam} 转让群并退群。
     *
     * #### 影响范围:
     * - 群成员收到 {@link IMEventInterface.removeTeamMembers | removeTeamMembers} 事件
     * - 群成员收到通知消息{@link IMEventInterface.msg | msg}:
     *   - msg.type: 'notification'
     *   - msg.from: 退群者账号
     *   - msg.to: 群id
     *   - msg.attach.type: 'leaveTeam'
     *   - msg.attach.users: 退群者信息详情
     * @locale
     *
     * @locale en
     * Voluntarily leave a group
     *
     * After a user voluntarily leaves a group, all group members will receive a group notification and the event {@link IMEventInterface.removeTeamMembers | removeTeamMembers } will be triggered.
     * @locale
     */
    leaveTeam(options: {
        teamId: string;
    }): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 转让群, 群主可操作
     *
     * #### 影响范围:
     * - 所有群成员收到 {@link IMEventInterface.transferTeam | transferTeam} 事件
     * - 所有群成员收到通知消息{@link IMEventInterface.msg | msg}:
     *   - msg.type: 'notification'
     *   - msg.from: 原群主账号
     *   - msg.to: 群id
     *   - msg.attach.type: 'transferTeam'
     *   - msg.attach.account: 新群主账号
     *
     * 若转让同时设置 `leave` 为 `true`，则相当于继续调用 {@link TeamServiceInterface.leaveTeam} 退群。
     * @locale
     *
     * @locale en
     * Transfer group. Only the group owner can perform this operation.
     *
     * After a group is transferred, all group members will receive a group notification and the events {@link IMEventInterface.transferTeam | transferTeam } will be triggered.
     *
     * If you leave the group while transferring the group, it is equivalent to leaving the group voluntarily. All group members will receive a group notification again and the event {@link IMEventInterface.removeTeamMembers | removeTeamMembers } will also be triggered.
     * @locale
     */
    transferTeam(options: TransferTeamOptions): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 更新群基本信息，普通群不允许更新。具体字段的含义请参考 {@link TeamServiceInterface.createTeam | createTeam}
     *
     * #### 影响范围:
     * - 所有群成员收到 {@link IMEventInterface.updateTeam | updateTeam} 事件
     * - 所有群成员收到通知消息{@link IMEventInterface.msg | msg}:
     *   - msg.type: 'notification'
     *   - msg.from: 操作者账号
     *   - msg.to: 群id
     *   - msg.attach.type: 'updateTeam'
     *   - msg.attach.team: 更新的群信息
     * @locale
     *
     * @locale en
     * Update group
     *
     * Normal groups cannot be updated:
     *
     * Group joining method
     *
     * Invitee verification mode
     *
     * Group invitation mode
     *
     * Group information modification permission
     *
     * Permission for modifying group information custom field modification
     *
     * After updating the group, all group members will receive a group notification and the event {@link IMEventInterface.updateTeam | updateTeam } will be triggered.
     * @locale
     */
    updateTeamInfo(options: UpdateTeamInfoOptions): Promise<Partial<Team>>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 获取群成员.
     *
     * 参数允许传 accounts 用于过滤群成员的结果
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/team/%E7%BE%A4%E6%88%90%E5%91%98%E7%AE%A1%E7%90%86.js" target="_blank">群成员管理</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * Get group members
     *
     * The parameter allows you to pass accounts to filter the results of group members
     * @locale
     */
    getTeamMembers(options: GetTeamMembersOptions): Promise<TeamMember[]>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 获取被禁言的群成员
     *
     * #### 关联函数
     * - {@link TeamServiceInterface.muteTeamMember}
     * @locale
     *
     * @locale en
     * Get muted group members
     * @locale
     */
    getMutedTeamMembers(options: {
        teamId: string;
    }): Promise<TeamMember[]>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 添加群成员
     *
     * 普通群：
     * - 拉人入群后, 所有群成员会收到通知并触发事件 {@link IMEventInterface.addTeamMembers | addTeamMembers}
     * - 被邀请的群成员先只有在群内成员发送消息后，才能够感知到自己已经入群。
     *
     * 高级群：
     * - 如果 `beInviteMode`: `noVerify`:
     *   - 所有群成员收到 {@link IMEventInterface.addTeamMembers | addTeamMembers} 事件
     *   - 被邀请人直接入群，所有群成员触发通知消息{@link IMEventInterface.msg | msg}:
     *     - msg.type: 'notification'
     *     - msg.from: 操作者
     *     - msg.to: 被邀请者
     *     - msg.attach.type: 'addTeamMembers'
     *     - msg.attach.accounts: 被邀请者账号
     * - 如果 `beInviteMode`: 'needVerify':
     *   - 被邀请者触发 {@link IMEventInterface.sysMsg | sysMsg}，其 type 为 'teamInvite'
     *   - 被邀请者通过 {@link TeamServiceInterface.acceptTeamInvite} 或者 {@link TeamServiceInterface.rejectTeamInvite} 来处理邀请
     * @locale
     *
     * @locale en
     * Add group members
     *
     * Normal group:
     *
     * 1. After people are invited to the group, all group members will receive a notification and the event {@link IMEventInterface.addTeamMembers | addTeamMembers } will be triggered.
     *
     * 2. The invited person receives a notification first and the event {@link IMEventInterface.addTeamMembers | addTeamMembers } will be triggered. The group will be visible to the invited person after someone chats in the group, when the event {@link IMEventInterface.teams | teams} is triggered.
     *
     * Advanced group:
     *
     * After the group owner and admins invite persons to join the group (create a group or invite persons to the group), the invitee will receive a system notification and the event {@link IMEventInterface.sysMsg | sysMsg }, whose type is ' teamInvite ', will be triggered.
     *
     * If the user accepts the invitation to join the group, all members of the group will receive a group notification message, the event {@link IMEventInterface.addTeamMembers | addTeamMembers } will be triggered.
     *
     * If the user rejects the group invitation, the inviter will receive a system notification and the event {@link IMEventInterface.sysMsg | sysMsg }, whose type is ' rejectTeamInvite ', will be triggered.
     * @locale
     *
     */
    addTeamMembers(options: AddTeamMembersOptions): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 踢人出群
     *
     * #### 影响范围:
     * - 群成员收到 {@link IMEventInterface.removeTeamMembers | removeTeamMembers} 事件
     * - 群成员收到通知消息{@link IMEventInterface.msg | msg}:
     *   - msg.type: 'notification'
     *   - msg.from: 踢人者id
     *   - msg.to: 群id
     *   - msg.attach.type: 'removeTeamMembers'
     *   - msg.attach.accounts: 被踢者账号
     * @locale
     *
     * @locale en
     * Kick people out of the group
     *
     * After kicking someone out of the group, all group members will receive a group notification and the event {@link IMEventInterface.removeTeamMembers | removeTeamMembers } will be triggered.
     * @locale
     */
    removeTeamMembers(options: RemoveTeamMembersOptions): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 申请入群。根据 `joinMode` 不同，SDK会有不同的行为。
     *
     * - 如果 `joinMode`: `noVerify`:
     *   - 所有群成员收到新增成员事件回调 {@link IMEventInterface.addTeamMembers | addTeamMembers}
     *   - 所有群成员收到通知消息{@link IMEventInterface.msg | msg}:
     *     - msg.type: 'notification'
     *     - msg.from: 申请者账号
     *     - msg.to: 群id
     *     - msg.attach.type: 'passTeamApply'
     *     - msg.attach.account: 申请者账号
     * - 如果 `joinMode`: 'needVerify':
     *   - 管理员收到 {@link IMEventInterface.sysMsg | sysMsg}，其 type 为 'applyTeam'。管理员通过 {@link TeamServiceInterface.passTeamApply} 或者 {@link TeamServiceInterface.rejectTeamApply} 来处理申请
     * - 如果 `joinMode`: 'rejectAll':
     *   - 调用此函数会抛出全局异常
     *
     * 用户可以主动申请加入高级群, 目标群的群主和管理员会收到系统通知，触发事件  {@link IMEventInterface.sysMsg | sysMsg} type 为 'applyTeam'，
     * @locale
     *
     * @locale en
     * Request to join the group
     *
     * Users can voluntarily request to join the advanced group, the group owner and admins of the group will receive a system notification, and the event {@link IMEventInterface.sysMsg | sysMsg }, whose type is ' applyTeam ', will be triggered.
     * @locale
     */
    applyTeam(options: ApplyTeamOptions): Promise<Team>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 添加群管理员。只有群主有权限操作
     *
     * #### 影响范围:
     * - 所有群成员收到更新群管理员事件回调 {@link IMEventInterface.updateTeamManagers | updateTeamManagers}
     * - 所有群成员收到通知消息{@link IMEventInterface.msg | msg}:
     *   - msg.type: 'notification'
     *   - msg.from: 群主账号
     *   - msg.to: 群id
     *   - msg.attach.type: 'addTeamManagers'
     *   - msg.attach.accounts: 新增管理员账号
     * @locale
     *
     * @locale en
     * Add group admin
     *
     * After adding a group manager, all group members will receive a group notification and trigger the event {@link IMEventInterface.updateTeamManagers | updateTeamManagers }.
     * @locale
     */
    addTeamManagers(options: AddTeamManagersOptions): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 移除群管理员。只有群主有权限操作
     *
     * #### 影响范围:
     * - 所有群成员收到更新群管理员事件回调 {@link IMEventInterface.updateTeamManagers | updateTeamManagers}
     * - 所有群成员收到通知消息{@link IMEventInterface.msg | msg}:
     *   - msg.type: 'notification'
     *   - msg.from: 群主账号
     *   - msg.to: 群id
     *   - msg.attach.type: 'removeTeamManagers'
     *   - msg.attach.accounts: 被移除管理员账号
     * @locale
     *
     * @locale en
     * Remove group admin
     *
     * After a group admin is removed, all group members will receive a group notification and the event {@link IMEventInterface.updateTeamManagers | updateTeamManagers } will be triggered.
     * @locale
     */
    removeTeamManagers(options: RemmoveTeamManagersOptions): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 修改自己在群里的信息
     *
     * #### 影响范围:
     * - 所有群成员会收群成员信息变更 {@link IMEventInterface.updateTeamMember | updateTeamMember}
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/session/%E4%BC%9A%E8%AF%9D%E5%85%8D%E6%89%93%E6%89%B0.js" target="_blank">会话免打扰</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * To modify your information in the group
     * @locale
     */
    updateMyMemberInfo(options: UpdateMyMemberInfoOptions): Promise<TeamMember>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 修改别人的群昵称。管理员有权限修改别人的群昵称。
     *
     * #### 影响范围:
     * - 所有群成员会收群成员信息变更 {@link IMEventInterface.updateTeamMember | updateTeamMember}
     * @locale
     *
     * @locale en
     * Modify other persons' group nicknames
     *
     * All other online group members will receive the event {@link IMEventInterface.updateTeamMember | updateTeamMember } .
     * @locale
     */
    updateMemberNick(options: UpdateMemberNickOptions): Promise<TeamMember>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 更新群成员禁言状态。只能禁言比之前权限更低的用户。
     *
     * #### 影响范围:
     * - 所有群成员收到 {@link IMEventInterface.updateTeamMembersMute | updateTeamMembersMute} 事件
     * - 所有群成员收到通知消息{@link IMEventInterface.msg | msg}:
     *   - msg.type: 'notification'
     *   - msg.from: 操作者账号
     *   - msg.to: 群id
     *   - msg.attach.type: 'updateTeamMemberMute'
     *   - msg.attach.account: 被禁言者账号
     *   - msg.attach.mute: 是否被禁言
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/team/%E7%BE%A4%E9%9D%99%E9%9F%B3.js" target="_blank">群静音</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * Update group member mute status
     *
     * After updating the mute status of group members, all group members will receive a group notification and the event {@link IMEventInterface.updateTeamMembersMute | updateTeamMembersMute } will be triggered.
     *
     * The “attach” (attachment) of the triggered event has a field “team”, whose value is the corresponding group; “account” refers to the muted account, and “members” is the list of muted group members.
     * @locale
     */
    muteTeamMember(options: MuteTeamMemberOptions): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 获取若干群成员的邀请者 accountId
     * @locale
     *
     * @locale en
     * Get the accountId of several group members’ inviters.
     * @locale
     */
    getTeamMemberInvitorAccid(options: GetTeamMemberInvitorAccidOptions): Promise<GetTeamMemberInvitorAccidResult>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群组全体禁言，或者取消禁言。只有管理员有权限操作
     *
     * #### 影响范围:
     * - 所有群成员收到群更新事件回调 {@link IMEventInterface.updateTeam | updateTeam}
     * - 所有群成员收到通知消息{@link IMEventInterface.msg | msg}:
     *   - msg.type: 'notification'
     *   - msg.from: 操作者账号
     *   - msg.to: 群id
     *   - msg.attach.type: 'updateTeam'
     *   - msg.attach.team: 群部分信息。包括了禁言相关信息
     *
     * #### 示例场景
     * <ul>
     * <li><a href="https://github.com/netease-im/im-code-example-web/blob/master/im-elite/team/%E7%BE%A4%E9%9D%99%E9%9F%B3.js" target="_blank">群静音</a></li>
     * </ul>
     * @locale
     *
     * @locale en
     * All group members are muted.
     * @locale
     */
    muteTeam(options: MuteTeamOptions): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * （管理员）通过群申请
     *
     * #### 影响范围:
     * - 所有群成员收到 {@link IMEventInterface.addTeamMembers | addTeamMembers} 事件
     * - 所有群成员收到群通知消息 {@link IMEventInterface.msg | msg}
     *   - msg.type: 'notification'
     *   - msg.from: 通过申请者账号
     *   - msg.to: 群id
     *   - msg.attach.type: 'passTeamApply'
     *   - msg.attach.account: 申请者账号
     * @locale
     *
     * @locale en
     * (Admin) approves the request to join the group.
     * @locale
     */
    passTeamApply(options: PassTeamApplyOptions): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * （管理员）拒绝群申请
     *
     * 管理员收到 type 为 `applyTeam` 的 {@link IMEventInterface.sysMsg | sysMsg} 后，调用此接口拒绝群申请。
     *
     * #### 影响范围:
     * 拒绝群申请后，申请者收到 type 为 'rejectTeamApply' {@link IMEventInterface.sysMsg | sysMsg} 系统通知
     * @locale
     *
     * @locale en
     * (Admin) rejects the request to join the group.
     * @locale
     */
    rejectTeamApply(options: RejectTeamApplyOptions): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 同意入群邀请。
     *
     * 收到 type 为 'teamInvite' 的 {@link IMEventInterface.sysMsg | sysMsg} 后，调用此接口同意入群邀请。
     *
     * #### 影响范围:
     *   - 所有群成员触发 {@link IMEventInterface.addTeamMembers | addTeamMembers} 事件
     *   - 所有群成员收到群通知消息 {@link IMEventInterface.msg | msg}
     *     - msg.type: 'notification'
     *     - msg.from: 被邀请人账号
     *     - msg.to: 群id
     *     - msg.attach.type: 'acceptTeamInvite'
     *     - msg.attach.account: 邀请者账号
     * @locale
     *
     * @locale en
     * (User) accepts the invitation to join the group.
     * @locale
     */
    acceptTeamInvite(options: AcceptTeamInviteOptions): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 拒绝入群邀请
     *
     * 收到 type 为 'teamInvite' 的 {@link IMEventInterface.sysMsg | sysMsg} 后，调用此接口拒绝入群邀请。
     *
     * #### 影响范围:
     *   - 邀请者收到 type 为 'rejectTeamInvite' {@link IMEventInterface.sysMsg | sysMsg} 系统通知
     * @locale
     *
     * @locale en
     * (User) rejects the invitation to join the group.
     * @locale
     */
    rejectTeamInvite(options: RejectTeamInviteOptions): Promise<void>;
}
/**
 * @Multi_Lang_Tag
 * @locale cn
 * 群加入方式, 仅限高级群有此属性，普通群(讨论组)没有
 *
 * noVerify 不需要验证
 * needVerify 加此群需要相关人员的验证
 * rejectAll 拒绝其他人加入
 * @locale
 *
 * @locale en
 * Only advanced groups have the Group Joining Method attribute. Normal groups (discussion groups) do not have this attribute
 *
 * noVerify: verification not required for joining the group.
 * needVerify: verification required for joining the group.
 * rejectAll: no more persons can join the group.
 * @locale
 */
export declare type TeamJoinMode = 'noVerify' | 'needVerify' | 'rejectAll';
/**
 * @Multi_Lang_Tag
 * @locale cn
 * 被邀请模式, 仅限高级群
 *
 * noVerify 不需要验证
 * needVerify 此群邀请某人，需要此人验证通过才能加入
 * @locale
 *
 * @locale en
 * Invited mode, advanced group only
 *
 * noVerify: verification not required
 * needVerify: invitee needs to be verified before the invitee can join the group.
 * @locale
 */
export declare type TeamBeInviteMode = 'noVerify' | 'needVerify';
/**
 * @Multi_Lang_Tag
 * @locale cn
 * 群邀请模式, 仅限高级群
 *
 * manager 管理员。仅限管理员可以邀请人进群
 * all 所有人。所有人都可以邀请人进群
 * @locale
 *
 * @locale en
 * Group invitation mode (only available for advanced groups)
 *
 * manager: only group admins can invite people to the group.
 * all: all group members can invite people to the group.
 * @locale
 */
export declare type TeamInviteMode = 'manager' | 'all';
/**
 * @Multi_Lang_Tag
 * @locale cn
 * 群信息修改权限, 仅限高级群
 *
 * manager 管理员。仅限管理员可以修改群信息
 * all 所有人
 * @locale
 *
 * @locale en
 * Group information modification permission (only available for advanced groups)
 *
 * manager: only group admins can modify group information
 * all
 * @locale
 */
export declare type TeamUpdateTeamMode = 'manager' | 'all';
/**
 * @Multi_Lang_Tag
 * @locale cn
 * 群信息自定义字段修改权限, 仅限高级群
 *
 * manager 管理员
 * all 所有人
 * @locale
 *
 * @locale en
 * Permission for modifying group information custom field (only available for advanced groups)
 *
 * manager: only group admins can modify group information custom fields.
 * all: all members can modify group information custom fields.
 * @locale
 */
export declare type TeamUpdateExtMode = 'manager' | 'all';
export interface Team {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群Id
     * @locale
     *
     * @locale en
     * Group ID
     * @locale
     */
    teamId: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群类型
     *
     * normal 为普通群（讨论组）
     * advanced 为 高级群
     *
     * 注：普通群没有群简介/群公告/群加入方式/群被邀请模式/群邀请模式/群信息修改权限/群信息自定义字段修改权限
     * @locale
     *
     * @locale en
     * Group type
     *
     * - normal: normal group (discussion group)
     * - advanced: advanced group
     *
     * Note: Normal group has no attributes including group introduction, group announcement, group joining method, invitee verification mode, group invitation mode, group information modification permission, and the permission for modifying group information custom field.
     * @locale
     */
    type: 'normal' | 'advanced';
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群名
     * @locale
     *
     * @locale en
     * Group name
     * @locale
     */
    name: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群头像
     * @locale
     *
     * @locale en
     * Group name
     * @locale
     */
    avatar: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群加入方式, 仅限高级群有此属性，普通群(讨论组)没有
     *
     * noVerify 不需要验证
     * needVerify 加此群需要相关人员的验证
     * rejectAll 拒绝其他人加入
     * @locale
     *
     * @locale en
     * Group joining method; only advanced groups have this attribute, normal groups (discussion groups) do not have this attribute
     *
     * noVerify: Verification not required.
     * needVerify: Verification is required before a person joins the group.
     * rejectAll: rejects others to join the group.
     * @locale
     */
    joinMode: TeamJoinMode;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 被邀请模式, 仅限高级群
     *
     * noVerify 不需要验证
     * needVerify 此群邀请某人，需要此人验证通过才能加入
     * @locale
     *
     * @locale en
     * Invitee verification mode (only available for the advanced group)
     *
     * noVerify: Verification not required.
     * needVerify: After a group member invites a person to join the group, the person need to be verified by the group member before the person can join the group.
     * @locale
     */
    beInviteMode: TeamBeInviteMode;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群邀请模式, 仅限高级群
     *
     * manager 管理员。仅限管理员可以邀请人进群
     * all 所有人。所有人都可以邀请人进群
     * @locale
     *
     * @locale en
     * Group invitation mode (only available for advanced groups)
     *
     * manager: only group admins can invite people to join the group.
     * all: everyone member can invite people to join the group.
     * @locale
     */
    inviteMode: TeamInviteMode;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群信息修改权限, 仅限高级群
     *
     * manager 管理员。仅限管理员可以修改群信息
     * all 所有人
     * @locale
     *
     * @locale en
     * Group information modification permission (only available for advanced groups)
     *
     * manager: only group admins can modify group information
     * all: all members can modify group information.
     * @locale
     */
    updateTeamMode: TeamUpdateTeamMode;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群信息自定义字段修改权限, 仅限高级群
     *
     * manager 管理员
     * all 所有人
     * @locale
     *
     * @locale en
     * Permission for modifying group information custom field (only available for advanced groups)
     *
     * manager: only group admins can modify group information custom field.
     * all: all members can modify group information custom field.
     * @locale
     */
    updateExtMode: TeamUpdateExtMode;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群主
     * @locale
     *
     * @locale en
     * Group owner
     * @locale
     */
    owner: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群人数上限
     * @locale
     *
     * @locale en
     * Maximum group size
     * @locale
     */
    level: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群成员数量
     * @locale
     *
     * @locale en
     * Number of group members
     * @locale
     */
    memberNum: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群成员最后更新时间戳
     * @locale
     *
     * @locale en
     * Timestamp of the last update of group member
     * @locale
     */
    memberUpdateTime: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群创建时间戳
     * @locale
     *
     * @locale en
     * Group creation timestamp
     * @locale
     */
    createTime: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群最后更新时间戳
     * @locale
     *
     * @locale en
     * Timestamp of the last update of the group
     * @locale
     */
    updateTime: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否有效, 解散后该群无效
     * @locale
     *
     * @locale en
     * Whether it is valid or not, the group will be invalid after disbanding
     * @locale
     */
    valid: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 该群是否对当前用户有效, 如果无效, 那么说明被踢了
     * @locale
     *
     * @locale en
     * Whether the group is valid for the current user, if it is invalid, it means that the current user has been kicked
     * @locale
     */
    validToCurrentUser: boolean;
    /**
     * @deprecated Use {@link Team.muteType} instead.
     *
     * @Multi_Lang_Tag
     * @locale cn
     * 是否禁言, 禁言状态下普通成员不能发送消息, 创建者和管理员可以发送消息
     * @locale
     *
     * @locale en
     * Whether to mute the group. If a group is muted, only group owners and admins can send messages.
     * @locale
     */
    mute: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 禁言模式
     *
     * none: 都不禁言;
     *
     * normal: 普通成员禁言，即普通成员不能发消息;
     *
     * all: 全体禁言，即所有成员均不能发消息禁言模式，包含群主
     * @locale
     *
     * @locale en
     * Mute mode
     * none: all members are unmuted.
     * normal: ordinary members are muted. In other words, ordinary members cannot send messages.
     * all: all members are muted. In other words, all members cannot send messages, including the group leader.
     * @locale
     */
    muteType: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群简介
     * @locale
     *
     * @locale en
     * Group introduction
     * @locale
     */
    intro?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群公告
     * @locale
     *
     * @locale en
     * Group announcement
     * @locale
     */
    announcement?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 第三方扩展字段, 开发者可以自行扩展, 建议封装成JSON格式字符串
     * 通 IM1 的 custom 字段。统一改叫 ext
     * @locale
     *
     * @locale en
     * Third-party extension fields. You can extend by yourselves. It is recommended that you encapsulate them into JSON format strings.
     * @locale
     */
    ext?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 第三方服务器扩展字段, 开发者可以自行扩展, 建议封装成JSON格式字符串
     * 通 IM1 的 serverCustom 字段。统一改叫 serverExt
     * @locale
     *
     * @locale en
     * Third-party server extension fields. You can extend by yourselves. It is recommended that you encapsulate them into JSON format strings.
     * @locale
     */
    serverExt?: string;
}
export declare type TeamMemberType = 'normal' | 'owner' | 'manager' | 'apply' | 'applyReject';
export interface TeamMember {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群成员的 id 标识（teamId + account）
     * @locale
     *
     * @locale en
     * The ID of the group member ( teamId + account)
     * @locale
     */
    id: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群ID
     * @locale
     *
     * @locale en
     * Group ID
     * @locale
     */
    teamId: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 帐号
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
     * 群成员类型
     *
     * 'normal' (普通成员)
     * 'owner' (群主)
     * 'manager' (管理员)
     * @locale
     *
     * @locale en
     * Group member type
     *
     * 'normal' (regular member)
     * 'owner' (group owner)
     * 'manager' (admin)
     * @locale
     */
    type: TeamMemberType;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 在群里面的昵称
     * @locale
     *
     * @locale en
     * Nickname in the group
     * @locale
     */
    nickInTeam: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 入群时间
     * @locale
     *
     * @locale en
     * Joining time
     * @locale
     */
    joinTime: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 更新时间
     * @locale
     *
     * @locale en
     * Update time
     * @locale
     */
    updateTime: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 普通群拉人进来的时候, 被拉的人处于未激活状态, 未激活状态下看不到这个群, 当有人说话后自动转为激活状态, 能看到该群
     * @locale
     *
     * @locale en
     * When a person is invited to a normal group, the status of the invited person is inactivated. For a person in this status, the group in invisible. When someone chats in the group, the status of the invited person automatically turns activated, and then the invited person can see the group.
     * @locale
     */
    active: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群成员是否有效
     * @locale
     *
     * @locale en
     * Whether the group members are valid
     * @locale
     */
    valid: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否被禁言
     * @locale
     *
     * @locale en
     * Whether the member is muted
     * @locale
     */
    mute?: boolean;
    /**
     * @deprecated Use {@link TeamMember.bitConfigMask} instead.
     *
     * @Multi_Lang_Tag
     * @locale cn
     * 是否关闭此群的消息提醒, true表示关闭提醒, 但是SDK仍然会收到这个群的消息, SDK只是记录这个设置, 具体根据这个设置要执行的操作由第三方APP决定
     * @locale
     *
     * @locale en
     * Whether to mute notifications of messages of this group; “true” means to mute; if muted, the SDK still receives messages of this group, the SDK just records this mute setting. So you should determine what the corresponding UI display should be like.
     * @locale
     */
    muteTeam?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 提醒策略
     *
     * 0 开启提醒
     * 1 关闭消息提醒
     * 2 只接受管理员的消息的提醒
     * @locale
     *
     * @locale en
     * Notification strategy
     *
     * 0: enable notification
     * 1: disable notification
     * 2: only notify group members of messages sent from group admins
     * @locale
     */
    bitConfigMask?: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 第三方扩展字段
     * @locale
     *
     * @locale en
     * Third-party extension fields
     * @locale
     */
    ext?: string;
}
export interface CreateTeamOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群类型
     *
     * - normal 为普通群（讨论组）
     * - advanced 为 高级群
     *
     * 注：普通群没有群简介/群公告/群加入方式/群被邀请模式/群邀请模式/群信息修改权限/群信息自定义字段修改权限
    
     * @locale
     *
     * @locale en
     * Group type
     * @locale
     */
    type: 'normal' | 'advanced';
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群名
     * @locale
     *
     * @locale en
     * Group name
     * @locale
     */
    name: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群头像
     * @locale
     *
     * @locale en
     * Group avatar
     * @locale
     */
    avatar?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群简介
     * @locale
     *
     * @locale en
     * Introduction
     * @locale
     */
    intro?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群公告
     * @locale
     *
     * @locale en
     * Announcement
     * @locale
     */
    announcement?: string;
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
     * 群等级，即人数上限
     * @locale
     *
     * @locale en
     * Group level, the upper limit of members
     * @locale
     */
    level?: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 要拉进群的成员的帐号列表
     * @locale
     *
     * @locale en
     * accounts to be invited to join the group
     * @locale
     */
    accounts?: string[];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 拉人附言
     * @locale
     *
     * @locale en
     * Personal message for invitations
     * @locale
     */
    ps?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群加入方式
     * @locale
     *
     * @locale en
     * Group joining method
     * @locale
     */
    joinMode?: TeamJoinMode;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群被邀请模式
     * @locale
     *
     * @locale en
     * Invitee verification mode
     * @locale
     */
    beInviteMode?: TeamBeInviteMode;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群邀请模式
     * @locale
     *
     * @locale en
     * Group invitation mode
     * @locale
     */
    inviteMode?: TeamInviteMode;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群信息修改权限
     * @locale
     *
     * @locale en
     * Group information modification permission
     * @locale
     */
    updateTeamMode?: TeamUpdateTeamMode;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群信息自定义字段修改权限
     * @locale
     *
     * @locale en
     * Permission for modifying group information custom field
     * @locale
     */
    updateExtMode?: TeamUpdateExtMode;
}
export interface TransferTeamOptions {
    teamId: string;
    account: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 转让群的同时是否离开群
     * @locale
     *
     * @locale en
     * Whether to leave the group while transferring the group
     * @locale
     */
    leave: boolean;
}
export interface UpdateTeamInfoOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群 id
     * @locale
     *
     * @locale en
     * Group ID
     * @locale
     */
    teamId: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群名
     * @locale
     *
     * @locale en
     * Group name
     * @locale
     */
    name?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群头像
     * @locale
     *
     * @locale en
     * Group avatar
     * @locale
     */
    avatar?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群简介
     * @locale
     *
     * @locale en
     * Group introduction
     * @locale
     */
    intro?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群公告
     * @locale
     *
     * @locale en
     * Group announcement
     * @locale
     */
    announcement?: string;
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
     * 群加入方式
     * @locale
     *
     * @locale en
     * Group joining method
     * @locale
     */
    joinMode?: TeamJoinMode;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群被邀请模式
     * @locale
     *
     * @locale en
     * Invitee verification mode
     *
     * @locale
     */
    beInviteMode?: TeamBeInviteMode;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群邀请模式
     * @locale
     *
     * @locale en
     * Group invitation mode
     * @locale
     */
    inviteMode?: TeamInviteMode;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群信息修改权限
     * @locale
     *
     * @locale en
     * Group information modification permission
     * @locale
     */
    updateTeamMode?: TeamUpdateTeamMode;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群信息自定义字段修改权限
     * 通 IM1 的 updateCustomMode
     * @locale
     *
     * @locale en
     * Permission for modifying group information custom field
     * @locale
     */
    updateExtMode?: TeamUpdateExtMode;
}
export interface GetTeamsByIdResult {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 获取到的群
     * @locale
     *
     * @locale en
     * Obtained groups
     * @locale
     */
    teams: Team[];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 获取不到信息的群 id
     * @locale
     *
     * @locale en
     * IDs of groups which no information can be obtained
     * @locale
     */
    tids: string[];
}
export interface AddTeamMembersOptions {
    teamId: string;
    accounts: string[];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 附言，长度不得大于 5000，开发者可以使用 JSON 格式字符串填充
     * @locale
     *
     * @locale en
     * P.S., the length should not be greater than 5,000, you can use JSON format string to fill in.
     * @locale
     */
    ps?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 附加字段，推荐使用 JSON 格式字符串
     * @locale
     *
     * @locale en
     * Additional fields, JSON format strings are recommended
     * @locale
     */
    ext?: string;
}
export interface RemoveTeamMembersOptions {
    teamId: string;
    accounts: string[];
}
export interface ApplyTeamOptions {
    teamId: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 附言
     * @locale
     *
     * @locale en
     * postscript
     * @locale
     */
    ps?: string;
}
export interface AddTeamManagersOptions {
    teamId: string;
    accounts: string[];
}
export interface RemmoveTeamManagersOptions {
    teamId: string;
    accounts: string[];
}
export interface UpdateMyMemberInfoOptions {
    teamId: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 在群里的昵称
     *
     * 注: 修改此字段后, 所有其它在线的群成员会收到事件 {@link IMEventInterface.updateTeamMember | updateTeamMember} 。
     * @locale
     *
     * @locale en
     * Nickname in the group
     * @locale
     */
    nickInTeam?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 提醒策略
     *
     * 0 开启提醒
     *
     * 1 关闭消息提醒
     *
     * 2 只接受管理员的消息的提醒
     *
     * 注意：如果关闭提醒，SDK仍然会收到这个群的消息。SDK只是记录这个设置，具体根据这个设置要执行的操作由开发者自行决定。
     * @locale
     *
     * @locale en
     * Notification strategy
     *
     * 0: enable notification
     *
     * 1: disable notification
     *
     * 2: only notify members of messages from admins
     *
     * Notice: if muted, the SDK still receives messages of this group.The SDK just records this mute setting, So you should determine what the corresponding UI display should be like.
     * @locale
     */
    bitConfigMask?: number;
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
export interface UpdateMemberNickOptions {
    teamId: string;
    account: string;
    nickInTeam: string;
}
export interface MuteTeamMemberOptions {
    teamId: string;
    account: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否要禁言
     * @locale
     *
     * @locale en
     * Whether to mute
     * @locale
     */
    mute: boolean;
}
export interface GetTeamMembersOptions {
    teamId: string;
    accounts?: string[];
}
export interface GetTeamMemberInvitorAccidOptions {
    teamId: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 需要查询邀请者accid的群成员账号列表，一次最多查200个。
     *
     * 当群成员数量小于等于200时为可选参数，不填默认查全部成员；
     * 群成员数量大于200时，需要将成员列表分批多次调用此接口查询
     * @locale
     *
     * @locale en
     * List of the member accounts whose inviters’ accid need to be searched (up to 200 at a time).
     *
     * When the number of group members is less than or equal to 200, it is an optional parameter. If not filled in, all members’ inviters will be searched by default.
     * When the number of group members is greater than 200, all members’ inviters need to be searched in batches by calling this API.
     * @locale
     */
    accounts: string[];
}
/**
 * @Multi_Lang_Tag
 * @locale cn
 * key 是群成员的 accid，value 是邀请者的 accid
 * @locale
 *
 * @locale en
 * key is the accid of the group member, value is the accid of the inviter
 * @locale
 */
export interface GetTeamMemberInvitorAccidResult {
    [key: string]: string;
}
export interface MuteTeamOptions {
    teamId: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否禁言
     * @locale
     *
     * @locale en
     * Whether to mute
     * @locale
     */
    mute: boolean;
}
export interface PassTeamApplyOptions {
    teamId: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 申请者的 accountId
     * @locale
     *
     * @locale en
     * Requester's accountId
     * @locale
     */
    from: string;
}
export interface RejectTeamApplyOptions {
    teamId: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 申请者的 accountId
     * @locale
     *
     * @locale en
     * Requester's accountId
     * @locale
     */
    from: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 附加信息
     * @locale
     *
     * @locale en
     * Additional information
     * @locale
     */
    ps?: string;
}
export interface AcceptTeamInviteOptions {
    teamId: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 邀请者的 accountId
     * @locale
     *
     * @locale en
     * accountId of the inviter
     * @locale
     */
    from: string;
}
export interface RejectTeamInviteOptions {
    teamId: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 邀请者的 accountId
     * @locale
     *
     * @locale en
     * accountId of the inviter
     * @locale
     */
    from: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 附加信息
     * @locale
     *
     * @locale en
     * Additional information
     * @locale
     */
    ps?: string;
}
