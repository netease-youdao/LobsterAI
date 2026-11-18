import type { ImageEditMessageSnapshot, ImageEditRequest } from './types';

export function imageEditMessageSnapshot(request: ImageEditRequest): ImageEditMessageSnapshot {
  return {
    requestId: request.id,
    sourceVersionNumber: request.sourceVersionNumber,
    source: { ...request.source },
    operation: request.operation,
    regions: request.regions.map(region => ({ ...region })),
    instruction: request.instruction,
  };
}

export function imageEditMessageMetadata(refs?: ReadonlyArray<{ imageEdit?: ImageEditRequest }>): {
  imageEdits?: ImageEditMessageSnapshot[];
} {
  const requests = new Map<string, ImageEditRequest>();
  for (const ref of refs ?? []) if (ref.imageEdit) requests.set(ref.imageEdit.id, ref.imageEdit);
  return requests.size ? { imageEdits: [...requests.values()].map(imageEditMessageSnapshot) } : {};
}
