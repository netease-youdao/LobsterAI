'use strict';

const fs = require('fs');

const OBSERVED_CREDENTIALS = [
  '    // LobsterAI: observe failures before wait starts, preserving its rejection result.',
  '    void credentialsPromise.catch(() => {});',
].join('\n');

function patchQQQrLogin(runtimePath) {
  const original = fs.readFileSync(runtimePath, 'utf8');
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const source = original.replace(/\r\n/g, '\n');
  const start = source.indexOf('function startQrLogin(');
  const end = source.indexOf('function parseChannelInput(', start);
  if (start < 0 || end < 0 || source.indexOf('function startQrLogin(', start + 1) >= 0) {
    throw new Error('[qqbot-package] Review the published QQ QR login lifecycle before bundling.');
  }
  const section = source.slice(start, end);
  const guardedCleanup = 'if (pendingSessions.get(key) === session) pendingSessions.delete(key);';
  if (section.includes(OBSERVED_CREDENTIALS)) {
    if (section.split(guardedCleanup).length !== 3 || !section.includes('resolve2({ message: err instanceof Error ? err.message : String(err) });')) {
      throw new Error('[qqbot-package] The QQ QR login lifecycle patch is incomplete.');
    }
    return;
  }
  const promiseBoundary = '      credentialsReject = rej;\n    });\n';
  const failure = '        onFailure: (err) => credentialsReject(err)';
  const cleanup = '    pendingSessions.delete(key);';
  if (section.split(promiseBoundary).length !== 2 || section.split(failure).length !== 2
      || section.split(cleanup).length !== 3) {
    throw new Error('[qqbot-package] Review the published QQ QR login lifecycle before bundling.');
  }
  const patched = section
    .replace(promiseBoundary, `${promiseBoundary}${OBSERVED_CREDENTIALS}\n`)
    .replace(failure, [
      '        onFailure: (err) => {',
      '          credentialsReject(err);',
      '          // Settle start too when obtaining the QR code fails.',
      '          resolve2({ message: err instanceof Error ? err.message : String(err) });',
      '        }',
    ].join('\n'))
    .replaceAll(cleanup, `    ${guardedCleanup}`);
  fs.writeFileSync(runtimePath, (source.slice(0, start) + patched + source.slice(end)).replace(/\n/g, newline));
}

module.exports = { patchQQQrLogin };
