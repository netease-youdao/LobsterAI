import { describe, expect, test } from 'vitest';

import { CodeFileIcon, getFileTypeInfo } from './index';

describe('file type icon mapping', () => {
  test.each(['page.html', 'legacy.htm', 'PAGE.HTML'])(
    'uses the purple code icon for web page file %s',
    fileName => {
      const info = getFileTypeInfo(fileName);

      expect(info.icon).toBe(CodeFileIcon);
      expect(info.color).toBe('#8B5CF6');
    },
  );
});
