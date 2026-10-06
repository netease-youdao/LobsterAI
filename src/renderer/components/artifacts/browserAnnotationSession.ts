import type { CoworkBrowserAnnotationBatch } from '@shared/cowork/browserAnnotations';

export function resolveRemovedActiveBrowserAnnotationBatch(
  previousBatch: CoworkBrowserAnnotationBatch | undefined,
  nextBatch: CoworkBrowserAnnotationBatch | undefined,
  isAnnotating: boolean,
): CoworkBrowserAnnotationBatch | undefined {
  if (!isAnnotating || !previousBatch || nextBatch) return undefined;
  return previousBatch;
}
