'use strict';
const path = require('node:path');

if (!process.env.LOBSTER_CONFIG_QA_DIR) {
  throw new Error('Set LOBSTER_CONFIG_QA_DIR to an isolated acceptance directory. Never use production userData.');
}
const qaDir = path.resolve(process.env.LOBSTER_CONFIG_QA_DIR);
const root = path.resolve(process.env.LOBSTER_CONFIG_QA_ROOT || process.cwd());
const inspectorPort = Number(process.env.LOBSTER_CONFIG_QA_INSPECTOR_PORT || 19564);
const fixturePort = Number(process.env.LOBSTER_CONFIG_QA_FIXTURE_PORT || 19565);
for (const port of [inspectorPort, fixturePort]) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid QA port');
}
module.exports = { qaDir, root, inspectorPort, fixturePort };
