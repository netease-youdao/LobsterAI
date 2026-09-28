import { OfficeFileError } from '../../../shared/office/core/officeFile';
import {
  SHEET_PACKAGE_LIMITS, SheetHiddenContent, type SheetPackageInfo, SheetReadOnlyReason,
} from '../../../shared/office/sheet/sheetFile';
import { OfficePackageException, packageRelationships, readOfficeZip } from '../core/officeZip';

const OFFICE_DOCUMENT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
const STRICT_NAMESPACE = 'http://purl.oclc.org/ooxml/spreadsheetml/main';
const WORKBOOK_CONTENT = /spreadsheetml\.(sheet|template)\.main\+xml|ms-excel\.(sheet|template)\.macroEnabled\.main\+xml/;
const MACRO_CONTENT = /macroEnabled\.main\+xml/;
const PREFIX = '(?:[^\\s<>/=:]+:)?';
const SHEET_PROTECTION = new RegExp(`<${PREFIX}sheetProtection\\b(?:[^"'>]|"[^"]*"|'[^']*')*\\ssheet\\s*=\\s*["'](?:1|true)["']`);
/** Array, data-table and dynamic-array formulas span cells the editor cannot keep consistent. */
const ARRAY_FORMULA = new RegExp(`<${PREFIX}f\\b[^>]*\\st\\s*=\\s*["'](?:array|dataTable)["']|<${PREFIX}c\\b[^>]*\\scm\\s*=`);

function fail(code: OfficeFileError, message: string): never {
  throw new OfficePackageException(code, message);
}

/**
 * Admission for in-place workbook editing. Malformed, encrypted and strict-OOXML packages are
 * refused. Pivot tables, array formulas, protection, external links, data connections,
 * signatures and macros open read only. Chart sheets are kept untouched but not shown.
 */
export function inspectSheetPackage(bytes: Uint8Array): SheetPackageInfo {
  const { names, xml } = readOfficeZip(bytes, SHEET_PACKAGE_LIMITS);
  const types = xml.get('[Content_Types].xml');
  if (!types || !WORKBOOK_CONTENT.test(types)) fail(OfficeFileError.InvalidFile, 'Not a spreadsheet package');
  const workbookPart = packageRelationships(xml.get('_rels/.rels'), '').find(relation => relation.type === OFFICE_DOCUMENT && !relation.external)?.target;
  const workbook = workbookPart ? xml.get(workbookPart) : undefined;
  if (!workbook) fail(OfficeFileError.InvalidFile, 'Missing workbook part');
  if (workbook.includes(STRICT_NAMESPACE)) fail(OfficeFileError.Unsupported, 'Strict Open XML workbooks are not supported');

  const readOnly = new Set<SheetReadOnlyReason>();
  const hidden = new Set<SheetHiddenContent>();
  if (MACRO_CONTENT.test(types)) readOnly.add(SheetReadOnlyReason.Macros);
  for (const name of names) {
    const lower = name.toLowerCase();
    if (/^xl\/pivot(tables|cache)\//.test(lower)) readOnly.add(SheetReadOnlyReason.PivotTables);
    if (lower.startsWith('xl/externallinks/')) readOnly.add(SheetReadOnlyReason.ExternalLinks);
    if (lower === 'xl/connections.xml' || lower.startsWith('xl/querytables/')) readOnly.add(SheetReadOnlyReason.DataConnections);
    if (lower.startsWith('_xmlsignatures/')) readOnly.add(SheetReadOnlyReason.Signature);
    if (lower.endsWith('vbaproject.bin')) readOnly.add(SheetReadOnlyReason.Macros);
    if (lower.startsWith('xl/chartsheets/')) hidden.add(SheetHiddenContent.ChartSheets);
  }
  for (const [name, text] of xml) {
    if (!/^xl\/worksheets\/[^/]+\.xml$/i.test(name)) continue;
    if (SHEET_PROTECTION.test(text)) readOnly.add(SheetReadOnlyReason.Protection);
    if (ARRAY_FORMULA.test(text)) readOnly.add(SheetReadOnlyReason.ArrayFormulas);
  }
  return { readOnly: [...readOnly].sort(), hidden: [...hidden].sort() };
}
