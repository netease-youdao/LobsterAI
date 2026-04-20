export const AgentAvatarExtension = {
  Png: 'png',
  Jpg: 'jpg',
  Jpeg: 'jpeg',
  Webp: 'webp',
  Gif: 'gif',
  Bmp: 'bmp',
  Avif: 'avif',
} as const;

export type AgentAvatarExtension =
  typeof AgentAvatarExtension[keyof typeof AgentAvatarExtension];

export const AgentAvatarAllowedExtensions = Object.values(AgentAvatarExtension);

export const AgentAvatarErrorCode = {
  UnsupportedFileType: 'unsupported_file_type',
  FileTooLarge: 'file_too_large',
  SourceNotFound: 'source_not_found',
  ImportFailed: 'import_failed',
} as const;

export type AgentAvatarErrorCode =
  typeof AgentAvatarErrorCode[keyof typeof AgentAvatarErrorCode];

export const AGENT_AVATAR_MAX_BYTES = 5 * 1024 * 1024;
export const AGENT_AVATAR_MAX_MB = Math.floor(AGENT_AVATAR_MAX_BYTES / (1024 * 1024));
export const AGENT_AVATAR_DIR_NAME = 'agent-avatars';
