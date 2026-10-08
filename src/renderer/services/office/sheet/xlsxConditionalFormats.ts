import type { IRange, IStyleBase, IWorkbookData } from '@univerjs/core';
import {
  CFNumberOperator, CFRuleType, CFSubRuleType, CFTextOperator, CFTimePeriodOperator, CFValueType, type IConditionalFormattingRuleConfig,
  type IConditionFormattingRule, IIconSetType, type IValueConfig,
} from '@univerjs/sheets-conditional-formatting';

import { cellReference } from './sheetAddress';
import { parseSqref } from './sheetStructure';
import type { XlsxStyles } from './xlsxStyles';
import { decodeXml, firstXmlElement, xmlAttribute, type XmlElement, xmlElements } from './xlsxXml';

/**
 * Conditional formats of a worksheet part, mapped to Univer's rule model so the grid shows them
 * the way Excel does. Rules Univer cannot express are left out of the view; they stay in the file.
 */

/** Where an imported rule came from, so the writer can keep its original markup. */
export interface ImportedConditionalFormat {
  cfId: string;
  /** The original `<cfRule>` element (main namespace), or undefined for an x14-only rule. */
  markup?: string;
  /** The x14 extension rule that carries this rule's Excel 2010 details (data bar options, custom icons). */
  extensionMarkup?: string;
  extensionId?: string;
  sqref: string;
  rule: IConditionFormattingRule;
}

const DEFAULT_ICON_SET = IIconSetType.threeTrafficLights1;
const ICON_SETS = new Set<string>(Object.values(IIconSetType));
const ICON_COUNT: Record<string, number> = {};
for (const set of Object.values(IIconSetType)) ICON_COUNT[set] = Number.parseInt(set.replace(/^_/, ''), 10) || 3;
/** Univer lists icons best first, except these two sets (fewest bars first). */
const WORST_FIRST_ICON_SETS = new Set<string>([IIconSetType.fourRating, IIconSetType.fiveRating]);
/** Univer's index of an Excel icon (Excel numbers icons from the lowest bucket up). */
const univerIconIndex = (set: string, excelIndex: number, count: number): string => String(WORST_FIRST_ICON_SETS.has(set) ? excelIndex : count - 1 - excelIndex);
const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const STRING = /^"((?:[^"]|"")*)"$/;
const DEFAULT_POSITIVE_BAR = '#638EC6';
const DEFAULT_NEGATIVE_BAR = '#FF0000';

const toRange = (range: { startRow: number; endRow: number; startColumn: number; endColumn: number }): IRange => ({ ...range });

function formulas(element: XmlElement, local = 'formula'): string[] {
  return element.inner ? [...xmlElements(element.inner, local)].map(item => decodeXml(item.inner ?? '').trim()) : [];
}

function valueConfig(cfvo: XmlElement | undefined): IValueConfig {
  if (!cfvo) return { type: CFValueType.min };
  const type = xmlAttribute(cfvo.open, 'type') ?? 'min';
  const formulaChild = cfvo.inner ? firstXmlElement(cfvo.inner, 'f') : undefined;
  const raw = formulaChild?.inner !== undefined ? decodeXml(formulaChild.inner) : xmlAttribute(cfvo.open, 'val');
  switch (type) {
    case 'min':
    case 'autoMin': return { type: CFValueType.min };
    case 'max':
    case 'autoMax': return { type: CFValueType.max };
    case 'num':
    case 'percent':
    case 'percentile': {
      const value = raw ?? '0';
      if (!NUMBER.test(value.trim())) return { type: CFValueType.formula, value: `=${value}` };
      return { type: type as CFValueType, value: Number(value) };
    }
    case 'formula': return { type: CFValueType.formula, value: `=${raw ?? '0'}` };
    default: return { type: CFValueType.min };
  }
}

function colorOf(element: XmlElement | undefined, styles: XlsxStyles, fallback: string): string {
  return (element && styles.color(element.open)) ?? fallback;
}

/** A cellIs rule whose operands are not plain numbers, rewritten as the formula Excel evaluates. */
function cellIsFormula(operator: string, operands: string[], anchor: string): string | undefined {
  const [first, second] = operands;
  if (first === undefined) return undefined;
  const comparison: Record<string, string> = {
    equal: '=', notEqual: '<>', greaterThan: '>', greaterThanOrEqual: '>=', lessThan: '<', lessThanOrEqual: '<=',
  };
  if (comparison[operator]) return `=${anchor}${comparison[operator]}(${first})`;
  if (second === undefined) return undefined;
  if (operator === 'between') return `=AND(${anchor}>=MIN((${first}),(${second})),${anchor}<=MAX((${first}),(${second})))`;
  if (operator === 'notBetween') return `=OR(${anchor}<MIN((${first}),(${second})),${anchor}>MAX((${first}),(${second})))`;
  return undefined;
}

