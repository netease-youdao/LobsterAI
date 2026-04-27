export const NimDownloadPlatform = {
  Android: 'android',
  Ios: 'ios',
} as const;

export type NimDownloadPlatform = typeof NimDownloadPlatform[keyof typeof NimDownloadPlatform];

export const NimDownloadQrImage = {
  [NimDownloadPlatform.Android]: 'https://yx-web-nosdn.netease.im/common/e093fd33c08db9ef2bd5d9764725effb/image.png',
  [NimDownloadPlatform.Ios]: 'https://yx-web-nosdn.netease.im/common/41ae96122f6810e37d421c2ddf4d8372/yunxin-im.png',
} as const;
