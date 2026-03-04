import { V2NIMPostscript } from './V2NIMFriendService';
import { V2NIMQueryDirection } from './V2NIMMessageService';
import type { NIMEBaseServiceClass, V2NIMAntispamConfig, V2NIMError } from './types';
/**
 * v2 群组模块
 *
 * 注: 使用 dist/esm 产物时，需要动态引入 V2NIMTeamService 后使用
 *
 * @example
 * ```
 * import { NIM, V2NIMTeamService } from 'nim-web-sdk-ng/dist/esm/nim'
 * NIM.registerService(V2NIMTeamService, 'V2NIMTeamService')
 * ```
 */
export declare class V2NIMTeamService extends NIMEBaseServiceClass<V2NIMTeamListener> {
    /**
     * 创建一个群组
     *
     * 注: 操作成功后, 触发事件的规则如下:
     * - 操作者端（群主）, SDK 抛出: {@link V2NIMTeamListener.onTeamCreated | V2NIMTeamListener.onTeamCreated}
     * - agreeMode 需要被邀请者同意
     *   - 被操作者端, SDK会抛出: {@link V2NIMTeamListener.onReceiveTeamJoinActionInfo | V2NIMTeamListener.onReceiveTeamJoinActionInfo}
     * - agreeMode 不需被邀请者同意
     *   - 被操作者端， SDK会抛出: {@link V2NIMTeamListener.onTeamJoined | V2NIMTeamListener.onTeamJoined}
     *   - 其他成员端， SDK会抛出: {@link V2NIMTeamListener.onTeamMemberJoined | V2NIMTeamListener.onTeamMemberJoined}
     *
     * @param createTeamParams 创建群组参数
     * @param invitorAccountIds 群组创建时，同时邀请加入群的成员列表
     * @param postscript 群组创建时，邀请入群的附言
     * @param antispamConfig 反垃圾参数. 如果开启了安全通，默认采用安全通，该配置不需要配置.
     *                       如果有审核需求，且直接对接易盾，则需要传入该配置
     *
     * @example
     * ```ts
     * await nim.V2NIMTeamService.createTeam({
     *   "name": "群名",
     *   "teamType": 1,
     *   "memberLimit": 200,
     * })
     * ```
     */
    createTeam(createTeamParams: V2NIMCreateTeamParams, inviteeAccountIds?: string[], postscript?: string, antispamConfig?: V2NIMAntispamConfig): Promise<V2NIMCreateTeamResult>;
    /**
     * 修改群组信息
     *
     * 注: 操作成功后, 触发事件的规则如下:
     * - 全员用户端，SDK会抛出: {@link V2NIMTeamListener.onTeamInfoUpdated | V2NIMTeamListener.onTeamInfoUpdated}
     *
     * @param teamId 群组id
     * @param teamType 群组类型
     * @param updateTeamInfoParams 更新群组信息参数
     * @param antispamConfig 反垃圾参数. 如果开启了安全通，默认采用安全通，该配置不需要配置.
     *                       如果有审核需求，且直接对接易盾，则需要传入该配置
     * @example
     * ```ts
     * await nim.V2NIMTeamService.updateTeamInfo(
     *   "123456",
     *   1,
     *   {
     *     "name": "群名1",
     *     "memberLimit": 200,
     *     "joinMode": 0,
     *     "agreeMode": 0,
     *     "inviteMode": 0,
     *     "updateInfoMode": 0,
     *     "updateExtensionMode": 0,
     *     "chatBannedMode": 0
     *   }
     * )
     * ```
     */
    updateTeamInfo(teamId: string, teamType: V2NIMTeamType, updateTeamInfoParams: V2NIMUpdateTeamInfoParams, antispamConfig?: V2NIMAntispamConfig): Promise<void>;
    /**
     * 退出群组
     *
     * 注: 操作成功后, 触发事件的规则如下:
     * - 操作者（自己本端），SDK会抛出: {@link V2NIMTeamListener.onTeamLeft | V2NIMTeamListener.onTeamLeft}
     * - 群内其它用户端， SDK会抛出: {@link V2NIMTeamListener.onTeamMemberLeft | V2NIMTeamListener.onTeamMemberLeft}
     *
     * @param teamId 群组id
     * @param teamType 群组类型
     * @example
     * ```ts
     * await nim.V2NIMTeamService.leaveTeam("123456", 1)
     * ```
     */
    leaveTeam(teamId: string, teamType: V2NIMTeamType): Promise<void>;
    /**
     * 获取群组信息
     *
     * @param teamId 群组id
     * @param teamType 群组类型
     * @example
     * ```ts
     * await nim.V2NIMTeamService.getTeamInfo("123456", 1)
     * ```
     */
    getTeamInfo(teamId: string, teamType: V2NIMTeamType): Promise<V2NIMTeam>;
    /**
     * 从云端获取群信息
     *
     * @param teamId 群组id
     * @param teamType 群组类型
     * @example
     * ```ts
     * await nim.V2NIMTeamService.getTeamInfoFromCloud("123456", 1)
     * ```
     */
    getTeamInfoFromCloud(teamId: string, teamType: V2NIMTeamType): Promise<V2NIMTeam>;
    /**
     * 获取当前已经加入的群组列表
     *
     * 注: 群组有效且自己在群中
     *
     * @param teamTypes 群类型列表. 若不传入这个字段, 代表这个过滤条件不生效, 则查询所有群类型
     * @example
     * ```ts
     * await nim.V2NIMTeamService.getJoinedTeamList([1])
     * ```
     */
    getJoinedTeamList(teamTypes?: V2NIMTeamType[]): Promise<V2NIMTeam[]>;
    /**
     * 获取当前自己为群主的群组列表
     *
     * 注: 群组有效且自己在群中，返回群组按群组创建时间升序排序
     *
     * @param teamTypes 群类型列表. 若不传入这个字段, 代表这个过滤条件不生效, 则查询所有群类型
     * @example
     * ```ts
     * await nim.V2NIMTeamService.getOwnerTeamList([1])
     * ```
     */
    getOwnerTeamList(teamTypes?: V2NIMTeamType[]): Promise<V2NIMTeam[]>;
    /**
     * 获取当前自己为管理员的群组列表（包括自己是群主的群）
     *
     * 注: 群组有效且自己在群中，返回群组按群组创建时间升序排序
     *
     * @param teamTypes 群类型列表. 若不传入这个字段, 代表这个过滤条件不生效, 则查询所有群类型
     * @example
     * ```ts
     * await nim.V2NIMTeamService.getManagerTeamList([1])
     * ```
     */
    getManagerTeamList(teamTypes?: V2NIMTeamType[]): Promise<V2NIMTeam[]>;
    /**
     * 获取当前已经加入的群组数量
     *
     * 注: 群组有效且自己在群中
     *
     * @param teamTypes 群类型列表. 若不传入这个字段, 代表这个过滤条件不生效, 则查询所有群类型
     * @example
     * ```ts
     * nim.V2NIMTeamService.getJoinedTeamCount([1])
     * ```
     */
    getJoinedTeamCount(teamTypes?: V2NIMTeamType[]): number;
    /**
     * 获取自己所有加入的群的群成员信息
     *
     * @param teamTypes 群类型列表. 若不传入这个字段, 代表这个过滤条件不生效, 则查询所有群类型
     * @example
     * ```ts
     * await nim.V2NIMTeamService.getJoinedTeamMembers([1])
     * ```
     */
    getJoinedTeamMembers(teamTypes?: V2NIMTeamType[]): Promise<V2NIMTeamMember[]>;
    /**
     * 根据群组ID获取群组信息
     *
     * 每次最多100个群组ID. 先查本地数据，本地缺失再查询云端
     *
     * @param teamIds 群组ID列表
     * @param teamType 群组类型
     * @example
     * ```ts
     * await nim.V2NIMTeamService.getTeamInfoByIds(["123456"], 1)
     * ```
     */
    getTeamInfoByIds(teamIds: string[], teamType: V2NIMTeamType): Promise<V2NIMTeam[]>;
    /**
     * 解散群组
     *
     * 注: 操作成功后, 触发事件的规则如下:
     * - 全员, SDK会抛出: {@link V2NIMTeamListener.onTeamDismissed | V2NIMTeamListener.onTeamDismissed}
     *
     * @param teamId 群组id
     * @param teamType 群组类型
     * ```ts
     * await nim.V2NIMTeamService.dismissTeam("123456", 1)
     * ```
     */
    dismissTeam(teamId: string, teamType: V2NIMTeamType): Promise<void>;
    /**
     * 邀请成员加入群
     *
     * 注: 操作成功后, 触发事件的规则如下:
     * - agreeMode 需要被邀请者同意
     *   - 被操作者端， SDK会抛出: {@link V2NIMTeamListener.onReceiveTeamJoinActionInfo | V2NIMTeamListener.onReceiveTeamJoinActionInfo}
     * - agreeMode 不需要被邀请者同意
     *   - 被操作者端， SDK会抛出: {@link V2NIMTeamListener.onTeamJoined | V2NIMTeamListener.onTeamJoined}
     *   - 其他成员端， SDK会抛出: {@link V2NIMTeamListener.onTeamMemberJoined | V2NIMTeamListener.onTeamMemberJoined}
     *
     * @param teamId 群组id
     * @param teamType 群组类型
     * @param inviteeAccountIds 邀请加入群的成员账号列表
     * @param postscript 邀请入群的附言
     * @returns 邀请失败的账号列表
     * @example
     * ```ts
     * await nim.V2NIMTeamService.inviteMember("123456", 1, ["accountId1"])
     * ```
     */
    inviteMember(teamId: string, teamType: V2NIMTeamType, inviteeAccountIds: string[], postscript?: string): Promise<string[]>;
    /**
     * 新的邀请成员加入群
     *
     * 注: 操作成功后, 触发事件的规则如下:
     * - agreeMode 需要被邀请者同意
     *   - 被操作者端， SDK会抛出: {@link V2NIMTeamListener.onReceiveTeamJoinActionInfo | V2NIMTeamListener.onReceiveTeamJoinActionInfo}
     * - agreeMode 不需要被邀请者同意
     *   - 被操作者端， SDK会抛出: {@link V2NIMTeamListener.onTeamJoined | V2NIMTeamListener.onTeamJoined}
     *   - 其他成员端， SDK会抛出: {@link V2NIMTeamListener.onTeamMemberJoined | V2NIMTeamListener.onTeamMemberJoined}
     *
     * @param teamId 群组id
     * @param teamType 群组类型
     * @param inviteeParams 邀请入群的信息
     * @returns 邀请失败的账号列表
     * @example
     * ```ts
     * await nim.V2NIMTeamService.inviteMemberEx("123456", 1, { inviteeAccountIds: ["accountId1"] })
     * ```
     */
    inviteMemberEx(teamId: string, teamType: V2NIMTeamType, inviteeParams: V2NIMTeamInviteParams): Promise<string[]>;
    /**
     * 接受邀请入群
     *
     * 注: 操作成功后, 触发事件的规则如下:
     * - 操作者（既接受邀请用户）端， SDK会抛出: {@link V2NIMTeamListener.onTeamJoined | V2NIMTeamListener.onTeamJoined}
     * - 其他成员端， SDK会抛出: {@link V2NIMTeamListener.onTeamMemberJoined | V2NIMTeamListener.onTeamMemberJoined}
     *
     * @param invitationInfo 邀请入群的信息
     * @example
     * ```ts
     * await nim.V2NIMTeamService.acceptInvitation(
     *   {
     *     "teamId": "123456",
     *     "teamType": 1,
     *     "operatorAccountId": "accountId1",
     *     "actionType": 2
     *   }
     * )
     * ```
     */
    acceptInvitation(invitationInfo: V2NIMTeamJoinActionInfo): Promise<V2NIMTeam>;
    /**
     * 拒绝邀请入群
     *
     * 注: 操作成功后, 触发事件的规则如下:
     * - 群主或管理员端， SDK会抛出: {@link V2NIMTeamListener.onReceiveTeamJoinActionInfo | V2NIMTeamListener.onReceiveTeamJoinActionInfo}‘
     *
     * @param invitationInfo 邀请入群的信息
     * @example
     * ```ts
     * await nim.V2NIMTeamService.rejectInvitation(
     *   {
     *     "teamId": "123456",
     *     "teamType": 1,
     *     "operatorAccountId": "accountId1",
     *     "actionType": 2
     *   },
     *   "test postscript"
     * )
     * ```
     */
    rejectInvitation(invitationInfo: V2NIMTeamJoinActionInfo, postscript?: string): Promise<void>;
    /**
     * 踢出群组成员
     *
     * 注1: 只有群主和群管理员有权限操作改接口
     *
     * 注2: 操作成功后, 触发事件的规则如下:
     * - 被操作者（既被踢用户），SDK会抛出: {@link V2NIMTeamListener.onTeamLeft | V2NIMTeamListener.onTeamLeft}
     * - 其他成员端，SDK会抛出: {@link V2NIMTeamListener.onTeamMemberKicked | V2NIMTeamListener.onTeamMemberKicked}
     *
     * @param teamId 群组id
     * @param teamType 群组类型
     * @param memberAccountIds 踢出群组的成员账号列表
     * @example
     * ```ts
     * await nim.V2NIMTeamService.kickMember("123456", 1, ["accountId1"])
     * ```
     */
    kickMember(teamId: string, teamType: V2NIMTeamType, memberAccountIds: string[]): Promise<void>;
    /**
     * (用户)申请加入群组
     *
     * 注: 操作成功后, 触发事件的规则如下:
     * - joinMode 自由加入
     *   - 操作者端，SDK 会抛出: {@link V2NIMTeamListener.onTeamJoined | V2NIMTeamListener.onTeamJoined}
     *   - 其他成员端， SDK 会抛出: {@link V2NIMTeamListener.onTeamMemberJoined | V2NIMTeamListener.onTeamMemberJoined}
     * - joinMode 群主管理员同意
     *   - 群主或管理员端，SDK 会抛出 {@link V2NIMTeamListener.onReceiveTeamJoinActionInfo | V2NIMTeamListener.onReceiveTeamJoinActionInfo}
     *
     * @param teamId 群组id
     * @param teamType 群组类型
     * @param postscript 申请附言
     * @returns 对应的群信息
     * @example
     * ```ts
     * await nim.V2NIMTeamService.applyJoinTeam("123456", 1, "test postscript")
     * ```
     */
    applyJoinTeam(teamId: string, teamType: V2NIMTeamType, postscript?: string): Promise<V2NIMTeam>;
    /**
     * (管理员)接受(用户的)入群申请
     *
     * 注: 操作成功后, 触发事件的规则如下:
     * - 被操作者（既被同意用户），SDK会抛出: {@link V2NIMTeamListener.onTeamJoined | V2NIMTeamListener.onTeamJoined}
     * - 其他成员， SDK会抛出: {@link V2NIMTeamListener.onTeamMemberJoined | V2NIMTeamListener.onTeamMemberJoined}
     *
     * @param applicationInfo 该申请的相关信息
     * @example
     * ```ts
     * await nim.V2NIMTeamService.acceptJoinApplication(
     *   {
     *     "teamId": "123456",
     *     "teamType": 1,
     *     "operatorAccountId": "accountId1",
     *     "actionType": 0
     *   }
     * )
     * ```
     */
    acceptJoinApplication(applicationInfo: V2NIMTeamJoinActionInfo): Promise<void>;
    /**
     * (管理员)拒绝(用户的)入群申请
     *
     * 注: 操作成功后, 触发事件的规则如下:
     * - 被操作用户（既被拒绝用户）， SDK会抛出: {@link V2NIMTeamListener.onReceiveTeamJoinActionInfo | V2NIMTeamListener.onReceiveTeamJoinActionInfo}
     *
     * @param applicationInfo 该申请的相关信息
     * @example
     * ```ts
     * await nim.V2NIMTeamService.rejectJoinApplication(
     *   {
     *     "teamId": "123456",
     *     "teamType": 1,
     *     "operatorAccountId": "accountId1",
     *     "actionType": 0
     *   },
     *   "test postscript"
     * )
     * ```
     */
    rejectJoinApplication(applicationInfo: V2NIMTeamJoinActionInfo, postscript?: string): Promise<void>;
    /**
     * 设置成员角色
     *
     * 注1: 本操作只有群主可操作, 且只能在普通成员与管理员直接角色切换, 如果成员设置角色与当前角色一致，默认请求成功
     *
     * 注2: 操作成功后, 触发事件的规则如下:
     * - 所有成员，SDK会抛出: @link V2NIMTeamListener.onTeamMemberInfoUpdated | V2NIMTeamListener.onTeamMemberInfoUpdated}
     *
     * @param teamId 群组id
     * @param teamType 群组类型
     * @param memberAccountIds 待操作的群组的成员账号列表
     * @param memberRole 新的角色类型
     * @example
     * ```ts
     * await nim.V2NIMTeamService.updateTeamMemberRole("123456", 1, ["accountId1"], 0)
     * ```
     */
    updateTeamMemberRole(teamId: string, teamType: V2NIMTeamType, memberAccountIds: string[], memberRole: V2NIMTeamMemberRole): Promise<void>;
    /**
     * 移交群主
     *
     * 注1: 本操作只有群主可操作
     *
     * 注2: 操作成功后, 触发事件的规则如下:
     * - 所有成员，SDK会抛出: {@link V2NIMTeamListener.onTeamInfoUpdated | V2NIMTeamListener.onTeamInfoUpdated}‘
     * - 若入参 leave 为 true:
     *   - 操作者， SDK会抛出:onTeamLeft
     *   - 其它成员， SDK会抛出:onTeamMemberLeft
     *
     * @param teamId 群组id
     * @param teamType 群组类型
     * @param accountId 新群主的账号 ID
     * @param leave 转让群主后, 操作者是否同时退出该群. 默认为 false
     * @returns 该操作的时间戳
     * @example
     * ```ts
     * await nim.V2NIMTeamService.transferTeamOwner("123456", 1, "accountId1", true)
     * ```
     */
    transferTeamOwner(teamId: string, teamType: V2NIMTeamType, accountId: string, leave?: boolean): Promise<void>;
    /**
     * 修改自己的群成员信息
     *
     * 注: 操作成功后, 触发事件的规则如下:
     * - 所有成员， SDK会抛出: {@link V2NIMTeamListener.onTeamMemberInfoUpdated | V2NIMTeamListener.onTeamMemberInfoUpdated}
     *
     * @param teamId 群组id
     * @param teamType 群组类型
     * @param memberInfoParams 被修改的字段
     * @example
     * ```ts
     * await nim.V2NIMTeamService.updateSelfTeamMemberInfo("123456", 1, {
     *   "teamNick": "test nick"
     * })
     * ```
     */
    updateSelfTeamMemberInfo(teamId: string, teamType: V2NIMTeamType, memberInfoParams: V2NIMUpdateSelfMemberInfoParams): Promise<void>;
    /**
     * 修改群成员昵称
     *
     * 注: 只有群主和管理员拥有此权限可操作
     *
     * 注: 操作成功后, 触发事件的规则如下:
     * - 所有成员，SDK会抛出: {@link V2NIMTeamListener.onTeamMemberInfoUpdated | V2NIMTeamListener.onTeamMemberInfoUpdated}
     *
     * @param teamId 群组id
     * @param teamType 群组类型
     * @param accountId 新群主的账号 ID
     * @param nick 昵称
     * @example
     * ```ts
     * await nim.V2NIMTeamService.updateTeamMemberNick("123456", 1, "accountId1", "test nick")
     * ```
     */
    updateTeamMemberNick(teamId: string, teamType: V2NIMTeamType, accountId: string, nick: string): Promise<void>;
    /**
     * 修改群成员昵称-附加审核参数. v10.9.30+ 支持
     *
     * 注: 只有群主和管理员拥有此权限可操作
     *
     * 注: 操作成功后, 触发事件的规则如下:
     * - 所有成员，SDK会抛出: {@link V2NIMTeamListener.onTeamMemberInfoUpdated | V2NIMTeamListener.onTeamMemberInfoUpdated}
     *
     * @param teamId 群组id
     * @param teamType 群组类型
     * @param nickParams 修改昵称相关参数
     */
    updateTeamMemberNickEx(teamId: string, teamType: V2NIMTeamType, nickParams: V2NIMUpdateMemberNickParams): Promise<void>;
    /**
     * 设置群组禁言模式
     *
     * 注: 操作成功后, 触发事件的规则如下:
     * - 所有成员，SDK会抛出: {@link V2NIMTeamListener.onTeamInfoUpdated | V2NIMTeamListener.onTeamInfoUpdated}
     *
     * @param teamId 群组id
     * @param teamType 群组类型
     * @param chatBannedMode 禁言模式
     * @example
     * ```ts
     * await nim.V2NIMTeamService.setTeamChatBannedMode("123456", 1, 1)
     * ```
     */
    setTeamChatBannedMode(teamId: string, teamType: V2NIMTeamType, chatBannedMode: V2NIMTeamChatBannedMode): Promise<void>;
    /**
     * 设置群组成员聊天禁言状态
     *
     * 注: 操作成功后, 触发事件的规则如下:
     * - 所有成员， SDK会抛出: {@link V2NIMTeamListener.onTeamMemberInfoUpdated | V2NIMTeamListener.onTeamMemberInfoUpdated}
     *
     * @param teamId 群组id
     * @param teamType 群组类型
     * @param accountId 被修改成员的账号
     * @param chatBanned 群组中聊天是否被禁言
     * @example
     * ```ts
     * // Ban someone
     * await nim.V2NIMTeamService.setTeamMemberChatBannedStatus("123456", 1, "accountId1", true)
     * ```
     */
    setTeamMemberChatBannedStatus(teamId: string, teamType: V2NIMTeamType, accountId: string, chatBanned: boolean): Promise<void>;
    /**
     * 获取群成员列表
     *
     * @param teamId 群组id
     * @param teamType 群组类型
     * @param memberRoles 成员角色
     * @returns 查询结果
     * @example
     * ```ts
     * await nim.V2NIMTeamService.getTeamMemberList(
     *   "123456",
     *   1,
     *   {
     *     "roleQueryType": 0,
     *     "onlyChatBanned": false,
     *     "direction": 0,
     *     "limit": 100,
     *     "nextToken": ""
     *   }
     * )
     * ```
     */
    getTeamMemberList(teamId: string, teamType: V2NIMTeamType, queryOption: V2NIMTeamMemberQueryOption): Promise<V2NIMTeamMemberListResult>;
    /**
     * 根据账号 ID 列表获取群组成员列表
     *
     * @param teamId 群组id
     * @param teamType 群组类型
     * @param accountIds 成员的账号 ID 列表. 一批传入最多支持 100 个.
     * @returns 成员列表
     * @example
     * ```ts
     * await nim.V2NIMTeamService.getTeamMemberListByIds("123456", 1, ["accountId1"])
     * ```
     */
    getTeamMemberListByIds(teamId: string, teamType: V2NIMTeamType, accountIds: string[]): Promise<V2NIMTeamMember[]>;
    /**
     * 根据账号 ID 列表获取群组成员邀请人
     *
     * @param teamId 群组id
     * @param teamType 群组类型
     * @param accountIds 成员的账号 ID 列表
     * @returns 邀请人信息列表, key: accountId, value: invitorAccountId
     * @example
     * ```ts
     * await nim.V2NIMTeamService.getTeamMemberInvitor("123456", 1, ["accountId1"])
     * ```
     */
    getTeamMemberInvitor(teamId: string, teamType: V2NIMTeamType, accountIds: string[]): Promise<{
        [accountId: string]: string;
    }>;
    /**
     * 获取群加入相关信息
     *
     * @param option 查询参数
     * @example
     * ```ts
     * await nim.V2NIMTeamService.getTeamJoinActionInfoList(
     *   {
     *     "offset": 0,
     *     "limit": 50
     *   }
     * )
     * ```
     */
    getTeamJoinActionInfoList(option: V2NIMTeamJoinActionInfoQueryOption): Promise<V2NIMTeamJoinActionInfoResult>;
    /**
     * 清空所有群申请
     */
    clearAllTeamJoinActionInfo(): Promise<void>;
    /**
     * 清空群申请-附加条件.
     */
    clearAllTeamJoinActionInfoEx(option: V2NIMTeamClearJoinActionInfoOption): Promise<void>;
    /**
     * 删除群申请
     *
     * 注: 会删除相同群的, 且相同申请者的所有申请记录
     *
     * @param applicationInfo 群申请记录
     */
    deleteTeamJoinActionInfo(applicationInfo: V2NIMTeamJoinActionInfo): Promise<void>;
    /**
     * 设置群申请/邀请动作为已读. v10.9.20+ 支持
     *
     * @param application 群申请的相关信息. 若不传代表将所有申请设置为已读.
     */
    setTeamJoinActionInfoRead(applicationInfo?: V2NIMTeamJoinActionInfo): Promise<void>;
    /**
     * 获取未读的群申请/邀请动作的数量. v10.9.20+ 支持
     */
    getTeamJoinActionInfoUnreadCount(): Promise<number>;
    /**
     * 根据关键字搜索群信息
     *  - 混合搜索高级群和超大群，like匹配
     *  - 只搜索群名称
     */
    searchTeamByKeyword(keyword: string): Promise<V2NIMTeam[]>;
    /**
     * 添加特别关注群成员列表
     *
     * @param teamId 群组id
     * @param teamType 群组类型
     * @param accountIds 特别关注的群成员 accountId 列表
     */
    addTeamMembersFollow(teamId: string, teamType: V2NIMTeamType, accountIds: Array<string>): Promise<void>;
    /**
     * 移除特别关注群成员列表
     *
     * @param teamId 群组id
     * @param teamType 群组类型
     * @param accountIds 特别关注的群成员 accountId 列表
     */
    removeTeamMembersFollow(teamId: string, teamType: V2NIMTeamType, accountIds: Array<string>): Promise<void>;
}
export declare type V2NIMTeamClearJoinActionInfoOption = {
    /**
     * 时间戳. 默认当前时间戳，会删除这个时间之前的所有记录
     */
    timestamp?: number;
    /**
     * 群类型. 默认删全部
     */
    type?: V2NIMTeamJoinActionTeamType;
};
export declare enum V2NIMTeamJoinActionTeamType {
    /**
     * 高级群
     */
    V2NIM_TEAM_JOIN_ACTION_TEAM_TYPE_NORMAL = 1,
    /**
     * 超大群
     */
    V2NIM_TEAM_JOIN_ACTION_TEAM_TYPE_SUPER = 2,
    /**
     * 所有
     */
    V2NIM_TEAM_JOIN_ACTION_TEAM_TYPE_ALL = 3
}
export declare type V2NIMUpdateMemberNickParams = {
    /**
     * 被修改成员的账号
     */
    accountId: string;
    /**
     * 被修改成员新的昵称
     *
     * 注: 可以传入空串”“
     */
    teamNick: string;
    /**
     * 安全通配置
     *
     * 注: 针对群昵称进行内容反垃圾检测. 如果不审核，该配置不需要配置
     */
    antispamConfig?: V2NIMAntispamConfig;
};
export declare type V2NIMTeamMemberListResult = {
    /**
     * 是否还有下一页
     */
    finished: boolean;
    /**
     * 下一页查询的偏移量.
     */
    nextToken: string;
    /**
     * 成员列表
     */
    memberList: V2NIMTeamMember[];
};
export declare const enum V2NIMTeamMemberRoleQueryType {
    /**
     * 所有成员
     */
    V2NIM_TEAM_MEMBER_ROLE_QUERY_TYPE_ALL = 0,
    /**
     * 普通成员
     */
    V2NIM_TEAM_MEMBER_ROLE_QUERY_TYPE_NORMAL = 1,
    /**
     * 群组管理员(包括群主)
     */
    V2NIM_TEAM_MEMBER_ROLE_QUERY_TYPE_MANAGER = 2
}
/**
 * 群组成员列表
 */
