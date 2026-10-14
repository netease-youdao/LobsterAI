import { OfficeEditorId } from '../core/officeEditor';
import { type OfficeFileBridge, officeFileChannels, type OfficePackageInfo, type OfficePackageLimits } from '../core/officeFile';

export const SlidesFileIpc = officeFileChannels(OfficeEditorId.Slides);

/**
 * Content the editor must not rewrite; such presentations open read only. Everything else it
 * does not understand (animations, media, charts, comments) is kept untouched.
 */
export const SlidesReadOnlyReason = {
  /** A password is required to modify the file in PowerPoint. */
  Protection: 'protection',
  Signature: 'signature',
  Macros: 'macros',
} as const;
export type SlidesReadOnlyReason = typeof SlidesReadOnlyReason[keyof typeof SlidesReadOnlyReason];

export type SlidesPackageInfo = OfficePackageInfo<SlidesReadOnlyReason>;

/** Decks carry pictures and video, so the limits are wider than for documents and workbooks. */
export const SLIDES_PACKAGE_LIMITS: OfficePackageLimits = {
  maxFileBytes: 80 * 1024 * 1024,
  maxExpandedBytes: 400 * 1024 * 1024,
  maxPartBytes: 150 * 1024 * 1024,
  maxParts: 10000,
};

export type SlidesFileBridge = OfficeFileBridge<SlidesPackageInfo>;
