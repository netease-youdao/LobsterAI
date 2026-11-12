import { createHash } from 'node:crypto';

import { PptAssetKind, type PptCatalog, PptExampleMode, PptWorkflow } from '../../src/shared/pptCreation/constants';

export const pptMaterial = Buffer.from('quarter,revenue\nQ1,100\nQ2,120\n');
/** Structural unit-test fixture only; never publish these placeholder URLs. */
export function pptCatalogFixture(): PptCatalog {
  const text = { zh: '测试', en: 'Test' };
  return {
    schemaVersion: 1, version: 'test-v1', enabled: true, expertPresetId: 'powerpoint-deck-builder', templates: [],
    examples: [{
      id: 'quarterly-report', title: text, description: text, prompt: { zh: '使用演示数据制作季度汇报', en: 'Create a quarterly report using demo data' },
      customPrompt: { zh: '只根据用户资料制作经营汇报', en: 'Use only the user materials to create a business report' },
      defaultMode: PptExampleMode.Guided, defaultWorkflow: PptWorkflow.Outline, slideCount: 10, modelName: 'Unit test fixture',
      previews: [{ url: 'https://ydhardwarecommon.nosdn.127.net/unit-test-cover.png', slide: 1 }], requiresMaterial: true,
      materials: [{ id: 'quarterly-data', name: 'quarterly.csv', kind: PptAssetKind.Csv,
        url: 'https://ydhardwarecommon.nosdn.127.net/unit-test-data.csv', sha256: createHash('sha256').update(pptMaterial).digest('hex') }],
    }],
  };
}