export declare type V2NIMTeamMemberQueryOption = {
    /**
     * 成员角色列表, 作为过滤条件
     */
    roleQueryType: V2NIMTeamMemberRoleQueryType;
    /**
     * 是否只返回聊天禁言成员列表. 默认值 false
     */
    onlyChatBanned?: boolean;
    /**
     * 消息查询方向
     *
     * 默认值 {@link V2NIMQueryDirection.V2NIM_QUERY_DIRECTION_DESC | V2NIMQueryDirection.V2NIM_QUERY_DIRECTION_DESC}
     */
    direction?: V2NIMQueryDirection;
    /**
     * 一页数量限制
     */
    limit?: number;
    /**
     * 分页偏移量
     *
     * 注: 第一页允许传空字符串
     */
    nextToken?: string;
};
export declare type V2NIMUpdateSelfMemberInfoParams = {
    /**
     * 群昵称
     *
     * 注: 不能为空字符串 ""
     */
    teamNick?: string;
    /**
     * 群成员扩展字段
     */
    serverExtension?: string;
    /**
     * 安全通配置
     *
     * 注: 针对群昵称进行内容反垃圾检测. 如果不审核，该配置不需要配置
     */
    antispamConfig?: V2NIMAntispamConfig;
};
/**
 * 修改群组信息参数
 */
