import fs from 'fs';
import path from 'path';

/**
 * Persona files of a non-main agent's OpenClaw workspace.
 *
 * Once these files exist they are the source of truth: OpenClaw injects them
 * into every run and the agent may edit them itself. The `agents.system_prompt`
 * and `agents.identity` columns only seed a missing file and keep a snapshot of
 * the last explicit save, so background config sync must never overwrite them.
 */
export const AgentPersonaFile = {
  Soul: 'SOUL.md',
  Identity: 'IDENTITY.md',
} as const;
export type AgentPersonaFile = typeof AgentPersonaFile[keyof typeof AgentPersonaFile];

export interface AgentPersona {
  systemPrompt?: string;
  identity?: string;
}

const formatPersonaFileContent = (value: string | undefined): string => {
  const trimmed = (value || '').trim();
  return trimmed ? `${trimmed}\n` : '';
};

const listPersonaFiles = (persona: AgentPersona): Array<[AgentPersonaFile, string | undefined]> => [
  [AgentPersonaFile.Soul, persona.systemPrompt],
  [AgentPersonaFile.Identity, persona.identity],
];

/**
 * Create the persona files that do not exist yet from the stored values.
 * Existing files, including empty ones, are left untouched.
 * Returns the names of the files that were created.
 */
export function seedAgentPersonaFiles(workspaceDir: string, persona: AgentPersona): AgentPersonaFile[] {
  fs.mkdirSync(workspaceDir, { recursive: true });
  const created: AgentPersonaFile[] = [];
  for (const [filename, value] of listPersonaFiles(persona)) {
    try {
      // `wx` fails on an existing file, so a concurrent agent write is never replaced.
      fs.writeFileSync(path.join(workspaceDir, filename), formatPersonaFileContent(value), {
        encoding: 'utf8',
        flag: 'wx',
      });
      created.push(filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
    }
  }
  return created;
}

/**
 * Overwrite persona files with explicitly set values, e.g. when an agent is
 * created or an enterprise package changes its persona. Undefined fields are
 * left as they are on disk.
 */
export function writeAgentPersonaFiles(workspaceDir: string, persona: AgentPersona): void {
  fs.mkdirSync(workspaceDir, { recursive: true });
  for (const [filename, value] of listPersonaFiles(persona)) {
    if (value === undefined) continue;
    const filePath = path.join(workspaceDir, filename);
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, formatPersonaFileContent(value), 'utf8');
    fs.renameSync(tmpPath, filePath);
  }
}

/**
 * Persona fields of `next` that must be written to disk. A new agent (no
 * `previous`) writes both files so a workspace left behind by a deleted agent
 * with the same ID does not leak into it; an existing agent writes only the
 * fields whose stored value changed.
 */
export function pickChangedAgentPersona(previous: AgentPersona | null, next: AgentPersona): AgentPersona {
  if (!previous) {
    return { systemPrompt: next.systemPrompt ?? '', identity: next.identity ?? '' };
  }
  const changed: AgentPersona = {};
  if (next.systemPrompt !== undefined && next.systemPrompt !== previous.systemPrompt) {
    changed.systemPrompt = next.systemPrompt;
  }
  if (next.identity !== undefined && next.identity !== previous.identity) {
    changed.identity = next.identity;
  }
  return changed;
}
