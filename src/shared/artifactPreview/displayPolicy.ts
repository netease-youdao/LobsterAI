import { getLibraryArtifactTypeForExtension, LibraryArtifactType } from '../library/constants';

/** Conversation cards omit source files even though the library can preview them. */
export const PREVIEWABLE_ARTIFACT_TYPES = new Set<LibraryArtifactType | 'local-service'>([
  LibraryArtifactType.Html,
  LibraryArtifactType.Svg,
  LibraryArtifactType.Mermaid,
  LibraryArtifactType.Image,
  LibraryArtifactType.Video,
  LibraryArtifactType.Markdown,
  LibraryArtifactType.Text,
  LibraryArtifactType.Document,
  'local-service',
]);

export function isConversationArtifactFileName(name: string): boolean {
  const fileName = name.trim().split(/[\\/]/u).pop() || '';
  const extensionStart = fileName.lastIndexOf('.');
  if (extensionStart < 0) return false;
  const type = getLibraryArtifactTypeForExtension(fileName.slice(extensionStart));
  return type !== null && PREVIEWABLE_ARTIFACT_TYPES.has(type);
}
