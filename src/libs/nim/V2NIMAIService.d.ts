import { V2NIMUser } from './V2NIMUserService';
import type { NIMEBaseServiceClass } from './types';
/**
 * AI 数字人服务
 *
 * 注: 使用 dist/esm 产物时，需要动态引入 V2NIMAIService 后使用
 *
 * @example
 * ```
 * import { NIM, V2NIMAIService } from 'nim-web-sdk-ng/dist/esm/nim'
 * NIM.registerService(V2NIMAIService, 'V2NIMAIService')
 * ```
 */
export declare class V2NIMAIService extends NIMEBaseServiceClass<V2NIMAIListener> {
    /**
     * 数字人拉取接口
     *
     * 注: 返回全量的本 Appkey 相关的数字人用户
     *
     * @returns 数字人用户列表
     * @example
     * ```js
     * const aiUsers = await nim.V2NIMAIService.getAIUserList()
     * ```
     */
    getAIUserList(): Promise<V2NIMAIUser[]>;
    /**
     * AI 数字人请求代理接口
     *
     * @param params 接口入参
     * @example
     * ```
     * await nim.V2NIMAIService.proxyAIModelCall({
     *   "accountId": "YOUR_AI_ACCOUNT_ID",
     *   "requestId": "YOUR_REQUEST_ID",
     *   "content": {
     *     "msg": "YOUR_CONTENT_MSG",
     *     "type": 0
     *   }
     * })
     * ```
     */
    proxyAIModelCall(params: V2NIMProxyAIModelCallParams): Promise<void>;
    /**
     * 停止AI数字人流式输出
     *
     * @param params 停止流式输出的参数
     * @returns Promise<void>
     * @example
     * ```js
     * await nim.V2NIMAIService.stopAIModelStreamCall({
     *   accountId: "YOUR_AI_ACCOUNT_ID",
     *   clientId: "YOUR_CLIENT_ID",
     *   type: 1,
     *   from: "YOUR_ACCOUNT_ID",
     *   to: "RECEIVER_ID",
     *   opeType: 0
     * })
     * ```
     */
    stopAIModelStreamCall(params: V2NIMAIModelStreamCallStopParams): Promise<void>;
}
export interface V2NIMAIUser extends V2NIMUser {
    /**
     * 大模型的类型， 客户端不做转义处理. v10.9.50 新增该字段
     */
    aiModelType: number;
    /**
     * @deprecated 10.9.50 废弃, 字段移到 aiModelType 中
     *
     * 大模型的类型
     */
    modelType: V2NIMAIModelType;
    /**
     * 模型相关配置信息
     */
    modelConfig?: V2NIMAIModelConfig;
}
export declare type V2NIMAIModelConfig = {
    /**
     * 具体大模型版本模型名称
     */
    model: string;
    /**
     * 提示词
     */
    prompt: string;
    /**
     * 提示词相关的变量
     */
    promptKeys?: string[];
    /**
     * 模型最大tokens数量
     */
    maxTokens?: number;
    /**
     * 核采样方法的概率阈值
     */
    topP?: string;
    /**
     * 随机性和多样性的程度值
     */
    temperature?: string;
};
export declare const enum V2NIMAIModelType {
    /**
     * 未知
     */
    V2NIM_AI_MODEL_TYPE_UNKNOW = 0,
    /**
     * 通义千问大模型
     */
    V2NIM_AI_MODEL_TYPE_QWEN = 1,
    /**
     * 微软Azure
     */
    V2NIM_AI_MODEL_TYPE_AZURE = 2,
    /**
     * 私有本地大模型
     */
    V2NIM_AI_MODEL_TYPE_PRIVATE = 3
}
/**
 * RAG 信息
 */
export declare type V2NIMAIRAGInfo = {
    /**
     * RAG 名称
     */
    name?: string;
    /**
     * RAG 图标
     */
    icon?: string;
    /**
     * 引用资源的标题
     */
    title?: string;
    /**
     * 引用资源的描述
     */
    description?: string;
    /**
     * 引用资源的链接
     */
    url?: string;
    /**
     * 引用资源的时间
     */
    time?: number;
};
/**
 * AI 数字人请求代理接口的入参
 */
