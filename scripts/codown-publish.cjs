'use strict';

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { parseArgs } = require('util');
const { packagingEnv, readCodownConfig } = require('./codown-config.cjs');
const { artifactUrl, readManifest } = require('./codown-artifacts.cjs');
const { publishManifest } = require('./codown-svn.cjs');

function printFollowUp(manifest, config, receipt, manifestPath) {
  if (receipt.dryRun) console.log('[Codown] Dry run completed; no files were copied or committed.');
  else console.log(`[Codown] ${receipt.uploaded.length ? 'Submitted to' : 'Already present in'} SVN at r${receipt.revision}; awaiting manual deployment.`);
  for (const artifact of manifest.artifacts) console.log(`[Codown] ${artifact.kind}: ${artifactUrl(manifest.publicBaseUrl, manifest.keyfrom, artifact.name)}`);
  console.log(`[Codown] Manual deployment: ${config.ticketUrl}`);
  console.log(`[Codown] Select the product directory ${path.basename(new URL(config.svnUrl).pathname)}${receipt.dryRun ? ' after submission' : ` and include r${receipt.revision}`}. No ticket has been created.`);
  console.log(`[Codown] After deployment: npm run codown:verify -- --manifest "${manifestPath}"`);
  console.log('[Codown] Configure Overmind manually after download verification succeeds.');
}

async function verifyManifest(manifestPath, { fetchImpl = fetch } = {}) {
  const manifest = await readManifest(manifestPath);
  for (const artifact of manifest.artifacts) {
    const url = artifactUrl(manifest.publicBaseUrl, manifest.keyfrom, artifact.name);
    const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(30 * 60 * 1000) });
    if (!response.ok || !response.body) throw new Error(`Download unavailable for ${artifact.name}: HTTP ${response.status}. Complete manual deployment first.`);
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > artifact.size) throw new Error(`Download size mismatch: ${artifact.name}`);
      hash.update(chunk);
    }
    if (size !== artifact.size || hash.digest('hex') !== artifact.sha256) throw new Error(`Download checksum mismatch: ${artifact.name}`);
    console.log(`[Codown] Verified ${artifact.kind}: ${url}`);
  }
  console.log('[Codown] All downloads match the release snapshot. Installer URLs are ready for manual Overmind configuration.');
}

async function publishAndReport(manifestPath, config, options = {}) {
  const receipt = await publishManifest(manifestPath, config, options);
  if (!receipt.dryRun) fs.writeFileSync(path.join(path.dirname(path.resolve(manifestPath)), 'svn-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  printFollowUp(await readManifest(manifestPath), config, receipt, manifestPath);
  return receipt;
}

async function main() {
  const { values } = parseArgs({ options: { manifest: { type: 'string' }, verify: { type: 'boolean' }, 'dry-run': { type: 'boolean' } } });
  if (!values.manifest || (values.verify && values['dry-run'])) throw new Error('Usage: codown:publish -- --manifest <path> [--dry-run], or codown:verify -- --manifest <path>');
  if (values.verify) return verifyManifest(values.manifest);
  const root = path.join(__dirname, '..');
  return publishAndReport(values.manifest, readCodownConfig(packagingEnv(root), root), { dryRun: values['dry-run'] === true });
}

if (require.main === module) main().catch(error => { console.error(`[Codown] ${error.message}`); process.exitCode = 1; });
module.exports = { verifyManifest, publishAndReport };
