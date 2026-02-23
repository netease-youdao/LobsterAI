#!/usr/bin/env node
'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const execFileAsync = promisify(execFile);

// =============================================
// [1] Configuration
// =============================================

const CACHE_DIR = path.join(os.tmpdir(), 'lobsterai-music-cache');

const DEFAULT_CONFIG = {
  preferredPan: ['quark', 'aliyun', 'baidu', 'uc'],
  defaultLimit: 5,
  timeout: 15000,
  cacheEnabled: true,
  cacheTTL: 30 * 60 * 1000, // 30 minutes
  // Deep search (cloudscraper-based page scraping)
  deepEnabled: true,
  deepMaxPages: 8,
  deepConcurrency: 4,
  deepPageTimeout: 8000,
};

function loadConfig() {
  const cfg = { ...DEFAULT_CONFIG };

  const envPan = process.env.MUSIC_SEARCH_PREFERRED_PAN;
  if (envPan) {
    cfg.preferredPan = envPan.split(',').map(s => s.trim()).filter(Boolean);
  }

  const envLimit = parseInt(process.env.MUSIC_SEARCH_DEFAULT_LIMIT, 10);
  if (Number.isFinite(envLimit) && envLimit > 0) {
    cfg.defaultLimit = envLimit;
  }

  const envTimeout = parseInt(process.env.MUSIC_SEARCH_TIMEOUT, 10);
  if (Number.isFinite(envTimeout) && envTimeout > 0) {
    cfg.timeout = envTimeout;
  }

  if (process.env.MUSIC_SEARCH_CACHE_ENABLED === 'false') {
    cfg.cacheEnabled = false;
  }

  const envTTL = parseInt(process.env.MUSIC_SEARCH_CACHE_TTL, 10);
  if (Number.isFinite(envTTL) && envTTL > 0) {
    cfg.cacheTTL = envTTL;
  }

  // Deep search config
  if (process.env.MUSIC_SEARCH_DEEP_ENABLED === 'false') {
    cfg.deepEnabled = false;
  }
  const envDeepMaxPages = parseInt(process.env.MUSIC_SEARCH_DEEP_MAX_PAGES, 10);
  if (Number.isFinite(envDeepMaxPages) && envDeepMaxPages > 0) {
    cfg.deepMaxPages = envDeepMaxPages;
  }
  const envDeepConcurrency = parseInt(process.env.MUSIC_SEARCH_DEEP_CONCURRENCY, 10);
  if (Number.isFinite(envDeepConcurrency) && envDeepConcurrency > 0) {
    cfg.deepConcurrency = envDeepConcurrency;
  }
  const envDeepTimeout = parseInt(process.env.MUSIC_SEARCH_DEEP_PAGE_TIMEOUT, 10);
  if (Number.isFinite(envDeepTimeout) && envDeepTimeout > 0) {
    cfg.deepPageTimeout = envDeepTimeout;
  }

  return cfg;
}

const config = loadConfig();

// =============================================
// [2] Utility Functions
// =============================================

/**
 * Detect audio format from text description.
 */
function detectFormat(text) {
  if (!text) return '';
  if (/\bDSD\d*\b|DSD(?:64|128|256|512)/i.test(text)) return 'DSD';
  if (/Hi-?Res|高解析/i.test(text)) return 'Hi-Res';
  if (/\bFLAC\b/i.test(text)) return 'FLAC';
  if (/\bAPE\b/i.test(text)) return 'APE';
  if (/\bWAV\b/i.test(text)) return 'WAV';
  if (/\bAIFF?\b/i.test(text)) return 'AIFF';
  if (/\bMP3\b|320\s*k/i.test(text)) return 'MP3';
  if (/\bAAC\b/i.test(text)) return 'AAC';
  if (/\bOGG\b/i.test(text)) return 'OGG';
  if (/无损/i.test(text)) return 'FLAC';
  return '';
}

/**
 * Detect cloud drive platform from URL or text.
 */
