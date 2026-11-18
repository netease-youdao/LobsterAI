import { describe, expect, test } from 'vitest';

import { makeSlidesFixture, nodeXmlCodec, SLIDES_FIXTURE_PARTS } from '../../../../../tests/fixtures/slides';
import { SlidesHistory } from './slidesHistory';
import { SlidesPackage } from './slidesPackage';
import { el } from './slidesXml';

const open = async () => SlidesPackage.open(await makeSlidesFixture(), nodeXmlCodec);
/** A step that names the first slide. */
const rename = (pkg: SlidesPackage, name: string) => pkg.transaction(() => el(pkg.edit(SLIDES_FIXTURE_PARTS.slide1).documentElement, 'p:cSld')!.setAttribute('name', name)).change;
const nameOf = (pkg: SlidesPackage) => el(pkg.xml(SLIDES_FIXTURE_PARTS.slide1).documentElement, 'p:cSld')!.getAttribute('name');

describe('slide history', () => {
  test('undoes and redoes steps, merging consecutive ones with the same key', async () => {
    const pkg = await open();
    const history = new SlidesHistory<string>();
    history.record(rename(pkg, 'a'), 'view-0', 'view-1');
    history.record(rename(pkg, 'ab'), 'view-1', 'view-2', 'typing');
    history.record(rename(pkg, 'abc'), 'view-2', 'view-3', 'typing');
    expect(history.undo(pkg)).toMatchObject({ before: 'view-1', after: 'view-3' });
    expect(nameOf(pkg)).toBe('a');
    expect(history.redo(pkg)?.after).toBe('view-3');
    expect(nameOf(pkg)).toBe('abc');
    history.undo(pkg);
    history.undo(pkg);
    expect(nameOf(pkg)).toBeFalsy();
    expect(history.canUndo).toBe(false);
    // A new step drops what could be redone.
    history.record(rename(pkg, 'x'), 'view-0', 'view-1');
    expect(history.canRedo).toBe(false);
  });

  test('ignores changes that change nothing and keeps at most the limit', async () => {
    const pkg = await open();
    const history = new SlidesHistory<number>(2);
    expect(history.record(pkg.transaction(() => pkg.edit(SLIDES_FIXTURE_PARTS.slide1)).change, 0, 0)).toBeUndefined();
    for (const name of ['1', '2', '3']) history.record(rename(pkg, name), 0, 0);
    history.undo(pkg);
    history.undo(pkg);
    expect(history.undo(pkg)).toBeUndefined();
    expect(nameOf(pkg)).toBe('1');
  });

  test('takes steps back out as if they never happened', async () => {
    const pkg = await open();
    const history = new SlidesHistory<number>();
    history.record(rename(pkg, 'kept'), 0, 1);
    const inserted = history.record(rename(pkg, 'inserted'), 1, 2)!;
    history.record(rename(pkg, 'typed'), 2, 3, 'typing');
    expect(history.revertTo(pkg, inserted)).toBe(true);
    expect(nameOf(pkg)).toBe('kept');
    expect(history.canRedo).toBe(false);
    expect(history.revertTo(pkg, inserted)).toBe(false);
  });
});
