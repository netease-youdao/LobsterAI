import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const skillMarkdown = fs.readFileSync(path.resolve('SKILLs/youdaonote/SKILL.md'), 'utf8');

describe('YoudaoNote Skill credential setup', () => {
  test('publishes the security fix as a new Skill version', () => {
    expect(skillMarkdown).toMatch(/^version: 1\.0\.10$/m);
  });

  test('requires the user to enter the API key in their own terminal', () => {
    expect(skillMarkdown).toContain('用户必须在自己的终端中直接输入 API Key');
    expect(skillMarkdown).toContain('Agent 不得索取、接收、读取或记录明文 API Key');
  });

  test('passes the API key through stdin instead of a command-line argument', () => {
    expect(skillMarkdown).toContain('read -rsp "YoudaoNote API Key: " YDN_API_KEY');
    expect(skillMarkdown).toContain(
      `printf '%s\\n' "$YDN_API_KEY" | youdaonote config set apiKey -`,
    );
    expect(skillMarkdown).toContain('unset YDN_API_KEY');
    expect(skillMarkdown).toContain('chmod 600 "$HOME/.youdaonote.json"');
    expect(skillMarkdown).not.toMatch(/youdaonote\s+config\s+set\s+apiKey\s+(?:<[^>]+>|YOUR_KEY)/i);
  });
});
