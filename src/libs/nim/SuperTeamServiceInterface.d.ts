/**
 * 调用方式:
 * ```js
 * nim.superTeam.getSuperTeamInfo(options)
 * ```
 */
export interface SuperTeamServiceInterface {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 获取群基本信息。除了创建群时的信息外，还包括 `memberNum`, `muteType`, `owner` 等字段
     * @locale
     *
     * @locale en
     * Get the information of the supergroup according to the group ID.
     * @locale
     */
    getSuperTeamInfo(options: {
        teamId: string;
    }): Promise<SuperTeam>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 获取超级群列表
     * @locale
     *
     * @locale en
     * Get the supergroup list.
     * @locale
     */
    getSuperTeams(): Promise<SuperTeam[]>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 更新群基本信息
     *
     * #### 影响范围:
     * - 所有群成员收到 {@link IMEventInterface.updateSuperTeam | updateSuperTeam} 事件
     * - 所有群成员收到通知消息{@link IMEventInterface.msg | msg}:
     *   - msg.type: 'notification'
     *   - msg.from: 操作者账号
     *   - msg.to: 群id
     *   - msg.attach.type: 'updateSuperTeam'
     *   - msg.attach.team: 更新的群信息
     * @locale
     *
     * @locale en
     * Update supergroup
     *
     * After the group is updated, all group members will receive group notifications and the event {@link IMEventInterface.updateSuperTeam | updateSuperTeam} will be triggered.
     * @locale
     */
    updateSuperTeamInfo(options: UpdateSuperTeamInfoOptions): Promise<SuperTeam>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 添加超级群成员
     *
     * - 如果 `beInviteMode`: `noVerify`:
     *   - 所有群成员收到 {@link IMEventInterface.addSuperTeamMembers | addSuperTeamMembers} 事件
     *   - 被邀请人直接入群，所有群成员触发通知消息{@link IMEventInterface.msg | msg}:
     *     - msg.type: 'notification'
     *     - msg.from: 操作者
     *     - msg.to: 被邀请者
     *     - msg.attach.type: 'addSuperTeamMembers'
     *     - msg.attach.accounts: 被邀请者账号
     * - 如果 `beInviteMode`: 'needVerify':
     *   - 被邀请者触发 {@link IMEventInterface.sysMsg | sysMsg}，其 type 为 'superTeamInvite'
     *   - 被邀请者通过 {@link SuperTeamServiceInterface.acceptSuperTeamInvite} 或者 {@link SuperTeamServiceInterface.rejectSuperTeamInvite} 来处理邀请
     * @locale
     *
     * @locale en
     * Add members to supergroup
     *
     * After the group owner and administrator invites persons to join the group (via creating a group or adding people into the group), the invitee will receive a system notification and the event {@link IMEventInterface.sysMsg | sysMsg}, whose type is 'superTeamInvite ', will be triggered.
     *
     * If the user accepts the invitation and joins the group, all group members in the group will receive a group notification and the event {@link IMEventInterface.addSuperTeamMembers | addSuperTeamMembers} will be triggered.
     *
     * If the user rejects the group invitation, the inviter will receive a system notification and the event {@link IMEventInterface.sysMsg | sysMsg}, whose type is 'rejectSuperTeamInvite', will be triggered.
     * @locale
     *
     */
    addSuperTeamMembers(options: AddSuperTeamMembersOptions): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 踢人出超级群
     *
     * #### 影响范围:
     * - 群成员收到 {@link IMEventInterface.removeSuperTeamMembers | removeSuperTeamMembers} 事件
     * - 群成员收到通知消息{@link IMEventInterface.msg | msg}:
     *   - msg.type: 'notification'
     *   - msg.from: 踢人者id
     *   - msg.to: 群id
     *   - msg.attach.type: 'removeSuperTeamMembers'
     *   - msg.attach.accounts: 被踢者账号
     * @locale
     *
     * @locale en
     * Kick people out of the supergroup
     *
     * After kicking someone out of the group, all group members will receive a group notification and the event {@link IMEventInterface.removeSuperTeamMembers | removeSuperTeamMembers} will be triggered.
     * @locale
     */
    removeSuperTeamMembers(options: RemoveSuperTeamMembersOptions): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 添加群管理员。只有群主有权限操作
     *
     * #### 影响范围:
     * - 所有群成员收到更新群管理员事件回调 {@link IMEventInterface.updateSuperTeamManagers | updateSuperTeamManagers}
     * - 所有群成员收到通知消息{@link IMEventInterface.msg | msg}:
     *   - msg.type: 'notification'
     *   - msg.from: 群主账号
     *   - msg.to: 群id
     *   - msg.attach.type: 'addSuperTeamManagers'
     *   - msg.attach.accounts: 新增管理员账号
     * @locale
     *
     * @locale en
     * Add supergroup administrator
     *
     * After adding a group administrator, all group members will receive a group notification and the event {@link IMEventInterface.updateSuperTeamManagers | updateSuperTeamManagers} will be triggered.
     * @locale
     */
    addSuperTeamManagers(options: AddSuperTeamManagersOptions): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 移除群管理员。只有群主有权限操作
     *
     * #### 影响范围:
     * - 所有群成员收到更新群管理员事件回调 {@link IMEventInterface.updateSuperTeamManagers | updateSuperTeamManagers}
     * - 所有群成员收到通知消息{@link IMEventInterface.msg | msg}:
     *   - msg.type: 'notification'
     *   - msg.from: 群主账号
     *   - msg.to: 群id
     *   - msg.attach.type: 'removeSuperTeamManagers'
     *   - msg.attach.accounts: 被移除管理员账号
     * @locale
     *
     * @locale en
     * Remove supergroup administrator
     *
     * After removing the group administrator, all group members will receive a group notifications and the event {@link IMEventInterface.updateSuperTeamManagers | updateSuperTeamManagers} will be triggered.
     * @locale
     */
    removeSuperTeamManagers(options: RemmoveSuperTeamManagersOptions): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 申请入群。根据 `joinMode` 不同，SDK会有不同的行为。
     *
     * - 如果 `joinMode`: `noVerify`:
     *   - 所有群成员收到新增成员事件回调 {@link IMEventInterface.addSuperTeamMembers | addSuperTeamMembers}
     *   - 所有群成员收到通知消息{@link IMEventInterface.msg | msg}:
     *     - msg.type: 'notification'
     *     - msg.from: 申请者账号
     *     - msg.to: 群id
     *     - msg.attach.type: 'passSuperTeamApply'
     *     - msg.attach.account: 申请者账号
     * - 如果 `joinMode`: 'needVerify':
     *   - 管理员收到 {@link IMEventInterface.sysMsg | sysMsg}，其 type 为 'applySuperTeam'。管理员通过 {@link SuperTeamServiceInterface.passSuperTeamApply} 或者 {@link SuperTeamServiceInterface.rejectSuperTeamApply} 来处理申请
     * - 如果 `joinMode`: 'rejectAll':
     *   - 调用此函数会抛出全局异常
     *
     * 用户可以主动申请加入高级群, 目标群的群主和管理员会收到系统通知，触发事件  {@link IMEventInterface.sysMsg | sysMsg} type 为 'applySuperTeam'，
     * @locale
     *
     * @locale en
     * Request to join the group.
     *
     * Users can request to join the advanced group, the group owner and administrator of the group will receive a system notification, and the event {@link IMEventInterface.sysMsg | sysMsg}, whose type is 'applySuperTeam', will be triggered.
     * @locale
     */
    applySuperTeam(options: ApplySuperTeamOptions): Promise<SuperTeam>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 转让群, 群主可操作
     *
     * #### 影响范围:
     * - 所有群成员收到 {@link IMEventInterface.transferSuperTeam | transferSuperTeam} 事件
     * - 所有群成员收到通知消息{@link IMEventInterface.msg | msg}:
     *   - msg.type: 'notification'
     *   - msg.from: 原群主账号
     *   - msg.to: 群id
     *   - msg.attach.type: 'transferSuperTeam'
     *   - msg.attach.account: 新群主账号
     *
     * 若转让同时设置 `leave` 为 `true`，则相当于继续调用 {@link SuperTeamServiceInterface.leaveSuperTeam} 退群。
     * @locale
     *
     * @locale en
     * Transfer group. The group owner can operate.
     *
     * After transferring a group, all group members will receive a group notification and the event {@link IMEventInterface.transferSuperTeam | transferSuperTeam} will be triggered.
     *
     * If you leave the group while transferring the group, all group members will receive the group notification again and the event {@link IMEventInterface.removeSuperTeamMembers | removeSuperTeamMembers} will be triggered.
     * @locale
     */
    transferSuperTeam(options: TransferSuperTeamOptions): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群组全体禁言，或者取消禁言。只有管理员有权限操作
     *
     * #### 影响范围:
     * - 所有群成员收到群更新事件回调 {@link IMEventInterface.updateSuperTeam | updateSuperTeam}
     * - 所有群成员收到通知消息{@link IMEventInterface.msg | msg}:
     *   - msg.type: 'notification'
     *   - msg.from: 操作者账号
     *   - msg.to: 群id
     *   - msg.attach.type: 'updateSuperTeam'
     *   - msg.attach.team: 群部分信息。包括了禁言相关信息
     * @locale
     *
     * @locale en
     * Mute all supergroup members
     * @locale
     */
    muteSuperTeam(options: MuteSuperTeamOptions): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 更新群成员禁言状态。只能禁言比之前权限更低的用户。
     *
     * #### 影响范围:
     * - 所有群成员收到 {@link IMEventInterface.updateSuperTeamMembersMute | updateSuperTeamMembersMute} 事件
     * - 所有群成员收到通知消息{@link IMEventInterface.msg | msg}:
     *   - msg.type: 'notification'
     *   - msg.from: 操作者账号
     *   - msg.to: 群id
     *   - msg.attach.type: 'updateSuperTeamMemberMute'
     *   - msg.attach.account: 被禁言者账号
     *   - msg.attach.mute: 是否被禁言
     * @locale
     *
     * @locale en
     * Update supergroup members’ mute status.
     *
     * After updating group member mute status, all group members will receive a group notification and the event {@link IMEventInterface.updateSuperTeamMembersMute | updateSuperTeamMembersMute} will be triggered.
     *
     * Its attachment has a field team whose value is the corresponding group object, the account is the banned account, and members is the list of banned group members.
     * @locale
     */
    muteSuperTeamMembers(options: MuteSuperTeamMembersOptions): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 修改别人的群昵称。管理员有权限修改别人的群昵称。
     *
     * #### 影响范围:
     * - 所有群成员会收群成员信息变更 {@link IMEventInterface.updateSuperTeamMember | updateSuperTeamMember}
     * @locale
     *
     * @locale en
     * Modify the nickname of others in this supergroup。
     *
     * All other online group members will receive the event {@link IMEventInterface.updateSuperTeamMember | updateSuperTeamMember} .
     * @locale
     */
    updateMemberNick(options: UpdateMemberNickOptions): Promise<SuperTeamMember>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 修改自己在群里的信息
     *
     * #### 影响范围:
     * - 所有群成员会收群成员信息变更 {@link IMEventInterface.updateSuperTeamMember | updateSuperTeamMember}
     * @locale
     *
     * @locale en
     * To modify your information in the supergroup
     * @locale
     */
    updateMyMemberInfo(options: UpdateMyMemberInfoOptions): Promise<SuperTeamMember>;
    /**
     * 暂时不考虑弄进来。。IM1 是使用多次回调得到，这里就有点诡异。
     */
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 按照某些账号获取超级群成员
     * @locale
     *
     * @locale en
     * Get supergroup members according to certain accounts
     * @locale
     */
    getSuperTeamMembersByAccounts(options: GetSuperTeamMembersByAccountsOptions): Promise<SuperTeamMember[]>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 获取超级群成员列表
     * @locale
     *
     * @locale en
     * Get supergroup members according to certain accounts
     * @locale
     */
    getSuperTeamMembers(options: GetSuperTeamMembersOptions): Promise<SuperTeamMember[]>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 获取被禁言的群成员
     *
     * #### 关联函数
     * - {@link SuperTeamServiceInterface.muteSuperTeamMembers}
     * @locale
     *
     * @locale en
     * Get the list of muted members of the supergroup
     * @locale
     */
    queryMuteMembers(options: QueryMuteMembersOptions): Promise<SuperTeamMember[]>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 主动退群。注意群主不能主动退群。若群主要退群，请使用 {@link SuperTeamServiceInterface.transferSuperTeam} 转让群并退群。
     *
     * #### 影响范围:
     * - 群成员收到 {@link IMEventInterface.removeSuperTeamMembers | removeSuperTeamMembers} 事件
     * - 群成员收到通知消息{@link IMEventInterface.msg | msg}:
     *   - msg.type: 'notification'
     *   - msg.from: 退群者账号
     *   - msg.to: 群id
     *   - msg.attach.type: 'leaveSuperTeam'
     *   - msg.attach.users: 退群者信息详情
     * @locale
     *
     * @locale en
     * Voluntarily leave the group
     *
     * After actively withdrawing from the group, all group members will receive group notifications and trigger the {@link IMEventInterface.removeSuperTeamMembers | removeSuperTeamMembers} event
     * @locale
     */
    leaveSuperTeam(options: {
        teamId: string;
    }): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * （管理员）通过群申请
     *
     * #### 影响范围:
     * - 所有群成员收到 {@link IMEventInterface.addSuperTeamMembers | addSuperTeamMembers} 事件
     * - 所有群成员收到群通知消息 {@link IMEventInterface.msg | msg}
     *   - msg.type: 'notification'
     *   - msg.from: 通过申请者账号
     *   - msg.to: 群id
     *   - msg.attach.type: 'passSuperTeamApply'
     *   - msg.attach.account: 申请者账号
     * @locale
     *
     * @locale en
     * Administrator approves the request to join the group.
     * @locale
     */
    passSuperTeamApply(options: PassSuperTeamApplyOptions): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * （管理员）拒绝群申请
     *
     * 管理员收到 type 为 `applySuperTeam` 的 {@link IMEventInterface.sysMsg | sysMsg} 后，调用此接口拒绝群申请。
     *
     * #### 影响范围:
     * 拒绝群申请后，申请者收到 type 为 'rejectSuperTeamApply' {@link IMEventInterface.sysMsg | sysMsg} 系统通知
     * @locale
     *
     * @locale en
     * Administrator rejects the request to join the group.
     * @locale
     */
    rejectSuperTeamApply(options: RejectSuperTeamApplyOptions): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 同意入群邀请。
     *
     * 收到 type 为 'superTeamInvite' 的 {@link IMEventInterface.sysMsg | sysMsg} 后，调用此接口同意入群邀请。
     *
     * #### 影响范围:
     *   - 所有群成员触发 {@link IMEventInterface.addSuperTeamMembers | addSuperTeamMembers} 事件
     *   - 所有群成员收到群通知消息 {@link IMEventInterface.msg | msg}
     *     - msg.type: 'notification'
     *     - msg.from: 被邀请人账号
     *     - msg.to: 群id
     *     - msg.attach.type: 'acceptSuperTeamInvite'
     *     - msg.attach.account: 邀请者账号
     * @locale
     *
     * @locale en
     * User accepts the invitation to join the group.
     * @locale
     */
    acceptSuperTeamInvite(options: AcceptSuperTeamInviteOptions): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 拒绝入群邀请
     *
     * 收到 type 为 'superTeamInvite' 的 {@link IMEventInterface.sysMsg | sysMsg} 后，调用此接口拒绝入群邀请。
     *
     * #### 影响范围:
     *   - 邀请者收到 type 为 'rejectSuperTeamInvite' {@link IMEventInterface.sysMsg | sysMsg} 系统通知
     * @locale
     *
     * @locale en
     * User declines the invitation to join the group.
     * @locale
     */
    rejectSuperTeamInvite(options: RejectSuperTeamInviteOptions): Promise<void>;
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
export declare type SuperTeamJoinMode = 'noVerify' | 'needVerify' | 'rejectAll';
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
 * Invitee verification mode (only available for advanced group
 *
 * noVerify: verification not required.
 * needVerify: invitee needs to be verified before the invitee can join the group.
 * @locale
 */
export declare type SuperTeamBeInviteMode = 'noVerify' | 'needVerify';
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
export declare type SuperTeamInviteMode = 'manager' | 'all';
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
 * all: all group members can modify group information.
 * @locale
 */
export declare type SuperTeamUpdateTeamMode = 'manager' | 'all';
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
export declare type SuperTeamUpdateExtMode = 'manager' | 'all';
export interface SuperTeam {
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
    avatar: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群加入方式
     *
     * noVerify 不需要验证
     * needVerify 加此群需要相关人员的验证
     * rejectAll 拒绝其他人加入
     * @locale
     *
     * @locale en
     * Group joining method (how to join the group)
     *
     * noVerify: verification not required.
     * needVerify: verification required before anyone can join the group.
     * rejectAll: reject others to join the group.
     * @locale
     */
    joinMode: SuperTeamJoinMode;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 被邀请模式
     *
     * noVerify 不需要验证
     * needVerify 此群邀请某人，需要此人验证通过才能加入
     * @locale
     *
     * @locale en
     * Invitee verification mode
     *
     * noVerify: verification not required.
     * needVerify: invitee needs to be verified before joining the group.
     * @locale
     */
    beInviteMode: SuperTeamBeInviteMode;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群邀请模式
     *
     * manager 管理员。仅限管理员可以邀请人进群
     * all 所有人。所有人都可以邀请人进群
     * @locale
     *
     * @locale en
     * Group invitation mode
     *
     * manager: only group admins can invite people to the group.
     * all: everyone can invite people to the group.
     * @locale
     */
    inviteMode: SuperTeamInviteMode;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群信息修改权限
     *
     * manager 管理员。仅限管理员可以修改群信息
     * all 所有人
     *
     * 注：level 大于 2000 人这种级别的超级群，设置 all 无法生效，只允许管理员/群主能修改信息
     * @locale
     *
     * @locale en
     * Group information modification permission
     *
     * manager: only group admins can modify group information
     * all: all group members can modify group information.
     *
     * Note: For a supergroup with a “level” greater than 2,000 people, setting the field to “all” is invalid. Only group admins / group owners can modify the information.
     * @locale
     */
    updateTeamMode: SuperTeamUpdateTeamMode;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群信息自定义字段修改权限
     *
     * manager 管理员
     * all 所有人
     *
     * 注：level 大于 2000 人这种级别的超级群，设置 all 无法生效，只允许管理员/群主能修改信息
     * @locale
     *
     * @locale en
     * Permission for modifying group information custom field
     *
     * manager: only group admins can modify group information custom fields.
     * all: all group members can.
     *
     * Note: For a supergroup with a “level” (maximum group size) greater than 2,000 people, setting the field to “all” is invalid. Only group admins / group owners can modify the information.
     * @locale
     */
    updateExtMode: SuperTeamUpdateExtMode;
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
     * Timestamp of the of the last update of group member
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
     * Timestamp of the last group update
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
     * Whether it is valid; the group will be invalid after disbanding
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
     * Whether the group is valid for the current user, if it is invalid, it means that the current user has been kicked out of the group.
     * @locale
     */
    validToCurrentUser: boolean;
    /**
     * @deprecated Use {@link SuperTeam.muteType} instead.
     *
     * @Multi_Lang_Tag
     * @locale cn
     * 是否禁言, 禁言状态下普通成员不能发送消息, 创建者和管理员可以发送消息
     * @locale
     *
     * @locale en
     * Whether the group is muted; if muted, ordinary members cannot send messages in the group, only the group owner and group admins can send messages.
     * @locale
     */
    mute: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 禁言模式
     * none: 都不禁言;
     * normal: 普通成员禁言，即普通成员不能发消息;
     * all: 全体禁言，即所有成员均不能发消息禁言模式，包含群主
     * @locale
     *
     * @locale en
     * Mute mode
     * none: all group members are unmuted.
     * normal: ordinary members are muted. In other words, ordinary members cannot send messages.
     * all: all members are muted. In other words, all members cannot send messages, including the group leader.
     * @locale
     */
    muteType: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 第三方扩展字段, 开发者可以自行扩展, 建议封装成JSON格式字符串
     * 通 IM1 的 custom 字段。统一改叫 ext
     * @locale
     *
     * @locale en
     * Third-party extension fields, you can expand by themselves. It is recommended that you encapsulate them into JSON format strings.
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
     * Third-party server extension fields, you can expand by themselves. It is recommended that you encapsulate them into JSON format strings.
     * @locale
     */
    serverExt?: string;
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
}
export declare type SuperTeamMemberType = 'normal' | 'owner' | 'manager' | 'apply' | 'applyReject';
export interface SuperTeamMember {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群成员的 id 标识（teamId + account）
     * @locale
     *
     * @locale en
     * The ID of the group member (teamId + account)
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
     * 'normal' (normal member)
     * 'owner' (group owner)
     * 'manager' (group admin)
     * @locale
     */
    type: SuperTeamMemberType;
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
     * @deprecated Use {@link SuperTeamMember.bitConfigMask} instead.
     *
     * @Multi_Lang_Tag
     * @locale cn
     * 是否关闭此群的消息提醒, true表示关闭提醒, 但是SDK仍然会收到这个群的消息, SDK只是记录这个设置, 具体根据这个设置要执行的操作由第三方APP决定
     * @locale
     *
     * @locale en
     * Whether to mute group notifications; “true” means to mute group notifications, but the SDK still receives the message of this group. (Note: the SDK just records this mute setting. The third-party APP needs to determine specific operations required to make this setting effective.)
     * @locale
     */
    muteTeam?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 入群时间
     * @locale
     *
     * @locale en
     * Group joining time
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
     * When a member of a normal group invites a person to join the group, the invited person is in an inactivated status. For a person in this status, the normal group is invisible to them. When someone in the group speaks, the invited person automatically turns activated and the group becomes visible to them.
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
     * Whether the group member is valid
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
     * Whether to be muted
     * @locale
     */
    mute?: boolean;
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
     * 2: Only notify messages from group admins
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
export interface TransferSuperTeamOptions {
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
export interface UpdateSuperTeamInfoOptions {
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
    joinMode?: SuperTeamJoinMode;
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
    beInviteMode?: SuperTeamBeInviteMode;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 群邀请模式
     *
     * @locale
     *
     * @locale en
     * Group invitation mode
     * @locale
     */
    inviteMode?: SuperTeamInviteMode;
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
    updateTeamMode?: SuperTeamUpdateTeamMode;
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
    updateExtMode?: SuperTeamUpdateExtMode;
}
export interface AddSuperTeamMembersOptions {
    teamId: string;
    accounts: string[];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 附言，长度不得大于 5000，开发者可以使用 JSON 格式字符串填充
     * @locale
     *
     * @locale en
     * P.S., the length should not be greater than 5,000 bytes, developers can use JSON format string to fill it.
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
export interface RemoveSuperTeamMembersOptions {
    teamId: string;
    accounts: string[];
}
export interface ApplySuperTeamOptions {
    teamId: string;
    ps?: string;
}
export interface AddSuperTeamManagersOptions {
    teamId: string;
    accounts: string[];
}
export interface RemmoveSuperTeamManagersOptions {
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
     * 注: 修改此字段后, 所有其它在线的群成员会收到事件 {@link IMEventInterface.updateSuperTeamMember | updateSuperTeamMember} 。
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
export interface MuteSuperTeamMembersOptions {
    teamId: string;
    accounts: string[];
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
export interface GetSuperTeamMembersOptions {
    teamId: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 成员加入时间
     *
     * 获取在该时间之后/之前进群的群成员
     * @locale
     *
     * @locale en
     * Member’s joining time
     *
     * Get group members who joined the group after/before this time
     * @locale
     */
    joinTime?: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 本次获取的群成员数量。默认 100，最多 1000
     * @locale
     *
     * @locale en
     * The number of group members obtained this time (default: 100, maximum: 1,000)
     * @locale
     */
    limit?: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 排序规则，默认 false
     *
     * false - 获取 joinTime 之后进群的群成员，按时间升序排列
     *
     * true - 获取 joinTime 之前进群的群成员，按时间降序排列
     * @locale
     *
     * @locale en
     * Sorting rule, default: false
     *
     * false - get the group members who entered the group after joinTime in ascending order of time.
     *
     * true - get the group members who entered the group before joinTime in descending order of time.
     * @locale
     */
    reverse?: boolean;
}
export interface GetSuperTeamMembersByAccountsOptions {
    teamId: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 成员账号 id，最大 20 个
     * @locale
     *
     * @locale en
     * Member accounts, maximum: 20
     * @locale
     */
    accounts: string[];
}
export interface MuteSuperTeamOptions {
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
export interface PassSuperTeamApplyOptions {
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
export interface RejectSuperTeamApplyOptions {
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
export interface AcceptSuperTeamInviteOptions {
    teamId: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 邀请者的 accountId
     * @locale
     *
     * @locale en
     * Inviter’s accountId
     * @locale
     */
    from: string;
}
export interface RejectSuperTeamInviteOptions {
    teamId: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 邀请者的 accountId
     * @locale
     *
     * @locale en
     * Inviter’s accountId
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
export interface QueryMuteMembersOptions {
    teamId: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 分页大小，一页默认 100
     * @locale
     *
     * @locale en
     * Paging size, default: 100 per page
     * @locale
     */
    limit?: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 筛选条件：加入的时间。获取的成员是在加入时间之前/之后的若干条。
     * @locale
     *
     * @locale en
     * Filter condition: joining time. Filtered members are a number of entries before/after the joining time.
     * @locale
     */
    joinTime?: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 默认 false，获取在 joinTime 之后加入的群员。
     *
     * 若为 true，获取在 joinTime 之前的加入的群员
     * @locale
     *
     * @locale en
     * false (default): get the group members who joined the group after joinTime.
     *
     * true: get the group members who joined the group before joinTime.
     * @locale
     */
    reverse?: boolean;
}
