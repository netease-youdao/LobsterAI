import { strToU8 } from 'fflate';
import { describe, expect, test } from 'vitest';

import { sheetMaps, StructureAction, StructureAxis } from './sheetStructure';
import { editRichText, importNotes, noteChanges, rewriteNotes } from './xlsxNotes';
import { XlsxPackage } from './xlsxPackage';

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const THREADED = 'http://schemas.microsoft.com/office/2017/10/relationships/threadedComment';
const PERSON = 'http://schemas.microsoft.com/office/2017/10/relationships/person';

function workbook(): Map<string, Uint8Array> {
  const parts: Record<string, string> = {
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="${PERSON}" Target="persons/person.xml"/></Relationships>`,
    'xl/persons/person.xml': '<personList xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments"><person displayName="Ann" id="{A}"/><person displayName="Bo" id="{B}"/></personList>',
    'xl/worksheets/sheet1.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>',
    'xl/worksheets/_rels/sheet1.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/comments" Target="../comments1.xml"/><Relationship Id="rId2" Type="${THREADED}" Target="../threadedComments/threadedComment1.xml"/></Relationships>`,
    'xl/comments1.xml': '<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>tc={1}</author></authors><commentList><comment ref="A1" authorId="0"><text><t>[Threaded comment] Your version of Excel allows you to read this threaded comment</t></text></comment></commentList></comments>',
    'xl/threadedComments/threadedComment1.xml': '<ThreadedComments xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments"><threadedComment ref="A1" personId="{A}" id="{1}"><text>Is this final?</text></threadedComment><threadedComment ref="A1" personId="{B}" id="{2}" parentId="{1}"><text>Yes</text></threadedComment></ThreadedComments>',
  };
  return new Map(Object.entries(parts).map(([name, text]) => [name, strToU8(text)]));
}

describe('notes', () => {
  test('threaded comments show their conversation; editing makes a plain note, deleting drops the thread', () => {
    const files = workbook();
    const notes = importNotes(new XlsxPackage(files), 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'sheet-0');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ threaded: true, note: { row: 0, col: 0, note: 'Ann: Is this final?\nBo: Yes' } });
    const identity = sheetMaps([], 'sheet-0');
    const text = (name: string) => new TextDecoder().decode(files.get(name));

    const edited = noteChanges(notes, { 0: { 0: { ...notes[0].note, note: 'Final.' } } }, identity)!;
    rewriteNotes(files, 'xl/worksheets/sheet1.xml', text('xl/worksheets/sheet1.xml'), edited);
    expect(text('xl/threadedComments/threadedComment1.xml')).not.toContain('threadedComment ref=');
    expect(text('xl/comments1.xml')).toContain('<comment ref="A1" authorId="0"><text><t xml:space="preserve">Final.</t></text></comment>');

    const again = workbook();
    const removed = noteChanges(notes, {}, identity)!;
    rewriteNotes(again, 'xl/worksheets/sheet1.xml', new TextDecoder().decode(again.get('xl/worksheets/sheet1.xml')), removed);
    // The legacy copy goes too; emptied parts leave with their relationships.
    expect(again.has('xl/comments1.xml')).toBe(false);
    expect(again.has('xl/threadedComments/threadedComment1.xml')).toBe(false);
    expect(new TextDecoder().decode(again.get('xl/worksheets/_rels/sheet1.xml.rels'))).not.toContain('Relationship Id');
  });

  test('notes follow row edits before they are compared', () => {
    const files = workbook();
    const notes = importNotes(new XlsxPackage(files), 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'sheet-0');
    const inserted = sheetMaps([{ sheetId: 'sheet-0', axis: StructureAxis.Rows, action: StructureAction.Insert, index: 0, count: 2 }], 'sheet-0');
    expect(noteChanges(notes, { 2: { 0: { ...notes[0].note, row: 2 } } }, inserted)).toBeUndefined();
  });
});

