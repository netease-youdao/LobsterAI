'use strict';

// Which `tar` to run on this host.
//
// Windows ships bsdtar as %SystemRoot%\System32\tar.exe, but a dev PATH often
// puts GNU tar first (Git for Windows, MSYS2, Cygwin). GNU tar reads an
// absolute Windows path as `host:file`, so `-xzf C:\...` fails with
// "Cannot connect to C: resolve failed" — every archive step dies on a machine
// that merely has Git Bash on PATH. Naming the system copy keeps that out of
// the picture; elsewhere PATH lookup is right.

const fs = require('fs');
const path = require('path');

function resolveTarCommand() {
  if (process.platform !== 'win32') return 'tar';
  const systemTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return fs.existsSync(systemTar) ? systemTar : 'tar';
}

module.exports = { resolveTarCommand };
