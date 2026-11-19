import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, expect, test, vi } from 'vitest';

import { AgentSource } from '../../shared/agent/constants';
import { createExpertCatalogFixture } from '../../shared/agent/expertCatalogFixture';
import type { Agent, UpdateAgentRequest } from '../coworkStore';
import { AgentPersonaFile } from './agentPersonaFiles';
import { PET_VLOG_PRESET_ID, upgradePetVlogPreset } from './petVlogPresetUpgrade';

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-vlog-upgrade-'));
const preset = {
  ...createExpertCatalogFixture().experts[0], id: PET_VLOG_PRESET_ID,
  name: '萌宠 Vlog 导演', nameEn: 'Pet Vlog Director', identity: '新导演设定', systemPrompt: '先交付基础剪辑版',
};
const legacyIdentity = '你是写实萌宠生活 Vlog 导演兼剪辑师。你负责从一句创意到真实可播放的视频，把主角的细小动作剪成有起伏的生活故事。';
const stored = {
  id: 'existing-agent', source: AgentSource.Preset, presetId: PET_VLOG_PRESET_ID,
  name: '小葵 Vlog', identity: legacyIdentity, description: '我的介绍', systemPrompt: '用户自定流程',
} as Agent;

const version = '2026-11-19.1';
function createStore() {
  let snapshot: string | null = null;
  return {
    getPresetDefaultsSnapshot: () => snapshot,
    savePresetDefaults: vi.fn((_id: string, _changes: UpdateAgentRequest, next: string) => { snapshot = next; }),
  };
}

afterAll(() => fs.rmdirSync(workspace));

afterEach(() => {
  for (const file of Object.values(AgentPersonaFile)) fs.rmSync(path.join(workspace, file), { force: true });
});

test('upgrades shipped fields and preserves the existing instance and customized workspace', () => {
  const store = createStore();
  const identity = path.join(workspace, AgentPersonaFile.Identity);
  fs.writeFileSync(identity, '独立编辑的身份');
  upgradePetVlogPreset(stored, preset, version, workspace, store);
  expect(store.savePresetDefaults).toHaveBeenCalledWith(stored.id, { name: preset.name, identity: preset.identity }, expect.any(String));
  expect(fs.readFileSync(identity, 'utf8')).toBe('独立编辑的身份');
  expect(fs.existsSync(path.join(workspace, AgentPersonaFile.Soul))).toBe(false);
  fs.writeFileSync(identity, legacyIdentity + '\r\n');
  const other = createStore();
  upgradePetVlogPreset({ ...stored, name: '工作室猫片' }, preset, version, workspace, other);
  expect(fs.readFileSync(identity, 'utf8')).toBe(preset.identity + '\n');
  expect(other.savePresetDefaults).toHaveBeenCalledWith(stored.id, { identity: preset.identity }, expect.any(String));
});

test('matches the installed language and only upgrades this preset', () => {
  const store = createStore();
  const agent = { ...stored, name: 'Xiaokui Vlog', identity: 'custom' };
  upgradePetVlogPreset(agent, preset, version, workspace, store);
  expect(store.savePresetDefaults).toHaveBeenCalledWith(stored.id, { name: preset.nameEn }, expect.any(String));
  upgradePetVlogPreset({ ...stored, source: AgentSource.Custom }, preset, version, workspace, store);
  upgradePetVlogPreset({ ...stored, presetId: 'other' }, preset, version, workspace, store);
  expect(store.savePresetDefaults).toHaveBeenCalledTimes(1);
});

test.each(['zh', 'en'] as const)('tracks new %s catalog defaults across releases and restarts', language => {
  const store = createStore();
  const first = language === 'zh' ? preset.systemPrompt : preset.systemPromptEn;
  const installed = { ...stored, systemPrompt: first };
  const soul = path.join(workspace, AgentPersonaFile.Soul);
  fs.writeFileSync(soul, first + '\r\n');
  upgradePetVlogPreset(installed, preset, version, workspace, store);
  const updated = { ...installed, name: preset.name, identity: preset.identity };
  const release = { ...preset, systemPrompt: '新的工作流', systemPromptEn: 'New workflow' };
  const nextPrompt = language === 'zh' ? release.systemPrompt : release.systemPromptEn;
  upgradePetVlogPreset(updated, release, '2026-11-19.10', workspace, store);
  expect(store.savePresetDefaults).toHaveBeenLastCalledWith(installed.id, { systemPrompt: nextPrompt }, expect.any(String));
  expect(fs.readFileSync(soul, 'utf8')).toBe(nextPrompt + '\n');
  const current = { ...updated, systemPrompt: nextPrompt };
  upgradePetVlogPreset(current, release, '2026-11-19.10', workspace, store);
  upgradePetVlogPreset(current, preset, '2026-11-19.9', workspace, store);
  expect(store.savePresetDefaults).toHaveBeenCalledTimes(2);
  expect(fs.readFileSync(soul, 'utf8')).toBe(nextPrompt + '\n');

  const third = { ...release, systemPrompt: '再次发布', systemPromptEn: 'Third release' };
  fs.writeFileSync(soul, 'Workspace edit');
  upgradePetVlogPreset({ ...current, systemPrompt: 'My studio workflow' }, third, '2026-11-20.1', workspace, store);
  expect(store.savePresetDefaults).toHaveBeenLastCalledWith(installed.id, {}, expect.any(String));
  expect(fs.readFileSync(soul, 'utf8')).toBe('Workspace edit');
});

test('waits for a current catalog when bootstrapping a newer shipped instance', () => {
  const store = createStore();
  const agent = { ...stored, name: preset.name };
  const stale = { ...preset, name: '小葵 Vlog' };
  upgradePetVlogPreset(agent, stale, '2026-11-18.2', workspace, store);
  upgradePetVlogPreset(agent, stale, '2026-11-18.2', workspace, store);
  expect(store.savePresetDefaults).not.toHaveBeenCalled();
  upgradePetVlogPreset(agent, preset, version, workspace, store);
  expect(store.savePresetDefaults).toHaveBeenCalledOnce();
});
