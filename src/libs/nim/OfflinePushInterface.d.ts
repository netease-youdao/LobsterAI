/**
 * 调用方式:
 * ```js
 * nim.offlinePush.setOfflinePushConfig(options)
 * ```
 */
export interface OfflinePushServiceInterface {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 查询云端会话列表
     * @locale
     *
     * @locale en
     * @locale
     */
    setOfflinePushConfig(options: NIMESetOfflinePushConfigOptions): void;
}
/**
 * @Multi_Lang_Tag
 * @locale cn
 * 离线推送参数
 * @locale
 *
 * @locale en
 *
 * @locale
 */
export interface NIMESetOfflinePushConfigOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * NIMUniPlugin插件实例。
     * @locale
     *
     * @locale en
     *
     * @locale
     */
    plugin: NIMEOfflinePushPlugin;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 各个手机厂商的推送服务参数。
     * @locale
     *
     * @locale en
     *
     * @locale
     */
    authConfig: NIMEOfflinePushAuthConfig;
}
export interface NIMEOfflinePushPlugin {
    getDeviceToken: (opt: {
        suggestPushType: string;
        config?: NIMEOfflinePushAuthConfig;
    }, fn: (token: string) => void) => void;
}
export interface NIMEOfflinePushAuthConfig {
    /**
     * 小米推送AppId
     */
    xmAppId?: string;
    /**
     * 小米推送AppKey
     */
    xmAppKey?: string;
    /**
     * 云信后台配置的小米推送证书
     */
    xmCertificateName?: string;
    /**
     * 华为推送AppId
     */
    hwAppId?: string;
    /**
     * 云信后台配置的华为推送证书
     */
    hwCertificateName?: string;
    /**
     * oppo推送AppId
     */
    oppoAppId?: string;
    /**
     * oppo推送AppKey
     */
    oppoAppKey?: string;
    /**
     * oppo推送AppSecret
     */
    oppoAppSecret?: string;
    /**
     * 云信后台配置的oppo推送证书
     */
    oppoCertificateName?: string;
    /**
     * 云信后台配置的vivo推送证书
     */
    vivoCertificateName?: string;
    /**
     * 云信后台配置的fcm推送证书
     */
    fcmCertificateName?: string;
    /**
     * 魅族推送AppId
     */
    mzAppId?: string;
    /**
     * 魅族推送AppKey
     */
    mzAppKey?: string;
    /**
     * 云信后台配置的魅族推送证书
     */
    mzCertificateName?: string;
    /**
     * 云信后台配置的苹果推送证书
     */
    apnsCertificateName?: string;
    /**
     * 云信后台配置的荣耀推送证书
     */
    honorCertificateName?: string;
}
/**
 * @Multi_Lang_Tag
 * @locale cn
 * 推送专用，更新并上报厂商推送（APNs、小米推送等）的devicetoken
 * @locale
 *
 * @locale en
 * Dedicated for push notification; update and upload the device token of the manufacturer’s push notification services (APNs, Xiaomi push, etc.)
 * @locale
 */
export interface NIMEUpdatePushTokenOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 证书名
     * @locale
     *
     * @locale en
     * Certificate name
     * @locale
     */
    tokenName: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 推送 token
     * @locale
     *
     * @locale en
     * Token for push notification
     * @locale
     */
    token: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 推送通道。默认 0，表示 apns 通道
     * @locale
     *
     * @locale en
     * Push channel. The default value is 0, which represents the APNs channel
     * @locale
     */
    pushkit: number;
}
/**
 * @Multi_Lang_Tag
 * @locale cn
 * 推送专用
 * @locale
 *
 * @locale en
 * Dedicated for push notification
 * @locale
 */
export interface NIMEUpdateAppBackgroundOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * app 是否正处在后台。
     * true 为 app 转入后台运行
     * false 为 app 切回前台运行
     * @locale
     *
     * @locale en
     * Whether the App is in the background.
     * true: App runs in the background
     * false: App runs in the foreground
     * @locale
     */
    isBackground: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 未读数（角标数字），只有ios需要传这个参数。
     * @locale
     *
     * @locale en
     * Unread count (number displayed as a subscript); you only need to pass this parameter if you are developing iOS App.
     * @locale
     */
    badge: number;
}
