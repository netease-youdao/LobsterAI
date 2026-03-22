/**
 * Unit tests for the "!" shell-command shortcut implemented in CoworkView.tsx.
 *
 * We mirror the pure decision logic from handlePromptSubmit and
 * handleShellCommand so no React / Electron environment is required.
 */
import { test, expect, describe } from 'vitest';

// ---------------------------------------------------------------------------
// Mirror: handlePromptSubmit — bang detection & routing
// ---------------------------------------------------------------------------

type SubmitTarget = 'shell' | 'start' | 'continue';

function classifyPrompt(
  prompt: string,
  hasCurrentSession: boolean,
): { target: SubmitTarget; command?: string } {
  const trimmed = prompt.trim();
  if (trimmed.startsWith('!')) {
    const command = trimmed.slice(1).trim();
    if (command) {
      return { target: 'shell', command };
    }
  }
  return { target: hasCurrentSession ? 'continue' : 'start' };
}

// ---------------------------------------------------------------------------
// Mirror: sessionId capture logic from handleShellCommand
// ---------------------------------------------------------------------------

function resolveSessionId(
  currentSessionId: string | null,
  now: number,
): string {
  if (!currentSessionId) {
    return `temp-shell-${now}`;
  }
  return currentSessionId;
}

// ---------------------------------------------------------------------------
// Mirror: tempSession title construction
// ---------------------------------------------------------------------------

function buildTempTitle(command: string): string {
  return `!${command}`.slice(0, 50);
}

// ---------------------------------------------------------------------------
// Mirror: isError flag
// ---------------------------------------------------------------------------

function computeIsError(success: boolean, exitCode: number): boolean {
  return !success || exitCode !== 0;
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('handlePromptSubmit — bang detection', () => {
  test('TC-BANG-01: "!ls -la" is classified as shell command', () => {
    const r = classifyPrompt('!ls -la', false);
    expect(r.target).toBe('shell');
    expect(r.command).toBe('ls -la');
  });

  test('TC-BANG-02: "!  ls -la" trims surrounding whitespace from command', () => {
    const r = classifyPrompt('!  ls -la', false);
    expect(r.target).toBe('shell');
    expect(r.command).toBe('ls -la');
  });

  test('TC-BANG-03: "  !ls" strips leading whitespace from prompt before matching', () => {
    const r = classifyPrompt('  !ls', false);
    expect(r.target).toBe('shell');
    expect(r.command).toBe('ls');
  });

  test('TC-BANG-04: "!" with no command is NOT treated as shell shortcut', () => {
    // Empty command falls through to the AI handler
    const r = classifyPrompt('!', false);
    expect(r.target).toBe('start');
    expect(r.command).toBeUndefined();
  });

  test('TC-BANG-05: "!   " (only whitespace after !) is NOT treated as shell shortcut', () => {
    const r = classifyPrompt('!   ', false);
    expect(r.target).toBe('start');
    expect(r.command).toBeUndefined();
  });

  test('TC-BANG-06: normal prompt without "!" is routed to AI (start when no session)', () => {
    const r = classifyPrompt('list my files', false);
    expect(r.target).toBe('start');
  });

  test('TC-BANG-07: normal prompt is routed to AI (continue when session active)', () => {
    const r = classifyPrompt('list my files', true);
    expect(r.target).toBe('continue');
  });

  test('TC-BANG-08: "!" in the middle of a prompt is NOT treated as shell shortcut', () => {
    const r = classifyPrompt('say hello! now', false);
    expect(r.target).toBe('start');
  });

  test('TC-BANG-09: bang command includes complex shell syntax', () => {
    const r = classifyPrompt('!git log --oneline -10 | head -5', false);
    expect(r.target).toBe('shell');
    expect(r.command).toBe('git log --oneline -10 | head -5');
  });

  test('TC-BANG-10: bang command with paths containing spaces', () => {
    const r = classifyPrompt('!ls "my folder"', false);
    expect(r.target).toBe('shell');
    expect(r.command).toBe('ls "my folder"');
  });
});

describe('handlePromptSubmit — routing when active session exists', () => {
  test('TC-ROUTE-01: shell command is not forwarded to AI regardless of session state', () => {
    expect(classifyPrompt('!echo hi', true).target).toBe('shell');
    expect(classifyPrompt('!echo hi', false).target).toBe('shell');
  });

  test('TC-ROUTE-02: regular prompt routes to continue when session is active', () => {
    expect(classifyPrompt('What is the weather?', true).target).toBe('continue');
  });

  test('TC-ROUTE-03: regular prompt routes to start when no session is active', () => {
    expect(classifyPrompt('What is the weather?', false).target).toBe('start');
  });
});

describe('sessionId capture logic', () => {
  const NOW = 1_700_000_000_000;

  test('TC-SID-01: generates a deterministic temp ID when there is no current session', () => {
    const id = resolveSessionId(null, NOW);
    expect(id).toBe(`temp-shell-${NOW}`);
  });

  test('TC-SID-02: uses existing session ID when a session is active', () => {
    const id = resolveSessionId('session-abc-123', NOW);
    expect(id).toBe('session-abc-123');
  });

  test('TC-SID-03: temp ID changes with different timestamps (no collision across calls)', () => {
    const id1 = resolveSessionId(null, NOW);
    const id2 = resolveSessionId(null, NOW + 1);
    expect(id1).not.toBe(id2);
  });
});

describe('tempSession title construction', () => {
  test('TC-TITLE-01: prepends "!" to command', () => {
    expect(buildTempTitle('ls -la')).toBe('!ls -la');
  });

  test('TC-TITLE-02: titles are capped at 50 characters', () => {
    const long = 'a'.repeat(60);
    expect(buildTempTitle(long).length).toBe(50);
  });

  test('TC-TITLE-03: short commands are not padded', () => {
    expect(buildTempTitle('pwd')).toBe('!pwd');
  });

  test('TC-TITLE-04: title starts with "!" for every command', () => {
    ['ls', 'git status', 'npm run build'].forEach((cmd) => {
      expect(buildTempTitle(cmd).startsWith('!')).toBe(true);
    });
  });
});

describe('isError / exitCode semantics', () => {
  test('TC-ERR-01: exitCode 0 and success=true → not an error', () => {
    expect(computeIsError(true, 0)).toBe(false);
  });

  test('TC-ERR-02: exitCode 1 and success=false → is an error', () => {
    expect(computeIsError(false, 1)).toBe(true);
  });

  test('TC-ERR-03: exitCode non-zero even when success=true → is an error', () => {
    // Edge case: IPC returned success=true but exitCode was non-zero
    expect(computeIsError(true, 1)).toBe(true);
  });

  test('TC-ERR-04: exitCode 0 but success=false → is an error', () => {
    expect(computeIsError(false, 0)).toBe(true);
  });

  test('TC-ERR-05: common non-zero exit codes are all flagged as errors', () => {
    [1, 2, 42, 127, 128, 255].forEach((code) => {
      expect(computeIsError(false, code)).toBe(true);
    });
  });
});

describe('user message construction', () => {
  function buildUserContent(command: string): string {
    return `!${command}`;
  }

  test('TC-USER-01: user message content always prefixes "!" to the raw command', () => {
    expect(buildUserContent('ls -la')).toBe('!ls -la');
  });

  test('TC-USER-02: complex command with pipes is preserved verbatim', () => {
    const cmd = 'git log --oneline | head -5';
    expect(buildUserContent(cmd)).toBe(`!${cmd}`);
  });
});
