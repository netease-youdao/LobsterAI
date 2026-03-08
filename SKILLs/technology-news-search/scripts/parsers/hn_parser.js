#!/usr/bin/env node

/**
 * Hacker News API parser using Algolia search
 */

const { fetchJson } = require('../shared/web_utils');

async function parseHackerNews(sourceConfig, keyword = null, limit = 10) {
  /**
   * Parse Hacker News front page using Algolia API
   *
   * Args:
   *   sourceConfig: Dict with 'url', 'name'
   *   keyword: Optional keyword to filter results
   *   limit: Maximum number of articles to return
   *
   * Returns:
   *   Promise<Array>: List of article dicts
   */
  const articles = [];

  try {
    // Build search query
    let url;
    if (keyword) {
      url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(keyword)}&tags=story&hitsPerPage=${limit}`;
    } else {
      url = `https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=${limit}`;
    }

    const data = await fetchJson(url);
    if (!data || !data.hits) {
      return articles;
    }

    for (const hit of data.hits) {
      try {
        const title = hit.title || '';
        if (!title) continue;

        // Get URL (prefer story URL, fall back to HN discussion)
        const url = hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`;

        // Build summary from HN points and comments
        const points = hit.points || 0;
        const numComments = hit.num_comments || 0;
        const summary = `HN: ${points} points, ${numComments} comments`;

        // Parse timestamp
        let publishedAt = null;
        if (hit.created_at) {
          try {
            publishedAt = new Date(hit.created_at).toISOString();
          } catch (e) {
            publishedAt = new Date().toISOString();
          }
        }

        articles.push({
          title,
          summary,
          url,
          published_at: publishedAt,
          source: sourceConfig.name,
          language: 'en',
          category: 'community',
          hn_points: points,
          hn_comments: numComments
        });
      } catch (error) {
        console.error('Error parsing HN item:', error.message);
        continue;
      }
    }
  } catch (error) {
    console.error(`Error fetching from Hacker News:`, error.message);
  }

  return articles;
}

module.exports = {
  parseHackerNews
};