function detectPanType(text) {
  if (!text) return 'unknown';
  if (/pan\.quark\.cn/i.test(text)) return 'quark';
  if (/pan\.baidu\.com/i.test(text)) return 'baidu';
  if (/alipan\.com|aliyundrive\.com/i.test(text)) return 'aliyun';
  if (/drive\.uc\.cn/i.test(text)) return 'uc';
  if (/夸克网盘|夸克/i.test(text)) return 'quark';
  if (/百度网盘|百度云/i.test(text)) return 'baidu';
  if (/阿里云盘|阿里网盘/i.test(text)) return 'aliyun';
  if (/UC网盘|UC盘/i.test(text)) return 'uc';
  return 'unknown';
}

/**
 * Deduplicate results by URL (or title+pan for non-direct links).
 */
function deduplicateResults(results) {
  const seen = new Set();
  const unique = [];
  for (const r of results) {
    const isPanUrl = r.url && Object.values(PAN_URL_PATTERNS).some(
      p => new RegExp(p.source).test(r.url)
    );
    const key = isPanUrl ? r.url : `${r.title}|${r.pan}|${r.url}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(r);
    }
  }
  return unique;
}

/**
 * Output JSON result to stdout.
 */
function outputJSON(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

/**
 * Output error as JSON.
 */
function outputError(message) {
  outputJSON({ success: false, error: message });
}

// =============================================
// [3] Cache
// =============================================

function getCacheKey(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

function getCache(key) {
  if (!config.cacheEnabled) return null;
  try {
    const file = path.join(CACHE_DIR, key + '.json');
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > config.cacheTTL) {
      try { fs.unlinkSync(file); } catch { /* ignore */ }
      return null;
    }
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

function setCache(key, data) {
  if (!config.cacheEnabled) return;
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(CACHE_DIR, key + '.json'),
      JSON.stringify(data),
      'utf-8'
    );
  } catch {
    // Cache write failure is non-critical
  }
}

// =============================================
// [5] Primary Engine: web-search Integration
// =============================================

/**
 * Build search queries for each target platform (music-oriented).
 */
function buildSearchQueries(keyword, panTypes) {
  const panConfig = {
    quark: { zhName: '夸克网盘', domain: 'pan.quark.cn' },
    baidu: { zhName: '百度网盘', domain: 'pan.baidu.com' },
    aliyun: { zhName: '阿里云盘', domain: 'www.alipan.com' },
    uc: { zhName: 'UC网盘', domain: 'drive.uc.cn' },
  };

  const nameQueries = [];
  const siteQueries = [];
  for (const pan of panTypes) {
    const cfg = panConfig[pan];
    if (!cfg) continue;

    // Music-specific queries with lossless keywords
    nameQueries.push({
      query: `${keyword} 无损音乐 ${cfg.zhName}`,
      pan,
    });

    // site: domain targeting
    siteQueries.push({
      query: `${keyword} 音乐 site:${cfg.domain}`,
      pan,
    });
  }
  return [...nameQueries, ...siteQueries];
}

/**
 * Resolve the web-search script path.
 */
function getWebSearchScriptPath() {
  const skillsRoot = process.env.SKILLS_ROOT
    || process.env.LOBSTERAI_SKILLS_ROOT
    || path.resolve(__dirname, '..', '..');

  const candidates = [
    path.join(skillsRoot, 'web-search', 'scripts', 'search.sh'),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  return null;
}

/**
 * Call web-search skill script and return raw markdown output.
 */
async function callWebSearch(query, maxResults) {
  const scriptPath = getWebSearchScriptPath();
  if (!scriptPath) {
    throw new Error('web-search skill 未找到，请确保 web-search 已启用');
  }

  const tmpFile = path.join(os.tmpdir(), `music-query-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  fs.writeFileSync(tmpFile, query, 'utf-8');

  const isWindows = process.platform === 'win32';
  const queryArg = `@${tmpFile}`;

  try {
    let stdout;
    if (isWindows) {
      const bashCandidates = [
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
        'bash',
      ];

      let bashPath = null;
      for (const candidate of bashCandidates) {
        try {
          await execFileAsync(candidate, ['--version'], { timeout: 5000 });
          bashPath = candidate;
          break;
        } catch {
          continue;
        }
      }

      if (!bashPath) {
        throw new Error('Windows 上未找到 bash（需要 Git Bash 或 WSL）');
      }

      const result = await execFileAsync(
        bashPath,
        [scriptPath, queryArg, String(maxResults)],
        { timeout: config.timeout * 2, maxBuffer: 10 * 1024 * 1024, env: process.env }
      );
      stdout = result.stdout;
    } else {
      const result = await execFileAsync(
        'bash',
        [scriptPath, queryArg, String(maxResults)],
        { timeout: config.timeout * 2, maxBuffer: 10 * 1024 * 1024, env: process.env }
      );
      stdout = result.stdout;
    }

    return stdout || '';
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore cleanup errors */ }
  }
}