export declare type V2NIMUpdateTeamInfoParams = {
    /**
     * 群组名称
     */
    name?: string;
    /**
     * 群组人数上限.
     *
     * 注: 只允许群主和管理员修改这个属性.
     */
    memberLimit?: number;
    /**
     * 群组介绍. 上限 255 个字符
     */
    intro?: string;
    /**
     * 群组公告. 上限 5000 个字符
     */
    announcement?: string;
    /**
     * 群组头像
     */
    avatar?: string;
    /**
     * 扩展字段
     */
    serverExtension?: string;
    /**
     * 申请入群模式. 即入群验证方式
     *
     * 注: 只允许群主和管理员修改这个属性.
     */
    joinMode?: V2NIMTeamJoinMode;
    /**
     * 被邀请人入群模式. 即被邀请人的同意方式
     *
     * 注: 只允许群主和管理员修改这个属性.
     */
    agreeMode?: V2NIMTeamAgreeMode;
    /**
     * 群组邀请模式. 即谁可以邀请他人入群
     *
     * 注: 只允许群主和管理员修改这个属性.
     */
    inviteMode?: V2NIMTeamInviteMode;
    /**
     * 群组资料修改模式. 即谁可以修改群组资料
     *
     * 注: 只允许群主和管理员修改这个属性.
     *
     * 注2: 此属性允许普通群成员能修改的参数有: name, avatar, announcement, intro
     */
    updateInfoMode?: V2NIMTeamUpdateInfoMode;
    /**
     * 群组扩展字段修改模式. 即谁可以修改群组扩展
     *
     * 注: 只允许群主和管理员修改这个属性.
     *
     * 注2: 此属性允许普通群成员能修改的参数有: serverExtension
     */
    updateExtensionMode?: V2NIMTeamUpdateExtensionMode;
    /**
     * 群组禁言状态
     *
     * 注: 只允许群主和管理员修改这个属性.
     */
    chatBannedMode?: V2NIMTeamChatBannedMode;
};
/**
 * 创建群组返回结果
 */