function highlight(subType: CFSubRuleType, style: IStyleBase, extra: Record<string, unknown> = {}): IConditionalFormattingRuleConfig {
  return { type: CFRuleType.highlightCell, subType, style, ...extra } as IConditionalFormattingRuleConfig;
}

const NUMBER_OPERATORS = new Set<string>(Object.values(CFNumberOperator));
const TIME_PERIODS = new Set<string>(Object.values(CFTimePeriodOperator));

interface RuleContext {
  styles: XlsxStyles;
  ranges: IRange[];
  /** Style of the rule's differential format. */
  style: IStyleBase;
  /** The Excel 2010 data bar or icon set that extends this rule, if any. */
  extension?: XmlElement;
}

function ruleConfig(element: XmlElement, context: RuleContext): IConditionalFormattingRuleConfig | undefined {
  const type = xmlAttribute(element.open, 'type');
  const operator = xmlAttribute(element.open, 'operator') ?? '';
  const operands = [...formulas(element), ...formulas(element, 'f')];
  const anchorCell = cellReference(Math.min(...context.ranges.map(range => range.startRow)), Math.min(...context.ranges.map(range => range.startColumn)));
  const { style } = context;
  switch (type) {
    case 'expression':
      return operands[0] ? highlight(CFSubRuleType.formula, style, { value: `=${operands[0]}` }) : undefined;
    case 'cellIs': {
      if (!NUMBER_OPERATORS.has(operator)) return undefined;
      if (operands.length && operands.every(value => NUMBER.test(value))) {
        const numbers = operands.map(Number);
        const value = operator === 'between' || operator === 'notBetween' ? [numbers[0], numbers[1] ?? numbers[0]] : numbers[0];
        return highlight(CFSubRuleType.number, style, { operator, value });
      }
      const text = STRING.exec(operands[0] ?? '');
      if (text && (operator === 'equal' || operator === 'notEqual') && operands.length === 1) {
        return highlight(CFSubRuleType.text, style, { operator: operator === 'equal' ? CFTextOperator.equal : CFTextOperator.notEqual, value: text[1].replace(/""/g, '"') });
      }
      const formula = cellIsFormula(operator, operands, anchorCell);
      return formula ? highlight(CFSubRuleType.formula, style, { value: formula }) : undefined;
    }
    case 'containsText':
    case 'notContainsText':
    case 'beginsWith':
    case 'endsWith':
      return highlight(CFSubRuleType.text, style, { operator: type, value: xmlAttribute(element.open, 'text') ?? '' });
    case 'containsBlanks':
    case 'notContainsBlanks':
    case 'containsErrors':
    case 'notContainsErrors':
      return highlight(CFSubRuleType.text, style, { operator: type });
    case 'timePeriod': {
      const period = xmlAttribute(element.open, 'timePeriod') ?? '';
      return TIME_PERIODS.has(period) ? highlight(CFSubRuleType.timePeriod, style, { operator: period }) : undefined;
    }
    case 'top10':
      return highlight(CFSubRuleType.rank, style, {
        isBottom: xmlAttribute(element.open, 'bottom') === '1',
        isPercent: xmlAttribute(element.open, 'percent') === '1',
        value: Number(xmlAttribute(element.open, 'rank') ?? 10),
      });
    case 'aboveAverage': {
      if (xmlAttribute(element.open, 'stdDev') !== undefined) return undefined;
      const above = xmlAttribute(element.open, 'aboveAverage') !== '0';
      const equal = xmlAttribute(element.open, 'equalAverage') === '1';
      const averageOperator = above
        ? (equal ? CFNumberOperator.greaterThanOrEqual : CFNumberOperator.greaterThan)
        : (equal ? CFNumberOperator.lessThanOrEqual : CFNumberOperator.lessThan);
      return highlight(CFSubRuleType.average, style, { operator: averageOperator });
    }
    case 'uniqueValues': return highlight(CFSubRuleType.uniqueValues, style);
    case 'duplicateValues': return highlight(CFSubRuleType.duplicateValues, style);
    case 'colorScale': {
      const scale = element.inner ? firstXmlElement(element.inner, 'colorScale') : undefined;
      if (!scale?.inner) return undefined;
      const points = [...xmlElements(scale.inner, 'cfvo')];
      const colors = [...xmlElements(scale.inner, 'color')];
      if (points.length < 2 || colors.length < points.length) return undefined;
      return {
        type: CFRuleType.colorScale,
        config: points.map((point, index) => ({ index, color: colorOf(colors[index], context.styles, '#FFFFFF'), value: valueConfig(point) })),
      };
    }
    case 'dataBar': {
      const bar = element.inner ? firstXmlElement(element.inner, 'dataBar') : undefined;
      if (!bar?.inner) return undefined;
      const points = [...xmlElements(bar.inner, 'cfvo')];
      const extension = context.extension?.inner ? firstXmlElement(context.extension.inner, 'dataBar') : undefined;
      const extensionPoints = extension?.inner ? [...xmlElements(extension.inner, 'cfvo')] : [];
      const negative = extension?.inner ? firstXmlElement(extension.inner, 'negativeFillColor') : undefined;
      return {
        type: CFRuleType.dataBar,
        isShowValue: xmlAttribute(bar.open, 'showValue') !== '0',
        config: {
          min: valueConfig(extensionPoints[0] ?? points[0]),
          max: valueConfig(extensionPoints[1] ?? points[1]),
          // Excel 2007 bars are gradients; Excel 2010 marks solid bars with gradient="0".
          isGradient: extension ? xmlAttribute(extension.open, 'gradient') !== '0' : true,
          positiveColor: colorOf(firstXmlElement(bar.inner, 'color') ?? firstXmlElement(bar.inner, 'fillColor'), context.styles, DEFAULT_POSITIVE_BAR),
          nativeColor: colorOf(negative, context.styles, DEFAULT_NEGATIVE_BAR),
        },
      };
    }
    case 'iconSet': {
      const main = element.inner ? firstXmlElement(element.inner, 'iconSet') : undefined;
      const extension = context.extension?.inner ? firstXmlElement(context.extension.inner, 'iconSet') : undefined;
      const set = extension ?? main;
      if (!set?.inner) return undefined;
      const setName = xmlAttribute(set.open, 'iconSet') ?? DEFAULT_ICON_SET;
      if (!ICON_SETS.has(setName)) return undefined;
      const points = [...xmlElements(set.inner, 'cfvo')];
      const count = points.length;
      if (count < 2) return undefined;
      const reverse = xmlAttribute(set.open, 'reverse') === '1';
      const customIcons = [...xmlElements(set.inner, 'cfIcon')];
      // Excel lists thresholds from the lowest bucket up; Univer lists icons best first.
      const config = Array.from({ length: count }, (_unused, position) => {
        const bucket = count - 1 - position;
        const point = points[bucket];
        const custom = customIcons[bucket];
        let iconType = setName as IIconSetType;
        let iconId = univerIconIndex(setName, reverse ? count - 1 - bucket : bucket, count);
        if (custom) {
          const customSet = xmlAttribute(custom.open, 'iconSet') ?? setName;
          const excelIcon = Number(xmlAttribute(custom.open, 'iconId') ?? 0);
          if (customSet === 'NoIcons' || !ICON_SETS.has(customSet)) {
            iconType = IIconSetType.empty;
            iconId = '';
          } else {
            iconType = customSet as IIconSetType;
            iconId = univerIconIndex(customSet, excelIcon, ICON_COUNT[customSet] ?? count);
          }
        }
        return {
          operator: xmlAttribute(point.open, 'gte') === '0' ? CFNumberOperator.greaterThan : CFNumberOperator.greaterThanOrEqual,
          value: valueConfig(point),
          iconType,
          iconId,
        };
      });
      return { type: CFRuleType.iconSet, isShowValue: xmlAttribute(set.open, 'showValue') !== '0', config };
    }
    default:
      return undefined;
  }
}

