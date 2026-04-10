import { CONFIG_KEYS } from '../config';
import type { PresetAvatarId,UserAvatarConfig } from '../types/avatar';
import { localStore } from './store';

class AvatarService {
  /**
   * 获取当前头像配置
   */
  async getAvatarConfig(): Promise<UserAvatarConfig | null> {
    try {
      const config = await localStore.getItem<UserAvatarConfig>(CONFIG_KEYS.USER_AVATAR);
      return config;
    } catch (error) {
      console.error('[AvatarService] Failed to get avatar config:', error);
      return null;
    }
  }

  /**
   * 保存头像配置
   */
  async saveAvatarConfig(config: UserAvatarConfig): Promise<void> {
    try {
      const configWithTimestamp: UserAvatarConfig = {
        ...config,
        updatedAt: Date.now(),
      };
      await localStore.setItem(CONFIG_KEYS.USER_AVATAR, configWithTimestamp);
      // 触发配置更新事件
      window.dispatchEvent(new CustomEvent('avatar-updated'));
    } catch (error) {
      console.error('[AvatarService] Failed to save avatar config:', error);
      throw error;
    }
  }

  /**
   * 删除头像配置（恢复默认）
   */
  async removeAvatarConfig(): Promise<void> {
    try {
      await localStore.removeItem(CONFIG_KEYS.USER_AVATAR);
      window.dispatchEvent(new CustomEvent('avatar-updated'));
    } catch (error) {
      console.error('[AvatarService] Failed to remove avatar config:', error);
      throw error;
    }
  }

  /**
   * 上传图片并转换为配置
   */
  async uploadImage(file: File): Promise<{ success: boolean; config?: UserAvatarConfig; error?: string }> {
    try {
      // 动态导入图片处理工具
      const { processAvatarImage, isValidImageType, isValidImageSize } = await import('../utils/imageUtils');

      // 验证文件类型
      if (!isValidImageType(file)) {
        return {
          success: false,
          error: 'avatarUploadErrorType',
        };
      }

      // 验证文件大小
      if (!isValidImageSize(file, 2)) {
        return {
          success: false,
          error: 'avatarUploadErrorSize',
        };
      }

      // 处理图片
      const result = await processAvatarImage(file, {
        maxSize: 2 * 1024 * 1024,
        targetSize: 256,
        quality: 0.8,
      });

      const config: UserAvatarConfig = {
        type: 'custom',
        customUrl: result.dataUrl,
      };

      return {
        success: true,
        config,
      };
    } catch (error) {
      console.error('[AvatarService] Failed to upload image:', error);
      return {
        success: false,
        error: 'avatarUploadErrorProcess',
      };
    }
  }

  /**
   * 设置预置头像
   */
  async setPresetAvatar(presetId: PresetAvatarId): Promise<void> {
    const config: UserAvatarConfig = {
      type: 'preset',
      presetId,
    };
    await this.saveAvatarConfig(config);
  }

  /**
   * 设置自定义头像
   */
  async setCustomAvatar(dataUrl: string): Promise<void> {
    const config: UserAvatarConfig = {
      type: 'custom',
      customUrl: dataUrl,
    };
    await this.saveAvatarConfig(config);
  }

  /**
   * 生成默认头像配置
   */
  generateDefaultAvatar(nickname: string): { bg: string; text: string } {
    // 使用昵称首字母或默认字符
    const firstChar = nickname?.charAt(0)?.toUpperCase() || '?';

    // 生成基于昵称的渐变色
    const gradients = [
      'from-blue-500 to-indigo-600',
      'from-emerald-500 to-teal-600',
      'from-violet-500 to-purple-600',
      'from-rose-500 to-pink-600',
      'from-amber-500 to-orange-600',
      'from-cyan-500 to-blue-600',
    ];

    // 根据昵称哈希选择渐变色
    const hash = nickname?.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) || 0;
    const bg = gradients[hash % gradients.length];

    return { bg, text: firstChar };
  }
}

export const avatarService = new AvatarService();
