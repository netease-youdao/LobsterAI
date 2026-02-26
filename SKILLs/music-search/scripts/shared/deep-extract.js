#!/usr/bin/env node
'use strict';

/**
 * Deep Extract - JavaScript 版深度页面抓取 & 网盘链接提取（音乐资源版）
 * 替代原来的 deep_extract.py
 *
 * 主要功能：
 *   - searchBaidu(queries, maxResults): 用 fetch 搜索百度，返回搜索结果页面列表
 *   - fetchAndExtract(page): 从单个页面深度抓取并提取网盘链接
 */

const { setTimeout: setTimeoutAsync } = require('timers/promises');

// ============ 链接匹配模式 ============

const PAN_PATTERNS = {
  quark: /https?:\/\/pan\.quark\.cn\/s\/[a-zA-Z0-9]+/g,
  baidu: /https?:\/\/pan\.baidu\.com\/s\/[a-zA-Z0-9_-]+/g,
  aliyun: /https?:\/\/(?:www\.)?alipan\.com\/s\/[a-zA-Z0-9]+/g,
  uc: /https?:\/\/drive\.uc\.cn\/s\/[a-zA-Z0-9]+/g,
};

const MAGNET_PATTERN = /magnet:\?xt=urn:btih:[a-zA-Z0-9]+/g;

const CODE_PATTERNS = [
  /(?:提取码|密码|提取密码)[：:\s]*([a-zA-Z0-9]{4,8})/,
  /(?:pwd|code)[=：:\s]*([a-zA-Z0-9]{4,8})/i,
];

const FORMAT_PATTERNS = [
  { pattern: /\bDSD\d*\b|DSD(?:64|128|256|512)/i, label: 'DSD' },
  { pattern: /Hi-?Res|高解析/i, label: 'Hi-Res' },
  { pattern: /\bFLAC\b/i, label: 'FLAC' },
  { pattern: /\bAPE\b/i, label: 'APE' },
  { pattern: /\bWAV\b/i, label: 'WAV' },
  { pattern: /\bAIFF?\b/i, label: 'AIFF' },
  { pattern: /\bMP3\b|320\s*[kK]/i, label: 'MP3' },
  { pattern: /\bAAC\b/i, label: 'AAC' },
  { pattern: /\bOGG\b/i, label: 'OGG' },
  { pattern: /无损/i, label: 'FLAC' },
];

// ============ 搜索引擎页面模式 ============

const SEARCH_ENGINE_PAGE_PATTERNS = [
  /baidu\.com\/s\?/,
  /bing\.com\/search\?/,
  /google\.com\/search\?/,
  /so\.com\/s\?/,
  /sogou\.com\/web\?/,
];

// ============ 辅助函数 ============

/**
 * 从 HTML 中提取页面标题
 */
function extractTitle(html) {
  let match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (match) {
    let title = match[1].trim();
    // 清理常见后缀
    title = title.replace(/\s*[-_|–—]\s*(首页|网站|资源|下载).*$/, '');
    return title.slice(0, 80);
  }

  match = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  if (match) {
    return match[1].trim().slice(0, 80);
  }

  return '';
}

/**
 * 检测音频格式标记
 */
function detectFormat(text) {
  for (const { pattern, label } of FORMAT_PATTERNS) {
    if (pattern.test(text)) {
      return label;
    }
  }
  return '';
}

/**
 * 查找提取码/密码
 */
function findExtractCode(text) {
  for (const pattern of CODE_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return match[1];
    }
  }
  return '';
}

/**
 * 判断 URL 是否是搜索引擎的搜索结果页面
 */
function isSearchPageUrl(url) {
  for (const pattern of SEARCH_ENGINE_PAGE_PATTERNS) {
    if (pattern.test(url)) {
      return true;
    }
  }
  return false;
}

/**
 * 获取页面内容，带超时控制
 */
async function fetchPageContent(url, timeout = 8000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Referer': 'https://www.baidu.com/',
        'Accept-Encoding': 'gzip, deflate',
      },
      signal: controller.signal,
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.text();
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Request timeout');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============ 核心抓取逻辑 ============

/**
 * 访问单个页面，提取所有网盘链接
 * @param {Object} page - { url, title }
 * @returns {Promise<Array>} 提取的链接列表
 */