export declare type V2NIMCreateTeamResult = {
    /**
     * 创建成功的群组对象
     */
    team: V2NIMTeam;
    /**
     * 创建群组时，邀请进入群组的失败成员列表
     */
    failedList: string[];
};
export declare type V2NIMCreateTeamParams = {
    /**
     * 群组名称
     */
    name: string;
    /**
     * 群组类型
     *
     * 注: 只能选择高级群或者超大群
     */
    teamType: V2NIMTeamType;
    /**
     * 群组人数上限. 默认 200
     */
    memberLimit?: number;
    /**
     * 群组介绍. 上限 255 个字符
     */
    intro?: string;
    /**
     * 群组公告. 上限 5000 个字符
     */
    announcement?: string;
    /**
     * 群组头像
     */
    avatar?: string;
    /**
     * 扩展字段
     */
    serverExtension?: string;
    /**
     * 申请入群模式. 即入群验证方式
     *
     * 默认值: {@link V2NIMTeamJoinMode.V2NIM_TEAM_JOIN_MODE_FREE | V2NIMTeamJoinMode.V2NIM_TEAM_JOIN_MODE_FREE}
     */
    joinMode?: V2NIMTeamJoinMode;
    /**
     * 被邀请人入群模式. 即被邀请人的同意方式
     *
     * 默认值: {@link V2NIMTeamAgreeMode.V2NIM_TEAM_AGREE_MODE_AUTH | V2NIMTeamAgreeMode.V2NIM_TEAM_AGREE_MODE_AUTH}
     */
    agreeMode?: V2NIMTeamAgreeMode;
    /**
     * 群组邀请模式. 即谁可以邀请他人入群
     *
     * 默认值: {@link V2NIMTeamInviteMode.V2NIM_TEAM_INVITE_MODE_MANAGER | V2NIMTeamInviteMode.V2NIM_TEAM_INVITE_MODE_MANAGER}
     */
    inviteMode?: V2NIMTeamInviteMode;
    /**
     * 群组资料修改模式. 即谁可以修改群组资料
     *
     * 默认值: {@link V2NIMTeamUpdateInfoMode.V2NIM_TEAM_UPDATE_INFO_MODE_MANAGER | V2NIMTeamUpdateInfoMode.V2NIM_TEAM_UPDATE_INFO_MODE_MANAGER}
     */
    updateInfoMode?: V2NIMTeamUpdateInfoMode;
    /**
     * 群组扩展字段修改模式. 即谁可以修改群组扩展
     *
     * 默认值: {@link V2NIMTeamUpdateExtensionMode.V2NIM_TEAM_UPDATE_EXTENSION_MODE_MANAGER | V2NIMTeamUpdateExtensionMode.V2NIM_TEAM_UPDATE_EXTENSION_MODE_MANAGER}
     */
    updateExtensionMode?: V2NIMTeamUpdateExtensionMode;
    /**
     * 群禁言状态
     *
     * 默认值: {@link V2NIMTeamChatBannedMode.V2NIM_TEAM_CHAT_BANNED_MODE_UNBAN | V2NIMTeamChatBannedMode.V2NIM_TEAM_CHAT_BANNED_MODE_UNBAN}
     */
    chatBannedMode?: V2NIMTeamChatBannedMode;
};
/**
 * 群组类型定义
 */
