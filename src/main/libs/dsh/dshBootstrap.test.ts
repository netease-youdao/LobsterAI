import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8'),
  },
}));

import {
  DECISION_EVALUATE_TOOL_NAME,
  DecisionModelProvider,
} from '../../../shared/decisionModel/constants';
import { type DecisionModelConfig, DEFAULT_DECISION_MODEL_CONFIG } from '../decisionModelConfig';
import { DshBootstrap } from './dshBootstrap';
import { createDshDecisionToolProvider } from './dshDecisionTool';

const tempDirs: string[] = [];
const openDbs: Database.Database[] = [];

describe('DshBootstrap.syncAllConfig', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    while (openDbs.length > 0) openDbs.pop()!.close();
    while (tempDirs.length > 0) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  });

  test('calls syncDynamicHostTools so toggling decision model hot-syncs without restart', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-dsh-bootstrap-'));
    tempDirs.push(userDataDir);
    const db = new Database(':memory:');
    openDbs.push(db);

    let config: DecisionModelConfig = { ...DEFAULT_DECISION_MODEL_CONFIG };
    const bootstrap = new DshBootstrap({
      userDataDir,
      db,
      skillsDir: path.join(userDataDir, 'SKILLs'),
      coworkStore: {
        getSession: () => null,
        addMessage: () => ({
          id: 'msg-1',
          type: 'assistant',
          content: '',
          timestamp: Date.now(),
        }),
        updateMessageContent: () => undefined,
        deleteMessage: () => undefined,
        updateSession: () => undefined,
      },
      getDefaultCwd: () => userDataDir,
      toolProviders: [
        createDshDecisionToolProvider({
          getConfig: () => config,
          fetch: vi.fn(),
        }),
      ],
    });

    const syncHostToolsSpy = vi.spyOn(bootstrap.hostManager, 'syncHostTools');
    const restartSpy = vi.spyOn(bootstrap.hostManager, 'restart');

    const syncInput = {
      providers: {},
      mcpServers: [],
      skillsPolicy: { enabledIds: null, disabledIds: [] },
    };

    const first = await bootstrap.syncAllConfig(syncInput);
    expect(first.success).toBe(true);
    expect(syncHostToolsSpy).toHaveBeenCalledTimes(1);
    expect(syncHostToolsSpy.mock.calls[0][0]).toEqual([]);

    config = {
      enabled: true,
      provider: DecisionModelProvider.Compatible,
      endpoint: 'http://127.0.0.1:41999/v1/systemone',
      apiKey: 'secret-decision-key',
      apiKeys: { [DecisionModelProvider.Compatible]: 'secret-decision-key' },
    };

    const second = await bootstrap.syncAllConfig(syncInput);
    expect(second.success).toBe(true);
    expect(syncHostToolsSpy).toHaveBeenCalledTimes(2);
    expect(syncHostToolsSpy.mock.calls[1][0].map(tool => tool.name)).toEqual([DECISION_EVALUATE_TOOL_NAME]);
    expect(restartSpy).not.toHaveBeenCalled();

    await bootstrap.stop();
  });
});
