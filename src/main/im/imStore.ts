/**
 * IM Gateway Store
 * SQLite operations for IM configuration storage
 */

import { Database } from 'sql.js';
import {
  IMGatewayConfig,
  DingTalkOpenClawConfig,
  FeishuOpenClawConfig,
  TelegramOpenClawConfig,
  QQConfig,
  DiscordOpenClawConfig,
  NimConfig,
  XiaomifengConfig,
  WecomOpenClawConfig,
  PopoOpenClawConfig,
  WeixinOpenClawConfig,
  IMSettings,
  IMPlatform,
  IMSessionMapping,
  DEFAULT_DINGTALK_OPENCLAW_CONFIG,
  DEFAULT_FEISHU_OPENCLAW_CONFIG,
  DEFAULT_TELEGRAM_OPENCLAW_CONFIG,
  DEFAULT_QQ_CONFIG,
  DEFAULT_DISCORD_OPENCLAW_CONFIG,
  DEFAULT_NIM_CONFIG,
  DEFAULT_XIAOMIFENG_CONFIG,
  DEFAULT_WECOM_CONFIG,
  DEFAULT_POPO_CONFIG,
  DEFAULT_WEIXIN_CONFIG,
  DEFAULT_IM_SETTINGS,
} from './types';

interface StoredConversationReplyRoute {
  channel: string;
  to: string;
  accountId?: string;
}

export class IMStore {
  private db: Database;
  private saveDb: () => void;

  constructor(db: Database, saveDb: () => void) {
    this.db = db;
    this.saveDb = saveDb;
    this.initializeTables();
    this.migrateDefaults();
  }

  private initializeTables() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS im_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    // IM session mappings table for Cowork mode
    this.db.run(`
      CREATE TABLE IF NOT EXISTS im_session_mappings (
        im_conversation_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        cowork_session_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL,
        PRIMARY KEY (im_conversation_id, platform)
      );
    `);

    // Migration: Add agent_id column to im_session_mappings
    const mappingCols = this.db.exec('PRAGMA table_info(im_session_mappings)');
    const mappingColNames = (mappingCols[0]?.values ?? []).map((r) => r[1] as string);
    if (!mappingColNames.includes('agent_id')) {
      this.db.run("ALTER TABLE im_session_mappings ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'main'");
    }

