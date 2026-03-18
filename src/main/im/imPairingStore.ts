/**
 * IM Pairing Store
 *
 * Reads and writes OpenClaw pairing JSON files directly from the main process.
 * Compatible with the OpenClaw SDK pairing-store format.
 *
 * File formats:
 *   credentials/<channel>-pairing.json            → { version: 1, requests: PairingRequest[] }
 *   credentials/<channel>-allowFrom.json           → { version: 1, allowFrom: string[] }
 *   credentials/<channel>-<accountId>-allowFrom.json → (account-scoped variant)
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------- Types ----------

export interface PairingRequest {
  id: string;
  code: string;
  createdAt: string;
  lastSeenAt: string;
  meta?: Record<string, string>;
}

interface PairingFileV1 {
  version: number;
  requests: PairingRequest[];
}

interface AllowFromFileV1 {
  version: number;
  allowFrom: string[];
}

// ---------- Constants (match OpenClaw SDK) ----------

const PAIRING_PENDING_TTL_MS = 3600 * 1000; // 1 hour

// ---------- Path helpers ----------

function safeChannelKey(channel: string): string {
  const raw = channel.trim().toLowerCase();
  if (!raw) throw new Error('invalid pairing channel');
  const safe = raw.replace(/[\\/:*?"<>|]/g, '_').replace(/\.\./g, '_');
  if (!safe || safe === '_') throw new Error('invalid pairing channel');
  return safe;
}

function resolveCredentialsDir(stateDir: string): string {
  return path.join(stateDir, 'credentials');
}

function resolvePairingPath(channel: string, stateDir: string): string {
  return path.join(resolveCredentialsDir(stateDir), `${safeChannelKey(channel)}-pairing.json`);
}

function resolveAllowFromPath(channel: string, stateDir: string, accountId?: string): string {
  const base = safeChannelKey(channel);
  const normalized = typeof accountId === 'string' ? accountId.trim().toLowerCase() : '';
  if (!normalized || normalized === 'default') {
    return path.join(resolveCredentialsDir(stateDir), `${base}-allowFrom.json`);
  }
  const safeAccount = normalized.replace(/[\\/:*?"<>|]/g, '_').replace(/\.\./g, '_');
  return path.join(resolveCredentialsDir(stateDir), `${base}-${safeAccount}-allowFrom.json`);
}

// ---------- JSON helpers ----------

function readJsonFileSync<T>(filePath: string, fallback: T): T {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFileSync(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

// ---------- Internal readers ----------

function readPairingFile(channel: string, stateDir: string): PairingRequest[] {
  const filePath = resolvePairingPath(channel, stateDir);
  const file = readJsonFileSync<PairingFileV1>(filePath, { version: 1, requests: [] });
  return Array.isArray(file.requests) ? file.requests : [];
}

function writePairingFile(channel: string, stateDir: string, requests: PairingRequest[]): void {
  const filePath = resolvePairingPath(channel, stateDir);
  writeJsonFileSync(filePath, { version: 1, requests });
}

function readAllowFromFile(channel: string, stateDir: string, accountId?: string): string[] {
  const filePath = resolveAllowFromPath(channel, stateDir, accountId);
  const file = readJsonFileSync<AllowFromFileV1>(filePath, { version: 1, allowFrom: [] });
  return Array.isArray(file.allowFrom) ? file.allowFrom : [];
}

function writeAllowFromFile(channel: string, stateDir: string, allowFrom: string[], accountId?: string): void {
  const filePath = resolveAllowFromPath(channel, stateDir, accountId);
  writeJsonFileSync(filePath, { version: 1, allowFrom });
}

// ---------- Public API ----------

/**
 * List pending pairing requests for a channel, filtering out expired ones.
 */
export function listPairingRequests(channel: string, stateDir: string): PairingRequest[] {
  const requests = readPairingFile(channel, stateDir);
  const now = Date.now();
  return requests.filter((r) => {
    const createdAt = new Date(r.createdAt).getTime();
    return !isNaN(createdAt) && now - createdAt < PAIRING_PENDING_TTL_MS;
  });
}

/**
 * Read the allowFrom store (approved sender IDs) for a channel.
 */
export function readAllowFromStore(channel: string, stateDir: string): string[] {
  return readAllowFromFile(channel, stateDir);
}

/**
 * Approve a pairing request by code.
 * Removes the request from the pairing file and adds the sender ID to allowFrom.
 * Returns the approved request, or null if the code was not found.
 */
export function approvePairingCode(
  channel: string,
  code: string,
  stateDir: string,
): PairingRequest | null {
  const requests = readPairingFile(channel, stateDir);

  const upperCode = code.toUpperCase().trim();
  const idx = requests.findIndex((r) => r.code === upperCode);
  if (idx === -1) return null;

  const [approved] = requests.splice(idx, 1);

  // Write back remaining requests (versioned format)
  writePairingFile(channel, stateDir, requests);

  // Resolve accountId from request meta (default account uses simple path)
  const accountId = approved.meta?.accountId;

  // Add to allowFrom
  const allowFrom = readAllowFromFile(channel, stateDir, accountId);
  if (!allowFrom.includes(approved.id)) {
    allowFrom.push(approved.id);
    writeAllowFromFile(channel, stateDir, allowFrom, accountId);
  }

  return approved;
}

/**
 * Reject a pairing request by code.
 * Removes the request from the pairing file without adding to allowFrom.
 * Returns the rejected request, or null if the code was not found.
 */
export function rejectPairingRequest(
  channel: string,
  code: string,
  stateDir: string,
): PairingRequest | null {
  const requests = readPairingFile(channel, stateDir);

  const upperCode = code.toUpperCase().trim();
  const idx = requests.findIndex((r) => r.code === upperCode);
  if (idx === -1) return null;

  const [rejected] = requests.splice(idx, 1);
  writePairingFile(channel, stateDir, requests);

  return rejected;
}
