import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  type AutomationHost, type AutomationOperation, type AutomationValue, createServerAutomationHost,
} from '@docx-editor.dev/core/automation';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { inspectWordPackage } from '../src/main/office/word/wordPackage';
import { makeWordFixture } from './fixtures/word';

const requestedFilename = 'brief.docx';
const documentTitle = '场地交接';

function readWordValue<K extends AutomationValue['kind']>(host: AutomationHost, op: AutomationOperation, kind: K) {
  const [result] = host.execute({ operations: [op] }).results;
  if (result?.status !== 'ok' || result.value.kind !== kind) throw new Error(`Could not read ${op.op}`);
  return result.value as Extract<AutomationValue, { kind: K }>;
}

function readMemoTitle(host: AutomationHost): string | undefined {
  const { handle: document } = readWordValue(host, { op: 'getDocument' }, 'handle');
  const { handle: body } = readWordValue(host, { op: 'getBody', document }, 'handle');
  const { handles } = readWordValue(host, { op: 'getParagraphs', body }, 'handles');
  const opening = [];
  for (const paragraph of handles) {
    const text = readWordValue(host, { op: 'getText', target: paragraph }, 'text').text.trim();
    if (!text) continue;
    const span = { paragraph };
    const { name } = readWordValue(host, { op: 'getStyle', span }, 'style');
    if (name && /^(?:title|标题)$/iu.test(name)) return text;
    // Look for an explicit Title throughout the memo, but only infer one from its opening.
    if (opening.length === 2) continue;
    const { font } = readWordValue(host, { op: 'getFont', span }, 'font');
    opening.push({ text, style: name ?? '', size: font.size });
  }
  const styled = opening.find(p => /^(?:heading|标题)\s*1$/iu.test(p.style));
  if (styled) return styled.text;
  const [first, second] = opening;
  if (first?.size != null && second?.size != null && second.size > first.size) return second.text;
  return first?.text;
}

async function checkMemoDelivery(directory: string): Promise<void> {
  // A direct file read can also succeed for the wrong capitalization on macOS and Windows.
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = entries.filter(entry => entry.isFile()).map(entry => entry.name);
  expect(files, `Expected ${requestedFilename} directly in ${directory}`).toContain(requestedFilename);

  const bytes = await fs.readFile(path.join(directory, requestedFilename));
  inspectWordPackage(bytes);
  const opened = createServerAutomationHost(bytes);
  if (!opened.ok) throw new Error(`Could not open ${requestedFilename}: ${opened.reason}`);
  try {
    expect(readMemoTitle(opened.host), 'Visible Word document title').toBe(documentTitle);
  } finally {
    opened.host.dispose();
  }
}

// For a model run, copy fixtures/cowork-docx-delivery/input/ into a fresh session cwd
// and submit fixtures/cowork-docx-delivery/prompt.txt. Grade the untouched output with
// LOBSTERAI_DOCX_DELIVERY_DIR=<cwd> npm test -- tests/coworkDocxDelivery.test.ts -t 'delivered memo'
const deliveredDirectory = process.env.LOBSTERAI_DOCX_DELIVERY_DIR;
test.runIf(deliveredDirectory)('opens the delivered memo from the model run', async () => {
  await checkMemoDelivery(deliveredDirectory!);
});

describe('memo delivery grader', () => {
  let directory: string;
  beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lobster-memo-')); });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

  test.each(['场地交接.docx', 'Brief.docx', 'exports/brief.docx'])(
    'rejects a valid Word file at %s and accepts the same bytes at the requested path',
    async wrongPath => {
      const filePath = path.join(directory, wrongPath);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const bytes = await makeWordFixture(documentTitle);
      await fs.writeFile(filePath, bytes);
      await expect(checkMemoDelivery(directory)).rejects.toThrow(`Expected ${requestedFilename} directly`);
      await fs.unlink(filePath);
      await fs.writeFile(path.join(directory, requestedFilename), bytes);
      await checkMemoDelivery(directory);
    },
  );

  test('rejects plain text bearing the correct filename and title', async () => {
    await fs.writeFile(path.join(directory, requestedFilename), documentTitle);
    await expect(checkMemoDelivery(directory)).rejects.toThrow('Not a ZIP archive');
  });

  test('rejects a Word file whose document title is the filename stem', async () => {
    await fs.writeFile(path.join(directory, requestedFilename), await makeWordFixture('brief'));
    await expect(checkMemoDelivery(directory)).rejects.toThrow('Visible Word document title');
  });

  test.each([
    ['a larger display title', '<w:p><w:r><w:rPr><w:b/><w:sz w:val="44"/></w:rPr><w:t>场地交接</w:t></w:r></w:p>'],
    ['a Heading 1 title', '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>场地交接</w:t></w:r></w:p>'],
  ])('reads %s beneath a smaller cover label', async (_label, heading) => {
    const coverLabel = '<w:p><w:r><w:rPr><w:b/><w:sz w:val="20"/></w:rPr><w:t>备忘录</w:t></w:r></w:p>';
    await writeMemoBody(directory, coverLabel + heading);
    await checkMemoDelivery(directory);
  });

  test('uses the document Title style even after several lines of cover metadata', async () => {
    const labels = '<w:p><w:r><w:t>活动管理组</w:t></w:r></w:p><w:p><w:r><w:t>内部备忘录</w:t></w:r></w:p>';
    const title = '<w:p><w:pPr><w:pStyle w:val="MemoTitle"/></w:pPr><w:r><w:t>场地交接</w:t></w:r></w:p>';
    await writeMemoBody(directory, labels + title, {
      'word/styles.xml': '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        + '<w:style w:type="paragraph" w:styleId="MemoTitle"><w:name w:val="Title"/></w:style></w:styles>',
    });
    await checkMemoDelivery(directory);
  });

  test('rejects an exact title match in the body below a different display title', async () => {
    const wrongTitle = '<w:p><w:r><w:rPr><w:b/><w:sz w:val="44"/></w:rPr><w:t>采购进度</w:t></w:r></w:p>';
    const body = '<w:p><w:r><w:rPr><w:sz w:val="22"/></w:rPr><w:t>场地交接</w:t></w:r></w:p>';
    await writeMemoBody(directory, wrongTitle + body);
    await expect(checkMemoDelivery(directory)).rejects.toThrow('Visible Word document title');
  });
});

async function writeMemoBody(directory: string, body: string, extraParts: Record<string, string> = {}): Promise<void> {
  const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const bytes = await makeWordFixture('', {
    ...extraParts,
    'word/document.xml': `<w:document xmlns:w="${ns}"><w:body>${body}<w:sectPr/></w:body></w:document>`,
  });
  await fs.writeFile(path.join(directory, requestedFilename), bytes);
}
