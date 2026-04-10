/**
 * 图片处理工具函数
 */

export interface ProcessAvatarImageOptions {
  maxSize?: number;      // 最大文件大小（字节），默认 2MB
  targetSize?: number;   // 输出尺寸，默认 256x256
  quality?: number;      // 压缩质量，默认 0.8
}

export interface ProcessedImageResult {
  dataUrl: string;
  width: number;
  height: number;
}

// 默认配置
const DEFAULT_OPTIONS: Required<ProcessAvatarImageOptions> = {
  maxSize: 2 * 1024 * 1024,  // 2MB
  targetSize: 256,
  quality: 0.8,
};

// 支持的图片类型
const VALID_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

/**
 * 检查文件类型是否有效
 */
export function isValidImageType(file: File): boolean {
  return VALID_IMAGE_TYPES.includes(file.type);
}

/**
 * 检查文件大小是否有效
 */
export function isValidImageSize(file: File, maxSizeMB: number = 2): boolean {
  return file.size <= maxSizeMB * 1024 * 1024;
}

/**
 * 压缩并裁剪图片为正方形
 */
export async function processAvatarImage(
  file: File,
  options: ProcessAvatarImageOptions = {}
): Promise<ProcessedImageResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();

    reader.onload = (e) => {
      img.src = e.target?.result as string;
    };

    reader.onerror = () => {
      reject(new Error('Failed to read file'));
    };

    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        if (!ctx) {
          reject(new Error('Failed to get canvas context'));
          return;
        }

        // 设置画布尺寸为目标尺寸
        canvas.width = opts.targetSize;
        canvas.height = opts.targetSize;

        // 计算裁剪区域（居中裁剪为正方形）
        const minDimension = Math.min(img.width, img.height);
        const sourceX = (img.width - minDimension) / 2;
        const sourceY = (img.height - minDimension) / 2;

        // 绘制图片（裁剪并缩放）
        ctx.drawImage(
          img,
          sourceX,
          sourceY,
          minDimension,
          minDimension,
          0,
          0,
          opts.targetSize,
          opts.targetSize
        );

        // 转换为 Data URL
        const dataUrl = canvas.toDataURL('image/jpeg', opts.quality);

        resolve({
          dataUrl,
          width: opts.targetSize,
          height: opts.targetSize,
        });
      } catch (error) {
        reject(error);
      }
    };

    img.onerror = () => {
      reject(new Error('Failed to load image'));
    };

    reader.readAsDataURL(file);
  });
}

/**
 * 获取文件扩展名
 */
export function getFileExtension(file: File): string {
  return file.name.split('.').pop()?.toLowerCase() || '';
}

/**
 * 格式化文件大小
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}
