/**
 * Unified, syntax-aware shell and embedded-script danger classification shared
 * by the main process (`commandSafety.ts`) and renderer (`permissionModalPresentation.ts`).
 *
 * Scans real shell command positions (skipping comments, ordinary quoted data,
 * and non-interpreter heredocs such as `cat <<'EOF' > doc.md`), plus real
 * destructive/mutation API calls inside embedded Python and Node scripts, and
 * reports the exact triggering snippet and line number so the approval UI can
 * show users *why* confirmation was requested.
 */

export const CommandDangerLevel = {
  Safe: 'safe',
  Caution: 'caution',
  Destructive: 'destructive',
} as const;
export type CommandDangerLevel = typeof CommandDangerLevel[keyof typeof CommandDangerLevel];

export const CommandDangerReason = {
  RecursiveDelete: 'recursive-delete',
  GitForcePush: 'git-force-push',
  GitResetHard: 'git-reset-hard',
  DiskOverwrite: 'disk-overwrite',
  DiskFormat: 'disk-format',
  FileDelete: 'file-delete',
  GitPush: 'git-push',
  ProcessKill: 'process-kill',
  PermissionChange: 'permission-change',
  PrivilegeEscalation: 'privilege-escalation',
} as const;
export type CommandDangerReason = typeof CommandDangerReason[keyof typeof CommandDangerReason];

export interface CommandDangerAnalysis {
  level: CommandDangerLevel;
  reason: CommandDangerReason | '';
  /** Trimmed command segment or script line that triggered the match. */
  matchedSnippet: string;
  /** 1-based line number of `matchedSnippet` in the original command (0 if safe). */
  matchedLineNumber: number;
  /**
   * True when the match came from an embedded script (heredoc / `-c` / `-e`)
   * or a multi-step compound command with more than one substantive action.
   */
  isEmbeddedInScript: boolean;
}

const SAFE_ANALYSIS: CommandDangerAnalysis = {
  level: CommandDangerLevel.Safe,
  reason: '',
  matchedSnippet: '',
  matchedLineNumber: 0,
  isEmbeddedInScript: false,
};

const REASON_PRIORITY: Record<CommandDangerReason, number> = {
  [CommandDangerReason.RecursiveDelete]: 100,
  [CommandDangerReason.GitForcePush]: 95,
  [CommandDangerReason.GitResetHard]: 90,
  [CommandDangerReason.DiskOverwrite]: 85,
  [CommandDangerReason.DiskFormat]: 80,
  [CommandDangerReason.PrivilegeEscalation]: 55,
  [CommandDangerReason.FileDelete]: 50,
  [CommandDangerReason.GitPush]: 45,
  [CommandDangerReason.ProcessKill]: 40,
  [CommandDangerReason.PermissionChange]: 35,
};

const REASON_LEVEL: Record<CommandDangerReason, CommandDangerLevel> = {
  [CommandDangerReason.RecursiveDelete]: CommandDangerLevel.Destructive,
  [CommandDangerReason.GitForcePush]: CommandDangerLevel.Destructive,
  [CommandDangerReason.GitResetHard]: CommandDangerLevel.Destructive,
  [CommandDangerReason.DiskOverwrite]: CommandDangerLevel.Destructive,
  [CommandDangerReason.DiskFormat]: CommandDangerLevel.Destructive,
  [CommandDangerReason.FileDelete]: CommandDangerLevel.Caution,
  [CommandDangerReason.GitPush]: CommandDangerLevel.Caution,
  [CommandDangerReason.ProcessKill]: CommandDangerLevel.Caution,
  [CommandDangerReason.PermissionChange]: CommandDangerLevel.Caution,
  [CommandDangerReason.PrivilegeEscalation]: CommandDangerLevel.Caution,
};

interface DangerCandidate {
  reason: CommandDangerReason;
  matchedSnippet: string;
  matchedLineNumber: number;
  fromEmbedded: boolean;
}

interface ShellToken {
  value: string;
  raw: string;
  quoted: boolean;
  startLine: number;
}

interface ShellSegment {
  tokens: ShellToken[];
  raw: string;
  startLine: number;
}

interface HeredocSpec {
  delimiter: string;
  stripTabs: boolean;
  ownerCommand: string;
}

interface HeredocBlock {
  ownerCommand: string;
  body: string;
  bodyStartLine: number;
}

const DELETE_COMMAND_VERBS = new Set([
  'rm',
  'rmdir',
  'rd',
  'unlink',
  'del',
  'erase',
  'remove-item',
  'trash',
]);

const KILL_COMMAND_VERBS = new Set([
  'kill',
  'killall',
  'pkill',
  'taskkill',
  'stop-process',
]);

const OWNERSHIP_COMMAND_VERBS = new Set([
  'chown',
  'chgrp',
  'icacls',
  'takeown',
]);

const PRIVILEGE_COMMAND_VERBS = new Set([
  'sudo',
  'doas',
]);

const SHELL_INTERPRETERS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'pwsh',
  'powershell',
]);

const JS_INTERPRETERS = new Set([
  'node',
  'deno',
  'bun',
  'tsx',
  'ts-node',
]);

const BOILERPLATE_SHELL_COMMANDS = new Set([
  'cd',
  'pushd',
  'popd',
  'export',
  'set',
  'unset',
  'true',
  'false',
  'pwd',
  'umask',
]);