export declare const enum V2NIMTeamType {
    /**
     * @deprecated
     * 讨论组
     *
     * 注: 讨论组功能不再维护, 出于兼容目的考虑, 给讨论组保留这个定义。
     */
    V2NIM_TEAM_TYPE_INVALID = 0,
    /**
     * 高级群
     */
    V2NIM_TEAM_TYPE_ADVANCED = 1,
    /**
     * 超大群
     */
    V2NIM_TEAM_TYPE_SUPER = 2
}
/**
 * (用户)申请入群的模式定义
 */
export declare const enum V2NIMTeamJoinMode {
    /**
     * 自由加入. 无须验证
     */
    V2NIM_TEAM_JOIN_MODE_FREE = 0,
    /**
     * 需申请. 群主或管理同意后加入
     */
    V2NIM_TEAM_JOIN_MODE_APPLY = 1,
    /**
     * 不接受申请. 私有群, 仅能通过邀请方式入群
     */
    V2NIM_TEAM_JOIN_MODE_INVITE = 2
}
/**
 * (管理员)邀请入群时是否需要被邀请人(用户)的同意模式定义
 */
export declare const enum V2NIMTeamAgreeMode {
    /**
     * 需要被邀请方同意
     */
    V2NIM_TEAM_AGREE_MODE_AUTH = 0,
    /**
     * 不需要被邀请人同意
     */
    V2NIM_TEAM_AGREE_MODE_NO_AUTH = 1
}
/**
 * 群组邀请模式定义
 */
