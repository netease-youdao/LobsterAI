#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  renderToFile,
  resolveTemplateDir,
} = require('./render-briefing-clip');

function parseArgs(argv) {
  const args = {
    inputFile: '',
    output: '',
    preset: '',
    debug: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    const next = argv[i + 1];
    switch (current) {
      case '--input-file':
        args.inputFile = next || '';
        i += 1;
        break;
      case '--output':
        args.output = next || '';
        i += 1;
        break;
      case '--preset':
        args.preset = next || '';
        i += 1;
        break;
      case '--debug':
        args.debug = true;
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

function printHelp() {
  process.stdout.write(
    [
      'Usage: node generate-briefing-clip.js --output <output.png> [--input-file <clip-data.json>] [--preset <preset>] [--debug]',
      'If --input-file is omitted, the script reads clip JSON from stdin.',
      'The runtime creates only temporary render files and keeps the final PNG by default.',
    ].join('\n') + '\n'
  );
}

function runCapture(tempHTMLPath, outputPath) {
  const captureScriptPath = path.join(resolveTemplateDir(), 'capture.mjs');
  const result = spawnSync(process.execPath, [captureScriptPath, tempHTMLPath, outputPath], {
    cwd: path.dirname(outputPath),
    encoding: 'utf8',
    stdio: 'pipe',
    env: process.env,
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'Screenshot capture failed');
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }

  if (!args.output) {
    throw new Error('Missing required --output');
  }

  const outputPath = path.resolve(args.output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-briefing-clip-'));
  try {
    const renderHTMLPath = path.join(tempDir, 'index.html');
    renderToFile({
      inputFile: args.inputFile,
      outputHTML: renderHTMLPath,
      preset: args.preset,
      template: 'block-clipping',
    });
    runCapture(renderHTMLPath, outputPath);
    process.stdout.write(`${outputPath}\n`);
  } finally {
    if (!args.debug) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  return 0;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

module.exports = {
  main,
  parseArgs,
  printHelp,
  runCapture,
};