/**
 * Pan link URL patterns.
 */
const PAN_URL_PATTERNS = {
  quark: /https?:\/\/pan\.quark\.cn\/s\/[a-zA-Z0-9]+/g,
  baidu: /https?:\/\/pan\.baidu\.com\/s\/[a-zA-Z0-9_-]+/g,
  aliyun: /https?:\/\/(?:www\.)?alipan\.com\/s\/[a-zA-Z0-9]+/g,
  uc: /https?:\/\/drive\.uc\.cn\/s\/[a-zA-Z0-9]+/g,
};

/**
 * Parse web-search markdown output to extract pan links.
 */
function parseWebSearchResults(markdown) {
  if (!markdown || typeof markdown !== 'string') return [];

  const results = [];
  const blocks = markdown.split(/^---$/m).filter(b => b.trim());

  for (const block of blocks) {
    const titleMatch = block.match(/^##\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : '';

    const urlMatch = block.match(/\*\*URL:\*\*\s*\[?(https?:\/\/[^\s\]\)]+)/);
    const pageUrl = urlMatch ? urlMatch[1] : '';

    const fullText = block;

    for (const [pan, pattern] of Object.entries(PAN_URL_PATTERNS)) {
      const regex = new RegExp(pattern.source, 'g');
      let match;
      while ((match = regex.exec(fullText)) !== null) {
        results.push({
          title: title || '未知标题',
          pan,
          url: match[0],
          format: detectFormat(fullText),
          extractCode: '',
          source: 'web-search',
          pageUrl,
        });
      }
    }

    if (title && pageUrl) {
      const detectedPan = detectPanType(pageUrl + ' ' + title);
      if (detectedPan !== 'unknown') {
        const alreadyHas = results.some(r => r.pageUrl === pageUrl);
        if (!alreadyHas) {
          results.push({
            title,
            pan: detectedPan,
            url: pageUrl,
            format: detectFormat(title),
            extractCode: '',
            source: 'web-search',
            pageUrl,
          });
        }
      }
    }
  }

  return results;
}

/**
 * Search via the web-search skill (primary engine).
 */
async function searchViaWebSearch(keyword, panTypes, limit) {
  const queries = buildSearchQueries(keyword, panTypes);
  const allResults = [];

  for (const { query, pan } of queries) {
    const cacheKey = getCacheKey(`web:${query}:${limit}`);
    const cached = getCache(cacheKey);
    if (cached) {
      allResults.push(...cached);
      continue;
    }

    try {
      const markdown = await callWebSearch(query, limit);
      const results = parseWebSearchResults(markdown);
      setCache(cacheKey, results);
      allResults.push(...results);
    } catch (err) {
      process.stderr.write(`[web-search] ${pan} 查询失败: ${err.message}\n`);
      if (allResults.length === 0) break;
    }
    if (allResults.length >= limit * panTypes.length) break;
  }

  return allResults;
}

// =============================================
// [6.5] Deep Search Engine (cloudscraper)
// =============================================

/**
 * Build smart search queries for deep extraction (music-oriented).
 */
function buildSmartQueries(keyword, panTypes) {
  const panNames = { quark: '夸克网盘', baidu: '百度网盘', aliyun: '阿里云盘', uc: 'UC网盘' };
  const panDomains = { quark: 'pan.quark.cn', baidu: 'pan.baidu.com', aliyun: 'www.alipan.com', uc: 'drive.uc.cn' };
  const queries = [];

  // 1. Music-specific queries with pan name
  for (const pan of panTypes) {
    const name = panNames[pan];
    if (name) {
      queries.push({ query: `${keyword} 无损音乐 ${name}`, pan });
    }
  }

  // 2. Generic music resource queries
  queries.push({ query: `${keyword} 无损音乐 网盘资源 下载`, pan: 'all' });
  queries.push({ query: `${keyword} FLAC 专辑 网盘`, pan: 'all' });

  // 3. site: queries last
  for (const pan of panTypes) {
    const domain = panDomains[pan];
    if (domain) {
      queries.push({ query: `${keyword} 音乐 site:${domain}`, pan });
    }
  }

  return queries;
}

