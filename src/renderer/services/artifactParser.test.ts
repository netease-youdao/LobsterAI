import { describe, expect, test } from 'vitest';

import { ShareDeploymentCandidateSource } from '../../shared/shareDeployment/constants';
import {
  dedupeArtifactsForDisplay,
  hasToolResultMediaAssets,
  isIgnoredArtifactPath,
  isPathInsideDirectory,
  normalizeArtifactFilePath,
  normalizeFilePathForDedup,
  parseFileLinksFromMessage,
  parseFilePathsFromText,
  parseLocalServiceUrlsFromText,
  parseMediaTokensFromText,
  parseToolArtifact,
  parseToolResultMediaArtifacts,
  shouldParseFilePathsFromToolResult,
  toAbsoluteArtifactPath,
} from './artifactParser';

describe('normalizeArtifactFilePath', () => {
  test('strips MEDIA prefix from paths parsed as bare file paths', () => {
    expect(normalizeArtifactFilePath('MEDIA:/Users/admin/work/test/test0623/generated-video.mp4'))
      .toBe('/Users/admin/work/test/test0623/generated-video.mp4');
  });

  test('recovers absolute path from cwd-prefixed MEDIA artifacts', () => {
    expect(normalizeArtifactFilePath('/users/admin/work/test/test0623/MEDIA:/Users/admin/work/test/test0623/generated-video.mp4'))
      .toBe('/Users/admin/work/test/test0623/generated-video.mp4');
  });
});

describe('normalizeFilePathForDedup', () => {
  test('strips leading / before Windows drive letter', () => {
    expect(normalizeFilePathForDedup('/D:/path/file.html')).toBe('d:/path/file.html');
  });

  test('normalizes backslashes to forward slashes', () => {
    expect(normalizeFilePathForDedup('D:\\path\\file.html')).toBe('d:/path/file.html');
  });

  test('lowercases for case-insensitive comparison', () => {
    expect(normalizeFilePathForDedup('D:/Path/File.HTML')).toBe('d:/path/file.html');
  });

  test('handles Unix absolute paths unchanged (except lowercase)', () => {
    expect(normalizeFilePathForDedup('/home/user/file.html')).toBe('/home/user/file.html');
  });

  test('dedup matches: file:// derived path vs tool path', () => {
    const fromFileUrl = '/D:/new_ws_test_2/hello-slide.html';
    const fromTool = 'D:\\new_ws_test_2\\hello-slide.html';
    expect(normalizeFilePathForDedup(fromFileUrl)).toBe(normalizeFilePathForDedup(fromTool));
  });

  test('dedup matches file URL and local POSIX path', () => {
    const fromFileUrl = 'file:///Users/admin/work/test0522/generated-video.mp4';
    const fromTool = '/Users/admin/work/test0522/generated-video.mp4';
    expect(normalizeFilePathForDedup(fromFileUrl)).toBe(normalizeFilePathForDedup(fromTool));
  });
});

describe('parseFileLinksFromMessage', () => {
  test('strips leading / from Windows file:// link path', () => {
    const content = '文件：[hello.pptx](file:///D:/workspace/hello.pptx)';
    const artifacts = parseFileLinksFromMessage(content, 'msg1', 'sess1');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].filePath).toBe('D:/workspace/hello.pptx');
  });

  test('preserves Unix file:// link path', () => {
    const content = '[report.pdf](file:///home/user/report.pdf)';
    const artifacts = parseFileLinksFromMessage(content, 'msg1', 'sess1');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].filePath).toBe('/home/user/report.pdf');
  });

  test('handles URI-encoded paths', () => {
    const content = '[文件.pptx](file:///D:/my%20folder/%E6%96%87%E4%BB%B6.pptx)';
    const artifacts = parseFileLinksFromMessage(content, 'msg1', 'sess1');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].filePath).toBe('D:/my folder/文件.pptx');
  });

  test('creates image artifacts for local file links', () => {
    const content = '[generated-image.png](file:///home/user/project/generated-image.png)';
    const artifacts = parseFileLinksFromMessage(content, 'msg1', 'sess1');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].type).toBe('image');
    expect(artifacts[0].filePath).toBe('/home/user/project/generated-image.png');
  });

  test('creates video artifacts for local file links', () => {
    const content = '[generated-video.mp4](file:///home/user/project/generated-video.mp4)';
    const artifacts = parseFileLinksFromMessage(content, 'msg1', 'sess1');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].type).toBe('video');
    expect(artifacts[0].filePath).toBe('/home/user/project/generated-video.mp4');
  });

  test('accepts plain absolute POSIX path links without file:// scheme', () => {
    const content = '改好了：[随便写一个 Markdown.md](/Users/admin/project012/随便写一个 Markdown.md)';
    const artifacts = parseFileLinksFromMessage(content, 'msg1', 'sess1');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].type).toBe('markdown');
    expect(artifacts[0].filePath).toBe('/Users/admin/project012/随便写一个 Markdown.md');
  });

  test('accepts Windows absolute path links with backslashes', () => {
    const content = '[周报.docx](D:\\工作文档\\周报.docx)';
    const artifacts = parseFileLinksFromMessage(content, 'msg1', 'sess1');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].type).toBe('document');
    expect(artifacts[0].filePath).toBe('D:\\工作文档\\周报.docx');
  });

  test('accepts relative path links with a separator', () => {
    const content = '[报告](./output/report.html)';
    const artifacts = parseFileLinksFromMessage(content, 'msg1', 'sess1');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].type).toBe('html');
    expect(artifacts[0].filePath).toBe('./output/report.html');
  });

  test('ignores web, mailto, anchor, and localhost links', () => {
    const content = [
      '[文档](https://example.com/report.pdf)',
      '[邮件](mailto:user@example.com)',
      '[章节](#section)',
      '[预览](http://localhost:3000/index.html)',
    ].join('\n');
    expect(parseFileLinksFromMessage(content, 'msg1', 'sess1')).toHaveLength(0);
  });

  test('ignores bare-name links without any separator', () => {
    const content = '[a.md](a.md)';
    expect(parseFileLinksFromMessage(content, 'msg1', 'sess1')).toHaveLength(0);
  });
});

