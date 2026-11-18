import { crc32, deflateSync } from 'node:zlib';

import JSZip from 'jszip';

const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const escapeXml = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function fixturePng(): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([size, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(64, 0); header.writeUInt32BE(32, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(32 * (64 * 3 + 1));
  for (let y = 0; y < 32; y++) for (let x = 0; x < 64; x++) {
    const offset = y * 193 + x * 3 + 1;
    pixels[offset] = 40; pixels[offset + 1] = 135; pixels[offset + 2] = 220;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

/** Small, independently constructed OOXML package; the editor does not generate its own input. */
export async function makeWordFixture(text = '中文文档测试 / Word editing', extraParts: Record<string, string> = {}): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0"?><Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="${OFFICE_REL_NS}/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0"?><Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="${OFFICE_REL_NS}/styles" Target="styles.xml"/><Relationship Id="rId2" Type="${OFFICE_REL_NS}/header" Target="header1.xml"/><Relationship Id="rId3" Type="${OFFICE_REL_NS}/footer" Target="footer1.xml"/><Relationship Id="rId4" Type="${OFFICE_REL_NS}/image" Target="media/pixel.png"/></Relationships>`);
  zip.file('word/styles.xml', `<w:styles xmlns:w="${WORD_NS}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft YaHei"/><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style></w:styles>`);
  zip.file('word/header1.xml', `<w:hdr xmlns:w="${WORD_NS}"><w:p><w:r><w:t>Header retained</w:t></w:r></w:p></w:hdr>`);
  zip.file('word/footer1.xml', `<w:ftr xmlns:w="${WORD_NS}"><w:p><w:r><w:t>Footer retained</w:t></w:r></w:p></w:ftr>`);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${WORD_NS}" xmlns:r="${OFFICE_REL_NS}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${escapeXml(text)}</w:t></w:r></w:p><w:p><w:r><w:t>第一段正文，可以直接编辑。Hello Word.</w:t></w:r></w:p><w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="457200"/><wp:docPr id="1" name="Fixture image"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="pixel.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId4"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="457200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p><w:tbl><w:tblPr><w:tblW w:w="5000" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/><w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="2500"/><w:gridCol w:w="2500"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="2500" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>项目</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="2500" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>数量 42</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p/><w:sectPr><w:headerReference w:type="default" r:id="rId2"/><w:footerReference w:type="default" r:id="rId3"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720"/></w:sectPr></w:body></w:document>`);
  zip.file('word/media/pixel.png', fixturePng());
  zip.file('customXml/item1.xml', '<custom xmlns="urn:lobster:test">preserve me verbatim</custom>');
  for (const [name, contents] of Object.entries(extraParts)) zip.file(name, contents);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
