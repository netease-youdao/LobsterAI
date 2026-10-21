import { DEFAULT_COMPANION_SKIN, DesktopCompanionSize } from './constants';

export const CompanionSkinKind = {
  /** The app icon's lobster on a disc; task status appears in a small badge. */
  Brand: 'brand',
  Image: 'image',
} as const;
export type CompanionSkinKind = typeof CompanionSkinKind[keyof typeof CompanionSkinKind];

export interface CompanionSkin {
  id: string;
  nameKey: string;
  kind: CompanionSkinKind;
  /** Relative to the companion page; null unless the kind is image. */
  asset: string | null;
  /** Accent used for skin selection highlights. */
  accent: string;
}

export const COMPANION_SKINS: readonly CompanionSkin[] = [
  { id: DEFAULT_COMPANION_SKIN, nameKey: 'desktopCompanionSkinLobster', kind: CompanionSkinKind.Brand, asset: null, accent: '#F2482A' },
  { id: 'ruanruanxia', nameKey: 'desktopCompanionSkinRuanruanxia', kind: CompanionSkinKind.Image, asset: './desktop-companion/skins/ruanruanxia.webp', accent: '#EE3B2F' },
  { id: 'xingxingxing', nameKey: 'desktopCompanionSkinXingxingxing', kind: CompanionSkinKind.Image, asset: './desktop-companion/skins/xingxingxing.webp', accent: '#F4A62A' },
  { id: 'shaee', nameKey: 'desktopCompanionSkinShaee', kind: CompanionSkinKind.Image, asset: './desktop-companion/skins/shaee.webp', accent: '#2F8BEA' },
  { id: 'zhangduoduo', nameKey: 'desktopCompanionSkinZhangduoduo', kind: CompanionSkinKind.Image, asset: './desktop-companion/skins/zhangduoduo.webp', accent: '#E2392F' },
  { id: 'jingyiming', nameKey: 'desktopCompanionSkinJingyiming', kind: CompanionSkinKind.Image, asset: './desktop-companion/skins/jingyiming.webp', accent: '#2A7FE0' },
  { id: 'liuliuyu', nameKey: 'desktopCompanionSkinLiuliuyu', kind: CompanionSkinKind.Image, asset: './desktop-companion/skins/liuliuyu.webp', accent: '#F26B1D' },
  { id: 'danpapa', nameKey: 'desktopCompanionSkinDanpapa', kind: CompanionSkinKind.Image, asset: './desktop-companion/skins/danpapa.webp', accent: '#F2B829' },
  { id: 'qingqingpiao', nameKey: 'desktopCompanionSkinQingqingpiao', kind: CompanionSkinKind.Image, asset: './desktop-companion/skins/qingqingpiao.webp', accent: '#8C7CF0' },
];

export function normalizeCompanionSkin(value: unknown): string {
  return typeof value === 'string' && COMPANION_SKINS.some(skin => skin.id === value) ? value : DEFAULT_COMPANION_SKIN;
}

export function getCompanionSkin(id: string): CompanionSkin {
  return COMPANION_SKINS.find(skin => skin.id === id) ?? COMPANION_SKINS[0];
}

/** The orb window for a skin. */
export function companionOrbSize(id: string): { width: number; height: number } {
  return getCompanionSkin(id).kind === CompanionSkinKind.Brand ? DesktopCompanionSize.BrandOrb : DesktopCompanionSize.Orb;
}
