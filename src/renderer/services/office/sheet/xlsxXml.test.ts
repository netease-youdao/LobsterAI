import { describe, expect, test } from 'vitest';

import { appendChildren, childInsertionPoint, firstChildElement } from './xlsxXml';

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
