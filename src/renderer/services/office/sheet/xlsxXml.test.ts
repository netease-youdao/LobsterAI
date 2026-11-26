import { describe, expect, test } from 'vitest';

import { appendChildren, childInsertionPoint, ensureXmlNamespace, firstChildElement, namespacePrefixFor } from './xlsxXml';

const FOLLOWERS = ['hyperlinks', 'pageMargins', 'drawing', 'controls', 'tableParts', 'extLst'];

describe('schema-ordered insertion', () => {
  test('only direct children count: nested extension lists are not siblings', () => {
    const sheet = '<worksheet><sheetData/>'
      + '<conditionalFormatting sqref="A1"><cfRule type="dataBar" priority="1"><dataBar/><extLst><ext uri="{B025F937}"><x14:id>1</x14:id></ext></extLst></cfRule></conditionalFormatting>'
      + '<pageMargins left="0.7"/><extLst><ext><x14:dataValidations><x14:dataValidation/></x14:dataValidations></ext></extLst></worksheet>';
    expect(childInsertionPoint(sheet, 'worksheet', FOLLOWERS)).toBe(sheet.indexOf('<pageMargins'));
    expect(childInsertionPoint(sheet, 'worksheet', ['extLst'])).toBe(sheet.lastIndexOf('<extLst>'));
    // Nothing follows: the parent's closing tag.
    expect(childInsertionPoint(sheet, 'worksheet', ['picture'])).toBe(sheet.indexOf('</worksheet>'));
    expect(childInsertionPoint(sheet, 'workbook', FOLLOWERS)).toBeUndefined();
  });

  test('prefixed parts, comments and markup-compatibility wrappers', () => {
    const sheet = '<x:worksheet xmlns:x="main" xmlns:mc="mc"><x:sheetData/><!-- <pageMargins/> --><x:pageMargins/>'
      + '<mc:AlternateContent><mc:Choice Requires="x14"><x:controls><x:control/></x:controls></mc:Choice><mc:Fallback/></mc:AlternateContent>'
      + '<x:tableParts count="0"/></x:worksheet>';
    expect(childInsertionPoint(sheet, 'worksheet', ['pageMargins'])).toBe(sheet.indexOf('<x:pageMargins'));
    // A drawing goes before the controls, which the wrapper stands for.
    expect(childInsertionPoint(sheet, 'worksheet', ['controls', 'tableParts'])).toBe(sheet.indexOf('<mc:AlternateContent'));
    expect(childInsertionPoint(sheet, 'worksheet', ['tableParts'])).toBe(sheet.indexOf('<x:tableParts'));
  });

  test('the sheet\'s own element, not one inside a custom view', () => {
    const sheet = '<worksheet><sheetData/><customSheetViews><customSheetView><autoFilter ref="A1:B2"/></customSheetView></customSheetViews></worksheet>';
    expect(firstChildElement(sheet, 'worksheet', 'autoFilter')).toBeUndefined();
    const own = sheet.replace('<customSheetViews>', '<autoFilter ref="A1:C3"/><customSheetViews>');
    expect(firstChildElement(own, 'worksheet', 'autoFilter')?.open).toBe('<autoFilter ref="A1:C3"/>');
  });

  test('children are appended to a written or an empty self-closing container', () => {
    expect(appendChildren('<workbook><definedNames><definedName name="a">1</definedName></definedNames></workbook>', 'definedNames', '<definedName name="b">2</definedName>'))
      .toBe('<workbook><definedNames><definedName name="a">1</definedName><definedName name="b">2</definedName></definedNames></workbook>');
    expect(appendChildren('<workbook><sheets/><definedNames /><calcPr/></workbook>', 'definedNames', '<definedName name="b">2</definedName>'))
      .toBe('<workbook><sheets/><definedNames><definedName name="b">2</definedName></definedNames><calcPr/></workbook>');
    expect(appendChildren('<Relationships xmlns="rels"/>', 'Relationships', '<Relationship Id="rId1"/>')).toBe('<Relationships xmlns="rels"><Relationship Id="rId1"/></Relationships>');
    expect(appendChildren('<workbook/>', 'definedNames', '<definedName/>')).toBeUndefined();
  });
});

describe('namespace declarations', () => {
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

  test('finds the prefix bound to a namespace URI regardless of quotes or spacing', () => {
    expect(namespacePrefixFor(`<workbook xmlns="main" xmlns:r="${REL}">`, REL)).toBe('r');
    expect(namespacePrefixFor(`<workbook xmlns="main" xmlns:ns1 = '${REL}'>`, REL)).toBe('ns1');
    expect(namespacePrefixFor(`<workbook xmlns="${REL}">`, REL)).toBeUndefined();
    expect(namespacePrefixFor('<workbook xmlns="main" xmlns:r="urn:other">', REL)).toBeUndefined();
  });

  test('adds a missing namespace declaration, keeps existing ones unchanged, and refuses conflicts', () => {
    const bare = '<workbook xmlns="main"><sheets/></workbook>';
    expect(ensureXmlNamespace(bare, 'workbook', 'r', REL)).toEqual({
      xml: `<workbook xmlns="main" xmlns:r="${REL}"><sheets/></workbook>`,
      bound: true,
    });

    const spaced = `<x:workbook xmlns:x="main" xmlns:r = '${REL}'><x:sheets/></x:workbook>`;
    expect(ensureXmlNamespace(spaced, 'workbook', 'r', REL)).toEqual({ xml: spaced, bound: true });

    const conflict = '<workbook xmlns="main" xmlns:r="urn:other"><sheets/></workbook>';
    expect(ensureXmlNamespace(conflict, 'workbook', 'r', REL)).toEqual({ xml: conflict, bound: false });

    expect(ensureXmlNamespace('<worksheet/>', 'workbook', 'r', REL)).toEqual({ xml: '<worksheet/>', bound: false });
  });
});
