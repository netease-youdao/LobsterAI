import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, test } from 'vitest';

import { applyPythonEncodingDefaults, PythonEncodingEnv } from './pythonEncodingEnv';

// On Windows this deliberately exercises the shipped embeddable runtime,
// including python311._pth, rather than a developer's system Python.
const python = process.platform === 'win32'
  ? path.join(process.cwd(), 'resources', 'python-win', 'python.exe')
  : 'python3';
const probe = spawnSync(python, ['--version'], { encoding: 'utf8', timeout: 5_000 });
const pythonMissing = (probe.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
const sample = 'Bodø/Glimt 中文 🚀';

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (Object.values(PythonEncodingEnv).some(name => name === key.toUpperCase())) delete env[key];
  }
  return env;
}

describe('Python Unicode output through real child processes', () => {
  test.skipIf(pythonMissing)('reproduces the reported GBK failure on the special character', () => {
    const result = spawnSync(python, ['-c', "import sys; sys.stdout.reconfigure(encoding='gbk'); print('Bod\\u00f8/Glimt')"], {
      env: childEnv(), encoding: 'utf8', timeout: 5_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("'gbk' codec can't encode character");
  });

  test.skipIf(pythonMissing)('defaults preserve Unicode in stdin, stdout, stderr and default-encoded files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'python-encoding-'));
    try {
      const env = childEnv();
      applyPythonEncodingDefaults(env, { platform: 'win32' });
      const outputPath = path.join(dir, 'unicode.txt');
      const script = [
        'import json, sys',
        'text = sys.stdin.read()',
        'with open(sys.argv[1], "w") as stream: stream.write(text)',
        'with open(sys.argv[1]) as stream: restored = stream.read()',
        'sys.stderr.write(text)',
        'print(json.dumps({"text": text, "restored": restored, "utf8_mode": sys.flags.utf8_mode,',
        '  "stdin": sys.stdin.encoding, "stdout": sys.stdout.encoding, "stderr": sys.stderr.encoding}, ensure_ascii=False))',
      ].join('\n');
      const result = spawnSync(python, ['-c', script, outputPath], {
        env, input: sample, encoding: 'utf8', timeout: 5_000,
      });

      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        text: sample, restored: sample, utf8_mode: 1, stdin: 'utf-8', stdout: 'utf-8', stderr: 'utf-8',
      });
      expect(result.stderr).toBe(sample);
      expect(fs.readFileSync(outputPath)).toEqual(Buffer.from(sample, 'utf8'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
