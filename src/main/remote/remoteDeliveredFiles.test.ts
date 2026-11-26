import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureDeliveryBaseline, changedDeliveredFile, deliveredFileDeclarations, deliveredFileLinks, REMOTE_DELIVERY_BASELINE_BUDGET_MS, RemoteFileDeliveryKind } from './remoteDeliveredFiles';

const roots: string[] = [];
const current = (): boolean => true;
function directory(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remote-delivery-')));
  roots.push(root);
  return root;
}
const identity = (file: string): string => {
  const stat = fs.statSync(file);
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
};
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('remote delivered file evidence', () => {
  it('a background scan cannot claim a directory or file changed after dispatch as its baseline', async () => {
    const root = directory(), beforeDispatch = Date.now() - 1000;
    fs.writeFileSync(path.join(root,'output.md'),'already generated after dispatch');
    const baseline = await captureDeliveryBaseline([root],current,beforeDispatch);
    expect(baseline.directories).toEqual([]);
    expect(await changedDeliveredFile(baseline,path.join(root,'output.md'),Date.now()+1,current)).toBeNull();
  });

  it('admits new and changed direct files but leaves unchanged references local', async () => {
    const root = directory(), old = path.join(root, 'old.md'), changed = path.join(root, 'changed.md');
    fs.writeFileSync(old, 'existing reference'); fs.writeFileSync(changed, 'old');
    const baseline = await captureDeliveryBaseline([root, root], current);
    expect(baseline.directories).toHaveLength(1);
    const created = path.join(root, '口算题100道.md');
    fs.writeFileSync(created, '100 problems'); fs.writeFileSync(changed, 'new output');
    const finishedAt = Date.now() + 1;
    expect(await changedDeliveredFile(baseline, old, finishedAt, current)).toBeNull();
    expect(await changedDeliveredFile(baseline, created, finishedAt, current)).toEqual({
      filePath: created, identity: identity(created), sizeBytes: '12',
      directories: [{ path: root, identity: `${fs.statSync(root).dev}:${fs.statSync(root).ino}` }],
    });
    expect(await changedDeliveredFile(baseline, changed, finishedAt, current)).toMatchObject({ identity: identity(changed) });
  });

  it('never discovers nested files, unsupported files, empty files, or oversized files', async () => {
    const root = directory(); fs.mkdirSync(path.join(root, 'nested'));
    const baseline = await captureDeliveryBaseline([root], current);
    for (const file of ['nested/report.md', 'index.html', 'empty.md', 'large.md']) {
      const target = path.join(root, file); fs.writeFileSync(target, file === 'empty.md' ? '' : 'output');
      if (file === 'large.md') fs.truncateSync(target, 5 * 1024 * 1024 + 1);
      expect(await changedDeliveredFile(baseline, target, Date.now() + 1, current)).toBeNull();
    }
  });

  it('rejects symlink directories, symlink files, and replaced directories', async () => {
    const root = directory(), external = directory(), alias = path.join(root, 'alias');
    fs.symlinkSync(external, alias, 'dir');
    expect((await captureDeliveryBaseline([alias], current)).directories).toHaveLength(0);
    const priorLink = path.join(root, 'prior.md'); fs.symlinkSync(path.join(external, 'prior.md'), priorLink);
    const baseline = await captureDeliveryBaseline([root], current);
    fs.writeFileSync(path.join(external, 'out.md'), 'outside');
    const link = path.join(root, 'out.md'); fs.symlinkSync(path.join(external, 'out.md'), link);
    expect(await changedDeliveredFile(baseline, link, Date.now() + 1, current)).toBeNull();
    fs.unlinkSync(priorLink); fs.writeFileSync(priorLink, 'replaced symlink');
    expect(await changedDeliveredFile(baseline, priorLink, Date.now() + 1, current)).toBeNull();
    const moved = path.join(external, 'moved'); fs.renameSync(root, moved); fs.mkdirSync(root);
    const output = path.join(root, 'new.md'); fs.writeFileSync(output, 'new directory');
    expect(await changedDeliveredFile(baseline, output, Date.now() + 1, current)).toBeNull();
  });

  it('counts all directory entries, including unsupported files, before admitting absence', async () => {
    const root = directory();
    for (let index = 0; index < 257; index++) fs.writeFileSync(path.join(root, `${index}.unsupported`), '');
    const baseline = await captureDeliveryBaseline([root], current);
    expect(baseline.directories).toHaveLength(0);
    const output = path.join(root, 'new.md'); fs.writeFileSync(output, 'output');
    expect(await changedDeliveredFile(baseline, output, Date.now() + 1, current)).toBeNull();
  });

  it('does not inspect roots beyond the two explicitly supplied slots', async () => {
    const first = directory(), second = directory(), third = directory();
    const baseline = await captureDeliveryBaseline([first, second, third], current);
    expect(baseline.directories.map(item => item.path)).toEqual([first, second]);
    const output = path.join(third, 'out.md'); fs.writeFileSync(output, 'output');
    expect(await changedDeliveredFile(baseline, output, Date.now() + 1, current)).toBeNull();
  });

  it('returns at its deadline and never accepts a late filesystem result', async () => {
    const root = directory();
    let release: ((value: fs.Stats) => void) | undefined;
    const stat = fs.statSync(root);
    const delayed = new Promise<fs.Stats>(resolve => { release = resolve; });
    vi.spyOn(fs.promises, 'lstat').mockImplementationOnce(async () => delayed);
    vi.useFakeTimers();
    const pending = captureDeliveryBaseline([root], current);
    let settled = false;
    void pending.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(REMOTE_DELIVERY_BASELINE_BUDGET_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    const baseline = await pending;
    expect(baseline.directories).toHaveLength(0);
    release!(stat); await Promise.resolve(); await Promise.resolve();
    expect(baseline.directories).toHaveLength(0);
  });

  it('accepts a complete unchanged scan taking longer than the former 80 ms deadline', async () => {
    const root = directory(), lstat = fs.promises.lstat.bind(fs.promises);
    vi.spyOn(fs.promises, 'lstat').mockImplementationOnce(async target => {
      await new Promise(resolve => setTimeout(resolve, 120)); return lstat(target);
    });
    const baseline = await captureDeliveryBaseline([root], current);
    expect(baseline.directories.map(item => item.path)).toEqual([root]);
    const output = path.join(root, 'deck.pptx'); fs.writeFileSync(output, 'new output');
    expect(await changedDeliveredFile(baseline, output, Date.now() + 1, current)).not.toBeNull();
  });

  it('retains the healthy Desktop scan when cwd I/O hangs and ignores its late result', async () => {
    const cwd = directory(), desktop = directory(), lstat = fs.promises.lstat.bind(fs.promises);
    let release!: (value: fs.Stats) => void;
    const waiting = new Promise<fs.Stats>(resolve => { release = resolve; });
    vi.spyOn(fs.promises, 'lstat').mockImplementation(target => String(target) === cwd ? waiting : lstat(target));
    const baseline = await captureDeliveryBaseline([cwd, desktop], current);
    expect(baseline.directories.map(item => item.path)).toEqual([desktop]);
    release(fs.statSync(cwd)); await new Promise(resolve => setTimeout(resolve, 10));
    expect(baseline.directories.map(item => item.path)).toEqual([desktop]);
    const output = path.join(desktop, 'new.md'); fs.writeFileSync(output, 'output');
    expect(await changedDeliveredFile(baseline, output, Date.now() + 1, current)).not.toBeNull();
  });

  it('preserves root priority when the second directory completes first', async () => {
    const first = directory(), second = directory(), lstat = fs.promises.lstat.bind(fs.promises);
    let release!: (value: fs.Stats) => void;
    const delayed = new Promise<fs.Stats>(resolve => { release = resolve; });
    vi.spyOn(fs.promises, 'lstat').mockImplementationOnce(() => delayed);
    const realpath = vi.spyOn(fs.promises, 'realpath');
    const pending = captureDeliveryBaseline([first, second], current);
    // The second realpath check is the last I/O in a successful root scan.
    await vi.waitFor(() => expect(realpath.mock.calls.filter(([target]) => target === second)).toHaveLength(2));
    release(await lstat(first));
    expect((await pending).directories.map(item => item.path)).toEqual([first, second]);
  });

  it.each(['io-error', 'changed-root'])('isolates a %s from the other authorized directory', async failure => {
    const cwd = directory(), desktop = directory(), lstat = fs.promises.lstat.bind(fs.promises);
    let cwdReads = 0;
    vi.spyOn(fs.promises, 'lstat').mockImplementation(async target => {
      if (String(target) === cwd && failure === 'io-error') throw new Error('EIO');
      const stat = await lstat(target);
      if (String(target) === cwd && ++cwdReads === 2) stat.mtimeMs += 1;
      return stat;
    });
    const baseline = await captureDeliveryBaseline([cwd, desktop], current);
    expect(baseline.directories.map(item => item.path)).toEqual([desktop]);
    const unverified = path.join(cwd, 'unverified.md'); fs.writeFileSync(unverified, 'must stay local');
    expect(await changedDeliveredFile(baseline, unverified, Date.now() + 1, current)).toBeNull();
  });

  it.each([false, true])('discards even a completed root when authorization is revoked during the other scan (throws=%s)', async throws => {
    const cwd = directory(), desktop = directory();
    let allowed = true, release!: (value: fs.Stats) => void;
    const delayed = new Promise<fs.Stats>(resolve => { release = resolve; });
    vi.spyOn(fs.promises, 'lstat').mockImplementationOnce(() => delayed);
    const realpath = vi.spyOn(fs.promises, 'realpath');
    const pending = captureDeliveryBaseline([cwd, desktop], () => {
      if (!allowed && throws) throw new Error('revoked');
      return allowed;
    });
    await vi.waitFor(() => expect(realpath.mock.calls.filter(([target]) => target === desktop)).toHaveLength(2));
    allowed = false; release(fs.statSync(cwd));
    expect((await pending).directories).toEqual([]);
  });

  it('closes an in-progress iterator after late I/O and never exposes a partial directory baseline', async () => {
    const root = directory(), file = path.join(root, 'partial.md'); fs.writeFileSync(file, 'existing');
    const lstat = fs.promises.lstat.bind(fs.promises);
    let release!: (value: fs.Stats) => void, started!: () => void, closed!: () => void;
    const delayed = new Promise<fs.Stats>(resolve => { release = resolve; });
    const reading = new Promise<void>(resolve => { started = resolve; });
    const finished = new Promise<void>(resolve => { closed = resolve; });
    const entries = (async function* () {
      try { yield { name: 'partial.md' }; } finally { closed(); }
    })();
    vi.spyOn(fs.promises, 'opendir').mockResolvedValue(entries as unknown as fs.Dir);
    vi.spyOn(fs.promises, 'lstat').mockImplementation(target => {
      if (String(target) === file) { started(); return delayed; }
      return lstat(target);
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = captureDeliveryBaseline([root], current);
    await reading;
    await vi.advanceTimersByTimeAsync(REMOTE_DELIVERY_BASELINE_BUDGET_MS);
    const baseline = await pending;
    expect(baseline.directories).toEqual([]);
    release(fs.statSync(file)); await finished;
    expect(baseline.directories).toEqual([]);
  });

  it('invalidates the original owner epoch and rejects changes after the delivery boundary', async () => {
    const root = directory(); let originalEpoch = true;
    const baseline = await captureDeliveryBaseline([root], () => originalEpoch);
    const output = path.join(root, 'out.md'); fs.writeFileSync(output, 'output');
    const receipt = await changedDeliveredFile(baseline, output, Date.now() + 1, current);
    expect(receipt).not.toBeNull();
    expect(await changedDeliveredFile(baseline, output, Date.now() + 1, () => false)).toBeNull();
    originalEpoch = false;
    expect(await changedDeliveredFile(baseline, output, Date.now() + 1, current)).toBeNull();
    const boundary = Date.now() - 1000;
    const nextBaseline = await captureDeliveryBaseline([root], current);
    fs.writeFileSync(output, 'changed later'); fs.utimesSync(output, boundary / 1000 - 1, boundary / 1000 - 1);
    expect(await changedDeliveredFile(nextBaseline, output, boundary, current)).toBeNull();
    expect(identity(output)).not.toBe(receipt!.identity);
  });

  it('rejects ownership changes during capture and confirmation', async () => {
    const root = directory(); let allowed = true;
    const lstat = fs.promises.lstat.bind(fs.promises);
    vi.spyOn(fs.promises, 'lstat').mockImplementationOnce(async target => {
      const stat = await lstat(target); allowed = false; return stat;
    });
    expect((await captureDeliveryBaseline([root], () => allowed)).directories).toHaveLength(0);
    vi.restoreAllMocks(); allowed = true;
    const baseline = await captureDeliveryBaseline([root], () => allowed);
    const output = path.join(root, 'out.md'); fs.writeFileSync(output, 'output');
    vi.spyOn(fs.promises, 'lstat').mockImplementationOnce(async target => {
      const stat = await lstat(target); allowed = false; return stat;
    });
    expect(await changedDeliveredFile(baseline, output, Date.now() + 1, current)).toBeNull();
  });
});

describe('explicit delivered file links', () => {
  it('accepts and deduplicates decoded absolute Markdown and local file links', () => {
    const root = directory(), file = path.join(root, '口算题100道.md'), spaced = path.join(root, 'with spaces.md');
    expect(deliveredFileLinks(`[file](${pathToFileURL(file)})\n[again](${file})\n[spaces](<${spaced}>)`)).toEqual([file, spaced]);
    expect(deliveredFileLinks(`[local](file://localhost${file})`)).toEqual([file]);
  });
  it('ignores bare paths, relative links, remote hosts, invalid escapes, and control characters', () => {
    expect(deliveredFileLinks('/tmp/bare.md [relative](out.md) [web](https://example.com/out.md) '
      + '[host](file://example.com/out.md) [unc](//example.com/out.md) [bad](file:///tmp/%GG.md) '
      + '[null](file:///tmp/a%00.md) [slash](file:///tmp/a%2fb.md)')).toEqual([]);
  });
  it('omits fenced and inline code and escaped link examples', () => {
    const content = [
      '[real](/tmp/real.md)',
      '```markdown',
      '[code](/tmp/fenced.md)',
      '```',
      '~~~',
      '[code](/tmp/tilde.md)',
      '~~~',
      '`[inline](/tmp/inline.md)` and ``[inline `tick`](/tmp/double.md)``',
      '![image](/tmp/image.png) \\[escaped](/tmp/escaped.md)',
      '    [indented](/tmp/indented.md)',
      '[last](/tmp/last.md)',
    ].join('\n');
    expect(deliveredFileLinks(content)).toEqual(['/tmp/real.md', '/tmp/image.png', '/tmp/last.md']);
  });
  it('fails closed for unclosed fences and code spans', () => {
    expect(deliveredFileLinks('[real](/tmp/real.md)\n```md\n[fake](/tmp/fake.md)')).toEqual(['/tmp/real.md']);
    expect(deliveredFileLinks('[real](/tmp/real.md) `[fake](/tmp/fake.md)')).toEqual(['/tmp/real.md']);
  });
  it('keeps masking until a valid matching fence closes', () => {
    const content = ['````md', '[a](/tmp/a.md)', '```', '[b](/tmp/b.md)',
      '    ````', '[c](/tmp/c.md)', '~~~~', '[d](/tmp/d.md)', '````', '[real](/tmp/real.md)'].join('\n');
    expect(deliveredFileLinks(content)).toEqual(['/tmp/real.md']);
    expect(deliveredFileLinks('> ```\n> [fake](/tmp/fake.md)\n> ```\n[real](/tmp/real.md)')).toEqual(['/tmp/real.md']);
    expect(deliveredFileLinks('- ```\n  [fake](/tmp/fake.md)\n  ```\n[real](/tmp/real.md)')).toEqual(['/tmp/real.md']);
  });
  it('recognizes allowed local image deliveries and deduplicates their download links', () => {
    const root = directory(), file = path.join(root, '生成的图片.PNG');
    expect(deliveredFileLinks(`![image](${pathToFileURL(file)}) [download](${file})`)).toEqual([file]);
    for (const extension of ['png', 'jpg', 'jpeg', 'webp', 'gif']) {
      expect(deliveredFileLinks(`![result](</tmp/image with spaces.${extension}>)`)).toEqual([`/tmp/image with spaces.${extension}`]);
    }
  });
  it('does not treat remote images, non-image targets, or image examples as local deliveries', () => {
    expect(deliveredFileLinks('![web](https://example.com/image.png) ![data](data:image/png;base64,AAAA) '
      + '![server](file://example.com/image.png) ![svg](/tmp/image.svg) ![active](/tmp/index.html) '
      + '![not-an-image](/tmp/private.md) ![unsupported](/tmp/image.avif) ![video](/tmp/movie.mp4)')).toEqual([]);
    expect(deliveredFileLinks('`![example](/tmp/image.png)`\n```markdown\n![example](/tmp/fenced.jpg)\n```\n'
      + '\\![escaped](/tmp/escaped.png)')).toEqual([]);
  });
  it('bounds unique declarations to twenty', () => {
    expect(deliveredFileLinks(Array.from({ length: 30 }, (_, index) => `[file](/tmp/${index}.md)`).join('\n'))).toHaveLength(20);
  });
});

describe('explicit MEDIA declarations', () => {
  it.each(['文件在下面。', '已发送！', 'Ready.', 'Sent!'])('accepts a single trailing MEDIA directive after visible delivery prose: %s', prefix => {
    const file = path.join(directory(), '工作简报 一.docx');
    for (const target of [file, `"${file}"`, `'${file}'`, `<${file}>`, `\`${file}\``]) {
      expect(deliveredFileDeclarations(`${prefix}\tMEDIA: ${target}`)).toEqual([
        { filePath: file, kind: RemoteFileDeliveryKind.Media },
      ]);
    }
    expect(deliveredFileLinks(`已发送。MEDIA:${file}`)).toEqual([file]);
  });

  it('recognizes a trailing Windows MEDIA path without treating backslashes or Chinese text as escapes', () => {
    const file = String.raw`D:\agent\主\工作简报.docx`;
    const isAbsolute = path.isAbsolute, resolve = path.resolve;
    vi.spyOn(path, 'isAbsolute').mockImplementation(value => /^[A-Za-z]:\\/u.test(value) ? path.win32.isAbsolute(value) : isAbsolute(value));
    vi.spyOn(path, 'resolve').mockImplementation((...parts) => /^[A-Za-z]:\\/u.test(parts[0] || '') ? path.win32.resolve(...parts) : resolve(...parts));
    expect(deliveredFileDeclarations(`文件在下面，点开就能下载。 MEDIA:${file}`)).toEqual([
      { filePath: file, kind: RemoteFileDeliveryKind.Media },
    ]);
  });

  it.each([
    '> 已发送。 MEDIA: /tmp/file.pdf', '- 已发送。 MEDIA: /tmp/file.pdf', '1. 已发送。 MEDIA: /tmp/file.pdf',
    '> Quoted delivery\n已发送。 MEDIA: /tmp/file.pdf', '- Quoted delivery\n已发送。 MEDIA: /tmp/file.pdf',
    '<blockquote>已发送。 MEDIA: /tmp/file.pdf</blockquote>', '<blockquote>\n已发送。 MEDIA: /tmp/file.pdf\n</blockquote>',
    '  * 已发送。 MEDIA: /tmp/file.pdf', '    已发送。 MEDIA: /tmp/file.pdf', '\t已发送。 MEDIA: /tmp/file.pdf',
    ' \t已发送。 MEDIA: /tmp/file.pdf', '# 已发送。 MEDIA: /tmp/file.pdf', '... MEDIA: /tmp/file.pdf',
    '示例 MEDIA: /tmp/file.pdf', '示例。 MEDIA: /tmp/file.pdf', 'Example. MEDIA: /tmp/file.pdf',
    '发送吗？ MEDIA: /tmp/file.pdf', 'MEDIA: /tmp/a.pdf MEDIA: /tmp/b.pdf', '已发送。 MEDIA: /tmp/a.pdf MEDIA: /tmp/b.pdf',
    '`example` 已发送。 MEDIA: /tmp/file.pdf', '`已发送。 MEDIA: /tmp/file.pdf`',
    '```\n已发送。 MEDIA: /tmp/file.pdf\n```', '<think>已发送。</think> MEDIA: /tmp/file.pdf',
    '<!-- hidden -->已发送。 MEDIA: /tmp/file.pdf', '<code>example</code>已发送。 MEDIA: /tmp/file.pdf',
    '已发送。 /tmp/file.pdf', '已发送。 MEDIA: https://example.com/file.pdf',
  ])('does not turn an ambiguous inline MEDIA example into a delivery: %s', content => {
    expect(deliveredFileDeclarations(content)).toEqual([]);
  });

  it('resumes inline delivery after a quoted paragraph or HTML blockquote ends', () => {
    expect(deliveredFileLinks('> Quoted delivery\n已发送。 MEDIA: /tmp/hidden.pdf\n\n已发送。 MEDIA: /tmp/real.pdf'))
      .toEqual(['/tmp/real.pdf']);
    expect(deliveredFileLinks('<blockquote>\n已发送。 MEDIA: /tmp/hidden.pdf\n</blockquote>\n已发送。 MEDIA: /tmp/real.pdf'))
      .toEqual(['/tmp/real.pdf']);
  });

  it('accepts standalone Chinese, space-containing, quoted and local file URL declarations', () => {
    const first = '/tmp/桌面题目 一.pdf', second = '/tmp/答案 二.pdf';
    expect(deliveredFileDeclarations(`已经发送。\nMEDIA: ${first}\nMEDIA: \`${second}\`\nMEDIA: ${pathToFileURL(first)}\n后续正文。`)).toEqual([
      { filePath: first, kind: RemoteFileDeliveryKind.Media }, { filePath: second, kind: RemoteFileDeliveryKind.Media },
    ]);
    expect(deliveredFileLinks('MEDIA: "/tmp/quoted.pdf"\nMEDIA: </tmp/angle.pdf>\nMEDIA: file://localhost/tmp/local.pdf'))
      .toEqual(['/tmp/quoted.pdf', '/tmp/angle.pdf', '/tmp/local.pdf']);
  });

  it('keeps literal percent sequences in paths and prioritizes MEDIA over a duplicate Markdown reference', () => {
    expect(deliveredFileDeclarations('[ref](/tmp/a%20b.pdf)\nMEDIA: /tmp/a b.pdf\nMEDIA: /tmp/a%20b.pdf')).toEqual([
      { filePath: '/tmp/a b.pdf', kind: RemoteFileDeliveryKind.Media },
      { filePath: '/tmp/a%20b.pdf', kind: RemoteFileDeliveryKind.Media },
    ]);
    expect(deliveredFileLinks('MEDIA: file:///tmp/a%20b.pdf\nMEDIA: /tmp/a%GG.pdf')).toEqual(['/tmp/a b.pdf', '/tmp/a%GG.pdf']);
  });

  it.each([
    'MEDIA: out.pdf', 'MEDIA: https://example.com/file.pdf', 'MEDIA: file://example.com/file.pdf',
    'MEDIA: //example.com/file.pdf', 'MEDIA: file:///tmp/a%00.pdf', 'MEDIA: file:///tmp/a%2fb.pdf',
    '> MEDIA: /tmp/file.pdf', '- MEDIA: /tmp/file.pdf', '1. MEDIA: /tmp/file.pdf',
    '    MEDIA: /tmp/file.pdf', '	MEDIA: /tmp/file.pdf', '示例 MEDIA: /tmp/file.pdf',
    '`MEDIA: /tmp/file.pdf`', '`code`MEDIA: /tmp/file.pdf', 'MEDIA: /tmp/file.pdf `example`',
    '```\nMEDIA: /tmp/file.pdf\n```', '~~~text\nMEDIA: /tmp/file.pdf\n~~~',
    '`unclosed\nMEDIA: /tmp/file.pdf', '```\nMEDIA: /tmp/file.pdf',
    '<think>\nMEDIA: /tmp/file.pdf\n</think>', '<thinking>\nMEDIA: /tmp/file.pdf\n</thinking>',
    '<!--\nMEDIA: /tmp/file.pdf\n-->', '<pre>\nMEDIA: /tmp/file.pdf\n</pre>',
    '<code>\nMEDIA: /tmp/file.pdf\n</code>',
  ])('does not upgrade hidden, quoted, code or non-local content to a delivery: %s', content => {
    expect(deliveredFileDeclarations(content)).toEqual([]);
  });

  it('resumes only after the hidden region has ended and bounds unique MEDIA declarations', () => {
    expect(deliveredFileLinks('<think>\nMEDIA: /tmp/hidden.pdf\n</think>\nMEDIA: /tmp/real.pdf\n'
      + '<!--\nMEDIA: /tmp/comment.pdf\n-->\nMEDIA: /tmp/last.pdf')).toEqual(['/tmp/real.pdf', '/tmp/last.pdf']);
    expect(deliveredFileLinks(Array.from({ length: 30 }, (_, index) => `MEDIA: /tmp/${index}.pdf`).join('\n'))).toHaveLength(20);
  });

  it('allows stable existing files only with the explicit delivery flag, retaining boundary checks', async () => {
    const root = directory(), external = directory(), file = path.join(root, 'existing.pdf');
    fs.writeFileSync(file, 'existing bytes');
    const baseline = await captureDeliveryBaseline([root], current);
    const boundary = Date.now() + 1;
    expect(await changedDeliveredFile(baseline, file, boundary, current)).toBeNull();
    expect(await changedDeliveredFile(baseline, file, boundary, current, true)).toMatchObject({ filePath: file, identity: identity(file) });
    expect(await changedDeliveredFile(baseline, file, boundary, () => false, true)).toBeNull();
    const outside = path.join(external, 'other.pdf'); fs.writeFileSync(outside, 'outside bytes');
    expect(await changedDeliveredFile(baseline, outside, Date.now() + 1, current, true)).toBeNull();
    fs.utimesSync(file, new Date(boundary + 1000), new Date(boundary + 1000));
    expect(await changedDeliveredFile(baseline, file, boundary, current, true)).toBeNull();
  });
});


describe('delivery rejection diagnostics', () => {
  it('reports an unadmitted root without logging its path or changing admission', async () => {
    const report = vi.fn();
    const baseline = { directories: [], current: () => true };
    const file = path.join(os.tmpdir(), 'private-customer-name.pdf');
    expect(await changedDeliveredFile(baseline, file, Date.now(), () => true, false, report)).toBeNull();
    expect(report).toHaveBeenCalledWith('FILE_OUTSIDE_CAPTURED_BASELINE');
    expect(JSON.stringify(report.mock.calls)).not.toContain(file);
  });

  it('keeps a diagnostic callback failure out of the admission path', async () => {
    const baseline = { directories: [], current: () => true };
    await expect(changedDeliveredFile(baseline, path.join(os.tmpdir(), 'private.pdf'), Date.now(), () => true, false,
      () => { throw new Error('log unavailable'); })).resolves.toBeNull();
  });
});
