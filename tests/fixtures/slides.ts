import { crc32, deflateSync } from 'node:zlib';

import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import JSZip from 'jszip';

import type { XmlCodec } from '../../src/renderer/services/office/slides/slidesXml';

/** The presentation code's XML access on Node, where the browser's DOMParser is missing. */
export const nodeXmlCodec: XmlCodec = {
  parse: text => new DOMParser().parseFromString(text, 'application/xml') as unknown as Document,
  serialize: document => new XMLSerializer().serializeToString(document as unknown as Parameters<XMLSerializer['serializeToString']>[0]),
};

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CONTENT = 'application/vnd.openxmlformats-officedocument.presentationml';
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

export const SLIDES_FIXTURE_PARTS = {
  presentation: 'ppt/presentation.xml',
  presentationRels: 'ppt/_rels/presentation.xml.rels',
  contentTypes: '[Content_Types].xml',
  master: 'ppt/slideMasters/slideMaster1.xml',
  titleLayout: 'ppt/slideLayouts/slideLayout1.xml',
  contentLayout: 'ppt/slideLayouts/slideLayout2.xml',
  theme: 'ppt/theme/theme1.xml',
  slide1: 'ppt/slides/slide1.xml',
  slide2: 'ppt/slides/slide2.xml',
  slide2Rels: 'ppt/slides/_rels/slide2.xml.rels',
  notes2: 'ppt/notesSlides/notesSlide1.xml',
  image: 'ppt/media/image1.png',
} as const;

/** Shape ids on the second slide. */
export const SLIDES_FIXTURE_SHAPES = { title: 2, body: 3, picture: 4, badge: 5, table: 6, note: 7 } as const;

