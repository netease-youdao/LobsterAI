import { DataValidationType, type IRange, type ISheetDataValidationRule } from '@univerjs/core';

import { type FormulaScope, mapRanges, parseSqref, type SheetMaps, sqrefText, transformAnchoredFormula, transformSqref } from './sheetStructure';
import { stable } from './xlsxConditionalFormatExport';
import { COMPARED_TYPES, EXCEL_ERROR_STYLES, EXCEL_TYPES, excelFormula, type ImportedDataValidation } from './xlsxDataValidations';
import { mapElements } from './xlsxStructureExport';
import {
  addElementPrefix, childInsertionPoint, decodeXml, elementPrefix, encodeXmlAttribute, encodeXmlText, firstXmlElement, setXmlAttributes, xmlAttribute,
} from './xlsxXml';

/**
 * Writes data validation back from Univer's rule model. A sheet whose rules are exactly what was
 * loaded (after row and column edits) keeps its markup; otherwise its rules are rebuilt in model
 * order, reusing the original element of every rule whose settings did not change.
 */

const X14_DATA_VALIDATIONS = '{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}';
const X14_NS = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main';
const XM_NS = 'http://schemas.microsoft.com/office/excel/2006/main';
/** Worksheet children that follow `<dataValidations>`, in schema order. */
const AFTER_DATA_VALIDATIONS = ['hyperlinks', 'printOptions', 'pageMargins', 'pageSetup', 'headerFooter', 'rowBreaks', 'colBreaks',
  'customProperties', 'cellWatches', 'ignoredErrors', 'smartTags', 'drawing', 'legacyDrawing', 'legacyDrawingHF', 'drawingHF', 'picture',
  'oleObjects', 'controls', 'webPublishItems', 'tableParts', 'extLst'];

export interface DataValidationContext {
  /** Rules as loaded; `rule` is the model's own copy right after load. */
  imported: ImportedDataValidation[];
  /** Rules in the model now. */
  current: ISheetDataValidationRule[];
  maps: SheetMaps;
  scope: FormulaScope;
  /** Whether the workbook counts dates from 1904 (dates in rules are written as serial numbers). */
  date1904?: boolean;
}

const rangeKey = (ranges: IRange[]): string => ranges
  .map(range => `${range.startRow},${range.startColumn},${range.endRow},${range.endColumn}`).sort().join(';');
const settingsOf = ({ uid: _uid, ranges: _ranges, ...settings }: ISheetDataValidationRule) => settings;
const sameSettings = (a: ISheetDataValidationRule, b: ISheetDataValidationRule): boolean => stable(settingsOf(a)) === stable(settingsOf(b));

/**
 * A rule after row, column or sheet edits, as Excel moves it: its ranges grow, shrink or move,
 * and its formulas keep their top-left anchor while their references follow the edit. Null when
 * all of its cells were deleted.
 */
export function moveDataValidation(rule: ISheetDataValidationRule, maps: SheetMaps, scope: FormulaScope): ISheetDataValidationRule | null {
  const before = rule.ranges.map(range => ({ ...range }));
  const after = mapRanges(before, maps) as IRange[];
  if (!after.length) return null;
  const move = (formula: string | undefined) => (formula?.startsWith('=') ? `=${transformAnchoredFormula(formula.slice(1), scope, maps, before, after)}` : formula);
  return {
    ...rule,
    ranges: after,
    ...(rule.formula1 !== undefined ? { formula1: move(rule.formula1) } : {}),
    ...(rule.formula2 !== undefined ? { formula2: move(rule.formula2) } : {}),
  };
}

function expectedRules(context: DataValidationContext): Map<string, ISheetDataValidationRule> {
  const expected = new Map<string, ISheetDataValidationRule>();
  for (const item of context.imported) {
    const moved = moveDataValidation(item.rule, context.maps, context.scope);
    if (moved) expected.set(item.uid, moved);
  }
  return expected;
}