    this.saveDb();
  }

  /**
   * Migrate existing IM configs to ensure stable defaults.
   */
  private migrateDefaults(): void {
    const platforms = ['dingtalk', 'feishu', 'telegram', 'discord', 'nim', 'xiaomifeng', 'qq', 'wecom', 'popo', 'weixin'] as const;
    let changed = false;

    for (const platform of platforms) {
      const result = this.db.exec('SELECT value FROM im_config WHERE key = ?', [platform]);
      if (!result[0]?.values[0]) continue;

      try {
        const config = JSON.parse(result[0].values[0][0] as string);
        if (config.debug === undefined || config.debug === false) {
          config.debug = true;
          const now = Date.now();
          this.db.run(
            'UPDATE im_config SET value = ?, updated_at = ? WHERE key = ?',
            [JSON.stringify(config), now, platform]
          );
          changed = true;
        }
      } catch {
        // Ignore parse errors
      }
    }

    const settingsResult = this.db.exec('SELECT value FROM im_config WHERE key = ?', ['settings']);
    if (settingsResult[0]?.values[0]) {
      try {
        const settings = JSON.parse(settingsResult[0].values[0][0] as string) as Partial<IMSettings>;
        // Keep IM and desktop behavior aligned: skills auto-routing should be on by default.
        // Historical renderer default could persist `skillsEnabled: false` unintentionally.
        if (settings.skillsEnabled !== true) {
          settings.skillsEnabled = true;
          const now = Date.now();
          this.db.run(
            'UPDATE im_config SET value = ?, updated_at = ? WHERE key = ?',
            [JSON.stringify(settings), now, 'settings']
          );
          changed = true;
        }
      } catch {
        // Ignore parse errors
      }
    }

    // Migrate feishu renderMode from 'text' to 'card' (previous renderer default was incorrect)
    const feishuResult = this.db.exec('SELECT value FROM im_config WHERE key = ?', ['feishu']);
    if (feishuResult[0]?.values[0]) {
      try {
        const feishuConfig = JSON.parse(feishuResult[0].values[0][0] as string) as Partial<{ renderMode: string }>;
        if (feishuConfig.renderMode === 'text') {
          feishuConfig.renderMode = 'card';
          const now = Date.now();
          this.db.run(
            'UPDATE im_config SET value = ?, updated_at = ? WHERE key = ?',
            [JSON.stringify(feishuConfig), now, 'feishu']
          );
          changed = true;
        }
      } catch {
        // Ignore parse errors
      }
    }

    // Migrate old native Telegram config to new OpenClaw format
    const oldTelegramResult = this.db.exec('SELECT value FROM im_config WHERE key = ?', ['telegram']);
    const newTelegramResult = this.db.exec('SELECT value FROM im_config WHERE key = ?', ['telegramOpenClaw']);
    if (oldTelegramResult[0]?.values[0] && !newTelegramResult[0]?.values[0]) {
      try {
        const oldConfig = JSON.parse(oldTelegramResult[0].values[0][0] as string) as {
          enabled?: boolean;
          botToken?: string;
          allowedUserIds?: string[];
          debug?: boolean;
        };
        if (oldConfig.botToken) {
          const hasAllowList = Array.isArray(oldConfig.allowedUserIds) && oldConfig.allowedUserIds.length > 0;
          const newConfig = {
            ...DEFAULT_TELEGRAM_OPENCLAW_CONFIG,
            enabled: oldConfig.enabled ?? false,
            botToken: oldConfig.botToken,
            allowFrom: oldConfig.allowedUserIds ?? [],
            dmPolicy: hasAllowList ? 'allowlist' as const : 'pairing' as const,
            debug: oldConfig.debug ?? true,
          };
          const now = Date.now();
          this.db.run(
            'INSERT OR REPLACE INTO im_config (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)',
            ['telegramOpenClaw', JSON.stringify(newConfig), now, now]
          );
          this.db.run('DELETE FROM im_config WHERE key = ?', ['telegram']);
          changed = true;
          console.log('[IMStore] Migrated old Telegram config to OpenClaw format');
        }
      } catch {
        // Ignore parse errors
      }
    }

    // Migrate old native Discord config to new OpenClaw format
    const oldDiscordResult = this.db.exec('SELECT value FROM im_config WHERE key = ?', ['discord']);
    const newDiscordResult = this.db.exec('SELECT value FROM im_config WHERE key = ?', ['discordOpenClaw']);
    if (oldDiscordResult[0]?.values[0] && !newDiscordResult[0]?.values[0]) {
      try {
        const oldConfig = JSON.parse(oldDiscordResult[0].values[0][0] as string) as {
          enabled?: boolean;
          botToken?: string;
          debug?: boolean;
        };
        if (oldConfig.botToken) {
          const newConfig = {
            ...DEFAULT_DISCORD_OPENCLAW_CONFIG,
            enabled: oldConfig.enabled ?? false,
            botToken: oldConfig.botToken,
            debug: oldConfig.debug ?? true,
          };
          const now = Date.now();
          this.db.run(
            'INSERT OR REPLACE INTO im_config (key, value, updated_at) VALUES (?, ?, ?)',
            ['discordOpenClaw', JSON.stringify(newConfig), now]
          );
          this.db.run('DELETE FROM im_config WHERE key = ?', ['discord']);
          changed = true;
          console.log('[IMStore] Migrated old Discord config to OpenClaw format');
        }
      } catch {
        // Ignore parse errors
      }
    }

    // Migrate old native Feishu config to new OpenClaw format
    const oldFeishuResult2 = this.db.exec('SELECT value FROM im_config WHERE key = ?', ['feishu']);
    const newFeishuResult = this.db.exec('SELECT value FROM im_config WHERE key = ?', ['feishuOpenClaw']);
    if (oldFeishuResult2[0]?.values[0] && !newFeishuResult[0]?.values[0]) {
      try {
        const oldConfig = JSON.parse(oldFeishuResult2[0].values[0][0] as string) as Partial<{ enabled: boolean; appId: string; appSecret: string; domain: string; debug: boolean }>;
        if (oldConfig.appId) {
          const newConfig: FeishuOpenClawConfig = {
            ...DEFAULT_FEISHU_OPENCLAW_CONFIG,
            enabled: oldConfig.enabled ?? false,
            appId: oldConfig.appId,
            appSecret: oldConfig.appSecret ?? '',
            domain: oldConfig.domain || 'feishu',
            debug: oldConfig.debug ?? true,
          };
          const now = Date.now();
          this.db.run(
            'INSERT OR REPLACE INTO im_config (key, value, updated_at) VALUES (?, ?, ?)',
            ['feishuOpenClaw', JSON.stringify(newConfig), now]
          );
          this.db.run('DELETE FROM im_config WHERE key = ?', ['feishu']);
          changed = true;
          console.log('[IMStore] Migrated old Feishu config to OpenClaw format');
        }
      } catch {
        // Ignore parse errors
      }
    }

    // Migrate old native DingTalk config to new OpenClaw format
    const oldDingtalkResult = this.db.exec('SELECT value FROM im_config WHERE key = ?', ['dingtalk']);
    const newDingtalkResult = this.db.exec('SELECT value FROM im_config WHERE key = ?', ['dingtalkOpenClaw']);
    if (oldDingtalkResult[0]?.values[0] && !newDingtalkResult[0]?.values[0]) {
      try {
        const oldConfig = JSON.parse(oldDingtalkResult[0].values[0][0] as string) as Partial<{ enabled: boolean; clientId: string; clientSecret: string; debug: boolean }>;
        if (oldConfig.clientId) {
          const newConfig: DingTalkOpenClawConfig = {
            ...DEFAULT_DINGTALK_OPENCLAW_CONFIG,
            enabled: oldConfig.enabled ?? false,
            clientId: oldConfig.clientId,
            clientSecret: oldConfig.clientSecret ?? '',
            debug: oldConfig.debug ?? false,
          };
          const now = Date.now();
          this.db.run(
            'INSERT OR REPLACE INTO im_config (key, value, updated_at) VALUES (?, ?, ?)',
            ['dingtalkOpenClaw', JSON.stringify(newConfig), now]
          );
          this.db.run('DELETE FROM im_config WHERE key = ?', ['dingtalk']);
          changed = true;
          console.log('[IMStore] Migrated old DingTalk config to OpenClaw format');
        }
      } catch {
        // Ignore parse errors
      }
    }

    // Migrate old native WeCom config to new OpenClaw format
    const oldWecomResult = this.db.exec('SELECT value FROM im_config WHERE key = ?', ['wecom']);
    const newWecomResult = this.db.exec('SELECT value FROM im_config WHERE key = ?', ['wecomOpenClaw']);
    if (oldWecomResult[0]?.values[0] && !newWecomResult[0]?.values[0]) {
      try {
        const oldConfig = JSON.parse(oldWecomResult[0].values[0][0] as string) as Partial<{ enabled: boolean; botId: string; secret: string; debug: boolean }>;
        if (oldConfig.botId) {
          const newConfig: WecomOpenClawConfig = {
            ...DEFAULT_WECOM_CONFIG,
            enabled: oldConfig.enabled ?? false,
            botId: oldConfig.botId,
            secret: oldConfig.secret ?? '',
            debug: oldConfig.debug ?? true,
          };
          const now = Date.now();
          this.db.run(
            'INSERT OR REPLACE INTO im_config (key, value, updated_at) VALUES (?, ?, ?)',
            ['wecomOpenClaw', JSON.stringify(newConfig), now]
          );
          this.db.run('DELETE FROM im_config WHERE key = ?', ['wecom']);
          changed = true;
          console.log('[IMStore] Migrated old WeCom config to OpenClaw format');
        }
      } catch {
        // Ignore parse errors
      }
    }

    // Migrate popo configs that have token but no connectionMode:
    // These are existing webhook users from before connectionMode was introduced.
    // Preserve their setup by explicitly setting connectionMode to 'webhook'.
    const popoResult = this.db.exec('SELECT value FROM im_config WHERE key = ?', ['popo']);
    if (popoResult[0]?.values[0]) {
      try {
        const popoConfig = JSON.parse(popoResult[0].values[0][0] as string) as Partial<PopoOpenClawConfig>;
        if (popoConfig.token && !popoConfig.connectionMode) {
          popoConfig.connectionMode = 'webhook';
          const now = Date.now();
          this.db.run(
            'UPDATE im_config SET value = ?, updated_at = ? WHERE key = ?',
            [JSON.stringify(popoConfig), now, 'popo']
          );
          changed = true;
          console.log('[IMStore] Migrated popo config: inferred connectionMode=webhook from existing token');
        }
      } catch {
        // Ignore parse errors
      }
    }

    if (changed) {
      this.saveDb();
    }
  }

  // ==================== Generic Config Operations ====================

  private getConfigValue<T>(key: string): T | undefined {
    const result = this.db.exec('SELECT value FROM im_config WHERE key = ?', [key]);
    if (!result[0]?.values[0]) return undefined;
    const value = result[0].values[0][0] as string;
    try {
      return JSON.parse(value) as T;
    } catch (error) {
      console.warn(`Failed to parse im_config value for ${key}`, error);
      return undefined;
    }
  }

  private setConfigValue<T>(key: string, value: T): void {
    const now = Date.now();
    this.db.run(`
      INSERT INTO im_config (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `, [key, JSON.stringify(value), now]);
    this.saveDb();
  }

  // ==================== Full Config Operations ====================

  getConfig(): IMGatewayConfig {
    const dingtalk = this.getConfigValue<DingTalkOpenClawConfig>('dingtalkOpenClaw') ?? DEFAULT_DINGTALK_OPENCLAW_CONFIG;
    const feishu = this.getConfigValue<FeishuOpenClawConfig>('feishuOpenClaw') ?? DEFAULT_FEISHU_OPENCLAW_CONFIG;
    const telegram = this.getConfigValue<TelegramOpenClawConfig>('telegramOpenClaw') ?? DEFAULT_TELEGRAM_OPENCLAW_CONFIG;
    const discord = this.getConfigValue<DiscordOpenClawConfig>('discordOpenClaw') ?? DEFAULT_DISCORD_OPENCLAW_CONFIG;
    const nim = this.getConfigValue<NimConfig>('nim') ?? DEFAULT_NIM_CONFIG;
    const xiaomifeng = this.getConfigValue<XiaomifengConfig>('xiaomifeng') ?? DEFAULT_XIAOMIFENG_CONFIG;
    const qq = this.getConfigValue<QQConfig>('qq') ?? DEFAULT_QQ_CONFIG;
    const wecom = this.getConfigValue<WecomOpenClawConfig>('wecomOpenClaw') ?? DEFAULT_WECOM_CONFIG;
    const popo = this.getConfigValue<PopoOpenClawConfig>('popo') ?? DEFAULT_POPO_CONFIG;
    const weixin = this.getConfigValue<WeixinOpenClawConfig>('weixin') ?? DEFAULT_WEIXIN_CONFIG;
    const settings = this.getConfigValue<IMSettings>('settings') ?? DEFAULT_IM_SETTINGS;

    // Resolve enabled field: default to false for safety
    // User must explicitly enable the service by setting enabled: true
    const resolveEnabled = <T extends { enabled?: boolean }>(stored: T, defaults: T): T => {
      const merged = { ...defaults, ...stored };
      // If enabled is not explicitly set, default to false (safer behavior)
      if (stored.enabled === undefined) {
        return { ...merged, enabled: false };
      }
      return merged;
    };

    return {
      dingtalk: resolveEnabled(dingtalk, DEFAULT_DINGTALK_OPENCLAW_CONFIG),
      feishu: resolveEnabled(feishu, DEFAULT_FEISHU_OPENCLAW_CONFIG),
      telegram: resolveEnabled(telegram, DEFAULT_TELEGRAM_OPENCLAW_CONFIG),
      discord: resolveEnabled(discord, DEFAULT_DISCORD_OPENCLAW_CONFIG),
      nim: resolveEnabled(nim, DEFAULT_NIM_CONFIG),
      xiaomifeng: resolveEnabled(xiaomifeng, DEFAULT_XIAOMIFENG_CONFIG),
      qq: resolveEnabled(qq, DEFAULT_QQ_CONFIG),
      wecom: resolveEnabled(wecom, DEFAULT_WECOM_CONFIG),
      popo: resolveEnabled(popo, DEFAULT_POPO_CONFIG),
      weixin: resolveEnabled(weixin, DEFAULT_WEIXIN_CONFIG),
      settings: { ...DEFAULT_IM_SETTINGS, ...settings },
    };
  }

  setConfig(config: Partial<IMGatewayConfig>): void {
    if (config.dingtalk) {
      this.setDingTalkOpenClawConfig(config.dingtalk);
    }
    if (config.feishu) {
      this.setFeishuOpenClawConfig(config.feishu);
    }
    if (config.telegram) {
      this.setTelegramOpenClawConfig(config.telegram);
    }
    if (config.discord) {
      this.setDiscordOpenClawConfig(config.discord);
    }
    if (config.nim) {
      this.setNimConfig(config.nim);
    }
    if (config.xiaomifeng) {
      this.setXiaomifengConfig(config.xiaomifeng);
    }
    if (config.qq) {
      this.setQQConfig(config.qq);
    }
    if (config.wecom) {
      this.setWecomConfig(config.wecom);
    }
    if (config.popo) {
      this.setPopoConfig(config.popo);
    }
    if (config.weixin) {
      this.setWeixinConfig(config.weixin);
    }
    if (config.settings) {
      this.setIMSettings(config.settings);
    }
  }

  // ==================== DingTalk OpenClaw Config ====================

  getDingTalkOpenClawConfig(): DingTalkOpenClawConfig {
    const stored = this.getConfigValue<DingTalkOpenClawConfig>('dingtalkOpenClaw');
    return { ...DEFAULT_DINGTALK_OPENCLAW_CONFIG, ...stored };
  }

  setDingTalkOpenClawConfig(config: Partial<DingTalkOpenClawConfig>): void {
    const current = this.getDingTalkOpenClawConfig();
    this.setConfigValue('dingtalkOpenClaw', { ...current, ...config });
  }

  // ==================== Feishu OpenClaw Config ====================

  getFeishuOpenClawConfig(): FeishuOpenClawConfig {
    const stored = this.getConfigValue<FeishuOpenClawConfig>('feishuOpenClaw');
    return { ...DEFAULT_FEISHU_OPENCLAW_CONFIG, ...stored };
  }

  setFeishuOpenClawConfig(config: Partial<FeishuOpenClawConfig>): void {
    const current = this.getFeishuOpenClawConfig();
    this.setConfigValue('feishuOpenClaw', { ...current, ...config });
  }

  // ==================== Discord OpenClaw Config ====================

  getDiscordOpenClawConfig(): DiscordOpenClawConfig {
    const stored = this.getConfigValue<DiscordOpenClawConfig>('discordOpenClaw');
    return { ...DEFAULT_DISCORD_OPENCLAW_CONFIG, ...stored };
  }

  setDiscordOpenClawConfig(config: Partial<DiscordOpenClawConfig>): void {
    const current = this.getDiscordOpenClawConfig();
    this.setConfigValue('discordOpenClaw', { ...current, ...config });
  }

  // ==================== NIM Config ====================

  getNimConfig(): NimConfig {
    const stored = this.getConfigValue<NimConfig>('nim');
    return { ...DEFAULT_NIM_CONFIG, ...stored };
  }

  setNimConfig(config: Partial<NimConfig>): void {
    const current = this.getNimConfig();
    this.setConfigValue('nim', { ...current, ...config });
  }

  // ==================== Xiaomifeng Config ====================

  getXiaomifengConfig(): XiaomifengConfig {
    const stored = this.getConfigValue<XiaomifengConfig>('xiaomifeng');
    return { ...DEFAULT_XIAOMIFENG_CONFIG, ...stored };
  }

  setXiaomifengConfig(config: Partial<XiaomifengConfig>): void {
    const current = this.getXiaomifengConfig();
    this.setConfigValue('xiaomifeng', { ...current, ...config });
  }

  // ==================== Telegram OpenClaw Config ====================

  getTelegramOpenClawConfig(): TelegramOpenClawConfig {
    const stored = this.getConfigValue<TelegramOpenClawConfig>('telegramOpenClaw');
    return { ...DEFAULT_TELEGRAM_OPENCLAW_CONFIG, ...stored };
  }

  setTelegramOpenClawConfig(config: Partial<TelegramOpenClawConfig>): void {
    const current = this.getTelegramOpenClawConfig();
    this.setConfigValue('telegramOpenClaw', { ...current, ...config });
  }

  // ==================== QQ Config ====================

  getQQConfig(): QQConfig {
    const stored = this.getConfigValue<QQConfig>('qq');
    return { ...DEFAULT_QQ_CONFIG, ...stored };
  }

  setQQConfig(config: Partial<QQConfig>): void {
    const current = this.getQQConfig();
    this.setConfigValue('qq', { ...current, ...config });
  }

  // ==================== WeCom OpenClaw Config ====================

  getWecomConfig(): WecomOpenClawConfig {
    const stored = this.getConfigValue<WecomOpenClawConfig>('wecomOpenClaw');
    return { ...DEFAULT_WECOM_CONFIG, ...stored };
  }

  setWecomConfig(config: Partial<WecomOpenClawConfig>): void {
    const current = this.getWecomConfig();
    this.setConfigValue('wecomOpenClaw', { ...current, ...config });
  }

  // ==================== POPO ====================

  getPopoConfig(): PopoOpenClawConfig {
    const stored = this.getConfigValue<PopoOpenClawConfig>('popo');
    return { ...DEFAULT_POPO_CONFIG, ...stored };
  }

  setPopoConfig(config: Partial<PopoOpenClawConfig>): void {
    const current = this.getPopoConfig();
    this.setConfigValue('popo', { ...current, ...config });
  }

  // ==================== Weixin (微信) ====================

  getWeixinConfig(): WeixinOpenClawConfig {
    const stored = this.getConfigValue<WeixinOpenClawConfig>('weixin');
    return { ...DEFAULT_WEIXIN_CONFIG, ...stored };
  }

  setWeixinConfig(config: Partial<WeixinOpenClawConfig>): void {
    const current = this.getWeixinConfig();
    this.setConfigValue('weixin', { ...current, ...config });
  }

  // ==================== IM Settings ====================

  getIMSettings(): IMSettings {
    const stored = this.getConfigValue<IMSettings>('settings');
    return { ...DEFAULT_IM_SETTINGS, ...stored };
  }

  setIMSettings(settings: Partial<IMSettings>): void {
    const current = this.getIMSettings();
    this.setConfigValue('settings', { ...current, ...settings });
  }

  // ==================== Utility ====================

  /**
   * Clear all IM configuration
   */
  clearConfig(): void {
    this.db.run('DELETE FROM im_config');
    this.saveDb();
  }

  /**
   * Check if IM is configured (at least one platform has credentials)
   */
  isConfigured(): boolean {
    const config = this.getConfig();
    const hasDingTalk = !!(config.dingtalk.clientId && config.dingtalk.clientSecret);
    const hasFeishu = !!(config.feishu.appId && config.feishu.appSecret);
    const hasTelegram = !!config.telegram.botToken;
    const hasDiscord = !!config.discord.botToken;
    const hasNim = !!(config.nim.appKey && config.nim.account && config.nim.token);
    const hasXiaomifeng = !!(config.xiaomifeng?.clientId && config.xiaomifeng?.secret);
    const hasQQ = !!(config.qq?.appId && config.qq?.appSecret);
    const hasWecom = !!(config.wecom?.botId && config.wecom?.secret);
    return hasDingTalk || hasFeishu || hasTelegram || hasDiscord || hasNim || hasXiaomifeng || hasQQ || hasWecom;
  }

  // ==================== Notification Target Persistence ====================

  /**
   * Get persisted notification target for a platform
   */
  getNotificationTarget(platform: IMPlatform): any | null {
    return this.getConfigValue<any>(`notification_target:${platform}`) ?? null;
  }

  /**
   * Persist notification target for a platform
   */
  setNotificationTarget(platform: IMPlatform, target: any): void {
    this.setConfigValue(`notification_target:${platform}`, target);
  }

  getConversationReplyRoute(
    platform: IMPlatform,
    conversationId: string,
  ): StoredConversationReplyRoute | null {
    const normalizedConversationId = conversationId.trim();
    if (!normalizedConversationId) {
      return null;
    }
    return this.getConfigValue<StoredConversationReplyRoute>(
      `conversation_reply_route:${platform}:${normalizedConversationId}`,
    ) ?? null;
  }

  setConversationReplyRoute(
    platform: IMPlatform,
    conversationId: string,
    route: StoredConversationReplyRoute,
  ): void {
    const normalizedConversationId = conversationId.trim();
    if (!normalizedConversationId) {
      return;
    }
    this.setConfigValue(`conversation_reply_route:${platform}:${normalizedConversationId}`, route);
  }

  // ==================== Session Mapping Operations ====================

  /**
   * Get session mapping by IM conversation ID and platform
   */
  getSessionMapping(imConversationId: string, platform: IMPlatform): IMSessionMapping | null {
    const result = this.db.exec(
      'SELECT im_conversation_id, platform, cowork_session_id, agent_id, created_at, last_active_at FROM im_session_mappings WHERE im_conversation_id = ? AND platform = ?',
      [imConversationId, platform]
    );
    if (!result[0]?.values[0]) return null;
    const row = result[0].values[0];
    return {
      imConversationId: row[0] as string,
      platform: row[1] as IMPlatform,
      coworkSessionId: row[2] as string,
      agentId: (row[3] as string) || 'main',
      createdAt: row[4] as number,
      lastActiveAt: row[5] as number,
    };
  }

  /**
   * Find the IM mapping that owns a given cowork session ID.
   */
  getSessionMappingByCoworkSessionId(coworkSessionId: string): IMSessionMapping | null {
    const result = this.db.exec(
      'SELECT im_conversation_id, platform, cowork_session_id, agent_id, created_at, last_active_at FROM im_session_mappings WHERE cowork_session_id = ? LIMIT 1',
      [coworkSessionId]
    );
    if (!result[0]?.values[0]) return null;
    const row = result[0].values[0];
    return {
      imConversationId: row[0] as string,
      platform: row[1] as IMPlatform,
      coworkSessionId: row[2] as string,
      agentId: (row[3] as string) || 'main',
      createdAt: row[4] as number,
      lastActiveAt: row[5] as number,
    };
  }

  /**
   * Create a new session mapping
   */
  createSessionMapping(imConversationId: string, platform: IMPlatform, coworkSessionId: string, agentId: string = 'main'): IMSessionMapping {
    const now = Date.now();
    this.db.run(
      'INSERT INTO im_session_mappings (im_conversation_id, platform, cowork_session_id, agent_id, created_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?)',
      [imConversationId, platform, coworkSessionId, agentId, now, now]
    );
    this.saveDb();
    return {
      imConversationId,
      platform,
      coworkSessionId,
      agentId,
      createdAt: now,
      lastActiveAt: now,
    };
  }

  /**
   * Update last active time for a session mapping
   */
  updateSessionLastActive(imConversationId: string, platform: IMPlatform): void {
    const now = Date.now();
    this.db.run(
      'UPDATE im_session_mappings SET last_active_at = ? WHERE im_conversation_id = ? AND platform = ?',
      [now, imConversationId, platform]
    );
    this.saveDb();
  }

  /**
   * Update the target session and agent for an existing mapping.
   * Used when the platform's agent binding changes.
   */
  updateSessionMappingTarget(imConversationId: string, platform: IMPlatform, newCoworkSessionId: string, newAgentId: string): void {
    const now = Date.now();
    this.db.run(
      'UPDATE im_session_mappings SET cowork_session_id = ?, agent_id = ?, last_active_at = ? WHERE im_conversation_id = ? AND platform = ?',
      [newCoworkSessionId, newAgentId, now, imConversationId, platform]
    );
    this.saveDb();
  }

  /**
   * Delete a session mapping
   */
  deleteSessionMapping(imConversationId: string, platform: IMPlatform): void {
    this.db.run(
      'DELETE FROM im_session_mappings WHERE im_conversation_id = ? AND platform = ?',
      [imConversationId, platform]
    );
    this.saveDb();
  }

  /**
   * Delete all session mappings that reference a given cowork session ID.
   * Called when a cowork session is deleted so that the IM conversation
   * can be re-synced as a fresh session.
   */
  deleteSessionMappingByCoworkSessionId(coworkSessionId: string): void {
    this.db.run(
      'DELETE FROM im_session_mappings WHERE cowork_session_id = ?',
      [coworkSessionId]
    );
    this.saveDb();
  }

  /**
   * List all session mappings for a platform
   */
  listSessionMappings(platform?: IMPlatform): IMSessionMapping[] {
    const query = platform
      ? 'SELECT im_conversation_id, platform, cowork_session_id, agent_id, created_at, last_active_at FROM im_session_mappings WHERE platform = ? ORDER BY last_active_at DESC'
      : 'SELECT im_conversation_id, platform, cowork_session_id, agent_id, created_at, last_active_at FROM im_session_mappings ORDER BY last_active_at DESC';
    const params = platform ? [platform] : [];
    const result = this.db.exec(query, params);
    if (!result[0]?.values) return [];
    return result[0].values.map(row => ({
      imConversationId: row[0] as string,
      platform: row[1] as IMPlatform,
      coworkSessionId: row[2] as string,
      agentId: (row[3] as string) || 'main',
      createdAt: row[4] as number,
      lastActiveAt: row[5] as number,
    }));
  }
}