describe('parseFilePathsFromText', () => {
  test('strips leading / after file:/// protocol removal on Windows', () => {
    const content = 'output at file:///D:/project/output.pdf done';
    const artifacts = parseFilePathsFromText(content, 'msg1', 'sess1');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].filePath).toBe('D:/project/output.pdf');
  });

  test('creates image artifacts for bare local image paths', () => {
    const content = 'Saved generated image: /home/user/project/generated-image.webp';
    const artifacts = parseFilePathsFromText(content, 'msg1', 'sess1');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].type).toBe('image');
    expect(artifacts[0].filePath).toBe('/home/user/project/generated-image.webp');
  });

  test('creates video artifacts for bare local video paths', () => {
    const content = 'Saved generated video: /home/user/project/generated-video.webm';
    const artifacts = parseFilePathsFromText(content, 'msg1', 'sess1');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].type).toBe('video');
    expect(artifacts[0].filePath).toBe('/home/user/project/generated-video.webm');
  });

  test('detects bare html file paths', () => {
    const content = '页面已生成 /home/user/project/dist/index.html 完成';
    const artifacts = parseFilePathsFromText(content, 'msg1', 'sess1');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].type).toBe('html');
    expect(artifacts[0].filePath).toBe('/home/user/project/dist/index.html');
  });

  test('detects bare Windows backslash paths', () => {
    const content = '文件已保存到 D:\\工作文档\\月报\\使用Agent.html';
    const artifacts = parseFilePathsFromText(content, 'msg1', 'sess1');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].type).toBe('html');
    expect(artifacts[0].filePath).toBe('D:\\工作文档\\月报\\使用Agent.html');
  });

  test('does not detect remote https image URLs as local paths', () => {
    const content = '图片在 https://example.com/assets/generated.png 上';
    expect(parseFilePathsFromText(content, 'msg1', 'sess1')).toHaveLength(0);
  });
});

