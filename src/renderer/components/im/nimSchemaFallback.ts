import type { UiHint } from './SchemaForm';

export const nimFallbackInstanceSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    enabled: { type: 'boolean' },
    nimToken: { type: 'string' },
    appKey: { type: 'string' },
    account: { type: 'string' },
    token: { type: 'string' },
    antispamEnabled: { type: 'boolean' },
    p2p: {
      type: 'object',
      additionalProperties: false,
      properties: {
        policy: {
          type: 'string',
          enum: ['open', 'allowlist', 'disabled'],
        },
        allowFrom: {
          type: 'array',
          items: {
            oneOf: [{ type: 'string' }, { type: 'number' }],
          },
        },
      },
    },
    team: {
      type: 'object',
      additionalProperties: false,
      properties: {
        policy: {
          type: 'string',
          enum: ['open', 'allowlist', 'disabled'],
        },
        allowFrom: {
          type: 'array',
          items: {
            oneOf: [{ type: 'string' }, { type: 'number' }],
          },
        },
      },
    },
    qchat: {
      type: 'object',
      additionalProperties: false,
      properties: {
        policy: {
          type: 'string',
          enum: ['open', 'allowlist', 'disabled'],
        },
        allowFrom: {
          type: 'array',
          items: {
            oneOf: [{ type: 'string' }, { type: 'number' }],
          },
        },
      },
    },
    advanced: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mediaMaxMb: { type: 'number', minimum: 0 },
        textChunkLimit: { type: 'integer', minimum: 1 },
        debug: { type: 'boolean' },
        legacyLogin: { type: 'boolean' },
        weblbsUrl: { type: 'string' },
        link_web: { type: 'string' },
        nos_uploader: { type: 'string' },
        nos_downloader_v2: { type: 'string' },
        nosSsl: { type: 'boolean' },
        nos_accelerate: { type: 'string' },
        nos_accelerate_host: { type: 'string' },
      },
    },
  },
};

export const nimFallbackUiHints: Record<string, UiHint> = {
  appKey: { order: 1, label: 'App Key' },
  account: { order: 2, label: 'Account ID' },
  token: { order: 3, label: 'Token', sensitive: true },
  antispamEnabled: { order: 10, label: 'Anti-spam Protection' },
  p2p: { order: 20, label: 'P2P' },
  'p2p.policy': { order: 21, label: 'Message Policy' },
  'p2p.allowFrom': { order: 22, label: 'Account Allowlist' },
  team: { order: 30, label: 'Team' },
  'team.policy': { order: 31, label: 'Message Policy' },
  'team.allowFrom': { order: 32, label: 'Team Allowlist' },
  qchat: { order: 40, label: 'QChat' },
  'qchat.policy': { order: 41, label: 'Message Policy' },
  'qchat.allowFrom': { order: 42, label: 'Server / Channel / Account Allowlist' },
  advanced: { order: 50, label: 'Advanced', advanced: true },
  'advanced.mediaMaxMb': { order: 51, label: 'Max Media Size (MB)' },
  'advanced.textChunkLimit': { order: 52, label: 'Text Chunk Limit' },
  'advanced.debug': { order: 53, label: 'Debug Mode', advanced: true },
  'advanced.legacyLogin': { order: 54, label: 'Legacy Login Mode', advanced: true },
  'advanced.weblbsUrl': { order: 55, label: 'LBS URL (Private Deploy)', advanced: true },
  'advanced.link_web': { order: 56, label: 'Link Server URL (Private Deploy)', advanced: true },
  'advanced.nos_uploader': { order: 57, label: 'NOS Upload URL (Private Deploy)', advanced: true },
  'advanced.nos_downloader_v2': { order: 58, label: 'NOS Download URL Format (Private Deploy)', advanced: true },
  'advanced.nosSsl': { order: 59, label: 'NOS Download HTTPS (Private Deploy)', advanced: true },
  'advanced.nos_accelerate': { order: 60, label: 'CDN Accelerate URL (Private Deploy)', advanced: true },
  'advanced.nos_accelerate_host': { order: 61, label: 'CDN Accelerate Host (Private Deploy)', advanced: true },
};
