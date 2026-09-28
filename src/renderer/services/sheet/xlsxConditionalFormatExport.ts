import type { IRange, IStyleData } from '@univerjs/core';
import {
  CFNumberOperator, CFRuleType, CFSubRuleType, CFTextOperator, CFValueType, type IConditionalFormattingRuleConfig,
  type IConditionFormattingRule, IIconSetType, type IValueConfig,
} from '@univerjs/sheets-conditional-formatting';

import { type CellRange,cellReference } from './sheetAddress';
import { type FormulaScope, mapRanges, parseSqref, type SheetMaps, sqrefText, transformAnchoredFormula } from './sheetStructure';
import type { ImportedConditionalFormat } from './xlsxConditionalFormats';
import { mapElements } from './xlsxStructureExport';
import { addElementPrefix, decodeXml, elementPrefix, encodeXmlAttribute, encodeXmlText, firstXmlElement, setXmlAttributes, xmlAttribute } from './xlsxXml';

/**
 * Writes conditional formats back from Univer's rule model. A sheet whose rules are exactly what
 * was loaded (after row and column edits) keeps its markup; otherwise its rules are rebuilt in
 * model order, reusing the original `<cfRule>` of every rule whose settings did not change.
 */

const X14_CONDITIONAL_FORMATS = '{78C0D931-6437-407d-A8EE-F0AAD7539E65}';
const X14_DATA_BAR = '{B025F937-C7B1-47D3-B67F-A62EFF666E3E}';
const X14_NS = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main';
const XM_NS = 'http://schemas.microsoft.com/office/excel/2006/main';
/** Worksheet children that follow `<conditionalFormatting>`, in schema order. */
const AFTER_CONDITIONAL_FORMATS = ['dataValidations', 'hyperlinks', 'printOptions', 'pageMargins', 'pageSetup', 'headerFooter', 'rowBreaks',
  'colBreaks', 'customProperties', 'cellWatches', 'ignoredErrors', 'smartTags', 'drawing', 'legacyDrawing', 'legacyDrawingHF', 'drawingHF',
  'picture', 'oleObjects', 'controls', 'webPublishItems', 'tableParts', 'extLst'];
const WORST_FIRST_ICON_SETS = new Set<string>([IIconSetType.fourRating, IIconSetType.fiveRating]);
const ICON_SETS = new Set<string>(Object.values(IIconSetType));

export interface ConditionalFormatContext {
  /** Rules as loaded, highest priority first; `rule` is the model's own copy right after load. */
  imported: ImportedConditionalFormat[];
  /** Rules in the model now, highest priority first. */
  current: IConditionFormattingRule[];
  maps: SheetMaps;
  scope: FormulaScope;
  /** Record index of a differential format for a highlight style. */
  dxf: (style: IStyleData) => number;
}

const rangeKey = (ranges: IRange[]): string => ranges
  .map(range => `${range.startRow},${range.startColumn},${range.endRow},${range.endColumn}`).sort().join(';');

/** Stable JSON: object keys sorted, so equal settings compare equal whatever their key order. */
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const sameSettings = (a: IConditionFormattingRule, b: IConditionFormattingRule): boolean => stable(a.rule) === stable(b.rule) && Boolean(a.stopIfTrue) === Boolean(b.stopIfTrue);

/** Rewrite every formula of a rule's settings; formulas are stored with a leading `=`. */
function mapRuleFormulas(rule: IConditionFormattingRule, transform: (formula: string) => string): IConditionFormattingRule {
  const copy = structuredClone(rule);
  const config = copy.rule as unknown as Record<string, unknown>;
  const convert = (value: unknown) => (typeof value === 'string' && value.startsWith('=') ? `=${transform(value.slice(1))}` : value);
  if (config.type === CFRuleType.highlightCell && config.subType === CFSubRuleType.formula) config.value = convert(config.value);
  const values = config.type === CFRuleType.dataBar
    ? [(config.config as { min: IValueConfig }).min, (config.config as { max: IValueConfig }).max]
    : Array.isArray(config.config) ? (config.config as { value: IValueConfig }[]).map(item => item.value) : [];
  for (const value of values) if (value?.type === CFValueType.formula) value.value = convert(value.value) as string;
  return copy;
}

/**
 * A rule after row, column or sheet edits, as Excel moves it: its ranges grow, shrink or move,
 * and its formulas keep their top-left anchor while their references follow the edit. Null when
 * all of its cells were deleted.
 */
