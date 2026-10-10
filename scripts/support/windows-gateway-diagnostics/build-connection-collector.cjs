'use strict';

// Builds the single-file engine connection collector sent to customers.
// Usage: node build-connection-collector.cjs <output-dir>
const path = require('node:path');
const { buildSingleFileCollector, writeCollector } = require('./single-file-collector.cjs');

const OUTPUT_NAME = 'LobsterAI-Connection-Diagnostics.cmd';
const PROBE_VARIABLE = '$script:EmbeddedConnectionProbe';

function buildConnectionCollector(sourceDir = __dirname) {
  return buildSingleFileCollector({
    sourceDir,
    collectorFile: 'collect-connection.ps1',
    probeFile: 'connection-probe.cjs',
    probeVariable: PROBE_VARIABLE,
    title: 'LobsterAI Engine Connection Diagnostics',
  });
}

function writeConnectionCollector(outputDir, sourceDir = __dirname) {
  return writeCollector(outputDir, OUTPUT_NAME, buildConnectionCollector(sourceDir));
}

module.exports = { OUTPUT_NAME, PROBE_VARIABLE, buildConnectionCollector, writeConnectionCollector };

if (require.main === module) {
  const outputDir = process.argv[2];
  if (!outputDir) {
    console.error('Usage: node build-connection-collector.cjs <output-dir>');
    process.exitCode = 2;
  } else {
    console.log(writeConnectionCollector(path.resolve(outputDir)));
  }
}