describe('parseToolResultMediaArtifacts', () => {
  test('prefers local filePath for persisted generated images', () => {
    const toolResultMsg = {
      id: 'result1',
      type: 'system' as const,
      content: 'Saved generated image',
      timestamp: Date.now(),
      metadata: {
        toolResultDetails: {
          assets: [
            {
              type: 'image',
              url: 'https://example.com/generated.png?signature=temporary',
              filePath: '/home/user/project/generated-image.png',
              mimeType: 'image/png',
              filename: 'generated-image.png',
            },
          ],
        },
      },
    };
    const artifacts = parseToolResultMediaArtifacts(toolResultMsg, 'sess1');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].type).toBe('image');
    expect(artifacts[0].content).toBe('');
    expect(artifacts[0].filePath).toBe('/home/user/project/generated-image.png');
  });

  test('uses remote url when no local file path exists', () => {
    const toolResultMsg = {
      id: 'result1',
      type: 'tool_result' as const,
      content: 'Generated image',
      timestamp: Date.now(),
      metadata: {
        toolResultDetails: {
          assets: [
            {
              type: 'image',
              url: 'https://example.com/generated.png?signature=temporary',
              mimeType: 'image/png',
            },
          ],
        },
      },
    };
    const artifacts = parseToolResultMediaArtifacts(toolResultMsg, 'sess1');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].content).toBe('https://example.com/generated.png?signature=temporary');
    expect(artifacts[0].filePath).toBeUndefined();
  });

  test('keeps remote-only video assets as legacy generated-video candidates', () => {
    const toolResultMsg = {
      id: 'result1',
      type: 'tool_result' as const,
      content: 'Saved generated video:',
      timestamp: Date.now(),
      metadata: {
        toolResultDetails: {
          assets: [
            {
              type: 'video',
              url: 'https://example.com/generated.mp4?signature=temporary',
              mimeType: 'video/mp4',
            },
          ],
        },
      },
    };
    const artifacts = parseToolResultMediaArtifacts(toolResultMsg, 'sess1');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].remoteUrl).toBe('https://example.com/generated.mp4?signature=temporary');
    expect(artifacts[0].legacyGeneratedVideoCandidate).toBe(true);
    expect(hasToolResultMediaAssets(toolResultMsg)).toBe(true);
  });

  test('does not mark arbitrary tool video output as a generated-video share candidate', () => {
    const toolResultMsg = {
      id: 'result1',
      type: 'tool_result' as const,
      content: 'Video processing complete',
      timestamp: Date.now(),
      metadata: {
        toolResultDetails: {
          assets: [
            {
              type: 'video',
              url: 'https://example.com/processed.mp4',
              mimeType: 'video/mp4',
            },
          ],
        },
      },
    };

    const artifacts = parseToolResultMediaArtifacts(toolResultMsg, 'sess1');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].legacyGeneratedVideoCandidate).toBeUndefined();
  });

  test('prefers local filePath for persisted generated videos', () => {
    const toolResultMsg = {
      id: 'result1',
      type: 'system' as const,
      content: 'Saved generated video',
      timestamp: Date.now(),
      metadata: {
        toolResultDetails: {
          taskId: '321',
          assets: [
            {
              type: 'video',
              url: 'https://example.com/generated.mp4?signature=temporary',
              filePath: '/home/user/project/generated-video.mp4',
              mimeType: 'video/mp4',
              filename: 'generated-video.mp4',
              outputIndex: 4,
            },
          ],
        },
      },
    };
    const artifacts = parseToolResultMediaArtifacts(toolResultMsg, 'sess1');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].type).toBe('video');
    expect(artifacts[0].content).toBe('');
    expect(artifacts[0].remoteUrl).toBe('https://example.com/generated.mp4?signature=temporary');
    expect(artifacts[0].filePath).toBe('/home/user/project/generated-video.mp4');
    expect(artifacts[0].mediaOrigin).toEqual({
      type: 'generated_video',
      taskId: '321',
      outputIndex: 4,
    });
  });

  test('detects media assets in tool result metadata', () => {
    const toolResultMsg = {
      id: 'result1',
      type: 'system' as const,
      content: 'Saved generated video',
      timestamp: Date.now(),
      metadata: {
        toolResultDetails: {
          assets: [
            {
              type: 'video',
              url: 'https://example.com/generated.mp4',
              filePath: '/home/user/project/generated-video.mp4',
            },
          ],
        },
      },
    };

    expect(hasToolResultMediaAssets(toolResultMsg)).toBe(true);
  });
});

