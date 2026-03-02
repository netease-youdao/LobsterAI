#!/usr/bin/env node

/**
 * Technology news search engine
 *
 * Search across multiple tech news sources and rank by heat score
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { parseRssFeed } = require('./parsers/rss_parser');
const { parseHackerNews } = require('./parsers/hn_parser');
const { calculateHeatScore, findDuplicateSources } = require('./shared/heat_calculator');
const { classifyKeyword, getSourcesForDomains } = require('./shared/domain_classifier');
const { filterSourcesByNetwork } = require('./shared/network_detector');

const execFileAsync = promisify(execFile);

const SCRIPT_DIR = __dirname;
const CONCURRENCY = 10; // Max concurrent RSS fetches
const FALLBACK_THRESHOLD = 3; // Minimum results before triggering fallback

function loadSources() {
  /**
   * Load news sources from references/sources.json
   */
  const sourcesFile = path.join(SCRIPT_DIR, '..', 'references', 'sources.json');
  const data = JSON.parse(fs.readFileSync(sourcesFile, 'utf-8'));
  return data.sources;
}

async function asyncPool(concurrency, items, fn) {
  /**
   * Run async functions with concurrency control
   */
  const results = [];
  const executing = new Set();

  for (const item of items) {
    const p = Promise.resolve().then(() => fn(item));
    results.push(p);
    executing.add(p);

    const clean = () => executing.delete(p);
    p.then(clean, clean);

    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }

  return Promise.allSettled(results);
}

function filterByFreshness(articles, maxAgeDays) {
  /**
   * Filter out articles older than maxAgeDays
   */
  if (!maxAgeDays || maxAgeDays <= 0) return articles;

  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  return articles.filter(article => {
    if (!article.published_at) return true; // Keep articles without date
    try {
      const time = new Date(article.published_at).getTime();
      if (isNaN(time)) return true; // Keep articles with unparseable dates
      return time >= cutoff;
    } catch (e) {
      return true;
    }
  });
}

function balanceSources(articles, maxPerSource = 5) {
  /**
   * Balance articles across sources to ensure diversity
   *
   * Args:
   *   articles: List of all articles (already sorted by heat score)
   *   maxPerSource: Maximum articles from each source
   *
   * Returns:
   *   Balanced list of articles
   */
  const sourceCounts = {};
  const balanced = [];

  for (const article of articles) {
    const source = article.source;
    if (!source) continue;

    if ((sourceCounts[source] || 0) < maxPerSource) {
      balanced.push(article);
      sourceCounts[source] = (sourceCounts[source] || 0) + 1;
    }
  }

  return balanced;
}

// ── web-search skill integration ──────────────────────────────────

function getWebSearchScriptPath() {
  const skillsRoot = process.env.SKILLS_ROOT
    || process.env.LOBSTERAI_SKILLS_ROOT
    || path.resolve(SCRIPT_DIR, '..', '..');

  const p = path.join(skillsRoot, 'web-search', 'scripts', 'search.sh');
  return fs.existsSync(p) ? p : null;
}

