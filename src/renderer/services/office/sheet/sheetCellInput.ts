import { type ICellData, type IDisposable, type ITextRun, type Nullable, ThemeService, type Univer } from '@univerjs/core';
import { AFTER_CELL_EDIT, SheetInterceptorService } from '@univerjs/sheets';

/**
 * Univer's cell editor gives typed text the theme's default text color when the cell has no color
 * of its own, so typing into a cell's existing text stored the new characters as colored rich
 * text: nearly invisible in the dark theme and extra formatting in the file. Excel keeps such a
 * cell plain. The default color is dropped from what was typed, and a cell whose text has no other
 * formatting left is written as a plain value.
 */

/** Univer's default text color for the editors (DocMenuStyleService.getDefaultStyle). */
const DEFAULT_TEXT_COLOR = 'gray.900';
/** Runs before the number format and link handlers read the typed text. */
const PRIORITY = 1000;

const sameColor = (a: Nullable<string>, b: string) => Boolean(a) && a!.toLowerCase() === b.toLowerCase();

/** The runs without the default color; runs left with no style go. */
function withoutDefaultColor(runs: readonly ITextRun[], defaultColor: string): ITextRun[] {
  return runs.flatMap(run => {
    if (!sameColor(run.ts?.cl?.rgb, defaultColor)) return [run];
    const { cl: _cl, ...rest } = run.ts ?? {};
    return Object.keys(rest).length ? [{ ...run, ts: rest }] : [];
  });
}

/** A typed cell as Excel keeps it; `defaultColor` is the editor's default text color. */
export function plainTypedCell(cell: Nullable<ICellData>, defaultColor: string): Nullable<ICellData> {
  const body = cell?.p?.body;
  if (!cell?.p || !body?.textRuns?.some(run => sameColor(run.ts?.cl?.rgb, defaultColor))) return cell;
  const textRuns = withoutDefaultColor(body.textRuns, defaultColor);
  // Anything else that makes it rich text keeps the document (Univer's isRichText).
  const rich = textRuns.length > 0 || (body.paragraphs?.length ?? 0) > 1 || Boolean(body.paragraphs?.some(paragraph => paragraph.bullet))
    || Boolean(body.customRanges?.length) || Boolean(body.customBlocks?.length) || Boolean(body.customDecorations?.length);
  if (rich) return { ...cell, p: { ...cell.p, body: { ...body, textRuns } } };
  return { ...cell, p: null, v: body.dataStream.replace(/\r?\n$/, '').replace(/\r$/, ''), f: null, si: null };
}

export function installPlainTypedCells(univer: Univer): IDisposable {
  const injector = univer.__getInjector();
  const theme = injector.get(ThemeService);
  const remove = injector.get(SheetInterceptorService).writeCellInterceptor.intercept(AFTER_CELL_EDIT, {
    priority: PRIORITY,
    handler: (cell, _context, next) => next(plainTypedCell(cell, theme.getColorFromTheme(DEFAULT_TEXT_COLOR))),
  });
  return { dispose: () => { remove(); } };
}
