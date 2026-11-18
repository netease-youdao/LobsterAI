import { OfficeEditorId } from '../core/officeEditor';
import {
  type OfficeFileBridge, officeFileChannels, type OfficePackageInfo, type OfficePackageLimits, type OfficeResult,
} from '../core/officeFile';
import type { WordDocumentFontDecl, WordFontResolveResult } from './wordFonts';

export const WordFileIpc = {
  ...officeFileChannels(OfficeEditorId.Word),
  ResolveFonts: 'artifact:word:resolve-fonts',
  ReadFont: 'artifact:word:read-font',
} as const;

/** Content the open core preserves but does not manage; such files open read only. */
export const WordReadOnlyReason = {
  Comments: 'comments',
  Revisions: 'revisions',
  Protection: 'protection',
  Embedded: 'embedded',
  Signature: 'signature',
  Macros: 'macros',
  ExternalContent: 'external-content',
} as const;
export type WordReadOnlyReason = typeof WordReadOnlyReason[keyof typeof WordReadOnlyReason];

/** What admission learned about a package besides its validity. */
export interface WordPackageInfo extends OfficePackageInfo<WordReadOnlyReason> {
  fonts: WordDocumentFontDecl[];
}

export const WORD_PACKAGE_LIMITS: OfficePackageLimits = {
  maxFileBytes: 25 * 1024 * 1024,
  maxExpandedBytes: 100 * 1024 * 1024,
  maxPartBytes: 25 * 1024 * 1024,
  maxParts: 4096,
};

/** Installed fonts, looked up by family name; bytes are fetched one face at a time. */
export interface WordFontApi {
  resolveFonts: (families: string[]) => Promise<OfficeResult<WordFontResolveResult>>;
  readFont: (faceId: string) => Promise<OfficeResult<Uint8Array>>;
}

export interface WordFileBridge extends OfficeFileBridge<WordPackageInfo>, WordFontApi {}