const OUTPUT_FILTER_COMMANDS = new Set([
  'tail',
  'head',
  'cat',
  'tee',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'wc',
  'sort',
  'uniq',
  'cut',
  'tr',
  'less',
  'more',
]);

const WRAPPER_COMMANDS = new Set([
  'command',
  'builtin',
  'nohup',
  'time',
  'exec',
]);

const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SYSTEM_PATH_PREFIXES = [
  '/etc',
  '/usr',
  '/system',
  '/bin',
  '/sbin',
  '/var',
  '/library',
  '/opt',
  '/boot',
  '/root',
  '/dev',
  '/proc',
  '/sys',
];

function normalizeCommandName(raw: string): string {
  const trimmed = raw.trim().replace(/^['"]|['"]$/g, '');
  const base = trimmed.replace(/^.*[\\/]/, '').toLowerCase();
  return base.endsWith('.exe') ? base.slice(0, -4) : base;
}

function isPythonInterpreter(cmdName: string): boolean {
  return /^python(?:\d+(?:\.\d+)*)?$/.test(cmdName);
}

function isSystemOrDirectoryTarget(target: string): boolean {
  const trimmed = target.trim().replace(/^['"]|['"]$/g, '');
  if (!trimmed || trimmed === '/' || trimmed.endsWith('/') || trimmed.endsWith('\\')) {
    return true;
  }
  const lower = trimmed.toLowerCase();
  return SYSTEM_PATH_PREFIXES.some(
    (prefix) => lower === prefix || lower.startsWith(`${prefix}/`),
  );
}

function isBenignOwnerOnlyShellChmod(args: ShellToken[]): boolean {
  let mode: string | null = null;
  const targets: string[] = [];
  let afterDoubleDash = false;

  for (const token of args) {
    const val = token.value;
    if (!afterDoubleDash && val === '--') {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && val.startsWith('-')) {
      if (val === '--recursive' || /^-[a-zA-Z]*R[a-zA-Z]*$/.test(val) || val.startsWith('--reference')) {
        return false;
      }
      continue;
    }
    if (mode === null) {
      mode = val;
    } else {
      targets.push(val);
    }
  }

  if (!mode || !/^0?600$/.test(mode) || targets.length === 0) {
    return false;
  }
  return targets.every((target) => !isSystemOrDirectoryTarget(target));
}

function isBenignOwnerOnlyCodeChmod(modeExpr: string, pathExpr?: string): boolean {
  const normalizedMode = modeExpr.trim().replace(/^['"]|['"]$/g, '');
  if (!/^0o?600$/i.test(normalizedMode) && normalizedMode !== '600') {
    return false;
  }
  if (pathExpr) {
    const trimmedPath = pathExpr.trim();
    const quotedLiteral = /^(['"])([^'"]*)\1$/.exec(trimmedPath);
    if (quotedLiteral && isSystemOrDirectoryTarget(quotedLiteral[2])) {
      return false;
    }
  }
  return true;
}

function clipSnippet(snippet: string, maxLen = 180): string {
  const normalized = snippet.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen - 1).trimEnd()}…`;
}

function pickBestCandidate(candidates: DangerCandidate[]): DangerCandidate | null {
  let best: DangerCandidate | null = null;
  for (const candidate of candidates) {
    if (!best || REASON_PRIORITY[candidate.reason] > REASON_PRIORITY[best.reason]) {
      best = candidate;
    }
  }
  return best;
}

function extractCommandSubstitutions(text: string): string[] {
  const substitutions: string[] = [];
  let i = 0;
  let inSingle = false;
  let inDouble = false;

  while (i < text.length) {
    const ch = text[i];
    if (inSingle) {
      if (ch === '\'') inSingle = false;
      i += 1;
      continue;
    }
    if (ch === '\\' && i + 1 < text.length) {
      i += 2;
      continue;
    }
    if (!inDouble && ch === '\'') {
      inSingle = true;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inDouble = !inDouble;
      i += 1;
      continue;
    }
    if (ch === '$' && text[i + 1] === '(' && text[i + 2] !== '(') {
      let depth = 1;
      let j = i + 2;
      let innerSingle = false;
      let innerDouble = false;
      while (j < text.length && depth > 0) {
        const c = text[j];
        if (innerSingle) {
          if (c === '\'') innerSingle = false;
        } else if (c === '\\' && j + 1 < text.length) {
          j += 1;
        } else if (!innerDouble && c === '\'') {
          innerSingle = true;
        } else if (c === '"') {
          innerDouble = !innerDouble;
        } else if (!innerDouble) {
          if (c === '(') depth += 1;
          else if (c === ')') depth -= 1;
        }
        j += 1;
      }
      if (depth === 0) {
        substitutions.push(text.slice(i + 2, j - 1));
        i = j;
        continue;
      }
    }
    if (ch === '`') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\' && j + 1 < text.length) {
          j += 2;
          continue;
        }
        if (text[j] === '`') break;
        j += 1;
      }
      if (j < text.length && text[j] === '`') {
        substitutions.push(text.slice(i + 1, j));
        i = j + 1;
        continue;
      }
    }
    i += 1;
  }

  return substitutions;
}

/**
 * Tokenize a shell command string into segments and heredoc blocks while
 * preserving exact 1-based line numbers across multi-line quoted strings.
 */
function parseShellScript(command: string): {
  segments: ShellSegment[];
  heredocs: HeredocBlock[];
} {
  const src = command.replace(/\r\n/g, '\n');
  const segments: ShellSegment[] = [];
  const heredocs: HeredocBlock[] = [];
  const pendingHeredocs: HeredocSpec[] = [];

  let i = 0;
  let line = 1;
  let currentTokens: ShellToken[] = [];
  let segStartPos = 0;
  let segStartLine = 1;

  const flushSegment = (endPos: number) => {
    if (currentTokens.length > 0) {
      segments.push({
        tokens: currentTokens,
        raw: src.slice(segStartPos, endPos).trim(),
        startLine: segStartLine,
      });
      currentTokens = [];
    }
  };

  const resolveCurrentOwner = (): string => {
    for (const tok of currentTokens) {
      if (ENV_ASSIGNMENT_RE.test(tok.value)) continue;
      const name = normalizeCommandName(tok.value);
      if (WRAPPER_COMMANDS.has(name) || name === 'env' || name === 'sudo' || name === 'doas') {
        continue;
      }
      return name;
    }
    return '';
  };

  const consumePendingHeredocs = () => {
    while (pendingHeredocs.length > 0 && i < src.length) {
      const spec = pendingHeredocs.shift()!;
      const bodyStartLine = line;
      const bodyLines: string[] = [];
      while (i < src.length) {
        const nl = src.indexOf('\n', i);
        const lineText = nl === -1 ? src.slice(i) : src.slice(i, nl);
        i = nl === -1 ? src.length : nl + 1;
        line += 1;
        const stripped = spec.stripTabs ? lineText.replace(/^\t+/, '') : lineText;
        if (stripped.trimEnd() === spec.delimiter) {
          break;
        }
        bodyLines.push(lineText);
      }
      heredocs.push({
        ownerCommand: spec.ownerCommand,
        body: bodyLines.join('\n'),
        bodyStartLine,
      });
    }
  };

  while (i < src.length) {
    const ch = src[i];

    if (ch === ' ' || ch === '\t') {
      i += 1;
      continue;
    }

    // Line continuation `\<newline>` outside quotes
    if (ch === '\\' && src[i + 1] === '\n') {
      i += 2;
      line += 1;
      continue;
    }

    // Newline ends current segment and starts any queued heredoc bodies
    if (ch === '\n') {
      flushSegment(i);
      i += 1;
      line += 1;
      segStartPos = i;
      segStartLine = line;
      if (pendingHeredocs.length > 0) {
        consumePendingHeredocs();
        segStartPos = i;
        segStartLine = line;
      }
      continue;
    }

    // Shell comment `#...` to end of line
    if (ch === '#') {
      flushSegment(i);
      while (i < src.length && src[i] !== '\n') {
        i += 1;
      }
      continue;
    }

    // Command separators
    if (ch === ';' || ch === '(' || ch === ')') {
      flushSegment(i);
      i += 1;
      segStartPos = i;
      segStartLine = line;
      continue;
    }
    if ((ch === '&' && src[i + 1] === '&') || (ch === '|' && src[i + 1] === '|')) {
      flushSegment(i);
      i += 2;
      segStartPos = i;
      segStartLine = line;
      continue;
    }
    if (ch === '|' || (ch === '&' && src[i - 1] !== '>' && src[i + 1] !== '>')) {
      flushSegment(i);
      i += 1;
      segStartPos = i;
      segStartLine = line;
      continue;
    }

    // Heredoc operator `<<` or `<<-` (excluding `<<<`)
    if (ch === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
      const stripTabs = src[i + 2] === '-';
      let j = i + (stripTabs ? 3 : 2);
      while (j < src.length && (src[j] === ' ' || src[j] === '\t')) j += 1;
      const lineEnd = src.indexOf('\n', j);
      const restOfLine = src.slice(j, lineEnd === -1 ? src.length : lineEnd);
      const delimMatch = /^(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z_][A-Za-z0-9_-]*))/.exec(restOfLine);
      if (delimMatch) {
        const delimiter = delimMatch[1] || delimMatch[2] || delimMatch[3];
        pendingHeredocs.push({
          delimiter,
          stripTabs,
          ownerCommand: resolveCurrentOwner(),
        });
        i = j + delimMatch[0].length;
        continue;
      }
    }

    // Read one shell token (supporting multi-line single/double quotes)
    if (currentTokens.length === 0) {
      segStartPos = i;
      segStartLine = line;
    }
    const tokenStart = i;
    const tokenStartLine = line;
    let value = '';
    let quoted = false;

    while (i < src.length) {
      const c = src[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === ';' || c === '|' || c === '(' || c === ')') {
        break;
      }
      if (c === '&' && src[i - 1] !== '>' && src[i + 1] !== '>') {
        break;
      }
      if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
        break;
      }
      if (c === '\'') {
        quoted = true;
        i += 1;
        while (i < src.length && src[i] !== '\'') {
          if (src[i] === '\n') line += 1;
          value += src[i];
          i += 1;
        }
        if (i < src.length && src[i] === '\'') i += 1;
        continue;
      }
      if (c === '"') {
        quoted = true;
        i += 1;
        while (i < src.length && src[i] !== '"') {
          if (
            src[i] === '\\'
            && i + 1 < src.length
            && (src[i + 1] === '"' || src[i + 1] === '\\' || src[i + 1] === '$' || src[i + 1] === '`')
          ) {
            value += src[i + 1];
            i += 2;
          } else if (src[i] === '\\' && src[i + 1] === '\n') {
            line += 1;
            i += 2;
          } else {
            if (src[i] === '\n') line += 1;
            value += src[i];
            i += 1;
          }
        }
        if (i < src.length && src[i] === '"') i += 1;
        continue;
      }
      if (c === '\\' && i + 1 < src.length) {
        if (src[i + 1] === '\n') {
          line += 1;
          i += 2;
        } else {
          value += src[i + 1];
          i += 2;
        }
        continue;
      }
      value += c;
      i += 1;
    }

    const raw = src.slice(tokenStart, i);
    if (raw.length > 0) {
      currentTokens.push({ value, raw, quoted, startLine: tokenStartLine });
    }
  }

  flushSegment(i);
  return { segments, heredocs };
}

