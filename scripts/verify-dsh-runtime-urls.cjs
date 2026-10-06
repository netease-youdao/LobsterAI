'use strict';

// Confirms every configured runtime URL actually serves the bytes the app will
// verify against:
//
//   node scripts/verify-dsh-runtime-urls.cjs [target-id]
//
// Run it after uploading an archive. Without this, a wrong URL, a truncated
// upload, or a stale digest only surfaces on a user's machine as a failed
// install. Streams the download and hashes on the fly, so it needs no disk
// space beyond a few buffers.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const LOG_TAG = '[verify-dsh-runtime-urls]';
const MAX_REDIRECTS = 5;

function log(message) {
  console.log(`${LOG_TAG} ${message}`);
}

function fail(message) {
  console.error(`${LOG_TAG} ${message}`);
  process.exit(1);
}

function hashUrl(url, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const request = client.get(url, { timeout: 10 * 60_000 }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location && redirectsLeft > 0) {
        response.resume();
        resolve(hashUrl(new URL(response.headers.location, url).toString(), redirectsLeft - 1));
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`HTTP ${status}`));
        return;
      }
      const hash = crypto.createHash('sha256');
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        hash.update(chunk);
      });
      response.on('end', () => resolve({ sha256: hash.digest('hex'), size }));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
  });
}

const onlyTarget = (process.argv[2] || '').trim();
const rootDir = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const runtimes = (pkg.dsh && pkg.dsh.runtimes) || {};
const targets = Object.keys(runtimes).filter((target) => !onlyTarget || target === onlyTarget);

if (targets.length === 0) {
  fail(onlyTarget ? `No runtime configured for ${onlyTarget}` : 'No runtimes configured in package.json dsh.runtimes');
}

(async () => {
  let failures = 0;
  for (const target of targets) {
    const expected = runtimes[target];
    log(`Checking ${target} -> ${expected.url}`);
    try {
      const actual = await hashUrl(expected.url);
      if (actual.size !== expected.size) {
        console.error(`${LOG_TAG}   FAIL size: expected ${expected.size}, served ${actual.size}`);
        failures += 1;
        continue;
      }
      if (actual.sha256 !== String(expected.sha256).toLowerCase()) {
        console.error(`${LOG_TAG}   FAIL sha256: expected ${expected.sha256}, served ${actual.sha256}`);
        failures += 1;
        continue;
      }
      log(`  OK ${actual.size} bytes, sha256 matches`);
    } catch (error) {
      console.error(`${LOG_TAG}   FAIL fetch: ${error.message}`);
      failures += 1;
    }
  }
  if (failures > 0) fail(`${failures} target(s) would fail to install`);
  log('All configured runtime URLs serve the expected bytes.');
})();
