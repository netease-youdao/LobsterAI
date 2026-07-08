import { afterEach, expect, test, vi } from 'vitest';

const nodeRuntimeMocks = vi.hoisted(() => ({
  resolveNodeRuntimeForSpawn: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
    isPackaged: false,
  },
}));

vi.mock('../libs/nodeRuntime', () => nodeRuntimeMocks);

import { __skillServicesTestUtils } from './skillServices';

afterEach(() => {
  nodeRuntimeMocks.resolveNodeRuntimeForSpawn.mockReset();
});

test('resolveSkillServiceNodeRuntime delegates to shared node runtime resolution', () => {
  nodeRuntimeMocks.resolveNodeRuntimeForSpawn.mockReturnValue({
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: [],
    env: {},
  });

  expect(__skillServicesTestUtils.resolveSkillServiceNodeRuntime({ PATH: 'ignored' })).toEqual({
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: [],
    extraEnv: undefined,
  });
});

test('resolveSkillServiceNodeRuntime preserves Electron-as-node fallback env', () => {
  nodeRuntimeMocks.resolveNodeRuntimeForSpawn.mockReturnValue({
    command: 'C:\\LobsterAI\\LobsterAI.exe',
    args: [],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  });

  expect(__skillServicesTestUtils.resolveSkillServiceNodeRuntime({ PATH: 'ignored' })).toEqual({
    command: 'C:\\LobsterAI\\LobsterAI.exe',
    args: [],
    extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
  });
});
