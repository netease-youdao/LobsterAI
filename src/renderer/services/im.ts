/**
 * IM Service
 * IPC wrapper for IM gateway operations
 */

import { store } from '../store';
import { PlatformRegistry } from '@shared/platform';
import type { Platform } from '@shared/platform';
import {
  setConfig,
  setStatus,
  setLoading,
  setError,
  addQQInstance,
  removeQQInstance,
  setQQInstanceConfig,
  addFeishuInstance,
  removeFeishuInstance,
  setFeishuInstanceConfig,
  addDingTalkInstance,
  removeDingTalkInstance,
  setDingTalkInstanceConfig,
} from '../store/slices/imSlice';
import type {
  IMGatewayConfig,
  IMGatewayStatus,
  IMConfigResult,
  IMStatusResult,
  IMGatewayResult,
  IMConnectivityTestResult,
  IMConnectivityTestResponse,
  QQOpenClawConfig,
  QQInstanceConfig,
  FeishuOpenClawConfig,
  FeishuInstanceConfig,
  DingTalkOpenClawConfig,
  DingTalkInstanceConfig,
} from '../types/im';

class IMService {
  private statusUnsubscribe: (() => void) | null = null;
  private messageUnsubscribe: (() => void) | null = null;
  private initPromise: Promise<void> | null = null;

