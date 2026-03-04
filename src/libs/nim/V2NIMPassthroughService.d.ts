import type { NIMEBaseServiceClass } from './types';
/**
 * 服务代理模块. 包含服务代理接口
 *
 * 注: 使用 dist/esm 产物时，需要动态引入 V2NIMPassthroughService 后使用
 *
 * @example
 * ```
 * import { NIM, V2NIMPassthroughService } from 'nim-web-sdk-ng/dist/esm/nim'
 * NIM.registerService(V2NIMPassthroughService, 'V2NIMPassthroughService')
 * ```
 */
export declare class V2NIMPassthroughService extends NIMEBaseServiceClass<V2NIMPassthroughListener> {
    /**
     * http 服务代理
     *
     * @example
     * ```
     * await nim.V2NIMPassthroughService.httpProxy({
     *   "path": "/nimserver/friend/get.action",
     *   "zone": "http://imtest.netease.im",
     *   "method": 2,
     *   "header": "{\"Nonce\":\"YOUR_NONCE\",\"CheckSum\":\"YOUR_CHECKSUM\",\"AppKey\":\"YOUR_APPKEY\",\"CurTime\":\"1730186843\",\"Content-Type\":\"application/x-www-form-urlencoded\"}",
     *   "body": "accid=YOUR_ACCID&updatetime=0"
     * })
     * ```
     */
    httpProxy(proxyRequest: V2NIMProxyRequest): Promise<V2NIMProxyResponse>;
}
/**
 * 代理的http请求参数
 */
export declare type V2NIMProxyRequest = {
    /**
     * url 中除了 host 的 path. path 不能为空
     */
    path: string;
    /**
     * 映射一个 upstream host, 不传则使用默认配置
     */
    zone?: string;
    /**
     * 请求方式. 默认值为 {@link V2NIMProxyRequestMethod.V2NIM_PROXY_REQUEST_METHOD_POST | V2NIMProxyRequestMethod.V2NIM_PROXY_REQUEST_METHOD_POST}
     *
     * 注:
     *
     * - GET请求， 如果 body 非空， 则返回参数错误
     * - POST/PUT, 如果 body 为空，返回参数错误
     */
    method?: V2NIMProxyRequestMethod;
    /**
     * 请求头.
     *
     * 注: 传入能被 JSON 解析的字符串
     */
    header?: string;
    /**
     * 请求体.
     */
    body?: string;
};
/**
 * 代理的 http 请求的响应
 */
export declare type V2NIMProxyResponse = {
    /**
     * 响应头. 返回能被 json 序列化的字符串
     */
    header?: string;
    /**
     * 响应体
     */
    body: string;
};
export declare enum V2NIMProxyRequestMethod {
    /**
     * GET请求
     */
    V2NIM_PROXY_REQUEST_METHOD_GET = 1,
    /**
     * POST请求
     */
    V2NIM_PROXY_REQUEST_METHOD_POST = 2,
    /**
     * PUT请求
     */
    V2NIM_PROXY_REQUEST_METHOD_PUT = 3,
    /**
     * DELETE请求
     */
    V2NIM_PROXY_REQUEST_METHOD_DELETE = 4
}
/**
 * 透传下行数据
 */
export declare type V2NIMProxyNotify = {
    /**
     * 发送方账号
     */
    fromAccountId: string;
    /**
     * 通知体
     */
    body: string;
    /**
     * 发送时间. 单位毫秒
     */
    time: number;
};
/**
 * 服务代理模块的监听器
 *
 * 注: 使用 dist/esm 产物时，需要动态引入 V2NIMPassthroughService 后使用
 *
 * @example
 * ```
 * import { NIM, V2NIMPassthroughService } from 'nim-web-sdk-ng/dist/esm/nim'
 * NIM.registerService(V2NIMPassthroughService, 'V2NIMPassthroughService')
 * ```
 */
export interface V2NIMPassthroughListener {
    /**
     * 服务代理的通知
     */
    onProxyNotify: [proxyNotify: V2NIMProxyNotify];
}
