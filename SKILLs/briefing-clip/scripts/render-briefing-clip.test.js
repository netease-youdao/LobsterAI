const { describe, it, expect } = require('vitest');

const {
  normalizeClipReportData,
  injectClipDataIntoTemplate,
  buildHeadlessCapturePlan,
  renderStandaloneHtml,
  resolveTemplateDir,
} = require('./render-briefing-clip');

describe('render-briefing-clip helpers', () => {
  it('forces stable layout freedom while preserving other layout fields', () => {
    const normalized = normalizeClipReportData({
      theme: { preset: 'paperwhisper-warm-ledger' },
      layout: {
        canvas_width: 720,
        spacing_scale: 'comfortable',
        freedom: 'expressive',
      },
      blocks: [],
    });

    expect(normalized.layout).toEqual({
      canvas_width: 720,
      spacing_scale: 'comfortable',
      freedom: 'stable',
    });
  });

  it('overrides the theme preset when one is provided explicitly', () => {
    const normalized = normalizeClipReportData({
      theme: { preset: 'paperwhisper-warm-ledger' },
      blocks: [],
    }, 'daily-brief-clean');

    expect(normalized.theme.preset).toBe('daily-brief-clean');
  });

  it('injects serialized clip data into the template placeholder', () => {
    const rendered = injectClipDataIntoTemplate(
      '<script id="clip-data">__CLIP_REPORT_DATA__</script>',
      {
        theme: { preset: 'paperwhisper-warm-ledger' },
        layout: { freedom: 'expressive' },
        blocks: [{ id: 'b1', type: 'masthead', variant: 'centered-stamp', props: {} }],
      }
    );

    expect(rendered).not.toContain('__CLIP_REPORT_DATA__');
    expect(rendered).toContain('"freedom": "stable"');
    expect(rendered).toContain('"preset": "paperwhisper-warm-ledger"');
  });

  it('renders standalone html with inline assets for preview and capture', () => {
    const rendered = renderStandaloneHtml({
      templateDir: resolveTemplateDir(),
      clipData: {
        theme: { preset: 'paperwhisper-warm-ledger' },
        blocks: [{ id: 'b1', type: 'masthead', variant: 'centered-stamp', props: { title: 'Test' } }],
      },
      preset: 'paperwhisper-warm-ledger',
    });

    expect(rendered).toContain('<style>');
    expect(rendered).toContain('data:font/woff2;base64,');
    expect(rendered).toContain('data:font/ttf;base64,');
    expect(rendered).toContain('<script>\n(function () {');
    expect(rendered).not.toContain('href="./styles.css"');
    expect(rendered).not.toContain('src="./template.js"');
  });

  it('plans capture through the bundled headless capture script', () => {
    const plan = buildHeadlessCapturePlan({
      templateDir: '/tmp/skills/briefing-clip/assets/templates/block-clipping',
      htmlPath: '/tmp/clip/render.html',
      outputPath: '/tmp/clip/output.png',
    });

    expect(plan.captureScriptPath).toBe('/tmp/skills/briefing-clip/assets/templates/block-clipping/capture.mjs');
    expect(plan.command).toContain('capture.mjs');
    expect(plan.command).not.toContain('playwright_cli.sh');
    expect(plan.command).toContain('/tmp/clip/render.html');
    expect(plan.command).toContain('/tmp/clip/output.png');
  });
});