function stripLeadingShellWrappers(tokens: ShellToken[]): {
  commandName: string;
  args: ShellToken[];
  hasPrivilegePrefix: boolean;
} {
  let idx = 0;
  let hasPrivilegePrefix = false;

  while (idx < tokens.length) {
    const tok = tokens[idx];
    if (!tok.quoted && ENV_ASSIGNMENT_RE.test(tok.value)) {
      idx += 1;
      continue;
    }
    const name = normalizeCommandName(tok.value);
    if (PRIVILEGE_COMMAND_VERBS.has(name)) {
      hasPrivilegePrefix = true;
      idx += 1;
      while (idx < tokens.length && tokens[idx].value.startsWith('-')) {
        const flag = tokens[idx].value;
        idx += 1;
        if ((flag === '-u' || flag === '-g' || flag === '-C' || flag === '-p') && idx < tokens.length) {
          idx += 1;
        }
      }
      continue;
    }
    if (name === 'env') {
      idx += 1;
      while (idx < tokens.length && (tokens[idx].value.startsWith('-') || ENV_ASSIGNMENT_RE.test(tokens[idx].value))) {
        idx += 1;
      }
      continue;
    }
    if (name === 'timeout' || name === 'nice') {
      idx += 1;
      while (idx < tokens.length && tokens[idx].value.startsWith('-')) {
        idx += 1;
      }
      if (name === 'timeout' && idx < tokens.length && /^\d/.test(tokens[idx].value)) {
        idx += 1;
      }
      continue;
    }
    if (WRAPPER_COMMANDS.has(name)) {
      idx += 1;
      continue;
    }
    return {
      commandName: name,
      args: tokens.slice(idx + 1),
      hasPrivilegePrefix,
    };
  }

  return { commandName: '', args: [], hasPrivilegePrefix };
}

