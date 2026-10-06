import type { ShareDeploymentPersistenceBinding } from './constants';

const PERSISTENCE_PATH_FIELDS = ['appPath', 'dataPath'] as const;

export type ShareDeploymentPersistencePathField =
  (typeof PERSISTENCE_PATH_FIELDS)[number];

export interface ShareDeploymentPersistencePathConflict {
  firstBindingIndex: number;
  firstField: ShareDeploymentPersistencePathField;
  firstPath: string;
  secondBindingIndex: number;
  secondField: ShareDeploymentPersistencePathField;
  secondPath: string;
}

export function findShareDeploymentPersistencePathConflict(
  bindings: ShareDeploymentPersistenceBinding[],
): ShareDeploymentPersistencePathConflict | null {
  for (let firstBindingIndex = 0; firstBindingIndex < bindings.length - 1; firstBindingIndex += 1) {
    const firstBinding = bindings[firstBindingIndex];
    for (let secondBindingIndex = firstBindingIndex + 1; secondBindingIndex < bindings.length; secondBindingIndex += 1) {
      const secondBinding = bindings[secondBindingIndex];
      for (const firstField of PERSISTENCE_PATH_FIELDS) {
        for (const secondField of PERSISTENCE_PATH_FIELDS) {
          const firstPath = firstBinding[firstField];
          const secondPath = secondBinding[secondField];
          if (persistencePathsOverlap(firstPath, secondPath)) {
            return {
              firstBindingIndex,
              firstField,
              firstPath,
              secondBindingIndex,
              secondField,
              secondPath,
            };
          }
        }
      }
    }
  }
  return null;
}

function persistencePathsOverlap(firstPath: string, secondPath: string): boolean {
  const first = normalizePersistencePathForComparison(firstPath);
  const second = normalizePersistencePathForComparison(secondPath);
  if (!first || !second) return false;
  return (
    first === second ||
    first.startsWith(`${second}/`) ||
    second.startsWith(`${first}/`)
  );
}

function normalizePersistencePathForComparison(value: string): string {
  if (!value || value.includes('\0')) return '';
  const segments: string[] = [];
  for (const segment of value.trim().replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return '';
      segments.pop();
      continue;
    }
    segments.push(segment.toLowerCase());
  }
  return segments.join('/');
}
