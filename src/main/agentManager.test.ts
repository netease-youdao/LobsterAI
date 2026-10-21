import { beforeEach, describe, expect, test, vi } from 'vitest';

import { DefaultAgentAvatarIcon } from '../shared/agent/avatar';
import { AgentId, AgentSource } from '../shared/agent/constants';
import { createExpertCatalogFixture, ExpertFixtureId } from '../shared/agent/expertCatalogFixture';
import { AgentManager } from './agentManager';
import type { Agent, CoworkStore, CreateAgentRequest, UpdateAgentRequest } from './coworkStore';
import { setLanguage } from './i18n';

const agents = new Map<string, Agent>();
const loadCatalog = vi.fn(async () => createExpertCatalogFixture());
const refreshAvatar = vi.fn((id: string, icon: string) => {
  const agent = { ...agents.get(id), icon, iconCustomized: false } as Agent;
  agents.set(id, agent);
  return agent;
});
const manager = new AgentManager({
  updatePresetAgentAvatar: refreshAvatar,
  listAgents: () => [...agents.values()],
  getAgent: (id: string) => agents.get(id) ?? null,
  createAgent: (request: CreateAgentRequest) => {
    const agent = { ...request, id: request.id ?? 'generated-id', enabled: true } as Agent;
    agents.set(agent.id, agent);
    return agent;
  },
  updateAgent: (id: string, updates: UpdateAgentRequest) => {
    const agent = { ...agents.get(id), ...updates } as Agent;
    agents.set(id, agent);
    return agent;
  },
} as unknown as CoworkStore, loadCatalog);

beforeEach(() => {
  agents.clear();
  refreshAvatar.mockClear();
  loadCatalog.mockReset().mockImplementation(async () => createExpertCatalogFixture());
  setLanguage('zh');
});

test('catalog refresh updates only managed preset avatars and preserves all other agent settings', async () => {
  const first = (await manager.addPresetAgent(ExpertFixtureId.Data))!;
  manager.updateAgent(first.id, { name: 'Custom name', systemPrompt: 'Custom prompt', model: 'custom/model', skillIds: ['docx'] });
  const before = { ...agents.get(first.id) };
  const catalog = createExpertCatalogFixture();
  const icon = 'https://ydhardwarecommon.nosdn.127.net/category-research.webp';
  catalog.experts[0].icon = icon;
  loadCatalog.mockResolvedValue(catalog);
  expect(await manager.getExpertCatalog()).toEqual(catalog);
  expect(agents.get(first.id)).toEqual({ ...before, icon, iconCustomized: false });
  await manager.getExpertCatalog();
  expect(refreshAvatar).toHaveBeenCalledTimes(1);
});

test('catalog refresh leaves user-selected icons, main and custom agents unchanged', async () => {
  const catalog = createExpertCatalogFixture();
  catalog.experts[0].icon = 'https://ydhardwarecommon.nosdn.127.net/category-research.webp';
  loadCatalog.mockResolvedValue(catalog);
  for (const agent of [
    { id: 'edited', source: AgentSource.Preset, icon: DefaultAgentAvatarIcon, iconCustomized: true },
    { id: 'legacy-edit', source: AgentSource.Preset, icon: 'https://ydhardwarecommon.nosdn.127.net/user.webp' },
    { id: AgentId.Main, source: AgentSource.Preset, icon: DefaultAgentAvatarIcon, iconCustomized: false },
    { id: 'custom', source: AgentSource.Custom, icon: DefaultAgentAvatarIcon, iconCustomized: false },
  ]) agents.set(agent.id, { ...agent, presetId: ExpertFixtureId.Data } as Agent);
  const before = [...agents.values()];
  await manager.getExpertCatalog();
  expect([...agents.values()]).toEqual(before);
  expect(refreshAvatar).not.toHaveBeenCalled();
});

