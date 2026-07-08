import type { LocalizedText } from '../kit/constants';

export const ComputerUseKitId = {
  BuiltIn: 'computer-use',
} as const;
export type ComputerUseKitId = typeof ComputerUseKitId[keyof typeof ComputerUseKitId];

export const ComputerUseSkillId = {
  BuiltIn: 'computer-use',
} as const;
export type ComputerUseSkillId = typeof ComputerUseSkillId[keyof typeof ComputerUseSkillId];

export const ComputerUseKitBundle = {
  MacArm64: 'builtin://computer-use/skill-bundle/mac-arm64/1.0.809',
  WindowsX64: 'https://ydhardwarebusiness.nosdn.127.net/2fa564627a3f1a0f3acedbc771d15f12.zip',
} as const;
export type ComputerUseKitBundle =
  typeof ComputerUseKitBundle[keyof typeof ComputerUseKitBundle];

export const ComputerUseKitBundleArchive = {
  MacArm64: 'lobsterai-computer-use-skill-mac-arm64-1.0.809.zip',
} as const;
export type ComputerUseKitBundleArchive =
  typeof ComputerUseKitBundleArchive[keyof typeof ComputerUseKitBundleArchive];

export const ComputerUseKitBundleIntegrity = {
  MacArm64: {
    Sha256: '12866fdf705eafd5fb089cc0ec6038dbee04749fdebf4934a83855e9cb68c737',
    SizeBytes: 3898,
  },
  WindowsX64: {
    Sha256: '8e214e06aef9d764d13351d9739ff0049d324dedecf29fa82d8d3a39d1e9da03',
    SizeBytes: 3149,
  },
} as const;
export type ComputerUseKitBundleIntegrity =
  typeof ComputerUseKitBundleIntegrity[keyof typeof ComputerUseKitBundleIntegrity];

export const ComputerUseKitMetadata = {
  Name: {
    en: 'Computer Use',
    zh: '电脑操作',
  } satisfies LocalizedText,
  Description: {
    en: 'Control local desktop applications with screenshots, accessibility text, clicks, typing, scrolling, and app launching.',
    zh: '通过截图、可访问性文本、点击、输入、滚动和应用启动来操作本地桌面应用。',
  } satisfies LocalizedText,
  SkillName: {
    en: 'Computer Use',
    zh: '电脑操作',
  } satisfies LocalizedText,
  SkillDescription: {
    en: 'Use LobsterAI Computer Use tools to inspect and control local desktop applications.',
    zh: '使用 LobsterAI 电脑操作工具检查和操作本地桌面应用。',
  } satisfies LocalizedText,
} as const;
