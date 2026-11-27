import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { RetainedImPlatform as Im } from '../../shared/dshEngine/hostConstants';
import { legacyImBotIdentities, preserveLegacyImBotIdentities } from '../migration/legacyImBotIdentities';
import { IMStore } from './imStore';
import type { DirectSessionRoute } from './legacyDirectSessionMapping';
import type { Platform } from './types';

const instanceId = '12345678-first';
const agentId = 'agent-a';
let db: Database.Database;
let store: IMStore;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
    CREATE TABLE cowork_sessions (id TEXT PRIMARY KEY, agent_id TEXT);
    INSERT INTO cowork_sessions VALUES ('old', 'agent-a'), ('split', 'agent-a'), ('another', 'agent-b');
  `);
  store = new IMStore(db);
});
afterEach(() => db.close());

function configure(key: string, config: Record<string, unknown> = {}) {
  db.prepare('INSERT OR REPLACE INTO im_config VALUES (?, ?, 1)').run(key, JSON.stringify(config));
}

test('recovers the original ordinary Feishu group independently of a newer raw chat mapping', () => {
  configure('feishu:' + instanceId, { appId: 'cli_original' });
  const chatId = 'oc_shared';
  store.createSessionMapping('group:' + chatId, Im.Feishu, 'old', agentId, 'agent:agent-a:feishu:group:oc_shared');
  store.createSessionMapping(chatId, ('feishu:' + instanceId) as Platform, 'split', agentId);
  const route = { instanceId, agentId, chatId, conversationIds: ['group:' + chatId] };
  expect(store.findLegacyFeishuGroupSessionMapping(route)?.coworkSessionId).toBe('old');
  expect(store.findLegacyFeishuGroupSessionMapping({ ...route, agentId: 'agent-b' })).toBeNull();
});

describe('Feishu topic and bot ownership across upgrades', () => {
  const group = 'oc_shared';
  const topic = 'group:oc_shared:thread:omt_TopicA';
  const other = '87654321-second';
  const route = { instanceId, agentId, chatId: group, conversationIds: [topic] };

  test('finds legacy scoped and accountless topics without confusing case or bot identity', () => {
    configure('feishu:' + instanceId, { instanceId, appId: 'cli_original' });
    configure('feishu:' + other, { instanceId: other, appId: 'cli_other' });
    store.setIMSettings({ platformAgentBindings: { ['feishu:' + instanceId]: agentId, ['feishu:' + other]: 'agent-b' } });
    preserveLegacyImBotIdentities(db);
    store.createSessionMapping(topic, Im.Feishu, 'old', agentId);
    expect(store.findLegacyFeishuGroupSessionMapping(route)?.coworkSessionId).toBe('old');
    expect(store.findLegacyFeishuGroupSessionMapping({ ...route, conversationIds: [topic.toLowerCase()] })).toBeNull();
    expect(store.findLegacyFeishuGroupSessionMapping({ ...route, instanceId: other })).toBeNull();
    store.setIMSettings({ platformAgentBindings: { ['feishu:' + instanceId]: agentId, ['feishu:' + other]: agentId } });
    expect(store.findLegacyFeishuGroupSessionMapping(route)).toBeNull();
    store.createSessionMapping('feishu:' + topic, 'feishu:12345678' as Platform, 'old', agentId);
    expect(store.findLegacyFeishuGroupSessionMapping(route)?.coworkSessionId).toBe('old');
    configure('feishu:' + instanceId, { instanceId, appId: 'cli_replaced' });
    expect(store.findLegacyFeishuGroupSessionMapping(route)).toBeNull();
  });

  test('lists the selected bot by full or unique short ID even when both bots share a peer and expert', () => {
    configure('feishu:' + instanceId, { instanceId });
    configure('feishu:' + other, { instanceId: other });
    store.createSessionMapping(group, ('feishu:' + instanceId) as Platform, 'old', agentId);
    store.createSessionMapping(group, ('feishu:' + other) as Platform, 'split', agentId);
    store.createSessionMapping(topic, 'feishu:12345678' as Platform, 'old', agentId);
    for (const selected of [instanceId, instanceId.slice(0, 8)]) {
      expect(store.listSessionMappings(Im.Feishu, selected).map(row => row.coworkSessionId)).toEqual(['old', 'old']);
    }
    expect(store.listSessionMappings(Im.Feishu, other.slice(0, 8)).map(row => row.coworkSessionId)).toEqual(['split']);
    configure('feishu:12345678-collision', { instanceId: '12345678-collision' });
    expect(store.listSessionMappings(Im.Feishu, '12345678')).toEqual([]);
    expect(store.listSessionMappings(Im.Feishu, instanceId)).toHaveLength(1);
  });
});

describe('OpenClaw to DSH direct conversation keys', () => {
  test.each([
    [Im.DingTalk, '12345678:direct:staff42', 'cid_DingTalk', 'staff42'],
    [Im.Feishu, '12345678:direct:ou_contact', 'oc_chat', 'ou_contact'],
    [Im.WeCom, '12345678:direct:alice', 'wecom_chat', 'Alice'],
    [Im.QQ, '12345678:direct:abc123', 'ABC123', 'ABC123'],
    [Im.Weixin, 'old-im-bot:direct:alice@im.wechat', 'ALICE@im.wechat', 'ALICE@im.wechat'],
  ] as const)('recovers the original %s transcript even after an earlier version split it', (platform, key, chatId, senderId) => {
    const isWeixin = platform === Im.Weixin;
    if (isWeixin) {
      configure(platform, { accountId: 'old-im-bot', botToken: 'old-credential' });
      preserveLegacyImBotIdentities(db);
      expect(legacyImBotIdentities(db)).toEqual([{ key: 'weixin', accountId: 'old-im-bot' }]);
      configure(platform, { accountId: 'replacement@im.bot', userId: senderId });
    } else {
      configure(`${platform}:${instanceId}`, { instanceId });
    }
    store.createSessionMapping(key, platform, 'old', agentId);
    const nativePlatform = isWeixin ? platform : `${platform}:${instanceId}` as Platform;
    store.createSessionMapping(chatId, nativePlatform, 'split', agentId);
    const route = { platform, instanceId: isWeixin ? 'default' : instanceId, agentId, chatId, senderId };
    expect(store.findLegacyDirectSessionMapping(route)?.coworkSessionId).toBe('old');
    expect(store.findLegacyDirectSessionMapping({ ...route, agentId: 'agent-b' })).toBeNull();
    expect(store.findLegacyDirectSessionMapping({ ...route, senderId: 'different-peer' })).toBeNull();
    expect(db.prepare('SELECT count(*) AS n FROM cowork_sessions').get()).toEqual({ n: 3 });
  });

  test('requires a unique bot prefix and live session with the same agent', () => {
    const route: DirectSessionRoute = { platform: Im.Feishu, instanceId, agentId, chatId: 'oc_1', senderId: 'ou_1' };
    configure(`feishu:${instanceId}`);
    configure('feishu:12345678-other');
    store.createSessionMapping('12345678:direct:ou_1', Im.Feishu, 'old', agentId);
    store.createSessionMapping('direct:ou_1', Im.Feishu, 'old', agentId);
    store.createSessionMapping(`${instanceId}:group:ou_1`, Im.Feishu, 'old', agentId);
    expect(store.findLegacyDirectSessionMapping(route)).toBeNull();
    store.createSessionMapping(`${instanceId}:direct:ou_1`, Im.Feishu, 'another', agentId);
    expect(store.findLegacyDirectSessionMapping(route)).toBeNull();
    store.updateSessionMappingTarget(`${instanceId}:direct:ou_1`, Im.Feishu, 'old', agentId, undefined, agentId);
    expect(store.findLegacyDirectSessionMapping(route)?.coworkSessionId).toBe('old');
    db.prepare('DELETE FROM cowork_sessions WHERE id = ?').run('old');
    expect(store.findLegacyDirectSessionMapping(route)).toBeNull();
  });

  test('declines two plausible sessions for one peer', () => {
    configure(`qq:${instanceId}`);
    store.createSessionMapping('12345678:direct:abc', Im.QQ, 'old', agentId);
    store.createSessionMapping(`${instanceId}:direct:abc`, Im.QQ, 'split', agentId);
    expect(store.findLegacyDirectSessionMapping({ platform: Im.QQ, instanceId, agentId, chatId: 'ABC' })).toBeNull();
  });

  test('recognizes a single-bot configuration after IMStore assigns its first full instance ID', () => {
    configure('feishuOpenClaw', { appId: 'same-app' });
    store.createSessionMapping('direct:ou_peer', Im.Feishu, 'old', agentId);
    preserveLegacyImBotIdentities(db);
    const upgraded = new IMStore(db);
    const [bot] = upgraded.getFeishuInstances();
    configure('feishu:another-bot', { appId: 'different-app' });
    const route = { platform: Im.Feishu, instanceId: bot.instanceId, agentId, senderId: 'ou_peer', chatId: 'oc_chat' };
    expect(upgraded.findLegacyDirectSessionMapping(route)?.coworkSessionId).toBe('old');
    expect(upgraded.findLegacyDirectSessionMapping({ ...route, instanceId: 'another-bot' })).toBeNull();
  });

  test('rejects a replacement bot in the same slot and considers retired instances for short-prefix collisions', () => {
    const route = { platform: Im.Feishu, instanceId, agentId, senderId: 'ou_peer', chatId: 'oc_chat' };
    const key = `feishu:${instanceId}`;
    configure(key, { appId: 'original-app' });
    configure('feishu:12345678-retired', { appId: 'retired-app' });
    preserveLegacyImBotIdentities(db);
    db.prepare('DELETE FROM im_config WHERE key = ?').run('feishu:12345678-retired');
    store.createSessionMapping('12345678:direct:ou_peer', Im.Feishu, 'old', agentId);
    expect(store.findLegacyDirectSessionMapping(route)).toBeNull();
    store.createSessionMapping(instanceId + ':direct:ou_peer', Im.Feishu, 'old', agentId);
    expect(store.findLegacyDirectSessionMapping(route)?.coworkSessionId).toBe('old');
    configure(key, { appId: 'replacement-app' });
    expect(store.findLegacyDirectSessionMapping(route)).toBeNull();
  });

  test('requires evidence that a bare DingTalk peer belongs to this bot and direct chat', () => {
    configure(`dingtalk:${instanceId}`);
    const context = { channel: 'dingtalk-connector', chattype: 'direct', accountid: '12345678', peerid: 'staff' };
    const key = (account: string) => 'agent:agent-a:openai-user:' + JSON.stringify({ ...context, accountid: account });
    store.createSessionMapping('staff', Im.DingTalk, 'old', agentId, key('other'));
    const route = { platform: Im.DingTalk, instanceId, agentId, chatId: 'cid_1', senderId: 'staff' };
    expect(store.findLegacyDirectSessionMapping(route)).toBeNull();
    store.updateSessionOpenClawSessionKey('staff', Im.DingTalk, key('12345678'), agentId);
    expect(store.findLegacyDirectSessionMapping(route)?.coworkSessionId).toBe('old');
  });

  test('does not claim a Weixin conversation across unrelated owners or guess a historic bot', () => {
    const peer = 'friend@im.wechat';
    configure(Im.Weixin, { accountId: 'original@im.bot', userId: 'old-owner' });
    preserveLegacyImBotIdentities(db);
    store.createSessionMapping('original-im-bot:direct:' + peer, Im.Weixin, 'old', agentId);
    const route = { platform: Im.Weixin, instanceId: 'default', agentId, chatId: peer };
    configure(Im.Weixin, { accountId: 'new@im.bot', userId: 'other-owner' });
    expect(store.findLegacyDirectSessionMapping(route)).toBeNull();
    configure(Im.Weixin, { accountId: 'new@im.bot', userId: 'old-owner' });
    expect(store.findLegacyDirectSessionMapping(route)?.coworkSessionId).toBe('old');
    configure(Im.Weixin, { accountId: 'original@im.bot' });
    expect(store.findLegacyDirectSessionMapping(route)?.coworkSessionId).toBe('old');
  });
});
