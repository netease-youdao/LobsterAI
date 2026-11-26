/** File bodies use authenticated HTTP; these capabilities never imply public URLs. */
export const RemoteFileCapability = { Sync: 'file_sync_v1', Versions: 'artifact_versions_v1' } as const;
export const RemoteFileState = { Pending: 'pending', Blocked: 'blocked', Failed: 'failed', Ready: 'ready' } as const;
export const RemoteFileReason = {
  Type: 'FILE_TYPE_NOT_ALLOWED', Size: 'FILE_TOO_LARGE', Source: 'FILE_SOURCE_CHANGED', Access: 'FILE_ACCESS_DENIED',
  Final: 'FINAL_SNAPSHOT_UNAVAILABLE', Policy: 'FILE_POLICY_CHANGED', Transfer: 'FILE_TRANSFER_BUSY',
} as const;
export interface RemoteFilePolicy {
  policyVersion: string;
  features: { inputUpload: boolean; desktopInputSync: boolean; artifactPublish: boolean; artifactDownload: boolean };
  types: Array<{ category: string; extensions: string[]; maxFileBytes: string; inputAllowed: boolean; artifactAutoSync: boolean }>;
  limits: { partBytes: string; maxInputCount: number; maxInputBytes: string; maxImageBytes: string;
    maxTaskArtifactCount: number; maxTaskArtifactBytes: string };
}
export interface RemoteArtifactManifest {
  artifactId: string; sessionId: string; name: string; revision: string; availability: string;
  latestVersion: string; lastCaptureSequence: string; pendingArtifactVersion: string | null;
  latest: { artifactVersion: string; assetId: string; assetVersion: string; fileName?: string; mimeType: string; sizeBytes: string; sha256: string } | null;
}
export function remoteFileLocalLimit(fileName: string, output: boolean): number | null {
  const extension = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '';
  const groups: Array<[string, number]> = [
    ['md txt csv json yaml yml xml js jsx ts tsx py java c cpp h hpp go rs sh sql css', 5],
    ['png jpg jpeg webp gif', 10], ['pdf docx xlsx pptx', 30],
    ...(!output ? [['mp3 wav m4a', 20], ['mp4 mov webm', 50]] as Array<[string, number]> : []),
  ];
  const limit = groups.find(([extensions]) => extensions.split(' ').includes(extension));
  return limit ? limit[1] * 1024 * 1024 : null;
}
export function remoteFileRule(policy: RemoteFilePolicy, fileName: string, sizeBytes: string, output: boolean): string | null {
  const extension = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : '';
  // The server list may tighten local policy; unknown categories/formats stay denied.
  const localLimit = remoteFileLocalLimit(fileName, output);
  const rule = policy.types.find(item => item.extensions.includes(extension) && (output ? item.artifactAutoSync : item.inputAllowed));
  if (!localLimit || !rule) return RemoteFileReason.Type;
  if (!/^\d+$/u.test(sizeBytes) || !/^\d+$/u.test(rule.maxFileBytes) || BigInt(sizeBytes) < 1n
    || BigInt(sizeBytes) > BigInt(rule.maxFileBytes) || BigInt(sizeBytes) > BigInt(localLimit)) return RemoteFileReason.Size;
  return null;
}
