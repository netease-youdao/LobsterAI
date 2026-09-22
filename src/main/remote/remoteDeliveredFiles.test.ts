import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureDeliveryBaseline, changedDeliveredFile, deliveredFileLinks } from './remoteDeliveredFiles';

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
    await vi.advanceTimersByTimeAsync(79);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    const baseline = await pending;
    expect(baseline.directories).toHaveLength(0);
    release!(stat); await Promise.resolve(); await Promise.resolve();
    expect(baseline.directories).toHaveLength(0);
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