describe('dedupeArtifactsForDisplay', () => {
  test('keeps one artifact when a generated video has both file link and metadata records', () => {
    const linkArtifacts = parseFileLinksFromMessage(
      '[generated-video.mp4](file:///home/user/project/generated-video.mp4)',
      'result1',
      'sess1',
    );
    const metadataArtifacts = parseToolResultMediaArtifacts({
      id: 'result1',
      type: 'system' as const,
      content: 'Saved generated video',
      timestamp: Date.now(),
      metadata: {
        toolResultDetails: {
          assets: [
            {
              type: 'video',
              url: 'https://example.com/generated.mp4?signature=temporary',
              filePath: '/home/user/project/generated-video.mp4',
              mimeType: 'video/mp4',
              filename: 'generated-video.mp4',
            },
          ],
        },
      },
    }, 'sess1');

    const artifacts = dedupeArtifactsForDisplay([...linkArtifacts, ...metadataArtifacts]);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].id).toBe(metadataArtifacts[0].id);
    expect(artifacts[0].remoteUrl).toBe('https://example.com/generated.mp4?signature=temporary');
  });

  test('preserves generated-video provenance when a later assistant file link has the same path', () => {
    const metadataArtifacts = parseToolResultMediaArtifacts({
      id: 'system-result',
      type: 'system' as const,
      content: 'Saved generated video',
      timestamp: 1,
      metadata: {
        toolResultDetails: {
          taskId: '206',
          mediaType: 'video',
          assets: [
            {
              type: 'video',
              url: 'https://example.com/generated.mp4?signature=temporary',
              filePath: '/home/user/project/generated-video.mp4',
              filename: 'generated-video.mp4',
              outputIndex: 0,
            },
          ],
        },
      },
    }, 'sess1');
    const linkArtifacts = parseFileLinksFromMessage(
      '[generated-video.mp4](file:///home/user/project/generated-video.mp4)',
      'assistant-result',
      'sess1',
    ).map(artifact => ({ ...artifact, createdAt: 2 }));

    const artifacts = dedupeArtifactsForDisplay([...metadataArtifacts, ...linkArtifacts]);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].id).toBe(metadataArtifacts[0].id);
    expect(artifacts[0].remoteUrl).toBe('https://example.com/generated.mp4?signature=temporary');
    expect(artifacts[0].mediaOrigin).toEqual({
      type: 'generated_video',
      taskId: '206',
      outputIndex: 0,
    });
  });

  test('replaces remote media artifact with local persisted version sharing the same url', () => {
    const artifacts = dedupeArtifactsForDisplay([
      {
        id: 'remote',
        messageId: 'msg1',
        sessionId: 'sess1',
        type: 'video',
        title: 'generated-video.mp4',
        content: 'https://example.com/generated.mp4',
        fileName: 'generated-video.mp4',
        createdAt: 1,
      },
      {
        id: 'local',
        messageId: 'msg1',
        sessionId: 'sess1',
        type: 'video',
        title: 'generated-video.mp4',
        content: '',
        fileName: 'generated-video.mp4',
        filePath: '/home/user/project/generated-video.mp4',
        remoteUrl: 'https://example.com/generated.mp4',
        createdAt: 2,
      },
    ]);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].id).toBe('local');
    expect(artifacts[0].filePath).toBe('/home/user/project/generated-video.mp4');
  });

  test('does not replace local media artifact with later remote placeholder', () => {
    const artifacts = dedupeArtifactsForDisplay([
      {
        id: 'local',
        messageId: 'msg1',
        sessionId: 'sess1',
        type: 'video',
        title: 'generated-video.mp4',
        content: '',
        fileName: 'generated-video.mp4',
        filePath: '/home/user/project/generated-video.mp4',
        remoteUrl: 'https://example.com/generated.mp4',
        createdAt: 1,
      },
      {
        id: 'remote',
        messageId: 'msg1',
        sessionId: 'sess1',
        type: 'video',
        title: 'generated-video.mp4',
        content: 'https://example.com/generated.mp4',
        fileName: 'generated-video.mp4',
        createdAt: 2,
      },
    ]);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].id).toBe('local');
  });

  test('dedupes video artifacts with file URL and local path forms', () => {
    const artifacts = dedupeArtifactsForDisplay([
      {
        id: 'file-url',
        messageId: 'msg1',
        sessionId: 'sess1',
        type: 'video',
        title: 'generated-video.mp4',
        content: '',
        fileName: 'generated-video.mp4',
        filePath: 'file:///Users/admin/work/test0522/generated-video.mp4',
        createdAt: 1,
      },
      {
        id: 'local',
        messageId: 'msg2',
        sessionId: 'sess1',
        type: 'video',
        title: 'generated-video.mp4',
        content: '',
        fileName: 'generated-video.mp4',
        filePath: '/Users/admin/work/test0522/generated-video.mp4',
        createdAt: 2,
      },
    ]);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].id).toBe('local');
  });

  test('dedupes local service artifacts with the same URL', () => {
    const artifacts = dedupeArtifactsForDisplay([
      {
        id: 'assistant-service',
        messageId: 'assistant-msg',
        sessionId: 'sess1',
        type: 'local-service',
        title: 'localhost:3000',
        content: 'http://localhost:3000',
        url: 'http://localhost:3000',
        createdAt: 1,
      },
      {
        id: 'system-service',
        messageId: 'system-msg',
        sessionId: 'sess1',
        type: 'local-service',
        title: 'localhost:3000',
        content: 'http://localhost:3000/',
        url: 'http://localhost:3000/',
        createdAt: 2,
      },
    ]);

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].id).toBe('system-service');
  });

  test('keeps one local service artifact per port and prefers detected project metadata', () => {
    const artifacts = dedupeArtifactsForDisplay([
      {
        id: 'default-service',
        messageId: 'assistant-msg',
        sessionId: 'sess1',
        type: 'local-service',
        title: 'localhost:3000',
        content: 'http://localhost:3000',
        url: 'http://localhost:3000',
        localService: {
          url: 'http://localhost:3000',
          origin: 'http://localhost:3000',
          projectDirectory: '/Users/admin/project',
        },
        createdAt: 2,
      },
      {
        id: 'project-service',
        messageId: 'system-msg',
        sessionId: 'sess1',
        type: 'local-service',
        title: 'localhost:3000',
        content: 'http://127.0.0.1:3000/app',
        url: 'http://127.0.0.1:3000/app',
        localService: {
          url: 'http://127.0.0.1:3000/app',
          origin: 'http://127.0.0.1:3000',
          projectDirectory: '/Users/admin/project/ai-datacenter',
        },
        createdAt: 1,
      },
    ], { defaultProjectDirectory: '/Users/admin/project' });

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].id).toBe('project-service');
  });

  test('keeps local service artifacts on different ports', () => {
    const artifacts = dedupeArtifactsForDisplay([
      {
        id: 'service-3000',
        messageId: 'assistant-msg',
        sessionId: 'sess1',
        type: 'local-service',
        title: 'localhost:3000',
        content: 'http://localhost:3000',
        url: 'http://localhost:3000',
        createdAt: 1,
      },
      {
        id: 'service-5174',
        messageId: 'system-msg',
        sessionId: 'sess1',
        type: 'local-service',
        title: 'localhost:5174',
        content: 'http://localhost:5174',
        url: 'http://localhost:5174',
        createdAt: 2,
      },
    ]);

    expect(artifacts.map(artifact => artifact.id)).toEqual(['service-3000', 'service-5174']);
  });
});

