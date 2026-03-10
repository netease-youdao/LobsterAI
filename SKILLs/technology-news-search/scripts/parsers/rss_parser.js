#!/usr/bin/env node

/**
 * Generic RSS/Atom feed parser using rss-parser
 *
 * Uses the mature rss-parser library for reliable RSS/Atom parsing
 * instead of fragile regex patterns.
 */

// 使用预打包的 rss-parser（esbuild bundle），无需外部 node_modules
const Parser = require('../vendor/rss-parser.bundle');

const parser = new Parser({
  timeout: 10000,
  customFields: {
    item: ['content:encoded', 'description']
  }
});

function extractRedditUpvotes(contentStr) {
  /**
   * Extract upvote count from Reddit content
   */
  if (!contentStr) return 0;
  const match = contentStr.match(/(\d+)\s+(points?|upvotes?)/i);
  return match ? parseInt(match[1], 10) : 0;
}

// Regex to detect if string contains CJK characters
const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;

function tokenizeKeyword(keyword) {
  /**
   * Split keyword into searchable tokens.
   * - Chinese: bigram split (每2个字一组) + full keyword
   * - English: split by spaces
   * - Mixed: handle both parts
   *
   * Returns: { full: string, tokens: string[], isCJK: boolean }
   */
  const full = keyword.toLowerCase();

  if (CJK_REGEX.test(keyword)) {
    // Chinese or mixed: extract CJK bigrams + any English words
    const tokens = new Set();
    // Add the full keyword
    tokens.add(full);
    // CJK bigram segmentation
    const cjkChars = keyword.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]+/g);
    if (cjkChars) {
      for (const segment of cjkChars) {
        if (segment.length >= 2) {
          for (let i = 0; i <= segment.length - 2; i++) {
            tokens.add(segment.substring(i, i + 2));
          }
        }
        if (segment.length >= 1) {
          tokens.add(segment);
        }
      }
    }
    // Also add English words if mixed
    const englishWords = keyword.match(/[a-zA-Z]+/g);
    if (englishWords) {
      for (const w of englishWords) {
        if (w.length >= 2) tokens.add(w.toLowerCase());
      }
    }
    return { full, tokens: Array.from(tokens), isCJK: true };
  } else {
    // English: split by spaces, keep words with length >= 2
    const words = full.split(/\s+/).filter(w => w.length >= 2);
    return { full, tokens: words.length > 1 ? [full, ...words] : [full], isCJK: false };
  }
}

function matchKeyword(title, summary, keywordInfo) {
  /**
   * Match keyword against title and summary using tokenized matching.
   *
   * Returns: 'exact_title' | 'token_title' | 'exact_summary' | 'token_summary' | null
   */
  const titleLower = (title || '').toLowerCase();
  const summaryLower = (summary || '').toLowerCase();

  // Check full keyword match first
  if (titleLower.includes(keywordInfo.full)) return 'exact_title';
  if (summaryLower.includes(keywordInfo.full)) return 'exact_summary';

  // Check token matches
  for (const token of keywordInfo.tokens) {
    if (token === keywordInfo.full) continue; // Already checked
    if (titleLower.includes(token)) return 'token_title';
  }
  for (const token of keywordInfo.tokens) {
    if (token === keywordInfo.full) continue;
    if (summaryLower.includes(token)) return 'token_summary';
  }

  return null;
}

function cleanText(text) {
  if (!text) return '';

  // Remove HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode basic HTML entities
  const entities = {
    '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"',
    '&apos;': "'", '&#39;': "'", '&nbsp;': ' ',
    '&mdash;': '—', '&ndash;': '–'
  };

  for (const [entity, char] of Object.entries(entities)) {
    text = text.replace(new RegExp(entity, 'g'), char);
  }

  // Clean whitespace
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

async function parseRssFeed(sourceConfig, keyword = null, limit = 10) {
  /**
   * Parse RSS or Atom feed using rss-parser
   *
   * Args:
   *   sourceConfig: Object with 'url', 'name', 'language', 'category'
   *   keyword: Optional keyword to filter results
   *   limit: Maximum number of articles to return
   *
   * Returns:
   *   Promise<Array>: List of article objects
   */
  const articles = [];
  const keywordInfo = keyword ? tokenizeKeyword(keyword) : null;

  try {
    const feed = await parser.parseURL(sourceConfig.url);

    // Process items
    const items = feed.items || [];
    let count = 0;

    for (const item of items) {
      if (count >= limit) break;

      try {
        // Extract basic fields
        const title = item.title ? cleanText(item.title) : '';
        if (!title) continue;

        const url = item.link || '';
        if (!url) continue;

        // Extract content/summary
        let summary = item.contentSnippet ||
                     item.content ||
                     item.description ||
                     item['content:encoded'] || '';
        summary = cleanText(summary);
        // Limit summary length
        summary = summary.length > 300 ? summary.substring(0, 300) + '...' : summary;

        // Parse date
        const pubDate = item.pubDate || item.published || item.updated || new Date();
        const publishedAt = new Date(pubDate).toISOString();

        // Keyword filtering with tokenized matching
        let matchType = null;
        if (keywordInfo) {
          matchType = matchKeyword(title, summary, keywordInfo);
          if (!matchType) continue;
        }

        // Build article object
        const article = {
          title,
          summary,
          url,
          published_at: publishedAt,
          source: sourceConfig.name,
          language: sourceConfig.language || 'en',
          category: sourceConfig.category || 'general'
        };

        // Store match type for heat score calculation
        if (matchType) {
          article._matchType = matchType;
        }

        // Extract Reddit upvotes if applicable
        if (sourceConfig.url && sourceConfig.url.includes('reddit.com')) {
          const contentForUpvotes = item.content || item.contentSnippet || '';
          const upvotes = extractRedditUpvotes(contentForUpvotes);
          if (upvotes > 0) {
            article.reddit_upvotes = upvotes;
          }
        }

        articles.push(article);
        count++;
      } catch (error) {
        console.error(`Error parsing item from ${sourceConfig.name}:`, error.message);
        continue;
      }
    }
  } catch (error) {
    console.error(`Error fetching/parsing RSS from ${sourceConfig.url}:`, error.message);
  }

  return articles;
}

module.exports = {
  parseRssFeed,
  tokenizeKeyword,
  matchKeyword
};
