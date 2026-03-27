#!/usr/bin/env node
/**
 * LobsterAI WeChat Article Search
 * Searches Sogou WeChat index for public account articles.
 *
 * Dependencies: npm install -g cheerio
 *
 * Usage:
 *   node wechat_search.js "keyword"
 *   node wechat_search.js "keyword" -n 15
 *   node wechat_search.js "keyword" -n 10 -o result.json
 *   node wechat_search.js "keyword" -r          # resolve real mp.weixin URLs
 */

"use strict";

const https = require("https");
const zlib = require("zlib");
const cheerio = require("cheerio");

// -------------------------------------------------------------------------
// User-Agent rotation
// -------------------------------------------------------------------------

const UA_LIST = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edg/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
];

function randomUA() {
  return UA_LIST[Math.floor(Math.random() * UA_LIST.length)];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -------------------------------------------------------------------------
// HTTP helpers
// -------------------------------------------------------------------------

function decompress(buf, encoding) {
  if (!encoding) return buf;
  const enc = String(encoding).toLowerCase();
  try {
    if (enc.includes("gzip")) return zlib.gunzipSync(buf);
    if (enc.includes("deflate")) return zlib.inflateSync(buf);
    if (enc.includes("br")) return zlib.brotliDecompressSync(buf);
  } catch (_) {
    /* fall through */
  }
  return buf;
}

function httpsGet(url, extraHeaders = {}, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: "GET",
      headers: {
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Encoding": "identity",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        Host: u.hostname,
        Referer: `https://${u.hostname}/`,
        "User-Agent": randomUA(),
        ...extraHeaders,
      },
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks);
        const body = decompress(raw, res.headers["content-encoding"]);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body,
          text: body.toString("utf-8"),
        });
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.end();
  });
}

// -------------------------------------------------------------------------
// Cookie helper (obtain SNUID from sogou video page)
// -------------------------------------------------------------------------

async function fetchSogouCookie() {
  try {
    const resp = await httpsGet(
      "https://v.sogou.com/v?ie=utf8&query=&p=40030600",
      {},
      10000
    );
    const raw = resp.headers["set-cookie"];
    if (!raw) return { str: "", obj: {} };
    const obj = {};
    raw.forEach((c) => {
      const kv = c.split(";")[0];
      const [k, v] = kv.split("=");
      if (k && v) obj[k.trim()] = v.trim();
    });
    return { str: raw.map((c) => c.split(";")[0]).join("; "), obj };
  } catch (_) {
    return { str: "", obj: {} };
  }
}

// -------------------------------------------------------------------------
// Resolve real mp.weixin URL from sogou redirect page
// -------------------------------------------------------------------------