export declare const enum V2NIMTeamInviteMode {
    /**
     * 群主，管理员可以邀请其他人入群
     */
    V2NIM_TEAM_INVITE_MODE_MANAGER = 0,
    /**
     * 所有人都可以邀请其他人入群
     */
    V2NIM_TEAM_INVITE_MODE_ALL = 1
}
/**
 * 群组资料修改模式
 */
export declare const enum V2NIMTeamUpdateInfoMode {
    /**
     * 群主, 管理员可以修改群组资料
     */
    V2NIM_TEAM_UPDATE_INFO_MODE_MANAGER = 0,
    /**
     * 所有人均可以修改群组资料
     */
    V2NIM_TEAM_UPDATE_INFO_MODE_ALL = 1
}
/**
 * 群组禁言模式类型定义
 */
export declare const enum V2NIMTeamChatBannedMode {
    /**
     * 不禁言. 群组成员可以自由发言
     */
    V2NIM_TEAM_CHAT_BANNED_MODE_UNBAN = 0,
    /**
     * 普通成员禁言. 但不包括管理员, 群主.
     */
    V2NIM_TEAM_CHAT_BANNED_MODE_BANNED_NORMAL = 1,
    /**
     * 全员禁言，群组所有成员都被禁言.
     *
     * 注: 该状态只能 OpenApi 发起, 而 SDK 不允许主动设置这个状态
     */
    V2NIM_TEAM_CHAT_BANNED_MODE_BANNED_ALL = 3
}
/**
 * 群组扩展字段修改模式
 */
export declare const enum V2NIMTeamUpdateExtensionMode {
    /**
     * 群主/管理员可以修改群组扩展字段
     */
    V2NIM_TEAM_UPDATE_EXTENSION_MODE_MANAGER = 0,
    /**
     * 所有人均可以修改群组扩展字段
     */
    V2NIM_TEAM_UPDATE_EXTENSION_MODE_ALL = 1
}
/**
 * 邀请入群的参数
 */
export declare type V2NIMTeamInviteParams = {
    /**
     * 邀请入群的账号 ID 列表
     */
    inviteeAccountIds: string[];
    /**
     * 附言
     */
    postscript?: string;
    /**
     * 扩展字段，仅支持普通群
     */
    serverExtension?: string;
};
/**
 * 群组定义
 */
