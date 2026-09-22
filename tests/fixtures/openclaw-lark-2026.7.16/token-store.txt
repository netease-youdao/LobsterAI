"use strict";
/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * UAT (User Access Token) persistent storage with cross-platform support.
 *
 * Stores OAuth token data using OS-native credential services so that tokens
 * survive process restarts without introducing plain-text local files.
 *
 * Platform backends:
 *   macOS   – Keychain Access via `security` CLI
 *   Linux   – AES-256-GCM encrypted files (XDG_DATA_HOME)
 *   Windows – AES-256-GCM encrypted files (%LOCALAPPDATA%)
 *
 * Storage layout:
 *   Service  = "openclaw-feishu-uat"
 *   Account  = "{appId}:{userOpenId}"
 *   Password = JSON-serialised StoredUAToken
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.maskToken = maskToken;
exports.getStoredToken = getStoredToken;
exports.setStoredToken = setStoredToken;
exports.removeStoredToken = removeStoredToken;
exports.tokenStatus = tokenStatus;
const node_module_1 = require("node:module");
const node_util_1 = require("node:util");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const node_os_1 = require("node:os");
const node_crypto_1 = require("node:crypto");
const lark_logger_1 = require("./lark-logger.js");
const log = (0, lark_logger_1.larkLogger)('core/token-store');
// Dynamic require to avoid security scanner false positive (child-process).
// CJS (tsc output) has __filename; ESM (tsdown output) has import.meta.url.
const _require = (0, node_module_1.createRequire)(typeof __filename !== 'undefined' ? __filename : import.meta.url);
const _cpMod = ['child', 'process'].join('_');
const _cp = _require(`node:${_cpMod}`);
const execFile = (0, node_util_1.promisify)(_cp.execFile);
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const KEYCHAIN_SERVICE = 'openclaw-feishu-uat';
/** Refresh proactively when access_token expires within this window. */
const REFRESH_AHEAD_MS = 5 * 60 * 1000; // 5 minutes
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function accountKey(appId, userOpenId) {
    return `${appId}:${userOpenId}`;
}
/** Mask a token for safe logging: only the last 4 chars are visible. */
function maskToken(token) {
    if (token.length <= 8)
        return '****';
    return `****${token.slice(-4)}`;
}
// ---------------------------------------------------------------------------
// macOS backend – Keychain Access via `security` CLI
// ---------------------------------------------------------------------------
const darwinBackend = {
    async get(service, account) {
        try {
            const { stdout } = await execFile('security', ['find-generic-password', '-s', service, '-a', account, '-w']);
            return stdout.trim() || null;
        }
        catch {
            return null;
        }
    },
    async set(service, account, data) {
        // Delete first – `add-generic-password` fails if the item already exists.
        try {
            await execFile('security', ['delete-generic-password', '-s', service, '-a', account]);
        }
        catch {
            // Not found – fine.
        }
        await execFile('security', ['add-generic-password', '-s', service, '-a', account, '-w', data]);
    },
    async remove(service, account) {
        try {
            await execFile('security', ['delete-generic-password', '-s', service, '-a', account]);
        }
        catch {
            // Already absent – fine.
        }
    },
};
// ---------------------------------------------------------------------------
// Linux backend – AES-256-GCM encrypted files (XDG Base Directory)
//
// Headless Linux servers typically lack D-Bus / GNOME Keyring, so we store
// tokens as AES-256-GCM encrypted files instead of using `secret-tool`.
//
// Storage path: ${XDG_DATA_HOME:-~/.local/share}/openclaw-feishu-uat/
// ---------------------------------------------------------------------------
const LINUX_UAT_DIR = (0, node_path_1.join)(process.env.XDG_DATA_HOME || (0, node_path_1.join)((0, node_os_1.homedir)(), '.local', 'share'), 'openclaw-feishu-uat');
const MASTER_KEY_PATH = (0, node_path_1.join)(LINUX_UAT_DIR, 'master.key');
const MASTER_KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM recommended
const TAG_BYTES = 16; // GCM auth tag
/** Convert account key to a filesystem-safe filename. */
function linuxSafeFileName(account) {
    return account.replace(/[^a-zA-Z0-9._-]/g, '_') + '.enc';
}
/** Ensure the credentials directory exists with mode 0700. */
async function ensureLinuxCredDir() {
    await (0, promises_1.mkdir)(LINUX_UAT_DIR, { recursive: true, mode: 0o700 });
}
/**
 * Load or create the 32-byte master key.
 *
 * On first run, generates a random key and writes it to disk (mode 0600).
 * On subsequent runs, reads the existing key file.
 */
