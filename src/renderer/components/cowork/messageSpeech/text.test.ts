import { expect, test } from 'vitest';

import { getMessageSpeechText } from './text';

test('reads formatted prose and link labels without their Markdown syntax or destinations', () => {
  const markdown = '# 结果\n\n已经**完成**，使用 `npm run build`。\n\n- [查看说明](https://example.com/docs)\n- ~~旧内容~~ 新内容';
  expect(getMessageSpeechText(markdown)).toBe('结果\n已经完成，使用 npm run build。\n查看说明\n旧内容 新内容');
});

test('skips code, diagrams, image references, raw URLs and HTML', () => {
  const markdown = [
    '生成完成。',
    '```ts\nconsole.log("do not speak");\n```',
    '```mermaid\ngraph TD; A-->B\n```',
    '![preview](file:///private/image.png)',
    '![reference][image]',
    '[image]: https://example.com/private.png',
    '<https://example.com/private>',
    '<div>hidden HTML content</div>',
  ].join('\n\n');
  expect(getMessageSpeechText(markdown)).toBe('生成完成。');
});

test('keeps table cells and math text readable', () => {
  const markdown = '| 项目 | 结果 |\n| --- | --- |\n| 构建 | 通过 |\n\n公式 $a + b$。';
  expect(getMessageSpeechText(markdown)).toBe('项目, 结果\n构建, 通过\n公式 a + b。');
});

test('media-only and code-only replies have no speech text', () => {
  expect(getMessageSpeechText('![图片](https://example.com/image.png)')).toBe('');
  expect(getMessageSpeechText('```json\n{"ok":true}\n```')).toBe('');
});
