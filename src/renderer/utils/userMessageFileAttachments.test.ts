import { describe, expect, test } from 'vitest';

import { extractUserMessageFileAttachments } from './userMessageFileAttachments';

// ─── Passthrough ────────────────────────────────────────────

describe('passthrough (no attachment lines)', () => {
  test('empty string', () => {
    const result = extractUserMessageFileAttachments('');
    expect(result.text).toBe('');
    expect(result.attachments).toEqual([]);
  });

  test('plain text unchanged', () => {
    const result = extractUserMessageFileAttachments('帮我总结这份文档');
    expect(result.text).toBe('帮我总结这份文档');
    expect(result.attachments).toEqual([]);
  });

  test('label with relative path is not extracted', () => {
    const content = '输入文件: docs/readme.md';
    const result = extractUserMessageFileAttachments(content);
    expect(result.text).toBe(content);
    expect(result.attachments).toEqual([]);
  });

  test('label mentioned mid-sentence is not extracted', () => {
    const content = '请注意输入文件: /tmp/a.txt 的编码问题';
    const result = extractUserMessageFileAttachments(content);
    // The trailing prose keeps this line matching as one long "path"; a path
    // like that fails the reveal stat-check gracefully. But a mid-line label
    // preceded by text must never match.
    expect(result.attachments).toEqual([]);
    expect(result.text).toBe(content);
  });

  test('markdown content unchanged', () => {
    const md = '## 计划\n\n- 第一步\n- 第二步';
    const result = extractUserMessageFileAttachments(md);
    expect(result.text).toBe(md);
    expect(result.attachments).toEqual([]);
  });
});

// ─── Extraction ─────────────────────────────────────────────

describe('file attachment extraction', () => {
  test('zh file line appended after prompt', () => {
    const result = extractUserMessageFileAttachments(
      '看看这个日志有什么问题\n\n输入文件: /Users/me/logs/lobsterai-logs-20260810.txt',
    );
    expect(result.text).toBe('看看这个日志有什么问题');
    expect(result.attachments).toEqual([
      {
        path: '/Users/me/logs/lobsterai-logs-20260810.txt',
        name: 'lobsterai-logs-20260810.txt',
        isDirectory: false,
      },
    ]);
  });

  test('en labels', () => {
    const result = extractUserMessageFileAttachments(
      'Summarize these\n\nInput Files: /Users/me/report.pdf\nInput Folder: /Users/me/project',
    );
    expect(result.text).toBe('Summarize these');
    expect(result.attachments).toEqual([
      { path: '/Users/me/report.pdf', name: 'report.pdf', isDirectory: false },
      { path: '/Users/me/project', name: 'project', isDirectory: true },
    ]);
  });

  test('zh folder label wins over its file-label prefix', () => {
    const result = extractUserMessageFileAttachments('输入文件夹: /Users/me/project');
    expect(result.text).toBe('');
    expect(result.attachments).toEqual([
      { path: '/Users/me/project', name: 'project', isDirectory: true },
    ]);
  });

  test('attachment-only message leaves empty text', () => {
    const result = extractUserMessageFileAttachments('输入文件: /tmp/a.csv\n输入文件: /tmp/b.csv');
    expect(result.text).toBe('');
    expect(result.attachments.map(a => a.name)).toEqual(['a.csv', 'b.csv']);
  });

  test('windows drive and UNC paths', () => {
    const result = extractUserMessageFileAttachments(
      String.raw`输入文件: C:\Users\me\数据 报表.xlsx` + '\n' + String.raw`输入文件: \\server\share\a.docx`,
    );
    expect(result.attachments).toEqual([
      { path: String.raw`C:\Users\me\数据 报表.xlsx`, name: '数据 报表.xlsx', isDirectory: false },
      { path: String.raw`\\server\share\a.docx`, name: 'a.docx', isDirectory: false },
    ]);
  });

  test('path with spaces is kept intact', () => {
    const result = extractUserMessageFileAttachments('输入文件: /Users/me/My Documents/final report.pdf');
    expect(result.attachments).toEqual([
      { path: '/Users/me/My Documents/final report.pdf', name: 'final report.pdf', isDirectory: false },
    ]);
  });

  test('Windows paths are deduped case-insensitively while POSIX paths preserve case', () => {
    const result = extractUserMessageFileAttachments(
      String.raw`输入文件: C:\tmp\a.txt` + '\n'
        + String.raw`Input Files: c:\TMP\A.TXT` + '\n'
        + '输入文件: /tmp/a.txt\nInput Files: /TMP/A.TXT',
    );
    expect(result.attachments.map(attachment => attachment.path)).toEqual([
      String.raw`C:\tmp\a.txt`,
      '/tmp/a.txt',
      '/TMP/A.TXT',
    ]);
  });

  test('only strips the trailing generated block', () => {
    const result = extractUserMessageFileAttachments(
      '第一段\n\n第二段\n\n输入文件: /tmp/a.txt',
    );
    expect(result.text).toBe('第一段\n\n第二段');
    expect(result.attachments).toHaveLength(1);
  });

  test('attachment-looking lines in the body or a quote are preserved', () => {
    const content = '输入文件: /tmp/a.txt\n\n> 输入文件: /tmp/quoted.txt\n\n用中文回答';
    const result = extractUserMessageFileAttachments(content);
    expect(result.text).toBe(content);
    expect(result.attachments).toEqual([]);
  });
});