export function moveConditionalFormat(rule: IConditionFormattingRule, maps: SheetMaps, scope: FormulaScope): IConditionFormattingRule | null {
  const before = rule.ranges.map(range => ({ ...range }));
  const after = mapRanges(before, maps) as IRange[];
  if (!after.length) return null;
  const moved = mapRuleFormulas(rule, formula => transformAnchoredFormula(formula, scope, maps, before, after));
  return { ...moved, ranges: after };
}

/** The loaded rules as the model should hold them after the row and column edits. */
function expectedRules(context: Omit<ConditionalFormatContext, 'current' | 'dxf'>): Map<string, IConditionFormattingRule> {
  const expected = new Map<string, IConditionFormattingRule>();
  for (const item of context.imported) {
    const moved = moveConditionalFormat(item.rule, context.maps, context.scope);
    if (moved) expected.set(item.cfId, moved);
  }
  return expected;
}

/** Whether the model holds exactly the loaded rules, moved by the row and column edits. */
export function conditionalFormatsUnchanged(context: ConditionalFormatContext): boolean {
  const expected = [...expectedRules(context).values()];
  if (expected.length !== context.current.length) return false;
  return expected.every((rule, index) => {
    const now = context.current[index];
    return now.cfId === rule.cfId && sameSettings(rule, now) && rangeKey(now.ranges) === rangeKey(rule.ranges);
  });
}

// ---------------------------------------------------------------------------------------------
// Markup for rules built in the editor

const argb = (color: string | undefined, fallback = '000000'): string => `FF${(color ?? `#${fallback}`).replace('#', '').slice(0, 6).toUpperCase()}`;
const formulaText = (value: unknown): string => String(value ?? '').replace(/^=/, '');

function cfvo(value: IValueConfig | undefined, gte = true): string {
  const type = value?.type ?? CFValueType.min;
  const attributes = [`type="${type}"`];
  if (type !== CFValueType.min && type !== CFValueType.max) attributes.push(`val="${encodeXmlAttribute(type === CFValueType.formula ? formulaText(value?.value) : String(value?.value ?? 0))}"`);
  if (!gte) attributes.push('gte="0"');
  return `<cfvo ${attributes.join(' ')}/>`;
}

const quoted = (text: string): string => `"${text.replace(/"/g, '""')}"`;

/** The formula Excel stores alongside a text rule, evaluated for the rule's top-left cell. */
function textRuleFormula(operator: string, value: string, cell: string): string | undefined {
  const text = quoted(value);
  switch (operator) {
    case CFTextOperator.containsText: return `NOT(ISERROR(SEARCH(${text},${cell})))`;
    case CFTextOperator.notContainsText: return `ISERROR(SEARCH(${text},${cell}))`;
    case CFTextOperator.beginsWith: return `LEFT(${cell},LEN(${text}))=${text}`;
    case CFTextOperator.endsWith: return `RIGHT(${cell},LEN(${text}))=${text}`;
    case CFTextOperator.containsBlanks: return `LEN(TRIM(${cell}))=0`;
    case CFTextOperator.notContainsBlanks: return `LEN(TRIM(${cell}))>0`;
    case CFTextOperator.containsErrors: return `ISERROR(${cell})`;
    case CFTextOperator.notContainsErrors: return `NOT(ISERROR(${cell}))`;
    default: return undefined;
  }
}

/** Excel's own formulas for its date-occurring rules. */
function timePeriodFormula(period: string, cell: string): string {
  const day = `FLOOR(${cell},1)`;
  const rounded = `ROUNDDOWN(${cell},0)`;
  switch (period) {
    case 'yesterday': return `${day}=TODAY()-1`;
    case 'tomorrow': return `${day}=TODAY()+1`;
    case 'last7Days': return `AND(TODAY()-${day}<=6,${day}<=TODAY())`;
    case 'thisMonth': return `AND(MONTH(${cell})=MONTH(TODAY()),YEAR(${cell})=YEAR(TODAY()))`;
    case 'lastMonth': return `AND(MONTH(${cell})=MONTH(EDATE(TODAY(),0-1)),YEAR(${cell})=YEAR(EDATE(TODAY(),0-1)))`;
    case 'nextMonth': return `AND(MONTH(${cell})=MONTH(EDATE(TODAY(),0+1)),YEAR(${cell})=YEAR(EDATE(TODAY(),0+1)))`;
    case 'thisWeek': return `AND(TODAY()-${rounded}<=WEEKDAY(TODAY())-1,${rounded}-TODAY()<=7-WEEKDAY(TODAY()))`;
    case 'lastWeek': return `AND(TODAY()-${rounded}>=(WEEKDAY(TODAY())),TODAY()-${rounded}<(WEEKDAY(TODAY())+7))`;
    case 'nextWeek': return `AND(${rounded}-TODAY()>(7-WEEKDAY(TODAY())),${rounded}-TODAY()<(15-WEEKDAY(TODAY())))`;
    default: return `${day}=TODAY()`;
  }
}

