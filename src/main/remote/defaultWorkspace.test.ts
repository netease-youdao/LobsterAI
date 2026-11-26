import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { prepareDefaultWorkspace } from './defaultWorkspace';

const temporary: string[] = [];
const directory = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-default-workspace-'));
  temporary.push(root);
  return root;
};
afterEach(async () => { await Promise.all(temporary.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

describe('default remote work directory', () => {
  test('creates the application default and returns its canonical location', async () => {
    const target = path.join(await directory(), 'lobsterai', 'project');
    const result = await prepareDefaultWorkspace(target, target);
    expect(result.path).toBe(await fs.realpath(target));
    expect(result.name).toBe('project');
  });
  test('uses an existing explicit directory but does not create or substitute an unavailable project', async () => {
    const root = await directory();
    const configured = path.join(root, 'project');
    const fallback = path.join(root, 'fallback');
    await expect(prepareDefaultWorkspace(configured, fallback)).rejects.toThrow();
    await expect(fs.stat(configured)).rejects.toThrow();
    await expect(fs.stat(fallback)).rejects.toThrow();
    await fs.mkdir(configured);
    expect((await prepareDefaultWorkspace(configured, fallback)).path).toBe(await fs.realpath(configured));
  });
  test('rejects a regular file as a work directory', async () => {
    const root = await directory();
    const file = path.join(root, 'document.txt');
    await fs.writeFile(file, 'text');
    await expect(prepareDefaultWorkspace(file, path.join(root, 'fallback'))).rejects.toThrow('not a directory');
  });
});