export declare type V2NIMProxyAIModelCallParams = {
    /**
     * 机器人账号ID
     */
    accountId: string;
    /**
     * 请求id
     *
     * 注: 需要用请求 id 将整个串联应答流程, 建议采用 uuid 算法避免重复
     */
    requestId: string;
    /**
     * 请求大模型的内容
     */
    content: V2NIMAIModelCallContent;
    /**
     * 请求调用上下文内容
     */
    messages?: V2NIMAIModelCallMessage[];
    /**
     * 提示词变量占位符替换. JSON 序列化的字符串, 用于填充 prompt 中的变量
     *
     * 注: 如果 V2NIMAIUser 中的 modelConfig.promptKeys 存在且数组长度不为 0 ，则必填.
     */
    promptVariables?: string;
    /**
     * 请求接口模型相关参数配置， 如果参数不为空，则默认覆盖控制相关配置
     */
    modelConfigParams?: V2NIMAIModelConfigParams;
    /**
     * 反垃圾配置
     */
    antispamConfig?: V2NIMProxyAICallAntispamConfig;
    /**
     * 是否是流式响应，默认false
     */
    aiStream: boolean;
};
/**
 * 数字人流式消息状态
 */
export declare const enum V2NIMAIModelStreamCallStatus {
    /**
     * 非流式状态
     */
    V2NIM_AI_MODEL_STREAM_CALL_STATUS_NONE = 0,
    /**
     * 停止输出
     */
    V2NIM_AI_MODEL_STREAM_CALL_STATUS_CANCEL = 2,
    /**
     * 输出完成
     */
    V2NIM_AI_MODEL_STREAM_CALL_STATUS_COMPLETE = 4,
    /**
     * 服务器异常终止
     */
    V2NIM_AI_MODEL_STREAM_CALL_STATUS_EXCEPTION = 5
}
export declare type V2NIMProxyAICallAntispamConfig = {
    /**
     * 指定消息是否需要经过安全通。默认为 true
     *
     * 对于已开通安全通的用户有效，默认消息都会走安全通，如果对单条消息设置 enable 为 false，则此消息不会走安全通
     */
    antispamEnabled?: boolean;
    /**
     * 指定易盾业务id
     */
    antispamBusinessId?: string;
};
/**
 * AI 大模型配置
 */
export declare type V2NIMAIModelConfigParams = {
    /**
     * 提示词
     */
    prompt?: string;
    /**
     * 模型最大tokens数量
     */
    maxTokens?: number;
    /**
     * 核采样方法的概率阈值
     */
    topP?: string;
    /**
     * 随机性和多样性的程度值
     */
    temperature?: string;
};
export interface V2NIMAIModelCallMessage {
    /**
     * 上下文内容的角色.
     *
     * 注: 请开发者自行判定自己发的消息选 user, 若是机器人发的消息是选 assistant
     */
    role: V2NIMAIModelRoleType;
    /**
     * 请求/响应的文本内容
     */
    msg: string;
    /**
     * 类型, 暂时只有 0, 代表文本
     */
    type: number;
}
export declare const enum V2NIMAIModelRoleType {
    /**
     * 系统
     */
    V2NIM_AI_MODEL_ROLE_TYPE_SYSTEM = "system",
    /**
     * 用户
     */
    V2NIM_AI_MODEL_ROLE_TYPE_USER = "user",
    /**
     * 助手
     */
    V2NIM_AI_MODEL_ROLE_TYPE_ASSISTANT = "assistant"
}
export interface V2NIMAIModelCallContent {
    /**
     * 请求/响应的文本内容
     */
    msg: string;
    /**
     * 类型, 暂时只有 0, 代表文本
     */
    type: number;
}
/**
 * AI 透传接口的响应的回调的结构体
 */