/**
 * Extract page URLs from web-search markdown output.
 */
function extractPageUrls(markdown) {
  if (!markdown || typeof markdown !== 'string') return [];

  const pages = [];
  const blocks = markdown.split(/^---$/m).filter(b => b.trim());
  for (const block of blocks) {
    const titleMatch = block.match(/^##\s+(.+)$/m);
    const urlMatch = block.match(/\*\*URL:\*\*\s*\[?(https?:\/\/[^\s\]\)]+)/);
    if (urlMatch) {
      pages.push({
        url: urlMatch[1],
        title: titleMatch ? titleMatch[1].trim() : '',
      });
    }
  }
  return pages;
}

/**
 * Domain blacklist: pages from these domains won't have downloadable pan links.
 */
const DOMAIN_BLACKLIST = [
  'bilibili.com', 'iqiyi.com', 'youku.com', 'v.qq.com',
  'mgtv.com', 'zhihu.com', 'weibo.com', 'baike.baidu.com', 'wikipedia.org',
  'imdb.com', 'bing.com', 'google.com', 'so.com', 'sogou.com',
  'baidu.com/s?',
  // Music streaming platforms (no downloadable pan links)
  'music.163.com', 'y.qq.com', 'kugou.com', 'kuwo.com',
  'music.apple.com', 'spotify.com', 'tidal.com',
];

/**
 * Score and select the most promising pages for deep link extraction.
 */
function scoreAndSelectPages(pages, maxPages) {
  const seen = new Set();
  const scored = [];

  for (const page of pages) {
    if (seen.has(page.url)) continue;
    seen.add(page.url);

    let score = 0;
    const text = (page.title + ' ' + page.url).toLowerCase();

    // Positive signals: resource/pan keywords
    if (/网盘|资源|链接|下载|分享|提取码|wangpan|yunpan/.test(text)) score += 30;
    if (/pan\.quark\.cn|pan\.baidu\.com|alipan\.com|drive\.uc\.cn/.test(text)) score += 50;
    // Music-specific positive signals
    if (/无损|flac|ape|wav|dsd|hi-?res|hires/.test(text)) score += 25;
    if (/音乐|专辑|歌曲|歌手|唱片|音频/.test(text)) score += 15;
    if (/320k|lossless|hifi/.test(text)) score += 10;

    // Negative signals
    let blacklisted = false;
    for (const domain of DOMAIN_BLACKLIST) {
      if (page.url.includes(domain)) {
        blacklisted = true;
        break;
      }
    }
    if (blacklisted) score -= 100;

    scored.push({ ...page, score });
  }

  return scored
    .filter(p => p.score > -50)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxPages);
}

/**
 * Python environment management for deep extraction.
 */
let _pythonPath = null;

async function ensurePythonEnv() {
  if (_pythonPath) return _pythonPath;

  const skillDir = path.resolve(__dirname, '..');
  const isWindows = process.platform === 'win32';
  const venvPython = isWindows
    ? path.join(skillDir, '.venv', 'Scripts', 'python.exe')
    : path.join(skillDir, '.venv', 'bin', 'python3');

  // 1. Check existing .venv
  if (fs.existsSync(venvPython)) {
    _pythonPath = venvPython;
    return _pythonPath;
  }

  // 2. Check MUSIC_SEARCH_PYTHON_PATH env
  const envPython = process.env.MUSIC_SEARCH_PYTHON_PATH;
  if (envPython) {
    try {
      await execFileAsync(envPython, ['-c', 'import cloudscraper'], { timeout: 5000 });
      _pythonPath = envPython;
      return _pythonPath;
    } catch { /* need install */ }
  }

  // 3. Check system python3
  const python3 = isWindows ? 'python' : 'python3';
  try {
    await execFileAsync(python3, ['-c', 'import cloudscraper'], { timeout: 5000 });
    _pythonPath = python3;
    return _pythonPath;
  } catch { /* need install */ }

  // 4. Auto-create venv and install cloudscraper
  try {
    process.stderr.write('[deep-search] 首次使用，正在安装 cloudscraper...\n');
    const reqFile = path.join(skillDir, 'requirements.txt');
    await execFileAsync(python3, ['-m', 'venv', path.join(skillDir, '.venv')], {
      timeout: 30000,
    });
    const pipPython = venvPython;
    await execFileAsync(pipPython, ['-m', 'pip', 'install', '-q', '-r', reqFile], {
      timeout: 60000,
    });
    _pythonPath = venvPython;
    process.stderr.write('[deep-search] cloudscraper 安装完成\n');
    return _pythonPath;
  } catch (err) {
    throw new Error(`Python 环境初始化失败: ${err.message}。请确保 python3 已安装。`);
  }
}

