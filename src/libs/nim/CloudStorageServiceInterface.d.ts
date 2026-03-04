import { IUploadFileOptions } from './types';
/**
 * 调用方式:
 * ```js
 * nim.cloudStorage.uploadFile(options)
 * ```
 */
export interface CloudStorageServiceInterface {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 上传文件
     * @locale
     *
     * @locale en
     * Upload files
     * @locale
     */
    uploadFile(options: IUploadFileOptions): Promise<UploadFileResult>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 短链转长链
     * @locale
     *
     * @locale en
     * Convert a shortened URL to a full URL.
     * @locale
     * */
    getOriginUrl(options: string): Promise<string>;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 获取文件鉴权的token
     * @locale
     * @locale en
     * Get the token for the authorization of file access.
     * @locale
     */
    getFileToken(options: GetFileTokenOptions): Promise<GetFileTokenResult | void>;
}
export interface UploadFileResult {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 文件名
     * @locale
     *
     * @locale en
     * File name.
     * @locale
     */
    name: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 文件 url
     * @locale
     *
     * @locale en
     * File URL
     * @locale
     */
    url: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 文件后缀
     * @locale
     *
     * @locale en
     * File extension
     * @locale
     */
    ext: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 文件大小，单位字节
     * @locale
     *
     * @locale en
     * File size (unit: bytes)
     * @locale
     */
    size?: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 宽度。
     * @locale
     *
     * @locale en
     * Width.
     * @locale
     */
    w?: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 高度
     * @locale
     *
     * @locale en
     * Height
     * @locale
     */
    h?: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 音频/视频 文件的时长
     * @locale
     *
     * @locale en
     * The duration of the audio/video file
     * @locale
     */
    dur?: number;
    md5?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 图片的转向
     * @locale
     *
     * @locale en
     * The orientation of the picture
     * @locale
     */
    orientation?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 音频解码格式
     * @locale
     *
     * @locale en
     * Audio decoding format
     * @locale
     */
    audioCodec?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 视频解码格式
     * @locale
     *
     * @locale en
     * Video decoding format
     * @locale
     */
    videoCodec?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 音视频文件的容器
     * @locale
     *
     * @locale en
     * Container for audio and video files
     * @locale
     */
    container?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 文件短链
     * @locale
     *
     * @locale en
     * Non-persistent HTTPS connection for getting files
     * @locale
     */
    _url_safe?: string;
}
export interface FileProgressObject {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 总大小
     * @locale
     *
     * @locale en
     * Total size (unit: byte)
     * @locale
     */
    total: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 已上传大小
     * @locale
     *
     * @locale en
     * Uploaded size
     * @locale
     */
    loaded: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 已上传进度
     * @locale
     *
     * @locale en
     * Upload progress
     * @locale
     */
    percentage: number;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 已上传进度的文本描述
     * @locale
     *
     * @locale en
     * Text description of upload progress
     * @locale
     */
    percentageText: string;
}
export interface GetFileTokenOptions {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 类型 2表示带过期时间的全局token鉴权，3表示文件级别的url鉴权
     * @locale
     *
     * @locale en
     * Type 2: token-based authentication with a validity period, 3: URL-based authentication
     * @locale
     */
    type: 2 | 3;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 如果type=3,是url鉴权，需要传url数组
     * @locale
     *
     * @locale en
     * If type=3, URL authentication, an array of URLs
     * @locale
     */
    urls?: string[] | string;
}
export interface GetFileTokenResult {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 类型 2表示带过期时间的全局token鉴权，3表示文件级别的url鉴权
     * @locale
     *
     * @locale en
     * Type 2: token-based authentication with a validity period, 3: URL-based authentication
     * @locale
     */
    type: 2 | 3;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 如果是url鉴权，就返回url数组对应的tokens
     * @locale
     *
     * @locale en
     * If URL-based authentication is used, the tokens associated with the array of URLs are returned.
     * @locale
     */
    tokens?: string[];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 基于过期时间鉴权的token
     * @locale
     *
     * @locale en
     * Token-based authentication with a validity period
     * @locale
     */
    token?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * token的过期时间，单位s
     * @locale
     *
     * @locale en
     * the validity period of a token in seconds
     * @locale
     */
    ttl: number;
}
export interface NIMEModuleParamCloudStorageConfig {
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * NOS上传地址（直传）
     * 小程序、UniApp上传地址, SDK 默认 'https://fileup.chatnos.com'
     * @locale
     *
     * @locale en
     * Address of NOS upload (direct transfer)
     * MiniApp, UniApp upload address
     * @locale
     */
    commonUploadHost?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 小程序、UniApp上传地址备用域名. SDK 默认: ['https://oss.chatnos.com']
     * @locale
     *
     * @locale en
     * MiniApp, UniApp upload backup address array
     * @locale
     *
     */
    commonUploadHostBackupList?: string[];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * NOS上传地址（分片）. SDK 默认: 'https://wannos-web.127.net'
     * @locale
     *
     * @locale en
     * Address of NOS upload (chunked transfer)
     * @locale
     */
    chunkUploadHost?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * NOS备用上传地址（分片）. SDK 默认: ['https://fileup.chatnos.com', 'https://oss.chatnos.com']
     * @locale
     *
     * @locale en
     * Default address of NOS upload (chunked transfer)
     * @locale
     */
    chunkUploadHostBackupList?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 发送文件消息中文件的url的通配符地址，例：'https://{host}/{object}'
     * @locale
     *
     * @locale en
     * Wildcard address of the file URL in the file message, for example: 'https://{host}/{object}'.
     * @locale
     */
    uploadReplaceFormat?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 接收到文件消息的替换模版
     * 这个是用来接到消息后，要按一定模式替换掉文件链接的。给予一个安全下载链接。
     * 例：'https://{bucket}-nosdn.netease.im/{object}'
     * @locale
     *
     * @locale en
     * The template for the URL of the received file of a file message
     * If a file messages is received, the URL of a file is replaced with a specified patten for a secured download URL
     * Example: 'https://{bucket}-nosdn.netease.im/{object}'
     * @locale
     */
    downloadUrl?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 收到哪些host地址，需要替换成downloadUrl，例：收到nos.netease.com/{bucket}/{obj}
     * @locale
     *
     * @locale en
     * received host addresses are replaced with downloadUrl, exmaple, nos.netease.com/{bucket}/{obj}
     * @locale
     */
    downloadHostList?: string[];
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 服务器下发的域名存在，并且对象前缀匹配成功，那么强行替换为`${protocol}${serverCdnDomain}/${decodePath.slice(prefixIndex)}`
     * @locale
     *
     * @locale en
     * If the CDN domain name exists and matches the prefix of an object, replace with `${protocol}${serverCdnDomain}/${decodePath.slice(prefixIndex)}`
     * @locale
     */
    nosCdnEnable?: boolean;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * NOS 上传专用的 cdn 配置
     * @locale
     *
     * @locale en
     * Dedicated CDN settings for NOS upload
     * @locale
     */
    cdn?: {
        /**
         * @Multi_Lang_Tag
         * @locale cn
         * 默认的下载域名
         * @locale
         *
         * @locale en
         * Default download domain name
         * @locale
         */
        defaultCdnDomain?: string;
        /**
         * @Multi_Lang_Tag
         * @locale cn
         * 下载域名
         * @locale
         *
         * @locale en
         * Download domain name
         * @locale
         */
        cdnDomain?: string;
        /**
         * @Multi_Lang_Tag
         * @locale cn
         * 桶名, 一般 NOS 默认为 "nim"
         * @locale
         *
         * @locale en
         * Bucket name, in most case, "nim" is used
         * @locale
         */
        bucket?: string;
        /**
         * @Multi_Lang_Tag
         * @locale cn
         * 路径前缀，一般不需要填写
         * @locale
         *
         * @locale en
         * Prefix of an object, not required
         * @locale
         */
        objectNamePrefix?: string;
    };
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * amazon aws s3 sdk
     *
     * ```js
     * // 1. 安装 s3 sdk: npm install @aws-sdk/client-SERVICE
     * // 2. 引入 s3 sdk: import {S3} from "@aws-sdk/client-s3"
     * // 3. 初始化时设置 s3 SDK:
     * NIM.getInstance(
     * {
     *    appkey: 'YOUR_APPKEY',
     *    token: 'YOUR_TOKEN',
     *    account: 'YOUR_ACCOUNT'
     * },
     * {
     *    cloudStorageConfig: {
     *      s3: S3
     *    }
     * })
     * ```
     *
     * 注：若传入 s3 sdk 后，本 SDK 根据融合存储策略配置，可能会 new 创建出它的实例并使用它的实例方法进行上传/存储。
     * @locale
     *
     * @locale en
     * amazon aws s3 sdk
     *
     * Note: if S3 SDK is specified, an instance is created and used for upload and storage using the new operator based on the converged storage configuration.
     * @locale
     */
    s3?: any;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * localStorage 缓存的云存储配置的键名的前缀。默认叫 NIMClient
     *
     * 注: 举个例子，根据默认配置，策略缓存的键叫 'NIMClient-AllGrayscaleConfig'。
     * @locale
     *
     * @locale en
     * The prefix of a key of the cloud storage configuration of the localStorage cache. The default prefix is NIMClient.
     *
     * For example, by default, the key of the caching policy is called 'NIMClient-AllGrayscaleConfig'.
     * @locale
     */
    storageKeyPrefix?: string;
    /**
     * @Multi_Lang_Tag
     * @locale cn
     * 是否需要开启融合存储整个策略。默认为 true
     *
     * 注: 为 false 则不会进行 lbs 灰度开关和策略获取，直接退化到老的 nos 上传逻辑。
     * @locale
     *
     * @locale en
     * whether the converged storage is enabled. The default value is true
     *
     * Note: if false, does not get the option and policy of the lbs gray release and the old NOS upload logic is used.
     * @locale
     */
    isNeedToGetUploadPolicyFromServer?: boolean;
}
