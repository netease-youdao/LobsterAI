import JSZip from 'jszip';
import { describe, expect, test } from 'vitest';

import { makeSlidesFixture, SLIDES_FIXTURE_PARTS as PARTS } from '../../../../tests/fixtures/slides';
import { OfficeFileError } from '../../../shared/office/core/officeFile';
import { SlidesReadOnlyReason } from '../../../shared/office/slides/slidesFile';
import type { OfficePackageException } from '../core/officeZip';
import { inspectSlidesPackage } from './slidesPackage';

const codeOf = (operation: () => unknown) => {
  try { operation(); } catch (error) { return (error as OfficePackageException).code; }
  return undefined;
};

describe('presentation admission', () => {
  test('a plain presentation is editable, animations, notes and media included', async () => {
    expect(inspectSlidesPackage(await makeSlidesFixture())).toEqual({ readOnly: [] });
  });

  test('opens macros, signatures and a password to modify read only', async () => {
    expect(inspectSlidesPackage(await makeSlidesFixture({ 'ppt/vbaProject.bin': 'macro' })).readOnly).toEqual([SlidesReadOnlyReason.Macros]);
    expect(inspectSlidesPackage(await makeSlidesFixture({ '_xmlsignatures/sig1.xml': '<Signature/>' })).readOnly).toEqual([SlidesReadOnlyReason.Signature]);
    const zip = await JSZip.loadAsync(await makeSlidesFixture());
    const presentation = await zip.file(PARTS.presentation)!.async('string');
    const protectedDeck = await makeSlidesFixture({
      [PARTS.presentation]: presentation.replace('<p:defaultTextStyle>', '<p:modifyVerifier cryptProviderType="rsaAES" cryptAlgorithmClass="hash" cryptAlgorithmType="typeAny" cryptAlgorithmSid="14" spinCount="100000" saltData="AAAA" hashData="AAAA"/><p:defaultTextStyle>'),
    });
    expect(inspectSlidesPackage(protectedDeck).readOnly).toEqual([SlidesReadOnlyReason.Protection]);
  });

  test('refuses malformed, encrypted, strict and non-presentation packages', async () => {
    expect(codeOf(() => inspectSlidesPackage(new TextEncoder().encode('not a zip')))).toBe(OfficeFileError.InvalidFile);
    const encrypted = new Uint8Array(512);
    encrypted.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(codeOf(() => inspectSlidesPackage(encrypted))).toBe(OfficeFileError.Unsupported);
    const zip = await JSZip.loadAsync(await makeSlidesFixture());
    const presentation = await zip.file(PARTS.presentation)!.async('string');
    const strict = await makeSlidesFixture({ [PARTS.presentation]: presentation.replace('http://schemas.openxmlformats.org/presentationml/2006/main', 'http://purl.oclc.org/ooxml/presentationml/main') });
    expect(codeOf(() => inspectSlidesPackage(strict))).toBe(OfficeFileError.Unsupported);
    const defaultNamespaceStrict = await makeSlidesFixture({ [PARTS.presentation]: '<?xml version="1.0"?><presentation xmlns="http://purl.oclc.org/ooxml/presentationml/main"/>' });
    expect(codeOf(() => inspectSlidesPackage(defaultNamespaceStrict))).toBe(OfficeFileError.Unsupported);
    const notDeck = await makeSlidesFixture({ [PARTS.contentTypes]: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' });
    expect(codeOf(() => inspectSlidesPackage(notDeck))).toBe(OfficeFileError.InvalidFile);
    const noPresentation = await makeSlidesFixture({ [PARTS.presentation]: undefined });
    expect(codeOf(() => inspectSlidesPackage(noPresentation))).toBe(OfficeFileError.InvalidFile);
  });
});
