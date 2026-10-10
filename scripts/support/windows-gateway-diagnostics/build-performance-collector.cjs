'use strict';

// Builds the single-file startup performance collector sent to customers.
// Usage: node build-performance-collector.cjs <output-dir>
const path = require('node:path');
const { buildSingleFileCollector, splitParamBlock, writeCollector } = require('./single-file-collector.cjs');

const OUTPUT_NAME = 'LobsterAI-Performance-Diagnostics.cmd';
const PROBE_VARIABLE = '$script:EmbeddedPerformanceProbe';

function buildPerformanceCollector(sourceDir = __dirname) {
  return buildSingleFileCollector({
    sourceDir,
    collectorFile: 'collect-performance.ps1',
    probeFile: 'performance-probe.cjs',
    probeVariable: PROBE_VARIABLE,
    title: 'LobsterAI Startup Performance Diagnostics',
  });
}

function writePerformanceCollector(outputDir, sourceDir = __dirname) {
  return writeCollector(outputDir, OUTPUT_NAME, buildPerformanceCollector(sourceDir));
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
