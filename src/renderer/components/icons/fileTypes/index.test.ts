import { describe, expect, test } from 'vitest';

import {
  CodeFileIcon,
  getFileTypeInfo,
  ImageFileIcon,
  JavaScriptFileIcon,
  PythonFileIcon,
  TypeScriptFileIcon,
} from './index';

describe('file type icon mapping', () => {
  test.each(['page.html', 'legacy.htm', 'PAGE.HTML'])(
    'uses the purple code icon for web page file %s',
    fileName => {
      const info = getFileTypeInfo(fileName);

      expect(info.icon).toBe(CodeFileIcon);
      expect(info.color).toBe('#8B5CF6');
    },
  );

  test('maps JavaScript, TypeScript, Python, and image extensions to distinct icons', () => {
    expect(getFileTypeInfo('open-headed.mjs').icon).toBe(JavaScriptFileIcon);
    expect(getFileTypeInfo('index.ts').icon).toBe(TypeScriptFileIcon);
    expect(getFileTypeInfo('create_docx.py').icon).toBe(PythonFileIcon);
    expect(getFileTypeInfo('first.png')).toMatchObject({ icon: ImageFileIcon, label: 'Image' });
    expect(getFileTypeInfo('Dockerfile').icon).toBe(CodeFileIcon);
  });
});
