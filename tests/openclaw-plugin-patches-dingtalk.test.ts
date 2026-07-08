import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const {
  findDingtalkDistMessageHandlers,
  patchDingtalk,
} = require('../scripts/openclaw-plugin-patches/dingtalk.cjs');

describe('openclaw DingTalk plugin patches', () => {
  test('patches Windows file URLs in source and dist message handlers', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-plugin-patch-'));
    const pluginDir = path.join(tempDir, 'dingtalk-connector');
    const sourceHandler = path.join(pluginDir, 'src', 'core', 'message-handler.ts');
    const distHandler = path.join(pluginDir, 'dist', 'message-handler-test.mjs');
    fs.mkdirSync(path.dirname(sourceHandler), { recursive: true });
    fs.mkdirSync(path.dirname(distHandler), { recursive: true });
    fs.mkdirSync(path.join(pluginDir, 'src', 'utils'), { recursive: true });

    fs.writeFileSync(
      sourceHandler,
      "const imageMarkdown = imageLocalPaths.map(p => `![image](file://${p})`).join('\\n');\n",
    );
    fs.writeFileSync(
      distHandler,
      'const imageMarkdown = imageLocalPaths.map((p) => `![image](file://${p})`).join("\\n");\n',
    );
    fs.writeFileSync(path.join(pluginDir, 'src', 'utils', 'agent.ts'), 'export {};\n');

    patchDingtalk({ runtimeExtensionsDir: tempDir, log: () => {} });

    const patchedSource = fs.readFileSync(sourceHandler, 'utf-8');
    const patchedDist = fs.readFileSync(distHandler, 'utf-8');
    expect(patchedSource).toContain('file:///${n}');
    expect(patchedDist).toContain('file:///${n}');
    expect(patchedDist).not.toContain('imageLocalPaths.map((p) => `![image](file://${p})`)');

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('finds hashed dist message handler bundles', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-plugin-patch-'));
    const pluginDir = path.join(tempDir, 'dingtalk-connector');
    const distDir = path.join(pluginDir, 'dist');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, 'message-handler-abc123.mjs'), 'export {};\n');
    fs.writeFileSync(path.join(distDir, 'message-handler-abc123.d.mts'), 'export {};\n');
    fs.writeFileSync(path.join(distDir, 'runtime-abc123.mjs'), 'export {};\n');

    expect(findDingtalkDistMessageHandlers(pluginDir)).toEqual([
      path.join(distDir, 'message-handler-abc123.mjs'),
    ]);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('patches bundled dist workspace resolver', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dingtalk-plugin-patch-'));
    const pluginDir = path.join(tempDir, 'dingtalk-connector');
    const sourceHandler = path.join(pluginDir, 'src', 'core', 'message-handler.ts');
    const distHandler = path.join(pluginDir, 'dist', 'message-handler-test.mjs');
    fs.mkdirSync(path.dirname(sourceHandler), { recursive: true });
    fs.mkdirSync(path.dirname(distHandler), { recursive: true });
    fs.mkdirSync(path.join(pluginDir, 'src', 'utils'), { recursive: true });
    fs.writeFileSync(sourceHandler, 'export {};\n');
    fs.writeFileSync(
      distHandler,
      [
        'function resolveAgentWorkspaceDir(cfg, agentId) {',
        '\tconst agentConfig = cfg.agents?.list?.find((a) => a.id === agentId);',
        '\tif (agentConfig?.workspace) return agentConfig.workspace.startsWith("~") ? path$1.join(os.homedir(), agentConfig.workspace.slice(1)) : agentConfig.workspace;',
        '\tif (agentId === "main" || agentId === cfg.defaultAgent) return path$1.join(os.homedir(), ".openclaw", "workspace");',
        '\treturn path$1.join(os.homedir(), ".openclaw", `workspace-${agentId}`);',
        '}',
      ].join('\n'),
    );
    fs.writeFileSync(path.join(pluginDir, 'src', 'utils', 'agent.ts'), 'export {};\n');

    patchDingtalk({ runtimeExtensionsDir: tempDir, log: () => {} });

    const patchedDist = fs.readFileSync(distHandler, 'utf-8');
    expect(patchedDist).toContain('dingtalk_agent_workspace_defaults_patch');
    expect(patchedDist).toContain('cfg.agents?.defaults?.workspace?.trim()');
    expect(patchedDist).toContain('path$1.join(expandWorkspacePath(fallbackWorkspace), agentId)');

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
