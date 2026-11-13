import { DOMParser } from '@xmldom/xmldom';
import JSZip from 'jszip';
import { expect, test } from 'vitest';

import { composeCover, readCoverTemplate } from './pptCoverPackage';

async function template(external = false) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('_rels/.rels', '<Relationships/>');
  zip.file('ppt/presentation.xml', '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst><p:sldId id="256"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>');
  zip.file('ppt/slides/slide1.xml', '<p:sld/>');
  zip.file('ppt/slides/_rels/slide1.xml.rels', `<Relationships><Relationship Id="image1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image.png" ${external ? 'TargetMode="External"' : ''}/></Relationships>`);
  zip.file('ppt/media/image.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return zip.generateAsync({ type: 'nodebuffer' });
}
test('exports native text objects and preserves the exact reused illustration', async () => {
  const original = await template();
  const result = await composeCover(original, { title: '校园阅读\n分享课', subtitle: 'A & B <C>', footer: '2026' });
  const zip = await JSZip.loadAsync(result);
  const document = new DOMParser().parseFromString(await zip.file('ppt/slides/slide1.xml')!.async('string'), 'text/xml');
  const text = Array.from(document.getElementsByTagName('a:t')).map(item => item.textContent).join('');
  expect(text).toContain('校园阅读分享课'); expect(text).toContain('A & B <C>');
  expect(document.getElementsByTagName('p:pic')).toHaveLength(1);
  expect(document.getElementsByTagName('p:sp').length).toBeGreaterThan(1);
  expect(await zip.file('ppt/media/image.png')!.async('nodebuffer')).toEqual((await readCoverTemplate(original)).background);
});
test('replaces only the illustration bytes when a new client image is chosen', async () => {
  const image = Buffer.from('client-generated-image');
  const zip = await JSZip.loadAsync(await composeCover(await template(), { title: '新主题', subtitle: '', footer: '' }, image));
  expect(await zip.file('ppt/media/image.png')!.async('nodebuffer')).toEqual(image);
});
test('refuses external template relationships', async () => {
  await expect(readCoverTemplate(await template(true))).rejects.toThrow('External');
});
