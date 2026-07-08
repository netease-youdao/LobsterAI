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

  test('declares LobsterAI media generation agent tool contracts', () => {
    expect(readContractTools('lobster-media-generation')).toEqual([
      'lobsterai_image_generate',
      'lobsterai_video_generate',
    ]);
  });

  test('declares TypeScript entries for local extensions that are precompiled for packaging', () => {
    expect(readPackageOpenClawExtensions('mcp-bridge')).toEqual(['./index.ts']);
    expect(readPackageOpenClawExtensions('ask-user-question')).toEqual(['./index.ts']);
    expect(readPackageOpenClawExtensions('lobster-media-generation')).toEqual(['./index.ts']);
  });
});
