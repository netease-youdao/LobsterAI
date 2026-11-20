/**
 * Pure helpers for `@lobsterai/dsh-bundle` persona assembly and SKILL.md
 * frontmatter parsing. Zero DSH peer imports so Vitest can test them directly.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const DEFAULT_AGENT_ID = 'main';
export const MAX_PERSONA_FILE_BYTES = 128 * 1024;
export const MAX_INLINE_MEMORY_CHARS = 3_000;

const MEMORY_TRUNCATED_HINT = '\n\n（长期记忆较长，以上仅展示前段内容；如需检索完整历史记忆或每日笔记，请调用 `lobster_memory_search` / `lobster_memory_get`。）';

const MANAGED_BLOCK_RE = /<!--\s*LOBSTERAI_MANAGED_START\s*-->[\s\S]*?<!--\s*LOBSTERAI_MANAGED_END\s*-->\s*/g;
const MANAGED_AGENTS_MARKER = '<!-- LobsterAI managed:';
const OPENCLAW_MEMORY_PROMOTION_COMMENT_RE = /^[ \t]*<!--\s*openclaw-memory-promotion:[^>]*-->[ \t]*\r?\n?/gm;

// Matches OpenClaw's stock `# AGENTS.md - Your Workspace` template through its
// standard `## Make It Yours` closing block (plus optional OpenClaw doc links),
// while preserving any user-authored text outside that stock template.
const OPENCLAW_STOCK_AGENTS_RE = /^#\s+AGENTS\.md\s*-\s*Your Workspace\s*\n+This folder is home\.\s*Treat it that way\.[\s\S]*?^##\s+Make It Yours\s*\n+This is a starting point\.\s*Add your own conventions, style, and rules as you figure out what works\.(?:\s*\n+##\s+Related\s*\n+(?:-\s+\[[^\]]+\]\(\/(?:reference|concepts|automation|gateway)\/[^)]+\)\s*\n?)+)?\s*/m;

// Matches standalone OpenClaw stock `# TOOLS.md - Local Notes` placeholder file.
const OPENCLAW_STOCK_TOOLS_RE = /^#\s+TOOLS\.md\s*-\s*Local Notes\s*\n+Skills define _how_ tools work\.[\s\S]*?Add whatever helps you do your job\.\s*This is your cheat sheet\.\s*/m;

export const PERSONA_FILES = Object.freeze([
  { file: 'SOUL.md', heading: '角色设定' },
  { file: 'IDENTITY.md', heading: '身份信息' },
  { file: 'USER.md', heading: '用户信息' },
  { file: 'AGENTS.md', heading: '工作区指令', sanitize: 'agents' },
  { file: 'MEMORY.md', heading: '长期记忆', sanitize: 'memory' },
]);

/** Simple mtime-keyed file cache so synchronous prompt assembly stays fast. */
const fileCache = new Map();

export function readTextCached(filePath) {
  try {
    if (!existsSync(filePath)) return '';
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return '';
    const cached = fileCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.content;
    }
    const raw = readFileSync(filePath, 'utf8');
    const content = raw.length > MAX_PERSONA_FILE_BYTES
      ? `${raw.slice(0, MAX_PERSONA_FILE_BYTES)}\n...(已截断)`
      : raw;
    fileCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, content });
    return content;
  } catch {
    return '';
  }
}

export function sanitizeAgentId(agentId) {
  const raw = typeof agentId === 'string' ? agentId.trim() : '';
  if (!raw || !/^[a-zA-Z0-9_-]{1,64}$/.test(raw)) return DEFAULT_AGENT_ID;
  return raw;
}

/**
 * Strip legacy OpenClaw managed blocks and default workspace/tools boilerplate
 * from `AGENTS.md` while keeping any user-authored instructions intact.
 */