/** Whether the model holds exactly the loaded rules, moved by the row and column edits. */
export function dataValidationsUnchanged(context: DataValidationContext): boolean {
  const expected = [...expectedRules(context).values()];
  if (expected.length !== context.current.length) return false;
  return expected.every((rule, index) => {
    const now = context.current[index];
    return now.uid === rule.uid && sameSettings(rule, now) && rangeKey(now.ranges) === rangeKey(rule.ranges);
  });
}

/** The original element with its ranges and formulas replaced. */
function reuse(item: ImportedDataValidation, rule: ISheetDataValidationRule, sqref: string, date1904?: boolean): string {
  const open = item.markup.match(/^<[^>]+>/)![0];
  let markup = item.extension ? item.markup : setXmlAttributes(open, { sqref }) + item.markup.slice(open.length);
  const formulas: Record<string, string | undefined> = {
    formula1: excelFormula(rule.type, rule.formula1, date1904), formula2: excelFormula(rule.type, rule.formula2, date1904),
  };
  for (const local of ['formula1', 'formula2'] as const) {
    markup = mapElements(markup, local, element => {
      if (element.inner === undefined || formulas[local] === undefined) return undefined;
      const inner = firstXmlElement(element.inner, 'f');
      if (inner?.inner !== undefined) return `${element.open}${element.inner.slice(0, inner.start)}${inner.open}${encodeXmlText(formulas[local]!)}</${inner.name}>${element.inner.slice(inner.end)}</${element.name}>`;
      return decodeXml(element.inner) === formulas[local] ? undefined : `${element.open}${encodeXmlText(formulas[local]!)}</${element.name}>`;
    });
  }
  if (item.extension) markup = mapElements(markup, 'sqref', element => `${element.open}${encodeXmlText(sqref)}</${element.name}>`);
  return markup;
}

/** Markup for a rule made in the editor. */
function build(rule: ISheetDataValidationRule, sqref: string, extension: boolean, date1904?: boolean): string | undefined {
  const type = EXCEL_TYPES[rule.type];
  if (!type) return undefined;
  const attributes: [string, string | undefined][] = [
    ['type', type === 'none' ? undefined : type],
    ['errorStyle', rule.errorStyle === undefined ? undefined : EXCEL_ERROR_STYLES[rule.errorStyle]],
    ['operator', COMPARED_TYPES.has(rule.type) && rule.operator && rule.operator !== 'between' ? rule.operator : undefined],
    ['allowBlank', rule.allowBlank ? '1' : undefined],
    ['showDropDown', rule.type === DataValidationType.LIST && rule.showDropDown === false ? '1' : undefined],
    ['showInputMessage', rule.showInputMessage ? '1' : undefined],
    ['showErrorMessage', rule.showErrorMessage ? '1' : undefined],
    ['errorTitle', rule.errorTitle],
    ['error', rule.error],
    ['promptTitle', rule.promptTitle],
    ['prompt', rule.prompt],
  ];
  if (!extension) attributes.push(['sqref', sqref]);
  const open = attributes.filter(([, value]) => value !== undefined).map(([name, value]) => ` ${name}="${encodeXmlAttribute(value!)}"`).join('');
  const formulas = [['formula1', excelFormula(rule.type, rule.formula1, date1904)], ['formula2', COMPARED_TYPES.has(rule.type) ? excelFormula(rule.type, rule.formula2, date1904) : undefined]]
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => (extension ? `<x14:${name}><xm:f>${encodeXmlText(value!)}</xm:f></x14:${name}>` : `<${name}>${encodeXmlText(value!)}</${name}>`))
    .join('');
  return extension
    ? `<x14:dataValidation${open}>${formulas}<xm:sqref>${sqref}</xm:sqref></x14:dataValidation>`
    : `<dataValidation${open}>${formulas}</dataValidation>`;
}

