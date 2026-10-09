import { describe, expect, test } from 'vitest';

import { CoworkCollaborationMode, type OpenClawEngineStatus } from '../../types/cowork';
import {
  buildCoworkStartPlan,
  CoworkStartBlock,
  type CoworkStartRequestInput,
  resolveCoworkStartBlock,
} from './coworkStartRequest';

const capabilities = {
  directSkillIds: ['docx'],
  runtimeSkillIds: ['docx', 'kit-skill'],
  kitReferences: [{ id: 'report-kit', name: 'Report kit' }],
  resolvedKitCapabilities: { skillIds: ['kit-skill'] },
} as unknown as CoworkStartRequestInput['capabilities'];

const base: CoworkStartRequestInput = {
  prompt: 'Draft the weekly report',
  title: 'Draft the weekly report',
  skillPrompt: '  Use the docx skill.  ',
  configSystemPrompt: 'Answer in Chinese.',
  kitIds: ['report-kit'],
  capabilities,
  collaborationMode: CoworkCollaborationMode.Default,
  cwd: '/Users/me/project',
  agentId: 'main',
  modelRef: 'lobsterai/deepseek-v4',
};

const engine = (phase: OpenClawEngineStatus['phase']) => ({ phase }) as OpenClawEngineStatus;

describe('cowork start plan', () => {
  test('sends the selected skills, kits, agent, model and folder with the combined system prompt', () => {
    const { options, runtimeSkillIds, suppressedCapabilities } = buildCoworkStartPlan(base);
    expect(options).toMatchObject({
      prompt: 'Draft the weekly report',
      cwd: '/Users/me/project',
      systemPrompt: 'Use the docx skill.\n\nAnswer in Chinese.',
      activeSkillIds: ['docx'],
      runtimeSkillIds: ['docx', 'kit-skill'],
      kitIds: ['report-kit'],
      kitReferences: capabilities.kitReferences,
      agentId: 'main',
      modelOverride: 'lobsterai/deepseek-v4',
    });
    expect(runtimeSkillIds).toEqual(['docx', 'kit-skill']);
    expect(suppressedCapabilities).toBe(false);
  });

  test('plan mode keeps skills on the message but loads none of them', () => {
    const plan = buildCoworkStartPlan({ ...base, collaborationMode: CoworkCollaborationMode.Plan });
    expect(plan.isPlanMode).toBe(true);
    expect(plan.displaySkillIds).toEqual(['docx']);
    expect(plan.runtimeSkillIds).toEqual([]);
    expect(plan.options.runtimeSkillIds).toEqual([]);
    expect(plan.suppressedCapabilities).toBe(true);
  });

  test('leaves out what was not chosen', () => {
    const { options } = buildCoworkStartPlan({
      ...base,
      skillPrompt: '',
      configSystemPrompt: '',
      kitIds: [],
      capabilities: { ...capabilities, directSkillIds: [], runtimeSkillIds: [] },
      cwd: '',
      mediaSelection: { mode: 'none' },
    });
    expect(options.systemPrompt).toBeUndefined();
    expect(options.activeSkillIds).toBeUndefined();
    expect(options.runtimeSkillIds).toBeUndefined();
    expect(options.kitIds).toBeUndefined();
    expect(options.kitReferences).toBeUndefined();
    expect(options.cwd).toBeUndefined();
    expect(options.mediaSelection).toBeUndefined();
  });
});

describe('cowork start blocks', () => {
  test('quota, then engine readiness, then a model that bills the other side', () => {
    expect(resolveCoworkStartBlock({ blockingQuotaReason: 'exhausted', engineStatus: engine('starting'), crossesBillingSide: true }))
      .toBe(CoworkStartBlock.EnterpriseQuota);
    expect(resolveCoworkStartBlock({ blockingQuotaReason: null, engineStatus: engine('starting'), crossesBillingSide: true }))
      .toBe(CoworkStartBlock.EngineNotReady);
    expect(resolveCoworkStartBlock({ blockingQuotaReason: null, engineStatus: engine('running'), crossesBillingSide: true }))
      .toBe(CoworkStartBlock.ModelBillingSide);
    expect(resolveCoworkStartBlock({ blockingQuotaReason: null, engineStatus: engine('ready'), crossesBillingSide: false })).toBeNull();
  });

  test('an unknown engine status lets the request report its own failure', () => {
    expect(resolveCoworkStartBlock({ blockingQuotaReason: null, engineStatus: null, crossesBillingSide: false })).toBeNull();
  });
});