/**
 * Call deep_extract.py search command.
 */
async function callDeepSearch(queries, maxResults) {
  const pythonPath = await ensurePythonEnv();
  const scriptPath = path.join(__dirname, 'deep_extract.py');

  if (!fs.existsSync(scriptPath)) {
    throw new Error('deep_extract.py 脚本未找到');
  }

  const { stdout } = await execFileAsync(
    pythonPath,
    [scriptPath, 'search', JSON.stringify(queries), String(maxResults)],
    { timeout: 20000, maxBuffer: 5 * 1024 * 1024 }
  );

  if (!stdout || !stdout.trim()) return [];

  try {
    return JSON.parse(stdout);
  } catch {
    return [];
  }
}

/**
 * Call deep_extract.py extract command.
 */
async function callDeepExtract(pages) {
  const pythonPath = await ensurePythonEnv();
  const scriptPath = path.join(__dirname, 'deep_extract.py');

  if (!fs.existsSync(scriptPath)) {
    throw new Error('deep_extract.py 脚本未找到');
  }

  return new Promise((resolve) => {
    const allResults = [];
    const child = execFile(
      pythonPath,
      [scriptPath, 'extract', String(config.deepConcurrency)],
      {
        timeout: config.deepPageTimeout * config.deepMaxPages + 10000,
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    child.stdin.write(JSON.stringify(pages));
    child.stdin.end();

    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (line.trim()) {
          try {
            const parsed = JSON.parse(line);
            if (Array.isArray(parsed)) {
              allResults.push(...parsed);
            }
          } catch { /* skip malformed lines */ }
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
    });

    child.on('close', () => {
      if (buffer.trim()) {
        try {
          const parsed = JSON.parse(buffer);
          if (Array.isArray(parsed)) {
            allResults.push(...parsed);
          }
        } catch { /* ignore */ }
      }
      resolve(allResults);
    });

    child.on('error', (err) => {
      process.stderr.write(`[deep-search] 子进程错误: ${err.message}\n`);
      resolve(allResults);
    });
  });
}

/**
 * Deep search engine: web-search discovery + cloudscraper deep extraction.
 */
async function searchViaDeepExtract(keyword, panTypes, limit) {
  const cacheKey = getCacheKey(`deep:${keyword}:${panTypes.join(',')}:${limit}`);
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const queries = buildSmartQueries(keyword, panTypes);

  const snippetResults = [];
  const allPages = [];

  // Phase 1A: web-search discovery
  for (const { query } of queries) {
    try {
      const markdown = await callWebSearch(query, 5);
      if (markdown) {
        snippetResults.push(...parseWebSearchResults(markdown));
        allPages.push(...extractPageUrls(markdown));
      }
    } catch (err) {
      process.stderr.write(`[deep-search] web-search 查询失败 (${query}): ${err.message}\n`);
      if (allPages.length === 0) break;
    }
    const usefulPages = allPages.filter(p => {
      const url = (p.url || '').toLowerCase();
      return !DOMAIN_BLACKLIST.some(d => url.includes(d));
    });
    if (usefulPages.length >= config.deepMaxPages * 2) break;
  }

  // Phase 1B: Fallback to cloudscraper Baidu if web-search found nothing
  if (allPages.length === 0) {
    process.stderr.write('[deep-search] web-search 未发现页面，尝试 cloudscraper 百度搜索...\n');
    try {
      const queryStrings = queries.map(q => q.query);
      const cloudPages = await callDeepSearch(queryStrings, 10);
      if (cloudPages.length > 0) {
        allPages.push(...cloudPages);
        process.stderr.write(`[deep-search] cloudscraper 百度搜索发现 ${cloudPages.length} 个页面\n`);
      }
    } catch (err) {
      process.stderr.write(`[deep-search] cloudscraper 搜索也失败: ${err.message}\n`);
    }
  }

  process.stderr.write(`[deep-search] 共发现 ${allPages.length} 个候选页面\n`);

  // Phase 2: Score and select best pages
  const selectedPages = scoreAndSelectPages(allPages, config.deepMaxPages);
  process.stderr.write(`[deep-search] 筛选后 ${selectedPages.length} 个页面进入深度提取\n`);
  if (selectedPages.length > 0) {
    process.stderr.write(`[deep-search] 页面: ${selectedPages.map(p => p.url).join(', ')}\n`);
  }

  // Phase 3: Deep extraction via cloudscraper
  let deepResults = [];
  if (selectedPages.length > 0 && config.deepEnabled) {
    try {
      deepResults = await callDeepExtract(selectedPages);
      process.stderr.write(`[deep-search] 深度提取到 ${deepResults.length} 条链接\n`);
    } catch (err) {
      process.stderr.write(`[deep-search] 深度提取失败: ${err.message}\n`);
    }
  }

  // Phase 4: Merge snippet results + deep results, deduplicate
  const merged = [...deepResults, ...snippetResults];
  const results = deduplicateResults(merged);

  setCache(cacheKey, results);
  return results;
}

// =============================================
// [7] Search Orchestration
// =============================================

/**
 * Main search orchestrator.
 */
async function searchAll(keyword, options = {}) {
  const {
    pan = 'all',
    format = 'all',
    limit = config.defaultLimit,
    engine = 'deep',
  } = options;

  const panTypes = pan === 'all' ? [...config.preferredPan] : [pan];

  const allResults = [];

  const enginePromises = [];

  if (engine === 'deep') {
    if (config.deepEnabled) {
      enginePromises.push(searchViaDeepExtract(keyword, panTypes, limit));
    } else {
      enginePromises.push(searchViaWebSearch(keyword, panTypes, limit));
    }
  } else if (engine === 'web') {
    enginePromises.push(searchViaWebSearch(keyword, panTypes, limit));
  } else {
    if (config.deepEnabled) {
      enginePromises.push(searchViaDeepExtract(keyword, panTypes, limit));
    } else {
      enginePromises.push(searchViaWebSearch(keyword, panTypes, limit));
    }
  }

  const settled = await Promise.allSettled(enginePromises);
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      allResults.push(...result.value);
    }
  }

  // Post-processing
  let results = deduplicateResults(allResults);

  // Filter by pan type
  if (pan !== 'all') {
    results = results.filter(r => r.pan === pan);
  }

  // Filter by format
  if (format !== 'all') {
    const f = format.toUpperCase();
    // Handle Hi-Res alias
    const normalizedFilter = f === 'HIRES' ? 'HI-RES' : f;
    results = results.filter(r => {
      const rf = (r.format || '').toUpperCase();
      return rf === normalizedFilter || rf === f;
    });
  }

  // Sort by preferred pan type order
  results.sort((a, b) => {
    const aIdx = config.preferredPan.indexOf(a.pan);
    const bIdx = config.preferredPan.indexOf(b.pan);
    return (aIdx === -1 ? 99 : aIdx) - (bIdx === -1 ? 99 : bIdx);
  });

  return results;
}