async function fetchAndExtract(page) {
  const { url, title: pageTitle = '' } = page;

  if (!url) {
    return [];
  }

  let html;
  try {
    html = await fetchPageContent(url, 8000);
  } catch (error) {
    process.stderr.write(`[extract] ${url} -> 请求失败: ${error.message}\n`);
    return [];
  }

  // 如果页面内容太短，可能是反爬页面
  if (html.length < 500) {
    process.stderr.write(`[extract] ${url} -> 内容太短 (${html.length} 字节)\n`);
    return [];
  }

  const title = extractTitle(html) || pageTitle;
  const results = [];
  const seenUrls = new Set();

  // 1. 提取各类网盘直链
  for (const [panType, pattern] of Object.entries(PAN_PATTERNS)) {
    let match;
    // 创建新的 RegExp 实例以重置 lastIndex
    const regex = new RegExp(pattern.source, 'g');
    while ((match = regex.exec(html)) !== null) {
      const panUrl = match[0];
      if (seenUrls.has(panUrl)) {
        continue;
      }
      seenUrls.add(panUrl);

      // 提取链接上下文（前后字符）用于格式和提取码检测
      const start = Math.max(0, match.index - 500);
      const end = Math.min(html.length, match.index + match[0].length + 300);
      const ctx = html.slice(start, end);

      results.push({
        title: title || '未知标题',
        pan: panType,
        url: panUrl,
        format: detectFormat(ctx),
        extractCode: findExtractCode(ctx),
        source: 'deep-search',
        pageUrl: url,
      });
    }
  }

  // 2. 提取磁力链接
  let match;
  const magnetRegex = new RegExp(MAGNET_PATTERN.source, 'g');
  while ((match = magnetRegex.exec(html)) !== null) {
    const magnetUrl = match[0];
    if (!seenUrls.has(magnetUrl)) {
      seenUrls.add(magnetUrl);
      const start = Math.max(0, match.index - 300);
      const end = Math.min(html.length, match.index + magnetUrl.length + 200);
      const ctx = html.slice(start, end);

      results.push({
        title: title || '未知标题',
        pan: 'magnet',
        url: magnetUrl,
        format: detectFormat(ctx),
        source: 'deep-search',
        pageUrl: url,
      });
    }
  }

  process.stderr.write(`[extract] ${url} -> ${html.length} 字节, 找到 ${results.length} 条链接\n`);
  return results;
}

/**
 * 用 fetch 搜索百度，解析 HTML 提取搜索结果 URL 和标题
 * @param {Array<string>} queries - 搜索关键词列表
 * @param {number} maxResults - 每个查询的最大结果数
 * @returns {Promise<Array>} 搜索结果页面列表
 */
async function searchBaidu(queries, maxResults = 10) {
  const allPages = [];
  const seen = new Set();

  for (const query of queries) {
    try {
      const searchUrl = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&rn=${maxResults}`;
      const html = await fetchPageContent(searchUrl, 15000);

      // 百度结果: <h3 class="...t/c-title..."><a href="URL">title</a></h3>
      const pattern = /<h3[^>]*class="[^"]*(?:\bt\b|c-title)[^"]*"[^>]*>\s*<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      let match;
      while ((match = pattern.exec(html)) !== null) {
        const pageUrl = match[1];
        const titleHtml = match[2];
        // 移除 HTML 标签
        const title = titleHtml.replace(/<[^>]+>/g, '').trim();

        if (!seen.has(pageUrl) && !isSearchPageUrl(pageUrl)) {
          seen.add(pageUrl);
          allPages.push({ url: pageUrl, title });
        }
      }

      // 加小延迟避免请求过快
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (error) {
      process.stderr.write(`[search] 百度搜索失败 (${query}): ${error.message}\n`);
      continue;
    }
  }

  return allPages.slice(0, maxResults * 2);
}

/**
 * 并发抓取多个页面并提取链接
 * @param {Array<Object>} pages - 页面列表 [{ url, title }, ...]
 * @param {number} concurrency - 并发数
 * @returns {Promise<Array>} 所有提取的链接
 */
async function batchFetchAndExtract(pages, concurrency = 4) {
  const results = [];
  const queue = [...pages];
  let activeCount = 0;
  let queueIndex = 0;

  return new Promise((resolve) => {
    const processNext = async () => {
      if (queueIndex >= queue.length) {
        activeCount--;
        if (activeCount === 0) {
          resolve(results);
        }
        return;
      }

      const page = queue[queueIndex++];
      try {
        const extracted = await fetchAndExtract(page);
        results.push(...extracted);
      } catch (error) {
        process.stderr.write(`[batch] 页面处理失败: ${error.message}\n`);
      }

      processNext();
    };

    // 启动初始的并发任务
    activeCount = Math.min(concurrency, queue.length);
    for (let i = 0; i < activeCount; i++) {
      processNext();
    }
  });
}

// ============ 导出 ============

module.exports = {
  fetchAndExtract,
  searchBaidu,
  batchFetchAndExtract,
  detectFormat,
  findExtractCode,
  extractTitle,
};
