import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { BLOCKED_SHEET_COMMAND, SHEET_MENU_CONFIG } from './sheetCommandPolicy';

/** Every sheet command id the installed Univer build registers, so an upgrade cannot slip past the policy. */
function univerCommandIds(): string[] {
  const root = path.resolve(__dirname, '../../../../../node_modules/@univerjs');
  const ids = new Set<string>();
  for (const pkg of ['sheets', 'sheets-ui', 'sheets-formula', 'sheets-formula-ui', 'sheets-numfmt', 'sheets-numfmt-ui']) {
    const source = fs.readFileSync(path.join(root, pkg, 'lib/es/index.js'), 'utf8');
    for (const match of source.matchAll(/"(sheet\.command\.[a-z0-9-]+)"/g)) ids.add(match[1]);
  }
  return [...ids].sort();
}

const STILL_REFUSED = /^sheet\.command\.(insert-range|delete-range|move-(rows|cols)|set-worksheet-(right-to-left|default-style)|set-gridlines-color)/;
const ALLOWED = [
  'sheet.command.set-range-values', 'sheet.command.set-style', 'sheet.command.set-range-bold', 'sheet.command.set-range-italic',
  'sheet.command.set-range-underline', 'sheet.command.set-range-stroke', 'sheet.command.set-range-font-family', 'sheet.command.set-range-fontsize',
  'sheet.command.set-range-text-color', 'sheet.command.set-background-color', 'sheet.command.set-border-basic', 'sheet.command.set-text-wrap',
  'sheet.command.set-horizontal-text-align', 'sheet.command.set-vertical-text-align', 'sheet.command.set-text-rotation',
  'sheet.command.add-worksheet-merge', 'sheet.command.add-worksheet-merge-all', 'sheet.command.remove-worksheet-merge',
  'sheet.command.set-worksheet-col-width', 'sheet.command.set-row-height', 'sheet.command.delta-column-width', 'sheet.command.delta-row-height',
  'sheet.command.set-col-hidden', 'sheet.command.set-rows-hidden', 'sheet.command.set-selected-rows-visible', 'sheet.command.set-selected-cols-visible',
  'sheet.command.auto-fill', 'sheet.command.clear-selection-content', 'sheet.command.clear-selection-format', 'sheet.command.clear-selection-all',
  'sheet.command.move-range', 'sheet.command.move-range-confirm', 'sheet.command.paste-value', 'sheet.command.paste-format',
  'sheet.command.set-worksheet-activate', 'sheet.command.set-zoom-ratio', 'sheet.command.move-selection', 'sheet.command.select-all',
  'sheet.command.apply-format-painter', 'sheet.command.text-to-number', 'sheet.command.set-col-auto-width', 'sheet.command.set-row-is-auto-height',
  // Structure the writer carries, checked per workbook by the structure tracker.
  'sheet.command.insert-row-before', 'sheet.command.insert-row-after', 'sheet.command.insert-multi-rows-above', 'sheet.command.insert-row-by-range',
  'sheet.command.insert-col-before', 'sheet.command.insert-multi-cols-right', 'sheet.command.insert-col-by-range',
  'sheet.command.remove-row-confirm', 'sheet.command.remove-row-by-range', 'sheet.command.remove-col-confirm', 'sheet.command.remove-col-by-range',
  'sheet.command.insert-sheet', 'sheet.command.remove-sheet', 'sheet.command.copy-sheet', 'sheet.command.set-worksheet-name',
  'sheet.command.set-worksheet-order', 'sheet.command.set-worksheet-hidden', 'sheet.command.set-worksheet-show', 'sheet.command.set-tab-color',
  'sheet.command.toggle-gridlines', 'sheet.command.set-selection-frozen', 'sheet.command.set-first-row-frozen', 'sheet.command.cancel-frozen',
];

describe('sheet command policy', () => {
  test('refuses every command the writer cannot carry, including suffixed variants', () => {
    const ids = univerCommandIds();
    expect(ids.length).toBeGreaterThan(100);
    const refused = ids.filter(id => STILL_REFUSED.test(id));
    expect(refused).toContain('sheet.command.insert-range-move-down-confirm');
    expect(refused.filter(id => !BLOCKED_SHEET_COMMAND.test(id))).toEqual([]);
    for (const id of ['sheet.command.delete-range-move-up-confirm', 'sheet.command.move-rows', 'sheet.command.insert-defined-name',
      'sheet.command.add-range-protection', 'sheet.command.set-col-data', 'sheet.command.set-worksheet-right-to-left']) {
      expect(BLOCKED_SHEET_COMMAND.test(id), id).toBe(true);
    }
  });

  test('keeps the editing, formatting and layout commands the writer supports', () => {
    const ids = new Set(univerCommandIds());
    for (const id of ALLOWED) {
      expect(ids.has(id), `${id} still exists in Univer`).toBe(true);
      expect(BLOCKED_SHEET_COMMAND.test(id), id).toBe(false);
    }
  });

  test('hides the menu entries of refused commands', () => {
    for (const id of Object.keys(SHEET_MENU_CONFIG)) {
      if (id.startsWith('sheet.command.')) expect(BLOCKED_SHEET_COMMAND.test(id), id).toBe(true);
    }
  });
});
