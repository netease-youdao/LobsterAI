import {
  SkinBackdropVisibility,
  SkinPreferredAppearance,
} from '../../shared/skin/constants';
import {
  resolveSkinBackdropVisibility,
  type SkinPresentation,
} from '../../shared/skin/presentation';

export const SkinBackdropVariant = {
  Home: 'home',
  Conversation: 'conversation',
  Management: 'management',
} as const;

export type SkinBackdropVariant = typeof SkinBackdropVariant[keyof typeof SkinBackdropVariant];

export interface SkinBackdropLayerStyle {
  imageClassName: string;
  overlay: string;
  visibility?: SkinBackdropVisibility;
}

const LEGACY_HOME_OVERLAY = [
  'radial-gradient(ellipse at 50% 47%,',
  'color-mix(in srgb, var(--lobster-background) 62%, transparent) 0%,',
  'color-mix(in srgb, var(--lobster-background) 44%, transparent) 47%,',
  'color-mix(in srgb, var(--lobster-background) 22%, transparent) 100%)',
  ', linear-gradient(to bottom,',
  'color-mix(in srgb, var(--lobster-background) 12%, transparent),',
  'color-mix(in srgb, var(--lobster-background) 54%, transparent))',
].join(' ');

const LEGACY_CONVERSATION_OVERLAY = [
  'linear-gradient(to bottom,',
  'color-mix(in srgb, var(--lobster-background) 20%, transparent),',
  'color-mix(in srgb, var(--lobster-background) 36%, transparent))',
].join(' ');

const PRESENTED_HOME_OVERLAYS: Record<SkinBackdropVisibility, string> = {
  [SkinBackdropVisibility.Subtle]: [
    'radial-gradient(ellipse at 50% 46%,',
    'color-mix(in srgb, var(--lobster-skin-canvas) 64%, transparent) 0%,',
    'color-mix(in srgb, var(--lobster-skin-canvas) 46%, transparent) 48%,',
    'color-mix(in srgb, var(--lobster-skin-canvas) 28%, transparent) 100%)',
    ', linear-gradient(to bottom,',
    'color-mix(in srgb, var(--lobster-skin-canvas) 22%, transparent),',
    'color-mix(in srgb, var(--lobster-skin-canvas) 88%, transparent))',
  ].join(' '),
  [SkinBackdropVisibility.Balanced]: [
    'radial-gradient(ellipse at 50% 46%,',
    'color-mix(in srgb, var(--lobster-skin-canvas) 52%, transparent) 0%,',
    'color-mix(in srgb, var(--lobster-skin-canvas) 34%, transparent) 48%,',
    'color-mix(in srgb, var(--lobster-skin-canvas) 18%, transparent) 100%)',
    ', linear-gradient(to bottom,',
    'color-mix(in srgb, var(--lobster-skin-canvas) 12%, transparent),',
    'color-mix(in srgb, var(--lobster-skin-canvas) 82%, transparent))',
  ].join(' '),
  [SkinBackdropVisibility.Vivid]: [
    'radial-gradient(ellipse at 50% 44%,',
    'color-mix(in srgb, var(--lobster-skin-canvas) 18%, transparent) 0%,',
    'color-mix(in srgb, var(--lobster-skin-canvas) 8%, transparent) 46%,',
    'transparent 100%)',
    ', linear-gradient(to bottom,',
    'color-mix(in srgb, var(--lobster-skin-canvas) 4%, transparent) 0%,',
    'transparent 52%,',
    'color-mix(in srgb, var(--lobster-skin-canvas) 46%, transparent) 100%)',
  ].join(' '),
};

const PRESENTED_CONVERSATION_OVERLAYS: Record<
  SkinBackdropVisibility,
  { light: string; dark: string }
> = {
  [SkinBackdropVisibility.Subtle]: {
    light: [
      'linear-gradient(to bottom,',
      'color-mix(in srgb, var(--lobster-skin-canvas) 58%, transparent),',
      'color-mix(in srgb, var(--lobster-skin-canvas) 74%, transparent))',
    ].join(' '),
    dark: [
      'linear-gradient(to bottom,',
      'color-mix(in srgb, var(--lobster-skin-canvas) 44%, transparent),',
      'color-mix(in srgb, var(--lobster-skin-canvas) 60%, transparent))',
    ].join(' '),
  },
  [SkinBackdropVisibility.Balanced]: {
    light: [
      'linear-gradient(to bottom,',
      'color-mix(in srgb, var(--lobster-skin-canvas) 44%, transparent),',
      'color-mix(in srgb, var(--lobster-skin-canvas) 62%, transparent))',
    ].join(' '),
    dark: [
      'linear-gradient(to bottom,',
      'color-mix(in srgb, var(--lobster-skin-canvas) 30%, transparent),',
      'color-mix(in srgb, var(--lobster-skin-canvas) 45%, transparent))',
    ].join(' '),
  },
  [SkinBackdropVisibility.Vivid]: {
    light: [
      'linear-gradient(to bottom,',
      'color-mix(in srgb, var(--lobster-skin-canvas) 30%, transparent),',
      'color-mix(in srgb, var(--lobster-skin-canvas) 44%, transparent))',
    ].join(' '),
    dark: [
      'linear-gradient(to bottom,',
      'color-mix(in srgb, var(--lobster-skin-canvas) 20%, transparent),',
      'color-mix(in srgb, var(--lobster-skin-canvas) 34%, transparent))',
    ].join(' '),
  },
};

