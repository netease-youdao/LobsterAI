/**
 * 调用方式:
 * ```js
 * const time = await nim.misc.getServerTime()
 * ```
 */
export interface MiscServiceInterface {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 获取服务器时间
     * @locale
     *
     * @locale en
     * @locale
     */
    getServerTime(): Promise<number>;
}
