#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const TEMPLATE_PLACEHOLDER = '__CLIP_REPORT_DATA__';
const DEFAULT_PRESET = 'paperwhisper-warm-ledger';
const DEFAULT_TEMPLATE = 'block-clipping';
function cloneJSON(value) {
  if (value === undefined) return {};
  return JSON.parse(JSON.stringify(value));
}

function normalizeClipReportData(input = {}, presetOverride) {
  const data = cloneJSON(input);
  const normalized = data && typeof data === 'object' ? data : {};

  const theme = normalized.theme && typeof normalized.theme === 'object'
    ? { ...normalized.theme }
    : {};
  theme.preset = presetOverride || theme.preset || DEFAULT_PRESET;
  normalized.theme = theme;

  const layout = normalized.layout && typeof normalized.layout === 'object'
    ? { ...normalized.layout }
    : {};
  layout.freedom = 'stable';
  normalized.layout = layout;

  if (!Array.isArray(normalized.blocks)) {
    normalized.blocks = [];
  }

  return normalized;
}

function injectClipDataIntoTemplate(templateHTML, clipData, presetOverride) {
  const normalized = normalizeClipReportData(clipData, presetOverride);
  const serialized = JSON.stringify(normalized, null, 2);
  return templateHTML.replace(TEMPLATE_PLACEHOLDER, serialized);
}

function mimeTypeForAsset(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.woff2') return 'font/woff2';
  if (extension === '.ttf') return 'font/ttf';
  if (extension === '.otf') return 'font/otf';
  if (extension === '.js') return 'text/javascript';
  if (extension === '.css') return 'text/css';
  return 'application/octet-stream';
}

function toDataUrl(filePath) {
  const content = fs.readFileSync(filePath);
  return `data:${mimeTypeForAsset(filePath)};base64,${content.toString('base64')}`;
}

function resolveSkillRoot() {
  return path.resolve(__dirname, '..');
}

function resolveTemplateDir(templateName = DEFAULT_TEMPLATE) {
  return path.join(resolveSkillRoot(), 'assets', 'templates', templateName);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function inlineTemplateAssets(templateHTML, templateDir) {
  const stylesPath = path.join(templateDir, 'styles.css');
  const scriptPath = path.join(templateDir, 'template.js');
  const fontsDir = path.join(templateDir, 'fonts');

  let styles = fs.readFileSync(stylesPath, 'utf8');
  const fontAssetPattern = /url\(["']?\.\/fonts\/([^"')]+)["']?\)/g;
  styles = styles.replace(fontAssetPattern, (_match, assetName) => {
    const assetPath = path.join(fontsDir, assetName);
    return `url("${toDataUrl(assetPath)}")`;
  });

  const script = fs.readFileSync(scriptPath, 'utf8');

  return templateHTML
    .replace('<link rel="stylesheet" href="./styles.css" />', `<style>\n${styles}\n</style>`)
    .replace('<script src="./template.js"></script>', `<script>\n${script}\n</script>`);
}

function renderStandaloneHtml({ templateDir, clipData, preset }) {
  const templateHTML = fs.readFileSync(path.join(templateDir, 'index.html'), 'utf8');
  const standaloneTemplate = inlineTemplateAssets(templateHTML, templateDir);
  return injectClipDataIntoTemplate(standaloneTemplate, clipData, preset);
}

function buildHeadlessCapturePlan({
  templateDir,
  htmlPath,
  outputPath,
}) {
  const captureScriptPath = path.join(templateDir, 'capture.mjs');
  const resolvedOutputPath = path.resolve(outputPath);
  const resolvedHtmlPath = path.resolve(htmlPath);

  const command = [
    `node ${shellQuote(captureScriptPath)} ${shellQuote(resolvedHtmlPath)} ${shellQuote(resolvedOutputPath)}`,
  ].join('\n');

  return {
    captureScriptPath,
    htmlPath: resolvedHtmlPath,
    outputPath: resolvedOutputPath,
    command,
  };
}

function parseArgs(argv) {
  const args = {
    inputFile: '',
    outputHTML: '',
    preset: '',
    template: DEFAULT_TEMPLATE,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    const next = argv[i + 1];
    switch (current) {
      case '--input-file':
        args.inputFile = next || '';
        i += 1;
        break;
      case '--output-html':
        args.outputHTML = next || '';
        i += 1;
        break;
      case '--preset':
        args.preset = next || '';
        i += 1;
        break;
      case '--template':
        args.template = next || DEFAULT_TEMPLATE;
        i += 1;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        break;
    }
  }

  return args;
}

function readClipData(inputFile) {
  const raw = inputFile
    ? fs.readFileSync(path.resolve(inputFile), 'utf8')
    : fs.readFileSync(0, 'utf8');
  return JSON.parse(raw);
}

function renderToFile({ inputFile, outputHTML, preset, template }) {
  if (!outputHTML) {
    throw new Error('Missing required --output-html');
  }

  const templateDir = resolveTemplateDir(template);
  const clipData = readClipData(inputFile);
  const renderedHTML = renderStandaloneHtml({ templateDir, clipData, preset });
  fs.mkdirSync(path.dirname(path.resolve(outputHTML)), { recursive: true });
  fs.writeFileSync(path.resolve(outputHTML), renderedHTML);
}

function printHelp() {
  process.stdout.write(
    [
      'Usage: node render-briefing-clip.js --input-file <clip-data.json> --output-html <render.html> [--preset <preset>]',
      'If --input-file is omitted, the script reads clip JSON from stdin.',
    ].join('\n') + '\n'
  );
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  try {
    renderToFile(args);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

module.exports = {
  DEFAULT_PRESET,
  buildHeadlessCapturePlan,
  injectClipDataIntoTemplate,
  inlineTemplateAssets,
  normalizeClipReportData,
  parseArgs,
  printHelp,
  renderStandaloneHtml,
  renderToFile,
  resolveTemplateDir,
  toDataUrl,
};