/** The Excel 2010 conditional formats of a worksheet, by the rule id main rules link to. */
function extensionRules(xml: string): { byId: Map<string, XmlElement & { sqref: string }>; standalone: (XmlElement & { sqref: string })[] } {
  const byId = new Map<string, XmlElement & { sqref: string }>();
  const standalone: (XmlElement & { sqref: string })[] = [];
  for (const container of xmlElements(xml, 'conditionalFormatting')) {
    if (xmlAttribute(container.open, 'sqref') !== undefined || !container.inner) continue;
    const sqrefElement = firstXmlElement(container.inner, 'sqref');
    const sqref = sqrefElement?.inner !== undefined ? decodeXml(sqrefElement.inner) : '';
    for (const rule of xmlElements(container.inner, 'cfRule')) {
      const id = xmlAttribute(rule.open, 'id');
      const entry = { ...rule, sqref };
      if (id) byId.set(id.toLowerCase(), entry);
      standalone.push(entry);
    }
  }
  return { byId, standalone };
}

/** Univer rules for a worksheet's conditional formats, highest priority first. */
export function importConditionalFormats(xml: string, styles: XlsxStyles): ImportedConditionalFormat[] {
  if (!xml.includes('conditionalFormatting')) return [];
  const extensions = extensionRules(xml);
  const linked = new Set<string>();
  const imported: (ImportedConditionalFormat & { priority: number })[] = [];
  let sequence = 0;
  const add = (element: XmlElement, sqref: string, markup: string | undefined, extension: (XmlElement & { sqref: string }) | undefined) => {
    const ranges = parseSqref(sqref).map(toRange);
    if (!ranges.length) return;
    const dxfId = xmlAttribute(element.open, 'dxfId');
    const inlineDxf = element.inner ? firstXmlElement(element.inner, 'dxf') : undefined;
    const style = (inlineDxf ? styles.dxfStyle(`${inlineDxf.open}${inlineDxf.inner ?? ''}</${inlineDxf.name}>`) : dxfId !== undefined ? styles.dxfStyle(Number(dxfId)) : undefined) ?? {};
    const config = ruleConfig(element, { styles, ranges, style: style as IStyleBase, extension });
    sequence++;
    if (!config) return;
    const cfId = `lobster-cf-${sequence}`;
    imported.push({
      cfId, markup, sqref,
      ...(extension ? { extensionMarkup: `${extension.open}${extension.inner ?? ''}</${extension.name}>`, extensionId: xmlAttribute(extension.open, 'id') } : {}),
      priority: Number(xmlAttribute(element.open, 'priority') ?? sequence),
      rule: { cfId, ranges, stopIfTrue: xmlAttribute(element.open, 'stopIfTrue') === '1', rule: config },
    });
  };
  for (const container of xmlElements(xml, 'conditionalFormatting')) {
    const sqref = xmlAttribute(container.open, 'sqref');
    if (sqref === undefined || !container.inner) continue;
    for (const rule of xmlElements(container.inner, 'cfRule')) {
      const idElement = rule.inner ? firstXmlElement(rule.inner, 'id') : undefined;
      const extensionId = idElement?.inner?.trim().toLowerCase();
      const extension = extensionId ? extensions.byId.get(extensionId) : undefined;
      if (extensionId) linked.add(extensionId);
      add(rule, sqref, `${rule.open}${rule.inner ?? ''}${rule.inner === undefined ? '' : `</${rule.name}>`}`, extension);
    }
  }
  // Excel 2010 rules without a main counterpart (formulas naming other sheets, custom icon sets).
  for (const rule of extensions.standalone) {
    const id = xmlAttribute(rule.open, 'id')?.toLowerCase();
    if (id && linked.has(id)) continue;
    add(rule, rule.sqref, undefined, rule);
  }
  return imported.sort((a, b) => a.priority - b.priority).map(({ priority: _priority, ...rest }) => rest);
}

