'use strict';

// Hide the console window Windows shows for every child dsh creates itself.
//
// dsh 0.1.5 moved CreateProcess into @deepseek-ai/dsh-win32-process, and both
// STARTUPINFOW sites there still pass STARTF_USESTDHANDLES (256) only:
//
//   - spawnPipedProcess: sandboxed children with piped stdio;
//   - spawnJobProcess: sandboxed runner children and, new in 0.1.5, every
//     ordinary subprocess (dsh-subprocess-local's Windows Job runner).
//
// LobsterAI runs dsh as the Electron executable, a GUI-subsystem process with
// no console, so each console program it starts gets a fresh, visible console
// window. Adding STARTF_USESHOWWINDOW (1) with wShowWindow: SW_HIDE (0) keeps
// the child headless, matching the windowsHide spawn dsh's fallback path
// already uses. CREATE_NO_WINDOW is not an option for the sandboxed sites:
// restricted-token children created with it die with STATUS_DLL_INIT_FAILED.
//
// Upstream ships this exact change from 0.1.6-alpha.2. Drop this patch once
// the pinned version includes it; the build fails here when it does.
//
// Written as a transform rather than a diff: `git apply` silently skips paths
// under a gitignored vendor directory (it resolves diff paths against the repo
// root).

const fs = require('fs');
const path = require('path');

const TARGET = ['node_modules', '@deepseek-ai', 'dsh-win32-process', 'lib', 'index.js'];
const FROM = '\t\t\tcb: 104,\n\t\t\tdwFlags: 256,';
const TO = '\t\t\tcb: 104,\n\t\t\tdwFlags: 257,\n\t\t\twShowWindow: 0,';
const EXPECTED_SITES = 2;

module.exports = {
  description: 'Win32 process spawns: start children with SW_HIDE so no console flashes',
  apply(runtimeRoot) {
    const filePath = path.join(runtimeRoot, ...TARGET);
    if (!fs.existsSync(filePath)) {
      throw new Error(`dsh-win32-process is not installed at ${filePath}`);
    }
    const contents = fs.readFileSync(filePath, 'utf8');
    const sites = contents.split(FROM).length - 1;
    if (sites !== EXPECTED_SITES) {
      throw new Error(`index.js: expected ${EXPECTED_SITES} STARTUPINFOW spawn sites, found ${sites}`);
    }
    fs.writeFileSync(filePath, contents.split(FROM).join(TO));
    return `index.js (${EXPECTED_SITES} spawn sites)`;
  },
};
