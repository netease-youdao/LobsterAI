import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import type { InstalledKitRecord } from '../../shared/kit/constants';
import { SkinWorkflowKind } from '../../shared/skin/constants';
import { SkinPackKitId } from '../../shared/skin/kit';
import { MediaSelectionMode } from '../mediaGenerationPolicy';
import { SkinRuntimeController } from './skinRuntimeController';

const installedSkinKit: InstalledKitRecord = {
  id: SkinPackKitId.BuiltIn,
  version: '0.1.0',
  installedAt: 1,
  workflowKind: SkinWorkflowKind.SkinPack,
  skills: null,
  mcpServers: [],
  connectors: [],
};

const createController = (parents: Record<string, string | null> = {}) => new SkinRuntimeController({
  rootDir: path.join(os.tmpdir(), 'lobsterai-skin-runtime-controller-test'),
  getInstalledKits: () => ({ [SkinPackKitId.BuiltIn]: installedSkinKit }),
  getParentSessionId: sessionId => parents[sessionId] ?? null,
  resolveSessionId: () => null,
  resolveMediaSelection: () => undefined,
});

describe('SkinRuntimeController.hasActiveWorkflow', () => {
  test('reports a running skin workflow for the session and its child sessions', () => {
    const controller = createController({ child: 'owner' });
    expect(controller.hasActiveWorkflow('owner')).toBe(false);

    controller.prepareTurn({
      sessionId: 'owner',
      kitIds: [SkinPackKitId.BuiltIn],
      mediaGenerationEntitled: true,
      mediaSelection: { mode: MediaSelectionMode.Image, imageModelId: 'image-model' },
    });

    expect(controller.hasActiveWorkflow('owner')).toBe(true);
    expect(controller.hasActiveWorkflow('child')).toBe(true);
    expect(controller.hasActiveWorkflow('other')).toBe(false);
    expect(controller.hasActiveWorkflow(null)).toBe(false);

    controller.handleRuntimeError('owner');
    expect(controller.hasActiveWorkflow('owner')).toBe(false);
  });
});
