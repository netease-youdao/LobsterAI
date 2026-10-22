import { describe, expect, test } from 'vitest';

import { stripAssistantImageDiagnostic } from './assistantImageDiagnostic';

const diagnostic = '[session:history] omitted image payload: missing data or mimeType';

describe('stripAssistantImageDiagnostic', () => {
  test('removes leaked standalone markers without removing the answer or image link', () => {
    expect(stripAssistantImageDiagnostic(`图片已生成。\n${diagnostic}\n![image](file:///result.png)`))
      .toBe('图片已生成。\n![image](file:///result.png)');
    expect(stripAssistantImageDiagnostic(`Done.\r\n${diagnostic}\r\n`)).toBe('Done.');
    expect(stripAssistantImageDiagnostic(diagnostic)).toBe('');
  });

  test.each([
    `这句话是什么意思：${diagnostic}`,
    `> ${diagnostic}`,
    `    ${diagnostic}`,
    `\`${diagnostic}\``,
    `\`\`\`text\n${diagnostic}\n\`\`\``,
    `~~~\n${diagnostic}\n~~~`,
    `\`\`\`\`text\n\`\`\`\n${diagnostic}\n\`\`\`\``,
    '[session:history] omitted image payload: invalid base64',
    '```svg\n<svg><text>hello</text></svg>\n```\n',
  ])('preserves quoted examples, other errors and valid SVG: %s', text => {
    expect(stripAssistantImageDiagnostic(text)).toBe(text);
  });

  test('removes a marker after a fenced example, preserving its contents', () => {
    const example = `~~~text\n${diagnostic}\n~~~`;
    expect(stripAssistantImageDiagnostic(`${example}\n${diagnostic}`)).toBe(example);
  });
});
