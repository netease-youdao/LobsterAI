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
  MacArm64: 'https://ydschool-video.nosdn.127.net/1791282471603lobsterai-computer-use-skill-mac-arm64-0.2.1.zip',
  WindowsX64: 'https://ydhardwarebusiness.nosdn.127.net/2fa564627a3f1a0f3acedbc771d15f12.zip',
} as const;
export type ComputerUseKitBundle =
  typeof ComputerUseKitBundle[keyof typeof ComputerUseKitBundle];

export const ComputerUseKitBundleIntegrity = {
  MacArm64: {
    Sha256: '133b6db94a87d9c3544c9c120162df6adbe61ad807e59ca20f8ec359adb48844',
    SizeBytes: 2586,
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