// =============================================
// [8] Command Handlers
// =============================================

async function cmdSearch(args) {
  const keyword = args.positional[0];
  if (!keyword) {
    outputError('请提供搜索关键词。用法: search <关键词> [--pan quark] [--format flac] [--limit 5]');
    process.exit(1);
  }

  const results = await searchAll(keyword, {
    pan: args.flags.pan || 'all',
    format: args.flags.format || 'all',
    limit: parseInt(args.flags.limit, 10) || config.defaultLimit,
    engine: args.flags.engine || 'deep',
  });

  outputJSON({
    success: true,
    data: {
      query: keyword,
      filters: {
        pan: args.flags.pan || 'all',
        format: args.flags.format || 'all',
      },
      total: results.length,
      results,
    },
  });
}

async function cmdHot(args) {
  const keyword = args.positional[0] || '2025 热门音乐 无损专辑 网盘资源';

  const results = await searchAll(keyword, {
    pan: args.flags.pan || 'all',
    format: args.flags.format || 'all',
    limit: parseInt(args.flags.limit, 10) || config.defaultLimit,
    engine: args.flags.engine || 'deep',
  });

  outputJSON({
    success: true,
    data: {
      category: 'hot',
      query: keyword,
      total: results.length,
      results,
    },
  });
}

async function cmdResolve(args) {
  const url = args.positional[0];
  if (!url) {
    outputError('请提供需要解析的 URL。用法: resolve <url>');
    process.exit(1);
  }

  try {
    const resp = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(config.timeout),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const html = await resp.text();

    const links = [];
    for (const [pan, pattern] of Object.entries(PAN_URL_PATTERNS)) {
      const regex = new RegExp(pattern.source, 'g');
      let match;
      while ((match = regex.exec(html)) !== null) {
        links.push({ url: match[0], pan });
      }
    }

    const seen = new Set();
    const unique = links.filter(l => {
      if (seen.has(l.url)) return false;
      seen.add(l.url);
      return true;
    });

    outputJSON({
      success: true,
      data: {
        originalUrl: url,
        resolved: unique,
        message: unique.length === 0 ? '未在页面中找到网盘链接' : undefined,
      },
    });
  } catch (err) {
    outputError(`解析失败: ${err.message}`);
    process.exit(1);
  }
}

