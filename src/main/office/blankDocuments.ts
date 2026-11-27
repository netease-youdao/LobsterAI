import fs from 'node:fs/promises';
import path from 'node:path';

import { strToU8, zipSync } from 'fflate';

import { BlankDocumentKind } from '../../shared/artifactPreview/blankDocument';

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CORE_PROPS_REL = 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties';
const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const SLIDES_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const CONTENT_SLIDES = 'application/vnd.openxmlformats-officedocument.presentationml';
const CONTENT_SHEET = 'application/vnd.openxmlformats-officedocument.spreadsheetml';

const OFFICE_THEME_XML = `${XML_DECL}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office">`
  + '<a:themeElements>'
  + '<a:clrScheme name="Office">'
  + '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>'
  + '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>'
  + '<a:dk2><a:srgbClr val="44546A"/></a:dk2>'
  + '<a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>'
  + '<a:accent1><a:srgbClr val="4472C4"/></a:accent1>'
  + '<a:accent2><a:srgbClr val="ED7D31"/></a:accent2>'
  + '<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>'
  + '<a:accent4><a:srgbClr val="FFC000"/></a:accent4>'
  + '<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>'
  + '<a:accent6><a:srgbClr val="70AD47"/></a:accent6>'
  + '<a:hlink><a:srgbClr val="0563C1"/></a:hlink>'
  + '<a:folHlink><a:srgbClr val="954F72"/></a:folHlink>'
  + '</a:clrScheme>'
  + '<a:fontScheme name="Office">'
  + '<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/><a:font script="Hans" typeface="等线 Light"/></a:majorFont>'
  + '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/><a:font script="Hans" typeface="等线"/></a:minorFont>'
  + '</a:fontScheme>'
  + '<a:fmtScheme name="Office">'
  + '<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="50000"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:shade val="80000"/></a:schemeClr></a:solidFill></a:fillStyleLst>'
  + '<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>'
  + '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>'
  + '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:shade val="90000"/></a:schemeClr></a:solidFill></a:bgFillStyleLst>'
  + '</a:fmtScheme>'
  + '</a:themeElements></a:theme>';

function zipParts(parts: Record<string, string>): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(parts)) {
    files[name] = strToU8(content);
  }
  return zipSync(files, { level: 6 });
}

function buildRels(entries: Array<[string, string, string]>): string {
  const items = entries
    .map(([id, type, target]) => {
      const fullType = type.startsWith('http://') || type.startsWith('https://') ? type : `${OFFICE_REL_NS}/${type}`;
      return `<Relationship Id="${id}" Type="${fullType}" Target="${target}"/>`;
    })
    .join('');
  return `${XML_DECL}<Relationships xmlns="${REL_NS}">${items}</Relationships>`;
}

/**
 * Standard OOXML Word (.docx) document with Chinese Office defaults:
 * DengXian (等线) 12pt (小四), 1.15x line spacing, 8pt paragraph after,
 * full heading/body/table/list style set with Enter-to-Normal flow, and Word 2013+ settings.
 */
