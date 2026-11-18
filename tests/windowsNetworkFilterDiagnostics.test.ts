import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const toolDirectory = path.resolve(__dirname, '../scripts/support/windows-gateway-diagnostics');
const { buildNetworkFilterCollector, PROBE_VARIABLE } = require('../scripts/support/windows-gateway-diagnostics/build-network-filter-collector.cjs');

test('builds one launcher that embeds the collector, helpers and the elevated probe', () => {
  const text: string = buildNetworkFilterCollector();
  // cmd.exe would treat a BOM as part of the first command.
  expect(text.charCodeAt(0)).toBe('<'.charCodeAt(0));
  expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  const lines = text.split('\r\n');
  const batchEnd = lines.indexOf('#>');
  expect(lines.slice(0, batchEnd).join('\n')).not.toMatch(/[^\x20-\x7e\n]/);
  expect(lines).toContain('title LobsterAI Network Filter Diagnostics');
  expect(lines[batchEnd + 1]).toBe('param(');
  expect(text).toContain('function Protect-DiagnosticText');
  // The elevated probe travels as data and is written out with a BOM before it runs.
  const probeStart = lines.indexOf(`${PROBE_VARIABLE} = @'`);
  const probeEnd = lines.indexOf("'@", probeStart);
  // The probe has its own param block; outside the embedded data there is exactly one.
  const outsideProbe = [...lines.slice(0, probeStart), ...lines.slice(probeEnd + 1)];
  expect(outsideProbe.filter((line) => line.startsWith('param(')).length).toBe(1);
  const probeSource = fs.readFileSync(path.join(toolDirectory, 'network-filter-probe.ps1'), 'utf8')
    .replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trimEnd();
  expect(probeStart).toBeGreaterThan(batchEnd);
  expect(lines.slice(probeStart + 1, probeEnd).join('\n')).toBe(probeSource);
  expect(text).toContain('[IO.File]::WriteAllText($probePath, $script:EmbeddedFilterProbe, (New-Object Text.UTF8Encoding($true)))');
  expect(text).toContain('-Verb RunAs -Wait -PassThru');
});

test('keeps Chinese PowerShell sources readable by Windows PowerShell -File', () => {
  for (const name of ['collect-network-filters.ps1', 'network-filter-probe.ps1', 'collect-connection.ps1']) {
    const bytes = fs.readFileSync(path.join(toolDirectory, name));
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  }
});
