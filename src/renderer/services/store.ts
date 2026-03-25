// 删除重复的类型声明，使用全局类型定义
export interface LocalStore {
  getItem<T>(key: string): Promise<T | null>;
  setItem<T>(key: string, value: T): Promise<void>;
  removeItem(key: string): Promise<void>;
}

class LocalStoreService implements LocalStore {
  async getItem<T>(key: string): Promise<T | null> {
    try {
      const value = await window.electron.store.get(key);
      return value || null;
    } catch (error) {
      console.error('Failed to get item from store:', error);
      return null;
    }
  }

  async setItem<T>(key: string, value: T, options?: { reason?: string }): Promise<void> {
    try {
      await window.electron.store.set(key, value, options);
    } catch (error) {
      console.error('Failed to set item in store:', error);
      throw error;
    }
  }

  async removeItem(key: string): Promise<void> {
    try {
      await window.electron.store.remove(key);
    } catch (error) {
      console.error('Failed to remove item from store:', error);
      throw error;
    }
  }
}

export const localStore = new LocalStoreService(); 