export function buildBlankWordBytes(): Uint8Array {
  const headingStyle = (
    level: number,
    halfPoints: number,
    before: number,
    after: number,
  ): string => (
    `<w:style w:type="paragraph" w:styleId="Heading${level}">`
    + `<w:name w:val="heading ${level}"/>`
    + '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>'
    + `<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${before}" w:after="${after}" w:line="240" w:lineRule="auto"/><w:outlineLvl w:val="${level - 1}"/></w:pPr>`
    + `<w:rPr><w:b/><w:bCs/><w:sz w:val="${halfPoints}"/><w:szCs w:val="${halfPoints}"/></w:rPr>`
    + '</w:style>'
  );

  return zipParts({
    '[Content_Types].xml': `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
      + '<Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/>'
      + '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>'
      + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
      + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
      + '</Types>',
    '_rels/.rels': buildRels([
      ['rId1', 'officeDocument', 'word/document.xml'],
      ['rId2', CORE_PROPS_REL, 'docProps/core.xml'],
      ['rId3', 'extended-properties', 'docProps/app.xml'],
    ]),
    'docProps/core.xml': `${XML_DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"/>`,
    'docProps/app.xml': `${XML_DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>LobsterAI</Application></Properties>`,
    'word/_rels/document.xml.rels': buildRels([
      ['rId1', 'styles', 'styles.xml'],
      ['rId2', 'fontTable', 'fontTable.xml'],
      ['rId3', 'settings', 'settings.xml'],
    ]),
    'word/settings.xml': `${XML_DECL}<w:settings xmlns:w="${WORD_NS}">`
      + '<w:defaultTabStop w:val="420"/>'
      + '<w:characterSpacingControl w:val="compressPunctuation"/>'
      + '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>'
      + '<w:themeFontLang w:val="en-US" w:eastAsia="zh-CN"/>'
      + '</w:settings>',
    'word/fontTable.xml': `${XML_DECL}<w:fonts xmlns:w="${WORD_NS}">`
      + '<w:font w:name="等线"><w:altName w:val="DengXian"/><w:charset w:val="86"/><w:family w:val="swiss"/><w:pitch w:val="variable"/></w:font>'
      + '</w:fonts>',
    'word/styles.xml': `${XML_DECL}<w:styles xmlns:w="${WORD_NS}">`
      + '<w:docDefaults>'
      + '<w:rPrDefault><w:rPr>'
      + '<w:rFonts w:ascii="等线" w:hAnsi="等线" w:eastAsia="等线" w:cs="等线"/>'
      + '<w:sz w:val="24"/><w:szCs w:val="24"/>'
      + '<w:lang w:val="en-US" w:eastAsia="zh-CN"/>'
      + '</w:rPr></w:rPrDefault>'
      + '<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>'
      + '</w:docDefaults>'
      + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
      + '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>'
      + '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>'
      + '<w:style w:type="numbering" w:default="1" w:styleId="NoList"><w:name w:val="No List"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/></w:style>'
      + '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="80" w:after="200" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="48"/><w:szCs w:val="48"/></w:rPr></w:style>'
      + '<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="0" w:after="160" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:color w:val="595959"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>'
      + headingStyle(1, 36, 280, 120)
      + headingStyle(2, 30, 200, 80)
      + headingStyle(3, 26, 160, 60)
      + headingStyle(4, 24, 120, 40)
      + '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="120" w:after="120"/><w:ind w:left="480"/></w:pPr><w:rPr><w:i/><w:iCs/><w:color w:val="595959"/></w:rPr></w:style>'
      + '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="420"/><w:contextualSpacing/></w:pPr></w:style>'
      + '<w:style w:type="paragraph" w:styleId="NoSpacing"><w:name w:val="No Spacing"/><w:qFormat/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:style>'
      + '</w:styles>',
    'word/document.xml': `${XML_DECL}<w:document xmlns:w="${WORD_NS}" xmlns:r="${OFFICE_REL_NS}">`
      + '<w:body>'
      + '<w:p/>'
      + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
      + '</w:body></w:document>',
  });
}

/** Minimal valid OOXML Spreadsheet (.xlsx) workbook that opens directly in the live editor. */
export function buildBlankSheetBytes(): Uint8Array {
  return zipParts({
    '[Content_Types].xml': `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + `<Override PartName="/xl/workbook.xml" ContentType="${CONTENT_SHEET}.sheet.main+xml"/>`
      + `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="${CONTENT_SHEET}.worksheet+xml"/>`
      + '<Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
      + `<Override PartName="/xl/styles.xml" ContentType="${CONTENT_SHEET}.styles+xml"/>`
      + '</Types>',
    '_rels/.rels': buildRels([['rId1', 'officeDocument', 'xl/workbook.xml']]),
    'xl/workbook.xml': `${XML_DECL}<workbook xmlns="${SHEET_NS}" xmlns:r="${OFFICE_REL_NS}">`
      + '<workbookPr defaultThemeVersion="164011"/>'
      + '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="12000" activeTab="0"/></bookViews>'
      + '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>'
      + '<calcPr calcId="191029"/>'
      + '</workbook>',
    'xl/_rels/workbook.xml.rels': buildRels([
      ['rId1', 'worksheet', 'worksheets/sheet1.xml'],
      ['rId2', 'theme', 'theme/theme1.xml'],
      ['rId3', 'styles', 'styles.xml'],
    ]),
    'xl/theme/theme1.xml': OFFICE_THEME_XML,
    'xl/styles.xml': `${XML_DECL}<styleSheet xmlns="${SHEET_NS}">`
      + '<fonts count="1"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font></fonts>'
      + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
      + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>'
      + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
      + '<dxfs count="0"/>'
      + '</styleSheet>',
    'xl/worksheets/sheet1.xml': `${XML_DECL}<worksheet xmlns="${SHEET_NS}" xmlns:r="${OFFICE_REL_NS}">`
      + '<dimension ref="A1"/>'
      + '<sheetViews><sheetView tabSelected="1" workbookViewId="0"><selection activeCell="A1" sqref="A1"/></sheetView></sheetViews>'
      + '<sheetFormatPr defaultRowHeight="15"/>'
      + '<sheetData/>'
      + '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>'
      + '</worksheet>',
  });
}

const SLIDE_GROUP_HEADER = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
  + '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

const slidePlaceholder = (
  id: number,
  name: string,
  ph: string,
  body: string,
  spPr = '<p:spPr/>',
  txBodyProps = '<a:bodyPr/><a:lstStyle/>',
): string => (
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr>`
  + `${spPr}<p:txBody>${txBodyProps}${body}</p:txBody></p:sp>`
);

const slideXfrm = (x: number, y: number, cx: number, cy: number): string => (
  `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
);

/** Minimal valid 16:9 OOXML Presentation (.pptx) with one editable title slide. */
export function buildBlankSlidesBytes(): Uint8Array {
  const slideMaster = `${XML_DECL}<p:sldMaster ${SLIDES_NS}><p:cSld>`
    + '<p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>'
    + `<p:spTree>${SLIDE_GROUP_HEADER}`
    + slidePlaceholder(
      2,
      'Title Placeholder 1',
      '<p:ph type="title"/>',
      '<a:p><a:endParaRPr lang="zh-CN" altLang="en-US"/></a:p>',
      `<p:spPr>${slideXfrm(838200, 365125, 10515600, 1325563)}</p:spPr>`,
    )
    + slidePlaceholder(
      3,
      'Text Placeholder 2',
      '<p:ph type="body" idx="1"/>',
      '<a:p><a:endParaRPr lang="zh-CN" altLang="en-US"/></a:p>',
      `<p:spPr>${slideXfrm(838200, 1825625, 10515600, 4351338)}</p:spPr>`,
    )
    + '</p:spTree></p:cSld>'
    + '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
    + '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/><p:sldLayoutId id="2147483650" r:id="rId2"/></p:sldLayoutIdLst>'
    + '<p:txStyles>'
    + '<p:titleStyle><a:lvl1pPr algn="l" defTabSz="914400"><a:buNone/><a:defRPr sz="4400" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/><a:cs typeface="+mj-cs"/></a:defRPr></a:lvl1pPr></p:titleStyle>'
    + '<p:bodyStyle><a:lvl1pPr marL="228600" indent="-228600" algn="l" defTabSz="914400"><a:defRPr sz="2400" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:bodyStyle>'
    + '<p:otherStyle><a:defPPr><a:defRPr lang="zh-CN"/></a:defPPr><a:lvl1pPr marL="0" algn="l" defTabSz="914400"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:otherStyle>'
    + '</p:txStyles></p:sldMaster>';

  const titleLayout = `${XML_DECL}<p:sldLayout ${SLIDES_NS} type="title" preserve="1"><p:cSld name="Title Slide"><p:spTree>${SLIDE_GROUP_HEADER}`
    + slidePlaceholder(
      2,
      'Title 1',
      '<p:ph type="ctrTitle"/>',
      '<a:p><a:endParaRPr lang="zh-CN" altLang="en-US"/></a:p>',
      `<p:spPr>${slideXfrm(1524000, 1600000, 9144000, 1800000)}</p:spPr>`,
      '<a:bodyPr anchor="b"/><a:lstStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="5400"/></a:lvl1pPr></a:lstStyle>',
    )
    + slidePlaceholder(
      3,
      'Subtitle 2',
      '<p:ph type="subTitle" idx="1"/>',
      '<a:p><a:endParaRPr lang="zh-CN" altLang="en-US"/></a:p>',
      `<p:spPr>${slideXfrm(1524000, 3600000, 9144000, 1200000)}</p:spPr>`,
      '<a:bodyPr/><a:lstStyle><a:lvl1pPr marL="0" indent="0" algn="ctr"><a:buNone/><a:defRPr sz="2400"/></a:lvl1pPr></a:lstStyle>',
    )
    + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';

  const contentLayout = `${XML_DECL}<p:sldLayout ${SLIDES_NS} type="obj" preserve="1"><p:cSld name="Title and Content"><p:spTree>${SLIDE_GROUP_HEADER}`
    + slidePlaceholder(2, 'Title 1', '<p:ph type="title"/>', '<a:p><a:endParaRPr lang="zh-CN" altLang="en-US"/></a:p>')
    + slidePlaceholder(3, 'Content Placeholder 2', '<p:ph idx="1"/>', '<a:p><a:endParaRPr lang="zh-CN" altLang="en-US"/></a:p>')
    + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';

  const slide1 = `${XML_DECL}<p:sld ${SLIDES_NS}><p:cSld><p:spTree>${SLIDE_GROUP_HEADER}`
    + slidePlaceholder(2, 'Title 1', '<p:ph type="ctrTitle"/>', '<a:p><a:endParaRPr lang="zh-CN" altLang="en-US"/></a:p>')
    + slidePlaceholder(3, 'Subtitle 2', '<p:ph type="subTitle" idx="1"/>', '<a:p><a:endParaRPr lang="zh-CN" altLang="en-US"/></a:p>')
    + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';

  const presentation = `${XML_DECL}<p:presentation ${SLIDES_NS} saveSubsetFonts="1">`
    + '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
    + '<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>'
    + '<p:sldSz cx="12192000" cy="6858000"/>'
    + '<p:notesSz cx="6858000" cy="9144000"/>'
    + '<p:defaultTextStyle><a:defPPr><a:defRPr lang="zh-CN"/></a:defPPr><a:lvl1pPr marL="0" algn="l" defTabSz="914400"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:defaultTextStyle>'
    + '</p:presentation>';

  return zipParts({
    '[Content_Types].xml': `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + `<Override PartName="/ppt/presentation.xml" ContentType="${CONTENT_SLIDES}.presentation.main+xml"/>`
      + `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${CONTENT_SLIDES}.slideMaster+xml"/>`
      + `<Override PartName="/ppt/slides/slide1.xml" ContentType="${CONTENT_SLIDES}.slide+xml"/>`
      + `<Override PartName="/ppt/presProps.xml" ContentType="${CONTENT_SLIDES}.presProps+xml"/>`
      + `<Override PartName="/ppt/viewProps.xml" ContentType="${CONTENT_SLIDES}.viewProps+xml"/>`
      + '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
      + `<Override PartName="/ppt/tableStyles.xml" ContentType="${CONTENT_SLIDES}.tableStyles+xml"/>`
      + `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${CONTENT_SLIDES}.slideLayout+xml"/>`
      + `<Override PartName="/ppt/slideLayouts/slideLayout2.xml" ContentType="${CONTENT_SLIDES}.slideLayout+xml"/>`
      + '</Types>',
    '_rels/.rels': buildRels([['rId1', 'officeDocument', 'ppt/presentation.xml']]),
    'ppt/presentation.xml': presentation,
    'ppt/_rels/presentation.xml.rels': buildRels([
      ['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'],
      ['rId2', 'slide', 'slides/slide1.xml'],
      ['rId3', 'presProps', 'presProps.xml'],
      ['rId4', 'viewProps', 'viewProps.xml'],
      ['rId5', 'theme', 'theme/theme1.xml'],
      ['rId6', 'tableStyles', 'tableStyles.xml'],
    ]),
    'ppt/presProps.xml': `${XML_DECL}<p:presentationPr ${SLIDES_NS}/>`,
    'ppt/viewProps.xml': `${XML_DECL}<p:viewPr ${SLIDES_NS}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr></p:viewPr>`,
    'ppt/tableStyles.xml': `${XML_DECL}<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`,
    'ppt/theme/theme1.xml': OFFICE_THEME_XML,
    'ppt/slideMasters/slideMaster1.xml': slideMaster,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': buildRels([
      ['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'],
      ['rId2', 'slideLayout', '../slideLayouts/slideLayout2.xml'],
      ['rId3', 'theme', '../theme/theme1.xml'],
    ]),
    'ppt/slideLayouts/slideLayout1.xml': titleLayout,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': buildRels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]),
    'ppt/slideLayouts/slideLayout2.xml': contentLayout,
    'ppt/slideLayouts/_rels/slideLayout2.xml.rels': buildRels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]),
    'ppt/slides/slide1.xml': slide1,
    'ppt/slides/_rels/slide1.xml.rels': buildRels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']]),
  });
}

