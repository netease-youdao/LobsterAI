import { describe, expect, test } from 'vitest';

import {
  formatOfficeFontLabel,
  formatOfficeFontSizeLabel,
  formatWordStyleLabel,
} from './officeToolbarLabels';

describe('officeToolbarLabels', () => {
  test('maps bundled and common CJK fonts to Chinese display names in zh locale', () => {
    expect(formatOfficeFontLabel('Noto Sans SC', 'zh')).toBe('思源黑体');
    expect(formatOfficeFontLabel('Microsoft YaHei', 'zh-CN')).toBe('微软雅黑');
    expect(formatOfficeFontLabel('SimSun', 'zh')).toBe('宋体');
    expect(formatOfficeFontLabel('Calibri', 'zh')).toBe('Calibri');
    expect(formatOfficeFontLabel('Noto Sans SC', 'en')).toBe('Noto Sans SC');
  });

  test('maps built-in Word paragraph styles to Chinese labels in zh locale', () => {
    expect(formatWordStyleLabel('Normal', 'Normal', 'zh')).toBe('正文');
    expect(formatWordStyleLabel('Title', 'Title', 'zh')).toBe('文档标题');
    expect(formatWordStyleLabel('Heading1', 'Heading 1', 'zh')).toBe('标题 1');
    expect(formatWordStyleLabel('CustomId', 'Heading 2', 'zh')).toBe('标题 2');
    expect(formatWordStyleLabel('CustomStyle', 'Custom Style', 'zh')).toBe('Custom Style');
    expect(formatWordStyleLabel('Normal', 'Normal', 'en')).toBe('Normal');
  });

  test('formats standard Chinese font sizes with point values in zh locale', () => {
    expect(formatOfficeFontSizeLabel(12, 'zh')).toBe('小四 (12)');
    expect(formatOfficeFontSizeLabel(10.5, 'zh')).toBe('五号 (10.5)');
    expect(formatOfficeFontSizeLabel(16, 'zh')).toBe('三号 (16)');
    expect(formatOfficeFontSizeLabel(22, 'zh')).toBe('二号 (22)');
    expect(formatOfficeFontSizeLabel(11, 'zh')).toBe('11');
    expect(formatOfficeFontSizeLabel(12, 'en')).toBe('12');
  });
});