async function closeWebSearchBrowser() {
  const serverUrl = process.env.WEB_SEARCH_SERVER || 'http://127.0.0.1:8923';
  try {
    await fetch(`${serverUrl}/api/browser/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Ignore — server may not be running
  }
}

async function callWebSearch(query, maxResults) {
  const scriptPath = getWebSearchScriptPath();
  if (!scriptPath) return null;

  const tmpFile = path.join(os.tmpdir(), `news-query-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  fs.writeFileSync(tmpFile, query, 'utf-8');

  const childEnv = { ...process.env, WEB_SEARCH_NO_CLEANUP: '1' };

  try {
    // Resolve bash path (Windows needs Git Bash)
    let bashPath = 'bash';
    if (process.platform === 'win32') {
      const candidates = [
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
        'bash',
      ];
      bashPath = null;
      for (const candidate of candidates) {
        try {
          await execFileAsync(candidate, ['--version'], { timeout: 5000 });
          bashPath = candidate;
          break;
        } catch {
          continue;
        }
      }
      if (!bashPath) {
        console.error('    web-search skipped: bash not found on Windows (needs Git Bash)');
        return null;
      }
    }

    const { stdout } = await execFileAsync(
      bashPath,
      [scriptPath, `@${tmpFile}`, String(maxResults)],
      { timeout: 30000, maxBuffer: 10 * 1024 * 1024, env: childEnv }
    );
    return stdout || '';
  } catch (err) {
    console.error(`    web-search error: ${err.message}`);
    return null;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

function parseWebSearchMarkdown(markdown) {
  /**
   * Parse web-search skill markdown output into article objects.
   * Format:
   *   ## Title
   *   **URL:** [url](url)
   *   Snippet text
   *   ---
   */
  const articles = [];
  if (!markdown) return articles;

  const sections = markdown.split(/^---$/m);

  for (const section of sections) {
    const titleMatch = section.match(/^##\s+(.+)$/m);
    const urlMatch = section.match(/\*\*URL:\*\*\s+\[?([^\]\s]+)/m);

    if (!titleMatch || !urlMatch) continue;

    const title = titleMatch[1].trim();
    const url = urlMatch[1].replace(/\].*$/, '').trim();

    // Extract snippet (text after URL line, before next section)
    const lines = section.split('\n');
    const urlLineIdx = lines.findIndex(l => l.includes('**URL:**'));
    const snippetLines = [];
    for (let i = urlLineIdx + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line && !line.startsWith('#') && !line.startsWith('**')) {
        snippetLines.push(line);
      }
    }
    const summary = snippetLines.join(' ').slice(0, 300);

    articles.push({
      title,
      summary,
      url,
      published_at: new Date().toISOString(),
      source: 'Web Search',
      language: 'auto',
      category: 'web_search',
      _matchType: 'web_search'
    });
  }

  return articles;
}

// ── end web-search integration ────────────────────────────────────

async function fetchFromSources(sources, keyword, limit) {
  /**
   * Fetch articles from sources in parallel with concurrency control.
   *
   * Args:
   *   sources: Array of source configs to fetch from
   *   keyword: Search keyword (null = no keyword filtering)
   *   limit: Max articles per source
   *
   * Returns:
   *   Array of articles
   */
  const fetchResults = await asyncPool(CONCURRENCY, sources, async (source) => {
    console.error(`  Fetching from ${source.name}...`);

    let articles = [];

    if (source.type === 'api' && source.id.includes('hackernews')) {
      articles = await parseHackerNews(source, keyword, limit);
    } else if (source.type === 'rss' || source.type === 'newsletter_rss') {
      articles = await parseRssFeed(source, keyword, limit);
    } else {
      console.error(`    Unsupported type: ${source.type}`);
      return [];
    }

    console.error(`    Found ${articles.length} articles`);
    return articles;
  });

  // Collect results from all settled promises
  const articlesList = [];
  for (let i = 0; i < fetchResults.length; i++) {
    const result = fetchResults[i];
    if (result.status === 'fulfilled' && Array.isArray(result.value)) {
      articlesList.push(...result.value);
    } else if (result.status === 'rejected') {
      console.error(`    Error from ${sources[i].name}: ${result.reason?.message || result.reason}`);
    }
  }

  return articlesList;
}

async function searchNews(keyword, limit = 15, maxPerSource = 5, balance = true, allSources = false, maxAgeDays = 7) {
  /**
   * Search for tech news across all sources
   *
   * Args:
   *   keyword: Search keyword
   *   limit: Max articles per source to fetch
   *   maxPerSource: Max articles per source to display (for balancing)
   *   balance: Whether to balance sources in output
   *   allSources: Whether to search all sources (disable smart routing)
   *   maxAgeDays: Max age of articles in days (default: 7, 0 = no limit)
   *
   * Returns:
   *   Promise<Object>: Dict with search results
   */
  const allSourcesList = loadSources();

  // Step 1: Filter by network accessibility (silent, automatic)
  const networkFilteredSources = await filterSourcesByNetwork(allSourcesList);

  // Step 2: Smart routing - filter sources by detected domains
  let sources;
  let usedSmartRouting = false;
  if (!allSources) {
    const domains = classifyKeyword(keyword);
    sources = getSourcesForDomains(networkFilteredSources, domains);
    usedSmartRouting = sources.length < networkFilteredSources.filter(s => s.enabled !== false).length;

    const domainList = Array.from(domains).sort().join(', ');
    console.error(`🎯 Detected domains: ${domainList}`);
    console.error(`🔍 Searching for '${keyword}' in ${sources.length} sources...\n`);
  } else {
    sources = networkFilteredSources;
    console.error(`🔍 Searching for '${keyword}' across ${sources.length} sources...\n`);
  }

  // Filter enabled sources
  const enabledSources = sources.filter(s => s.enabled !== false);

  // Fetch from initial sources
  const startTime = Date.now();
  let articlesList = await fetchFromSources(enabledSources, keyword, limit);
  const fetchedSourceIds = new Set(enabledSources.map(s => s.id));

  const fetchTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.error(`\n⏱️  Fetched ${enabledSources.length} sources in ${fetchTime}s (concurrency: ${CONCURRENCY})`);

  // Fallback Layer 1: Expand to all sources if too few results
  let fallbackUsed = 'none';
  if (articlesList.length < FALLBACK_THRESHOLD && usedSmartRouting) {
    const additionalSources = networkFilteredSources.filter(
      s => s.enabled !== false && !fetchedSourceIds.has(s.id)
    );

    if (additionalSources.length > 0) {
      console.error(`\n🔄 Too few results (${articlesList.length}), expanding to ${additionalSources.length} more sources...\n`);
      const startTime2 = Date.now();
      const moreArticles = await fetchFromSources(additionalSources, keyword, limit);
      articlesList.push(...moreArticles);
      additionalSources.forEach(s => fetchedSourceIds.add(s.id));
      fallbackUsed = 'expanded_sources';
      const fetchTime2 = ((Date.now() - startTime2) / 1000).toFixed(1);
      console.error(`\n⏱️  Expanded fetch: ${additionalSources.length} sources in ${fetchTime2}s`);
    }
  }

  // Fallback Layer 2: Web search via web-search skill
  if (articlesList.length < FALLBACK_THRESHOLD) {
    const webSearchScript = getWebSearchScriptPath();
    if (webSearchScript) {
      const year = new Date().getFullYear();
      const query = `${keyword} 最新新闻 ${year}`;
      console.error(`\n🌐 Too few results (${articlesList.length}), trying web search: "${query}"...\n`);
      const startTimeWs = Date.now();
      const markdown = await callWebSearch(query, 10);
      const webArticles = parseWebSearchMarkdown(markdown);
      if (webArticles.length > 0) {
        articlesList.push(...webArticles);
        fallbackUsed = 'web_search';
        console.error(`    Web search found ${webArticles.length} results`);
      }
      await closeWebSearchBrowser();
      const fetchTimeWs = ((Date.now() - startTimeWs) / 1000).toFixed(1);
      console.error(`⏱️  Web search completed in ${fetchTimeWs}s`);
    }
  }

  // Fallback Layer 3: Return latest articles without keyword filtering
  if (articlesList.length < FALLBACK_THRESHOLD) {
    // Pick reliable general sources that we haven't fetched without keyword
    const generalSources = networkFilteredSources.filter(
      s => s.enabled !== false &&
           (s.domains || []).includes('general') &&
           s.category !== 'official_blog'
    ).slice(0, 6);

    if (generalSources.length > 0) {
      console.error(`\n🔄 Still too few results (${articlesList.length}), fetching latest articles from ${generalSources.length} general sources...\n`);
      const startTime3 = Date.now();
      const latestArticles = await fetchFromSources(generalSources, null, 5); // No keyword!
      // Tag as recommended (not keyword-matched)
      latestArticles.forEach(a => { a._matchType = 'recommended'; });
      articlesList.push(...latestArticles);
      fallbackUsed = 'latest_articles';
      const fetchTime3 = ((Date.now() - startTime3) / 1000).toFixed(1);
      console.error(`\n⏱️  Latest articles fetch: ${generalSources.length} sources in ${fetchTime3}s`);
    }
  }

  // Filter by freshness
  const freshArticles = filterByFreshness(articlesList, maxAgeDays);
  if (freshArticles.length < articlesList.length) {
    console.error(`🕐 Freshness filter: kept ${freshArticles.length}/${articlesList.length} articles (max ${maxAgeDays} days)`);
  }

  // Calculate heat scores
  console.error(`\n📊 Calculating heat scores...\n`);
  for (const article of freshArticles) {
    article.heat_score = calculateHeatScore(article, freshArticles, keyword);
    article.duplicate_sources = findDuplicateSources(article, freshArticles);
  }

  // Sort by heat score
  freshArticles.sort((a, b) => b.heat_score - a.heat_score);

  // Balance sources if enabled
  let finalArticles = freshArticles;
  if (balance) {
    console.error(`⚖️  Balancing sources (max ${maxPerSource} per source)...\n`);
    finalArticles = balanceSources(freshArticles, maxPerSource);
  }

  // Prepare output (strip internal fields, add match info for fallback articles)
  const cleanResults = finalArticles.map(article => {
    const { _matchType, ...clean } = article;
    if (_matchType === 'recommended') {
      clean.match = 'recommended';
    } else if (_matchType === 'web_search') {
      clean.match = 'web_search';
    }
    return clean;
  });

  const result = {
    keyword,
    total_found: cleanResults.length,
    search_time: new Date().toISOString(),
    fallback_used: fallbackUsed,
    results: cleanResults
  };

  return result;
}

async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);
  const options = {
    keyword: null,
    limit: 15,
    'max-per-source': 5,
    'max-age': 7,
    'no-balance': false,
    'all-sources': false
  };

  // Simple argument parsing
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg.startsWith('--')) {
      const key = arg.substring(2);
      if (key === 'no-balance' || key === 'all-sources') {
        options[key] = true;
      } else if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        const value = args[++i];
        if (key === 'limit' || key === 'max-per-source' || key === 'max-age') {
          options[key] = parseInt(value, 10);
        } else {
          options[key] = value;
        }
      }
    } else if (!options.keyword) {
      // First non-option argument is the keyword
      options.keyword = arg;
    }
  }

  // Validate required arguments
  if (!options.keyword) {
    console.error('Error: Missing required argument <keyword>');
    console.error('Usage: search_news.js <keyword> [options]');
    console.error('\nOptions:');
    console.error('  --limit NUM              Max articles per source (default: 15)');
    console.error('  --max-per-source NUM     Max articles to display per source (default: 5)');
    console.error('  --max-age DAYS           Max article age in days (default: 7, 0 = no limit)');
    console.error('  --no-balance             Disable source balancing');
    console.error('  --all-sources            Search all sources (disable smart routing)');
    process.exit(1);
  }

  try {
    // Perform search
    const result = await searchNews(
      options.keyword,
      options.limit,
      options['max-per-source'],
      !options['no-balance'],
      options['all-sources'],
      options['max-age']
    );

    // Output JSON to stdout (for Claude to read)
    console.log(JSON.stringify(result, null, 2));

    console.error(`\n✅ Search complete! Found ${result.total_found} articles.`);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

// Run main
main().catch(error => {
  console.error(`Fatal error: ${error.message}`);
  process.exit(1);
});

module.exports = {
  searchNews,
  loadSources,
  balanceSources
};
