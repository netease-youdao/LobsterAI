import type { LocalizedQuickAction, Prompt, QuickAction, QuickActionsConfig, QuickActionsI18n } from '../types/quickAction';
import { i18nService } from './i18n';

const CONFIG_PATH = './quick-actions.json';
const I18N_PATH = './quick-actions-i18n.json';

class QuickActionService {
  private config: QuickActionsConfig | null = null;
  private i18nData: QuickActionsI18n | null = null;
  private listeners = new Set<() => void>();

  /**
   * 加载快捷操作配置
   */
  async loadConfig(): Promise<QuickActionsConfig> {
    if (this.config) {
      return this.config;
    }

    try {
      const response = await fetch(CONFIG_PATH);
      if (!response.ok) {
        throw new Error(`Failed to load quick actions config: ${response.status}`);
      }
      const data = await response.json();
      this.config = data as QuickActionsConfig;
      return this.config;
    } catch (error) {
      console.error('Failed to load quick actions config:', error);
      // 返回空配置作为降级
      return { version: 1, actions: [] };
    }
  }

  /**
   * 加载国际化数据
   */
  async loadI18n(): Promise<QuickActionsI18n> {
    if (this.i18nData) {
      return this.i18nData;
    }

    try {
      const response = await fetch(I18N_PATH);
      if (!response.ok) {
        throw new Error(`Failed to load quick actions i18n: ${response.status}`);
      }
      const data = await response.json();
      this.i18nData = data as QuickActionsI18n;
      return this.i18nData;
    } catch (error) {
      console.error('Failed to load quick actions i18n:', error);
      // 返回空数据作为降级
      return { zh: {}, en: {} };
    }
  }

  /**
   * 获取所有快捷操作（已本地化）
   */
  async getLocalizedActions(): Promise<LocalizedQuickAction[]> {
    const config = await this.loadConfig();
    const i18nData = await this.loadI18n();
    const language = i18nService.getLanguage();

    return config.actions.map(action => {
      const actionI18n = i18nData[language]?.[action.id];

      return {
        ...action,
        label: actionI18n?.label || action.id,
        prompts: action.prompts.map(prompt => {
          const promptI18n = actionI18n?.prompts?.[prompt.id];

          return {
            id: prompt.id,
            label: promptI18n?.label || prompt.id,
            description: promptI18n?.description,
            prompt: promptI18n?.prompt || ''
          };
        })
      };
    });
  }

  /**
   * 获取所有快捷操作（原始数据）
   */
  async getActions(): Promise<QuickAction[]> {
    const config = await this.loadConfig();
    return config.actions;
  }

  /**
   * 根据 ID 获取快捷操作（已本地化）
   */
  async getLocalizedActionById(id: string): Promise<LocalizedQuickAction | undefined> {
    const actions = await this.getLocalizedActions();
    return actions.find(action => action.id === id);
  }

  /**
   * 根据 ID 获取快捷操作（原始数据）
   */
  async getActionById(id: string): Promise<QuickAction | undefined> {
    const actions = await this.getActions();
    return actions.find(action => action.id === id);
  }

  /**
   * 根据 actionId 和 promptId 获取提示词（原始数据）
   */
  async getPrompt(actionId: string, promptId: string): Promise<Prompt | undefined> {
    const action = await this.getActionById(actionId);
    if (!action) return undefined;
    return action.prompts.find(prompt => prompt.id === promptId);
  }

  /**
   * 根据 skillMapping 获取对应的快捷操作（已本地化）
   */
  async getLocalizedActionBySkillMapping(skillMapping: string): Promise<LocalizedQuickAction | undefined> {
    const actions = await this.getLocalizedActions();
    return actions.find(action => action.skillMapping === skillMapping);
  }

  /**
   * 根据 skillMapping 获取对应的快捷操作（原始数据）
   */
  async getActionBySkillMapping(skillMapping: string): Promise<QuickAction | undefined> {
    const actions = await this.getActions();
    return actions.find(action => action.skillMapping === skillMapping);
  }

  /**
   * 订阅语言变化事件
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 通知所有订阅者
   */
  private notifyListeners(): void {
    this.listeners.forEach(listener => listener());
  }

  /**
   * 清除缓存（用于重新加载）
   */
  clearCache(): void {
    this.config = null;
    this.i18nData = null;
    this.notifyListeners();
  }

  /**
   * 初始化服务（订阅语言变化）
   */
  initialize(): void {
    // 订阅 i18n 服务的语言变化事件
    i18nService.subscribe(() => {
      this.clearCache();
    });
  }
}

export const quickActionService = new QuickActionService();