/** Resource the conditional formatting plugin stores its rules in (SHEET_CONDITIONAL_FORMATTING_PLUGIN). */
export const CONDITIONAL_FORMATS_RESOURCE = 'SHEET_CONDITIONAL_FORMATTING_PLUGIN';

/** Conditional formats of a Univer snapshot, per sheet id, highest priority first. */
export function conditionalFormatsOf(snapshot: IWorkbookData): Record<string, IConditionFormattingRule[]> {
  const resource = snapshot.resources?.find(item => item.name === CONDITIONAL_FORMATS_RESOURCE);
  if (!resource?.data) return {};
  try {
    const parsed = JSON.parse(resource.data) as Record<string, IConditionFormattingRule[]>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Compare later saves against the rules as the model holds them right after loading, so any
 * normalization Univer applies on load never reads as an edit.
 */
export function adoptLoadedConditionalFormats(imported: Map<string, ImportedConditionalFormat[]>, snapshot: IWorkbookData): void {
  const model = conditionalFormatsOf(snapshot);
  for (const [sheetId, formats] of imported) {
    const rules = new Map((model[sheetId] ?? []).map(rule => [rule.cfId, rule]));
    for (const format of formats) {
      const loaded = rules.get(format.cfId);
      if (loaded) format.rule = structuredClone(loaded);
    }
  }
}