function fixturePng(): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([size, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(32, 0); header.writeUInt32BE(16, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(16 * (32 * 3 + 1));
  for (let y = 0; y < 16; y++) for (let x = 0; x < 32; x++) {
    const offset = y * 97 + x * 3 + 1;
    pixels[offset] = 237; pixels[offset + 1] = 125; pixels[offset + 2] = 49;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

const rels = (entries: [string, string, string][]) => `${DECL}<Relationships xmlns="${REL_NS}">${entries.map(([id, type, target]) => `<Relationship Id="${id}" Type="${OFFICE_REL}/${type}" Target="${target}"/>`).join('')}</Relationships>`;
const text = (value: string, props = '<a:rPr lang="zh-CN" altLang="en-US" dirty="0"/>') => `<a:r>${props}<a:t>${value}</a:t></a:r>`;
const placeholder = (id: number, name: string, ph: string, body: string, spPr = '<p:spPr/>') => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr>${spPr}<p:txBody><a:bodyPr/><a:lstStyle/>${body}</p:txBody></p:sp>`;
const xfrm = (x: number, y: number, cx: number, cy: number) => `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`;
const group = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

const THEME = (name: string) => `${DECL}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="${name}"><a:themeElements>`
  + '<a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>'
  + '<a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/><a:font script="Hans" typeface="等线 Light"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/><a:font script="Hans" typeface="等线"/></a:minorFont></a:fontScheme>'
  + '<a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="50000"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:shade val="80000"/></a:schemeClr></a:solidFill></a:fillStyleLst>'
  + '<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>'
  + '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>'
  + '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:shade val="90000"/></a:schemeClr></a:solidFill></a:bgFillStyleLst></a:fmtScheme>'
  + '</a:themeElements></a:theme>';

const MASTER = `${DECL}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${group}`
  + placeholder(2, 'Title Placeholder 1', '<p:ph type="title"/>', `<a:p>${text('单击此处编辑母版标题样式')}</a:p>`, `<p:spPr>${xfrm(838200, 365125, 10515600, 1325563)}</p:spPr>`)
  + placeholder(3, 'Text Placeholder 2', '<p:ph type="body" idx="1"/>', `<a:p><a:pPr lvl="0"/>${text('编辑母版文本样式')}</a:p><a:p><a:pPr lvl="1"/>${text('第二级')}</a:p>`, `<p:spPr>${xfrm(838200, 1825625, 10515600, 4351338)}</p:spPr>`)
  + '<p:sp><p:nvSpPr><p:cNvPr id="4" name="Accent Bar"/><p:cNvSpPr/><p:nvPr userDrawn="1"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="6604000"/><a:ext cx="12192000" cy="254000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:schemeClr val="accent1"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>'
  + '</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
  + '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/><p:sldLayoutId id="2147483650" r:id="rId2"/></p:sldLayoutIdLst>'
  + '<p:txStyles><p:titleStyle><a:lvl1pPr algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPct val="0"/></a:spcBef><a:buNone/><a:defRPr sz="4400" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/><a:cs typeface="+mj-cs"/></a:defRPr></a:lvl1pPr></p:titleStyle>'
  + '<p:bodyStyle><a:lvl1pPr marL="228600" indent="-228600" algn="l" defTabSz="914400"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPts val="1000"/></a:spcBef><a:buFont typeface="Arial" panose="020B0604020202020204"/><a:buChar char="&#8226;"/><a:defRPr sz="2800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr>'
  + '<a:lvl2pPr marL="685800" indent="-228600" algn="l" defTabSz="914400"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPts val="500"/></a:spcBef><a:buFont typeface="Arial"/><a:buChar char="&#8226;"/><a:defRPr sz="2400" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl2pPr></p:bodyStyle>'
  + '<p:otherStyle><a:defPPr><a:defRPr lang="zh-CN"/></a:defPPr><a:lvl1pPr marL="0" algn="l" defTabSz="914400"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>';

const TITLE_LAYOUT = `${DECL}<p:sldLayout ${NS} type="title" preserve="1"><p:cSld name="标题幻灯片"><p:spTree>${group}`
  + placeholder(2, 'Title 1', '<p:ph type="ctrTitle"/>', `<a:p>${text('单击此处编辑母版标题样式')}</a:p>`, `<p:spPr>${xfrm(1524000, 1122363, 9144000, 2387600)}</p:spPr>`).replace('<p:txBody><a:bodyPr/><a:lstStyle/>', '<p:txBody><a:bodyPr anchor="b"/><a:lstStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="6000"/></a:lvl1pPr></a:lstStyle>')
  + placeholder(3, 'Subtitle 2', '<p:ph type="subTitle" idx="1"/>', `<a:p>${text('单击此处编辑母版副标题样式')}</a:p>`, `<p:spPr>${xfrm(1524000, 3602038, 9144000, 1655762)}</p:spPr>`).replace('<p:txBody><a:bodyPr/><a:lstStyle/>', '<p:txBody><a:bodyPr/><a:lstStyle><a:lvl1pPr marL="0" indent="0" algn="ctr"><a:buNone/><a:defRPr sz="2400"/></a:lvl1pPr></a:lstStyle>')
  + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';

const CONTENT_LAYOUT = `${DECL}<p:sldLayout ${NS} type="obj" preserve="1"><p:cSld name="标题和内容"><p:spTree>${group}`
  + placeholder(2, 'Title 1', '<p:ph type="title"/>', `<a:p>${text('单击此处编辑母版标题样式')}</a:p>`)
  + placeholder(3, 'Content Placeholder 2', '<p:ph idx="1"/>', `<a:p><a:pPr lvl="0"/>${text('编辑母版文本样式')}</a:p>`)
  + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';

const SLIDE1 = `${DECL}<p:sld ${NS}><p:cSld><p:spTree>${group}`
  + placeholder(2, '标题 1', '<p:ph type="ctrTitle"/>', `<a:p>${text('季度汇报')}</a:p>`)
  + placeholder(3, '副标题 2', '<p:ph type="subTitle" idx="1"/>', `<a:p>${text('2026 年第三季度')}</a:p>`)
  + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';

const TABLE = '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="6" name="表格 5"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>'
  + '<p:xfrm><a:off x="6400800" y="3657600"/><a:ext cx="4572000" cy="741680"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}</a:tableStyleId></a:tblPr>'
  + '<a:tblGrid><a:gridCol w="2286000"/><a:gridCol w="2286000"/></a:tblGrid>'
  + `<a:tr h="370840"><a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p>${text('指标')}</a:p></a:txBody><a:tcPr/></a:tc><a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p>${text('数值')}</a:p></a:txBody><a:tcPr/></a:tc></a:tr>`
  + `<a:tr h="370840"><a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p>${text('用户数')}</a:p></a:txBody><a:tcPr/></a:tc><a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p>${text('1200')}</a:p></a:txBody><a:tcPr/></a:tc></a:tr>`
  + '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>';

const SLIDE2 = `${DECL}<p:sld ${NS}><p:cSld><p:spTree>${group}`
  + placeholder(2, '标题 1', '<p:ph type="title"/>', `<a:p>${text('项目进展')}</a:p>`)
  + placeholder(3, '内容占位符 2', '<p:ph idx="1"/>', `<a:p>${text('完成数据迁移')}</a:p><a:p><a:pPr lvl="1"/>${text('测试覆盖率 ')}${text('85%', '<a:rPr lang="en-US" b="1" dirty="0"/>')}</a:p><a:p>${text('上线新功能')}</a:p>`,
    `<p:spPr>${xfrm(838200, 1825625, 5181600, 4351338)}</p:spPr>`)
  + '<p:pic><p:nvPicPr><p:cNvPr id="4" name="图片 3" descr="趋势图"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>'
  + `<p:spPr>${xfrm(6400800, 1825625, 2286000, 1143000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
  + `<p:sp><p:nvSpPr><p:cNvPr id="5" name="矩形 4"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(9144000, 1825625, 1828800, 685800)}<a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom><a:solidFill><a:schemeClr val="accent2"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr>`
  + `<p:txBody><a:bodyPr rtlCol="0" anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr"/>${text('重点', '<a:rPr lang="zh-CN" altLang="en-US" b="1" dirty="0"><a:solidFill><a:schemeClr val="bg1"/></a:solidFill></a:rPr>')}</a:p></p:txBody></p:sp>`
  + TABLE
  + `<p:sp><p:nvSpPr><p:cNvPr id="7" name="文本框 6"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(838200, 6248400, 4572000, 307777)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>`
  + `<p:txBody><a:bodyPr wrap="square" rtlCol="0"><a:spAutoFit/></a:bodyPr><a:lstStyle/><a:p>${text('备注：数据截至九月', '<a:rPr lang="zh-CN" altLang="en-US" sz="1400" dirty="0"><a:solidFill><a:srgbClr val="7F7F7F"/></a:solidFill></a:rPr>')}</a:p></p:txBody></p:sp>`
  + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>'
  + '<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst><p:par><p:cTn id="3" fill="hold"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst><p:childTnLst><p:par><p:cTn id="4" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:par><p:cTn id="5" presetID="1" presetClass="entr" presetSubtype="0" fill="hold" nodeType="clickEffect"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst><p:set><p:cBhvr><p:cTn id="6" dur="1" fill="hold"><p:stCondLst><p:cond delay="499"/></p:stCondLst></p:cTn><p:tgtEl><p:spTgt spid="5"/></p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>'
  + '</p:sld>';

const NOTES_MASTER = `${DECL}<p:notesMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${group}`
  + placeholder(2, 'Slide Image Placeholder 1', '<p:ph type="sldImg" idx="2"/>', '<a:p><a:endParaRPr lang="zh-CN"/></a:p>', `<p:spPr>${xfrm(685800, 1143000, 5486400, 3086100)}</p:spPr>`)
  + placeholder(3, 'Notes Placeholder 2', '<p:ph type="body" sz="quarter" idx="3"/>', `<a:p>${text('编辑母版文本样式')}</a:p>`, `<p:spPr>${xfrm(685800, 4400550, 5486400, 3600450)}</p:spPr>`)
  + '</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
  + '<p:notesStyle><a:lvl1pPr marL="0" algn="l" defTabSz="914400"><a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:notesStyle></p:notesMaster>';

const NOTES2 = `${DECL}<p:notes ${NS}><p:cSld><p:spTree>${group}`
  + placeholder(2, '幻灯片图像占位符 1', '<p:ph type="sldImg"/>', '<a:p><a:endParaRPr lang="zh-CN"/></a:p>')
  + placeholder(3, '备注占位符 2', '<p:ph type="body" idx="1"/>', `<a:p>${text('讲解项目进度')}</a:p>`)
  + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>';

const PRESENTATION = `${DECL}<p:presentation ${NS} xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" saveSubsetFonts="1">`
  + '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:notesMasterIdLst><p:notesMasterId r:id="rId4"/></p:notesMasterIdLst>'
  + '<p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/>'
  + '<p:defaultTextStyle><a:defPPr><a:defRPr lang="zh-CN"/></a:defPPr><a:lvl1pPr marL="0" algn="l" defTabSz="914400"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:defaultTextStyle>'
  + '<p:extLst><p:ext uri="{521415D9-36F7-43E2-AB2F-B90AF26B5E84}"><p14:sectionLst><p14:section name="默认节" id="{6A5B3C8E-0D14-4A0B-9A0D-AF1B3A8D2C11}"><p14:sldIdLst><p14:sldId id="256"/><p14:sldId id="257"/></p14:sldIdLst></p14:section></p14:sectionLst></p:ext></p:extLst></p:presentation>';

/**
 * An independently written presentation with the structures real decks carry: a master with
 * text styles and a decorative shape, title and content layouts, a theme, placeholders that
 * inherit their position, a picture, a styled shape with an animation, a table, a text box,
 * speaker notes and a section list.
 */
export async function makeSlidesFixture(overrides: Partial<Record<string, string | Uint8Array>> = {}): Promise<Uint8Array> {
  const parts: Record<string, string | Uint8Array | undefined> = {
    '[Content_Types].xml': `${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>`
      + `<Override PartName="/ppt/presentation.xml" ContentType="${CONTENT}.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${CONTENT}.slideMaster+xml"/>`
      + `<Override PartName="/ppt/slides/slide1.xml" ContentType="${CONTENT}.slide+xml"/><Override PartName="/ppt/slides/slide2.xml" ContentType="${CONTENT}.slide+xml"/>`
      + `<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="${CONTENT}.notesMaster+xml"/><Override PartName="/ppt/notesSlides/notesSlide1.xml" ContentType="${CONTENT}.notesSlide+xml"/>`
      + `<Override PartName="/ppt/presProps.xml" ContentType="${CONTENT}.presProps+xml"/><Override PartName="/ppt/viewProps.xml" ContentType="${CONTENT}.viewProps+xml"/>`
      + '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
      + `<Override PartName="/ppt/tableStyles.xml" ContentType="${CONTENT}.tableStyles+xml"/>`
      + `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${CONTENT}.slideLayout+xml"/><Override PartName="/ppt/slideLayouts/slideLayout2.xml" ContentType="${CONTENT}.slideLayout+xml"/>`
      + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>',
    '_rels/.rels': `${DECL}<Relationships xmlns="${REL_NS}"><Relationship Id="rId3" Type="${OFFICE_REL}/extended-properties" Target="docProps/app.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId1" Type="${OFFICE_REL}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    'docProps/app.xml': `${DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Office PowerPoint</Application><Slides>2</Slides></Properties>`,
    'docProps/core.xml': `${DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>季度汇报</dc:title></cp:coreProperties>`,
    'ppt/presentation.xml': PRESENTATION,
    'ppt/_rels/presentation.xml.rels': rels([['rId8', 'tableStyles', 'tableStyles.xml'], ['rId3', 'slide', 'slides/slide2.xml'], ['rId7', 'theme', 'theme/theme1.xml'], ['rId2', 'slide', 'slides/slide1.xml'], ['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'], ['rId6', 'viewProps', 'viewProps.xml'], ['rId5', 'presProps', 'presProps.xml'], ['rId4', 'notesMaster', 'notesMasters/notesMaster1.xml']]),
    'ppt/presProps.xml': `${DECL}<p:presentationPr ${NS}/>`,
    'ppt/viewProps.xml': `${DECL}<p:viewPr ${NS}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr></p:viewPr>`,
    'ppt/tableStyles.xml': `${DECL}<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`,
    'ppt/theme/theme1.xml': THEME('Office 主题'),
    'ppt/theme/theme2.xml': THEME('Office Theme'),
    'ppt/slideMasters/slideMaster1.xml': MASTER,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': rels([['rId3', 'theme', '../theme/theme1.xml'], ['rId2', 'slideLayout', '../slideLayouts/slideLayout2.xml'], ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']]),
    'ppt/slideLayouts/slideLayout1.xml': TITLE_LAYOUT,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]),
    'ppt/slideLayouts/slideLayout2.xml': CONTENT_LAYOUT,
    'ppt/slideLayouts/_rels/slideLayout2.xml.rels': rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]),
    'ppt/slides/slide1.xml': SLIDE1,
    'ppt/slides/_rels/slide1.xml.rels': rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']]),
    'ppt/slides/slide2.xml': SLIDE2,
    'ppt/slides/_rels/slide2.xml.rels': rels([['rId3', 'notesSlide', '../notesSlides/notesSlide1.xml'], ['rId2', 'image', '../media/image1.png'], ['rId1', 'slideLayout', '../slideLayouts/slideLayout2.xml']]),
    'ppt/notesMasters/notesMaster1.xml': NOTES_MASTER,
    'ppt/notesMasters/_rels/notesMaster1.xml.rels': rels([['rId1', 'theme', '../theme/theme2.xml']]),
    'ppt/notesSlides/notesSlide1.xml': NOTES2,
    'ppt/notesSlides/_rels/notesSlide1.xml.rels': rels([['rId2', 'slide', '../slides/slide2.xml'], ['rId1', 'notesMaster', '../notesMasters/notesMaster1.xml']]),
    'ppt/media/image1.png': fixturePng(),
    ...overrides,
  };
  const zip = new JSZip();
  for (const [name, contents] of Object.entries(parts)) if (contents !== undefined) zip.file(name, contents);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