export interface V2NIMAIModelCallResult {
    /**
     * 本次响应的状态, 200 为成功, 其他的都是失败
     */
    code: number;
    /**
     * 机器人账号 ID
     */
    accountId: string;
    /**
     * 请求 ID
     */
    requestId: string;
    /**
     * 响应的内容
     */
    content: V2NIMAIModelCallContent;
    /**
     * 数字人回复内容的引用资源列表
     */
    aiRAGs?: V2NIMAIRAGInfo[];
    /**
     * 回复的时间戳
     */
    timestamp: number;
    /**
     * 是否是流式响应，默认false
     */
    aiStream: boolean;
    /**
     * 数字人流式响应状态
     */
    aiStreamStatus: V2NIMAIModelStreamCallStatus;
}
/**
 * 透传协议流式分片信息
 */
export interface V2NIMAIModelStreamCallChunk {
    /**
     * 数字人流式回复分片文本
     */
    content: string;
    /**
     * 数字人流式回复当前分片时间
     */
    chunkTime: number;
    /**
     * 类型，当前仅支持0表示文本
     */
    type: number;
    /**
     * 分片序号，从0开始
     */
    index: number;
}
/**
 * 流式回复内容
 */
export interface V2NIMAIModelStreamCallContent {
    /**
     * 数字人流式回复分片组装好后的文本
     */
    msg: string;
    /**
     * 类型，当前仅支持0表示文本
     */
    type: number;
    /**
     * 数字人流式回复最近一个分片
     */
    lastChunk: V2NIMAIModelStreamCallChunk;
}
/**
 * 透传接口的 AI 流式回复的结构体
 */
export interface V2NIMAIModelStreamCallResult {
    /**
     * AI 响应的状态码
     */
    code: number;
    /**
     * 数字人的 accountId
     */
    accountId: string;
    /**
     * 本次响应的标识
     */
    requestId: string;
    /**
     * 请求 AI 的回复
     */
    content?: V2NIMAIModelStreamCallContent;
    /**
     * 数字人回复内容的引用资源列表
     * 第一个分片才下发，端上是否内存缓存，每次都上抛？
     */
    aiRAGs?: V2NIMAIRAGInfo[];
    /**
     * 分片的时间戳
     */
    timestamp: number;
}
/**
 * 停止透传接口的 AI 流式回复
 */
export interface V2NIMAIModelStreamCallStopParams {
    /**
     * 机器人账号ID
     */
    accountId: string;
    /**
     * 请求id
     */
    requestId: string;
}
/**
 * AI 数字人服务的监听事件
 *
 * 注: 使用 dist/esm 产物时，需要动态引入 V2NIMAIService 后使用
 *
 * @example
 * ```
 * import { NIM, V2NIMAIService } from 'nim-web-sdk-ng/dist/esm/nim'
 * NIM.registerService(V2NIMAIService, 'V2NIMAIService')
 * ```
 */
export interface V2NIMAIListener {
    /**
     * AI 透传接口的响应的回调
     *
     * 注: 接口 proxyAIModelCall 调用完毕后, 接下来服务器响应以通知的形式下发, 端测需要触发回调提供
     *
     * @param response 本次响应的结构体
     *
     * @example
     * ```
     * nim.V2NIMAIService.on('onProxyAIModelCall', (response) => {})
     * ```
     */
    onProxyAIModelCall: [response: V2NIMAIModelCallResult];
    /**
     * AI 透传接口的流式回复的回调
     *
     * 注: 接口 proxyAIModelStreamCall 调用完毕后, 接下来服务器响应以通知的形式下发, 端测需要触发回调提供
     *
     * @param response 本次响应的结构体
     *
     * @example
     * ```
     * nim.V2NIMAIService.on('onProxyAIModelStreamCall', (response) => {})
     * ```
     * */
    onProxyAIModelStreamCall: [response: V2NIMAIModelStreamCallResult];
}