describe('note text and moves', () => {
  const RICH = '<r><rPr><b/><sz val="9"/></rPr><t>Ann:</t></r><r><rPr><sz val="9"/></rPr><t xml:space="preserve">\nCheck the rate</t></r>';

  test('edits change only the words that changed, keeping each run\'s formatting', () => {
    expect(editRichText(RICH, 'Ann:\nCheck the new rate', '')).toBe('<r><rPr><b/><sz val="9"/></rPr><t xml:space="preserve">Ann:</t></r><r><rPr><sz val="9"/></rPr><t xml:space="preserve">\nCheck the new rate</t></r>');
    // Text typed at the start takes the formatting of what follows it.
    expect(editRichText(RICH, 'Bo:\nCheck the rate', '')).toBe('<r><rPr><b/><sz val="9"/></rPr><t xml:space="preserve">Bo:</t></r><r><rPr><sz val="9"/></rPr><t xml:space="preserve">\nCheck the rate</t></r>');
    // Removing the author leaves the body run.
    expect(editRichText(RICH, 'Check the rate', '')).toBe('<r><rPr><sz val="9"/></rPr><t xml:space="preserve">Check the rate</t></r>');
    expect(editRichText('<x:t>Old</x:t>', 'New', 'x:')).toBe('<x:t xml:space="preserve">New</x:t>');
    expect(editRichText('<x:r><x:rPr><x:b/></x:rPr><x:t>A</x:t></x:r><x:r><x:t>B</x:t></x:r>', 'AC', 'x:')).toBe('<x:r><x:rPr><x:b/></x:rPr><x:t xml:space="preserve">A</x:t></x:r><x:r><x:t xml:space="preserve">C</x:t></x:r>');
  });

  test('notes moved with their cells keep their comment, author and box', () => {
    const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const files = new Map(Object.entries({
      'xl/worksheets/sheet1.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/><legacyDrawing r:id="rId2"/></worksheet>',
      'xl/worksheets/_rels/sheet1.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/comments" Target="../comments1.xml"/><Relationship Id="rId2" Type="${REL}/vmlDrawing" Target="../drawings/vmlDrawing1.vml"/></Relationships>`,
      'xl/comments1.xml': `<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>Ann</author></authors><commentList><comment ref="A2" authorId="0"><text>${RICH}</text></comment><comment ref="A3" authorId="0"><text><t>Second</t></text></comment></commentList></comments>`,
      'xl/drawings/vmlDrawing1.vml': '<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:x="urn:schemas-microsoft-com:office:excel">'
        + '<v:shape id="_x0000_s1025" style="width:120pt;height:60pt;visibility:hidden"><x:ClientData ObjectType="Note"><x:Anchor> 1, 15, 0, 10, 3, 15, 4, 4</x:Anchor><x:Row>1</x:Row><x:Column>0</x:Column></x:ClientData></v:shape>'
        + '<v:shape id="_x0000_s1026" style="width:120pt;height:60pt;visibility:hidden"><x:ClientData ObjectType="Note"><x:Anchor> 1, 15, 1, 10, 3, 15, 5, 4</x:Anchor><x:Row>2</x:Row><x:Column>0</x:Column></x:ClientData></v:shape></xml>',
    }).map(([name, text]) => [name, strToU8(text)]));
    const text = (name: string) => new TextDecoder().decode(files.get(name));
    const notes = importNotes(new XlsxPackage(files), 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'sheet-0');
    const [first, second] = notes.map(item => item.note);
    // A sort swapped rows 2 and 3 and the first note was then edited.
    const current = { 1: { 0: { ...second, row: 1 } }, 2: { 0: { ...first, row: 2, note: 'Ann:\nCheck the new rate' } } };
    const changes = noteChanges(notes, current, sheetMaps([], 'sheet-0'))!;
    expect([...changes.kept].map(([from, kept]) => [from, kept.to])).toEqual([['1:0', '2:0'], ['2:0', '1:0']]);
    rewriteNotes(files, 'xl/worksheets/sheet1.xml', text('xl/worksheets/sheet1.xml'), changes);
    const comments = text('xl/comments1.xml');
    expect(comments).toContain('<comment ref="A3" authorId="0"><text><r><rPr><b/><sz val="9"/></rPr><t xml:space="preserve">Ann:</t></r><r><rPr><sz val="9"/></rPr><t xml:space="preserve">\nCheck the new rate</t></r></text></comment>');
    expect(comments).toContain('<comment ref="A2" authorId="0"><text><t>Second</t></text></comment>');
    expect(comments).not.toContain('LobsterAI');
    const vml = text('xl/drawings/vmlDrawing1.vml');
    expect(vml).toContain('<x:Anchor> 1, 15, 1, 10, 3, 15, 5, 4</x:Anchor><x:Row>2</x:Row>');
    expect(vml).toContain('<x:Anchor> 1, 15, 0, 10, 3, 15, 4, 4</x:Anchor><x:Row>1</x:Row>');
  });

  test('threads follow their cells, and a moved thread edited becomes a note there', () => {
    const files = workbook();
    const notes = importNotes(new XlsxPackage(files), 'xl/workbook.xml', 'xl/worksheets/sheet1.xml', 'sheet-0');
    const text = (name: string) => new TextDecoder().decode(files.get(name));
    const identity = sheetMaps([], 'sheet-0');
    const moved = noteChanges(notes, { 4: { 0: { ...notes[0].note, row: 4 } } }, identity)!;
    const copy = new Map(files);
    rewriteNotes(copy, 'xl/worksheets/sheet1.xml', text('xl/worksheets/sheet1.xml'), moved);
    const decoded = (name: string) => new TextDecoder().decode(copy.get(name));
    expect(decoded('xl/threadedComments/threadedComment1.xml').match(/ref="A5"/g)).toHaveLength(2);
    expect(decoded('xl/comments1.xml')).toContain('<comment ref="A5" authorId="0"><text><t>[Threaded comment]');

    const converted = noteChanges(notes, { 4: { 0: { ...notes[0].note, row: 4, note: 'Done' } } }, identity)!;
    rewriteNotes(files, 'xl/worksheets/sheet1.xml', text('xl/worksheets/sheet1.xml'), converted);
    expect(files.has('xl/threadedComments/threadedComment1.xml')).toBe(false);
    expect(text('xl/comments1.xml')).toContain('<comment ref="A5" authorId="0"><text><t xml:space="preserve">Done</t></text></comment>');
  });
});
