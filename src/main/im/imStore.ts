/**
 * IM Gateway Store
 * SQLite operations for IM configuration storage
 */

import { randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';

import { PlatformRegistry } from '../../shared/platform';
import {
  DEFAULT_DINGTALK_MULTI_INSTANCE_CONFIG,
  DEFAULT_DINGTALK_OPENCLAW_CONFIG,
  DEFAULT_DISCORD_MULTI_INSTANCE_CONFIG,
  DEFAULT_DISCORD_OPENCLAW_CONFIG,
  DEFAULT_FEISHU_MULTI_INSTANCE_CONFIG,
  DEFAULT_FEISHU_OPENCLAW_CONFIG,
  DEFAULT_IM_SETTINGS,
  DEFAULT_NETEASE_BEE_CONFIG,
  DEFAULT_NIM_CONFIG,
  DEFAULT_NIM_MULTI_INSTANCE_CONFIG,
  DEFAULT_POPO_CONFIG,
  DEFAULT_QQ_CONFIG,
  DEFAULT_QQ_MULTI_INSTANCE_CONFIG,
  DEFAULT_TELEGRAM_OPENCLAW_CONFIG,
  DEFAULT_TELEGRAM_MULTI_INSTANCE_CONFIG,
  DEFAULT_WECOM_CONFIG,
  DEFAULT_WECOM_MULTI_INSTANCE_CONFIG,
  DEFAULT_WEIXIN_CONFIG,
  DingTalkInstanceConfig,
  DingTalkMultiInstanceConfig,
  DingTalkOpenClawConfig,
  DiscordInstanceConfig,
  DiscordMultiInstanceConfig,
  DiscordOpenClawConfig,
  FeishuInstanceConfig,
  FeishuMultiInstanceConfig,
  FeishuOpenClawConfig,
  IMGatewayConfig,
  IMSessionMapping,
  IMSettings,
  NeteaseBeeChanConfig,
  NimConfig,
  NimInstanceConfig,
  NimMultiInstanceConfig,
  Platform,
  PopoOpenClawConfig,
  QQConfig,
  QQInstanceConfig,
  QQMultiInstanceConfig,
  TelegramOpenClawConfig,
  TelegramInstanceConfig,
  TelegramMultiInstanceConfig,
  WecomInstanceConfig,
  WecomMultiInstanceConfig,
  WecomOpenClawConfig,
  WeixinOpenClawConfig,
  EmailMultiInstanceConfig,
  EmailInstanceConfig,
  DEFAULT_EMAIL_MULTI_INSTANCE_CONFIG,
  DEFAULT_EMAIL_INSTANCE_CONFIG,
} from './types';

interface StoredConversationReplyRoute {
  channel: string;
  to: string;
  accountId?: string;
}

interface SessionMappingRow {
  im_conversation_id: string;
  platform: string;
  cowork_session_id: string;
  agent_id: string;
  created_at: number;
  last_active_at: number;
}

function deriveNimRuntimeAccountIdForInstance(
  inst: Pick<NimInstanceConfig, 'nimToken' | 'appKey' | 'account'>,
): string | null {
  const nimToken = inst.nimToken?.trim();
  if (nimToken) {
    const delimiter = nimToken.includes('|') ? '|' : '-';
    const parts = nimToken.split(delimiter).map((part) => part.trim());
    if (parts.length === 3 && parts[0] && parts[1]) {
      return `${parts[0]}:${parts[1]}`;
    }
  }
  if (inst.appKey?.trim() && inst.account?.trim()) {
    return `${inst.appKey.trim()}:${inst.account.trim()}`;
  }
  return null;
}

function normalizeNimLegacyConversationPrefix(runtimeAccountId: string): string {
  return runtimeAccountId.replace(/:/g, '-');
}

export class IMStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initializeTables();
    this.migrateDefaults();
  }

  private initializeTables() {
    this.db
      .prepare(
        `
      CREATE TABLE IF NOT EXISTS im_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
      )
      .run();

    // IM session mappings table for Cowork mode
    this.db
      .prepare(
        `
      CREATE TABLE IF NOT EXISTS im_session_mappings (
        im_conversation_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        cowork_session_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL,
        PRIMARY KEY (im_conversation_id, platform)
      );
    `,
      )
      .run();

    // Migration: Add agent_id column to im_session_mappings
    const mappingCols = this.db.pragma('table_info(im_session_mappings)') as Array<{
      name: string;
    }>;
    const mappingColNames = mappingCols.map(r => r.name);
    if (!mappingColNames.includes('agent_id')) {
      this.db
        .prepare("ALTER TABLE im_session_mappings ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'main'")
        .run();
    }
  }

  /**
   * Migrate existing IM configs to ensure stable defaults.
   */
  private migrateDefaults(): void {
    const platforms = PlatformRegistry.platforms;

    for (const platform of platforms) {
      const row = this.db.prepare('SELECT value FROM im_config WHERE key = ?').get(platform) as
        | { value: string }
        | undefined;
      if (!row) continue;

      try {
        const config = JSON.parse(row.value);
        if (config.debug === undefined || config.debug === false) {
          config.debug = true;
          const now = Date.now();
          this.db
            .prepare('UPDATE im_config SET value = ?, updated_at = ? WHERE key = ?')
            .run(JSON.stringify(config), now, platform);
        }
      } catch {
        // Ignore parse errors
      }
    }

    const settingsRow = this.db
      .prepare('SELECT value FROM im_config WHERE key = ?')
      .get('settings') as { value: string } | undefined;
    if (settingsRow) {
      try {
        const settings = JSON.parse(settingsRow.value) as Partial<IMSettings>;
        // Keep IM and desktop behavior aligned: skills auto-routing should be on by default.
        // Historical renderer default could persist `skillsEnabled: false` unintentionally.
        if (settings.skillsEnabled !== true) {
          settings.skillsEnabled = true;
          const now = Date.now();
          this.db
            .prepare('UPDATE im_config SET value = ?, updated_at = ? WHERE key = ?')
            .run(JSON.stringify(settings), now, 'settings');
        }
      } catch {
        // Ignore parse errors
      }
    }

    // Migrate feishu renderMode from 'text' to 'card' (previous renderer default was incorrect)
    const feishuRow = this.db.prepare('SELECT value FROM im_config WHERE key = ?').get('feishu') as
      | { value: string }
      | undefined;
    if (feishuRow) {
      try {
        const feishuConfig = JSON.parse(feishuRow.value) as Partial<{ renderMode: string }>;
        if (feishuConfig.renderMode === 'text') {
          feishuConfig.renderMode = 'card';
          const now = Date.now();
          this.db
            .prepare('UPDATE im_config SET value = ?, updated_at = ? WHERE key = ?')
            .run(JSON.stringify(feishuConfig), now, 'feishu');
        }
      } catch {
        // Ignore parse errors
      }
    }

    // Migrate old native Telegram config to new OpenClaw format
    const oldTelegramRow = this.db
      .prepare('SELECT value FROM im_config WHERE key = ?')
      .get('telegram') as { value: string } | undefined;
    const newTelegramRow = this.db
      .prepare('SELECT value FROM im_config WHERE key = ?')
      .get('telegramOpenClaw') as { value: string } | undefined;
    if (oldTelegramRow && !newTelegramRow) {
      try {
        const oldConfig = JSON.parse(oldTelegramRow.value) as {
          enabled?: boolean;
          botToken?: string;
          allowedUserIds?: string[];
          debug?: boolean;
        };
        if (oldConfig.botToken) {
          const hasAllowList =
            Array.isArray(oldConfig.allowedUserIds) && oldConfig.allowedUserIds.length > 0;
          const newConfig = {
            ...DEFAULT_TELEGRAM_OPENCLAW_CONFIG,
            enabled: oldConfig.enabled ?? false,
            botToken: oldConfig.botToken,
            allowFrom: oldConfig.allowedUserIds ?? [],
            dmPolicy: hasAllowList ? ('allowlist' as const) : ('pairing' as const),
            debug: oldConfig.debug ?? true,
          };
          const now = Date.now();
          this.db
            .prepare(
              'INSERT OR REPLACE INTO im_config (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)',
            )
            .run('telegramOpenClaw', JSON.stringify(newConfig), now, now);
          this.db.prepare('DELETE FROM im_config WHERE key = ?').run('telegram');
          console.log('[IMStore] Migrated old Telegram config to OpenClaw format');
        }
      } catch {
        // Ignore parse errors
      }
    }

    // Migrate single telegramOpenClaw config to multi-instance format
    const oldTelegramSingleRow = this.db
      .prepare('SELECT value FROM im_config WHERE key = ?')
      .get('telegramOpenClaw') as { value: string } | undefined;
    const existingTelegramInstances = this.db
      .prepare('SELECT key FROM im_config WHERE key LIKE ?')
      .all('telegram:%') as Array<{ key: string }>;
    if (oldTelegramSingleRow && !existingTelegramInstances.length) {
      try {
        const oldConfig = JSON.parse(oldTelegramSingleRow.value) as TelegramOpenClawConfig;
        const instanceId = randomUUID();
        const instanceConfig: TelegramInstanceConfig = {
          ...DEFAULT_TELEGRAM_OPENCLAW_CONFIG,
          ...oldConfig,
          instanceId,
          instanceName: 'Telegram Bot 1',
        };
        const now = Date.now();
        this.db
          .prepare(
            'INSERT INTO im_config (key, value, updated_at) VALUES (?, ?, ?)',
          )
          .run(`telegram:${instanceId}`, JSON.stringify(instanceConfig), now);
        this.db.prepare('DELETE FROM im_config WHERE key = ?').run('telegramOpenClaw');
        // Migrate session mappings
        this.db
          .prepare('UPDATE im_session_mappings SET platform = ? WHERE platform = ?')
          .run(`telegram:${instanceId}`, 'telegram');
        // Migrate agent bindings
        const settingsRow = this.db
          .prepare('SELECT value FROM im_config WHERE key = ?')
          .get('settings') as { value: string } | undefined;
        if (settingsRow) {
          try {
            const settings = JSON.parse(settingsRow.value) as IMSettings;
            if (settings.platformAgentBindings?.['telegram']) {
              settings.platformAgentBindings[`telegram:${instanceId}`] =
                settings.platformAgentBindings['telegram'];
              delete settings.platformAgentBindings['telegram'];
              this.db
                .prepare('UPDATE im_config SET value = ?, updated_at = ? WHERE key = ?')
                .run(JSON.stringify(settings), now, 'settings');
            }
          } catch {
            // Ignore parse errors
          }
        }
        console.log('[IMStore] Migrated single Telegram config to multi-instance format');
      } catch {
        // Ignore parse errors
      }
    }

    // Migrate old native Discord config to new OpenClaw format
    const oldDiscordRow = this.db
      .prepare('SELECT value FROM im_config WHERE key = ?')
      .get('discord') as { value: string } | undefined;
    const newDiscordRow = this.db
      .prepare('SELECT value FROM im_config WHERE key = ?')
      .get('discordOpenClaw') as { value: string } | undefined;
    if (oldDiscordRow && !newDiscordRow) {
      try {
        const oldConfig = JSON.parse(oldDiscordRow.value) as {
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
          this.db
            .prepare('INSERT OR REPLACE INTO im_config (key, value, updated_at) VALUES (?, ?, ?)')
            .run('discordOpenClaw', JSON.stringify(newConfig), now);
          this.db.prepare('DELETE FROM im_config WHERE key = ?').run('discord');
          console.log('[IMStore] Migrated old Discord config to OpenClaw format');
        }
      } catch {
        // Ignore parse errors
      }
    }

    // Migrate single discordOpenClaw config to multi-instance format
    const oldDiscordSingleRow = this.db
      .prepare('SELECT value FROM im_config WHERE key = ?')
      .get('discordOpenClaw') as { value: string } | undefined;
    const existingDiscordInstances = this.db
      .prepare('SELECT key FROM im_config WHERE key LIKE ?')
      .all('discord:%') as Array<{ key: string }>;
    if (oldDiscordSingleRow && !existingDiscordInstances.length) {
      try {
        const oldConfig = JSON.parse(oldDiscordSingleRow.value) as DiscordOpenClawConfig;
        const instanceId = randomUUID();
        const instanceConfig: DiscordInstanceConfig = {
          ...DEFAULT_DISCORD_OPENCLAW_CONFIG,
          ...oldConfig,
          instanceId,
          instanceName: 'Discord Bot 1',
        };
        const now = Date.now();
        this.db
          .prepare(
            'INSERT INTO im_config (key, value, updated_at) VALUES (?, ?, ?)',
          )
          .run(`discord:${instanceId}`, JSON.stringify(instanceConfig), now);
        this.db.prepare('DELETE FROM im_config WHERE key = ?').run('discordOpenClaw');
        // Migrate session mappings
        this.db
          .prepare('UPDATE im_session_mappings SET platform = ? WHERE platform = ?')
          .run(`discord:${instanceId}`, 'discord');
        // Migrate agent bindings
        const settingsRow4 = this.db
          .prepare('SELECT value FROM im_config WHERE key = ?')
          .get('settings') as { value: string } | undefined;
        if (settingsRow4) {
          try {
            const settings = JSON.parse(settingsRow4.value) as IMSettings;
            if (settings.platformAgentBindings?.['discord']) {
              settings.platformAgentBindings[`discord:${instanceId}`] =
                settings.platformAgentBindings['discord'];
              delete settings.platformAgentBindings['discord'];
              this.db
                .prepare('UPDATE im_config SET value = ?, updated_at = ? WHERE key = ?')
                .run(JSON.stringify(settings), now, 'settings');
            }
          } catch {
            // Ignore parse errors
          }
        }
        console.log('[IMStore] Migrated single Discord config to multi-instance format');
      } catch {
        // Ignore parse errors
      }
    }

    // Migrate old native Feishu config to new OpenClaw format
    const oldFeishuRow2 = this.db
      .prepare('SELECT value FROM im_config WHERE key = ?')
      .get('feishu') as { value: string } | undefined;
    const newFeishuRow = this.db
      .prepare('SELECT value FROM im_config WHERE key = ?')
      .get('feishuOpenClaw') as { value: string } | undefined;
    if (oldFeishuRow2 && !newFeishuRow) {
      try {
        const oldConfig = JSON.parse(oldFeishuRow2.value) as Partial<{
          enabled: boolean;
          appId: string;
          appSecret: string;
          domain: string;
          debug: boolean;
        }>;
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
          this.db
            .prepare('INSERT OR REPLACE INTO im_config (key, value, updated_at) VALUES (?, ?, ?)')
            .run('feishuOpenClaw', JSON.stringify(newConfig), now);
          this.db.prepare('DELETE FROM im_config WHERE key = ?').run('feishu');
          console.log('[IMStore] Migrated old Feishu config to OpenClaw format');
        }
      } catch {
        // Ignore parse errors
      }
    }

    // Migrate old native DingTalk config to new OpenClaw format
    const oldDingtalkRow = this.db
      .prepare('SELECT value FROM im_config WHERE key = ?')
      .get('dingtalk') as { value: string } | undefined;
    const newDingtalkRow = this.db
      .prepare('SELECT value FROM im_config WHERE key = ?')
      .get('dingtalkOpenClaw') as { value: string } | undefined;
    if (oldDingtalkRow && !newDingtalkRow) {
      try {
        const oldConfig = JSON.parse(oldDingtalkRow.value) as Partial<{
          enabled: boolean;
          clientId: string;
          clientSecret: string;
          debug: boolean;
        }>;
        if (oldConfig.clientId) {
          const newConfig: DingTalkOpenClawConfig = {
            ...DEFAULT_DINGTALK_OPENCLAW_CONFIG,
            enabled: oldConfig.enabled ?? false,
            clientId: oldConfig.clientId,
            clientSecret: oldConfig.clientSecret ?? '',
            debug: oldConfig.debug ?? false,
          };
          const now = Date.now();
          this.db
            .prepare('INSERT OR REPLACE INTO im_config (key, value, updated_at) VALUES (?, ?, ?)')
            .run('dingtalkOpenClaw', JSON.stringify(newConfig), now);
          this.db.prepare('DELETE FROM im_config WHERE key = ?').run('dingtalk');
          console.log('[IMStore] Migrated old DingTalk config to OpenClaw format');
        }
      } catch {
        // Ignore parse errors
      }
    }

    // Migrate old native WeCom config to new OpenClaw format
    const oldWecomRow = this.db
      .prepare('SELECT value FROM im_config WHERE key = ?')
      .get('wecom') as { value: string } | undefined;
    const newWecomRow = this.db
      .prepare('SELECT value FROM im_config WHERE key = ?')
      .get('wecomOpenClaw') as { value: string } | undefined;
    if (oldWecomRow && !newWecomRow) {
      try {
        const oldConfig = JSON.parse(oldWecomRow.value) as Partial<{
          enabled: boolean;
          botId: string;
          secret: string;
          debug: boolean;
        }>;
        if (oldConfig.botId) {
          const newConfig: WecomOpenClawConfig = {
            ...DEFAULT_WECOM_CONFIG,
            enabled: oldConfig.enabled ?? false,
            botId: oldConfig.botId,
            secret: oldConfig.secret ?? '',
            debug: oldConfig.debug ?? true,
          };
          const now = Date.now();
          this.db
            .prepare('INSERT OR REPLACE INTO im_config (key, value, updated_at) VALUES (?, ?, ?)')
            .run('wecomOpenClaw', JSON.stringify(newConfig), now);
          this.db.prepare('DELETE FROM im_config WHERE key = ?').run('wecom');
          console.log('[IMStore] Migrated old WeCom config to OpenClaw format');
        }
      } catch {
        // Ignore parse errors
      }
    }

    // Migrate popo configs that have token but no connectionMode:
    // These are existing webhook users from before connectionMode was introduced.
    // Preserve their setup by explicitly setting connectionMode to 'webhook'.
    const popoRow = this.db.prepare('SELECT value FROM im_config WHERE key = ?').get('popo') as
      | { value: string }
      | undefined;
    if (popoRow) {
      try {
        const popoConfig = JSON.parse(popoRow.value) as Partial<PopoOpenClawConfig>;
        if (popoConfig.token && !popoConfig.connectionMode) {
          popoConfig.connectionMode = 'webhook';
          const now = Date.now();
          this.db
            .prepare('UPDATE im_config SET value = ?, updated_at = ? WHERE key = ?')
            .run(JSON.stringify(popoConfig), now, 'popo');
          console.log(
            '[IMStore] Migrated popo config: inferred connectionMode=webhook from existing token',
          );
        }
      } catch {
        // Ignore parse errors
      }
    }

    // Migrate 'xiaomifeng' config key to 'netease-bee'
    const oldXmfRow = this.db
      .prepare('SELECT value FROM im_config WHERE key = ?')
      .get('xiaomifeng') as { value: string } | undefined;
    const newBeeRow = this.db
      .prepare('SELECT value FROM im_config WHERE key = ?')
      .get('netease-bee') as { value: string } | undefined;
    if (oldXmfRow && !newBeeRow) {
      try {
        const oldConfig = JSON.parse(oldXmfRow.value) as Partial<NeteaseBeeChanConfig>;
        const now = Date.now();
        this.db
          .prepare('INSERT INTO im_config (key, value, updated_at) VALUES (?, ?, ?)')
          .run('netease-bee', JSON.stringify({ ...DEFAULT_NETEASE_BEE_CONFIG, ...oldConfig }), now);
        this.db.prepare('DELETE FROM im_config WHERE key = ?').run('xiaomifeng');
        console.log('[IMStore] Migrated xiaomifeng config to netease-bee');
      } catch {
        // Ignore parse errors
      }
    }

    // Migrate single QQ config to multi-instance format
    const oldQQRow = this.db.prepare('SELECT value FROM im_config WHERE key = ?').get('qq') as
      | { value: string }
      | undefined;
    const existingQQInstances = this.db
      .prepare('SELECT key FROM im_config WHERE key LIKE ?')
      .all('qq:%') as Array<{ key: string }>;
    if (oldQQRow && !existingQQInstances.length) {
      try {
        const oldConfig = JSON.parse(oldQQRow.value) as QQConfig;
        const instanceId = crypto.randomUUID();
        const instanceConfig: QQInstanceConfig = {
          ...DEFAULT_QQ_CONFIG,
          ...oldConfig,
          instanceId,
          instanceName: 'QQ Bot 1',
        };
        const now = Date.now();
        this.db
          .prepare('INSERT INTO im_config (key, value, updated_at) VALUES (?, ?, ?)')
          .run(`qq:${instanceId}`, JSON.stringify(instanceConfig), now);
        this.db.prepare('DELETE FROM im_config WHERE key = ?').run('qq');
        // Migrate session mappings
        this.db
          .prepare('UPDATE im_session_mappings SET platform = ? WHERE platform = ?')
          .run(`qq:${instanceId}`, 'qq');
        // Migrate agent bindings
        const settingsRow2 = this.db
          .prepare('SELECT value FROM im_config WHERE key = ?')
          .get('settings') as { value: string } | undefined;
        if (settingsRow2) {
          const settings = JSON.parse(settingsRow2.value) as IMSettings;
          if (settings.platformAgentBindings?.['qq']) {
            settings.platformAgentBindings[`qq:${instanceId}`] =
              settings.platformAgentBindings['qq'];
            delete settings.platformAgentBindings['qq'];
            this.db
              .prepare('UPDATE im_config SET value = ?, updated_at = ? WHERE key = ?')
              .run(JSON.stringify(settings), now, 'settings');
          }
        }
        console.log('[IMStore] Migrated single QQ config to multi-instance format');
      } catch {
        // Ignore parse errors
      }
    }

    // Migrate single Feishu config to multi-instance format
    const oldFeishuSingleRow = this.db
      .prepare('SELECT value FROM im_config WHERE key = ?')
      .get('feishuOpenClaw') as { value: string } | undefined;
    const existingFeishuInstances = this.db
      .prepare('SELECT key FROM im_config WHERE key LIKE ?')
      .all('feishu:%') as Array<{ key: string }>;
    if (oldFeishuSingleRow && !existingFeishuInstances.length) {
      try {
        const oldConfig = JSON.parse(oldFeishuSingleRow.value) as FeishuOpenClawConfig;
        const instanceId = crypto.randomUUID();
        const instanceConfig: FeishuInstanceConfig = {
          ...DEFAULT_FEISHU_OPENCLAW_CONFIG,
          ...oldConfig,
          instanceId,
          instanceName: 'Feishu Bot 1',
        };
        const now = Date.now();
        this.db
          .prepare('INSERT INTO im_config (key, value, updated_at) VALUES (?, ?, ?)')
          .run(`feishu:${instanceId}`, JSON.stringify(instanceConfig), now);
        this.db.prepare('DELETE FROM im_config WHERE key = ?').run('feishuOpenClaw');
        // Migrate session mappings
        this.db
          .prepare('UPDATE im_session_mappings SET platform = ? WHERE platform = ?')
          .run(`feishu:${instanceId}`, 'feishu');
        // Migrate agent bindings
        const settingsRow3 = this.db
          .prepare('SELECT value FROM im_config WHERE key = ?')
          .get('settings') as { value: string } | undefined;
        if (settingsRow3) {
          const settings = JSON.parse(settingsRow3.value) as IMSettings;
          if (settings.platformAgentBindings?.['feishu']) {
            settings.platformAgentBindings[`feishu:${instanceId}`] =
              settings.platformAgentBindings['feishu'];
            delete settings.platformAgentBindings['feishu'];
            this.db
              .prepare('UPDATE im_config SET value = ?, updated_at = ? WHERE key = ?')
              .run(JSON.stringify(settings), now, 'settings');
          }
        }
        console.log('[IMStore] Migrated single Feishu config to multi-instance format');
      } catch {
        // Ignore parse errors
      }
    }

    // Migrate single DingTalk config to multi-instance format
    const oldDingtalkSingleRow = this.db
      .prepare('SELECT value FROM im_config WHERE key = ?')
      .get('dingtalkOpenClaw') as { value: string } | undefined;
    const existingDingtalkInstances = this.db
      .prepare('SELECT key FROM im_config WHERE key LIKE ?')
      .all('dingtalk:%') as Array<{ key: string }>;
    if (oldDingtalkSingleRow && !existingDingtalkInstances.length) {
      try {
        const oldDtConfig = JSON.parse(oldDingtalkSingleRow.value) as DingTalkOpenClawConfig;
        const instanceId = crypto.randomUUID();
        const instanceConfig: DingTalkInstanceConfig = {
          ...DEFAULT_DINGTALK_OPENCLAW_CONFIG,
          ...oldDtConfig,
          instanceId,
          instanceName: 'DingTalk Bot 1',
        };
        const now = Date.now();
        this.db
          .prepare('INSERT INTO im_config (key, value, updated_at) VALUES (?, ?, ?)')
          .run(`dingtalk:${instanceId}`, JSON.stringify(instanceConfig), now);
        this.db.prepare('DELETE FROM im_config WHERE key = ?').run('dingtalkOpenClaw');
        // Migrate session mappings
        this.db
          .prepare('UPDATE im_session_mappings SET platform = ? WHERE platform = ?')
          .run(`dingtalk:${instanceId}`, 'dingtalk');
        // Migrate agent bindings
        const settingsRow4 = this.db
          .prepare('SELECT value FROM im_config WHERE key = ?')
          .get('settings') as { value: string } | undefined;
        if (settingsRow4) {
          const settings = JSON.parse(settingsRow4.value) as IMSettings;
          if (settings.platformAgentBindings?.['dingtalk']) {
            settings.platformAgentBindings[`dingtalk:${instanceId}`] =
              settings.platformAgentBindings['dingtalk'];
            delete settings.platformAgentBindings['dingtalk'];
            this.db
              .prepare('UPDATE im_config SET value = ?, updated_at = ? WHERE key = ?')
              .run(JSON.stringify(settings), now, 'settings');
          }
        }
        console.log('[IMStore] Migrated single DingTalk config to multi-instance format');
      } catch {
        // Ignore parse errors
      }
    }

    // Migrate single WeCom config to multi-instance format
    const oldWecomSingleRow = this.db.prepare('SELECT value FROM im_config WHERE key = ?').get('wecomOpenClaw') as
      | { value: string }
      | undefined;
    const existingWecomInstances = this.db
      .prepare('SELECT key FROM im_config WHERE key LIKE ?')
      .all('wecom:%') as Array<{ key: string }>;
    if (oldWecomSingleRow && !existingWecomInstances.length) {
      try {
        const oldConfig = JSON.parse(oldWecomSingleRow.value) as WecomOpenClawConfig;
        const instanceId = crypto.randomUUID();
        const instanceConfig: WecomInstanceConfig = {
          ...DEFAULT_WECOM_CONFIG,
          ...oldConfig,
          instanceId,
          instanceName: 'WeCom Bot 1',
        };
        const now = Date.now();
        this.db
          .prepare('INSERT INTO im_config (key, value, updated_at) VALUES (?, ?, ?)')
          .run(`wecom:${instanceId}`, JSON.stringify(instanceConfig), now);
        this.db.prepare('DELETE FROM im_config WHERE key = ?').run('wecomOpenClaw');
        // Migrate session mappings
        this.db
          .prepare('UPDATE im_session_mappings SET platform = ? WHERE platform = ?')
          .run(`wecom:${instanceId}`, 'wecom');
        // Migrate agent bindings
        const settingsRowWecom = this.db
          .prepare('SELECT value FROM im_config WHERE key = ?')
          .get('settings') as { value: string } | undefined;
        if (settingsRowWecom) {
          const settings = JSON.parse(settingsRowWecom.value) as IMSettings;
          if (settings.platformAgentBindings?.['wecom']) {
            settings.platformAgentBindings[`wecom:${instanceId}`] =
              settings.platformAgentBindings['wecom'];
            delete settings.platformAgentBindings['wecom'];
            this.db
              .prepare('UPDATE im_config SET value = ?, updated_at = ? WHERE key = ?')
              .run(JSON.stringify(settings), now, 'settings');
          }
        }
        console.log('[IMStore] Migrated single WeCom config to multi-instance format');
      } catch {
        // Ignore parse errors
      }
    }
  }

  private getConfigValue<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM im_config WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    if (!row) return undefined;
    const value = row.value;
    try {
      return JSON.parse(value) as T;
    } catch (error) {
      console.warn(`Failed to parse im_config value for ${key}`, error);
      return undefined;
    }
  }

  private setConfigValue<T>(key: string, value: T): void {
    const now = Date.now();
    this.db
      .prepare(
        `
      INSERT INTO im_config (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `,
      )
      .run(key, JSON.stringify(value), now);
  }

  // ==================== Full Config Operations ====================

  getConfig(): IMGatewayConfig {
    const dingtalkMulti = this.getDingTalkMultiInstanceConfig();
    const telegramMulti = this.getTelegramMultiInstanceConfig();
    const discordMulti = this.getDiscordMultiInstanceConfig();
    const nimMulti = this.getNimMultiInstanceConfig();
    const neteaseBeeChan =
      this.getConfigValue<NeteaseBeeChanConfig>('netease-bee') ?? DEFAULT_NETEASE_BEE_CONFIG;
    const qqMulti = this.getQQMultiInstanceConfig();
    const feishuMulti = this.getFeishuMultiInstanceConfig();
    const wecomMulti = this.getWecomMultiInstanceConfig();
    const popo = this.getConfigValue<PopoOpenClawConfig>('popo') ?? DEFAULT_POPO_CONFIG;
    const weixin = this.getConfigValue<WeixinOpenClawConfig>('weixin') ?? DEFAULT_WEIXIN_CONFIG;
    const settings = this.getConfigValue<IMSettings>('settings') ?? DEFAULT_IM_SETTINGS;
    const email = this.getEmailConfig();

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
      dingtalk: dingtalkMulti,
      feishu: feishuMulti,
      telegram: telegramMulti,
      discord: discordMulti,
      nim: nimMulti,
      'netease-bee': resolveEnabled(neteaseBeeChan, DEFAULT_NETEASE_BEE_CONFIG),
      qq: qqMulti,
      wecom: wecomMulti,
      popo: resolveEnabled(popo, DEFAULT_POPO_CONFIG),
      weixin: resolveEnabled(weixin, DEFAULT_WEIXIN_CONFIG),
      email,
      settings: { ...DEFAULT_IM_SETTINGS, ...settings },
    };
  }

  setConfig(config: Partial<IMGatewayConfig>): void {
    if (config.dingtalk) {
      this.setDingTalkMultiInstanceConfig(config.dingtalk);
    }
    if (config.feishu) {
      this.setFeishuMultiInstanceConfig(config.feishu);
    }
    if (config.telegram) {
      this.setTelegramMultiInstanceConfig(config.telegram);
    }
    if (config.discord) {
      this.setDiscordMultiInstanceConfig(config.discord);
    }
    if (config.nim) {
      this.setNimMultiInstanceConfig(config.nim);
    }
    if (config['netease-bee']) {
      this.setNeteaseBeeChanConfig(config['netease-bee']);
    }
    if (config.qq) {
      this.setQQMultiInstanceConfig(config.qq);
    }
    if (config.wecom) {
      this.setWecomMultiInstanceConfig(config.wecom);
    }
    if (config.popo) {
      this.setPopoConfig(config.popo);
    }
    if (config.weixin) {
      this.setWeixinConfig(config.weixin);
    }
    if (config.email) {
      this.setEmailConfig(config.email);
    }
    if (config.settings) {
      this.setIMSettings(config.settings);
    }
  }

  // ==================== DingTalk OpenClaw Config ====================

  /** @deprecated Use getDingTalkMultiInstanceConfig() or getDingTalkInstances() instead */
  getDingTalkOpenClawConfig(): DingTalkOpenClawConfig {
    const stored = this.getConfigValue<DingTalkOpenClawConfig>('dingtalkOpenClaw');
    return { ...DEFAULT_DINGTALK_OPENCLAW_CONFIG, ...stored };
  }

  /** @deprecated Use setDingTalkInstanceConfig() instead */
  setDingTalkOpenClawConfig(config: Partial<DingTalkOpenClawConfig>): void {
    const current = this.getDingTalkOpenClawConfig();
    this.setConfigValue('dingtalkOpenClaw', { ...current, ...config });
  }

  // ==================== DingTalk Multi-Instance Config ====================

  getDingTalkInstances(): DingTalkInstanceConfig[] {
    const rows = this.db
      .prepare('SELECT key, value FROM im_config WHERE key LIKE ?')
      .all('dingtalk:%') as Array<{ key: string; value: string }>;
    if (!rows.length) return [];
    const instances: DingTalkInstanceConfig[] = [];
    for (const row of rows) {
      try {
        const config = JSON.parse(row.value) as DingTalkInstanceConfig;
        instances.push({ ...DEFAULT_DINGTALK_OPENCLAW_CONFIG, ...config });
      } catch {
        // Ignore parse errors
      }
    }
    return instances;
  }

  getDingTalkInstanceConfig(instanceId: string): DingTalkInstanceConfig | null {
    const stored = this.getConfigValue<DingTalkInstanceConfig>(`dingtalk:${instanceId}`);
    if (!stored) return null;
    return { ...DEFAULT_DINGTALK_OPENCLAW_CONFIG, ...stored };
  }

  setDingTalkInstanceConfig(instanceId: string, config: Partial<DingTalkInstanceConfig>): void {
    const current = this.getDingTalkInstanceConfig(instanceId);
    if (current) {
      this.setConfigValue(`dingtalk:${instanceId}`, { ...current, ...config });
    } else {
      this.setConfigValue(`dingtalk:${instanceId}`, {
        ...DEFAULT_DINGTALK_OPENCLAW_CONFIG,
        instanceId,
        instanceName: config.instanceName || 'DingTalk Bot',
        ...config,
      });
    }
  }

  deleteDingTalkInstance(instanceId: string): void {
    const now = Date.now();
    this.db.prepare('DELETE FROM im_config WHERE key = ?').run(`dingtalk:${instanceId}`);
    // Clean up session mappings for this instance
    this.db
      .prepare('DELETE FROM im_session_mappings WHERE platform = ?')
      .run(`dingtalk:${instanceId}`);
    void now;
  }

  getDingTalkMultiInstanceConfig(): DingTalkMultiInstanceConfig {
    const instances = this.getDingTalkInstances();
    if (instances.length === 0) return DEFAULT_DINGTALK_MULTI_INSTANCE_CONFIG;
    return { instances };
  }

  setDingTalkMultiInstanceConfig(config: DingTalkMultiInstanceConfig): void {
    // Write each instance individually
    for (const inst of config.instances) {
      this.setDingTalkInstanceConfig(inst.instanceId, inst);
    }
  }

  // ==================== Feishu OpenClaw Config ====================

  /** @deprecated Use getFeishuMultiInstanceConfig() or getFeishuInstances() instead */
  getFeishuOpenClawConfig(): FeishuOpenClawConfig {
    const stored = this.getConfigValue<FeishuOpenClawConfig>('feishuOpenClaw');
    return { ...DEFAULT_FEISHU_OPENCLAW_CONFIG, ...stored };
  }

  /** @deprecated Use setFeishuInstanceConfig() instead */
  setFeishuOpenClawConfig(config: Partial<FeishuOpenClawConfig>): void {
    const current = this.getFeishuOpenClawConfig();
    this.setConfigValue('feishuOpenClaw', { ...current, ...config });
  }

  // ==================== Feishu Multi-Instance Config ====================

  getFeishuInstances(): FeishuInstanceConfig[] {
    const rows = this.db
      .prepare('SELECT key, value FROM im_config WHERE key LIKE ?')
      .all('feishu:%') as Array<{ key: string; value: string }>;
    if (!rows.length) return [];
    const instances: FeishuInstanceConfig[] = [];
    for (const row of rows) {
      try {
        const config = JSON.parse(row.value) as FeishuInstanceConfig;
        instances.push({ ...DEFAULT_FEISHU_OPENCLAW_CONFIG, ...config });
      } catch {
        // Ignore parse errors
      }
    }
    return instances;
  }

  getFeishuInstanceConfig(instanceId: string): FeishuInstanceConfig | null {
    const stored = this.getConfigValue<FeishuInstanceConfig>(`feishu:${instanceId}`);
    if (!stored) return null;
    return { ...DEFAULT_FEISHU_OPENCLAW_CONFIG, ...stored };
  }

  setFeishuInstanceConfig(instanceId: string, config: Partial<FeishuInstanceConfig>): void {
    const current = this.getFeishuInstanceConfig(instanceId);
    if (current) {
      this.setConfigValue(`feishu:${instanceId}`, { ...current, ...config });
    } else {
      this.setConfigValue(`feishu:${instanceId}`, {
        ...DEFAULT_FEISHU_OPENCLAW_CONFIG,
        instanceId,
        instanceName: config.instanceName || 'Feishu Bot',
        ...config,
      });
    }
  }

  deleteFeishuInstance(instanceId: string): void {
    const now = Date.now();
    this.db.prepare('DELETE FROM im_config WHERE key = ?').run(`feishu:${instanceId}`);
    // Clean up session mappings for this instance
    this.db
      .prepare('DELETE FROM im_session_mappings WHERE platform = ?')
      .run(`feishu:${instanceId}`);
    void now;
  }

  getFeishuMultiInstanceConfig(): FeishuMultiInstanceConfig {
    const instances = this.getFeishuInstances();
    if (instances.length === 0) return DEFAULT_FEISHU_MULTI_INSTANCE_CONFIG;
    return { instances };
  }

  setFeishuMultiInstanceConfig(config: FeishuMultiInstanceConfig): void {
    // Write each instance individually
    for (const inst of config.instances) {
      this.setFeishuInstanceConfig(inst.instanceId, inst);
    }
  }

  // ==================== Discord OpenClaw Config ====================

  /** @deprecated Use getDiscordMultiInstanceConfig() or getDiscordInstances() instead */
  getDiscordOpenClawConfig(): DiscordOpenClawConfig {
    const stored = this.getConfigValue<DiscordOpenClawConfig>('discordOpenClaw');
    return { ...DEFAULT_DISCORD_OPENCLAW_CONFIG, ...stored };
  }

  /** @deprecated Use setDiscordInstanceConfig() instead */
  setDiscordOpenClawConfig(config: Partial<DiscordOpenClawConfig>): void {
    const current = this.getDiscordOpenClawConfig();
    this.setConfigValue('discordOpenClaw', { ...current, ...config });
  }

  // ==================== Discord Multi-Instance Config ====================

  getDiscordInstances(): DiscordInstanceConfig[] {
    const rows = this.db
      .prepare('SELECT key, value FROM im_config WHERE key LIKE ?')
      .all('discord:%') as Array<{ key: string; value: string }>;
    if (!rows.length) return [];
    const instances: DiscordInstanceConfig[] = [];
    for (const row of rows) {
      try {
        const config = JSON.parse(row.value) as DiscordInstanceConfig;
        instances.push({ ...DEFAULT_DISCORD_OPENCLAW_CONFIG, ...config });
      } catch {
        // Ignore parse errors
      }
    }
    return instances;
  }

  getDiscordInstanceConfig(instanceId: string): DiscordInstanceConfig | null {
    const stored = this.getConfigValue<DiscordInstanceConfig>(`discord:${instanceId}`);
    if (!stored) return null;
    return { ...DEFAULT_DISCORD_OPENCLAW_CONFIG, ...stored };
  }

  setDiscordInstanceConfig(instanceId: string, config: Partial<DiscordInstanceConfig>): void {
    const current = this.getDiscordInstanceConfig(instanceId);
    if (current) {
      this.setConfigValue(`discord:${instanceId}`, { ...current, ...config });
    } else {
      this.setConfigValue(`discord:${instanceId}`, {
        ...DEFAULT_DISCORD_OPENCLAW_CONFIG,
        instanceId,
        instanceName: config.instanceName || 'Discord Bot',
        ...config,
      });
    }
  }

  deleteDiscordInstance(instanceId: string): void {
    this.db.prepare('DELETE FROM im_config WHERE key = ?').run(`discord:${instanceId}`);
    this.db.prepare('DELETE FROM im_session_mappings WHERE platform = ?').run(`discord:${instanceId}`);
  }

  getDiscordMultiInstanceConfig(): DiscordMultiInstanceConfig {
    const instances = this.getDiscordInstances();
    if (instances.length === 0) return DEFAULT_DISCORD_MULTI_INSTANCE_CONFIG;
    return { instances };
  }

  setDiscordMultiInstanceConfig(config: DiscordMultiInstanceConfig): void {
    for (const inst of config.instances) {
      this.setDiscordInstanceConfig(inst.instanceId, inst);
    }
  }

  // ==================== NIM Config ====================

  private hasMeaningfulNimConfig(config: Partial<NimConfig> | null | undefined): config is NimConfig {
    return Boolean(config && (config.nimToken || (config.appKey && config.account && config.token)));
  }

  private buildMigratedNimInstance(config: NimConfig): NimInstanceConfig {
    return {
      ...DEFAULT_NIM_CONFIG,
      ...config,
      instanceId: randomUUID(),
      instanceName: 'NIM Bot 1',
    };
  }

  getNimConfig(): NimConfig {
    const stored = this.getConfigValue<NimConfig>('nim');
    return { ...DEFAULT_NIM_CONFIG, ...stored };
  }

  setNimConfig(config: Partial<NimConfig>): void {
    const current = this.getNimConfig();
    this.setConfigValue('nim', { ...current, ...config });
  }

  private deleteLegacyNimConfig(): void {
    this.db.prepare('DELETE FROM im_config WHERE key = ?').run('nim');
  }

  getNimInstances(): NimInstanceConfig[] {
    const rows = this.db
      .prepare('SELECT key, value FROM im_config WHERE key LIKE ?')
      .all('nim:%') as Array<{ key: string; value: string }>;
    if (rows.length > 0) {
      const instances: NimInstanceConfig[] = [];
      for (const row of rows) {
        try {
          const config = JSON.parse(row.value) as NimInstanceConfig;
          instances.push({ ...DEFAULT_NIM_CONFIG, ...config });
        } catch {
          // Ignore parse errors
        }
      }
      return instances;
    }

    const legacy = this.getConfigValue<NimConfig>('nim');
    if (!this.hasMeaningfulNimConfig(legacy)) {
      return [];
    }

    const migrated = this.buildMigratedNimInstance(legacy);
    this.setNimInstanceConfig(migrated.instanceId, migrated);
    return [migrated];
  }

  getNimInstanceConfig(instanceId: string): NimInstanceConfig | null {
    const stored = this.getConfigValue<NimInstanceConfig>(`nim:${instanceId}`);
    if (!stored) return null;
    return { ...DEFAULT_NIM_CONFIG, ...stored };
  }

  setNimInstanceConfig(instanceId: string, config: Partial<NimInstanceConfig>): void {
    this.deleteLegacyNimConfig();
    const current = this.getNimInstanceConfig(instanceId);
    if (current) {
      this.setConfigValue(`nim:${instanceId}`, { ...current, ...config });
      return;
    }
    this.setConfigValue(`nim:${instanceId}`, {
      ...DEFAULT_NIM_CONFIG,
      instanceId,
      instanceName: config.instanceName || 'NIM Bot',
      ...config,
    });
  }

  deleteNimInstance(instanceId: string): void {
    this.db.prepare('DELETE FROM im_config WHERE key = ?').run(`nim:${instanceId}`);
    this.db.prepare('DELETE FROM im_session_mappings WHERE platform = ?').run(`nim:${instanceId}`);
    if (this.getNimInstances().length === 0) {
      this.deleteLegacyNimConfig();
    }
  }

  getNimMultiInstanceConfig(): NimMultiInstanceConfig {
    const instances = this.getNimInstances();
    if (instances.length === 0) return DEFAULT_NIM_MULTI_INSTANCE_CONFIG;
    return { instances };
  }

  setNimMultiInstanceConfig(config: NimMultiInstanceConfig): void {
    this.deleteLegacyNimConfig();
    const nextIds = new Set(config.instances.map((inst) => inst.instanceId));
    for (const inst of this.getNimInstances()) {
      if (!nextIds.has(inst.instanceId)) {
        this.deleteNimInstance(inst.instanceId);
      }
    }
    for (const inst of config.instances) {
      this.setNimInstanceConfig(inst.instanceId, inst);
    }
  }

  // ==================== NeteaseBee Chan Config ====================

  getNeteaseBeeChanConfig(): NeteaseBeeChanConfig {
    const stored = this.getConfigValue<NeteaseBeeChanConfig>('netease-bee');
    return { ...DEFAULT_NETEASE_BEE_CONFIG, ...stored };
  }

  setNeteaseBeeChanConfig(config: Partial<NeteaseBeeChanConfig>): void {
    const current = this.getNeteaseBeeChanConfig();
    this.setConfigValue('netease-bee', { ...current, ...config });
  }

  // ==================== Telegram OpenClaw Config ====================

  /** @deprecated Use getTelegramMultiInstanceConfig() or getTelegramInstances() instead */
  getTelegramOpenClawConfig(): TelegramOpenClawConfig {
    const stored = this.getConfigValue<TelegramOpenClawConfig>('telegramOpenClaw');
    return { ...DEFAULT_TELEGRAM_OPENCLAW_CONFIG, ...stored };
  }

  /** @deprecated Use setTelegramInstanceConfig() instead */
  setTelegramOpenClawConfig(config: Partial<TelegramOpenClawConfig>): void {
    const current = this.getTelegramOpenClawConfig();
    this.setConfigValue('telegramOpenClaw', { ...current, ...config });
  }

  // ==================== Telegram Multi-Instance Config ====================

  getTelegramInstances(): TelegramInstanceConfig[] {
    const rows = this.db
      .prepare('SELECT key, value FROM im_config WHERE key LIKE ?')
      .all('telegram:%') as Array<{ key: string; value: string }>;
    if (!rows.length) return [];
    const instances: TelegramInstanceConfig[] = [];
    for (const row of rows) {
      try {
        const config = JSON.parse(row.value) as TelegramInstanceConfig;
        instances.push({ ...DEFAULT_TELEGRAM_OPENCLAW_CONFIG, ...config });
      } catch {
        // Ignore parse errors
      }
    }
    return instances;
  }

  getTelegramInstanceConfig(instanceId: string): TelegramInstanceConfig | null {
    const stored = this.getConfigValue<TelegramInstanceConfig>(`telegram:${instanceId}`);
    if (!stored) return null;
    return { ...DEFAULT_TELEGRAM_OPENCLAW_CONFIG, ...stored };
  }

  setTelegramInstanceConfig(instanceId: string, config: Partial<TelegramInstanceConfig>): void {
    const current = this.getTelegramInstanceConfig(instanceId);
    if (current) {
      this.setConfigValue(`telegram:${instanceId}`, { ...current, ...config });
    } else {
      this.setConfigValue(`telegram:${instanceId}`, {
        ...DEFAULT_TELEGRAM_OPENCLAW_CONFIG,
        instanceId,
        instanceName: config.instanceName || 'Telegram Bot',
        ...config,
      });
    }
  }

  deleteTelegramInstance(instanceId: string): void {
    this.db.prepare('DELETE FROM im_config WHERE key = ?').run(`telegram:${instanceId}`);
    this.db.prepare('DELETE FROM im_session_mappings WHERE platform = ?').run(`telegram:${instanceId}`);
  }

  getTelegramMultiInstanceConfig(): TelegramMultiInstanceConfig {
    const instances = this.getTelegramInstances();
    if (instances.length === 0) return DEFAULT_TELEGRAM_MULTI_INSTANCE_CONFIG;
    return { instances };
  }

  setTelegramMultiInstanceConfig(config: TelegramMultiInstanceConfig): void {
    for (const inst of config.instances) {
      this.setTelegramInstanceConfig(inst.instanceId, inst);
    }
  }

  // ==================== QQ Multi-Instance Config ====================

  /** @deprecated Use getQQMultiInstanceConfig() or getQQInstances() instead */
  getQQConfig(): QQConfig {
    const stored = this.getConfigValue<QQConfig>('qq');
    return { ...DEFAULT_QQ_CONFIG, ...stored };
  }

  /** @deprecated Use setQQInstanceConfig() instead */
  setQQConfig(config: Partial<QQConfig>): void {
    const current = this.getQQConfig();
    this.setConfigValue('qq', { ...current, ...config });
  }

  getQQInstances(): QQInstanceConfig[] {
    const rows = this.db
      .prepare('SELECT key, value FROM im_config WHERE key LIKE ?')
      .all('qq:%') as Array<{ key: string; value: string }>;
    if (!rows.length) return [];
    const instances: QQInstanceConfig[] = [];
    for (const row of rows) {
      try {
        const config = JSON.parse(row.value) as QQInstanceConfig;
        instances.push({ ...DEFAULT_QQ_CONFIG, ...config });
      } catch {
        // Ignore parse errors
      }
    }
    return instances;
  }

  getQQInstanceConfig(instanceId: string): QQInstanceConfig | null {
    const stored = this.getConfigValue<QQInstanceConfig>(`qq:${instanceId}`);
    if (!stored) return null;
    return { ...DEFAULT_QQ_CONFIG, ...stored };
  }

  setQQInstanceConfig(instanceId: string, config: Partial<QQInstanceConfig>): void {
    const current = this.getQQInstanceConfig(instanceId);
    if (current) {
      this.setConfigValue(`qq:${instanceId}`, { ...current, ...config });
    } else {
      this.setConfigValue(`qq:${instanceId}`, {
        ...DEFAULT_QQ_CONFIG,
        instanceId,
        instanceName: config.instanceName || `QQ Bot`,
        ...config,
      });
    }
  }

  deleteQQInstance(instanceId: string): void {
    const now = Date.now();
    this.db.prepare('DELETE FROM im_config WHERE key = ?').run(`qq:${instanceId}`);
    // Clean up session mappings for this instance
    this.db.prepare('DELETE FROM im_session_mappings WHERE platform = ?').run(`qq:${instanceId}`);
    void now;
  }

  getQQMultiInstanceConfig(): QQMultiInstanceConfig {
    const instances = this.getQQInstances();
    if (instances.length === 0) return DEFAULT_QQ_MULTI_INSTANCE_CONFIG;
    return { instances };
  }

  setQQMultiInstanceConfig(config: QQMultiInstanceConfig): void {
    // Write each instance individually
    for (const inst of config.instances) {
      this.setQQInstanceConfig(inst.instanceId, inst);
    }
  }

  // ==================== WeCom Multi-Instance Config ====================

  /** @deprecated Use getWecomMultiInstanceConfig() or getWecomInstances() instead */
  getWecomConfig(): WecomOpenClawConfig {
    const stored = this.getConfigValue<WecomOpenClawConfig>('wecomOpenClaw');
    return { ...DEFAULT_WECOM_CONFIG, ...stored };
  }

  /** @deprecated Use setWecomInstanceConfig() instead */
  setWecomConfig(config: Partial<WecomOpenClawConfig>): void {
    const current = this.getWecomConfig();
    this.setConfigValue('wecomOpenClaw', { ...current, ...config });
  }

  getWecomInstances(): WecomInstanceConfig[] {
    const rows = this.db
      .prepare('SELECT key, value FROM im_config WHERE key LIKE ?')
      .all('wecom:%') as Array<{ key: string; value: string }>;
    if (!rows.length) return [];
    const instances: WecomInstanceConfig[] = [];
    for (const row of rows) {
      try {
        const config = JSON.parse(row.value) as WecomInstanceConfig;
        instances.push({ ...DEFAULT_WECOM_CONFIG, ...config });
      } catch {
        // Ignore parse errors
      }
    }
    return instances;
  }

  getWecomInstanceConfig(instanceId: string): WecomInstanceConfig | null {
    const stored = this.getConfigValue<WecomInstanceConfig>(`wecom:${instanceId}`);
    if (!stored) return null;
    return { ...DEFAULT_WECOM_CONFIG, ...stored };
  }

  setWecomInstanceConfig(instanceId: string, config: Partial<WecomInstanceConfig>): void {
    const current = this.getWecomInstanceConfig(instanceId);
    if (current) {
      this.setConfigValue(`wecom:${instanceId}`, { ...current, ...config });
    } else {
      this.setConfigValue(`wecom:${instanceId}`, {
        ...DEFAULT_WECOM_CONFIG,
        instanceId,
        instanceName: config.instanceName || `WeCom Bot`,
        ...config,
      });
    }
  }

  deleteWecomInstance(instanceId: string): void {
    this.db.prepare('DELETE FROM im_config WHERE key = ?').run(`wecom:${instanceId}`);
    // Clean up session mappings for this instance
    this.db.prepare('DELETE FROM im_session_mappings WHERE platform = ?').run(`wecom:${instanceId}`);
  }

  getWecomMultiInstanceConfig(): WecomMultiInstanceConfig {
    const instances = this.getWecomInstances();
    if (instances.length === 0) return DEFAULT_WECOM_MULTI_INSTANCE_CONFIG;
    return { instances };
  }

  setWecomMultiInstanceConfig(config: WecomMultiInstanceConfig): void {
    // Write each instance individually
    for (const inst of config.instances) {
      this.setWecomInstanceConfig(inst.instanceId, inst);
    }
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

  // ==================== Email Channel Config ====================

  /**
   * Get email channel multi-instance configuration
   */
  getEmailConfig(): EmailMultiInstanceConfig {
    const raw = this.db.prepare('SELECT value FROM im_config WHERE key = ?').get('email') as
      | { value: string }
      | undefined;

    if (!raw?.value) {
      return DEFAULT_EMAIL_MULTI_INSTANCE_CONFIG;
    }

    try {
      const parsed = JSON.parse(raw.value);

      // Migration logic: detect v1 format (single account) and convert to v2 (multi-instance)
      if (parsed.email && !parsed.instances) {
        console.log('[EmailChannel] Migrating from v1 config format');
        return {
          instances: [
            {
              instanceId: 'email-1',
              instanceName: 'Default',
              enabled: parsed.enabled ?? false,
              transport: 'imap',
              email: parsed.email,
              password: parsed.password,
              agentId: 'main',
              ...DEFAULT_EMAIL_INSTANCE_CONFIG,
            },
          ],
        };
      }

      // v2 format: multi-instance mode
      return {
        instances: (parsed.instances || []).map((inst: any) => ({
          ...DEFAULT_EMAIL_INSTANCE_CONFIG,
          ...inst,
        })),
      };
    } catch (error) {
      console.error('[EmailChannel] Failed to parse config:', error);
      return DEFAULT_EMAIL_MULTI_INSTANCE_CONFIG;
    }
  }

  /**
   * Set email channel multi-instance configuration
   */
  setEmailConfig(config: EmailMultiInstanceConfig): void {
    this.setConfigValue('email', config);
  }

  setEmailInstanceConfig(instanceId: string, config: Partial<EmailInstanceConfig>): void {
    const current = this.getEmailConfig();
    const existing = current.instances.find(i => i.instanceId === instanceId);
    if (existing) {
      const updated = current.instances.map(i =>
        i.instanceId === instanceId ? { ...i, ...config } : i,
      );
      this.setEmailConfig({ instances: updated });
    } else {
      this.setEmailConfig({
        instances: [...current.instances, { ...DEFAULT_EMAIL_INSTANCE_CONFIG, ...config, instanceId } as EmailInstanceConfig],
      });
    }
  }

  deleteEmailInstance(instanceId: string): void {
    const current = this.getEmailConfig();
    const updated = current.instances.filter(i => i.instanceId !== instanceId);
    this.setEmailConfig({ instances: updated });
    // Clean up session mappings for this instance
    this.db
      .prepare('DELETE FROM im_session_mappings WHERE platform = ?')
      .run(`email:${instanceId}`);
  }

  // ==================== Utility ====================

  /**
   * Clear all IM configuration
   */
  clearConfig(): void {
    this.db.prepare('DELETE FROM im_config').run();
  }

  /**
   * Check if IM is configured (at least one platform has credentials)
   */
  isConfigured(): boolean {
    const config = this.getConfig();
    const hasDingTalk =
      config.dingtalk?.instances?.some(i => !!(i.clientId && i.clientSecret)) ?? false;
    const hasFeishu = config.feishu?.instances?.some(i => !!(i.appId && i.appSecret)) ?? false;
    const hasTelegram = config.telegram?.instances?.some(i => !!i.botToken) ?? false;
    const hasDiscord = config.discord?.instances?.some(i => !!i.botToken) ?? false;
    const hasNim = config.nim?.instances?.some(i => !!(i.nimToken || (i.appKey && i.account && i.token))) ?? false;
    const hasNeteaseBeeChan = !!(config['netease-bee']?.clientId && config['netease-bee']?.secret);
    const hasQQ = config.qq?.instances?.some(i => !!(i.appId && i.appSecret)) ?? false;
    const hasWecom = config.wecom?.instances?.some(i => !!(i.botId && i.secret)) ?? false;
    return (
      hasDingTalk ||
      hasFeishu ||
      hasTelegram ||
      hasDiscord ||
      hasNim ||
      hasNeteaseBeeChan ||
      hasQQ ||
      hasWecom
    );
  }

  // ==================== Notification Target Persistence ====================

  /**
   * Get persisted notification target for a platform
   */
  getNotificationTarget(platform: Platform): any | null {
    return this.getConfigValue<any>(`notification_target:${platform}`) ?? null;
  }

  /**
   * Persist notification target for a platform
   */
  setNotificationTarget(platform: Platform, target: any): void {
    this.setConfigValue(`notification_target:${platform}`, target);
  }

  getConversationReplyRoute(
    platform: Platform,
    conversationId: string,
  ): StoredConversationReplyRoute | null {
    const normalizedConversationId = conversationId.trim();
    if (!normalizedConversationId) {
      return null;
    }
    return (
      this.getConfigValue<StoredConversationReplyRoute>(
        `conversation_reply_route:${platform}:${normalizedConversationId}`,
      ) ?? null
    );
  }

  setConversationReplyRoute(
    platform: Platform,
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
  getSessionMapping(imConversationId: string, platform: Platform): IMSessionMapping | null {
    const row = this.db
      .prepare(
        'SELECT im_conversation_id, platform, cowork_session_id, agent_id, created_at, last_active_at FROM im_session_mappings WHERE im_conversation_id = ? AND platform = ?',
      )
      .get(imConversationId, platform) as SessionMappingRow | undefined;
    if (!row) return null;
    return {
      imConversationId: row.im_conversation_id,
      platform: row.platform as Platform,
      coworkSessionId: row.cowork_session_id,
      agentId: row.agent_id || 'main',
      createdAt: row.created_at,
      lastActiveAt: row.last_active_at,
    };
  }

  /**
   * Find the IM mapping that owns a given cowork session ID.
   */
  getSessionMappingByCoworkSessionId(coworkSessionId: string): IMSessionMapping | null {
    const row = this.db
      .prepare(
        'SELECT im_conversation_id, platform, cowork_session_id, agent_id, created_at, last_active_at FROM im_session_mappings WHERE cowork_session_id = ? LIMIT 1',
      )
      .get(coworkSessionId) as SessionMappingRow | undefined;
    if (!row) return null;
    return {
      imConversationId: row.im_conversation_id,
      platform: row.platform as Platform,
      coworkSessionId: row.cowork_session_id,
      agentId: row.agent_id || 'main',
      createdAt: row.created_at,
      lastActiveAt: row.last_active_at,
    };
  }

  /**
   * Create a new session mapping
   */
  createSessionMapping(
    imConversationId: string,
    platform: Platform,
    coworkSessionId: string,
    agentId: string = 'main',
  ): IMSessionMapping {
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO im_session_mappings (im_conversation_id, platform, cowork_session_id, agent_id, created_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(imConversationId, platform, coworkSessionId, agentId, now, now);
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
  updateSessionLastActive(imConversationId: string, platform: Platform): void {
    const now = Date.now();
    this.db
      .prepare(
        'UPDATE im_session_mappings SET last_active_at = ? WHERE im_conversation_id = ? AND platform = ?',
      )
      .run(now, imConversationId, platform);
  }

  /**
   * Update the target session and agent for an existing mapping.
   * Used when the platform's agent binding changes.
   */
  updateSessionMappingTarget(
    imConversationId: string,
    platform: Platform,
    newCoworkSessionId: string,
    newAgentId: string,
  ): void {
    const now = Date.now();
    this.db
      .prepare(
        'UPDATE im_session_mappings SET cowork_session_id = ?, agent_id = ?, last_active_at = ? WHERE im_conversation_id = ? AND platform = ?',
      )
      .run(newCoworkSessionId, newAgentId, now, imConversationId, platform);
  }

  /**
   * Delete a session mapping
   */
  deleteSessionMapping(imConversationId: string, platform: Platform): void {
    this.db
      .prepare('DELETE FROM im_session_mappings WHERE im_conversation_id = ? AND platform = ?')
      .run(imConversationId, platform);
  }

  /**
   * Delete all session mappings that reference a given cowork session ID.
   * Called when a cowork session is deleted so that the IM conversation
   * can be re-synced as a fresh session.
   */
  deleteSessionMappingByCoworkSessionId(coworkSessionId: string): void {
    this.db
      .prepare('DELETE FROM im_session_mappings WHERE cowork_session_id = ?')
      .run(coworkSessionId);
  }

  /**
   * List all session mappings for a platform, optionally filtered by IM bot accountId.
   *
   * The accountId is encoded as the first segment of im_conversation_id before
   * the peer subtype suffix (for example "c9c41984:direct:ou_xxx" or the legacy
   * NIM form "appKey-account:direct:peer"). Filtering by accountId therefore
   * requires no schema migration. NIM additionally accepts the current stable
   * instance key and matches legacy runtime-derived prefixes for compatibility.
   */
  listSessionMappings(platform?: Platform, accountId?: string): IMSessionMapping[] {
    let query: string;
    let params: unknown[];

    if (platform && accountId) {
      const directPrefixes = new Set<string>([accountId]);
      if (platform === 'nim') {
        for (const inst of this.getNimInstances()) {
          const instanceKey = inst.instanceId?.slice(0, 8);
          if (instanceKey !== accountId) continue;
          const runtimeAccountId = deriveNimRuntimeAccountIdForInstance(inst);
          if (runtimeAccountId) {
            directPrefixes.add(normalizeNimLegacyConversationPrefix(runtimeAccountId));
          }
        }
      }

      // Include direct conversations owned by this bot instance (prefix matches accountId)
      // and all group conversations for the platform, since group membership per-bot
      // is not yet stored — group: prefix is a temporary heuristic until im_account_id
      // column is introduced.
      const directClauses = Array.from(directPrefixes).map(() => 'im_conversation_id LIKE ?');
      query = `SELECT im_conversation_id, platform, cowork_session_id, agent_id, created_at, last_active_at
        FROM im_session_mappings
        WHERE platform = ?
          AND (${directClauses.join(' OR ')} OR im_conversation_id LIKE 'group:%')
        ORDER BY last_active_at DESC`;
      params = [platform, ...Array.from(directPrefixes).map((prefix) => `${prefix}:%`)];
    } else if (platform) {
      query =
        'SELECT im_conversation_id, platform, cowork_session_id, agent_id, created_at, last_active_at FROM im_session_mappings WHERE platform = ? ORDER BY last_active_at DESC';
      params = [platform];
    } else {
      query =
        'SELECT im_conversation_id, platform, cowork_session_id, agent_id, created_at, last_active_at FROM im_session_mappings ORDER BY last_active_at DESC';
      params = [];
    }

    const rows = this.db.prepare(query).all(...params) as SessionMappingRow[];
    return rows.map(row => ({
      imConversationId: row.im_conversation_id,
      platform: row.platform as Platform,
      coworkSessionId: row.cowork_session_id,
      agentId: row.agent_id || 'main',
      createdAt: row.created_at,
      lastActiveAt: row.last_active_at,
    }));
  }
}