function isSubstantiveSegment(segment: ShellSegment): boolean {
  const { commandName, hasPrivilegePrefix } = stripLeadingShellWrappers(segment.tokens);
  if (hasPrivilegePrefix) return true;
  if (!commandName) return false;
  if (BOILERPLATE_SHELL_COMMANDS.has(commandName)) return false;
  if (OUTPUT_FILTER_COMMANDS.has(commandName) && segment.tokens.length <= 4) {
    return false;
  }
  return true;
}

function extractInlineFlagToken(args: ShellToken[], flags: Set<string>): ShellToken | null {
  for (let i = 0; i < args.length; i += 1) {
    const val = args[i].value.toLowerCase();
    if (flags.has(val) && i + 1 < args.length) {
      return args[i + 1];
    }
  }
  return null;
}

function findGitSubcommand(args: ShellToken[]): { subcommand: string; subArgs: ShellToken[] } | null {
  let i = 0;
  while (i < args.length) {
    const val = args[i].value;
    if (val === '-C' || val === '-c' || val === '--git-dir' || val === '--work-tree') {
      i += 2;
      continue;
    }
    if (val.startsWith('-')) {
      i += 1;
      continue;
    }
    return { subcommand: val.toLowerCase(), subArgs: args.slice(i + 1) };
  }
  return null;
}

/**
 * Mask Python comments and non-shell string literals with spaces (preserving
 * newlines so 1-based line numbers remain exact) while extracting string or
 * string-list arguments passed to `os.system` / `os.popen` / `subprocess.*`.
 */
