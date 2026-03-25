import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test } from 'vitest';
import { computeSkillFingerprint, decideSkillInstall, resolveSkillConflictDecision } from './skillInstallIdentity';

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (!root) continue;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-skill-identity-'));
  tempRoots.push(root);
  return root;
}

function createSkillDir(root: string, dirName: string, files: Record<string, string>): string {
  const skillDir = path.join(root, dirName);
  fs.mkdirSync(skillDir, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(skillDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }
  return skillDir;
}

test('computeSkillFingerprint: identical skill content in different temp roots yields the same fingerprint', () => {
  const rootA = createTempRoot();
  const rootB = createTempRoot();
  const files = {
    'SKILL.md': '---\nname: demo\ndescription: Demo skill\n---\n# Demo\n',
    'scripts/run.js': 'console.log("demo");\n',
  };

  const skillA = createSkillDir(rootA, 'demo-skill', files);
  const skillB = createSkillDir(rootB, 'demo-skill-copy', files);

  expect(computeSkillFingerprint(skillA)).toBe(computeSkillFingerprint(skillB));
});

test('computeSkillFingerprint: managed file changes update the fingerprint', () => {
  const root = createTempRoot();
  const skillA = createSkillDir(root, 'demo-a', {
    'SKILL.md': '---\nname: demo\ndescription: Demo skill\n---\n# Demo\n',
    'scripts/run.js': 'console.log("demo");\n',
  });
  const skillB = createSkillDir(root, 'demo-b', {
    'SKILL.md': '---\nname: demo\ndescription: Demo skill\n---\n# Demo v2\n',
    'scripts/run.js': 'console.log("demo");\n',
  });

  expect(computeSkillFingerprint(skillA)).not.toBe(computeSkillFingerprint(skillB));
});

test('computeSkillFingerprint: ignored runtime files do not affect the fingerprint', () => {
  const root = createTempRoot();
  const files = {
    'SKILL.md': '---\nname: demo\ndescription: Demo skill\n---\n# Demo\n',
    'scripts/run.js': 'console.log("demo");\n',
  };

  const skillA = createSkillDir(root, 'demo-a', files);
  const skillB = createSkillDir(root, 'demo-b', {
    ...files,
    '.env': 'API_KEY=secret\n',
    '.DS_Store': 'ignored\n',
    'node_modules/pkg/index.js': 'module.exports = "ignored";\n',
    '.git/HEAD': 'ref: refs/heads/main\n',
  });

  expect(computeSkillFingerprint(skillA)).toBe(computeSkillFingerprint(skillB));
});

test('decideSkillInstall: identical writable skill content overwrites the existing install and keeps the id', () => {
  const installRoot = createTempRoot();
  const sourceRoot = createTempRoot();
  const installedDir = createSkillDir(installRoot, 'demo-skill', {
    'SKILL.md': '---\nname: demo\ndescription: Demo skill\n---\n# Demo\n',
    'scripts/run.js': 'console.log("demo");\n',
    '.env': 'API_KEY=secret\n',
  });
  const candidateDir = createSkillDir(sourceRoot, 'demo-skill-upload', {
    'SKILL.md': '---\nname: demo\ndescription: Demo skill\n---\n# Demo\n',
    'scripts/run.js': 'console.log("demo");\n',
  });

  const decision = decideSkillInstall({
    candidateDir,
    desiredId: 'demo-skill',
    installRoot,
    installedSkills: [
      { id: 'demo-skill', dir: installedDir, writable: true },
    ],
  });

  expect(decision.action).toBe('overwrite');
  expect(decision.targetId).toBe('demo-skill');
  expect(decision.targetDir).toBe(installedDir);
});

test('decideSkillInstall: identical read-only skill content is treated as a no-op', () => {
  const installRoot = createTempRoot();
  const bundledRoot = createTempRoot();
  const candidateRoot = createTempRoot();
  const bundledDir = createSkillDir(bundledRoot, 'demo-skill', {
    'SKILL.md': '---\nname: demo\ndescription: Demo skill\n---\n# Demo\n',
    'scripts/run.js': 'console.log("demo");\n',
  });
  const candidateDir = createSkillDir(candidateRoot, 'demo-skill-upload', {
    'SKILL.md': '---\nname: demo\ndescription: Demo skill\n---\n# Demo\n',
    'scripts/run.js': 'console.log("demo");\n',
  });

  const decision = decideSkillInstall({
    candidateDir,
    desiredId: 'demo-skill',
    installRoot,
    installedSkills: [
      { id: 'demo-skill', dir: bundledDir, writable: false },
    ],
  });

  expect(decision.action).toBe('skip');
  expect(decision.reason).toBe('readonly-duplicate');
});

test('decideSkillInstall: same name but different content enters conflict resolution', () => {
  const installRoot = createTempRoot();
  const candidateRoot = createTempRoot();
  const existingDir = createSkillDir(installRoot, 'demo-skill', {
    'SKILL.md': '---\nname: demo\ndescription: Demo skill\n---\n# Demo\n',
    'scripts/run.js': 'console.log("demo");\n',
  });
  const candidateDir = createSkillDir(candidateRoot, 'demo-skill-upload', {
    'SKILL.md': '---\nname: demo\ndescription: Demo skill\n---\n# Demo 2\n',
    'scripts/run.js': 'console.log("demo");\n',
  });

  const decision = decideSkillInstall({
    candidateDir,
    desiredId: 'demo-skill',
    installRoot,
    installedSkills: [
      { id: 'demo-skill', dir: path.join(installRoot, 'demo-skill'), writable: true },
    ],
  });

  expect(decision.action).toBe('conflict');
  expect(decision.existingId).toBe('demo-skill');
  expect(decision.existingDir).toBe(existingDir);
});

test('resolveSkillConflictDecision: keepBoth installs under the next available id', () => {
  const installRoot = createTempRoot();
  const existingDir = createSkillDir(installRoot, 'demo-skill', {
    'SKILL.md': '---\nname: demo\ndescription: Demo skill\n---\n# Demo\n',
  });
  const conflictDecision = {
    action: 'conflict' as const,
    fingerprint: 'abc',
    desiredId: 'demo-skill',
    existingId: 'demo-skill',
    existingDir,
    existingWritable: true,
  };

  const resolved = resolveSkillConflictDecision(conflictDecision, 'keepBoth', installRoot);

  expect(resolved.action).toBe('install');
  expect(resolved.targetId).toBe('demo-skill-1');
  expect(resolved.targetDir).toBe(path.join(installRoot, 'demo-skill-1'));
});

test('resolveSkillConflictDecision: replaceExisting overwrites the current writable install', () => {
  const installRoot = createTempRoot();
  const existingDir = createSkillDir(installRoot, 'demo-skill', {
    'SKILL.md': '---\nname: demo\ndescription: Demo skill\n---\n# Demo\n',
  });
  const conflictDecision = {
    action: 'conflict' as const,
    fingerprint: 'abc',
    desiredId: 'demo-skill',
    existingId: 'demo-skill',
    existingDir,
    existingWritable: true,
  };

  const resolved = resolveSkillConflictDecision(conflictDecision, 'replaceExisting', installRoot);

  expect(resolved.action).toBe('overwrite');
  expect(resolved.targetId).toBe('demo-skill');
  expect(resolved.targetDir).toBe(existingDir);
});

test('resolveSkillConflictDecision: replaceExisting shadows a read-only skill from the writable root', () => {
  const installRoot = createTempRoot();
  const bundledRoot = createTempRoot();
  const existingDir = createSkillDir(bundledRoot, 'demo-skill', {
    'SKILL.md': '---\nname: demo\ndescription: Demo skill\n---\n# Demo\n',
  });
  const conflictDecision = {
    action: 'conflict' as const,
    fingerprint: 'abc',
    desiredId: 'demo-skill',
    existingId: 'demo-skill',
    existingDir,
    existingWritable: false,
  };

  const resolved = resolveSkillConflictDecision(conflictDecision, 'replaceExisting', installRoot);

  expect(resolved.action).toBe('install');
  expect(resolved.targetId).toBe('demo-skill');
  expect(resolved.targetDir).toBe(path.join(installRoot, 'demo-skill'));
});

test('decideSkillInstall: importing an already installed directory is a no-op', () => {
  const installRoot = createTempRoot();
  const installedDir = createSkillDir(installRoot, 'demo-skill', {
    'SKILL.md': '---\nname: demo\ndescription: Demo skill\n---\n# Demo\n',
    'scripts/run.js': 'console.log("demo");\n',
  });

  const decision = decideSkillInstall({
    candidateDir: installedDir,
    desiredId: 'demo-skill',
    installRoot,
    installedSkills: [
      { id: 'demo-skill', dir: installedDir, writable: true },
    ],
  });

  expect(decision.action).toBe('skip');
  expect(decision.reason).toBe('same-directory');
});
