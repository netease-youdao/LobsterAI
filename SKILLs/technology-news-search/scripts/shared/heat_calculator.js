#!/usr/bin/env node

/**
 * Heat score calculator for news articles
 */

function normalizeTitle(title) {
  if (!title) return '';
  // Remove non-word characters and lowercase
  title = title.replace(/[^\w\s]/g, '').toLowerCase();
  // Remove extra whitespace
  title = title.replace(/\s+/g, ' ').trim();
  return title;
}

function calculateHeatScore(article, allArticles, keyword) {
  /**
   * Calculate heat score for an article
   *
   * Scoring factors:
   * - Base score: +20
   * - Time decay: 24h=+40, 48h=+28, 72h=+16, >72h=+8
   * - Keyword match: exact=+30, partial=+15, summary=+5
   * - HN engagement: points/10 (max +20)
   * - Reddit engagement: upvotes/10 (max +20)
   * - Official source bonus: +10
   * - Multi-source bonus: +20 per duplicate
   *
   * Total capped at 100
   */
  let score = 20; // Base score

  // Time decay
  if (article.published_at) {
    try {
      const pubTime = new Date(article.published_at);
      const now = new Date();
      const hoursAgo = (now - pubTime) / (1000 * 60 * 60);

      if (hoursAgo <= 24) {
        score += 40; // Very fresh
      } else if (hoursAgo <= 48) {
        score += 28; // Recent
      } else if (hoursAgo <= 72) {
        score += 16; // Somewhat recent
      } else {
        score += 8; // Older
      }
    } catch (e) {
      score += 10; // Default if can't parse
    }
  }

  // Keyword match quality
  if (keyword) {
    // Use pre-computed match type if available (from tokenized matching)
    if (article._matchType) {
      switch (article._matchType) {
        case 'exact_title':  score += 30; break; // Full keyword in title
        case 'token_title':  score += 20; break; // Token match in title
        case 'web_search':   score += 15; break; // Web search result (keyword-relevant)
        case 'exact_summary': score += 10; break; // Full keyword in summary
        case 'token_summary': score += 5;  break; // Token match in summary
      }
    } else {
      // Fallback: simple substring matching (e.g., for HN articles)
      const keywordLower = keyword.toLowerCase();
      const titleLower = (article.title || '').toLowerCase();
      const summaryLower = (article.summary || '').toLowerCase();

      if (keywordLower === titleLower) {
        score += 30;
      } else if (titleLower.includes(keywordLower)) {
        score += 15;
      } else if (summaryLower.includes(keywordLower)) {
        score += 5;
      }
    }
  }

  // HN engagement bonus
  if (article.hn_points) {
    score += Math.min(Math.floor(article.hn_points / 10), 20);
  }

  // Reddit engagement bonus
  if (article.reddit_upvotes) {
    score += Math.min(Math.floor(article.reddit_upvotes / 10), 20);
  }

  // Official source bonus
  if (article.category === 'official_blog') {
    score += 10;
  }

  // Multi-source bonus (check for duplicate titles)
  if (article.title) {
    const titleNormalized = normalizeTitle(article.title);
    const duplicateCount = allArticles.filter(a => {
      return a.title &&
             normalizeTitle(a.title) === titleNormalized &&
             a.source !== article.source;
    }).length;
    score += duplicateCount * 20; // +20 per duplicate source
  }

  // Normalize to 0-100
  return Math.min(score, 100);
}

function findDuplicateSources(article, allArticles) {
  /**
   * Find other sources that have the same story
   */
  if (!article.title) {
    return [];
  }

  const titleNormalized = normalizeTitle(article.title);
  const duplicates = [];

  for (const a of allArticles) {
    if (a.title &&
        normalizeTitle(a.title) === titleNormalized &&
        a.source !== article.source) {
      duplicates.push(a.source);
    }
  }

  return duplicates;
}

module.exports = {
  calculateHeatScore,
  findDuplicateSources,
  normalizeTitle
};