function preprocessPythonCode(code: string): {
  maskedCode: string;
  shellExecCalls: Array<{ command: string; lineOffset: number }>;
} {
  const chars = Array.from(code);
  const masked = Array.from(code);
  const shellExecCalls: Array<{ command: string; lineOffset: number }> = [];

  interface PyStringSpan {
    start: number;
    end: number;
    value: string;
    lineOffset: number;
  }
  const stringSpans: PyStringSpan[] = [];

  let i = 0;
  let lineOffset = 0;
  while (i < chars.length) {
    const ch = chars[i];
    if (ch === '\n') {
      lineOffset += 1;
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < chars.length && chars[i] !== '\n') {
        masked[i] = ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '\'' || ch === '"') {
      const start = i;
      const startLineOffset = lineOffset;
      const isTriple = chars[i + 1] === ch && chars[i + 2] === ch;
      const quoteLen = isTriple ? 3 : 1;
      i += quoteLen;
      let val = '';
      while (i < chars.length) {
        if (chars[i] === '\\' && i + 1 < chars.length) {
          if (chars[i + 1] === '\n') lineOffset += 1;
          val += chars[i + 1];
          i += 2;
          continue;
        }
        if (isTriple && chars[i] === ch && chars[i + 1] === ch && chars[i + 2] === ch) {
          i += 3;
          break;
        }
        if (!isTriple && (chars[i] === ch || chars[i] === '\n')) {
          if (chars[i] === '\n') lineOffset += 1;
          i += 1;
          break;
        }
        if (chars[i] === '\n') lineOffset += 1;
        val += chars[i];
        i += 1;
      }
      const end = i;
      stringSpans.push({ start, end, value: val, lineOffset: startLineOffset });
      for (let k = start; k < end; k += 1) {
        if (masked[k] !== '\n') masked[k] = ' ';
      }
      continue;
    }
    i += 1;
  }

  const maskedJoined = masked.join('');
  const execCallRe = /\b(?:os\.(?:system|popen)|subprocess\.(?:run|call|check_call|check_output|Popen))\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = execCallRe.exec(maskedJoined)) !== null) {
    const callArgStart = match.index + match[0].length;
    let depth = 1;
    let p = callArgStart;
    while (p < masked.length && depth > 0) {
      if (masked[p] === '(') depth += 1;
      else if (masked[p] === ')') depth -= 1;
      p += 1;
    }
    const callEnd = p;
    const innerSpans = stringSpans.filter((s) => s.start >= callArgStart && s.end <= callEnd);
    if (innerSpans.length === 0) continue;

    const argPrefix = code.slice(callArgStart, innerSpans[0].start).trim();
    if (argPrefix.startsWith('[')) {
      const closeBracket = code.indexOf(']', callArgStart);
      const listSpans = closeBracket >= 0
        ? innerSpans.filter((s) => s.end <= closeBracket)
        : innerSpans;
      if (listSpans.length > 0) {
        const joined = listSpans
          .map((s) => (/\s/.test(s.value) ? `"${s.value.replace(/"/g, '\\"')}"` : s.value))
          .join(' ');
        shellExecCalls.push({ command: joined, lineOffset: listSpans[0].lineOffset });
      }
    } else if (argPrefix === '' || argPrefix === 'f' || argPrefix === 'r') {
      shellExecCalls.push({
        command: innerSpans[0].value,
        lineOffset: innerSpans[0].lineOffset,
      });
    }
  }

  return { maskedCode: maskedJoined, shellExecCalls };
}

