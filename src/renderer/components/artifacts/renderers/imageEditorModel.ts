import type { LanguageType } from '@/services/i18n';

export const ImageEditorTool = {
  Comment: 'comment',
  Remove: 'remove',
} as const;

export type ImageEditorTool = typeof ImageEditorTool[keyof typeof ImageEditorTool];

export const ImageEditAspectRatio = {
  Original: 'original',
  Square: '1:1',
  Portrait: '3:4',
  Story: '9:16',
  Landscape: '4:3',
  Widescreen: '16:9',
} as const;

export type ImageEditAspectRatio =
  typeof ImageEditAspectRatio[keyof typeof ImageEditAspectRatio];

export interface ImageEditorPoint {
  x: number;
  y: number;
}

export interface ImageEditorComment extends ImageEditorPoint {
  id: string;
  text: string;
}

export interface ImageEditorStroke {
  id: string;
  points: ImageEditorPoint[];
  /** Brush diameter as a fraction of the image's shortest side. */
  size: number;
}

export interface ImageEditorSnapshot {
  comments: ImageEditorComment[];
  strokes: ImageEditorStroke[];
}

export interface ImageEditPromptInput {
  aspectRatio: ImageEditAspectRatio;
  comments: ImageEditorComment[];
  customInstructions: string;
  hasRemovalMask: boolean;
  language: LanguageType;
}

export const EMPTY_IMAGE_EDITOR_SNAPSHOT: ImageEditorSnapshot = {
  comments: [],
  strokes: [],
};

export function clampImageEditorPoint(point: ImageEditorPoint): ImageEditorPoint {
  return {
    x: Math.min(1, Math.max(0, point.x)),
    y: Math.min(1, Math.max(0, point.y)),
  };
}

export function getCompletedImageEditorComments(
  comments: ImageEditorComment[],
): ImageEditorComment[] {
  return comments.filter(comment => comment.text.trim().length > 0);
}

export function hasImageEditorChanges(input: ImageEditPromptInput): boolean {
  return getCompletedImageEditorComments(input.comments).length > 0
    || input.hasRemovalMask
    || input.aspectRatio !== ImageEditAspectRatio.Original
    || input.customInstructions.trim().length > 0;
}

export function offsetImageEditPromptReferences(prompt: string, offset: number): string {
  const normalizedOffset = Math.max(0, Math.floor(offset));
  if (normalizedOffset === 0) return prompt;
  return prompt.replace(/@图片(\d+)/g, (_match, imageNumber: string) => (
    `@图片${Number(imageNumber) + normalizedOffset}`
  ));
}

export function buildImageEditPrompt(input: ImageEditPromptInput): string {
  const comments = getCompletedImageEditorComments(input.comments);
  const customInstructions = input.customInstructions.trim();
  const hasCommentGuide = comments.length > 0;
  const maskImageNumber = hasCommentGuide ? 3 : 2;

  if (input.language === 'en') {
    const lines = ['Edit @图片1 while preserving unmentioned content and the original visual style.'];
    if (hasCommentGuide) {
      lines.push('Use the numbered markers in @图片2 as the edit locations:');
      comments.forEach((comment, index) => {
        lines.push(`${index + 1}. ${comment.text.trim()}`);
      });
    }
    if (input.hasRemovalMask) {
      lines.push(`Remove the areas painted white in @图片${maskImageNumber} and naturally reconstruct the background.`);
    }
    if (input.aspectRatio !== ImageEditAspectRatio.Original) {
      lines.push(`Change the canvas to ${input.aspectRatio}, extending or reframing the scene naturally without stretching the subject.`);
    }
    if (customInstructions) {
      lines.push(`Additional instructions: ${customInstructions}`);
    }
    return lines.join('\n');
  }

  const lines = ['请编辑 @图片1，未提及的内容与原有视觉风格保持不变。'];
  if (hasCommentGuide) {
    lines.push('请按 @图片2 中的编号标记定位并完成以下修改：');
    comments.forEach((comment, index) => {
      lines.push(`${index + 1}. ${comment.text.trim()}`);
    });
  }
  if (input.hasRemovalMask) {
    lines.push(`删除 @图片${maskImageNumber} 中白色涂抹覆盖的区域，并自然补全背景。`);
  }
  if (input.aspectRatio !== ImageEditAspectRatio.Original) {
    lines.push(`将画布调整为 ${input.aspectRatio}，自然延展或重新构图，不要拉伸主体。`);
  }
  if (customInstructions) {
    lines.push(`补充要求：${customInstructions}`);
  }
  return lines.join('\n');
}