  /**
   * Initialize IM service (with concurrency guard to prevent duplicate init)
   */
  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._doInit();
    return this.initPromise;
  }

  private async _doInit(): Promise<void> {
    // Set up status change listener
    this.statusUnsubscribe = window.electron.im.onStatusChange((status: IMGatewayStatus) => {
      store.dispatch(setStatus(status));
    });

    // Set up message listener (for logging/monitoring)
    this.messageUnsubscribe = window.electron.im.onMessageReceived((message) => {
      console.log('[IM Service] Message received:', message);
    });

    // Load initial config and status
    await this.loadConfig();
    await this.loadStatus();
  }

  /**
   * Clean up listeners
   */
  destroy(): void {
    if (this.statusUnsubscribe) {
      this.statusUnsubscribe();
      this.statusUnsubscribe = null;
    }
    if (this.messageUnsubscribe) {
      this.messageUnsubscribe();
      this.messageUnsubscribe = null;
    }
    this.initPromise = null;
  }

  /**
   * Load configuration from main process
   */
  async loadConfig(): Promise<IMGatewayConfig | null> {
    try {
      store.dispatch(setLoading(true));
      const result: IMConfigResult = await window.electron.im.getConfig();
      if (result.success && result.config) {
        store.dispatch(setConfig(result.config));
        return result.config;
      } else {
        store.dispatch(setError(result.error || 'Failed to load IM config'));
        return null;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load IM config';
      store.dispatch(setError(message));
      return null;
    } finally {
      store.dispatch(setLoading(false));
    }
  }

  /**
   * Load status from main process
   */
  async loadStatus(): Promise<IMGatewayStatus | null> {
    try {
      const result: IMStatusResult = await window.electron.im.getStatus();
      if (result.success && result.status) {
        store.dispatch(setStatus(result.status));
        return result.status;
      }
      return null;
    } catch (error) {
      console.error('[IM Service] Failed to load status:', error);
      return null;
    }
  }

  /**
   * Update configuration and trigger gateway sync/restart.
   * Used by toggleGateway and other operations that need immediate effect.
   */
  async updateConfig(config: Partial<IMGatewayConfig>): Promise<boolean> {
    try {
      store.dispatch(setLoading(true));
      const result: IMGatewayResult = await window.electron.im.setConfig(config, { syncGateway: true });
      if (result.success) {
        // Reload config to get merged values
        await this.loadConfig();
        return true;
      } else {
        store.dispatch(setError(result.error || 'Failed to update IM config'));
        return false;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update IM config';
      store.dispatch(setError(message));
      return false;
    } finally {
      store.dispatch(setLoading(false));
    }
  }

  /**
   * Persist configuration to DB without triggering gateway sync/restart.
   * Used by onBlur handlers to save field values silently.
   */
  async persistConfig(config: Partial<IMGatewayConfig>): Promise<boolean> {
    try {
      const result: IMGatewayResult = await window.electron.im.setConfig(config, { syncGateway: false });
      if (result.success) {
        return true;
      } else {
        console.error('[IM Service] Failed to persist config:', result.error);
        return false;
      }
    } catch (error) {
      console.error('[IM Service] Failed to persist config:', error);
      return false;
    }
  }

  /**
   * Sync IM gateway config (regenerate openclaw.json and restart gateway).
   * Called from the global Settings Save button.
   */
  async saveAndSyncConfig(): Promise<boolean> {
    try {
      const result: IMGatewayResult = await window.electron.im.syncConfig();
      return result.success;
    } catch (error) {
      console.error('[IM Service] Failed to sync IM config:', error);
      return false;
    }
  }

  /**
   * Start a gateway
   */
  async startGateway(platform: Platform): Promise<boolean> {
    try {
      store.dispatch(setLoading(true));
      store.dispatch(setError(null));
      const result: IMGatewayResult = await window.electron.im.startGateway(platform);
      if (result.success) {
        await this.loadStatus();
        return true;
      } else {
        store.dispatch(setError(result.error || `Failed to start ${platform} gateway`));
        return false;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : `Failed to start ${platform} gateway`;
      store.dispatch(setError(message));
      return false;
    } finally {
      store.dispatch(setLoading(false));
    }
  }

  /**
   * Stop a gateway
   */
  async stopGateway(platform: Platform): Promise<boolean> {
    try {
      store.dispatch(setLoading(true));
      const result: IMGatewayResult = await window.electron.im.stopGateway(platform);
      if (result.success) {
        await this.loadStatus();
        return true;
      } else {
        store.dispatch(setError(result.error || `Failed to stop ${platform} gateway`));
        return false;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : `Failed to stop ${platform} gateway`;
      store.dispatch(setError(message));
      return false;
    } finally {
      store.dispatch(setLoading(false));
    }
  }

  /**
   * Test gateway connectivity and conversation readiness
   */
  async testGateway(
    platform: Platform,
    configOverride?: Partial<IMGatewayConfig>
  ): Promise<IMConnectivityTestResult | null> {
    try {
      store.dispatch(setLoading(true));
      const result: IMConnectivityTestResponse = await window.electron.im.testGateway(platform, configOverride);
      if (result.success && result.result) {
        return result.result;
      }
      store.dispatch(setError(result.error || `Failed to test ${platform} connectivity`));
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : `Failed to test ${platform} connectivity`;
      store.dispatch(setError(message));
      return null;
    } finally {
      store.dispatch(setLoading(false));
    }
  }

  /**
   * Get current config from store
   */
  getConfig(): IMGatewayConfig {
    return store.getState().im.config;
  }

  /**
   * Get current status from store
   */
  getStatus(): IMGatewayStatus {
    return store.getState().im.status;
  }

  /**
   * Check if any gateway is connected
   */
  isAnyConnected(): boolean {
    const status = this.getStatus();
    return PlatformRegistry.platforms.some(p => {
      const s = status[p];
      if (p === 'qq' || p === 'feishu' || p === 'dingtalk') {
        return (s as any)?.instances?.some((i: any) => i.connected);
      }
      return (s as any)?.connected;
    });
  }

  /**
   * List pending pairing requests and approved allowFrom for a platform
   */
  async listPairingRequests(platform: string) {
    return window.electron.im.listPairingRequests(platform);
  }

  /**
   * Approve a pairing code
   */
  async approvePairingCode(platform: string, code: string) {
    return window.electron.im.approvePairingCode(platform, code);
  }

  /**
   * Reject a pairing request
   */
  async rejectPairingRequest(platform: string, code: string) {
    return window.electron.im.rejectPairingRequest(platform, code);
  }

  /**
   * Fetch the OpenClaw config schema (JSON Schema + uiHints) from the gateway.
   */
  async getOpenClawConfigSchema(): Promise<{ schema: Record<string, unknown>; uiHints: Record<string, Record<string, unknown>> } | null> {
    try {
      const result = await window.electron.im.getOpenClawConfigSchema();
      if (result.success && result.result) {
        return result.result;
      }
      return null;
    } catch {
      return null;
    }
  }

  // ==================== DingTalk Multi-Instance Operations ====================

  async addDingTalkInstance(name: string): Promise<DingTalkInstanceConfig | null> {
    try {
      const result = await window.electron.im.addDingTalkInstance(name);
      if (result.success && result.instance) {
        store.dispatch(addDingTalkInstance(result.instance));
        return result.instance;
      }
      console.error('[IM Service] Failed to add DingTalk instance:', result.error);
      return null;
    } catch (error) {
      console.error('[IM Service] Failed to add DingTalk instance:', error);
      return null;
    }
  }

  async deleteDingTalkInstance(instanceId: string): Promise<boolean> {
    try {
      const result = await window.electron.im.deleteDingTalkInstance(instanceId);
      if (result.success) {
        store.dispatch(removeDingTalkInstance(instanceId));
        return true;
      }
      console.error('[IM Service] Failed to delete DingTalk instance:', result.error);
      return false;
    } catch (error) {
      console.error('[IM Service] Failed to delete DingTalk instance:', error);
      return false;
    }
  }

  async persistDingTalkInstanceConfig(instanceId: string, config: Partial<DingTalkOpenClawConfig>): Promise<boolean> {
    try {
      const result = await window.electron.im.setDingTalkInstanceConfig(instanceId, config, { syncGateway: false });
      if (result.success) {
        store.dispatch(setDingTalkInstanceConfig({ instanceId, config }));
        return true;
      }
      console.error('[IM Service] Failed to persist DingTalk instance config:', result.error);
      return false;
    } catch (error) {
      console.error('[IM Service] Failed to persist DingTalk instance config:', error);
      return false;
    }
  }

  async updateDingTalkInstanceConfig(instanceId: string, config: Partial<DingTalkOpenClawConfig>): Promise<boolean> {
    try {
      store.dispatch(setLoading(true));
      const result = await window.electron.im.setDingTalkInstanceConfig(instanceId, config, { syncGateway: true });
      if (result.success) {
        await this.loadConfig();
        await this.loadStatus();
        return true;
      }
      store.dispatch(setError(result.error || 'Failed to update DingTalk instance config'));
      return false;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update DingTalk instance config';
      store.dispatch(setError(message));
      return false;
    } finally {
      store.dispatch(setLoading(false));
    }
  }

  // ==================== QQ Multi-Instance Operations ====================

  async addQQInstance(name: string): Promise<QQInstanceConfig | null> {
    try {
      const result = await window.electron.im.addQQInstance(name);
      if (result.success && result.instance) {
        store.dispatch(addQQInstance(result.instance));
        return result.instance;
      }
      console.error('[IM Service] Failed to add QQ instance:', result.error);
      return null;
    } catch (error) {
      console.error('[IM Service] Failed to add QQ instance:', error);
      return null;
    }
  }

  async deleteQQInstance(instanceId: string): Promise<boolean> {
    try {
      const result = await window.electron.im.deleteQQInstance(instanceId);
      if (result.success) {
        store.dispatch(removeQQInstance(instanceId));
        return true;
      }
      console.error('[IM Service] Failed to delete QQ instance:', result.error);
      return false;
    } catch (error) {
      console.error('[IM Service] Failed to delete QQ instance:', error);
      return false;
    }
  }

  async persistQQInstanceConfig(instanceId: string, config: Partial<QQOpenClawConfig>): Promise<boolean> {
    try {
      const result = await window.electron.im.setQQInstanceConfig(instanceId, config, { syncGateway: false });
      if (result.success) {
        store.dispatch(setQQInstanceConfig({ instanceId, config }));
        return true;
      }
      console.error('[IM Service] Failed to persist QQ instance config:', result.error);
      return false;
    } catch (error) {
      console.error('[IM Service] Failed to persist QQ instance config:', error);
      return false;
    }
  }

  async updateQQInstanceConfig(instanceId: string, config: Partial<QQOpenClawConfig>): Promise<boolean> {
    try {
      store.dispatch(setLoading(true));
      const result = await window.electron.im.setQQInstanceConfig(instanceId, config, { syncGateway: true });
      if (result.success) {
        await this.loadConfig();
        await this.loadStatus();
        return true;
      }
      store.dispatch(setError(result.error || 'Failed to update QQ instance config'));
      return false;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update QQ instance config';
      store.dispatch(setError(message));
      return false;
    } finally {
      store.dispatch(setLoading(false));
    }
  }

  // ==================== Feishu Multi-Instance Operations ====================

  async addFeishuInstance(name: string): Promise<FeishuInstanceConfig | null> {
    try {
      const result = await window.electron.im.addFeishuInstance(name);
      if (result.success && result.instance) {
        store.dispatch(addFeishuInstance(result.instance));
        return result.instance;
      }
      console.error('[IM Service] Failed to add Feishu instance:', result.error);
      return null;
    } catch (error) {
      console.error('[IM Service] Failed to add Feishu instance:', error);
      return null;
    }
  }

  async deleteFeishuInstance(instanceId: string): Promise<boolean> {
    try {
      const result = await window.electron.im.deleteFeishuInstance(instanceId);
      if (result.success) {
        store.dispatch(removeFeishuInstance(instanceId));
        return true;
      }
      console.error('[IM Service] Failed to delete Feishu instance:', result.error);
      return false;
    } catch (error) {
      console.error('[IM Service] Failed to delete Feishu instance:', error);
      return false;
    }
  }

  async persistFeishuInstanceConfig(instanceId: string, config: Partial<FeishuOpenClawConfig>): Promise<boolean> {
    try {
      const result = await window.electron.im.setFeishuInstanceConfig(instanceId, config, { syncGateway: false });
      if (result.success) {
        store.dispatch(setFeishuInstanceConfig({ instanceId, config }));
        return true;
      }
      console.error('[IM Service] Failed to persist Feishu instance config:', result.error);
      return false;
    } catch (error) {
      console.error('[IM Service] Failed to persist Feishu instance config:', error);
      return false;
    }
  }

  async updateFeishuInstanceConfig(instanceId: string, config: Partial<FeishuOpenClawConfig>): Promise<boolean> {
    try {
      store.dispatch(setLoading(true));
      const result = await window.electron.im.setFeishuInstanceConfig(instanceId, config, { syncGateway: true });
      if (result.success) {
        await this.loadConfig();
        await this.loadStatus();
        return true;
      }
      store.dispatch(setError(result.error || 'Failed to update Feishu instance config'));
      return false;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update Feishu instance config';
      store.dispatch(setError(message));
      return false;
    } finally {
      store.dispatch(setLoading(false));
    }
  }
}

export const imService = new IMService();