function scanPythonCode(
  code: string,
  baseLineNumber: number,
  fromEmbedded: boolean,
  out: DangerCandidate[],
): void {
  const { maskedCode, shellExecCalls } = preprocessPythonCode(code);
  const originalLines = code.split(/\r?\n/);
  const maskedLines = maskedCode.split(/\r?\n/);

  for (const call of shellExecCalls) {
    const nested: DangerCandidate[] = [];
    collectShellCandidates(call.command, baseLineNumber + call.lineOffset, true, nested);
    const origLine = originalLines[call.lineOffset]?.trim();
    for (const item of nested) {
      out.push({
        reason: item.reason,
        matchedSnippet: clipSnippet(origLine || item.matchedSnippet),
        matchedLineNumber: baseLineNumber + call.lineOffset,
        fromEmbedded: true,
      });
    }
  }

  for (let idx = 0; idx < maskedLines.length; idx += 1) {
    const maskedLine = maskedLines[idx];
    const origLine = originalLines[idx] ?? '';
    const lineNum = baseLineNumber + idx;

    if (/\b(?:shutil\.)?rmtree\s*\(/.test(maskedLine)) {
      out.push({
        reason: CommandDangerReason.RecursiveDelete,
        matchedSnippet: clipSnippet(origLine),
        matchedLineNumber: lineNum,
        fromEmbedded,
      });
      continue;
    }

    if (
      /\bos\.(?:remove|unlink|rmdir)\s*\(/.test(maskedLine)
      || /\.\s*(?:unlink|rmdir)\s*\(/.test(maskedLine)
      || /\bsend2trash\s*\(/.test(maskedLine)
    ) {
      out.push({
        reason: CommandDangerReason.FileDelete,
        matchedSnippet: clipSnippet(origLine),
        matchedLineNumber: lineNum,
        fromEmbedded,
      });
    }

    if (/\bos\.(?:kill|killpg)\s*\(/.test(maskedLine)) {
      out.push({
        reason: CommandDangerReason.ProcessKill,
        matchedSnippet: clipSnippet(origLine),
        matchedLineNumber: lineNum,
        fromEmbedded,
      });
    }

    if (/\bos\.(?:chown|lchown)\s*\(/.test(maskedLine)) {
      out.push({
        reason: CommandDangerReason.PermissionChange,
        matchedSnippet: clipSnippet(origLine),
        matchedLineNumber: lineNum,
        fromEmbedded,
      });
    }

    if (/\b(?:os\.)?chmod\s*\(/.test(maskedLine) || /\.\s*chmod\s*\(/.test(maskedLine)) {
      const origChmodMatch = /(?:\bos\.|\.)?chmod\s*\(([^)]*)\)/.exec(origLine);
      let benign = false;
      if (origChmodMatch) {
        const argParts = origChmodMatch[1].split(',');
        if (argParts.length >= 2) {
          benign = isBenignOwnerOnlyCodeChmod(argParts[1], argParts[0]);
        } else if (argParts.length === 1) {
          benign = isBenignOwnerOnlyCodeChmod(argParts[0]);
        }
      }
      if (!benign) {
        out.push({
          reason: CommandDangerReason.PermissionChange,
          matchedSnippet: clipSnippet(origLine),
          matchedLineNumber: lineNum,
          fromEmbedded,
        });
      }
    }
  }
}

function preprocessJsCode(code: string): {
  maskedCode: string;
  shellExecCalls: Array<{ command: string; lineOffset: number }>;
} {
  const chars = Array.from(code);
  const masked = Array.from(code);
  const shellExecCalls: Array<{ command: string; lineOffset: number }> = [];
  interface JsStringSpan {
    start: number;
    end: number;
    value: string;
    lineOffset: number;
  }
  const stringSpans: JsStringSpan[] = [];

  let i = 0;
  let lineOffset = 0;
  while (i < chars.length) {
    const ch = chars[i];
    if (ch === '\n') {
      lineOffset += 1;
      i += 1;
      continue;
    }
    if (ch === '/' && chars[i + 1] === '/') {
      while (i < chars.length && chars[i] !== '\n') {
        masked[i] = ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '/' && chars[i + 1] === '*') {
      masked[i] = ' ';
      masked[i + 1] = ' ';
      i += 2;
      while (i < chars.length && !(chars[i] === '*' && chars[i + 1] === '/')) {
        if (chars[i] === '\n') lineOffset += 1;
        else masked[i] = ' ';
        i += 1;
      }
      if (i + 1 < chars.length) {
        masked[i] = ' ';
        masked[i + 1] = ' ';
        i += 2;
      }
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      const quote = ch;
      const start = i;
      const startLineOffset = lineOffset;
      i += 1;
      let val = '';
      while (i < chars.length) {
        if (chars[i] === '\\' && i + 1 < chars.length) {
          if (chars[i + 1] === '\n') lineOffset += 1;
          val += chars[i + 1];
          i += 2;
          continue;
        }
        if (chars[i] === quote) {
          i += 1;
          break;
        }
        if (chars[i] === '\n') lineOffset += 1;
        val += chars[i];
        i += 1;
      }
      const end = i;
      stringSpans.push({ start, end, value: val, lineOffset: startLineOffset });
      for (let k = start; k < end; k += 1) {
        if (masked[k] !== '\n') masked[k] = ' ';
      }
      continue;
    }
    i += 1;
  }

  const maskedJoined = masked.join('');
  const execCallRe = /\b(?:execSync|exec)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = execCallRe.exec(maskedJoined)) !== null) {
    const callArgStart = match.index + match[0].length;
    const nextSpan = stringSpans.find(
      (s) => s.start >= callArgStart && code.slice(callArgStart, s.start).trim() === '',
    );
    if (nextSpan) {
      shellExecCalls.push({ command: nextSpan.value, lineOffset: nextSpan.lineOffset });
    }
  }

  return { maskedCode: maskedJoined, shellExecCalls };
}

function scanJsCode(
  code: string,
  baseLineNumber: number,
  fromEmbedded: boolean,
  out: DangerCandidate[],
): void {
  const { maskedCode, shellExecCalls } = preprocessJsCode(code);
  const originalLines = code.split(/\r?\n/);
  const maskedLines = maskedCode.split(/\r?\n/);

  for (const call of shellExecCalls) {
    const nested: DangerCandidate[] = [];
    collectShellCandidates(call.command, baseLineNumber + call.lineOffset, true, nested);
    const origLine = originalLines[call.lineOffset]?.trim();
    for (const item of nested) {
      out.push({
        reason: item.reason,
        matchedSnippet: clipSnippet(origLine || item.matchedSnippet),
        matchedLineNumber: baseLineNumber + call.lineOffset,
        fromEmbedded: true,
      });
    }
  }

  for (let idx = 0; idx < maskedLines.length; idx += 1) {
    const maskedLine = maskedLines[idx];
    const origLine = originalLines[idx] ?? '';
    const lineNum = baseLineNumber + idx;

    if (/\b(?:rmSync|rm)\s*\([^)]*recursive\s*:\s*true/.test(maskedLine)) {
      out.push({
        reason: CommandDangerReason.RecursiveDelete,
        matchedSnippet: clipSnippet(origLine),
        matchedLineNumber: lineNum,
        fromEmbedded,
      });
      continue;
    }

    if (/\b(?:unlinkSync|unlink|rmSync|rmdirSync|rmdir)\s*\(/.test(maskedLine)) {
      out.push({
        reason: CommandDangerReason.FileDelete,
        matchedSnippet: clipSnippet(origLine),
        matchedLineNumber: lineNum,
        fromEmbedded,
      });
    }

    if (/\bprocess\.kill\s*\(/.test(maskedLine)) {
      out.push({
        reason: CommandDangerReason.ProcessKill,
        matchedSnippet: clipSnippet(origLine),
        matchedLineNumber: lineNum,
        fromEmbedded,
      });
    }

    if (/\b(?:chownSync|chown|lchownSync|lchown)\s*\(/.test(maskedLine)) {
      out.push({
        reason: CommandDangerReason.PermissionChange,
        matchedSnippet: clipSnippet(origLine),
        matchedLineNumber: lineNum,
        fromEmbedded,
      });
    }

    if (/\b(?:chmodSync|chmod)\s*\(/.test(maskedLine)) {
      const origChmodMatch = /\b(?:chmodSync|chmod)\s*\(([^)]*)\)/.exec(origLine);
      let benign = false;
      if (origChmodMatch) {
        const argParts = origChmodMatch[1].split(',');
        if (argParts.length >= 2) {
          benign = isBenignOwnerOnlyCodeChmod(argParts[1], argParts[0]);
        }
      }
      if (!benign) {
        out.push({
          reason: CommandDangerReason.PermissionChange,
          matchedSnippet: clipSnippet(origLine),
          matchedLineNumber: lineNum,
          fromEmbedded,
        });
      }
    }
  }
}

function collectSegmentCandidates(
  segment: ShellSegment,
  baseLineOffset: number,
  fromEmbedded: boolean,
  out: DangerCandidate[],
): void {
  const lineNumber = baseLineOffset + segment.startLine - 1;
  const snippet = clipSnippet(segment.raw);

  // Check command substitutions inside arguments (e.g. `echo "$(rm -rf /tmp/x)"`)
  for (const sub of extractCommandSubstitutions(segment.raw)) {
    collectShellCandidates(sub, lineNumber, true, out);
  }

  const { commandName, args, hasPrivilegePrefix } = stripLeadingShellWrappers(segment.tokens);

  if (hasPrivilegePrefix) {
    out.push({
      reason: CommandDangerReason.PrivilegeEscalation,
      matchedSnippet: snippet,
      matchedLineNumber: lineNumber,
      fromEmbedded,
    });
  }

  if (!commandName) {
    return;
  }

  // Inline interpreter scripts (`python3 -c`, `node -e`, `sh -c`, `pwsh -Command`)
  if (isPythonInterpreter(commandName)) {
    const inlineToken = extractInlineFlagToken(args, new Set(['-c']));
    if (inlineToken) {
      scanPythonCode(inlineToken.value, baseLineOffset + inlineToken.startLine - 1, true, out);
    }
    return;
  }
  if (JS_INTERPRETERS.has(commandName)) {
    const inlineToken = extractInlineFlagToken(args, new Set(['-e', '--eval']));
    if (inlineToken) {
      scanJsCode(inlineToken.value, baseLineOffset + inlineToken.startLine - 1, true, out);
    }
    return;
  }
  if (SHELL_INTERPRETERS.has(commandName)) {
    const inlineToken = extractInlineFlagToken(args, new Set(['-c', '-command']));
    if (inlineToken) {
      collectShellCandidates(inlineToken.value, baseLineOffset + inlineToken.startLine - 1, true, out);
    }
    return;
  }

  // Delete commands (`rm`, `rmdir`, `Remove-Item`, `del`, `unlink`, ...)
  if (commandName === 'rm') {
    const isRecursive = args.some(
      (tok) => tok.value === '--recursive' || /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(tok.value),
    );
    out.push({
      reason: isRecursive ? CommandDangerReason.RecursiveDelete : CommandDangerReason.FileDelete,
      matchedSnippet: snippet,
      matchedLineNumber: lineNumber,
      fromEmbedded,
    });
    return;
  }
  if (commandName === 'remove-item') {
    const isRecursive = args.some((tok) => /^-r(?:ecurse)?$/i.test(tok.value));
    out.push({
      reason: isRecursive ? CommandDangerReason.RecursiveDelete : CommandDangerReason.FileDelete,
      matchedSnippet: snippet,
      matchedLineNumber: lineNumber,
      fromEmbedded,
    });
    return;
  }
  if (commandName === 'rmdir' || commandName === 'rd') {
    const isRecursive = args.some((tok) => /^\/s$/i.test(tok.value));
    out.push({
      reason: isRecursive ? CommandDangerReason.RecursiveDelete : CommandDangerReason.FileDelete,
      matchedSnippet: snippet,
      matchedLineNumber: lineNumber,
      fromEmbedded,
    });
    return;
  }
  if (DELETE_COMMAND_VERBS.has(commandName)) {
    out.push({
      reason: CommandDangerReason.FileDelete,
      matchedSnippet: snippet,
      matchedLineNumber: lineNumber,
      fromEmbedded,
    });
    return;
  }

  // Git commands (`git push`, `git push --force/-f`, `git reset --hard`, `git clean`)
  if (commandName === 'git') {
    const gitSub = findGitSubcommand(args);
    if (gitSub) {
      if (gitSub.subcommand === 'push') {
        const isForce = gitSub.subArgs.some((tok) => (
          tok.value === '-f'
          || tok.value === '--force'
          || tok.value.startsWith('--force-with-lease')
          || tok.value === '--force-if-includes'
        ));
        out.push({
          reason: isForce ? CommandDangerReason.GitForcePush : CommandDangerReason.GitPush,
          matchedSnippet: snippet,
          matchedLineNumber: lineNumber,
          fromEmbedded,
        });
      } else if (gitSub.subcommand === 'reset' && gitSub.subArgs.some((tok) => tok.value === '--hard')) {
        out.push({
          reason: CommandDangerReason.GitResetHard,
          matchedSnippet: snippet,
          matchedLineNumber: lineNumber,
          fromEmbedded,
        });
      } else if (gitSub.subcommand === 'clean') {
        out.push({
          reason: CommandDangerReason.FileDelete,
          matchedSnippet: snippet,
          matchedLineNumber: lineNumber,
          fromEmbedded,
        });
      }
    }
    return;
  }

  // Disk overwrite (`dd if=... of=...`)
  if (commandName === 'dd') {
    const hasDdOperand = args.some((tok) => (
      /^(?:if|of|bs|ibs|obs|count|seek|skip|conv|status)=/i.test(tok.value)
      || tok.value.startsWith('/dev/')
    ));
    if (hasDdOperand) {
      out.push({
        reason: CommandDangerReason.DiskOverwrite,
        matchedSnippet: snippet,
        matchedLineNumber: lineNumber,
        fromEmbedded,
      });
    }
    return;
  }

  // Disk format (`mkfs`, `mkfs.ext4`, ...)
  if (commandName === 'mkfs' || commandName.startsWith('mkfs.')) {
    out.push({
      reason: CommandDangerReason.DiskFormat,
      matchedSnippet: snippet,
      matchedLineNumber: lineNumber,
      fromEmbedded,
    });
    return;
  }

  // `find ... -delete` or `find ... -exec rm ...`
  if (commandName === 'find') {
    if (args.some((tok) => tok.value === '-delete')) {
      out.push({
        reason: CommandDangerReason.FileDelete,
        matchedSnippet: snippet,
        matchedLineNumber: lineNumber,
        fromEmbedded,
      });
      return;
    }
    for (let idx = 0; idx < args.length - 1; idx += 1) {
      if (args[idx].value === '-exec' || args[idx].value === '-execdir') {
        const execCmd = normalizeCommandName(args[idx + 1].value);
        if (DELETE_COMMAND_VERBS.has(execCmd)) {
          out.push({
            reason: CommandDangerReason.FileDelete,
            matchedSnippet: snippet,
            matchedLineNumber: lineNumber,
            fromEmbedded,
          });
          return;
        }
      }
    }
    return;
  }

  // `osascript ... delete`
  if (commandName === 'osascript' && /\bdelete\b/i.test(segment.raw)) {
    out.push({
      reason: CommandDangerReason.FileDelete,
      matchedSnippet: snippet,
      matchedLineNumber: lineNumber,
      fromEmbedded,
    });
    return;
  }

  // Process termination (`kill`, `killall`, `pkill`, `taskkill`, `stop-process`)
  if (KILL_COMMAND_VERBS.has(commandName)) {
    out.push({
      reason: CommandDangerReason.ProcessKill,
      matchedSnippet: snippet,
      matchedLineNumber: lineNumber,
      fromEmbedded,
    });
    return;
  }

  // File ownership / permissions (`chown`, `chgrp`, `chmod`, ...)
  if (OWNERSHIP_COMMAND_VERBS.has(commandName)) {
    out.push({
      reason: CommandDangerReason.PermissionChange,
      matchedSnippet: snippet,
      matchedLineNumber: lineNumber,
      fromEmbedded,
    });
    return;
  }
  if (commandName === 'chmod' && !isBenignOwnerOnlyShellChmod(args)) {
    out.push({
      reason: CommandDangerReason.PermissionChange,
      matchedSnippet: snippet,
      matchedLineNumber: lineNumber,
      fromEmbedded,
    });
  }
}

function collectShellCandidates(
  command: string,
  baseLineOffset: number,
  fromEmbedded: boolean,
  out: DangerCandidate[],
): ShellSegment[] {
  const { segments, heredocs } = parseShellScript(command);

  for (const segment of segments) {
    collectSegmentCandidates(segment, baseLineOffset, fromEmbedded, out);
  }

  for (const doc of heredocs) {
    const docStartLine = baseLineOffset + doc.bodyStartLine - 1;
    if (isPythonInterpreter(doc.ownerCommand)) {
      scanPythonCode(doc.body, docStartLine, true, out);
    } else if (JS_INTERPRETERS.has(doc.ownerCommand)) {
      scanJsCode(doc.body, docStartLine, true, out);
    } else if (SHELL_INTERPRETERS.has(doc.ownerCommand)) {
      collectShellCandidates(doc.body, docStartLine, true, out);
    }
    // Non-interpreter heredocs (e.g. `cat <<'EOF' > README.md`) are inert data.
  }

  return segments;
}

/**
 * Analyze a shell command (including multi-line scripts and embedded Python/Node
 * heredocs or `-c`/`-e` programs) and return its highest-severity danger level,
 * reason code, exact triggering snippet/line number, and whether the trigger is
 * embedded in a broader script or multi-step command.
 */
export function analyzeCommandDanger(command: string): CommandDangerAnalysis {
  if (!command || typeof command !== 'string' || !command.trim()) {
    return SAFE_ANALYSIS;
  }

  const candidates: DangerCandidate[] = [];
  const segments = collectShellCandidates(command, 1, false, candidates);
  const best = pickBestCandidate(candidates);
  if (!best) {
    return SAFE_ANALYSIS;
  }

  const substantiveSegmentCount = segments.filter(isSubstantiveSegment).length;
  const isEmbeddedInScript = best.fromEmbedded || substantiveSegmentCount >= 2;

  return {
    level: REASON_LEVEL[best.reason],
    reason: best.reason,
    matchedSnippet: best.matchedSnippet,
    matchedLineNumber: best.matchedLineNumber,
    isEmbeddedInScript,
  };
}

export function isDangerousCommand(command: string): boolean {
  return analyzeCommandDanger(command).level !== CommandDangerLevel.Safe;
}

export function isDeleteCommand(command: string): boolean {
  if (!command || typeof command !== 'string' || !command.trim()) {
    return false;
  }
  const candidates: DangerCandidate[] = [];
  collectShellCandidates(command, 1, false, candidates);
  return candidates.some(
    (c) => c.reason === CommandDangerReason.FileDelete || c.reason === CommandDangerReason.RecursiveDelete,
  );
}
