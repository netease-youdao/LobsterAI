// Small synthetic catalog for protocol and onboarding tests; never bundled as content.
import { DefaultAgentAvatarIcon } from './avatar';
import { type ExpertCatalog, ExpertCatalogSchemaVersion, ExpertScenarioAccent } from './presets';

export const ExpertFixtureId = { Data: 'fixture-data', App: 'fixture-app' } as const;
export const ExpertFixtureCategory = { Research: 'fixture-research', Development: 'fixture-development' } as const;

export function createExpertCatalogFixture(): ExpertCatalog {
  return {
    schemaVersion: ExpertCatalogSchemaVersion,
    version: 'fixture.1',
    categories: [
      { id: ExpertFixtureCategory.Research, label: { zh: '研究', en: 'Research' } },
      { id: ExpertFixtureCategory.Development, label: { zh: '开发', en: 'Development' } },
    ],
    scenarios: [{ id: 'fixture-scenario', title: { zh: '精选', en: 'Featured' },
      description: { zh: '从问题开始', en: 'Start with a question' }, accent: ExpertScenarioAccent.Teal,
      expertIds: [ExpertFixtureId.Data] }],
    experts: [{
      id: ExpertFixtureId.Data, name: '测试数据顾问', nameEn: 'Test Data Partner',
      description: '检查表格并整理数据', descriptionEn: 'Inspect spreadsheets and organize data',
      identity: '检查实际数据', identityEn: 'Inspect actual data',
      systemPrompt: '检查实际数据，核对口径并输出结果。', systemPromptEn: 'Inspect actual data, verify metrics and deliver results.',
      icon: DefaultAgentAvatarIcon, skillIds: ['xlsx', 'create-plan'], category: ExpertFixtureCategory.Research,
      tags: [{ zh: '数据分析', en: 'Data analysis' }],
      starterPrompts: [{ zh: '帮我整理这张表格', en: 'Help me organize this spreadsheet' }],
    }, {
      id: ExpertFixtureId.App, name: '测试小程序开发', nameEn: 'Test Mini App Builder',
      description: '完成小程序原型', descriptionEn: 'Build a mini app prototype',
      identity: '先分析需求', identityEn: 'Analyze requirements first',
      systemPrompt: '澄清需求，开发并验证原型。', systemPromptEn: 'Clarify requirements, build and verify a prototype.',
      icon: DefaultAgentAvatarIcon, skillIds: [], category: ExpertFixtureCategory.Development,
      tags: [{ zh: '原型开发', en: 'Prototyping' }],
      starterPrompts: [{ zh: '帮我制作一个活动报名小程序', en: 'Build an event registration mini app' }],
    }],
  };
}
