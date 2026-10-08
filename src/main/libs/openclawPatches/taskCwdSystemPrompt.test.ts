import { describe, expect, test } from 'vitest';

import {
  expectOpenClawSourceContains,
  expectPatchContains,
  isOpenClawSourceAvailable,
  readCurrentOpenClawPatch,
} from './patchTestUtils';

const patchFile = 'zz-openclaw-task-cwd-system-prompt.patch';

describe('OpenClaw task cwd system prompt patch', () => {
  test('carries separate task and agent workspace directory roles', () => {
    expectPatchContains(patchFile, [
      'runtimeCwd?: string',
      'runtimeCwd: effectiveCwd',
      '## Directory Roles',
      'Task working directory:',
      'Agent workspace:',
      'MEMORY.md, and memory/**',
      'use their absolute path under the agent workspace',
      'runtimeCwd: sanitizedRuntimeCwd',
      'preserves workspace guidance when task cwd is not separate',
      'expect(promptCall?.runtimeCwd).toBe(taskRepo)',
    ]);

    expect(readCurrentOpenClawPatch(patchFile)).not.toContain('workspaceDir: effectiveCwd');
  });

  test.skipIf(!isOpenClawSourceAvailable())('is applied to the local OpenClaw source tree', () => {
    expectOpenClawSourceContains([
      {
        file: 'src/agents/system-prompt.ts',
        snippets: [
          'runtimeCwd?: string',
          'const hasSeparateRuntimeCwd =',
          '"## Directory Roles"',
          'MEMORY.md, and memory/**',
          'runtimeCwd: sanitizedRuntimeCwd',
        ],
      },
      {
        file: 'src/agents/embedded-agent-runner/system-prompt.ts',
        snippets: ['runtimeCwd?: string', 'runtimeCwd: params.runtimeCwd'],
      },
      {
        file: 'src/agents/embedded-agent-runner/run/attempt-system-prompt-prepare.ts',
        snippets: ['runtimeCwd: params.effectiveCwd'],
      },
      {
        file: 'src/agents/embedded-agent-runner/prepared-compaction-runtime.ts',
        snippets: ['runtimeCwd: effectiveCwd'],
      },
    ]);
  });
});