const PRESENTED_MANAGEMENT_OVERLAYS: Record<
  SkinBackdropVisibility,
  { light: string; dark: string }
> = {
  [SkinBackdropVisibility.Subtle]: {
    light: [
      'linear-gradient(to bottom,',
      'color-mix(in srgb, var(--lobster-skin-canvas) 48%, transparent),',
      'color-mix(in srgb, var(--lobster-skin-canvas) 62%, transparent))',
    ].join(' '),
    dark: [
      'linear-gradient(to bottom,',
      'color-mix(in srgb, var(--lobster-skin-canvas) 34%, transparent),',
      'color-mix(in srgb, var(--lobster-skin-canvas) 48%, transparent))',
    ].join(' '),
  },
  [SkinBackdropVisibility.Balanced]: {
    light: [
      'linear-gradient(to bottom,',
      'color-mix(in srgb, var(--lobster-skin-canvas) 32%, transparent),',
      'color-mix(in srgb, var(--lobster-skin-canvas) 46%, transparent))',
    ].join(' '),
    dark: [
      'linear-gradient(to bottom,',
      'color-mix(in srgb, var(--lobster-skin-canvas) 18%, transparent),',
      'color-mix(in srgb, var(--lobster-skin-canvas) 30%, transparent))',
    ].join(' '),
  },
  [SkinBackdropVisibility.Vivid]: {
    light: [
      'linear-gradient(to bottom,',
      'color-mix(in srgb, var(--lobster-skin-canvas) 22%, transparent),',
      'color-mix(in srgb, var(--lobster-skin-canvas) 34%, transparent))',
    ].join(' '),
    dark: [
      'linear-gradient(to bottom,',
      'color-mix(in srgb, var(--lobster-skin-canvas) 12%, transparent),',
      'color-mix(in srgb, var(--lobster-skin-canvas) 22%, transparent))',
    ].join(' '),
  },
};

const PRESENTED_HOME_IMAGE_CLASSES: Record<SkinBackdropVisibility, string> = {
  [SkinBackdropVisibility.Subtle]: 'opacity-[0.58] saturate-[0.92]',
  [SkinBackdropVisibility.Balanced]: 'opacity-[0.78]',
  [SkinBackdropVisibility.Vivid]: 'opacity-[0.96]',
};

const PRESENTED_CONVERSATION_IMAGE_CLASSES: Record<
  SkinBackdropVisibility,
  { light: string; dark: string }
> = {
  [SkinBackdropVisibility.Subtle]: {
    light: 'opacity-[0.16] saturate-[0.82]',
    dark: 'opacity-[0.16] saturate-[0.82]',
  },
  [SkinBackdropVisibility.Balanced]: {
    light: 'opacity-[0.26] saturate-[0.88]',
    dark: 'opacity-[0.26] saturate-[0.88]',
  },
  [SkinBackdropVisibility.Vivid]: {
    light: 'opacity-[0.38]',
    dark: 'opacity-[0.42]',
  },
};

const PRESENTED_MANAGEMENT_IMAGE_CLASSES: Record<
  SkinBackdropVisibility,
  { light: string; dark: string }
> = {
  [SkinBackdropVisibility.Subtle]: {
    light: 'opacity-[0.16] saturate-[0.82]',
    dark: 'opacity-[0.18] saturate-[0.82]',
  },
  [SkinBackdropVisibility.Balanced]: {
    light: 'opacity-[0.26] saturate-[0.88]',
    dark: 'opacity-[0.30] saturate-[0.88]',
  },
  [SkinBackdropVisibility.Vivid]: {
    light: 'opacity-[0.38]',
    dark: 'opacity-[0.44]',
  },
};

export const resolveSkinBackdropLayerStyle = (
  variant: SkinBackdropVariant,
  presentation?: SkinPresentation,
): SkinBackdropLayerStyle => {
  const isHome = variant === SkinBackdropVariant.Home;
  const isManagement = variant === SkinBackdropVariant.Management;

  if (!presentation) {
    return {
      imageClassName: isHome
        ? 'opacity-[0.82] dark:opacity-[0.72]'
        : 'opacity-[0.32] saturate-[0.90] dark:opacity-[0.28]',
      overlay: isHome ? LEGACY_HOME_OVERLAY : LEGACY_CONVERSATION_OVERLAY,
    };
  }

  const visibility = resolveSkinBackdropVisibility(presentation);
  const appearanceKey = presentation.preferredAppearance === SkinPreferredAppearance.Dark
    ? 'dark'
    : 'light';

  if (isHome) {
    return {
      imageClassName: PRESENTED_HOME_IMAGE_CLASSES[visibility],
      overlay: PRESENTED_HOME_OVERLAYS[visibility],
      visibility,
    };
  }

  if (isManagement) {
    return {
      imageClassName: PRESENTED_MANAGEMENT_IMAGE_CLASSES[visibility][appearanceKey],
      overlay: PRESENTED_MANAGEMENT_OVERLAYS[visibility][appearanceKey],
      visibility,
    };
  }

  return {
    imageClassName: PRESENTED_CONVERSATION_IMAGE_CLASSES[visibility][appearanceKey],
    overlay: PRESENTED_CONVERSATION_OVERLAYS[visibility][appearanceKey],
    visibility,
  };
};