describe('parseLocalServiceUrlsFromText', () => {
  test('parses localhost service URLs', () => {
    const content = '服务已启动：http://localhost:4173/login-react.html';
    const artifacts = parseLocalServiceUrlsFromText(content, 'msg1', 'sess1');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].type).toBe('local-service');
    expect(artifacts[0].url).toBe('http://localhost:4173/login-react.html');
    expect(artifacts[0].title).toBe('login-react.html');
  });

  test('uses markdown link text as title', () => {
    const content = '[登录页面](http://localhost:4173/login-react.html)';
    const artifacts = parseLocalServiceUrlsFromText(content, 'msg1', 'sess1');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].title).toBe('登录页面');
  });

  test('deduplicates repeated markdown and bare URLs', () => {
    const content = '[http://localhost:4173/](http://localhost:4173/)\nhttp://localhost:4173/';
    const artifacts = parseLocalServiceUrlsFromText(content, 'msg1', 'sess1');
    expect(artifacts).toHaveLength(1);
  });

  test('does not attach session cwd as project directory when no project is detected', () => {
    const artifacts = parseLocalServiceUrlsFromText(
      '服务已启动：http://localhost:3000',
      'msg1',
      'sess1',
      { projectDirectory: '/Users/admin/project/fanren-vote' },
    );

    expect(artifacts[0].localService).toEqual({
      url: 'http://localhost:3000',
      origin: 'http://localhost:3000',
    });
  });

  test('prefers project directory from startup cd command over session cwd', () => {
    const content = [
      '启动方式',
      '```bash',
      'cd /Users/admin/lobsterai/project/fanren/fanren-vote',
      'npm run dev',
      '```',
      '预览地址：http://localhost:3000',
    ].join('\n');
    const artifacts = parseLocalServiceUrlsFromText(
      content,
      'msg1',
      'sess1',
      { projectDirectory: '/Users/admin/lobsterai/project/fanren' },
    );

    expect(artifacts[0].localService?.projectDirectory).toBe(
      '/Users/admin/lobsterai/project/fanren/fanren-vote',
    );
  });

  test('prefers labeled project directory over session cwd', () => {
    const content = [
      '项目目录： `/Users/admin/lobsterai/project/fanren/fanren-vote/`',
      '预览地址：http://localhost:3000',
    ].join('\n');
    const artifacts = parseLocalServiceUrlsFromText(
      content,
      'msg1',
      'sess1',
      { projectDirectory: '/Users/admin/lobsterai/project/fanren' },
    );

    expect(artifacts[0].localService?.projectDirectory).toBe(
      '/Users/admin/lobsterai/project/fanren/fanren-vote/',
    );
  });

  test('extracts labeled project directory from markdown file link', () => {
    const content = [
      '✅ 服务已启动，运行在 http://localhost:3000',
      '• 项目路径： [`/Users/admin/lobsterai/project/fanren/fanren-vote/`](file:///Users/admin/lobsterai/project/fanren/fanren-vote/)',
      '• 状态： 正常运行，HTTP 200',
    ].join('\n');
    const artifacts = parseLocalServiceUrlsFromText(
      content,
      'msg1',
      'sess1',
      { projectDirectory: '/Users/admin/lobsterai/project/fanren' },
    );

    expect(artifacts[0].localService?.projectDirectory).toBe(
      '/Users/admin/lobsterai/project/fanren/fanren-vote/',
    );
  });

  test('extracts project directory from project located markdown file link', () => {
    const content = [
      '网站已全部完成！ 项目位于 [chinese-navy-site](file:///Users/admin/lobsterai/project/chinese-navy-site)，本地服务运行在 `http://localhost:8765`。',
      '',
      '**文件结构：**',
      '- [index.html](file:///Users/admin/lobsterai/project/chinese-navy-site/index.html) — 页面结构',
    ].join('\n');
    const artifacts = parseLocalServiceUrlsFromText(
      content,
      'msg1',
      'sess1',
      { projectDirectory: '/Users/admin/lobsterai/project' },
    );

    expect(artifacts[0].localService?.projectDirectory).toBe(
      '/Users/admin/lobsterai/project/chinese-navy-site',
    );
    expect(artifacts[0].localService?.projectCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          directory: '/Users/admin/lobsterai/project/chinese-navy-site',
          source: ShareDeploymentCandidateSource.TextLabeledPath,
        }),
      ]),
    );
  });

  test('derives project directory from common parent of file links', () => {
    const content = [
      '本地服务运行在 http://localhost:8765',
      '- [index.html](file:///Users/admin/lobsterai/project/chinese-navy-site/index.html)',
      '- [style.css](file:///Users/admin/lobsterai/project/chinese-navy-site/styles/style.css)',
      '- [app.js](file:///Users/admin/lobsterai/project/chinese-navy-site/scripts/app.js)',
    ].join('\n');
    const artifacts = parseLocalServiceUrlsFromText(content, 'msg1', 'sess1');

    expect(artifacts[0].localService?.projectDirectory).toBe(
      '/Users/admin/lobsterai/project/chinese-navy-site',
    );
    expect(artifacts[0].localService?.projectCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          directory: '/Users/admin/lobsterai/project/chinese-navy-site',
          source: ShareDeploymentCandidateSource.TextCommonParent,
        }),
      ]),
    );
  });

  test('ignores malformed labeled project directory markers', () => {
    const content = [
      '项目路径： [',
      '预览地址：http://localhost:3000',
    ].join('\n');
    const artifacts = parseLocalServiceUrlsFromText(
      content,
      'msg1',
      'sess1',
      { projectDirectory: '/Users/admin/lobsterai/project/fanren' },
    );

    expect(artifacts[0].localService?.projectDirectory).toBeUndefined();
  });

  test('ignores remote URLs', () => {
    const artifacts = parseLocalServiceUrlsFromText('https://example.com/app', 'msg1', 'sess1');
    expect(artifacts).toHaveLength(0);
  });
});