export declare type V2NIMTeam = {
    /**
     * 群组ID
     */
    teamId: string;
    /**
     * 群组类型
     */
    teamType: V2NIMTeamType;
    /**
     * 群组名称
     */
    name: string;
    /**
     * 群组拥有者的账号 ID
     */
    ownerAccountId: string;
    /**
     * 群组人数上限
     */
    memberLimit: number;
    /**
     * 群组当前人数
     */
    memberCount: number;
    /**
     * 群组创建时间
     */
    createTime: number;
    /**
     * 群组更新时间
     */
    updateTime: number;
    /**
     * 群组介绍. 上限 255 个字符
     */
    intro: string;
    /**
     * 群组公告. 上限 5000 个字符
     */
    announcement: string;
    /**
     * 头像
     */
    avatar: string;
    /**
     * 扩展字段
     */
    serverExtension?: string;
    /**
     * 客户自定义扩展
     *
     * 注: 这个字段仅由 openApi 发请求设置. 而 SDK 只是透传这个字段.
     */
    customerExtension?: string;
    /**
     * 申请入群模式. 即入群验证方式
     */
    joinMode: V2NIMTeamJoinMode;
    /**
     * 被邀请人入群模式. 即被邀请人的同意方式
     */
    agreeMode: V2NIMTeamAgreeMode;
    /**
     * 群组邀请模式. 即谁可以邀请他人入群
     */
    inviteMode: V2NIMTeamInviteMode;
    /**
     * 群组资料修改模式. 即谁可以修改群组资料
     */
    updateInfoMode: V2NIMTeamUpdateInfoMode;
    /**
     * 群组扩展字段修改模式. 即谁可以修改群组扩展
     */
    updateExtensionMode: V2NIMTeamUpdateExtensionMode;
    /**
     * 群禁言状态
     */
    chatBannedMode: V2NIMTeamChatBannedMode;
    /**
     * 是否有效群
     */
    isTeamEffective: boolean;
    /**
     * @computed
     *
     * 是否自己所在的有效的群.
     *
     * 注: 为 true 的条件是此群存在且本账号已加入此群
     */
    isValidTeam: boolean;
};
/**
 * 群组成员角色类型定义
 */
export declare const enum V2NIMTeamMemberRole {
    /**
     * 普通成员
     */
    V2NIM_TEAM_MEMBER_ROLE_NORMAL = 0,
    /**
     * 群组拥有者
     */
    V2NIM_TEAM_MEMBER_ROLE_OWNER = 1,
    /**
     * 群组管理员
     */
    V2NIM_TEAM_MEMBER_ROLE_MANAGER = 2
}
/**
 * 群组成员属性定义
 */
export declare type V2NIMTeamMember = {
    /**
     * 群组 ID
     */
    teamId: string;
    /**
     * 群类型
     */
    teamType: V2NIMTeamType;
    /**
     * 群组成员账号 ID
     */
    accountId: string;
    /**
     * 群组成员类型
     */
    memberRole: V2NIMTeamMemberRole;
    /**
     * 群组昵称
     */
    teamNick?: string;
    /**
     * 内部使用字段, 主要用来设置群消息提醒
     * CLOSE_NOTIFY = 1L << 0; // 关闭消息提醒
     * ONLY_MANAGER_NOTIFY = 1L << 1; // 只对群管理员下发消息的提醒
     * 关联到群的消息提醒字段上。
     */
    /**
     * 扩展字段
     */
    serverExtension?: string;
    /**
     * 入群时间
     */
    joinTime: number;
    /**
     * 更新时间
     */
    updateTime?: number;
    /**
     * 入群邀请人. 若主动入群该字段为空
     */
    /**
     * 是否在群中
     */
    inTeam: boolean;
    /**
     * 聊天是否被禁言. 默认 false
     */
    chatBanned?: boolean;
    /**
     * 特别关注群成员列表
     */
    followAccountIds?: Array<string>;
};
/**
 * 群组监听回调
 *
 * 注: 使用 dist/esm 产物时，需要动态引入 V2NIMTeamService 后使用
 *
 * @example
 * ```
 * import { NIM, V2NIMTeamService } from 'nim-web-sdk-ng/dist/esm/nim'
 * NIM.registerService(V2NIMTeamService, 'V2NIMTeamService')
 * ```
 *
 * 监听器使用示例:
 *
 * @example
 * ```ts
 * nim.V2NIMTeamService.on('onSyncStarted', () => { console.log("recv onSyncStarted") })
 * nim.V2NIMTeamService.on('onSyncFinished', () => { console.log("recv onSyncFinished") })
 * nim.V2NIMTeamService.on('onSyncFailed', (error) => { console.log("recv onSyncFailed", error) })
 * nim.V2NIMTeamService.on('onTeamCreated', (team) => { console.log("recv onTeamCreated", team) })
 * nim.V2NIMTeamService.on('onTeamJoined', (team) => { console.log("recv onTeamJoined", team) })
 * nim.V2NIMTeamService.on('onTeamLeft', (team, isKicked) => { console.log("recv onTeamLeft", team, isKicked) })
 * nim.V2NIMTeamService.on('onTeamInfoUpdated', (team) => { console.log("recv onTeamInfoUpdated", team) })
 * nim.V2NIMTeamService.on('onTeamMemberJoined', (teamMembers) => { console.log("recv onTeamMemberJoined", teamMembers) })
 * nim.V2NIMTeamService.on('onTeamMemberKicked', (operateAccountId, teamMembers) => { console.log("recv onTeamMemberKicked", operateAccountId, teamMembers) })
 * nim.V2NIMTeamService.on('onTeamMemberLeft', (teamMembers) => { console.log("recv onTeamMemberLeft", teamMembers) })
 * nim.V2NIMTeamService.on('onTeamMemberInfoUpdated', (teamMembers) => { console.log("recv onTeamMemberInfoUpdated", teamMembers) })
 * nim.V2NIMTeamService.on('onReceiveTeamJoinActionInfo', (joinActionInfo) => { console.log("recv onReceiveTeamJoinActionInfo", joinActionInfo) })
 * ```
 */
