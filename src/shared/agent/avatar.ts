export const AgentAvatarIconFormat = {
  Svg: 'agent-avatar-svg',
} as const;

export type AgentAvatarIconFormat = typeof AgentAvatarIconFormat[keyof typeof AgentAvatarIconFormat];

export const AgentAvatarIconSeparator = {
  Value: ':',
} as const;

export const AgentAvatarSvg = {
  Lobster: 'lobster',
  Code: 'code',
  Repair: 'repair',
  Briefcase: 'briefcase',
  ShoppingCart: 'shopping-cart',
  Data: 'data',
  Document: 'document',
  Folder: 'folder',
  Tag: 'tag',
  Brain: 'brain',
  GraduationCap: 'graduation-cap',
  Books: 'books',
  Experiment: 'experiment',
  Diagnosis: 'diagnosis',
  Scales: 'scales',
  Translation: 'translation',
  TranslationAlt: 'translation-alt',
  Creation: 'creation',
  Artboard: 'artboard',
  Music: 'music',
  Entertainment: 'entertainment',
  Headphones: 'headphones',
  Inspiration: 'inspiration',
  Lightning: 'lightning',
  Travel: 'travel',
  Fitness: 'fitness',
  Meditation: 'meditation',
  Heart: 'heart',
  PottedPlant: 'potted-plant',
  Pet: 'pet',
} as const;

export type AgentAvatarSvg = typeof AgentAvatarSvg[keyof typeof AgentAvatarSvg];

export interface DesignedAgentAvatar {
  svg: AgentAvatarSvg;
}

const AGENT_AVATAR_PART_COUNT = 2;

const AGENT_AVATAR_SVGS = new Set<string>(Object.values(AgentAvatarSvg));

export const DefaultAgentAvatar = {
  svg: AgentAvatarSvg.Lobster,
} as const satisfies DesignedAgentAvatar;

export const isAgentAvatarSvg = (value: string): value is AgentAvatarSvg => {
  return AGENT_AVATAR_SVGS.has(value);
};

export const encodeAgentAvatarIcon = (avatar: DesignedAgentAvatar): string => {
  return [
    AgentAvatarIconFormat.Svg,
    avatar.svg,
  ].join(AgentAvatarIconSeparator.Value);
};

export const DefaultAgentAvatarIcon = encodeAgentAvatarIcon(DefaultAgentAvatar);

export const parseAgentAvatarIcon = (value: string | null | undefined): DesignedAgentAvatar | null => {
  const normalized = value?.trim() ?? '';
  if (!normalized) return null;

  const parts = normalized.split(AgentAvatarIconSeparator.Value);
  if (parts.length !== AGENT_AVATAR_PART_COUNT) return null;

  const [format, svg] = parts;
  if (format !== AgentAvatarIconFormat.Svg) return null;
  if (!isAgentAvatarSvg(svg)) return null;

  return { svg };
};

export const normalizeAgentAvatarIcon = (value: string | null | undefined): string => {
  const normalized = value?.trim() ?? '';
  const avatar = parseAgentAvatarIcon(normalized);
  if (avatar) return encodeAgentAvatarIcon(avatar);
  return DefaultAgentAvatarIcon;
};