export function buildBlankDocumentBytes(kind: BlankDocumentKind): Uint8Array {
  switch (kind) {
    case BlankDocumentKind.Word:
      return buildBlankWordBytes();
    case BlankDocumentKind.Slides:
      return buildBlankSlidesBytes();
    case BlankDocumentKind.Sheet:
      return buildBlankSheetBytes();
    case BlankDocumentKind.Markdown:
      return new Uint8Array();
  }
}

const EXTENSION_BY_KIND: Record<BlankDocumentKind, string> = {
  [BlankDocumentKind.Word]: '.docx',
  [BlankDocumentKind.Slides]: '.pptx',
  [BlankDocumentKind.Sheet]: '.xlsx',
  [BlankDocumentKind.Markdown]: '.md',
};

const DEFAULT_BASE_NAME_BY_KIND: Record<BlankDocumentKind, string> = {
  [BlankDocumentKind.Word]: 'Untitled Document',
  [BlankDocumentKind.Slides]: 'Untitled Presentation',
  [BlankDocumentKind.Sheet]: 'Untitled Spreadsheet',
  [BlankDocumentKind.Markdown]: 'Untitled Note',
};

const MAX_COLLISION_ATTEMPTS = 500;

export function sanitizeBlankDocumentBaseName(baseName: string | undefined, kind: BlankDocumentKind): string {
  const cleaned = (baseName ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '')
    .trim();
  return cleaned || DEFAULT_BASE_NAME_BY_KIND[kind];
}

export async function createBlankDocumentInDirectory(
  directory: string,
  kind: BlankDocumentKind,
  baseName?: string,
): Promise<{ filePath: string; fileName: string }> {
  const targetDir = directory.trim();
  if (!targetDir || !path.isAbsolute(targetDir)) {
    throw new Error('Working directory must be an absolute path');
  }
  await fs.mkdir(targetDir, { recursive: true });
  const extension = EXTENSION_BY_KIND[kind];
  const stem = sanitizeBlankDocumentBaseName(baseName, kind);
  const bytes = buildBlankDocumentBytes(kind);

  for (let index = 1; index <= MAX_COLLISION_ATTEMPTS; index++) {
    const fileName = index === 1 ? `${stem}${extension}` : `${stem} ${index}${extension}`;
    const filePath = path.join(targetDir, fileName);
    try {
      await fs.writeFile(filePath, bytes, { flag: 'wx' });
      return { filePath, fileName };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'EEXIST') continue;
      throw error;
    }
  }
  throw new Error('Could not allocate an unused file name for the blank document');
}
