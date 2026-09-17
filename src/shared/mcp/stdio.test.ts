import { describe, expect, test } from 'vitest';

import {
  STDIO_ARG_MAX_LENGTH,
  STDIO_COMMAND_MAX_LENGTH,
  StdioCommandValidationError,
  validateStdioCommand,
} from './stdio';

describe('validateStdioCommand', () => {
  test('accepts bare executable names and absolute paths', () => {
    expect(validateStdioCommand('npx', ['-y', 'my-mcp'])).toEqual({
      ok: true,
      command: 'npx',
      args: ['-y', 'my-mcp'],
    });
    expect(validateStdioCommand('C:\\Program Files\\nodejs\\node.exe', ['server.js']).ok).toBe(true);
    expect(validateStdioCommand('/opt/my app/bin/mcp-server').ok).toBe(true);
    expect(validateStdioCommand('\\\\server\\share\\mcp server.exe').ok).toBe(true);
  });

  test('accepts args containing spaces and dollar signs', () => {
    const result = validateStdioCommand('npx', ['--model', 'gpt-4o', '--token=$TOKEN', '--query=a b']);
    expect(result).toEqual({
      ok: true,
      command: 'npx',
      args: ['--model', 'gpt-4o', '--token=$TOKEN', '--query=a b'],
    });
  });

  test('trims surrounding whitespace from the command', () => {
    expect(validateStdioCommand('  node  ')).toEqual({ ok: true, command: 'node', args: [] });
  });

  test.each([
    ['', StdioCommandValidationError.Empty],
    ['   ', StdioCommandValidationError.Empty],
    ['node\u0000-x', StdioCommandValidationError.ControlChar],
    ['node\n-x', StdioCommandValidationError.ControlChar],
    ['node\t-x', StdioCommandValidationError.ControlChar],
    ['node & calc', StdioCommandValidationError.ShellMeta],
    ['node | cat', StdioCommandValidationError.ShellMeta],
    ['node; calc', StdioCommandValidationError.ShellMeta],
    ['node < input', StdioCommandValidationError.ShellMeta],
    ['node > output', StdioCommandValidationError.ShellMeta],
    ['echo `whoami`', StdioCommandValidationError.ShellMeta],
    ['node "$(whoami)"', StdioCommandValidationError.ShellMeta],
    ['npx -y foo', StdioCommandValidationError.InlineArguments],
    ['./server', StdioCommandValidationError.RelativePath],
    ['node_modules/.bin/server', StdioCommandValidationError.RelativePath],
    ['../server', StdioCommandValidationError.PathTraversal],
    ['C:\\safe\\..\\evil.exe', StdioCommandValidationError.PathTraversal],
  ])('rejects injection command "%s"', (command, error) => {
    const result = validateStdioCommand(command);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(error);
  });

  test('rejects non-string and overlong inputs', () => {
    expect(validateStdioCommand(42 as unknown)).toMatchObject({
      ok: false,
      error: StdioCommandValidationError.NonString,
    });
    expect(validateStdioCommand('n'.repeat(STDIO_COMMAND_MAX_LENGTH + 1))).toMatchObject({
      ok: false,
      error: StdioCommandValidationError.TooLong,
    });
  });

  test('validates the args array shape and contents', () => {
    expect(validateStdioCommand('npx', 'bad')).toMatchObject({
      ok: false,
      error: StdioCommandValidationError.InvalidArgs,
    });
    expect(validateStdioCommand('npx', [42])).toMatchObject({
      ok: false,
      error: StdioCommandValidationError.InvalidArgType,
    });
    expect(validateStdioCommand('npx', ['ok', 'bad\narg'])).toMatchObject({
      ok: false,
      error: StdioCommandValidationError.ArgControlChar,
    });
    expect(validateStdioCommand('npx', ['ok', 'a&b'])).toMatchObject({
      ok: false,
      error: StdioCommandValidationError.ArgControlChar,
    });
    expect(validateStdioCommand('npx', ['x'.repeat(STDIO_ARG_MAX_LENGTH + 1)])).toMatchObject({
      ok: false,
      error: StdioCommandValidationError.ArgTooLong,
    });
  });
});
