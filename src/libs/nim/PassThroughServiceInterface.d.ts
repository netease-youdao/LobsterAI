/**
 * 调用方式:
 * ```js
 * nim.passThrough.request(options)
 * ```
 */
export interface PassThroughServiceInterface {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 透传协议
     * @locale
     *
     * @locale en
     * Transparent transmission protocol
     * @locale
     */
    request(options: RequestProxyOptions): Promise<RequestProxyResult>;
}
export interface RequestProxyOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * HTTP path（不包含域名 host）
     * @locale
     *
     * @locale en
     * HTTP path (does not include the domain name host)
     * @locale
     */
    path: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 映射一个视频云 upstream host，不传用默认配置
     * @locale
     *
     * @locale en
     * Map a video cloud upstream host (the default value will be applied if no custom value is passed).
     * @locale
     */
    zone?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * HTTP Method
     *
     * 数字常量 (1-get, 2-post, 3-put, 4-delete)，默认post
     * @locale
     *
     * @locale en
     * HTTP Method
     *
     * Numeric constants (1-GET, 2-POST, 3-PUT, 4-DELETE), default value: 2
     * @locale
     */
    method?: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * HTTP header，JSON 格式字符串
     * @locale
     *
     * @locale en
     * HTTP header, the JSON format string
     * @locale
     */
    header?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * HTTP body，透传字符串
     * @locale
     *
     * @locale en
     * HTTP body, transparently-transmitted string
     * @locale
     */
    body?: string;
}
export declare type RequestProxyResult = RequestProxyOptions;
