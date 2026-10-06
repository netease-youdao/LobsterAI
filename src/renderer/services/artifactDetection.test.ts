import { describe, expect, test } from 'vitest';

import { ShareDeploymentCandidateSource } from '../../shared/shareDeployment/constants';
import type { CoworkMessage } from '../types/cowork';
import { collectSessionArtifacts } from './artifactDetection';

const CWD = '/Users/admin/project012';

const assistantMessage = (id: string, content: string): CoworkMessage => ({
  id,
  type: 'assistant',
  content,
  timestamp: Date.now(),
} as CoworkMessage);

const editToolUse = (id: string, filePath: string, toolName = 'Edit'): CoworkMessage => ({
  id,
  type: 'tool_use',
  content: '',
  timestamp: Date.now(),
  metadata: {
    toolName,
    toolUseId: `tu-${id}`,
    toolInput: { file_path: filePath, old_string: 'a', new_string: 'b' },
  },
} as CoworkMessage);

const toolResult = (toolUseMsg: CoworkMessage, isError = false): CoworkMessage => ({
  id: `result-${toolUseMsg.id}`,
  type: 'tool_result',
  content: isError ? 'failed' : 'OK',
  timestamp: Date.now(),
  metadata: { toolUseId: toolUseMsg.metadata?.toolUseId, ...(isError ? { isError: true } : {}) },
} as CoworkMessage);

describe('collectSessionArtifacts', () => {
  test('edit-only turn without any link in the reply still yields an artifact', () => {
    const toolUse = editToolUse('tool1', `${CWD}/随便写一个 Markdown.md`);
    const messages = [
      toolUse,
      toolResult(toolUse),
      assistantMessage('a1', '改好了。'),
    ];

    const detected = collectSessionArtifacts(messages, 'sess1', CWD);
    expect(detected).toHaveLength(1);
    expect(detected[0].type).toBe('markdown');
    expect(detected[0].messageId).toBe('tool1');
    expect(detected[0].filePath).toBe(`${CWD}/随便写一个 Markdown.md`);
  });

  test('plain-path markdown link in the reply yields an artifact', () => {
    const messages = [
      assistantMessage('a1', `全部检查通过：[使用Agent.html](${CWD}/使用Agent.html)`),
    ];

    const detected = collectSessionArtifacts(messages, 'sess1', CWD);
    expect(detected).toHaveLength(1);
    expect(detected[0].type).toBe('html');
    expect(detected[0].messageId).toBe('a1');
    expect(detected[0].filePath).toBe(`${CWD}/使用Agent.html`);
  });

  test('relative markdown link is resolved against the session cwd', () => {
    const messages = [
      assistantMessage('a1', '产出：[报告](./output/report.html)'),
    ];

    const detected = collectSessionArtifacts(messages, 'sess1', CWD);
    expect(detected).toHaveLength(1);
    expect(detected[0].filePath).toBe(`${CWD}/output/report.html`);
  });

  test('linked files under .cowork-temp are suppressed', () => {
    const messages = [
      assistantMessage('a1', `[草稿](${CWD}/.cowork-temp/draft.md)`),
    ];

    expect(collectSessionArtifacts(messages, 'sess1', CWD)).toHaveLength(0);
  });

  test('write/edit tool artifacts under .cowork-temp are suppressed', () => {
    const toolUse = editToolUse('tool1', `${CWD}/.cowork-temp/rebuild.md`, 'Write');
    const messages = [toolUse, toolResult(toolUse)];

    expect(collectSessionArtifacts(messages, 'sess1', CWD)).toHaveLength(0);
  });

  test('bare paths in prose are kept only inside the session cwd', () => {
    const messages = [
      assistantMessage('a1', [
        `已生成 ${CWD}/dist/index.html`,
        '参考了 /etc/config/other/sample.md',
      ].join('\n')),
    ];

    const detected = collectSessionArtifacts(messages, 'sess1', CWD);
    expect(detected).toHaveLength(1);
    expect(detected[0].filePath).toBe(`${CWD}/dist/index.html`);
  });

  test('linked files outside the cwd (e.g. Desktop) are kept', () => {
    const messages = [
      assistantMessage('a1', '[便笺.md](/Users/admin/Desktop/便笺.md)'),
    ];

    const detected = collectSessionArtifacts(messages, 'sess1', CWD);
    expect(detected).toHaveLength(1);
    expect(detected[0].filePath).toBe('/Users/admin/Desktop/便笺.md');
  });

  test('collects localhost service urls alongside file artifacts', () => {
    const messages = [
      assistantMessage('a1', `服务已启动 http://localhost:5173 页面 [首页](${CWD}/index.html)`),
    ];

    const detected = collectSessionArtifacts(messages, 'sess1', CWD);
    const types = detected.map(artifact => artifact.type).sort();
    expect(types).toEqual(['html', 'local-service']);
  });

  test('preserves project context for detected local services', () => {
    const messages = [
      {
        id: 'tool1',
        type: 'tool_use',
        content: '',
        timestamp: Date.now(),
        metadata: {
          toolName: 'Bash',
          toolInput: { command: `cd ${CWD}/app && npm run dev` },
        },
      },
      assistantMessage('a1', '服务已启动：http://localhost:5173'),
    ] as CoworkMessage[];

    const detected = collectSessionArtifacts(messages, 'sess1', CWD);
    const localService = detected.find(artifact => artifact.type === 'local-service');
    expect(localService?.localService?.projectDirectory).toBe(`${CWD}/app`);
    expect(localService?.localService?.projectCandidates?.[0].source).toBe(
      ShareDeploymentCandidateSource.ToolCdCommand,
    );
  });

  test('failed edit tool calls yield no artifacts', () => {
    const toolUse = editToolUse('tool1', `${CWD}/report.md`);
    const messages = [toolUse, toolResult(toolUse, true)];

    expect(collectSessionArtifacts(messages, 'sess1', CWD)).toHaveLength(0);
  });
});
