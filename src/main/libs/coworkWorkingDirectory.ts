import fs from 'fs';
import os from 'os';
import path from 'path';

export const CoworkWorkingDirectoryIssue = {
  DriveRoot: 'drive_root',
  Missing: 'missing',
  NotDirectory: 'not_directory',
} as const;
export type CoworkWorkingDirectoryIssue =
  typeof CoworkWorkingDirectoryIssue[keyof typeof CoworkWorkingDirectoryIssue];

export type CoworkWorkingDirectoryProblem = {
  ok: false;
  issue: CoworkWorkingDirectoryIssue;
  directory: string;
};

export type CoworkWorkingDirectoryCheck =
  | { ok: true; directory: string }
  | CoworkWorkingDirectoryProblem;

export interface CoworkWorkingDirectoryCheckOptions {
  platform?: NodeJS.Platform;
  /**
   * App-managed folders that may be recreated when missing. A folder the user
   * picked is never created: on an unplugged drive that would fail (macOS
   * /Volumes is root-owned) or leave a stray folder where the drive mounts.
   */
  recreatableDirectories?: readonly string[];
}

const MISSING_PATH_ERROR_CODES = new Set(['ENOENT', 'ENOTDIR']);
const WINDOWS_DRIVE_ROOT_PATTERN = /^[a-zA-Z]:\\?$/;

export const getDefaultCoworkProjectDirectory = (): string =>
  path.join(os.homedir(), 'lobsterai', 'project');

const isMissingPathError = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && MISSING_PATH_ERROR_CODES.has(code);
};

const statIfPresent = (directory: string): fs.Stats | null => {
  try {
    return fs.statSync(directory);
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
};

export function checkCoworkWorkingDirectory(
  workingDirectory: string,
  options: CoworkWorkingDirectoryCheckOptions = {},
): CoworkWorkingDirectoryCheck {
  const platform = options.platform ?? process.platform;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const directory = pathApi.resolve(workingDirectory);
  // Drive roots fail mkdir with EPERM and OpenClaw rejects them as workspaces.
  if (platform === 'win32' && WINDOWS_DRIVE_ROOT_PATTERN.test(directory)) {
    return { ok: false, issue: CoworkWorkingDirectoryIssue.DriveRoot, directory };
  }

  let stats = statIfPresent(directory);
  if (!stats) {
    const comparable = (value: string) => (platform === 'win32' ? value.toLowerCase() : value);
    const recreatable = (options.recreatableDirectories ?? [])
      .some(candidate => comparable(pathApi.resolve(candidate)) === comparable(directory));
    if (!recreatable) {
      return { ok: false, issue: CoworkWorkingDirectoryIssue.Missing, directory };
    }
    fs.mkdirSync(directory, { recursive: true });
    stats = fs.statSync(directory);
  }
  if (!stats.isDirectory()) {
    return { ok: false, issue: CoworkWorkingDirectoryIssue.NotDirectory, directory };
  }
  return { ok: true, directory };
}