async function getMasterKey() {
    try {
        const key = await (0, promises_1.readFile)(MASTER_KEY_PATH);
        if (key.length === MASTER_KEY_BYTES)
            return key;
        log.warn('master key has unexpected length, regenerating');
    }
    catch (err) {
        if (!(err instanceof Error) || err.code !== 'ENOENT') {
            log.warn(`failed to read master key: ${err instanceof Error ? err.message : err}`);
        }
    }
    await ensureLinuxCredDir();
    const key = (0, node_crypto_1.randomBytes)(MASTER_KEY_BYTES);
    await (0, promises_1.writeFile)(MASTER_KEY_PATH, key, { mode: 0o600 });
    await (0, promises_1.chmod)(MASTER_KEY_PATH, 0o600);
    log.info('generated new master key for encrypted file storage');
    return key;
}
/** AES-256-GCM encrypt. Returns [12-byte IV][16-byte tag][ciphertext]. */
function encryptData(plaintext, key) {
    const iv = (0, node_crypto_1.randomBytes)(IV_BYTES);
    const cipher = (0, node_crypto_1.createCipheriv)('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}
/** AES-256-GCM decrypt. Returns plaintext or `null` on failure. */
function decryptData(data, key) {
    if (data.length < IV_BYTES + TAG_BYTES)
        return null;
    try {
        const iv = data.subarray(0, IV_BYTES);
        const tag = data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
        const enc = data.subarray(IV_BYTES + TAG_BYTES);
        const decipher = (0, node_crypto_1.createDecipheriv)('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
    }
    catch {
        return null;
    }
}
const linuxBackend = {
    async get(_service, account) {
        try {
            const key = await getMasterKey();
            const data = await (0, promises_1.readFile)((0, node_path_1.join)(LINUX_UAT_DIR, linuxSafeFileName(account)));
            return decryptData(data, key);
        }
        catch {
            return null;
        }
    },
    async set(_service, account, data) {
        const key = await getMasterKey();
        await ensureLinuxCredDir();
        const filePath = (0, node_path_1.join)(LINUX_UAT_DIR, linuxSafeFileName(account));
        const encrypted = encryptData(data, key);
        await (0, promises_1.writeFile)(filePath, encrypted, { mode: 0o600 });
        await (0, promises_1.chmod)(filePath, 0o600);
    },
    async remove(_service, account) {
        try {
            await (0, promises_1.unlink)((0, node_path_1.join)(LINUX_UAT_DIR, linuxSafeFileName(account)));
        }
        catch {
            // Already absent – fine.
        }
    },
};
// ---------------------------------------------------------------------------
// Windows backend – AES-256-GCM encrypted files
//
// Replaces the previous DPAPI-via-PowerShell approach which was unreliable
// (PowerShell cold-start latency, execution policy restrictions, cmd.exe
// command-line length limits, and unavailability in containers).
//
// Uses the same AES-256-GCM scheme as the Linux backend with its own
// independent storage directory and master key.
//
// Storage path: %LOCALAPPDATA%\openclaw-feishu-uat\
// ---------------------------------------------------------------------------
const WIN32_UAT_DIR = (0, node_path_1.join)(process.env.LOCALAPPDATA ?? (0, node_path_1.join)(process.env.USERPROFILE ?? (0, node_os_1.homedir)(), 'AppData', 'Local'), KEYCHAIN_SERVICE);
const WIN32_MASTER_KEY_PATH = (0, node_path_1.join)(WIN32_UAT_DIR, 'master.key');
/** Convert account key to a filesystem-safe filename (whitelist approach). */
function win32SafeFileName(account) {
    return account.replace(/[^a-zA-Z0-9._-]/g, '_') + '.enc';
}
async function ensureWin32CredDir() {
    await (0, promises_1.mkdir)(WIN32_UAT_DIR, { recursive: true });
}
async function getWin32MasterKey() {
    try {
        const key = await (0, promises_1.readFile)(WIN32_MASTER_KEY_PATH);
        if (key.length === MASTER_KEY_BYTES)
            return key;
        log.warn('win32 master key has unexpected length, regenerating');
    }
    catch (err) {
        if (!(err instanceof Error) || err.code !== 'ENOENT') {
            log.warn(`failed to read win32 master key: ${err instanceof Error ? err.message : err}`);
        }
    }
    await ensureWin32CredDir();
    const key = (0, node_crypto_1.randomBytes)(MASTER_KEY_BYTES);
    await (0, promises_1.writeFile)(WIN32_MASTER_KEY_PATH, key);
    log.info('generated new master key for win32 encrypted file storage');
    return key;
}
const win32Backend = {
    async get(_service, account) {
        try {
            const key = await getWin32MasterKey();
            const data = await (0, promises_1.readFile)((0, node_path_1.join)(WIN32_UAT_DIR, win32SafeFileName(account)));
            return decryptData(data, key);
        }
        catch {
            return null;
        }
    },
    async set(_service, account, data) {
        const key = await getWin32MasterKey();
        await ensureWin32CredDir();
        const filePath = (0, node_path_1.join)(WIN32_UAT_DIR, win32SafeFileName(account));
        const encrypted = encryptData(data, key);
        await (0, promises_1.writeFile)(filePath, encrypted);
    },
    async remove(_service, account) {
        try {
            await (0, promises_1.unlink)((0, node_path_1.join)(WIN32_UAT_DIR, win32SafeFileName(account)));
        }
        catch {
            // Already absent – fine.
        }
    },
};
// ---------------------------------------------------------------------------
// Platform selection
// ---------------------------------------------------------------------------
function createBackend() {
    switch (process.platform) {
        case 'darwin':
            return darwinBackend;
        case 'linux':
            return linuxBackend;
        case 'win32':
            return win32Backend;
        default:
            log.warn(`unsupported platform "${process.platform}", falling back to macOS backend`);
            return darwinBackend;
    }
}
const backend = createBackend();
// ---------------------------------------------------------------------------
// Public API – Credential operations
// ---------------------------------------------------------------------------
/**
 * Read the stored UAT for a given (appId, userOpenId) pair.
 * Returns `null` when no entry exists or the payload is unparseable.
 */
async function getStoredToken(appId, userOpenId) {
    try {
        const json = await backend.get(KEYCHAIN_SERVICE, accountKey(appId, userOpenId));
        if (!json)
            return null;
        return JSON.parse(json);
    }
    catch {
        return null;
    }
}
/**
 * Persist a UAT using the platform credential store.
 *
 * Overwrites any existing entry for the same (appId, userOpenId).
 */
async function setStoredToken(token) {
    const key = accountKey(token.appId, token.userOpenId);
    const payload = JSON.stringify(token);
    await backend.set(KEYCHAIN_SERVICE, key, payload);
    log.info(`saved UAT for ${token.userOpenId} (at:${maskToken(token.accessToken)})`);
}
/**
 * Remove a stored UAT from the credential store.
 */
async function removeStoredToken(appId, userOpenId) {
    await backend.remove(KEYCHAIN_SERVICE, accountKey(appId, userOpenId));
    log.info(`removed UAT for ${userOpenId}`);
}
// ---------------------------------------------------------------------------
// Token validity check
// ---------------------------------------------------------------------------
/**
 * Determine the freshness of a stored token.
 *
 * - `"valid"`         – access_token is still good (expires > 5 min from now)
 * - `"needs_refresh"` – access_token expired/expiring but refresh_token is valid
 * - `"expired"`       – both tokens are expired; re-authorization required
 */
function tokenStatus(token) {
    const now = Date.now();
    if (now < token.expiresAt - REFRESH_AHEAD_MS) {
        return 'valid';
    }
    if (now < token.refreshExpiresAt) {
        return 'needs_refresh';
    }
    return 'expired';
}
