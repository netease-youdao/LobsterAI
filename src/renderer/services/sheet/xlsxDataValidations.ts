import {
  DataValidationErrorStyle, DataValidationOperator, DataValidationRenderMode, DataValidationType, type IRange, type ISheetDataValidationRule,
  type IWorkbookData,
} from '@univerjs/core';

import { parseSqref } from './sheetStructure';
import { decodeXml, elementPrefix, firstXmlElement, xmlAttribute, type XmlElement, xmlElements } from './xlsxXml';

/**
 * Data validation of a worksheet part in Univer's rule model: list rules show their dropdown,
 * other rules check what is typed. The writer keeps the file's markup unless the rules change.
 */

/** Resource the data validation plugin stores its rules in (SHEET_DATA_VALIDATION_PLUGIN). */
export const DATA_VALIDATIONS_RESOURCE = 'SHEET_DATA_VALIDATION_PLUGIN';

export interface ImportedDataValidation {
  uid: string;
  /** The original `<dataValidation>` element, main namespace or x14. */
  markup: string;
  /** Excel 2010 rules (formulas naming other sheets) live in the worksheet's extension list. */
  extension: boolean;
  rule: ISheetDataValidationRule;
}

const TYPES: Record<string, DataValidationType> = {
  none: DataValidationType.ANY, whole: DataValidationType.WHOLE, decimal: DataValidationType.DECIMAL, list: DataValidationType.LIST,
  date: DataValidationType.DATE, time: DataValidationType.TIME, textLength: DataValidationType.TEXT_LENGTH, custom: DataValidationType.CUSTOM,
};
export const EXCEL_TYPES: Partial<Record<string, string>> = Object.fromEntries(Object.entries(TYPES).map(([excel, univer]) => [univer, excel]));
const OPERATORS = new Set<string>(Object.values(DataValidationOperator));
const ERROR_STYLES: Record<string, DataValidationErrorStyle> = {
  stop: DataValidationErrorStyle.STOP, warning: DataValidationErrorStyle.WARNING, information: DataValidationErrorStyle.INFO,
};
export const EXCEL_ERROR_STYLES: Record<number, string> = { [DataValidationErrorStyle.WARNING]: 'warning', [DataValidationErrorStyle.INFO]: 'information' };
/** Types whose rule compares against one or two values with an operator. */
export const COMPARED_TYPES = new Set<string>([
  DataValidationType.WHOLE, DataValidationType.DECIMAL, DataValidationType.DATE, DataValidationType.TIME, DataValidationType.TEXT_LENGTH,
]);
const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const LIST_LITERAL = /^"((?:[^"]|"")*)"$/;

/** A rule formula as Univer stores it: `=` for formulas, plain text for list items and numbers. */
export function univerFormula(type: string, formula: string | undefined): string | undefined {
  if (formula === undefined || formula === '') return undefined;
  if (type === DataValidationType.LIST) {
    const literal = LIST_LITERAL.exec(formula);
    return literal ? literal[1].replace(/""/g, '"') : `=${formula}`;
  }
  if (type !== DataValidationType.CUSTOM && NUMBER.test(formula)) return formula;
  return `=${formula}`;
}

/** The formula text Excel stores for a Univer rule formula. */
export function excelFormula(type: string, formula: string | undefined): string | undefined {
  if (formula === undefined || formula === '') return undefined;
  if (formula.startsWith('=')) return formula.slice(1);
  if (type === DataValidationType.LIST) {
    let items: string[];
    try {
      const parsed = JSON.parse(formula) as unknown;
      items = Array.isArray(parsed) && parsed.every(item => typeof item === 'string') ? parsed : formula.split(',');
    } catch {
      items = formula.split(',');
    }
    return `"${items.join(',').replace(/"/g, '""')}"`;
  }
  return formula;
}

function formulaText(element: XmlElement, local: string): string | undefined {
  const holder = element.inner ? firstXmlElement(element.inner, local) : undefined;
  if (holder?.inner === undefined) return undefined;
  // x14 rules wrap the formula in <xm:f>.
  const inner = firstXmlElement(holder.inner, 'f');
  return decodeXml(inner?.inner ?? holder.inner).trim();
}

const flag = (element: XmlElement, name: string): boolean => ['1', 'true'].includes(xmlAttribute(element.open, name) ?? '');

/** Rule ranges within the sheet's grid: whole-column rules would otherwise span a million rows. */
function clamp(ranges: IRange[], limits: { rows: number; columns: number }): IRange[] {
  return ranges
    .filter(range => range.startRow < limits.rows && range.startColumn < limits.columns)
    .map(range => ({ ...range, endRow: Math.min(range.endRow, limits.rows - 1), endColumn: Math.min(range.endColumn, limits.columns - 1) }));
}

