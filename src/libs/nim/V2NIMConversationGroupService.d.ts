import { V2NIMConversation, V2NIMConversationOperationResult } from './V2NIMConversationService';
import type { NIMEBaseServiceClass } from './types';
/**
 * 会话分组功能
 *
 * 注: 使用 dist/esm 产物时，需要动态引入 V2NIMConversationGroupService 后使用
 *
 * @example
 * ```
 * import { NIM, V2NIMConversationGroupService } from 'nim-web-sdk-ng/dist/esm/nim'
 * NIM.registerService(V2NIMConversationGroupService, 'V2NIMConversationGroupService')
 * ```
 */
export declare class V2NIMConversationGroupService extends NIMEBaseServiceClass<V2NIMConversationGroupListener> {
    /**
     * 创建一个会话分组
     *
     * 注: 在操作成功且是有效的操作时, 抛出事件 {@link V2NIMConversationGroupListener.onConversationGroupCreated | V2NIMConversationGroupListener.onConversationGroupCreated}
     *
     * @param name 分组名
     * @param serverExtension 扩展字段
     * @param conversationIds 所拥有的会话 id 列表
     *
     * @example
     * ```ts
     * const conversationId1 = nim.V2NIMConversationIdUtil.p2pConversationId('TARGET_ACCOUNT_ID')
     * const conversationId2 = nim.V2NIMConversationIdUtil.teamConversationId('TARGET_TEAM_ID')
     * try {
     *   const result = await nim.V2NIMConversationGroupService.createConversationGroup('GROUP_NAME', '', [conversationId1, conversationId2])
     *   // todo success.
     *   // console.log(result.group)
     * } catch (err) {
     *   // TODO failed.
     *   // console.error(error.code)
     * }
     * ```
     *
     */
    createConversationGroup(name: string, serverExtension?: string, conversationIds?: string[]): Promise<V2NIMConversationGroupResult>;
    /**
     * 删除会话分组
     *
     * 注: 成功删除后抛出事件 {@link V2NIMConversationGroupListener.onConversationGroupDeleted}
     *
     * @param groupId
     */
    deleteConversationGroup(groupId: string): Promise<void>;
    /**
     * 更新会话分组
     *
     * 注: 成功更新后抛出事件 {@link V2NIMConversationGroupListener.onConversationGroupChanged}
     *
     * @param groupId 分组 id
     * @param name 传入 null 或者 undefined 表示不更新; 传入空字符串会得到参数校验错误
     * @param serverExtension 扩展字段
     */
    updateConversationGroup(groupId: string, name?: string, serverExtension?: string): Promise<void>;
    /**
     * 添加会话到相应分组下面
     *
     * 注: 成功添加后抛出事件 {@link V2NIMConversationGroupListener.onConversationsAddedToGroup}
     *
     * @param groupId 分组 id
     * @param conversationIds 待添加的会话 id 列表
     */
    addConversationsToGroup(groupId: string, conversationIds: string[]): Promise<V2NIMConversationOperationResult[]>;
    /**
     * 从会话分组删除相应会话
     *
     * 注: 成功添加后抛出事件 {@link V2NIMConversationGroupListener.onConversationsRemovedFromGroup}
     *
     * @param groupId 分组 id
     * @param conversationIds 待删除的会话 id 列表
     */
    removeConversationsFromGroup(groupId: string, conversationIds: string[]): Promise<V2NIMConversationOperationResult[]>;
    /**
     * 获取单个会话分组信息
     *
     * @param groupId 会话分组的 ID
     */
    getConversationGroup(groupId: string): Promise<V2NIMConversationGroup>;
    /**
     * 获取会话分组列表
     */
    getConversationGroupList(): Promise<V2NIMConversationGroup[]>;
    /**
     * 根据分组 ID 获取会话分组列表
     *
     * @param groupIds 会话分组的 ID 列表
     */
    getConversationGroupListByIds(groupIds: string[]): Promise<V2NIMConversationGroup[]>;
}
export declare type V2NIMConversationGroup = {
    /**
     * 会话分组ID
     */
    groupId: string;
    /**
     * 会话分组名称
     */
    name: string;
    /**
     * 扩展字段
     */
    serverExtension: string;
    /**
     * 会话分组的创建时间
     */
    createTime: number;
    /**
     * 会话分组的修改时间
     */
    updateTime: number;
};
export declare type V2NIMConversationGroupResult = {
    /**
     * 会话分组信息
     */
    group: V2NIMConversationGroup;
    /**
     * 失败的会话列表信息
     */
    failedList: V2NIMConversationOperationResult[];
};
export declare type V2NIMConversationGroupConfig = {};
/**
 * 会话分组的监听事件
 *
 * 注: 使用 dist/esm 产物时，需要动态引入 V2NIMConversationGroupService 后使用
 *
 * @example
 * ```
 * import { NIM, V2NIMConversationGroupService } from 'nim-web-sdk-ng/dist/esm/nim'
 * NIM.registerService(V2NIMConversationGroupService, 'V2NIMConversationGroupService')
 * ```
 */
export interface V2NIMConversationGroupListener {
    /**
     * 会话分组被创建
     */
    onConversationGroupCreated: [conversationGroup: V2NIMConversationGroup];
    /**
     * 会话分组被删除
     */
    onConversationGroupDeleted: [groupId: string];
    /**
     * 会话分组被更新
     */
    onConversationGroupChanged: [conversationGroup: V2NIMConversationGroup];
    /**
     * 会话分组下的会话被添加
     */
    onConversationsAddedToGroup: [groupId: string, list: V2NIMConversation[]];
    /**
     * 会话分组下的会话被删除
     *
     * @param groupId 分组 id
     * @param list 会话 id 列表
     */
    onConversationsRemovedFromGroup: [groupId: string, list: string[]];
}
