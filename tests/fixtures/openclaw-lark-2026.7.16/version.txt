"use strict";
/**
 * Copyright (c) 2026 ByteDance Ltd. and/or its affiliates
 * SPDX-License-Identifier: MIT
 *
 * 插件版本号管理
 *
 * 从 package.json 读取版本号并生成 User-Agent 字符串。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPluginVersion = getPluginVersion;
exports.getPlatform = getPlatform;
exports.getUserAgent = getUserAgent;
const node_url_1 = require("node:url");
const node_path_1 = require("node:path");
const node_fs_1 = require("node:fs");
/** 缓存的版本号 */
let cachedVersion;
/**
 * 获取插件版本号（从 package.json 读取）
 *
 * @returns 版本号字符串，如 "2026.2.28.5"；读取失败返回 "unknown"
 */
function getPluginVersion() {
    if (cachedVersion)
        return cachedVersion;
    try {
        // 当前文件: src/core/version.ts → 向上两级到达项目根目录
        const __filename = (0, node_url_1.fileURLToPath)(import.meta.url);
        const __dirname = (0, node_path_1.dirname)(__filename);
        const packageJsonPath = (0, node_path_1.join)(__dirname, '..', '..', 'package.json');
        const raw = (0, node_fs_1.readFileSync)(packageJsonPath, 'utf8');
        const pkg = JSON.parse(raw);
        cachedVersion = pkg.version ?? 'unknown';
        return cachedVersion;
    }
    catch {
        cachedVersion = 'unknown';
        return cachedVersion;
    }
}
/**
 * 获取当前运行平台名称
 *
 * @returns `mac` | `linux` | `windows`
 */
function getPlatform() {
    switch (process.platform) {
        case 'darwin':
            return 'mac';
        case 'win32':
            return 'windows';
        default:
            return 'linux';
    }
}
/**
 * 生成 User-Agent 字符串
 *
 * @returns User-Agent 字符串，格式：`openclaw-lark/{version}/{platform}`
 *
 * @example
 * ```typescript
 * getUserAgent() // => "openclaw-lark/2026.2.28.5/mac"
 * ```
 */
function getUserAgent() {
    return `openclaw-lark/${getPluginVersion()}/${getPlatform()}`;
}
