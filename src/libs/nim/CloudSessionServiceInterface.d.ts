import { IMMessage } from './MsgServiceInterface';
import { SystemMessage } from './SystemMessageServiceInterface';
/**
 * 调用方式:
 * ```js
 * nim.cloudSession.queryCloudSessionList(options)
 * ```
 */
export interface CloudSessionServiceInterface {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 查询云端会话列表
     * @locale
     *
     * @locale en
     * Query the list of sessions on the server
     * @locale
     */
    queryCloudSessionList(options: NIMEQueryCloudSessionListOptions): Promise<NIMEQueryCloudSessionListResult>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 查询某个云端会话
     * @locale
     *
     * @locale en
     * Query a specified session
     * @locale
     */
    queryCloudSession(options: NIMEQueryCloudSessionOptions): Promise<NIMECloudSession>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 更新云端会话
     * @locale
     *
     * @locale en
     * Update a session on the server
     * @locale
     */
    updateCloudSession(options: NIMEUpdateCloudSessionOptions): Promise<void>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 删除云端会话列表
     * @locale
     *
     * @locale en
     * Delete a session on the server
     * @locale
     */
    deleteCloudSessionList(options: NIMEDeleteCloudSessionListOptions): Promise<void>;
}
export interface NIMECloudSession {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * sessionId
     *
     * 例如 p2p-cs1、team-113879441
     * @locale
     *
     * @locale en
     * sessionId
     *
     * Example: p2p-cs1, team-113879441
     * @locale
     */
    sessionId: string;
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
     * 扩展字段，仅自己可见
     * @locale
     *
     * @locale en
     * Extension, visible only to yourself
     * @locale
     */
    ext?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 上一条消息的信息.
     *
     * 注1: 若最近消息被撤回了, 会返回特殊的标记 isLastMsgRecalled 与 revokedMsg
     *
     * 注2: 若最近消息被单向删除了, 或者是这个会话的确没有过消息, 这个定义将不会返回.
     * @locale
     *
     * @locale en
     * Previous message
     * @locale
     */
    lastMsgInfo?: {
        /**
         * @Multi_Lang_Tag
         * @locale cn
         * 上一条消息是否被撤回
         * @locale
         *
         * @locale en
         * Whether the last message is unsent
         * @locale
         */
        isLastMsgRecalled: boolean;
        /**
         * @Multi_Lang_Tag
         * @locale cn
         * 上一条消息内容，isLastMsgRecalled 为 false 时存在。
         * @locale
         *
         * @locale en
         * body of the last message, valid if isLastMsgRecalled is set to false
         * @locale
         */
        lastMsg?: IMMessage;
        /**
         * @Multi_Lang_Tag
         * @locale cn
         * 上一条被撤回的消息通知，isLastMsgRecalled 为 true 时存在。
         * @locale
         *
         * @locale en
         * notification of the last unsent message, valid if isLastMsgRecalled is set to true
         * @locale
         */
        revokedMsg?: SystemMessage;
    };
}
export interface NIMEQueryCloudSessionListOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 与 maxTimestamp 组成一个时间段。默认 0，代表不限制
     * @locale
     *
     * @locale en
     * The SDK  determines the parameter order based on the time period it forms with timestamp2. <br>
     * The default value is 0, which means there is no restriction.
     * @locale
     */
    minTimestamp?: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 与 minTimestamp 组成一个时间段。默认 0，代表不限制
     * @locale
     *
     * @locale en
     * The SDK  determines the parameter order based on the time period it forms with timestamp1. <br>
     * The default value is 0, which means there is no restriction.
     * @locale
     */
    maxTimestamp?: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 分页大小，默认 100
     * @locale
     *
     * @locale en
     * The number of sessions displayed on a page. The default value is 100.
     * @locale
     */
    limit?: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否需要返回 last msg。默认 true
     * @locale
     *
     * @locale en
     * Whether the last message is returned. The default value is true.
     * @locale
     */
    includedLastMsg?: boolean;
}
export interface NIMEQueryCloudSessionListResult {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 会话列表
     * @locale
     *
     * @locale en
     * List of sessions
     * @locale
     */
    sessionList: NIMECloudSession[];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否下一页还有数据
     * @locale
     *
     * @locale en
     * Whether more data is loaded for the next page
     * @locale
     */
    hasMore: boolean;
}
export interface NIMEQueryCloudSessionOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 会话 ID
     * @locale
     *
     * @locale en
     * Session ID
     * @locale
     */
    sessionId: string;
}
export interface NIMEUpdateCloudSessionOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 会话 ID
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
     * 扩展字段，仅自己可见
     * @locale
     *
     * @locale en
     * The extension field, only visible for the current user
     * @locale
     */
    ext: string;
}
export interface NIMEDeleteCloudSessionListOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 要删除的会话 ID 的列表
     * @locale
     *
     * @locale en
     * The list of sessions to be deleted
     * @locale
     */
    sessionIdList: string[];
}
