import React, { useEffect, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

import { ToolbarPopoverPanel, useToolbarPopover } from './SheetPopover';

const t = (key: string) => i18nService.t(key);

/** Excel's standard colors, under the theme colors. */
const STANDARD_COLORS = ['#C00000', '#FF0000', '#FFC000', '#FFFF00', '#92D050', '#00B050', '#00B0F0', '#0070C0', '#002060', '#7030A0'];

export const ColorTarget = { Font: 'font', Fill: 'fill' } as const;
export type ColorTarget = typeof ColorTarget[keyof typeof ColorTarget];

/** Excel's colors before one is picked: red text, yellow fill. */
const FIRST_COLOR: Record<ColorTarget, string> = { [ColorTarget.Font]: '#FF0000', [ColorTarget.Fill]: '#FFFF00' };
const LABELS: Record<ColorTarget, { button: string; menu: string; none: string }> = {
  [ColorTarget.Font]: { button: 'sheetFontColor', menu: 'sheetFontColorMenu', none: 'sheetColorAutomatic' },
  [ColorTarget.Fill]: { button: 'sheetFillColor', menu: 'sheetFillColorMenu', none: 'sheetNoFill' },
};
const PALETTE_WIDTH = 236;
/** Excel's automatic font color is black; "No Fill" has no swatch color. */
const AUTOMATIC_SWATCH: Record<ColorTarget, string | undefined> = { [ColorTarget.Font]: '#000000', [ColorTarget.Fill]: undefined };

/** A swatch; pressing it keeps the focus in the grid, as Excel's palette does. */
function Swatch({ color, onPick }: { color: string; onPick: (color: string) => void }): React.ReactElement {
  return (
    <button type="button" className="lobster-sheet-swatch" style={{ background: color }} title={color} aria-label={color}
      onMouseDown={event => event.preventDefault()} onClick={() => onPick(color)} />
  );
}

/** Any other color, from the system picker: applied once when the picker closes, as one undo step. */
function MoreColors({ initial, onPick }: { initial: string; onPick: (color: string) => void }): React.ReactElement {
  const input = useRef<HTMLInputElement>(null);
  const pick = useRef(onPick);
  pick.current = onPick;
  useEffect(() => {
    const element = input.current;
    if (!element) return undefined;
    const changed = () => pick.current(element.value);
    element.addEventListener('change', changed);
    return () => element.removeEventListener('change', changed);
  }, []);
  return (
    <label className="lobster-sheet-palette-more">
      <input ref={input} type="color" defaultValue={initial.toLowerCase()} />
      {t('sheetMoreColors')}
    </label>
  );
}

/**
 * Excel's color palette: automatic or no color, the theme colors with their lighter and darker
 * variants, the standard colors and any other color. `noneSwatch` is the color "Automatic" stands
 * for; "No Fill" has none.
 */
function ColorPalette({ themeColors, noneLabel, noneSwatch, initial, onPick }: {
  themeColors: string[][]; noneLabel: string; noneSwatch?: string; initial: string; onPick: (color: string | null) => void;
}): React.ReactElement {
  const rows = themeColors[0]?.map((_, row) => themeColors.map(column => column[row])) ?? [];
  const swatch = (color: string, key: React.Key) => <Swatch key={key} color={color} onPick={onPick} />;
  return (
    <>
      <button type="button" className="lobster-sheet-palette-none" onMouseDown={event => event.preventDefault()} onClick={() => onPick(null)}>
        <span className={`lobster-sheet-swatch${noneSwatch ? '' : ' lobster-sheet-swatch-none'}`} style={noneSwatch ? { background: noneSwatch } : undefined} aria-hidden="true" />
        {noneLabel}
      </button>
      {rows.length > 0 && (
        <>
          <span className="lobster-sheet-palette-title">{t('sheetThemeColors')}</span>
          <div className="lobster-sheet-palette-grid">{rows[0].map((color, column) => swatch(color, column))}</div>
          <div className="lobster-sheet-palette-grid">{rows.slice(1).flatMap((row, index) => row.map((color, column) => swatch(color, `${index}-${column}`)))}</div>
        </>
      )}
      <span className="lobster-sheet-palette-title">{t('sheetStandardColors')}</span>
      <div className="lobster-sheet-palette-grid">{STANDARD_COLORS.map(color => swatch(color, color))}</div>
      <MoreColors initial={initial} onPick={onPick} />
    </>
  );
}

/**
 * Excel's font and fill color buttons: the button applies the color used last, the arrow opens the
 * palette of theme colors (with their lighter and darker variants), standard colors, automatic or
 * no fill, and any other color.
 */
export function SheetColorButton({ target, themeColors, disabled, onPick }: {
  target: ColorTarget; themeColors: string[][]; disabled: boolean; onPick: (color: string | null) => void;
}): React.ReactElement {
  const [last, setLast] = useState(FIRST_COLOR[target]);
  const popover = useToolbarPopover(PALETTE_WIDTH);
  const labels = LABELS[target];
  const pick = (color: string | null) => {
    if (color) setLast(color.toUpperCase());
    popover.setOpen(false);
    onPick(color);
  };
  return (
    <span className="lobster-sheet-split">
      <button type="button" title={t(labels.button)} aria-label={t(labels.button)} disabled={disabled}
        onMouseDown={event => event.preventDefault()} onClick={() => pick(last)}>
        {target === ColorTarget.Font
          ? <span className="lobster-sheet-font-color" style={{ borderBottomColor: last }}>A</span>
          : <span className="lobster-sheet-fill" style={{ background: last }} />}
      </button>
      <button ref={popover.trigger} type="button" className="lobster-sheet-split-arrow" title={t(labels.menu)} aria-label={t(labels.menu)} aria-expanded={popover.open}
        disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => popover.setOpen(value => !value)}>▾</button>
      <ToolbarPopoverPanel popover={popover} label={t(labels.menu)} width={PALETTE_WIDTH}>
        <ColorPalette themeColors={themeColors} noneLabel={t(labels.none)} noneSwatch={AUTOMATIC_SWATCH[target]} initial={last} onPick={pick} />
      </ToolbarPopoverPanel>
    </span>
  );
}
