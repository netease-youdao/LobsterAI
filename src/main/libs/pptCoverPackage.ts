import { DOMParser } from '@xmldom/xmldom';
import JSZip from 'jszip';

import { PptAssetKind } from '../../shared/pptCreation/constants';
import { layoutCoverText, PptCover, type PptCoverFields } from '../../shared/pptCreation/cover';
import { validatePptAsset } from './pptCreationStore';

const NS = { Drawing: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  Presentation: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  Rel: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships' } as const;
const xml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
const emu = (px: number) => Math.round(px * 9525);

export async function readCoverTemplate(bytes: Buffer) {
  await validatePptAsset(bytes, PptAssetKind.Pptx);
  const zip = await JSZip.loadAsync(bytes);
  const source = await zip.file('ppt/presentation.xml')?.async('string');
  const presentation = new DOMParser().parseFromString((source ?? '').replace(/^\uFEFF/, ''), 'text/xml');
  const size = presentation.getElementsByTagNameNS(NS.Presentation, 'sldSz')[0];
  if (presentation.getElementsByTagNameNS(NS.Presentation, 'sldId').length !== 1
    || size?.getAttribute('cx') !== String(emu(PptCover.Width)) || size?.getAttribute('cy') !== String(emu(PptCover.Height))) throw new Error('Invalid cover template dimensions');
  // Curated cover packages are data-only, with no external relationships.
  for (const name of Object.keys(zip.files).filter(name => name.endsWith('.rels'))) {
    if (/TargetMode\s*=\s*["']External["']/i.test(await zip.file(name)!.async('string'))) throw new Error('External cover relationship');
  }
  const images = Object.keys(zip.files).filter(name => /^ppt\/media\/[^/]+\.png$/.test(name));
  if (images.length !== 1 || !zip.file('ppt/slides/slide1.xml')) throw new Error('Invalid cover illustration');
  const background = await zip.file(images[0])!.async('nodebuffer');
  if (background.length > PptCover.MaxImageBytes || !background.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Invalid cover PNG');
  return { zip, background, imagePart: images[0] };
}

export async function composeCover(template: Buffer, fields: PptCoverFields, image?: Buffer): Promise<Buffer> {
  const lines = layoutCoverText(fields);
  const { zip, imagePart } = await readCoverTemplate(template);
  if (image) zip.file(imagePart, image);
  const slideRels = await zip.file('ppt/slides/_rels/slide1.xml.rels')!.async('string');
  const rels = new DOMParser().parseFromString(slideRels.replace(/^\uFEFF/, ''), 'text/xml');
  const imageRel = Array.from(rels.getElementsByTagName('Relationship')).find(r => r.getAttribute('Type')?.endsWith('/image'));
  if (!imageRel) throw new Error('Cover image relationship missing');
  const textShapes = lines.map((line, i) => {
    const style = `<a:rPr lang="zh-CN" sz="${Math.round(line.size * 75)}" b="${line.bold ? 1 : 0}"><a:solidFill><a:srgbClr val="${line.color}"/></a:solidFill><a:latin typeface="${PptCover.Font}"/><a:ea typeface="${PptCover.Font}"/><a:cs typeface="${PptCover.Font}"/></a:rPr>`;
    return `<p:sp><p:nvSpPr><p:cNvPr id="${i + 3}" name="Cover text ${i + 1}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${emu(line.x)}" y="${emu(line.y)}"/><a:ext cx="${emu(line.width)}" cy="${emu(line.height)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t"><a:noAutofit/></a:bodyPr><a:lstStyle/><a:p><a:pPr marL="0" indent="0"/><a:r>${style}<a:t xml:space="preserve">${xml(line.text)}</a:t></a:r></a:p></p:txBody></p:sp>`;
  }).join('');
  zip.file('ppt/slides/slide1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="${NS.Drawing}" xmlns:r="${NS.Rel}" xmlns:p="${NS.Presentation}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:pic><p:nvPicPr><p:cNvPr id="2" name="Cover illustration"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${xml(imageRel.getAttribute('Id')!)}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu(PptCover.Width)}" cy="${emu(PptCover.Height)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>${textShapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`);
  // Remove cached thumbnails rather than showing the original title after export.
  zip.remove('docProps/thumbnail.jpeg'); zip.remove('docProps/thumbnail.png');
  const rootRels = await zip.file('_rels/.rels')!.async('string');
  zip.file('_rels/.rels', rootRels.replace(/<Relationship\b[^>]*Type="[^"]*\/thumbnail"[^>]*\/?\s*>/g, ''));
  const types = await zip.file('[Content_Types].xml')!.async('string');
  zip.file('[Content_Types].xml', types.replace(/<Override\b[^>]*PartName="\/docProps\/thumbnail\.(?:jpeg|png)"[^>]*\/?\s*>/g, ''));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
