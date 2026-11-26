'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Runs in the pinned runtime. Match EntryTree.getTasks() without importing
// anything or evaluating user config. Local plugin specifiers can be paths.
function reportPendingBootEntries(loader, since) {
  let imports = 0;
  let activations = 0;
  const packages = new Set();
  for (const entry of loader.entries()) {
    if (entry._initTask) imports++;
    else if (entry.fiber?.inertia) activations++;
    else continue;
    const name = entry.options.name;
    if (packages.size < 5 && /^@(?:deepseek-ai|lobsterai)\/[a-z0-9-]{1,64}$/.test(name)) packages.add(name);
  }
  const waitMs = Math.round(performance.now() - since);
  process.stderr.write(`[dsh-logger][info][dsh-startup] [DshStartup] pid=${process.pid} stage=tree-pending waitMs=${waitMs} pendingImports=${imports} pendingActivations=${activations} packages=${[...packages].join(',') || '-'}\n`);
}

// The Cordis log exporter is itself part of the tree being timed. Use its
// stderr envelope so Electron can retain milestones even if loading stalls.
const bootHeader = 'async function boot(binName, absoluteConfigPath, patches, prepare, bareModuleBaseUrl) {';
const timing = [
  '\tlet lastWallMs = 0, lastCpuMs = 0;',
  '\tconst markBoot = (stage) => {',
  '\t\tif (!process.env.LOBSTERAI_DSH_BRIDGE_URL) return;',
  '\t\tconst elapsedMs = Math.round(process.uptime() * 1000);',
  '\t\tconst cpu = process.cpuUsage();',
  '\t\tconst cpuMs = Math.round((cpu.user + cpu.system) / 1000);',
  '\t\tprocess.stderr.write(`[dsh-logger][info][dsh-startup] [DshStartup] pid=${process.pid} stage=${stage} elapsedMs=${elapsedMs} phaseMs=${elapsedMs - lastWallMs} phaseCpuMs=${cpuMs - lastCpuMs}\\n`);',
  '\t\tlastWallMs = elapsedMs;',
  '\t\tlastCpuMs = cpuMs;',
  '\t};',
  '\tmarkBoot("boot-enter");',
].join('\n');
const waitForTree = '\t\tawait ctx.get("loader")?.await();';
const timedWait = [
  '\t\tmarkBoot("root-mounted");',
  '\t\tconst loader = ctx.get("loader");',
  '\t\tconst since = performance.now();',
  '\t\tconst pendingTimer = loader && process.env.LOBSTERAI_DSH_BRIDGE_URL',
  '\t\t\t? setTimeout(() => reportPendingBootEntries(loader, since), 5000).unref() : undefined;',
  '\t\ttry {',
  '\t\t\tawait loader?.await();',
  '\t\t} finally {',
  '\t\t\tclearTimeout(pendingTimer);',
  '\t\t}',
  '\t\tmarkBoot("tree-loaded");',
].join('\n');
const prepare = '\t\tawait prepare?.(ctx);';
const audit = '\t\tawait auditStartupEntries(ctx, binName);';
const sites = [
  [bootHeader, `${reportPendingBootEntries.toString()}\n${bootHeader}\n${timing}`],
  [prepare, `${prepare}\n\t\tmarkBoot("host-prepared");`],
  [waitForTree, timedWait],
  [audit, `${audit}\n\t\tmarkBoot("tree-audited");`],
];

module.exports = {
  description: 'dsh-app-boot: report wall and CPU time at Cordis boot milestones',
  apply(runtimeRoot) {
    const file = path.join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js');
    const source = fs.readFileSync(file, 'utf8');
    let result = source;
    for (const [anchor, replacement] of sites) {
      if (source.includes(replacement)) continue;
      const matches = source.split(anchor).length - 1;
      if (matches !== 1) throw new Error(`dsh-app-boot: expected one "${anchor.trim()}" site, found ${matches}`);
      result = result.replace(anchor, () => replacement);
    }
    if (result === source) return 'startup timings already present';
    fs.writeFileSync(file, result);
    return 'instrumented Cordis boot milestones';
  },
};
