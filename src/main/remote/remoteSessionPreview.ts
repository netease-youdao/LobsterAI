import { isRemoteExpertImageKey, RemoteExpertAvatar } from '../../shared/agent/avatar';

const SESSION_SUMMARY_BYTES = 8 * 1024;
// The server fills in the device ID. Reserving its maximum even after binding keeps a sealed revision stable.
const MAX_REMOTE_ID = 'x'.repeat(64);

export function fitExpertSessionPreview<T extends { sessionId?: string; preview: string; agent?: { icon: string | null } | null }>(summary: T): T {
  const icon = summary.agent?.icon;
  if (!icon || (icon !== RemoteExpertAvatar.Default && !isRemoteExpertImageKey(icon))) return summary;
  const preview = summary.preview.replace(/[\uD800-\uDBFF]$/u, '');
  const wire = { ...summary, preview, deviceId: MAX_REMOTE_ID, sessionId: summary.sessionId || MAX_REMOTE_ID };
  let excess = Buffer.byteLength(JSON.stringify(wire)) - SESSION_SUMMARY_BYTES;
  if (excess <= 0) return preview === summary.preview ? summary : { ...summary, preview };
  const points = Array.from(preview);
  while (excess > 0 && points.length) {
    // Exclude the two JSON string quotes: only this code point is removed from the preview.
    excess -= Buffer.byteLength(JSON.stringify(points.pop())) - 2;
  }
  return { ...summary, preview: points.join('') };
}
