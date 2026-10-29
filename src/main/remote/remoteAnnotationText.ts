import { BrowserAnnotationElementChangeProperty } from '../../shared/cowork/browserAnnotations';
import { ImageEditOperation } from '../../shared/imageEditing/types';
import { remoteAnnotationPropertyLabels, remoteAnnotationTranslations } from '../../shared/remote/annotationCopy';
import { getLanguage, type LanguageType } from '../i18n';

/** Local display policy only; the public text-block protocol is unchanged. */
export const RemoteAnnotationDisplayVersion = 1;
export const RemoteAnnotationTextLimits = { Bytes: 16 * 1024, Items: 20, Comment: 2000 } as const;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const entries = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

/** Reads user-authored comments/edits only. DOM, paths, URLs and screenshot identifiers stay local. */
export function buildRemoteAnnotationText(metadata: Record<string, unknown>, language: LanguageType = getLanguage()): string {
  const copy = remoteAnnotationTranslations[language], labels = remoteAnnotationPropertyLabels[language];
  const sections: string[] = [];
  let count = 0, truncated = false, visual = false;
  const clean = (value: unknown, limit: number = RemoteAnnotationTextLimits.Comment): string => {
    if (typeof value !== 'string') return '';
    if (value.length > limit) truncated = true;
    return value.slice(0, limit).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, '').replace(/[\uD800-\uDBFF]$/u, '').replace(/[\uD800-\uDFFF]/gu, '\uFFFD').trim();
  };
  const name = (value: unknown): string => {
    if (typeof value !== 'string') return copy.remoteAnnotationUnnamed;
    // Titles can themselves be paths/URLs. Keep at most a display basename, never a URL query or authority.
    let title = value.slice(0, 512).replace(/[\u0000-\u001f\u007f]/gu, '').trim().split(/[?#]/u)[0];
    if (/^[a-z][a-z0-9+.-]*:/iu.test(title) && !/^[a-z]:[\\/]/iu.test(title)) {
      if (!/^(?:https?|file):\/\//iu.test(title)) return copy.remoteAnnotationUnnamed;
      try { title = new URL(title).pathname; } catch { return copy.remoteAnnotationUnnamed; }
    }
    return clean(title.split(/[\\/]/u).at(-1), 128) || copy.remoteAnnotationUnnamed;
  };
  for (const raw of entries(metadata.browserAnnotations).slice(0, RemoteAnnotationTextLimits.Items)) {
    const batch = record(raw); if (!batch) continue;
    const lines: string[] = [];
    const annotations = entries(batch.annotations);
    if (annotations.length > RemoteAnnotationTextLimits.Items) truncated = true;
    for (const rawAnnotation of annotations.slice(0, RemoteAnnotationTextLimits.Items)) {
      if (count >= RemoteAnnotationTextLimits.Items) { truncated = true; break; }
      const annotation = record(rawAnnotation); if (!annotation) continue;
      const details: string[] = [];
      const comment = clean(annotation.comment); if (comment) details.push(comment);
      const edit = record(annotation.elementEdit), before = record(edit?.original), after = record(edit?.current);
      if (before && after) for (const property of Object.values(BrowserAnnotationElementChangeProperty)) {
        const original = before[property], current = after[property];
        if (original === current || ![original, current].every(value => value === undefined || typeof value === 'string' || typeof value === 'number' && Number.isFinite(value))) continue;
        const format = (value: unknown): string => clean(typeof value === 'number' ? String(value) : value,
          property === BrowserAnnotationElementChangeProperty.Text ? RemoteAnnotationTextLimits.Comment : 256) || copy.remoteAnnotationEmpty;
        details.push(`${labels[property]}: ${format(original)} → ${format(current)}`);
      }
      if (!details.length) continue;
      count++;
      lines.push(`${count}. ${details.join('\n')}`);
      visual ||= record(annotation.screenshot)?.status === 'ready';
    }
    if (lines.length) sections.push(`${copy.remoteAnnotationBrowser}（${name(batch.pageTitle || batch.pageUrl)}）\n${lines.join('\n')}`);
  }
  for (const raw of entries(metadata.imageEdits).slice(0, RemoteAnnotationTextLimits.Items)) {
    if (count >= RemoteAnnotationTextLimits.Items) { truncated = true; break; }
    const edit = record(raw); if (!edit || !Object.values(ImageEditOperation).includes(edit.operation as ImageEditOperation)) continue;
    const lines: string[] = [];
    if (entries(edit.regions).length > RemoteAnnotationTextLimits.Items) truncated = true;
    for (const rawRegion of entries(edit.regions).slice(0, RemoteAnnotationTextLimits.Items)) {
      if (count >= RemoteAnnotationTextLimits.Items) { truncated = true; break; }
      const text = clean(record(rawRegion)?.text); if (!text) continue;
      count++; lines.push(`${count}. ${text}`);
    }
    const instruction = clean(edit.instruction); if (instruction) lines.push(instruction);
    if (!lines.length && edit.operation !== ImageEditOperation.Markup && edit.operation !== ImageEditOperation.Comment) continue;
    if (!lines.length) count++;
    visual = true;
    sections.push(`${copy.remoteAnnotationImage}（${name(record(edit.source)?.title)}）\n${lines.join('\n')}`.trim());
  }
  if (!sections.length) return '';
  truncated ||= entries(metadata.browserAnnotations).length > RemoteAnnotationTextLimits.Items || entries(metadata.imageEdits).length > RemoteAnnotationTextLimits.Items;
  if (visual) sections.push(copy.remoteAnnotationVisual);
  let text = sections.join('\n\n');
  const suffix = `\n\n${copy.remoteAnnotationTruncated}`;
  if (Buffer.byteLength(text) > RemoteAnnotationTextLimits.Bytes - Buffer.byteLength(suffix)) {
    const bytes = Buffer.from(text);
    let end = RemoteAnnotationTextLimits.Bytes - Buffer.byteLength(suffix);
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
    text = bytes.subarray(0, end).toString('utf8').trimEnd(); truncated = true;
  }
  return text + (truncated ? suffix : '');
}
