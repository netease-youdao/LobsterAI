/** Screenshot-only copy is kept separate from the companion window's dictionary. */
export const screenshotCopy = {
  zh: {
    hint: '拖动框选，调整选区后标注或选择操作。Esc 退出', select: '移动选区', rectangle: '矩形',
    ellipse: '椭圆', arrow: '箭头', pen: '画笔', mosaic: '马赛克', text: '文字',
    color: '颜色', width: '粗细', fontSize: '字号', undo: '撤销', reset: '重新框选',
    copy: '复制', save: '保存', extractText: '提取文字', translate: '翻译', ask: '问 AI',
    cancel: '取消', done: '完成', placeholder: '输入文字', error: '截图处理失败，请重试。',
    resize: '调整选区', editor: '截图编辑器', toolbar: '截图工具', busy: '处理中…',
  },
  en: {
    hint: 'Drag to select, then adjust, annotate or choose an action. Esc to cancel', select: 'Move selection', rectangle: 'Rectangle',
    ellipse: 'Ellipse', arrow: 'Arrow', pen: 'Pen', mosaic: 'Mosaic', text: 'Text',
    color: 'Color', width: 'Stroke width', fontSize: 'Font size', undo: 'Undo', reset: 'Reselect',
    copy: 'Copy', save: 'Save', extractText: 'Extract text', translate: 'Translate', ask: 'Ask AI',
    cancel: 'Cancel', done: 'Done', placeholder: 'Enter text', error: 'Could not process the screenshot. Try again.',
    resize: 'Resize selection', editor: 'Screenshot editor', toolbar: 'Screenshot tools', busy: 'Processing…',
  },
} as const;

export const screenshotTranslations = {
  zh: Object.fromEntries(Object.entries(screenshotCopy.zh).map(([key, value]) => [`screenshotEditor_${key}`, value])),
  en: Object.fromEntries(Object.entries(screenshotCopy.en).map(([key, value]) => [`screenshotEditor_${key}`, value])),
};
