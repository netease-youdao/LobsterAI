import { unzipSync } from 'fflate';
import { describe, expect, test } from 'vitest';

import { makeSlidesFixture, nodeXmlCodec, SLIDES_FIXTURE_PARTS } from '../../../../../tests/fixtures/slides';
import { inspectSlidesPackage } from '../../../../main/office/slides/slidesPackage';
import { relativeTarget, RelType, resolvePart, SlidesPackage } from './slidesPackage';
import { el } from './slidesXml';

/** A package's files by name; folder entries carry nothing. */
const filesOf = (bytes: Uint8Array) => Object.fromEntries(Object.entries(unzipSync(bytes)).filter(([name]) => !name.endsWith('/')));

const open = async () => {
  const bytes = await makeSlidesFixture();
  return { bytes, pkg: SlidesPackage.open(bytes, nodeXmlCodec) };
};

describe('SlidesPackage', () => {
  test('saves untouched parts byte for byte, with the content types first', async () => {
    const { bytes, pkg } = await open();
    pkg.xml(SLIDES_FIXTURE_PARTS.slide2);
    const before = filesOf(bytes);
    const saved = pkg.toBytes();
    const after = filesOf(saved);
    expect(Object.keys(after)[0]).toBe('[Content_Types].xml');
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    for (const [name, content] of Object.entries(before)) expect(Buffer.from(after[name]).equals(Buffer.from(content)), name).toBe(true);
    // The main process admits what the editor writes.
    expect(inspectSlidesPackage(saved).readOnly).toEqual([]);
  });

  test('writes only the parts an edit touched', async () => {
    const { bytes, pkg } = await open();
    const doc = pkg.edit(SLIDES_FIXTURE_PARTS.slide1);
    el(doc.documentElement, 'p:cSld')!.setAttribute('name', 'Edited');
    const before = filesOf(bytes);
    const after = filesOf(pkg.toBytes());
    const changed = Object.keys(before).filter(name => !Buffer.from(after[name]).equals(Buffer.from(before[name])));
    expect(changed).toEqual([SLIDES_FIXTURE_PARTS.slide1]);
    const text = new TextDecoder().decode(after[SLIDES_FIXTURE_PARTS.slide1]);
    expect(text.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>')).toBe(true);
    expect(text).toContain('<p:cSld name="Edited">');
  });

  test('rolls a failed transaction back and undoes and redoes a finished one', async () => {
    const { pkg } = await open();
    const original = pkg.codec.serialize(pkg.xml(SLIDES_FIXTURE_PARTS.slide1));
    expect(() => pkg.transaction(() => {
      pkg.edit(SLIDES_FIXTURE_PARTS.slide1).documentElement.setAttribute('show', '0');
      pkg.put('ppt/extra.xml', '<x/>', 'application/xml');
      throw new Error('refused');
    })).toThrow('refused');
    expect(pkg.codec.serialize(pkg.xml(SLIDES_FIXTURE_PARTS.slide1))).toBe(original);
    expect(pkg.has('ppt/extra.xml')).toBe(false);
    expect(pkg.contentType('ppt/extra.xml')).toBe('application/xml');

    const { change } = pkg.transaction(() => pkg.edit(SLIDES_FIXTURE_PARTS.slide1).documentElement.setAttribute('show', '0'));
    expect(pkg.xml(SLIDES_FIXTURE_PARTS.slide1).documentElement.getAttribute('show')).toBe('0');
    pkg.undo(change);
    expect(pkg.xml(SLIDES_FIXTURE_PARTS.slide1).documentElement.getAttribute('show')).toBeFalsy();
    pkg.redo(change);
    expect(pkg.xml(SLIDES_FIXTURE_PARTS.slide1).documentElement.getAttribute('show')).toBe('0');
  });

  test('adds and removes relationships and resolves targets', async () => {
    const { pkg } = await open();
    const id = pkg.relate(SLIDES_FIXTURE_PARTS.slide1, RelType.Image, SLIDES_FIXTURE_PARTS.image);
    expect(pkg.target(SLIDES_FIXTURE_PARTS.slide1, id)).toBe(SLIDES_FIXTURE_PARTS.image);
    pkg.unrelate(SLIDES_FIXTURE_PARTS.slide1, id);
    expect(pkg.target(SLIDES_FIXTURE_PARTS.slide1, id)).toBeUndefined();
    expect(resolvePart('ppt/slides/slide1.xml', '../media/image%201.png')).toBe('ppt/media/image 1.png');
    expect(relativeTarget('ppt/slides/slide1.xml', 'ppt/media/image1.png')).toBe('../media/image1.png');
    expect(pkg.freePart('ppt/slides/slide', '.xml')).toBe('ppt/slides/slide3.xml');
  });
});
