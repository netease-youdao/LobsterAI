'use strict';

// Builds the single-file network filter collector sent to customers.
// Usage: node build-network-filter-collector.cjs <output-dir>
const path = require('node:path');
const { buildSingleFileCollector, writeCollector } = require('./single-file-collector.cjs');

const OUTPUT_NAME = 'LobsterAI-Network-Filter-Diagnostics.cmd';
const PROBE_VARIABLE = '$script:EmbeddedFilterProbe';

function buildNetworkFilterCollector(sourceDir = __dirname) {
  return buildSingleFileCollector({
    sourceDir,
    collectorFile: 'collect-network-filters.ps1',
    probeFile: 'network-filter-probe.ps1',
    probeVariable: PROBE_VARIABLE,
    title: 'LobsterAI Network Filter Diagnostics',
  });
}

function writeNetworkFilterCollector(outputDir, sourceDir = __dirname) {
  return writeCollector(outputDir, OUTPUT_NAME, buildNetworkFilterCollector(sourceDir));
}

module.exports = { OUTPUT_NAME, PROBE_VARIABLE, buildNetworkFilterCollector, writeNetworkFilterCollector };

if (require.main === module) {
  const outputDir = process.argv[2];
  if (!outputDir) {
    console.error('Usage: node build-network-filter-collector.cjs <output-dir>');
    process.exitCode = 2;
  } else {
    console.log(writeNetworkFilterCollector(path.resolve(outputDir)));
  }
}
