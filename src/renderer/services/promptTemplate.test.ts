import { describe, test, expect, vi } from 'vitest';

vi.mock('../store', () => ({
  store: { dispatch: vi.fn() },
}));

vi.mock('./i18n', () => ({
  i18nService: {
    getLanguage: () => 'zh',
    t: (key: string) => key,
  },
}));

import {
  extractVariableNames,
  isSystemVariable,
  resolveTemplate,
} from './promptTemplate';

describe('extractVariableNames', () => {
  test('extracts single variable', () => {
    expect(extractVariableNames('Hello {{name}}')).toEqual(['name']);
  });

  test('extracts multiple unique variables', () => {
    expect(extractVariableNames('{{greeting}} {{name}}, welcome to {{place}}')).toEqual([
      'greeting',
      'name',
      'place',
    ]);
  });

  test('deduplicates repeated variable names', () => {
    expect(extractVariableNames('{{name}} is {{name}}')).toEqual(['name']);
  });

  test('returns empty array for no variables', () => {
    expect(extractVariableNames('No variables here')).toEqual([]);
  });

  test('ignores malformed variable syntax', () => {
    expect(extractVariableNames('{{}} {{123}} {{ name }} {name}')).toEqual([]);
  });

  test('extracts system variables (ALL_CAPS)', () => {
    expect(extractVariableNames('Today is {{DATE}} at {{TIME}}')).toEqual(['DATE', 'TIME']);
  });

  test('handles underscores in variable names', () => {
    expect(extractVariableNames('{{first_name}} {{last_name}}')).toEqual([
      'first_name',
      'last_name',
    ]);
  });

  test('extracts variables starting with underscore', () => {
    expect(extractVariableNames('{{_private}}')).toEqual(['_private']);
  });
});

describe('isSystemVariable', () => {
  test('returns true for ALL_CAPS names', () => {
    expect(isSystemVariable('DATE')).toBe(true);
    expect(isSystemVariable('TIME')).toBe(true);
    expect(isSystemVariable('LANGUAGE')).toBe(true);
    expect(isSystemVariable('MY_VAR')).toBe(true);
  });

  test('returns false for lowercase or mixed case names', () => {
    expect(isSystemVariable('name')).toBe(false);
    expect(isSystemVariable('userName')).toBe(false);
    expect(isSystemVariable('Date')).toBe(false);
    expect(isSystemVariable('myVar')).toBe(false);
  });

  test('returns false for names with digits', () => {
    expect(isSystemVariable('VAR1')).toBe(false);
    expect(isSystemVariable('ABC123')).toBe(false);
  });
});

describe('resolveTemplate', () => {
  test('replaces user variables with provided values', () => {
    const result = resolveTemplate('Hello {{name}}, you are {{role}}', {
      name: 'Alice',
      role: 'admin',
    });
    expect(result).toBe('Hello Alice, you are admin');
  });

  test('preserves unresolved user variables as-is', () => {
    const result = resolveTemplate('Hello {{name}}, your {{title}}', {
      name: 'Bob',
    });
    expect(result).toBe('Hello Bob, your {{title}}');
  });

  test('resolves system variables automatically', () => {
    const result = resolveTemplate('Language: {{LANGUAGE}}', {});
    expect(result).toBe('Language: zh');
  });

  test('handles mixed system and user variables', () => {
    const result = resolveTemplate('{{name}} logged in at {{TIME}} on {{DATE}}', {
      name: 'Charlie',
    });
    expect(result).toContain('Charlie logged in at ');
    expect(result).not.toContain('{{name}}');
    expect(result).not.toContain('{{TIME}}');
    expect(result).not.toContain('{{DATE}}');
  });

  test('returns content unchanged when no variables present', () => {
    const result = resolveTemplate('No variables here', {});
    expect(result).toBe('No variables here');
  });

  test('handles empty content', () => {
    const result = resolveTemplate('', {});
    expect(result).toBe('');
  });

  test('preserves unknown system variables as-is', () => {
    const result = resolveTemplate('{{UNKNOWN_SYS_VAR}}', {});
    expect(result).toBe('{{UNKNOWN_SYS_VAR}}');
  });
});