describe('expert preset installation', () => {
  test('installs a localized agent with the default model and bundled capabilities', async () => {
    setLanguage('en');
    const agent = await manager.addPresetAgent(ExpertFixtureId.Data, ' provider/model ');
    expect(agent).toMatchObject({
      name: 'Test Data Partner', model: 'provider/model', workingDirectory: '',
      source: AgentSource.Preset, presetId: ExpertFixtureId.Data, skillIds: ['xlsx', 'create-plan'],
    });
    expect(agent?.systemPrompt).toContain('Inspect actual data');
  });

  test('reuses an expert offline without resetting user edits and re-enables disabled instances', async () => {
    const first = (await manager.addPresetAgent(ExpertFixtureId.Data))!;
    manager.updateAgent(first.id, { name: '我的编辑', systemPrompt: 'Custom prompt', model: 'custom/model', skillIds: ['docx'], enabled: false });
    loadCatalog.mockRejectedValue(new Error('Offline'));
    expect(await manager.addPresetAgent(ExpertFixtureId.Data, 'another/model')).toMatchObject({
      id: first.id, name: '我的编辑', systemPrompt: 'Custom prompt', model: 'custom/model', skillIds: ['docx'], enabled: true,
    });
    expect(agents.size).toBe(1);
  });

  test('does not commandeer an unrelated agent with the same ID', async () => {
    const custom = { id: ExpertFixtureId.App, source: AgentSource.Custom, name: 'My own agent' } as Agent;
    agents.set(custom.id, custom);
    const expert = (await manager.addPresetAgent(ExpertFixtureId.App))!;
    expect(expert.id).not.toBe(custom.id);
    expect((await manager.addPresetAgent(ExpertFixtureId.App))?.id).toBe(expert.id);
    expect(agents.get(custom.id)).toEqual(custom);
    expect(agents.size).toBe(2);
  });

  test('a new catalog improves new installations without rewriting an installed legacy agent', async () => {
    const installed = (await manager.addPresetAgent(ExpertFixtureId.Data, 'legacy/model'))!;
    manager.updateAgent(installed.id, { name: 'My data expert', identity: 'My identity', workingDirectory: '/my-data' });
    const before = { ...agents.get(installed.id)! };
    const catalog = createExpertCatalogFixture();
    const preset = catalog.experts.find(item => item.id === ExpertFixtureId.Data)!;
    preset.systemPrompt = 'Produce a complete report from the supplied example.';
    preset.skillIds = ['xlsx'];
    preset.starterPrompts[0] = { zh: '直接生成示例报告。', en: 'Create the example report.' };
    loadCatalog.mockResolvedValue(catalog);

    expect((await manager.getExpertCatalog()).experts[0].starterPrompts[0]).toEqual(preset.starterPrompts[0]);
    expect(await manager.addPresetAgent(ExpertFixtureId.Data, 'new/model')).toEqual(before);
    expect(agents.size).toBe(1);

    // A separate fresh installation receives the improved preset. Existing users
    // keep their original prompt, planning skill, model and working directory.
    agents.clear();
    expect(await manager.addPresetAgent(ExpertFixtureId.Data, 'new/model')).toMatchObject({
      systemPrompt: preset.systemPrompt, skillIds: ['xlsx'], model: 'new/model', workingDirectory: '',
    });
  });

  test('deleted experts can be summoned again and unknown IDs create nothing', async () => {
    await manager.addPresetAgent(ExpertFixtureId.Data);
    agents.delete(ExpertFixtureId.Data);
    expect((await manager.addPresetAgent(ExpertFixtureId.Data))?.presetId).toBe(ExpertFixtureId.Data);
    expect(await manager.addPresetAgent('missing-preset')).toBeNull();
    expect(agents.size).toBe(1);
  });

  test('concurrent summons share one installed agent', async () => {
    const results = await Promise.all([manager.addPresetAgent(ExpertFixtureId.Data), manager.addPresetAgent(ExpertFixtureId.Data)]);
    expect(results[0]?.id).toBe(results[1]?.id);
    expect(agents.size).toBe(1);
    expect((await manager.getPresetAgents()).map(preset => preset.id)).toEqual([ExpertFixtureId.App]);
  });
});