function ruleOf(element: XmlElement, sqref: string, uid: string, limits: { rows: number; columns: number }): ISheetDataValidationRule | undefined {
  const excelType = xmlAttribute(element.open, 'type') ?? 'none';
  const type = TYPES[excelType];
  if (!type) return undefined;
  const ranges = clamp(parseSqref(sqref), limits);
  if (!ranges.length) return undefined;
  const operator = xmlAttribute(element.open, 'operator') ?? (COMPARED_TYPES.has(type) ? DataValidationOperator.BETWEEN : undefined);
  const formula1 = univerFormula(type, formulaText(element, 'formula1'));
  const formula2 = univerFormula(type, formulaText(element, 'formula2'));
  const text = (name: string) => xmlAttribute(element.open, name);
  // Excel's showDropDown="1" hides the in-cell dropdown.
  const hideDropdown = flag(element, 'showDropDown');
  const rule: ISheetDataValidationRule = {
    uid,
    type,
    ranges,
    allowBlank: flag(element, 'allowBlank'),
    ...(operator && OPERATORS.has(operator) && COMPARED_TYPES.has(type) ? { operator: operator as DataValidationOperator } : {}),
    ...(formula1 !== undefined ? { formula1 } : {}),
    ...(formula2 !== undefined && COMPARED_TYPES.has(type) ? { formula2 } : {}),
    showErrorMessage: flag(element, 'showErrorMessage'),
    errorStyle: ERROR_STYLES[xmlAttribute(element.open, 'errorStyle') ?? 'stop'] ?? DataValidationErrorStyle.STOP,
    showInputMessage: flag(element, 'showInputMessage'),
    ...(text('errorTitle') !== undefined ? { errorTitle: text('errorTitle') } : {}),
    ...(text('error') !== undefined ? { error: text('error') } : {}),
    ...(text('promptTitle') !== undefined ? { promptTitle: text('promptTitle') } : {}),
    ...(text('prompt') !== undefined ? { prompt: text('prompt') } : {}),
    ...(type === DataValidationType.LIST ? { showDropDown: !hideDropdown, renderMode: hideDropdown ? DataValidationRenderMode.TEXT : DataValidationRenderMode.ARROW } : {}),
  };
  return rule;
}

/** Univer rules for a worksheet's data validation, in document order (main rules, then Excel 2010 ones). */
export function importDataValidations(xml: string, limits: { rows: number; columns: number }): ImportedDataValidation[] {
  if (!xml.includes('dataValidation')) return [];
  const imported: ImportedDataValidation[] = [];
  const rootPrefix = elementPrefix(firstXmlElement(xml, 'worksheet')?.name ?? '');
  let sequence = 0;
  for (const element of xmlElements(xml, 'dataValidation')) {
    const markup = `${element.open}${element.inner ?? ''}${element.inner === undefined ? '' : `</${element.name}>`}`;
    const extension = elementPrefix(element.name) !== rootPrefix;
    let sqref = xmlAttribute(element.open, 'sqref');
    if (sqref === undefined && element.inner) {
      const holder = firstXmlElement(element.inner, 'sqref');
      sqref = holder?.inner !== undefined ? decodeXml(holder.inner) : undefined;
    }
    sequence++;
    if (!sqref) continue;
    const uid = `lobster-dv-${sequence}`;
    const rule = ruleOf(element, sqref, uid, limits);
    if (rule) imported.push({ uid, markup, extension, rule });
  }
  return imported;
}

/** Data validation rules of a Univer snapshot, per sheet id; undefined when the plugin is not loaded. */
export function dataValidationsOf(snapshot: IWorkbookData): Record<string, ISheetDataValidationRule[]> | undefined {
  const resource = snapshot.resources?.find(item => item.name === DATA_VALIDATIONS_RESOURCE);
  if (!resource) return undefined;
  if (!resource.data) return {};
  try {
    const parsed = JSON.parse(resource.data) as Record<string, ISheetDataValidationRule[]>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Compare later saves against the rules as the model holds them right after loading. */
export function adoptLoadedDataValidations(imported: Map<string, ImportedDataValidation[]>, snapshot: IWorkbookData): void {
  const model = dataValidationsOf(snapshot);
  if (!model) return;
  for (const [sheetId, rules] of imported) {
    const loaded = new Map((model[sheetId] ?? []).map(rule => [rule.uid, rule]));
    for (const item of rules) {
      const rule = loaded.get(item.uid);
      if (rule) item.rule = structuredClone(rule);
    }
  }
}