function extractRedirectUrl(html) {
  // meta refresh
  let m = html.match(
    /<meta[^>]*http-equiv=["']refresh["'][^>]*content=["']\d+;\s*url=([^"']+)["']/i
  );
  if (m) return m[1];
  // JS location
  m =
    html.match(/location\.href\s*=\s*["']([^"']+)["']/i) ||
    html.match(/window\.location\s*=\s*["']([^"']+)["']/i);
  if (m) return m[1];
  // url += '...' concatenation pattern
  const parts = [];
  for (const p of html.matchAll(/url\s*\+=\s*'([^']*)'/g)) parts.push(p[1]);
  for (const p of html.matchAll(/url\s*\+=\s*"([^"]*)"/g)) parts.push(p[1]);
  if (parts.length) {
    const joined = parts.join("");
    if (joined.includes("mp.weixin.qq.com")) return joined;
  }
  return null;
}

async function resolveRealUrl(sogouUrl, cookieObj) {
  if (!sogouUrl.includes("weixin.sogou.com")) return sogouUrl;
  const snuid = cookieObj.SNUID || "";
  const base =
    "ABTEST=7|1716888919|v1; IPLOC=CN5101; ariaDefaultTheme=default";
  const cookie = snuid ? `${base}; SNUID=${snuid}` : base;

  for (let i = 0; i < 2; i++) {
    try {
      const resp = await httpsGet(sogouUrl, { Cookie: cookie }, 5000);
      if (resp.status >= 300 && resp.status < 400 && resp.headers.location) {
        const loc = resp.headers.location;
        if (loc.includes("mp.weixin.qq.com")) return loc;
      }
      if (resp.status === 200) {
        const redir = extractRedirectUrl(resp.text);
        if (redir && redir.includes("mp.weixin.qq.com")) return redir;
      }
      return sogouUrl;
    } catch (_) {
      await sleep(800);
    }
  }
  return sogouUrl;
}

// -------------------------------------------------------------------------
// Parse search results
// -------------------------------------------------------------------------

function toChinaTime(date) {
  const ct = new Date(date.getTime() + 8 * 3600000);
  const y = ct.getUTCFullYear();
  const mo = String(ct.getUTCMonth() + 1).padStart(2, "0");
  const d = String(ct.getUTCDate()).padStart(2, "0");
  const h = String(ct.getUTCHours()).padStart(2, "0");
  const mi = String(ct.getUTCMinutes()).padStart(2, "0");
  const s = String(ct.getUTCSeconds()).padStart(2, "0");
  return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
}

function relativeTimeLabel(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (days > 0) return `${days}天前`;
  if (hours > 0) return `${hours}小时前`;
  if (mins > 0) return `${mins}分钟前`;
  return "刚刚";
}

function parseArticle($, el) {
  const $el = $(el);
  const $link = $el.find("h3 a");
  if (!$link.length) return null;

  const title = $link.text().trim();
  let url = $link.attr("href") || "";
  if (url.startsWith("/")) url = `https://weixin.sogou.com${url}`;

  const summary = $el.find("p.txt-info").text().trim();

  let datetime = "";
  let timeDesc = "";
  let source = "";

  const $sp = $el.find(".s-p");
  if ($sp.length) {
    // timestamp from script tag
    const script = $sp.find(".s2 script").text();
    const tsMatch = script.match(/(\d{10})/);
    if (tsMatch) {
      const ts = parseInt(tsMatch[1]) * 1000;
      datetime = toChinaTime(new Date(ts));
      timeDesc = relativeTimeLabel(ts);
    }
    // source
    const $src =
      $sp.find(".all-time-y2").length > 0
        ? $sp.find(".all-time-y2")
        : $sp.find("a.account");
    source = $src.text().trim();
  }

  return { title, url, summary, datetime, time_desc: timeDesc || datetime, source };
}

function parseSearchPage(html, max) {
  const $ = cheerio.load(html);
  const $list = $("ul.news-list");
  if (!$list.length) return [];
  const out = [];
  $list.find("li").each((_, el) => {
    if (out.length >= max) return false;
    const a = parseArticle($, el);
    if (a) out.push(a);
  });
  return out;
}

// -------------------------------------------------------------------------
// Main search
// -------------------------------------------------------------------------

async function searchArticles(query, maxResults, shouldResolve) {
  maxResults = Math.min(maxResults, 50);
  const articles = [];
  const pagesNeeded = Math.ceil(maxResults / 10);

  for (let page = 1; page <= pagesNeeded && articles.length < maxResults; page++) {
    try {
      const { str: cookie } = await fetchSogouCookie();
      const encoded = encodeURIComponent(query);
      const url = `https://weixin.sogou.com/weixin?query=${encoded}&s_from=input&_sug_=n&type=2&page=${page}&ie=utf8`;
      const resp = await httpsGet(url, cookie ? { Cookie: cookie } : {}, 30000);
      const remaining = maxResults - articles.length;
      const parsed = parseSearchPage(resp.text, remaining);
      if (!parsed.length) break;
      articles.push(...parsed);
      if (page < pagesNeeded) await sleep(500 + Math.random() * 800);
    } catch (err) {
      console.error(`[第${page}页失败] ${err.message}`);
      break;
    }
  }

  const result = articles.slice(0, maxResults);

  if (shouldResolve && result.length) {
    console.error(`解析真实URL (${result.length}篇) ...`);
    const { obj: cookieObj } = await fetchSogouCookie();
    let ok = 0;
    for (let i = 0; i < result.length; i++) {
      const a = result[i];
      const real = await resolveRealUrl(a.url, cookieObj);
      const resolved = !real.includes("weixin.sogou.com");
      if (resolved) {
        a.url = real;
        ok++;
      }
      a.url_resolved = resolved;
      if (i < result.length - 1) await sleep(500 + Math.random() * 800);
    }
    console.error(`解析完成: 成功 ${ok}, 失败 ${result.length - ok}`);
  }

  return result;
}

// -------------------------------------------------------------------------
// CLI
// -------------------------------------------------------------------------

function parseArgs(argv) {
  let query = "";
  let num = 10;
  let output = "";
  let resolve = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "-n" || argv[i] === "--num") {
      num = parseInt(argv[++i]) || 10;
    } else if (argv[i] === "-o" || argv[i] === "--output") {
      output = argv[++i] || "";
    } else if (argv[i] === "-r" || argv[i] === "--resolve-url") {
      resolve = true;
    } else if (!argv[i].startsWith("-")) {
      query = argv[i];
    }
  }
  return { query, num, output, resolve };
}

async function main() {
  const { query, num, output, resolve } = parseArgs(process.argv.slice(2));

  if (!query) {
    console.log(`
LobsterAI 微信公众号文章搜索

用法:
  node wechat_search.js <关键词> [选项]

选项:
  -n, --num <数量>       返回结果数 (默认10, 最大50)
  -o, --output <文件>    输出JSON文件
  -r, --resolve-url      解析真实微信URL

示例:
  node wechat_search.js "人工智能" -n 20
  node wechat_search.js "ChatGPT" -o result.json
`);
    process.exit(0);
  }

  console.error(`搜索: "${query}" ...`);
  const articles = await searchArticles(query, num, resolve);
  const payload = { query, total: articles.length, articles };
  const jsonStr = JSON.stringify(payload, null, 2);

  if (output) {
    require("fs").writeFileSync(output, jsonStr, "utf-8");
    console.error(`已保存: ${output}`);
  }

  console.log(jsonStr);
}

module.exports = { searchArticles };

if (require.main === module) {
  main().catch((e) => {
    console.error("搜索失败:", e.message);
    process.exit(1);
  });
}