describe('parseMediaTokensFromText', () => {
  test('parses MEDIA token with Windows path (no space)', () => {
    const content = 'MEDIA:C:\\Users\\test\\images\\output.png';
    const artifacts = parseMediaTokensFromText(content, 'msg1', 'sess1');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].filePath).toBe('C:\\Users\\test\\images\\output.png');
    expect(artifacts[0].type).toBe('image');
  });

  test('parses MEDIA token with space after colon', () => {
    const content = 'MEDIA: /tmp/output.png';
    const artifacts = parseMediaTokensFromText(content, 'msg1', 'sess1');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].filePath).toBe('/tmp/output.png');
  });

  test('parses macOS path with spaces (Application Support)', () => {
    const content = 'MEDIA: /Users/test/Library/Application Support/com.lobsterai/images/output.png';
    const artifacts = parseMediaTokensFromText(content, 'msg1', 'sess1');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].filePath).toBe('/Users/test/Library/Application Support/com.lobsterai/images/output.png');
    expect(artifacts[0].type).toBe('image');
  });

  test('parses backtick-wrapped path with spaces', () => {
    const content = 'MEDIA: `/Users/test/Library/Application Support/output.png`';
    const artifacts = parseMediaTokensFromText(content, 'msg1', 'sess1');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].filePath).toBe('/Users/test/Library/Application Support/output.png');
  });

  test('parses file:// prefixed MEDIA path', () => {
    const content = 'MEDIA: file:///D:/workspace/image.jpg';
    const artifacts = parseMediaTokensFromText(content, 'msg1', 'sess1');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].filePath).toBe('D:/workspace/image.jpg');
  });

  test('parses MEDIA token with video path', () => {
    const content = 'MEDIA: /tmp/output.mp4';
    const artifacts = parseMediaTokensFromText(content, 'msg1', 'sess1');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].filePath).toBe('/tmp/output.mp4');
    expect(artifacts[0].type).toBe('video');
  });

  test('parses multiple MEDIA tokens on separate lines', () => {
    const content = 'MEDIA: /tmp/img1.png\nMEDIA: /tmp/img2.jpg';
    const artifacts = parseMediaTokensFromText(content, 'msg1', 'sess1');
    expect(artifacts).toHaveLength(2);
    expect(artifacts[0].filePath).toBe('/tmp/img1.png');
    expect(artifacts[1].filePath).toBe('/tmp/img2.jpg');
  });

  test('ignores MEDIA token with unknown extension', () => {
    const content = 'MEDIA: /tmp/data.xyz';
    const artifacts = parseMediaTokensFromText(content, 'msg1', 'sess1');
    expect(artifacts).toHaveLength(0);
  });

  test('trims trailing whitespace from path', () => {
    const content = 'MEDIA: /tmp/output.png   ';
    const artifacts = parseMediaTokensFromText(content, 'msg1', 'sess1');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].filePath).toBe('/tmp/output.png');
  });
});

describe('parseFilePathsFromText', () => {
  test('normalizes MEDIA-prefixed video paths captured by bare path detection', () => {
    const content = 'MEDIA:/Users/admin/work/test/test0623/generated-video-20260623-184040-1.mp4';
    const artifacts = parseFilePathsFromText(content, 'msg1', 'sess1');
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].filePath).toBe('/Users/admin/work/test/test0623/generated-video-20260623-184040-1.mp4');
    expect(artifacts[0].type).toBe('video');
  });
});

