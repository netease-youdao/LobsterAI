'use strict';

// Shared builder for the single-file collectors sent to customers.
// Explorer runs a file double-clicked inside a ZIP after extracting only that
// file, so the launcher, collector, shared helpers and probe live in one .cmd.
const fs = require('node:fs');
const path = require('node:path');

// cmd.exe runs these lines and exits before the PowerShell part; PowerShell
// reads the whole file as UTF-8 and sees these lines as one block comment.
// Bypass matches collect.cmd: the Defender and Storage modules load format files.
function batchHeader(title) {
  if (!/^[\x20-\x7e]+$/.test(title)) throw new Error('The window title must be printable ASCII for cmd.exe.');
  return [
    // A batch label (ignored by cmd.exe) that opens a PowerShell block comment.
    '<# : LobsterAI diagnostics launcher',
    '@echo off',
    'setlocal',
    `title ${title}`,
    'set "LOBSTERAI_DIAG_SELF=%~f0"',
    '"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$source = [IO.File]::ReadAllText($env:LOBSTERAI_DIAG_SELF, [Text.Encoding]::UTF8); & ([ScriptBlock]::Create($source))"',
    'set "DIAG_EXIT=%ERRORLEVEL%"',
    'if not "%DIAG_EXIT%"=="0" echo Diagnostic collection ended with code %DIAG_EXIT%. Please send a screenshot of this window to support.',
    'echo.',
    'pause',
    'exit /b %DIAG_EXIT%',
    '#>',
  ];
}

function readText(file) {
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

/** PowerShell only accepts a param block as the first statement of the embedded script. */
function splitParamBlock(source, fileName = 'The collector') {
  const match = source.match(/^param\([\s\S]*?\n\)\n/);
  if (!match) throw new Error(`${fileName} must start with its param block.`);
  return [match[0], source.slice(match[0].length)];
}

/**
 * @param {{ sourceDir: string, collectorFile: string, probeFile: string, probeVariable: string, title: string }} options
 */
function buildSingleFileCollector({ sourceDir, collectorFile, probeFile, probeVariable, title }) {
  const collector = readText(path.join(sourceDir, collectorFile));
  const common = readText(path.join(sourceDir, 'diagnostic-common.ps1'));
  const probe = readText(path.join(sourceDir, probeFile));
  // A line starting with '@ would end the single-quoted here-string early.
  if (/^'@/m.test(probe)) throw new Error('The probe cannot be embedded in a PowerShell here-string.');
  const [params, body] = splitParamBlock(collector, collectorFile);
  const text = [
    ...batchHeader(title),
    params.trimEnd(),
    `${probeVariable} = @'`,
    probe.trimEnd(),
    "'@",
    common.trimEnd(),
    body.trimEnd(),
    '',
  ].join('\n');
  // Batch labels and goto need CRLF. No BOM: cmd.exe would read it as part of the first command.
  return text.replace(/\n/g, '\r\n');
}

function writeCollector(outputDir, outputName, text) {
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, outputName);
  fs.writeFileSync(outputPath, text, 'utf8');
  return outputPath;
}

module.exports = { batchHeader, buildSingleFileCollector, splitParamBlock, writeCollector };