export interface V2NIMTeamListener {
    /**
     * 群组信息同步开始回调
     */
    onSyncStarted: [];
    /**
     * 群组信息同步结束回调
     */
    onSyncFinished: [];
    /**
     * 群组信息数据同步失败
     */
    onSyncFailed: [error: V2NIMError];
    /**
     * 群组创建回调
     *
     * 注: 包括多端同步和初始化同步都可能触发
     */
    onTeamCreated: [team: V2NIMTeam];
    /**
     * 群组解散
     */
    onTeamDismissed: [team: V2NIMTeam];
    /**
     * (自己)加入某群
     *
     * 注: 当自己被邀请后接受邀请， 或申请通过，或直接被拉入群组的事件通知
     */
    onTeamJoined: [team: V2NIMTeam];
    /**
     * 退出群组
     *
     * 注: 当自己主动离开群组或被管理员踢出群组会收到该事件
     *
     * @param team 被离开的群组
     * @param isKicked 是否被踢出群组
     */
    onTeamLeft: [team: V2NIMTeam, isKicked: boolean];
    /**
     * 群组信息更新
     */
    onTeamInfoUpdated: [team: V2NIMTeam];
    /**
     * 群组成员加入
     *
     * 注: 非本账号的用户加入了这个群组后触发的
     *
     * @param teamMembers 加入的群组成员信息
     */
    onTeamMemberJoined: [teamMembers: V2NIMTeamMember[]];
    /**
     * 群组成员被踢
     *
     * @param operateAccountId 操作者账号 ID
     * @param teamMembers 被踢的群组成员信息
     */
    onTeamMemberKicked: [operateAccountId: string, teamMembers: V2NIMTeamMember[]];
    /**
     * 群组成员退出
     *
     * @param teamMembers 退出的群组成员信息
     */
    onTeamMemberLeft: [teamMembers: V2NIMTeamMember[]];
    /**
     * 群组成员信息变更
     *
     * @param teamMembers 变更的群成员信息列表
     */
    onTeamMemberInfoUpdated: [teamMembers: V2NIMTeamMember[]];
    /**
     * 群组申请动作
     *
     * 注: 区分四种类型: 管理员收到入群申请; 申请人收到入群申请被拒绝; 成员收到入群邀请; 管理员收到入群邀请被拒绝
     */
    onReceiveTeamJoinActionInfo: [joinActionInfo: V2NIMTeamJoinActionInfo];
}
/**
 * 群操作类型
 */
export declare const enum V2NIMTeamJoinActionType {
    /**
     * 申请入群
     */
    V2NIM_TEAM_JOIN_ACTION_TYPE_APPLICATION = 0,
    /**
     * 管理拒绝申请入群
     */
    V2NIM_TEAM_JOIN_ACTION_TYPE_REJECT_APPLICATION = 1,
    /**
     * 邀请入群
     */
    V2NIM_TEAM_JOIN_ACTION_TYPE_INVITATION = 2,
    /**
     * 成员拒绝邀请入群
     */
    V2NIM_TEAM_JOIN_ACTION_TYPE_REJECT_INVITATION = 3,
    /**
     * 收到管理员同意入群申请
     */
    V2NIM_TEAM_JOIN_ACTION_TYPE_ACCEPT_APPLICATION = 4,
    /**
     * 收到被邀请人同意入群邀请
     */
    V2NIM_TEAM_JOIN_ACTION_TYPE_ACCEPT_INVITATION = 5
}
/**
 * 群的消息通知
 */
export declare type V2NIMTeamJoinActionInfo = {
    /**
     * 群操作类型
     */
    actionType: V2NIMTeamJoinActionType;
    /**
     * 群组ID
     */
    teamId: string;
    /**
     * 群组类型
     */
    teamType: V2NIMTeamType;
    /**
     * 操作者的账号 ID
     */
    operatorAccountId: string;
    /**
     * 该操作的附言
     */
    postscript?: string;
    /**
     * 该操作发生时的时间戳
     */
    timestamp: number;
    /**
     * 操作状态
     */
    actionStatus: V2NIMTeamJoinActionStatus;
    /**
     * 附加字段
     */
    serverExtension?: string;
    /**
     * 是否已读. v10.9.20+ 新增
     */
    read: boolean;
    /**
     * 发起者账号
     */
    fromAccountId: string;
    /**
     * 目标账号.
     *
     * 注: 当前仅在邀请场景, 该字段有确切的值, 代表受邀者.
     */
    targetAccountId: string;
    /**
     * 记录ID
     */
    serverId: string;
    /**
     * 变更的时间
     */
    updateTimestamp: number;
    /**
     * 附言历史
     */
    postscriptHistory?: V2NIMPostscript[];
};
/**
 * 成员入群操作处理状态
 */
export declare const enum V2NIMTeamJoinActionStatus {
    /**
     * 未处理
     */
    V2NIM_TEAM_JOIN_ACTION_STATUS_INIT = 0,
    /**
     * 已同意
     */
    V2NIM_TEAM_JOIN_ACTION_STATUS_AGREED = 1,
    /**
     * 已拒绝
     */
    V2NIM_TEAM_JOIN_ACTION_STATUS_REJECTED = 2,
    /**
     * 已过期
     */
    V2NIM_TEAM_JOIN_ACTION_STATUS_EXPIRED = 3
}
export declare const enum V2NIMTeamNotificationType {
    teamApply = 0,
    teamApplyReject = 1,
    teamInvite = 2,
    teamInviteReject = 3,
    tlistUpdate = 4,
    superTeamApply = 15,
    superTeamApplyReject = 16,
    superTeamInvite = 17,
    superTeamInviteReject = 18
}
export declare type V2NIMTeamJoinActionInfoQueryOption = {
    /**
     * 过滤条件: 群操作类型。
     *
     * 注: 不传这个参数, 或者传递了空数组, 这个过滤条件不生效.
     */
    types?: V2NIMTeamJoinActionType[];
    /**
     * 过滤条件: 操作处理状态.
     *
     * 注: 不传这个参数, 或者传递了空数组, 这个过滤条件不生效.
     */
    status?: V2NIMTeamJoinActionStatus[];
    /**
     * 分页偏移量. 是一个时间戳
     */
    offset?: number;
    /**
     * 每次查询的数量. 默认 50
     */
    limit?: number;
};
export declare type V2NIMTeamJoinActionInfoResult = {
    /**
     * 群的消息通知的列表
     */
    infos: V2NIMTeamJoinActionInfo[];
    /**
     * 分页偏移量
     */
    offset: number;
    /**
     * 是否还有下一页
     */
    finished: boolean;
};
export declare type V2NIMTeamServiceConfig = {
    /**
     * 是否开启服务端群申请记录功能. 默认为 false，即不开启。
     */
    enableServerV2TeamJoinActionInfo?: boolean;
};