describe('parseToolArtifact', () => {
  test('extracts file path from Write tool input', () => {
    const toolUseMsg = {
      id: 'tool1',
      type: 'tool_use' as const,
      content: '',
      timestamp: Date.now(),
      metadata: {
        toolName: 'Write',
        toolUseId: 'tu1',
        toolInput: { file_path: 'D:\\workspace\\hello.html', content: '<html></html>' },
      },
    };
    const toolResultMsg = {
      id: 'result1',
      type: 'tool_result' as const,
      content: 'OK',
      timestamp: Date.now(),
      metadata: { toolUseId: 'tu1' },
    };
    const artifact = parseToolArtifact(toolUseMsg, toolResultMsg, 'sess1');
    expect(artifact).not.toBeNull();
    expect(artifact!.filePath).toBe('D:\\workspace\\hello.html');
  });

  test('dedup: tool path and file link path normalize to same value', () => {
    const toolPath = 'D:\\new_ws_test_2\\hello-slide.pptx';
    const linkContent = '[hello-slide.pptx](file:///D:/new_ws_test_2/hello-slide.pptx)';
    const linkArtifacts = parseFileLinksFromMessage(linkContent, 'msg1', 'sess1');
    expect(linkArtifacts).toHaveLength(1);

    expect(normalizeFilePathForDedup(toolPath))
      .toBe(normalizeFilePathForDedup(linkArtifacts[0].filePath!));
  });

  test('extracts file path from Edit tool input', () => {
    const toolUseMsg = {
      id: 'tool1',
      type: 'tool_use' as const,
      content: '',
      timestamp: Date.now(),
      metadata: {
        toolName: 'Edit',
        toolUseId: 'tu1',
        toolInput: { file_path: '/Users/admin/project012/随便写一个 Markdown.md', old_string: 'a', new_string: 'b' },
      },
    };
    const artifact = parseToolArtifact(toolUseMsg, undefined, 'sess1');
    expect(artifact).not.toBeNull();
    expect(artifact!.type).toBe('markdown');
    expect(artifact!.filePath).toBe('/Users/admin/project012/随便写一个 Markdown.md');
    expect(artifact!.messageId).toBe('tool1');
  });

  test('extracts file path from lowercase edit tool with path key', () => {
    const toolUseMsg = {
      id: 'tool2',
      type: 'tool_use' as const,
      content: '',
      timestamp: Date.now(),
      metadata: {
        toolName: 'edit',
        toolUseId: 'tu2',
        toolInput: { path: 'D:\\workspace\\notes.md' },
      },
    };
    const artifact = parseToolArtifact(toolUseMsg, undefined, 'sess1');
    expect(artifact).not.toBeNull();
    expect(artifact!.filePath).toBe('D:\\workspace\\notes.md');
  });

  test('supports MultiEdit and create_file tool names', () => {
    for (const toolName of ['MultiEdit', 'create_file', 'multi_edit']) {
      const artifact = parseToolArtifact({
        id: `tool-${toolName}`,
        type: 'tool_use' as const,
        content: '',
        timestamp: Date.now(),
        metadata: {
          toolName,
          toolUseId: `tu-${toolName}`,
          toolInput: { file_path: '/tmp/out/report.md' },
        },
      }, undefined, 'sess1');
      expect(artifact, toolName).not.toBeNull();
    }
  });

  test('returns null for edit tool when the tool result errored', () => {
    const toolUseMsg = {
      id: 'tool3',
      type: 'tool_use' as const,
      content: '',
      timestamp: Date.now(),
      metadata: {
        toolName: 'Edit',
        toolUseId: 'tu3',
        toolInput: { file_path: '/tmp/out/report.md' },
      },
    };
    const toolResultMsg = {
      id: 'result3',
      type: 'tool_result' as const,
      content: 'failed',
      timestamp: Date.now(),
      metadata: { toolUseId: 'tu3', isError: true },
    };
    expect(parseToolArtifact(toolUseMsg, toolResultMsg, 'sess1')).toBeNull();
  });

  test('returns null for delete-style and shell tools', () => {
    for (const toolName of ['delete_file', 'remove', 'Bash', 'exec', 'Read']) {
      const artifact = parseToolArtifact({
        id: `tool-${toolName}`,
        type: 'tool_use' as const,
        content: '',
        timestamp: Date.now(),
        metadata: {
          toolName,
          toolUseId: `tu-${toolName}`,
          toolInput: { file_path: '/tmp/out/report.md' },
        },
      }, undefined, 'sess1');
      expect(artifact, toolName).toBeNull();
    }
  });
});

describe('toAbsoluteArtifactPath', () => {
  test('keeps absolute POSIX and Windows paths unchanged', () => {
    expect(toAbsoluteArtifactPath('/home/user/a.md', '/cwd')).toBe('/home/user/a.md');
    expect(toAbsoluteArtifactPath('D:\\ws\\a.md', '/cwd')).toBe('D:\\ws\\a.md');
  });

  test('strips file:// prefixes and Windows leading slash', () => {
    expect(toAbsoluteArtifactPath('file:///D:/ws/a.md', '/cwd')).toBe('D:/ws/a.md');
    expect(toAbsoluteArtifactPath('file:///home/user/a.md', '/cwd')).toBe('/home/user/a.md');
  });

  test('joins relative paths to the session cwd', () => {
    expect(toAbsoluteArtifactPath('output/report.html', '/Users/admin/project')).toBe('/Users/admin/project/output/report.html');
    expect(toAbsoluteArtifactPath('./output/report.html', '/Users/admin/project/')).toBe('/Users/admin/project/output/report.html');
  });

  test('returns relative path unchanged without a cwd', () => {
    expect(toAbsoluteArtifactPath('output/report.html')).toBe('output/report.html');
  });
});

