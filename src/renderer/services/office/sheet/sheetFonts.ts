/** Widest digit of the default font as the grid will paint it, in CSS pixels. */
export function measureDigitWidth(family: string | undefined, sizePt: number | undefined): number | undefined {
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return undefined;
  context.font = `${sizePt ?? 11}pt "${family ?? 'Calibri'}", sans-serif`;
  const width = Math.max(...'0123456789'.split('').map(digit => context.measureText(digit).width));
  return Number.isFinite(width) && width > 0 ? Math.round(width * 100) / 100 : undefined;
}
