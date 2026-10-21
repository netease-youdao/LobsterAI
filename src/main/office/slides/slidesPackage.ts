import { OfficeFileError } from '../../../shared/office/core/officeFile';
import { SLIDES_PACKAGE_LIMITS, type SlidesPackageInfo, SlidesReadOnlyReason } from '../../../shared/office/slides/slidesFile';
import { OfficePackageException, packageRelationships, readOfficeZip } from '../core/officeZip';

const OFFICE_DOCUMENT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
/** A Strict Open XML presentation declares the Strict PresentationML namespace instead of the Transitional one. */
const STRICT_NAMESPACE = /\sxmlns(?::[^\s=/>]+)?\s*=\s*["']http:\/\/purl\.oclc\.org\/ooxml\/presentationml\/main["']/;
const PRESENTATION_CONTENT = /presentationml\.(presentation|slideshow|template)\.main\+xml|ms-powerpoint\.(presentation|slideshow|template)\.macroEnabled\.main\+xml/;
const MACRO_CONTENT = /macroEnabled\.main\+xml/;
/** A password to modify the file (PowerPoint's "Read-only recommended" with a password). */
const MODIFY_PASSWORD = /<(?:[^\s<>/=:]+:)?modifyVerifier\b/;

function fail(code: OfficeFileError, message: string): never {
  throw new OfficePackageException(code, message);
}

/**
 * Admission for in-place presentation editing. Malformed, encrypted and strict-OOXML packages
 * are refused. Macros, signatures and a password to modify open read only. The editor rewrites
 * only the slides it changes, so animations, media, charts and comments stay as they are.
 */
export function inspectSlidesPackage(bytes: Uint8Array): SlidesPackageInfo {
  const { names, xml } = readOfficeZip(bytes, SLIDES_PACKAGE_LIMITS);
  const types = xml.get('[Content_Types].xml');
  if (!types || !PRESENTATION_CONTENT.test(types)) fail(OfficeFileError.InvalidFile, 'Not a presentation package');
  const presentationPart = packageRelationships(xml.get('_rels/.rels'), '').find(relation => relation.type === OFFICE_DOCUMENT && !relation.external)?.target;
  const presentation = presentationPart ? xml.get(presentationPart) : undefined;
  if (!presentation) fail(OfficeFileError.InvalidFile, 'Missing presentation part');
  if (STRICT_NAMESPACE.test(presentation)) fail(OfficeFileError.Unsupported, 'Strict Open XML presentations are not supported');

  const readOnly = new Set<SlidesReadOnlyReason>();
  if (MACRO_CONTENT.test(types)) readOnly.add(SlidesReadOnlyReason.Macros);
  if (MODIFY_PASSWORD.test(presentation)) readOnly.add(SlidesReadOnlyReason.Protection);
  for (const name of names) {
    const lower = name.toLowerCase();
    if (lower.startsWith('_xmlsignatures/')) readOnly.add(SlidesReadOnlyReason.Signature);
    if (lower.endsWith('vbaproject.bin')) readOnly.add(SlidesReadOnlyReason.Macros);
  }
  return { readOnly: [...readOnly].sort() };
}
