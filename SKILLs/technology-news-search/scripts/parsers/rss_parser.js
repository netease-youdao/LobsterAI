#!/usr/bin/env node

/**
 * Generic RSS/Atom feed parser using rss-parser
 *
 * Uses the mature rss-parser library for reliable RSS/Atom parsing
 * instead of fragile regex patterns.
 */

// 从应用主目录的 node_modules 加载 rss-parser
// 应用会设置 NODE_PATH，所以 require('rss-parser') 会自动找到
const Parser = require('rss-parser');

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

        // Keyword filtering
        if (keyword) {
          const keywordLower = keyword.toLowerCase();
          if (!title.toLowerCase().includes(keywordLower) &&
              !summary.toLowerCase().includes(keywordLower)) {
            continue;
          }
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
  parseRssFeed
};
