import { describe, expect, test } from 'vitest';

import {
  buildImageEditPrompt,
  clampImageEditorPoint,
  hasImageEditorChanges,
  ImageEditAspectRatio,
  type ImageEditorComment,
  offsetImageEditPromptReferences,
} from './imageEditorModel';

const comments: ImageEditorComment[] = [
  { id: 'one', x: 0.25, y: 0.5, text: '把杯子改成蓝色' },
  { id: 'empty', x: 0.5, y: 0.5, text: '   ' },
];

describe('imageEditorModel', () => {
  test('clamps normalized image points', () => {
    expect(clampImageEditorPoint({ x: -0.2, y: 1.4 })).toEqual({ x: 0, y: 1 });
  });

  test('builds a localized prompt with deterministic attachment numbers', () => {
    expect(buildImageEditPrompt({
      aspectRatio: ImageEditAspectRatio.Widescreen,
      comments,
      customInstructions: '光线更柔和',
      hasRemovalMask: true,
      language: 'zh',
    })).toBe([
      '请编辑 @图片1，未提及的内容与原有视觉风格保持不变。',
      '请按 @图片2 中的编号标记定位并完成以下修改：',
      '1. 把杯子改成蓝色',
      '删除 @图片3 中白色涂抹覆盖的区域，并自然补全背景。',
      '将画布调整为 16:9，自然延展或重新构图，不要拉伸主体。',
      '补充要求：光线更柔和',
    ].join('\n'));
  });

  test('uses image two for a removal mask when no comment guide exists', () => {
    expect(buildImageEditPrompt({
      aspectRatio: ImageEditAspectRatio.Original,
      comments: [],
      customInstructions: '',
      hasRemovalMask: true,
      language: 'en',
    })).toContain('@图片2');
  });

  test('ignores empty comments when deciding whether the draft has changes', () => {
    expect(hasImageEditorChanges({
      aspectRatio: ImageEditAspectRatio.Original,
      comments: [comments[1]],
      customInstructions: '',
      hasRemovalMask: false,
      language: 'zh',
    })).toBe(false);
  });

  test('offsets image mentions when a draft already has image attachments', () => {
    expect(offsetImageEditPromptReferences(
      '编辑 @图片1，并使用 @图片2 和 @图片3。',
      2,
    )).toBe('编辑 @图片3，并使用 @图片4 和 @图片5。');
  });
});
