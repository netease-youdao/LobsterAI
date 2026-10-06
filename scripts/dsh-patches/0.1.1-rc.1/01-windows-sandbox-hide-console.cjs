'use strict';

// Hide the console window Windows shows for every sandboxed child.
//
// dsh's Windows ACL sandbox spawns through CreateProcessW with
// STARTF_USESTDHANDLES (256) only, so each tool run flashes a console window.
// Adding STARTF_USESHOWWINDOW (1) with wShowWindow: SW_HIDE (0) keeps the
// child headless. The struct already declares `wShowWindow: "uint16"`, so the
// extra field is honoured rather than dropped by koffi.
//
// Written as a transform rather than a diff: the published bundle's filename
// carries a content hash, and `git apply` silently skips paths under a
// gitignored vendor directory (it resolves diff paths against the repo root).

const fs = require('fs');
const path = require('path');

const TARGET_DIR = ['node_modules', '@deepseek-ai', 'dsh-sandbox-windows-acl', 'lib'];
const FROM = '\t\tcb: 104,\n\t\tdwFlags: 256,';
const TO = '\t\tcb: 104,\n\t\tdwFlags: 257,\n\t\twShowWindow: 0,';
const EXPECTED_SITES = 2;

module.exports = {
  description: 'Windows sandbox: spawn sandboxed children with SW_HIDE so no console flashes',
  apply(runtimeRoot) {
    const libDir = path.join(runtimeRoot, ...TARGET_DIR);
    if (!fs.existsSync(libDir)) {
      throw new Error(`dsh-sandbox-windows-acl is not installed at ${libDir}`);
    }
    for (const name of fs.readdirSync(libDir).filter((entry) => entry.endsWith('.js'))) {
      const filePath = path.join(libDir, name);
      const contents = fs.readFileSync(filePath, 'utf8');
      const sites = contents.split(FROM).length - 1;
      if (sites === 0) continue;
      if (sites !== EXPECTED_SITES) {
        throw new Error(`${name}: expected ${EXPECTED_SITES} sandboxed spawn sites, found ${sites}`);
      }
      fs.writeFileSync(filePath, contents.split(FROM).join(TO));
      return `${name} (${EXPECTED_SITES} spawn sites)`;
    }
    throw new Error('no file in dsh-sandbox-windows-acl/lib contains the sandboxed spawn startup info');
  },
};
