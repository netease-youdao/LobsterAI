'use strict';

/**
 * electron-builder custom Windows code-signing hook.
 *
 * Uploads each binary produced by the build (app exe, uninstaller, installer)
 * to the internal Youdao signing service and replaces the local file with the
 * signed result. This closes the "signed installer shell, unsigned payload"
 * gap: security software freezes the unsigned LobsterAI.exe on first
 * execution, which is what hung installations in the field.
 *
 * Service API (per the official signing-service doc):
 *   POST /api/sign
 *     headers: x-app-key, x-app-secret, x-username
 *     body:    multipart, files=<binary> (application/octet-stream)
 *     ->       {results: [{originalName, downloadUrl, ...}]}
 *   GET <downloadUrl>   same auth headers, returns the signed file
 *
 * NEVER call the service's /api/cleanup from automation: it deletes every
 * file on the shared server, including other teams' in-flight jobs.
 *
 * Credentials (process env wins; missing keys are filled from the repo-root
 * .env file, same convention as the Apple notarization credentials). The
 * service URL is internal infrastructure and is deliberately NOT hardcoded
 * here -- ask the signing service team for all four values:
 *   YD_SIGN_SERVICE_URL   signing service base URL
 *   YD_SIGN_APP_KEY       service app key
 *   YD_SIGN_APP_SECRET    service app secret
 *   YD_SIGN_USERNAME      requesting user (shown in the service's audit log)
 *
 * Missing values -> the hook logs one warning and skips, so local dev
 * packaging keeps producing (unsigned) artifacts. See .env.example.
 */

const fs = require('fs');
const path = require('path');

const SERVICE_URL_ENV = 'YD_SIGN_SERVICE_URL';
const APP_KEY_ENV = 'YD_SIGN_APP_KEY';
const APP_SECRET_ENV = 'YD_SIGN_APP_SECRET';
const USERNAME_ENV = 'YD_SIGN_USERNAME';

const REQUEST_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 2;

let warnedAboutMissingCredentials = false;
const signedThisRun = new Set();

/**
 * Minimal dependency-free .env loader (KEY=VALUE lines, # comments,
 * optional surrounding quotes). Existing process.env values always win,
 * matching dotenv semantics. Values are never logged.
 */
