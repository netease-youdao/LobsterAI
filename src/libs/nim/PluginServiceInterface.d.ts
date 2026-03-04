/**
 * 调用方式:
 * ```js
 * nim.plugin.getChatroomAddress(options)
 * ```
 */
export interface PluginServiceInterface {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 获取聊天室的连接地址，返回可用的连接地址列表
     *
     * 注：更推荐开发者使用 http 接口去获取可用的连接地址列表，请自行查阅服务器文档。
     * @locale
     *
     * @locale en
     * Obtain the connection address of a chat room and return a list of available connection addresses
     *
     * Note: It is recommended that you use the HTTP interface to obtain a list of available connection addresses. See the server documentation for details.
     * @locale
     */
    getChatroomAddress(options: GetChatroomAddressOptions): Promise<string[]>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 获取圈组的连接地址，返回可用的连接地址列表
     *
     * 注：更推荐开发者使用 http 接口去获取可用的连接地址列表，请自行查阅服务器文档。
     * @locale
     *
     * @locale en
     * Obtain the connection address of the QChat and return a list of available connection addresses
     *
     * Note: It is recommended that you use the HTTP interface to obtain a list of available connection addresses. See the server documentation for details.
     * @locale
     */
    getQChatAddress(options?: GetQChatAddressOptions): Promise<string[]>;
}
export interface GetChatroomAddressOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 聊天室 id
     * @locale
     *
     * @locale en
     * The ID of a chat room
     * @locale
     */
    chatroomId: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 0 代表想要获取 ipv4 的连接，1 代表 ipv6，2 代表不限制。
     *
     * 默认 0
     * @locale
     *
     * @locale en
     * The value of 0 represents a request for an IPv4 connection, 1 represents IPv6, and 2 represents no restrictions.
     *
     * The default value is 0.
     * @locale
     */
    ipType?: number;
}
export interface GetQChatAddressOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 0 代表想要获取 ipv4 的连接，1 代表 ipv6，2 代表不限制。
     *
     * 默认 0
     * @locale
     *
     * @locale en
     * The value of 0 represents a request for an IPv4 connection, 1 represents IPv6, and 2 represents no restrictions.
     *
     * The default value is 0.
     * @locale
     */
    ipType?: number;
}
