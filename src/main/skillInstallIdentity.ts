import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const IGNORED_ENTRY_NAMES = new Set([
  '.DS_Store',
  '.env',
  '.git',
  'node_modules',
]);

export type InstalledSkillInstallTarget = {
  id: string;
  dir: string;
  writable: boolean;
  fingerprint?: string;
};

type BaseSkillInstallDecision = {
  fingerprint: string;
};

export type SkillInstallDecision =
  | (BaseSkillInstallDecision & {
    action: 'install';
    targetId: string;
    targetDir: string;
  })
  | (BaseSkillInstallDecision & {
    action: 'conflict';
    desiredId: string;
    existingId: string;
    existingDir: string;
    existingWritable: boolean;
  })
  | (BaseSkillInstallDecision & {
    action: 'overwrite';
    targetId: string;
    targetDir: string;
  })
  | (BaseSkillInstallDecision & {
    action: 'skip';
    reason: 'readonly-duplicate' | 'same-directory';
  });

function shouldIgnoreEntry(relativePath: string): boolean {
  if (!relativePath) return false;
  return relativePath.split(path.sep).some(segment => IGNORED_ENTRY_NAMES.has(segment));
}

function collectManagedEntries(root: string): string[] {
  const managedEntries: string[] = [];
  const queue: string[] = [''];

  while (queue.length > 0) {
    const currentRelative = queue.shift();
    if (currentRelative === undefined) continue;

    const currentPath = currentRelative ? path.join(root, currentRelative) : root;
    const entries = fs.readdirSync(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const relativePath = currentRelative
        ? path.join(currentRelative, entry.name)
        : entry.name;

      if (shouldIgnoreEntry(relativePath)) {
        continue;
      }

      if (entry.isDirectory()) {
        queue.push(relativePath);
        continue;
      }

      managedEntries.push(relativePath);
    }
  }

  managedEntries.sort((a, b) => a.localeCompare(b));
  return managedEntries;
}

export function computeSkillFingerprint(skillDir: string): string {
  const hash = crypto.createHash('sha256');
  const resolvedDir = path.resolve(skillDir);
  const entries = collectManagedEntries(resolvedDir);

  for (const relativePath of entries) {
    const absolutePath = path.join(resolvedDir, relativePath);
    const stat = fs.lstatSync(absolutePath);
    hash.update(`path:${relativePath}\n`);

    if (stat.isSymbolicLink()) {
      hash.update(`symlink:${fs.readlinkSync(absolutePath)}\n`);
      continue;
    }

    hash.update(fs.readFileSync(absolutePath));
    hash.update('\n');
  }

  return hash.digest('hex');
}

function resolveUniqueTargetId(installRoot: string, desiredId: string): { targetId: string; targetDir: string } {
  let targetId = desiredId;
  let targetDir = path.join(installRoot, targetId);
  let suffix = 1;

  while (fs.existsSync(targetDir)) {
    targetId = `${desiredId}-${suffix}`;
    targetDir = path.join(installRoot, targetId);
    suffix += 1;
  }

  return { targetId, targetDir };
}

export function decideSkillInstall(options: {
  candidateDir: string;
  desiredId: string;
  installRoot: string;
  installedSkills: InstalledSkillInstallTarget[];
}): SkillInstallDecision {
  const candidateDir = path.resolve(options.candidateDir);
  const fingerprint = computeSkillFingerprint(candidateDir);

  let writableDuplicate: InstalledSkillInstallTarget | null = null;
  let readonlyDuplicate: InstalledSkillInstallTarget | null = null;
  let sameNameConflict: InstalledSkillInstallTarget | null = null;

  for (const installedSkill of options.installedSkills) {
    const installedDir = path.resolve(installedSkill.dir);
    if (installedDir === candidateDir) {
      return {
        action: 'skip',
        fingerprint,
        reason: 'same-directory',
      };
    }

    if (installedSkill.id === options.desiredId && !sameNameConflict) {
      sameNameConflict = installedSkill;
    }

    const installedFingerprint = installedSkill.fingerprint ?? computeSkillFingerprint(installedSkill.dir);
    if (installedFingerprint !== fingerprint) {
      continue;
    }

    if (installedSkill.writable) {
      writableDuplicate = installedSkill;
      break;
    }

    if (!readonlyDuplicate) {
      readonlyDuplicate = installedSkill;
    }
  }

  if (writableDuplicate) {
    return {
      action: 'overwrite',
      fingerprint,
      targetId: writableDuplicate.id,
      targetDir: path.resolve(writableDuplicate.dir),
    };
  }

  if (readonlyDuplicate) {
    return {
      action: 'skip',
      fingerprint,
      reason: 'readonly-duplicate',
    };
  }

  if (sameNameConflict) {
    return {
      action: 'conflict',
      fingerprint,
      desiredId: options.desiredId,
      existingId: sameNameConflict.id,
      existingDir: path.resolve(sameNameConflict.dir),
      existingWritable: sameNameConflict.writable,
    };
  }

  const { targetId, targetDir } = resolveUniqueTargetId(
    path.resolve(options.installRoot),
    options.desiredId
  );

  return {
    action: 'install',
    fingerprint,
    targetId,
    targetDir,
  };
}

export function resolveSkillConflictDecision(
  decision: Extract<SkillInstallDecision, { action: 'conflict' }>,
  action: 'keepBoth' | 'replaceExisting',
  installRoot: string
): Extract<SkillInstallDecision, { action: 'install' | 'overwrite' }> {
  if (action === 'keepBoth') {
    const { targetId, targetDir } = resolveUniqueTargetId(path.resolve(installRoot), decision.desiredId);
    return {
      action: 'install',
      fingerprint: decision.fingerprint,
      targetId,
      targetDir,
    };
  }

  if (decision.existingWritable) {
    return {
      action: 'overwrite',
      fingerprint: decision.fingerprint,
      targetId: decision.existingId,
      targetDir: decision.existingDir,
    };
  }

  const overrideTargetDir = path.join(path.resolve(installRoot), decision.desiredId);
  return {
    action: fs.existsSync(overrideTargetDir) ? 'overwrite' : 'install',
    fingerprint: decision.fingerprint,
    targetId: decision.desiredId,
    targetDir: overrideTargetDir,
  };
}