function loadDotEnv(envPath = path.join(__dirname, '..', '.env')) {
  let content;
  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch {
    return;
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadDotEnv();

/**
 * Read the PE Attribute Certificate Table (data directory #4) entry.
 * Returns {offset, size} when the file carries an Authenticode signature,
 * null when it is a valid PE without one. Throws for non-PE files.
 */
function readPeCertTable(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(4096);
    const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
    if (bytesRead < 0x40 || header.toString('latin1', 0, 2) !== 'MZ') {
      throw new Error(`${filePath} is not a PE file (missing MZ header)`);
    }
    const eLfanew = header.readUInt32LE(0x3c);
    if (eLfanew + 24 > bytesRead || header.toString('latin1', eLfanew, eLfanew + 4) !== 'PE\0\0') {
      throw new Error(`${filePath} is not a PE file (missing PE signature)`);
    }
    const optOff = eLfanew + 4 + 20;
    const magic = header.readUInt16LE(optOff);
    let ddOff;
    if (magic === 0x10b) {
      ddOff = optOff + 96; // PE32
    } else if (magic === 0x20b) {
      ddOff = optOff + 112; // PE32+
    } else {
      throw new Error(`${filePath} has unknown optional header magic 0x${magic.toString(16)}`);
    }
    const certEntryOff = ddOff + 4 * 8;
    if (certEntryOff + 8 > bytesRead) {
      throw new Error(`${filePath} PE header is truncated`);
    }
    const offset = header.readUInt32LE(certEntryOff);
    const size = header.readUInt32LE(certEntryOff + 4);
    if (offset === 0 || size === 0) {
      return null;
    }
    return { offset, size };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * People paste whatever URL is at hand -- the doc's full /api/sign endpoint
 * or the manual upload page. Normalize all of them to the service root
 * (a raw endpoint would otherwise double up into /api/sign/api/sign).
 */
function normalizeServiceUrl(rawUrl) {
  return rawUrl
    .replace(/\/+$/, '')
    .replace(/\/sign\.html$/i, '')
    .replace(/\/api\/sign$/i, '')
    .replace(/\/+$/, '');
}

function resolveServiceConfig() {
  const serviceUrl = (process.env[SERVICE_URL_ENV] || '').trim();
  const appKey = (process.env[APP_KEY_ENV] || '').trim();
  const appSecret = (process.env[APP_SECRET_ENV] || '').trim();
  const username = (process.env[USERNAME_ENV] || '').trim();
  if (!serviceUrl || !appKey || !appSecret || !username) {
    return null;
  }
  const baseUrl = normalizeServiceUrl(serviceUrl);
  return {
    baseUrl,
    headers: {
      'x-app-key': appKey,
      'x-app-secret': appSecret,
      'x-username': username,
    },
  };
}

async function safeText(response) {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return '';
  }
}

async function fileToBlob(filePath) {
  if (typeof fs.openAsBlob === 'function') {
    return fs.openAsBlob(filePath, { type: 'application/octet-stream' });
  }
  return new Blob([await fs.promises.readFile(filePath)], { type: 'application/octet-stream' });
}

async function signOnce(serviceConfig, filePath) {
  const fileName = path.basename(filePath);

  const formData = new FormData();
  formData.append('files', await fileToBlob(filePath), fileName);

  const signResponse = await fetch(`${serviceConfig.baseUrl}/api/sign`, {
    method: 'POST',
    headers: serviceConfig.headers,
    body: formData,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!signResponse.ok) {
    throw new Error(`[WinSign] sign request failed: HTTP ${signResponse.status} ${await safeText(signResponse)}`);
  }

  const payload = await signResponse.json();
  const result = Array.isArray(payload?.results) ? payload.results[0] : null;
  if (!result?.downloadUrl) {
    throw new Error(`[WinSign] unexpected sign response: ${JSON.stringify(payload).slice(0, 300)}`);
  }

  const downloadUrl = new URL(result.downloadUrl, `${serviceConfig.baseUrl}/`).toString();
  const downloadResponse = await fetch(downloadUrl, {
    headers: serviceConfig.headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!downloadResponse.ok) {
    throw new Error(`[WinSign] download failed: HTTP ${downloadResponse.status} ${await safeText(downloadResponse)}`);
  }
  const signedBytes = Buffer.from(await downloadResponse.arrayBuffer());

  const originalSize = fs.statSync(filePath).size;
  if (signedBytes.length < originalSize) {
    throw new Error(
      `[WinSign] signed file is smaller than the original (${signedBytes.length} < ${originalSize} bytes), refusing to replace ${fileName}`,
    );
  }

  const tmpPath = `${filePath}.ydsign.tmp`;
  fs.writeFileSync(tmpPath, signedBytes);
  try {
    const certTable = readPeCertTable(tmpPath);
    if (!certTable) {
      throw new Error(`[WinSign] service returned ${fileName} without an Authenticode signature`);
    }
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    fs.rmSync(tmpPath, { force: true });
    throw error;
  }
}

/**
 * Sign one binary in place through the internal service.
 * Returns true when the file ends up signed, false when signing was skipped
 * (no credentials, or the file already carries a signature).
 */
async function signFile(filePath) {
  const serviceConfig = resolveServiceConfig();
  if (!serviceConfig) {
    if (!warnedAboutMissingCredentials) {
      warnedAboutMissingCredentials = true;
      console.warn(
        `[WinSign] ${SERVICE_URL_ENV}/${APP_KEY_ENV}/${APP_SECRET_ENV}/${USERNAME_ENV} are not fully set (env or .env) -- `
        + 'Windows binaries will NOT be signed. This is fine for local dev builds and must never happen on release CI. '
        + 'See .env.example.',
      );
    }
    return false;
  }

  const normalizedPath = path.resolve(filePath);
  if (signedThisRun.has(normalizedPath)) {
    return true;
  }
  if (readPeCertTable(normalizedPath)) {
    console.log(`[WinSign] ${path.basename(normalizedPath)} already carries a signature, skipping`);
    signedThisRun.add(normalizedPath);
    return false;
  }

  const sizeMb = (fs.statSync(normalizedPath).size / (1024 * 1024)).toFixed(1);
  console.log(`[WinSign] signing ${path.basename(normalizedPath)} (${sizeMb} MB) via ${serviceConfig.baseUrl}`);
  const t0 = Date.now();

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await signOnce(serviceConfig, normalizedPath);
      signedThisRun.add(normalizedPath);
      console.log(`[WinSign] signed ${path.basename(normalizedPath)} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return true;
    } catch (error) {
      lastError = error;
      console.warn(`[WinSign] attempt ${attempt}/${MAX_ATTEMPTS} failed for ${path.basename(normalizedPath)}:`, error.message);
    }
  }
  throw lastError;
}

/**
 * electron-builder `win.sign` entry point. Called once per binary that needs
 * a signature (app exe, uninstaller, installer; some versions also pass
 * hash variants for the same file -- deduplicated via signedThisRun).
 */
async function signWindowsBinary(configuration) {
  await signFile(configuration.path);
}

function _resetForTests() {
  warnedAboutMissingCredentials = false;
  signedThisRun.clear();
}

module.exports = signWindowsBinary;
module.exports.default = signWindowsBinary;
module.exports.signFile = signFile;
module.exports.readPeCertTable = readPeCertTable;
module.exports.loadDotEnv = loadDotEnv;
module.exports._resetForTests = _resetForTests;
