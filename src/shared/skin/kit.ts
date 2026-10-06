import { SkinWorkflowKind } from './constants';

export const SkinPackKitId = {
  BuiltIn: 'ai-skin-designer',
} as const;

export type SkinPackKitId = typeof SkinPackKitId[keyof typeof SkinPackKitId];

export const SkinPackSkillId = {
  BuiltIn: 'skin-creator',
} as const;

export type SkinPackSkillId = typeof SkinPackSkillId[keyof typeof SkinPackSkillId];

export const SkinPackKitBundle = {
  BuiltIn: `builtin://${SkinPackKitId.BuiltIn}`,
} as const;

export const SkinPackKitMetadata = {
  Version: '0.3.0',
  IconUrl: 'https://ydhardwarecommon.nosdn.127.net/2f862627ac5bd30d4292f9752e7828e6.png',
  WorkflowKind: SkinWorkflowKind.SkinPack,
} as const;