describe('isIgnoredArtifactPath', () => {
  test('ignores .cowork-temp, node_modules, .git, and hidden segments', () => {
    expect(isIgnoredArtifactPath('/cwd/.cowork-temp/draft.md')).toBe(true);
    expect(isIgnoredArtifactPath('D:\\ws\\.cowork-temp\\draft.md')).toBe(true);
    expect(isIgnoredArtifactPath('/cwd/node_modules/pkg/readme.md')).toBe(true);
    expect(isIgnoredArtifactPath('/cwd/.git/config.md')).toBe(true);
    expect(isIgnoredArtifactPath('/cwd/sub/.hidden/report.md')).toBe(true);
    expect(isIgnoredArtifactPath('/cwd/sub/.env.md')).toBe(true);
  });

  test('keeps normal deliverable paths', () => {
    expect(isIgnoredArtifactPath('/cwd/output/report.md')).toBe(false);
    expect(isIgnoredArtifactPath('./output/report.md')).toBe(false);
    expect(isIgnoredArtifactPath('~/Desktop/report.md')).toBe(false);
    expect(isIgnoredArtifactPath('D:\\工作文档\\周报.docx')).toBe(false);
  });
});

describe('isPathInsideDirectory', () => {
  test('detects containment case-insensitively across separators', () => {
    expect(isPathInsideDirectory('/Users/Admin/Project/a.md', '/users/admin/project')).toBe(true);
    expect(isPathInsideDirectory('D:\\ws\\out\\a.md', 'D:/WS')).toBe(true);
  });

  test('rejects paths outside the directory and prefix collisions', () => {
    expect(isPathInsideDirectory('/Users/admin/other/a.md', '/Users/admin/project')).toBe(false);
    expect(isPathInsideDirectory('/Users/admin/project2/a.md', '/Users/admin/project')).toBe(false);
  });
});

describe('shouldParseFilePathsFromToolResult', () => {
  test('returns true for image_generate tool', () => {
    expect(shouldParseFilePathsFromToolResult('image_generate')).toBe(true);
  });

  test('returns true for lobsterai_image_generate tool', () => {
    expect(shouldParseFilePathsFromToolResult('lobsterai_image_generate')).toBe(true);
  });

  test('is case-insensitive', () => {
    expect(shouldParseFilePathsFromToolResult('Image_Generate')).toBe(true);
    expect(shouldParseFilePathsFromToolResult('LOBSTERAI_IMAGE_GENERATE')).toBe(true);
  });

  test('returns false for Bash tool (find/ls output should not become artifacts)', () => {
    expect(shouldParseFilePathsFromToolResult('Bash')).toBe(false);
  });

  test('returns false for other command execution tools', () => {
    expect(shouldParseFilePathsFromToolResult('execute_command')).toBe(false);
    expect(shouldParseFilePathsFromToolResult('run_terminal_command')).toBe(false);
    expect(shouldParseFilePathsFromToolResult('shell')).toBe(false);
  });

  test('returns false for null/undefined/empty', () => {
    expect(shouldParseFilePathsFromToolResult(null)).toBe(false);
    expect(shouldParseFilePathsFromToolResult(undefined)).toBe(false);
    expect(shouldParseFilePathsFromToolResult('')).toBe(false);
  });

  test('returns false for file tools (Read, Write, Edit)', () => {
    expect(shouldParseFilePathsFromToolResult('Read')).toBe(false);
    expect(shouldParseFilePathsFromToolResult('Write')).toBe(false);
    expect(shouldParseFilePathsFromToolResult('Edit')).toBe(false);
  });
});

describe('parseFilePathsFromText — find command output scenario', () => {
  test('regex matches paths from find output (demonstrating the bug vector)', () => {
    // Simulates `find . -name "*.png"` output on macOS
    const findOutput = [
      './B-01-seedream.png',
      './B-02-chart.png',
      './subfolder/凡人修仙传女性角色群像全身照.png',
      './black_huaqiang_bao_shu_reference.png',
    ].join('\n');

    const artifacts = parseFilePathsFromText(findOutput, 'msg1', 'sess1');
    // These paths all have a `/` so they match BARE_FILE_PATH_RE
    expect(artifacts.length).toBeGreaterThanOrEqual(3);
  });

  test('bare filenames without directory separator do NOT match', () => {
    // Simulates output from `ls *.png` (no path prefix)
    const content = 'B-01-seedream.png\nB-02-chart.png';
    const artifacts = parseFilePathsFromText(content, 'msg1', 'sess1');
    expect(artifacts).toHaveLength(0);
  });
});
