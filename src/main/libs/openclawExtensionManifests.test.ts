import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../../');

function readManifest(extensionId: string): Record<string, unknown> {
  const manifestPath = path.join(repoRoot, 'openclaw-extensions', extensionId, 'openclaw.plugin.json');
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
}

function readContractTools(extensionId: string): string[] {
  const manifest = readManifest(extensionId);
  const contracts = manifest.contracts as { tools?: unknown } | undefined;
  return Array.isArray(contracts?.tools)
    ? contracts.tools.filter((tool): tool is string => typeof tool === 'string')
    : [];
}

function readPackageOpenClawExtensions(extensionId: string): string[] {
  const packagePath = path.join(repoRoot, 'openclaw-extensions', extensionId, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { openclaw?: { extensions?: unknown } };
  return Array.isArray(pkg.openclaw?.extensions)
    ? pkg.openclaw.extensions.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

describe('OpenClaw extension manifests', () => {
  test('declares the AskUserQuestion agent tool contract', () => {
    expect(readContractTools('ask-user-question')).toEqual(['AskUserQuestion']);
  });

  test('declares LobsterAI media generation and skin agent tool contracts', () => {
    expect(readContractTools('lobster-media-generation')).toEqual([
      'lobsterai_image_generate',
      'lobsterai_video_generate',
      'lobsterai_skin_manage',
    ]);
  });

  test('declares the experimental decision model agent tool contract', () => {
    expect(readContractTools('lobster-decision')).toEqual(['decision_evaluate']);
  });

  test('declares TypeScript entries for local extensions that are precompiled for packaging', () => {
    expect(readPackageOpenClawExtensions('mcp-bridge')).toEqual(['./index.ts']);
    expect(readPackageOpenClawExtensions('ask-user-question')).toEqual(['./index.ts']);
    expect(readPackageOpenClawExtensions('lobster-media-generation')).toEqual(['./index.ts']);
    expect(readPackageOpenClawExtensions('lobster-decision')).toEqual(['./index.ts']);
    expect(readPackageOpenClawExtensions('lobsterai-model-compat')).toEqual(['./index.ts']);
  });

  test('declares a strict allowlisted model-profile config for LobsterAI compatibility', () => {
    const manifest = readManifest('lobsterai-model-compat');
    expect(manifest.providers).toEqual(['lobsterai-model-compat']);
    // The v2026.8.1 Gateway only imports provider plugins whose provider ids are
    // referenced by configured agent models; the "lobsterai-server" API owner hint
    // is not consulted, and runs cannot lazy-load plugins inside a prepared plugin
    // generation. Startup activation keeps the compatibility owner in every
    // Gateway generation so package and custom K3 hooks apply from the first run.
    expect(manifest.activation).toEqual({
      onStartup: true,
      onProviders: ['lobsterai-server'],
    });
    expect(manifest.configSchema).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        modelProfiles: {
          type: 'object',
          minProperties: 1,
          propertyNames: {
            pattern: '^[^/\\s]+/[^\\s]+$',
          },
          additionalProperties: {
            type: 'string',
            enum: ['moonshot-kimi-k3'],
          },
        },
        thinkingProfiles: {
          type: 'object',
          minProperties: 1,
          propertyNames: {
            pattern: '^[^/\\s]+/[^\\s]+$',
          },
          additionalProperties: {
            type: 'object',
            additionalProperties: false,
            properties: {
              options: {
                type: 'array',
                minItems: 1,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    level: {
                      type: 'string',
                      enum: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
                    },
                    openclawLevel: {
                      type: 'string',
                      enum: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
                    },
                  },
                  required: ['level', 'openclawLevel'],
                },
              },
              defaultLevel: {
                type: 'string',
                enum: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
              },
              requestOptionsVersion: {
                type: 'integer',
                enum: [1],
              },
            },
            required: ['options', 'defaultLevel'],
          },
        },
      },
      anyOf: [
        { required: ['modelProfiles'] },
        { required: ['thinkingProfiles'] },
      ],
    });
  });
});
