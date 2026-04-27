import fs from 'fs';
import path from 'path';
import { describe, expect, test } from 'vitest';

describe('legacy engine cleanup', () => {
  test('package.json no longer depends on the claude agent sdk', () => {
    const packageJsonPath = path.resolve(__dirname, '../../../../package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>;
    };

    expect(packageJson.dependencies?.['@anthropic-ai/claude-agent-sdk']).toBeUndefined();
  });
});
