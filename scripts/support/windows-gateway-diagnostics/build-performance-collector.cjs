'use strict';

// Builds the single-file startup performance collector sent to customers.
// Explorer runs a file double-clicked inside a ZIP after extracting only that
// file, so the launcher, collector, shared helpers and probe live in one .cmd.
// Usage: node build-performance-collector.cjs <output-dir>
const fs = require('node:fs');
const path = require('node:path');

const OUTPUT_NAME = 'LobsterAI-Performance-Diagnostics.cmd';
const PROBE_VARIABLE = '$script:EmbeddedPerformanceProbe';

// cmd.exe runs these lines and exits before the PowerShell part; PowerShell
// reads the whole file as UTF-8 and sees these lines as one block comment.
// Bypass matches collect.cmd: the Defender and Storage modules load format files.
const BATCH_HEADER = [
  // A batch label (ignored by cmd.exe) that opens a PowerShell block comment.
  '<# : LobsterAI diagnostics launcher',
  '@echo off',
  'setlocal',
  'title LobsterAI Startup Performance Diagnostics',
  'set "LOBSTERAI_DIAG_SELF=%~f0"',
  '"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$source = [IO.File]::ReadAllText($env:LOBSTERAI_DIAG_SELF, [Text.Encoding]::UTF8); & ([ScriptBlock]::Create($source))"',
  'set "DIAG_EXIT=%ERRORLEVEL%"',
  'if not "%DIAG_EXIT%"=="0" echo Diagnostic collection ended with code %DIAG_EXIT%. Please send a screenshot of this window to support.',
  'echo.',
  'pause',
  'exit /b %DIAG_EXIT%',
  '#>',
];

function readText(file) {
  return fs.readFileSync(file, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
}

/** PowerShell only accepts a param block as the first statement of the embedded script. */
function splitParamBlock(source) {
  const match = source.match(/^param\([\s\S]*?\n\)\n/);
  if (!match) throw new Error('collect-performance.ps1 must start with its param block.');
  return [match[0], source.slice(match[0].length)];
}

function buildPerformanceCollector(sourceDir = __dirname) {
  const collector = readText(path.join(sourceDir, 'collect-performance.ps1'));
  const common = readText(path.join(sourceDir, 'diagnostic-common.ps1'));
  const probe = readText(path.join(sourceDir, 'performance-probe.cjs'));
  // A line starting with '@ would end the single-quoted here-string early.
  if (/^'@/m.test(probe)) throw new Error('The probe cannot be embedded in a PowerShell here-string.');
  const [params, body] = splitParamBlock(collector);
  const text = [
    ...BATCH_HEADER,
    params.trimEnd(),
    `${PROBE_VARIABLE} = @'`,
    probe.trimEnd(),
    "'@",
    common.trimEnd(),
    body.trimEnd(),
    '',
  ].join('\n');
  // Batch labels and goto need CRLF. No BOM: cmd.exe would read it as part of the first command.
  return text.replace(/\n/g, '\r\n');
}

function writePerformanceCollector(outputDir, sourceDir = __dirname) {
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, OUTPUT_NAME);
  fs.writeFileSync(outputPath, buildPerformanceCollector(sourceDir), 'utf8');
  return outputPath;
}

module.exports = { OUTPUT_NAME, PROBE_VARIABLE, buildPerformanceCollector, splitParamBlock, writePerformanceCollector };

if (require.main === module) {
  const outputDir = process.argv[2];
  if (!outputDir) {
    console.error('Usage: node build-performance-collector.cjs <output-dir>');
    process.exitCode = 2;
  } else {
    console.log(writePerformanceCollector(path.resolve(outputDir)));
  }
}