interface BuiltRule {
  markup: string;
  /** An x14 extension rule (solid or negative-colored data bars). */
  extension?: string;
}

let generatedIds = 0;
function extensionId(): string {
  generatedIds = (generatedIds + 1) % 0xFFFF;
  const random = () => Math.floor(Math.random() * 0x10000).toString(16).toUpperCase().padStart(4, '0');
  return `{${random()}${random()}-${random()}-4${random().slice(1)}-${(0x8000 | generatedIds).toString(16).toUpperCase()}-${random()}${random()}${random()}}`;
}

/** Markup for a rule built or changed in the editor; undefined when Excel has no equivalent. */
function buildRule(rule: IConditionFormattingRule, priority: number, context: ConditionalFormatContext, sqref: string): BuiltRule | undefined {
  const config = rule.rule as IConditionalFormattingRuleConfig & Record<string, unknown>;
  const stop = rule.stopIfTrue ? ' stopIfTrue="1"' : '';
  const top = rule.ranges.length ? cellReference(Math.min(...rule.ranges.map(range => range.startRow)), Math.min(...rule.ranges.map(range => range.startColumn))) : 'A1';
  const formulas = (...items: string[]) => items.map(item => `<formula>${encodeXmlText(item)}</formula>`).join('');
  if (config.type === CFRuleType.highlightCell) {
    const dxf = ` dxfId="${context.dxf((config as { style?: IStyleData }).style ?? {})}"`;
    const head = (type: string, extra = '') => `<cfRule type="${type}"${dxf} priority="${priority}"${stop}${extra}>`;
    switch (config.subType) {
      case CFSubRuleType.number: {
        const value = config.value as number | [number, number] | undefined;
        const operands = Array.isArray(value) ? value.map(String) : [String(value ?? 0)];
        return { markup: `${head('cellIs', ` operator="${config.operator as string}"`)}${formulas(...operands)}</cfRule>` };
      }
      case CFSubRuleType.text: {
        const operator = config.operator as string;
        const value = String(config.value ?? '');
        if (operator === CFTextOperator.equal || operator === CFTextOperator.notEqual) {
          return { markup: `${head('cellIs', ` operator="${operator}"`)}${formulas(quoted(value))}</cfRule>` };
        }
        const formula = textRuleFormula(operator, value, top);
        if (!formula) return undefined;
        const text = [CFTextOperator.containsText, CFTextOperator.notContainsText, CFTextOperator.beginsWith, CFTextOperator.endsWith].includes(operator as CFTextOperator)
          ? ` operator="${operator === CFTextOperator.notContainsText ? 'notContains' : operator}" text="${encodeXmlAttribute(value)}"` : '';
        return { markup: `${head(operator, text)}${formulas(formula)}</cfRule>` };
      }
      case CFSubRuleType.timePeriod:
        return { markup: `${head('timePeriod', ` timePeriod="${config.operator as string}"`)}${formulas(timePeriodFormula(config.operator as string, top))}</cfRule>` };
      case CFSubRuleType.rank:
        return { markup: `${head('top10', `${config.isPercent ? ' percent="1"' : ''}${config.isBottom ? ' bottom="1"' : ''} rank="${Number(config.value ?? 10)}"`)}</cfRule>` };
      case CFSubRuleType.average: {
        const operator = config.operator as string;
        const below = operator === CFNumberOperator.lessThan || operator === CFNumberOperator.lessThanOrEqual;
        const equal = operator === CFNumberOperator.greaterThanOrEqual || operator === CFNumberOperator.lessThanOrEqual;
        return { markup: `${head('aboveAverage', `${below ? ' aboveAverage="0"' : ''}${equal ? ' equalAverage="1"' : ''}`)}</cfRule>` };
      }
      case CFSubRuleType.uniqueValues: return { markup: `${head('uniqueValues')}</cfRule>` };
      case CFSubRuleType.duplicateValues: return { markup: `${head('duplicateValues')}</cfRule>` };
      case CFSubRuleType.formula: return { markup: `${head('expression')}${formulas(formulaText(config.value))}</cfRule>` };
      default: return undefined;
    }
  }
  if (config.type === CFRuleType.colorScale) {
    const points = [...(config.config as { index: number; color: string; value: IValueConfig }[])].sort((a, b) => a.index - b.index);
    if (points.length < 2) return undefined;
    return {
      markup: `<cfRule type="colorScale" priority="${priority}"${stop}><colorScale>${points.map(point => cfvo(point.value)).join('')}${points.map(point => `<color rgb="${argb(point.color)}"/>`).join('')}</colorScale></cfRule>`,
    };
  }
  if (config.type === CFRuleType.dataBar) {
    const bar = config.config as { min: IValueConfig; max: IValueConfig; isGradient: boolean; positiveColor: string; nativeColor: string };
    const show = config.isShowValue === false ? ' showValue="0"' : '';
    const needsExtension = bar.isGradient === false || (bar.nativeColor && bar.nativeColor.toUpperCase() !== '#FF0000');
    const id = needsExtension ? extensionId() : undefined;
    const link = id ? `<extLst><ext uri="${X14_DATA_BAR}" xmlns:x14="${X14_NS}"><x14:id>${id}</x14:id></ext></extLst>` : '';
    const markup = `<cfRule type="dataBar" priority="${priority}"${stop}><dataBar${show}>${cfvo(bar.min)}${cfvo(bar.max)}<color rgb="${argb(bar.positiveColor, '638EC6')}"/></dataBar>${link}</cfRule>`;
    if (!id) return { markup };
    const x14Point = (value: IValueConfig, auto: string) => (value.type === CFValueType.min || value.type === CFValueType.max
      ? `<x14:cfvo type="${auto}"/>` : `<x14:cfvo type="${value.type}"><xm:f>${encodeXmlText(value.type === CFValueType.formula ? formulaText(value.value) : String(value.value ?? 0))}</xm:f></x14:cfvo>`);
    const extension = `<x14:conditionalFormatting xmlns:xm="${XM_NS}"><x14:cfRule type="dataBar" id="${id}"><x14:dataBar minLength="0" maxLength="100"${bar.isGradient === false ? ' gradient="0"' : ''}>`
      + `${x14Point(bar.min, 'autoMin')}${x14Point(bar.max, 'autoMax')}<x14:negativeFillColor rgb="${argb(bar.nativeColor, 'FF0000')}"/><x14:axisColor rgb="FF000000"/>`
      + `</x14:dataBar></x14:cfRule><xm:sqref>${sqref}</xm:sqref></x14:conditionalFormatting>`;
    return { markup, extension };
  }
  if (config.type === CFRuleType.iconSet) {
    const entries = config.config as { operator: string; value: IValueConfig; iconType: string; iconId: string }[];
    const count = entries.length;
    const set = entries.find(entry => ICON_SETS.has(entry.iconType) && entry.iconType !== IIconSetType.empty)?.iconType ?? IIconSetType.threeTrafficLights1;
    // Excel lists thresholds from the lowest bucket up; the first entry is the top bucket here.
    const points = entries.map((_entry, index) => entries[count - 1 - index]);
    const standard = (reverse: boolean) => entries.every((entry, position) => {
      const bucket = count - 1 - position;
      const excel = reverse ? count - 1 - bucket : bucket;
      return entry.iconType === set && entry.iconId === String(WORST_FIRST_ICON_SETS.has(set) ? excel : count - 1 - excel);
    });
    const reverse = !standard(false) && standard(true);
    const show = config.isShowValue === false ? ' showValue="0"' : '';
    return {
      markup: `<cfRule type="iconSet" priority="${priority}"${stop}><iconSet iconSet="${set}"${reverse ? ' reverse="1"' : ''}${show}>${points.map(point => cfvo(point.value, point.operator !== CFNumberOperator.greaterThan)).join('')}</iconSet></cfRule>`,
    };
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Rebuilding a sheet's conditional formats

function withPriority(markup: string, priority: number): string {
  const open = markup.match(/^<[^>]+>/)![0];
  return setXmlAttributes(open, { priority: String(priority) }) + markup.slice(open.length);
}

/** Rebase and move the formulas of an unchanged rule for its current ranges. */
function moveFormulas(markup: string, local: string, context: ConditionalFormatContext, before: CellRange[], after: CellRange[]): string {
  return mapElements(markup, local, element => {
    if (element.inner === undefined) return undefined;
    const formula = decodeXml(element.inner);
    const next = transformAnchoredFormula(formula, context.scope, context.maps, before, after);
    return next === formula ? undefined : `${element.open}${encodeXmlText(next)}</${element.name}>`;
  });
}

/** The worksheet's own extension list: its last child. */
function worksheetExtensionList(xml: string): { innerStart: number } | undefined {
  const close = /<\/((?:[\w.-]+:)?extLst)>\s*<\/(?:[\w.-]+:)?worksheet>\s*$/.exec(xml);
  if (!close) return undefined;
  const name = close[1];
  const open = xml.lastIndexOf(`<${name}`, close.index);
  if (open < 0) return undefined;
  const openEnd = xml.indexOf('>', open);
  return { innerStart: openEnd + 1 };
}

/** The worksheet with its conditional formats rebuilt from the model. */
export function rewriteConditionalFormats(xml: string, context: ConditionalFormatContext): string {
  const worksheet = firstXmlElement(xml, 'worksheet');
  const prefix = elementPrefix(worksheet?.name ?? '');
  // Drop every existing rule, main and Excel 2010 extension alike.
  let result = mapElements(xml, 'conditionalFormatting', element => (xmlAttribute(element.open, 'sqref') !== undefined ? null : undefined));
  result = mapElements(result, 'ext', element => (xmlAttribute(element.open, 'uri')?.toUpperCase() === X14_CONDITIONAL_FORMATS.toUpperCase() ? null : undefined));
  const byId = new Map(context.imported.map(item => [item.cfId, item]));
  const expected = expectedRules(context);
  const main: string[] = [];
  const extensions: string[] = [];
  context.current.forEach((rule, index) => {
    const priority = index + 1;
    const ranges = rule.ranges.map(range => ({ startRow: range.startRow, endRow: range.endRow, startColumn: range.startColumn, endColumn: range.endColumn }));
    if (!ranges.length) return;
    const sqref = sqrefText(ranges);
    const original = byId.get(rule.cfId);
    const moved = expected.get(rule.cfId);
    if (original && moved && sameSettings(moved, rule)) {
      const before = parseSqref(original.sqref);
      if (original.markup) main.push(`<conditionalFormatting sqref="${sqref}">${moveFormulas(withPriority(original.markup, priority), 'formula', context, before, ranges)}</conditionalFormatting>`);
      if (original.extensionMarkup) {
        const extension = original.markup ? original.extensionMarkup : withPriority(original.extensionMarkup, priority);
        extensions.push(`<x14:conditionalFormatting xmlns:xm="${XM_NS}">${moveFormulas(extension, 'f', context, before, ranges)}<xm:sqref>${sqref}</xm:sqref></x14:conditionalFormatting>`);
      }
      return;
    }
    const built = buildRule(rule, priority, context, sqref);
    if (!built) return;
    main.push(`<conditionalFormatting sqref="${sqref}">${built.markup}</conditionalFormatting>`);
    if (built.extension) extensions.push(built.extension);
  });
  // Extensions first: the worksheet's extension list is its last child, and rules about to be
  // inserted carry extension lists of their own.
  if (extensions.length) {
    const ext = `<ext uri="${X14_CONDITIONAL_FORMATS}" xmlns:x14="${X14_NS}"><x14:conditionalFormattings>${extensions.join('')}</x14:conditionalFormattings></ext>`;
    const list = worksheetExtensionList(result);
    if (list) {
      result = result.slice(0, list.innerStart) + ext + result.slice(list.innerStart);
    } else {
      const at = result.lastIndexOf('</');
      result = result.slice(0, at) + addElementPrefix('<extLst>', prefix) + ext + addElementPrefix('</extLst>', prefix) + result.slice(at);
    }
  }
  if (main.length) {
    const markup = addElementPrefix(main.join(''), prefix);
    const next = AFTER_CONDITIONAL_FORMATS.map(name => firstXmlElement(result, name)).filter(Boolean).sort((a, b) => a!.start - b!.start)[0];
    const at = next ? next.start : result.lastIndexOf('</');
    result = result.slice(0, at) + markup + result.slice(at);
  }
  // An emptied extension list would be invalid.
  return mapElements(result, 'extLst', element => (element.inner !== undefined && !element.inner.trim() ? null : undefined));
}
