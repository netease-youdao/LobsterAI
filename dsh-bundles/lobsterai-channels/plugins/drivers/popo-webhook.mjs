import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { decryptPopoEvent } from './popo-protocol.mjs';

// Existing bots can share a port, with individual account URLs and signing tokens.
const listeners = new Map();
const MAX_BODY_BYTES = 1024 * 1024;

function validSignature(query, token) {
  const signature = query.get('signature');
  const timestamp = query.get('timestamp');
  const nonce = query.get('nonce');
  if (!timestamp || !nonce || !/^[a-f0-9]{64}$/i.test(signature ?? '')) return false;
  const digest = createHash('sha256').update([token, timestamp, nonce].sort().join('')).digest();
  return timingSafeEqual(digest, Buffer.from(signature, 'hex'));
}

async function receive(accounts, req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const routes = [...accounts].filter(({ paths }) => paths.includes(url.pathname));
    if (!routes.length) return res.writeHead(404).end();
    const matches = routes.filter(({ config }) => validSignature(url.searchParams, config.token));
    if (matches.length !== 1) return res.writeHead(401).end();
    const { config, onEvent } = matches[0];
    if (req.method === 'GET') return res.writeHead(200, { 'content-type': 'text/plain' }).end(url.searchParams.get('nonce'));
    if (req.method !== 'POST') return res.writeHead(405).end();
    let length = 0;
    const chunks = [];
    for await (const chunk of req) {
      length += chunk.length;
      if (length > MAX_BODY_BYTES) return res.writeHead(413).end();
      chunks.push(chunk);
    }
    const { encrypt } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const event = decryptPopoEvent(encrypt, config.aesKey);
    await onEvent(event);
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"text":"success"}');
  } catch {
    if (!res.headersSent) res.writeHead(400);
    res.end();
  }
}

export async function listenPopoWebhook(config, instanceId, onEvent) {
  const port = Number(config.webhookPort || 3100);
  const path = (config.webhookPath || '/popo/callback').replace(/\/$/, '');
  const account = { config, onEvent, paths: [path, path + '/' + instanceId, path + '/' + instanceId.slice(0, 8)] };
  let entry = listeners.get(port);
  if (!entry) {
    const accounts = new Set();
    const server = createServer({ requestTimeout: 15_000 }, (req, res) => { void receive(accounts, req, res); });
    const ready = new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, () => { server.off('error', reject); resolve(); });
    });
    entry = { accounts, server, ready };
    listeners.set(port, entry);
  }
  entry.accounts.add(account);
  try {
    await entry.ready;
  } catch (err) {
    if (listeners.get(port) === entry) listeners.delete(port);
    throw err;
  }
  return async () => {
    entry.accounts.delete(account);
    if (!entry.accounts.size && listeners.get(port) === entry) {
      listeners.delete(port);
      await new Promise(resolve => entry.server.close(resolve));
    }
  };
}
