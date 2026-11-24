import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import type { ProbeGitWorkspaceResponse } from '../../../shared/artifactPreview/blankDocument';

const execFileAsync = promisify(execFile);
const GIT_PROBE_TIMEOUT_MS = 2500;

export const EMPTY_GIT_PROBE: ProbeGitWorkspaceResponse = {
  isGitRepository: false,
  changedFileCount: 0,
  branch: null,
};

function countPorcelainEntries(stdout: string): number {
  const fields = stdout.split('\0');
  let count = 0;
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (!field) continue;
    const status = field.slice(0, 2);
    count += 1;
    if (status.includes('R') || status.includes('C')) index += 1;
  }
  return count;
}

export async function probeGitWorkspaceDirectory(cwd: string): Promise<ProbeGitWorkspaceResponse> {
  const target = cwd.trim();
  if (!target || !path.isAbsolute(target)) return EMPTY_GIT_PROBE;
  const runGit = async (...args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync(
      'git',
      ['--no-optional-locks', '-C', target, ...args],
      {
        timeout: GIT_PROBE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' },
      },
    );
    return stdout;
  };
  try {
    if ((await runGit('rev-parse', '--is-inside-work-tree')).trim() !== 'true') {
      return EMPTY_GIT_PROBE;
    }
    const [branchRaw, statusRaw] = await Promise.all([
      runGit('rev-parse', '--abbrev-ref', 'HEAD')
        .catch(() => runGit('symbolic-ref', '--short', 'HEAD'))
        .catch(() => ''),
      runGit('status', '--porcelain=v1', '-z', '--untracked-files=all', '--find-renames').catch(() => ''),
    ]);
    return {
      isGitRepository: true,
      changedFileCount: countPorcelainEntries(statusRaw),
      branch: branchRaw.trim() || null,
    };
  } catch {
    return EMPTY_GIT_PROBE;
  }
}
