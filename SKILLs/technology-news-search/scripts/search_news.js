#!/usr/bin/env node

/**
 * Technology news search engine
 *
 * Search across multiple tech news sources and rank by heat score
 */

const fs = require('fs');
const path = require('path');
const { parseRssFeed } = require('./parsers/rss_parser');
const { parseHackerNews } = require('./parsers/hn_parser');
const { calculateHeatScore, findDuplicateSources } = require('./shared/heat_calculator');
const { classifyKeyword, getSourcesForDomains } = require('./shared/domain_classifier');
const { filterSourcesByNetwork } = require('./shared/network_detector');

const SCRIPT_DIR = __dirname;

function loadSources() {
  /**
   * Load news sources from references/sources.json
   */
  const sourcesFile = path.join(SCRIPT_DIR, '..', 'references', 'sources.json');
  const data = JSON.parse(fs.readFileSync(sourcesFile, 'utf-8'));
  return data.sources;
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

async function searchNews(keyword, limit = 15, maxPerSource = 5, balance = true, allSources = false) {
  /**
   * Search for tech news across all sources
   *
   * Args:
   *   keyword: Search keyword
   *   limit: Max articles per source to fetch
   *   maxPerSource: Max articles per source to display (for balancing)
   *   balance: Whether to balance sources in output
   *   allSources: Whether to search all sources (disable smart routing)
   *
   * Returns:
   *   Promise<Object>: Dict with search results
   */
  const allSourcesList = loadSources();

  // Step 1: Filter by network accessibility (silent, automatic)
  const networkFilteredSources = await filterSourcesByNetwork(allSourcesList);

  // Step 2: Smart routing - filter sources by detected domains
  let sources;
  if (!allSources) {
    const domains = classifyKeyword(keyword);
    sources = getSourcesForDomains(networkFilteredSources, domains);

    const domainList = Array.from(domains).sort().join(', ');
    console.error(`🎯 Detected domains: ${domainList}`);
    console.error(`🔍 Searching for '${keyword}' in ${sources.length} sources...\n`);
  } else {
    sources = networkFilteredSources;
    console.error(`🔍 Searching for '${keyword}' across ${sources.length} sources...\n`);
  }

  const articlesList = [];

  // Search each source
  for (const source of sources) {
    if (source.enabled === false) continue;

    console.error(`  Fetching from ${source.name}...`);

    try {
      let articles = [];

      if (source.type === 'api' && source.id.includes('hackernews')) {
        // Use HN API parser
        articles = await parseHackerNews(source, keyword, limit);
      } else if (source.type === 'rss' || source.type === 'newsletter_rss') {
        // Use RSS parser
        articles = await parseRssFeed(source, keyword, limit);
      } else {
        console.error(`    Unsupported type: ${source.type}`);
        continue;
      }

      articlesList.push(...articles);
      console.error(`    Found ${articles.length} articles`);
    } catch (error) {
      console.error(`    Error: ${error.message}`);
      continue;
    }
  }

  // Calculate heat scores
  console.error(`\n📊 Calculating heat scores...\n`);
  for (const article of articlesList) {
    article.heat_score = calculateHeatScore(article, articlesList, keyword);
    article.duplicate_sources = findDuplicateSources(article, articlesList);
  }

  // Sort by heat score
  articlesList.sort((a, b) => b.heat_score - a.heat_score);

  // Balance sources if enabled
  if (balance) {
    console.error(`⚖️  Balancing sources (max ${maxPerSource} per source)...\n`);
    articlesList.splice(0, articlesList.length, ...balanceSources(articlesList, maxPerSource));
  }

  // Prepare output
  const result = {
    keyword,
    total_found: articlesList.length,
    search_time: new Date().toISOString(),
    results: articlesList
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
        if (key === 'limit' || key === 'max-per-source') {
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
      options['all-sources']
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
