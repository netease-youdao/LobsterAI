import { V2NIMMessageAttachment } from './V2NIMMessageService';
/**
 * v2 存储模块. 包含上传文件能力.
 *
 * 注: 使用 dist/esm 产物时，需要动态引入 V2NIMStorageService 后使用
 *
 * @example
 * ```
 * import { NIM, V2NIMStorageService } from 'nim-web-sdk-ng/dist/esm/nim'
 * NIM.registerService(V2NIMStorageService, 'V2NIMStorageService')
 * ```
 */
export declare class V2NIMStorageService {
    /**
     * 设置自定义场景
     *
     * @param sceneName 自定义的场景名
     * @param expireTime 文件过期时间. 单位秒. 数值要求大于等于 86400 秒, 即 1 天.
     */
    addCustomStorageScene(sceneName: string, expireTime: number): V2NIMStorageScene;
    /**
     * 查询存储场景列表
     */
    getStorageSceneList(): V2NIMStorageScene[];
    /**
     * 创建文件上传任务
     *
     * @param fileParams 上传文件参数
     * @returns 上传任务
     */
    createUploadFileTask(fileParams: V2NIMUploadFileParams): V2NIMUploadFileTask;
    /**
     * 上传文件
     *
     * 注: 比之 {@link V2NIMStorageService.uploadFileWithMetaInfo | V2NIMStorageService.uploadFileWithMetaInfo }, 本接口只单纯返回上传的 url
     *
     * @param fileTask 上传任务，createUploadTask 函数返回值
     * @returns 文件的 url
     */
    uploadFile(fileTask: V2NIMUploadFileTask, progress: V2NIMProgressCallback): Promise<string>;
    /**
     * 上传文件并返回媒体信息
     *
     * 注: 比之 {@link V2NIMStorageService.uploadFile | V2NIMStorageService.uploadFile }, 本接口额外查询文件的媒体信息, 并返回相关媒体信息
     *
     * @param fileTask 上传任务，createUploadTask 函数返回值
     * @returns 文件以及相关的媒体信息
     */
    uploadFileWithMetaInfo(fileTask: V2NIMUploadFileTask, progress: V2NIMProgressCallback): Promise<V2NIMFileMetaInfo>;
    /**
     * 取消文件上传
     *
     * @param fileTask 上传任务，createUploadTask 函数返回值
     */
    cancelUploadFile(fileTask: V2NIMUploadFileTask): Promise<void>;
    /**
     * 短链转长链
     *
     * @param url 短链
     */
    shortUrlToLong(url: string): Promise<string>;
    /**
     * 生成图片缩略链接
     *
     * 使用示例: nim.V2NIMStorageService.getImageThumbUrl(attachment, { width: 100, height: 100 })
     */
    getImageThumbUrl(attachment: V2NIMMessageAttachment, thumbSize: V2NIMSize): Promise<V2NIMGetMediaResourceInfoResult>;
    /**
     * 生成视频封面图链接
     *
     * 使用示例: nim.V2NIMStorageService.getVideoCoverUrl(attachment, { width: 100, height: 100 })
     */
    getVideoCoverUrl(attachment: V2NIMMessageAttachment, thumbSize: V2NIMSize): Promise<V2NIMGetMediaResourceInfoResult>;
}
export declare class V2NIMStorageUtil {
    /**
     * 生成图片缩略链接
     *
     * 使用 dist/esm 产物时，需要动态引入 V2NIMStorageUtil 后使用:
     * NIM.registerService(V2NIMStorageUtil, 'V2NIMStorageUtil')
     *
     * 使用示例: nim.V2NIMStorageUtil.imageThumbUrl('https://example.com/image.jpg', 100)
     *
     * @deprecated 从 10.3.0 开始废弃该接口。请使用 getImageThumbUrl
     * @param url 图片原始链接
     * @param thumbSize 缩放的尺寸
     *
     */
    imageThumbUrl(url: string, thumbSize: number): string;
    /**
     *
     * 使用 dist/esm 产物时，需要动态引入 V2NIMStorageUtil 后使用:
     * NIM.registerService(V2NIMStorageUtil, 'V2NIMStorageUtil')
     *
     * 使用示例: nim.V2NIMStorageUtil.videoCoverUrl('https://example.com/video.mp4', 10)
     *
     * 生成视频封面图链接
     * @deprecated 从 10.3.0 开始废弃该接口。请使用 getVideoCoverUrl
     * @param url 视频原始链接
     * @param offset 从第几秒开始截
     *
     */
    videoCoverUrl(url: string, offset: number): string;
}
export interface V2NIMStorageScene {
    /**
     * 场景名
     */
    sceneName: string;
    /**
     * 该场景下文件的过期时间. 单位秒.
     *
     * 最小应该大于 24 * 60 * 60, 即一天。
     * 最大值不应该大于 Math.pow(2, 31) - 1，
     */
    expireTime?: number;
}
export interface V2NIMUploadFileParams {
    /**
     * 文件对象、或者在小程序中，文件路径
     */
    fileObj: File | string;
    /**
     * 场景名
     */
    sceneName?: string;
}
export interface V2NIMUploadFileTask {
    /**
     * 任务 ID, 内部生成
     */
    taskId: string;
    /**
     * 任务参数
     */
    uploadParams: V2NIMUploadFileParams;
}
/**
 * 文件相关媒体信息
 */
export interface V2NIMFileMetaInfo {
    /**
     * 文件资源的 url 地址
     */
    url: string;
    /**
     * 文件名
     */
    name: string;
    /**
     * 文件大小，单位字节
     */
    size: number;
    /**
     * 文件后缀名
     */
    ext: string;
    /**
     * 文件摘要 md5 值
     */
    md5?: string;
    /**
     * 高度. 如果文件为图片，视频则存在此字段
     */
    height?: number;
    /**
     * 宽度. 如果文件为图片，视频则存在此字段
     */
    width?: number;
    /**
     * 文件方向. 如果文件为图片，视频则存在此字段
     */
    orientation?: string;
    /**
     * 时长. 如果文件为音频，视频则存在此字段
     */
    duration?: number;
    /**
     * 音频解码格式
     */
    audioCodec?: string;
    /**
     * 视频解码格式
     */
    videoCodec?: string;
    /**
     * 音视频文件的容器
     */
    container?: string;
}
/**
 * 文件上传进度变化回调函数。取值范围 [0, 100]
 */
export declare type V2NIMProgressCallback = (progress: number) => void;
/**
 * 缩略图，视频封面尺寸
 */
export declare type V2NIMSize = {
    /**
     * 宽度。如果不填，默认为 0，表示根据填入的高度，在保留原始宽高比的情况下，等比缩放
     *
     * 宽度、高度不能同时设置为 0，或者同时不填
     */
    width?: number;
    /**
     * 高度。如果不填， 默认为 0，表示根据填入的宽度，在保留原始宽高比的情况下，等比缩放
     *
     * 宽度、高度不能同时设置为 0，或者同时不填
     */
    height?: number;
};
export declare type V2NIMGetMediaResourceInfoResult = {
    /**
     * 获取缩略图，视频封面返回的 URL 链接地址
     */
    url: string;
};
