import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  DSH_HTML_RENDER_TOOL,
  HTML_RENDER_LIMITS,
  HtmlRenderFormat,
} from '../../../shared/dshEngine/hostConstants';
import {
  createDshHtmlRenderProvider,
  dshHtmlRenderToolDescriptor,
  parseHtmlRenderJobs,
} from './dshHtmlRenderTool';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-html-render-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('dshHtmlRenderTool', () => {
  test('parses single-item top-level arguments with defaults', () => {
    const cwd = makeTempDir();
    const htmlFile = path.join(cwd, 'cover.html');
    fs.writeFileSync(htmlFile, '<html><body>Hello</body></html>', 'utf8');

    const jobs = parseHtmlRenderJobs(
      { htmlPath: 'cover.html', outputPath: 'out/cover.png' },
      [cwd],
    );

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toEqual({
      htmlPath: fs.realpathSync(htmlFile),
      outputPath: path.join(fs.realpathSync(cwd), 'out', 'cover.png'),
      width: HTML_RENDER_LIMITS.DefaultWidth,
      height: HTML_RENDER_LIMITS.DefaultHeight,
      fullPage: false,
      format: HtmlRenderFormat.Png,
      quality: HTML_RENDER_LIMITS.DefaultQuality,
      waitMs: 0,
    });
  });

  test('parses batch items and infers jpeg format from extension', () => {
    const cwd = makeTempDir();
    const html1 = path.join(cwd, 'a.html');
    const html2 = path.join(cwd, 'b.htm');
    fs.writeFileSync(html1, '<html></html>', 'utf8');
    fs.writeFileSync(html2, '<html></html>', 'utf8');

    const jobs = parseHtmlRenderJobs(
      {
        items: [
          { htmlPath: html1, outputPath: path.join(cwd, 'a.png'), width: 1242, height: 1242 },
          { htmlPath: html2, outputPath: path.join(cwd, 'b.jpg'), fullPage: true, quality: 85, waitMs: 120 },
        ],
      },
      [cwd],
    );

    expect(jobs).toHaveLength(2);
    expect(jobs[0].width).toBe(1242);
    expect(jobs[0].height).toBe(1242);
    expect(jobs[0].format).toBe(HtmlRenderFormat.Png);
    expect(jobs[1].format).toBe(HtmlRenderFormat.Jpeg);
    expect(jobs[1].fullPage).toBe(true);
    expect(jobs[1].quality).toBe(85);
    expect(jobs[1].waitMs).toBe(120);
  });

  test('rejects URLs, missing html files, bad extensions, and out-of-range dimensions', () => {
    const cwd = makeTempDir();
    const htmlFile = path.join(cwd, 'card.html');
    fs.writeFileSync(htmlFile, '<html></html>', 'utf8');

    expect(() => parseHtmlRenderJobs(
      { htmlPath: 'https://example.com/a.html', outputPath: path.join(cwd, 'a.png') },
      [cwd],
    )).toThrow(/not a URL/i);

    expect(() => parseHtmlRenderJobs(
      { htmlPath: path.join(cwd, 'missing.html'), outputPath: path.join(cwd, 'a.png') },
      [cwd],
    )).toThrow(/does not exist/i);

    expect(() => parseHtmlRenderJobs(
      { htmlPath: htmlFile, outputPath: path.join(cwd, 'a.svg') },
      [cwd],
    )).toThrow(/unsupported extension/i);

    expect(() => parseHtmlRenderJobs(
      { htmlPath: htmlFile, outputPath: path.join(cwd, 'a.png'), width: 32 },
      [cwd],
    )).toThrow(/between 64 and 4096/i);

    expect(() => parseHtmlRenderJobs({}, [cwd])).toThrow(/non-empty array/i);
  });

  test('rejects batch exceeding maximum item count', () => {
    const cwd = makeTempDir();
    const htmlFile = path.join(cwd, 'card.html');
    fs.writeFileSync(htmlFile, '<html></html>', 'utf8');
    const items = Array.from({ length: HTML_RENDER_LIMITS.MaxItems + 1 }, (_, i) => ({
      htmlPath: htmlFile,
      outputPath: path.join(cwd, `out-${i}.png`),
    }));

    expect(() => parseHtmlRenderJobs({ items }, [cwd])).toThrow(/At most 20/i);
  });

  test('provider exposes deduplicated items-only schema and forwards legacy top-level jobs to renderer', async () => {
    const cwd = makeTempDir();
    const htmlFile = path.join(cwd, 'cover.html');
    fs.writeFileSync(htmlFile, '<html></html>', 'utf8');
    const render = vi.fn(async jobs => jobs.map(job => ({
      htmlPath: job.htmlPath,
      outputPath: job.outputPath,
      width: job.width,
      height: job.height,
      bytes: 12345,
      format: job.format,
    })));

    const provider = createDshHtmlRenderProvider({
      resolveAllowedRoots: () => [cwd],
      render,
    });

    expect(provider.listDescriptors()).toEqual([dshHtmlRenderToolDescriptor]);
    expect(dshHtmlRenderToolDescriptor.deferLoading).toBeUndefined();
    expect(dshHtmlRenderToolDescriptor.name).toBe(DSH_HTML_RENDER_TOOL);
    expect(dshHtmlRenderToolDescriptor.inputSchema).toMatchObject({
      type: 'object',
      required: ['items'],
    });
    const schemaProps = (dshHtmlRenderToolDescriptor.inputSchema.properties ?? {}) as Record<string, unknown>;
    expect(Object.keys(schemaProps)).toEqual(['items']);

    const output = await provider.execute(
      DSH_HTML_RENDER_TOOL,
      { htmlPath: htmlFile, outputPath: path.join(cwd, 'cover.png') },
      { agentId: 'xiaohongshu-viral-expert', coworkSessionId: 'sess-1' },
    );

    expect(render).toHaveBeenCalledTimes(1);
    expect(output).toMatchObject({
      ok: true,
      count: 1,
      results: [{ width: 1242, height: 1656, bytes: 12345, format: HtmlRenderFormat.Png }],
    });
  });
});