export function stripLegacyOpenClawAgentsBoilerplate(content) {
  if (typeof content !== 'string' || !content) return '';
  let text = content.replace(/\r\n/g, '\n').replace(MANAGED_BLOCK_RE, '');
  const markerIndex = text.indexOf(MANAGED_AGENTS_MARKER);
  if (markerIndex >= 0) {
    text = text.slice(0, markerIndex);
  }
  text = text.replace(OPENCLAW_STOCK_AGENTS_RE, '');
  text = text.replace(OPENCLAW_STOCK_TOOLS_RE, '');
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Remove legacy OpenClaw memory-promotion HTML comments from `MEMORY.md`
 * and enforce a bounded inline character budget so long-term memory cannot
 * bloat every turn's system prompt (full history remains searchable via
 * `lobster_memory_search` / `lobster_memory_get`).
 */
export function sanitizeMemoryMarkdownForPrompt(content, maxChars = MAX_INLINE_MEMORY_CHARS) {
  if (typeof content !== 'string' || !content) return '';
  const cleaned = content
    .replace(/\r\n/g, '\n')
    .replace(OPENCLAW_MEMORY_PROMOTION_COMMENT_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!cleaned || cleaned.length <= maxChars) return cleaned;
  const slice = cleaned.slice(0, maxChars);
  const lastNewline = slice.lastIndexOf('\n');
  const bounded = (lastNewline > Math.floor(maxChars * 0.6) ? slice.slice(0, lastNewline) : slice).trimEnd();
  return `${bounded}${MEMORY_TRUNCATED_HINT}`;
}

export function assembleWorkspacePersona(workspacesDir, agentId, customSystemPrompt) {
  const sections = [];
  if (workspacesDir) {
    const dir = resolve(workspacesDir, sanitizeAgentId(agentId));
    for (const item of PERSONA_FILES) {
      let text = readTextCached(join(dir, item.file));
      if (item.sanitize === 'agents' && text) {
        text = stripLegacyOpenClawAgentsBoilerplate(text);
      } else if (item.sanitize === 'memory' && text) {
        text = sanitizeMemoryMarkdownForPrompt(text);
      }
      const trimmed = text.trim();
      if (trimmed.length > 0) {
        sections.push(`## ${item.heading}\n\n${trimmed}`);
      }
    }
  }
  if (typeof customSystemPrompt === 'string' && customSystemPrompt.trim().length > 0) {
    sections.push(customSystemPrompt.trim());
  }
  return sections.join('\n\n');
}

/**
 * Parse YAML frontmatter header from a SKILL.md file (lightweight, zero-dep),
 * including YAML multiline block scalars (`|`, `>`, `|-`, `>-`, `|+`, `>+`)
 * and indented continuation lines.
 */
export function parseSkillFrontmatter(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: markdown };
  const [, yamlBlock, body] = match;
  const lines = yamlBlock.split(/\r?\n/);
  const meta = {};

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const kv = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let rawValue = kv[2].trim();

    if (/^[|>][+-]?$/.test(rawValue)) {
      const folded = rawValue.startsWith('>');
      const blockLines = [];
      let baseIndent = null;
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        if (next.trim().length === 0) {
          blockLines.push('');
          i += 1;
          continue;
        }
        const indentMatch = next.match(/^([ \t]+)/);
        if (!indentMatch) break;
        const indentLen = indentMatch[1].length;
        if (baseIndent === null) baseIndent = indentLen;
        if (indentLen < baseIndent) break;
        blockLines.push(next.slice(baseIndent));
        i += 1;
      }
      const joined = folded
        ? blockLines.join(' ').replace(/\s+/g, ' ').trim()
        : blockLines.join('\n').trim();
      meta[key] = joined;
      continue;
    }

    if (
      (rawValue.startsWith('"') && rawValue.endsWith('"') && rawValue.length >= 2)
      || (rawValue.startsWith("'") && rawValue.endsWith("'") && rawValue.length >= 2)
    ) {
      rawValue = rawValue.slice(1, -1);
    } else if (rawValue.length > 0) {
      // Collect plain indented continuation lines for multi-line scalars.
      const parts = [rawValue];
      while (i + 1 < lines.length && /^[ \t]+\S/.test(lines[i + 1])) {
        parts.push(lines[i + 1].trim());
        i += 1;
      }
      rawValue = parts.join(' ');
    }
    meta[key] = rawValue;
  }
  return { meta, body };
}
