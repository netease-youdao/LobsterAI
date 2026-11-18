import { afterEach, describe, expect, test, vi } from 'vitest';

import { ShareDeploymentCandidateSource } from '../../shared/shareDeployment/constants';
import { type Artifact, ArtifactTypeValue } from '../types/artifact';
import type { CoworkMessage } from '../types/cowork';
import { collectSessionArtifacts, loadDetectedFileArtifact } from './artifactDetection';

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

describe('loadDetectedFileArtifact', () => {
  const MTIME_MS = 1_761_700_000_123;

  const fileArtifact = (type: Artifact['type'], filePath: string): Artifact => ({
    id: `artifact-${type}`,
    messageId: 'm1',
    sessionId: 'sess1',
    type,
    title: filePath.split('/').pop() ?? filePath,
    content: '',
    filePath,
    source: 'file',
    createdAt: 1,
  });

  const stubDialog = (options: { exists: boolean; dataUrl?: string }) => {
    const dialog = {
      statFile: vi.fn(async () => (options.exists
        ? { success: true, isFile: true, mtimeMs: MTIME_MS }
        : { success: false, error: 'ENOENT' })),
      readFileAsDataUrl: vi.fn(async () => (options.exists && options.dataUrl
        ? { success: true, dataUrl: options.dataUrl }
        : { success: false, error: 'ENOENT' })),
    };
    vi.stubGlobal('window', { electron: { dialog } });
    return dialog;
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('image files are only checked for existence, never read as a data URL', async () => {
    const dialog = stubDialog({ exists: true, dataUrl: 'data:image/png;base64,AAAA' });

    const loaded = await loadDetectedFileArtifact(fileArtifact(ArtifactTypeValue.Image, `${CWD}/out/cat.png`), CWD);

    expect(dialog.readFileAsDataUrl).not.toHaveBeenCalled();
    expect(dialog.statFile).toHaveBeenCalledWith(`${CWD}/out/cat.png`);
    expect(loaded).toMatchObject({ content: '', filePath: `${CWD}/out/cat.png`, contentVersion: MTIME_MS });
  });

  test('relative image paths resolve against the session cwd', async () => {
    const dialog = stubDialog({ exists: true });

    const loaded = await loadDetectedFileArtifact(fileArtifact(ArtifactTypeValue.Image, 'out/cat.png'), CWD);

    expect(dialog.statFile).toHaveBeenCalledWith(`${CWD}/out/cat.png`);
    expect(loaded?.filePath).toBe(`${CWD}/out/cat.png`);
  });

  test('missing image files yield no artifact', async () => {
    const dialog = stubDialog({ exists: false });

    expect(await loadDetectedFileArtifact(fileArtifact(ArtifactTypeValue.Image, `${CWD}/gone.png`), CWD)).toBeNull();
    expect(dialog.readFileAsDataUrl).not.toHaveBeenCalled();
  });

  test('text files are still read and decoded', async () => {
    const dialog = stubDialog({ exists: true, dataUrl: `data:text/markdown;base64,${btoa('# hi')}` });

    const loaded = await loadDetectedFileArtifact(fileArtifact(ArtifactTypeValue.Markdown, `${CWD}/notes.md`), CWD);

    expect(dialog.readFileAsDataUrl).toHaveBeenCalledWith(`${CWD}/notes.md`);
    expect(loaded?.content).toBe('# hi');
  });
});
