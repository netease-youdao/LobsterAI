'use strict';

const fs = require('fs');
const path = require('path');
const { parseEnv } = require('util');

const CodownEnv = {
  WorkingCopy: 'CODOWN_WORKING_COPY',
  SvnUrl: 'CODOWN_SVN_URL',
  PublicBaseUrl: 'CODOWN_PUBLIC_BASE_URL',
  TicketUrl: 'CODOWN_TICKET_URL',
  Username: 'CODOWN_SVN_USERNAME',
  Password: 'CODOWN_SVN_PASSWORD',
};

function packagingEnv(root, inherited = process.env) {
  const envPath = path.join(root, '.env');
  const local = fs.existsSync(envPath) ? parseEnv(fs.readFileSync(envPath, 'utf8')) : {};
  return { ...local, ...inherited };
}

function httpsUrl(value, name, { query = false } = {}) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be an HTTPS URL.`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (!query && url.search)) {
    throw new Error(`${name} must use HTTPS without credentials, fragments${query ? '' : ' or query parameters'}.`);
  }
  return url.href.replace(/\/+$/, '');
}

function publicBaseUrl(env) {
  return httpsUrl(env[CodownEnv.PublicBaseUrl], CodownEnv.PublicBaseUrl);
}

function readCodownConfig(env, root) {
  const workingCopy = env[CodownEnv.WorkingCopy]?.trim();
  if (!workingCopy) throw new Error(`${CodownEnv.WorkingCopy} is required.`);
  return {
    workingCopy: path.resolve(root, workingCopy),
    svnUrl: httpsUrl(env[CodownEnv.SvnUrl], CodownEnv.SvnUrl),
    publicBaseUrl: publicBaseUrl(env),
    ticketUrl: httpsUrl(env[CodownEnv.TicketUrl], CodownEnv.TicketUrl, { query: true }),
    username: env[CodownEnv.Username]?.trim() || '',
    password: env[CodownEnv.Password] || '',
  };
}

// Do not forward publisher configuration in the build subprocess environment.
function withoutSvnCredentials(env) {
  const result = { ...env };
  for (const key of Object.values(CodownEnv)) delete result[key];
  return result;
}

module.exports = { CodownEnv, packagingEnv, httpsUrl, publicBaseUrl, readCodownConfig, withoutSvnCredentials };