// =============================================
// [9] CLI Entry Point
// =============================================

function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args[0] || '';
  const positional = [];
  const flags = {};

  let i = 1;
  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = 'true';
        i += 1;
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      const shortMap = { n: 'limit', p: 'pan', f: 'format', e: 'engine' };
      const key = shortMap[arg[1]] || arg[1];
      const next = args[i + 1];
      if (next && !next.startsWith('-')) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = 'true';
        i += 1;
      }
    } else {
      positional.push(arg);
      i += 1;
    }
  }

  return { command, positional, flags };
}

function printUsage() {
  const usage = `Music Search - 音乐资源搜索工具

用法:
  music-search.js <command> [arguments] [options]

命令:
  search <keyword>    搜索音乐资源
  hot [keyword]       热门推荐搜索
  resolve <url>       解析跳转链接获取真实网盘地址

选项 (search/hot):
  --pan <type>        筛选网盘: quark, baidu, aliyun, uc, all (默认: all)
  --format <f>        筛选格式: flac, ape, wav, dsd, hires, mp3, aac, all (默认: all)
  --limit <n>         每平台结果数 (默认: ${config.defaultLimit})
  --engine <e>        引擎: deep, web (默认: deep)
                      deep = web-search 搜索 + cloudscraper 深度页面抓取（推荐，最准确）
                      web = 仅从搜索摘要中提取链接（不做深度抓取）

示例:
  music-search.js search "周杰伦 范特西"
  music-search.js search "周杰伦 范特西" --pan quark --format flac
  music-search.js search "邓紫棋 光年之外" --format hires
  music-search.js hot "2025年热门专辑"
  music-search.js resolve "https://example.com/redirect/xxx"
`;
  process.stderr.write(usage);
}

async function main() {
  const rawArgs = process.argv.slice(2);

  if (rawArgs.length === 0 || rawArgs.includes('--help') || rawArgs.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  const args = parseArgs(process.argv);

  try {
    switch (args.command) {
      case 'search':
      case 's':
        await cmdSearch(args);
        break;
      case 'hot':
        await cmdHot(args);
        break;
      case 'resolve':
      case 'r':
        await cmdResolve(args);
        break;
      default:
        printUsage();
        process.exit(1);
    }
  } catch (err) {
    outputError(err.message || String(err));
    process.exit(1);
  }
}

main();