/** The worksheet's own extension list: its last child. */
function worksheetExtensionList(xml: string): { innerStart: number } | undefined {
  const close = /<\/((?:[\w.-]+:)?extLst)>\s*<\/(?:[\w.-]+:)?worksheet>\s*$/.exec(xml);
  if (!close) return undefined;
  const open = xml.lastIndexOf(`<${close[1]}`, close.index);
  return open < 0 ? undefined : { innerStart: xml.indexOf('>', open) + 1 };
}

/** The worksheet with its data validation rebuilt from the model. */
export function rewriteDataValidations(xml: string, context: DataValidationContext): string {
  const worksheet = firstXmlElement(xml, 'worksheet');
  const prefix = elementPrefix(worksheet?.name ?? '');
  const container = firstXmlElement(xml, 'dataValidations');
  const containerOpen = container && elementPrefix(container.name) === prefix ? container.open : undefined;
  let result = mapElements(xml, 'dataValidations', element => (elementPrefix(element.name) === prefix ? null : undefined));
  result = mapElements(result, 'ext', element => (xmlAttribute(element.open, 'uri')?.toUpperCase() === X14_DATA_VALIDATIONS.toUpperCase() ? null : undefined));
  const byId = new Map(context.imported.map(item => [item.uid, item]));
  const expected = expectedRules(context);
  const main: string[] = [];
  const extensions: string[] = [];
  for (const rule of context.current) {
    const ranges = rule.ranges.map(range => ({ startRow: range.startRow, endRow: range.endRow, startColumn: range.startColumn, endColumn: range.endColumn }));
    if (!ranges.length) continue;
    const original = byId.get(rule.uid);
    const moved = expected.get(rule.uid);
    if (original && moved && sameSettings(moved, rule)) {
      // Whole-column rules were clipped to the grid on load; keep the file's own reference text.
      const sourceSqref = original.extension
        ? decodeXml(firstXmlElement(original.markup, 'sqref')?.inner ?? '')
        : xmlAttribute(original.markup.match(/^<[^>]+>/)![0], 'sqref') ?? '';
      const kept = rangeKey(moved.ranges) === rangeKey(ranges) ? transformSqref(sourceSqref, context.maps) : null;
      const sqref = kept && parseSqref(kept).length ? kept : sqrefText(ranges);
      (original.extension ? extensions : main).push(reuse(original, rule, sqref, context.date1904));
      continue;
    }
    // Formulas naming other sheets go where Excel 2010 puts them.
    const extension = [rule.formula1, rule.formula2].some(formula => formula?.startsWith('=') && formula.includes('!'));
    const built = build(rule, sqrefText(ranges), extension, context.date1904);
    if (built) (extension ? extensions : main).push(built);
  }
  if (extensions.length) {
    const ext = `<ext uri="${X14_DATA_VALIDATIONS}" xmlns:x14="${X14_NS}"><x14:dataValidations count="${extensions.length}" xmlns:xm="${XM_NS}">${extensions.join('')}</x14:dataValidations></ext>`;
    const list = worksheetExtensionList(result);
    if (list) {
      result = result.slice(0, list.innerStart) + ext + result.slice(list.innerStart);
    } else {
      const at = result.lastIndexOf('</');
      result = result.slice(0, at) + addElementPrefix('<extLst>', prefix) + ext + addElementPrefix('</extLst>', prefix) + result.slice(at);
    }
  }
  if (main.length) {
    const open = containerOpen ? setXmlAttributes(containerOpen, { count: String(main.length) }) : addElementPrefix(`<dataValidations count="${main.length}">`, prefix);
    const markup = `${open}${addElementPrefix(main.join(''), prefix)}${addElementPrefix('</dataValidations>', prefix)}`;
    const at = childInsertionPoint(result, 'worksheet', AFTER_DATA_VALIDATIONS) ?? result.lastIndexOf('</');
    result = result.slice(0, at) + markup + result.slice(at);
  }
  return mapElements(result, 'extLst', element => (element.inner !== undefined && !element.inner.trim() ? null : undefined));
}
