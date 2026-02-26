#!/usr/bin/env node

/**
 * Network connectivity detector for news-technology skill
 *
 * Silently detects if user can access global sources and automatically
 * falls back to China-only sources if needed. Detection is cached for
 * 5 minutes to avoid repeated checks.
 */

const fs = require('fs');
const path = require('path');
const { fetchUrl } = require('./web_utils');

const CACHE_FILE = path.join(__dirname, '..', '..', '.network_cache');
const CACHE_DURATION = 300 * 1000; // 5 minutes in milliseconds

async function checkGlobalAccess(timeout = 3000, useCache = true) {
  /**
   * Check if global (non-China) sources are accessible.
   *
   * Silently tests connectivity to international websites. Uses cached
   * result if available and fresh (within 5 minutes).
   *
   * Args:
   *   timeout: Timeout in milliseconds for each test (default: 3000)
   *   useCache: Whether to use cached result (default: true)
   *
   * Returns:
   *   Promise<boolean>: True if global sources are accessible, False otherwise
   */

  // Check cache first
  if (useCache) {
    const cachedResult = readCache();
    if (cachedResult !== null) {
      return cachedResult;
    }
  }

  // Test URLs (lightweight, reliable endpoints)
  const testUrls = [
    'https://www.cloudflare.com/cdn-cgi/trace',
    'https://techcrunch.com/feed/'
  ];

  for (const url of testUrls) {
    try {
      const content = await fetchUrl(url, { timeout });
      if (content) {
        // Success - global sources accessible
        writeCache(true);
        return true;
      }
    } catch (error) {
      // This URL failed, try next one
      continue;
    }
  }

  // All tests failed - global sources not accessible
  writeCache(false);
  return false;
}

function readCache() {
  /**
   * Read cached network detection result.
   *
   * Returns:
   *   boolean|null: True/False if cache is valid, null if cache is stale or missing
   */
  try {
    if (!fs.existsSync(CACHE_FILE)) {
      return null;
    }

    // Check if cache is still fresh
    const stats = fs.statSync(CACHE_FILE);
    const cacheAge = Date.now() - stats.mtimeMs;

    if (cacheAge > CACHE_DURATION) {
      // Cache expired
      try {
        fs.unlinkSync(CACHE_FILE);
      } catch (e) {
        // Ignore if can't delete
      }
      return null;
    }

    // Read cached result
    const content = fs.readFileSync(CACHE_FILE, 'utf-8').trim();
    return content === 'true';
  } catch (error) {
    // Any error reading cache, ignore it
    return null;
  }
}

function writeCache(result) {
  /**
   * Write network detection result to cache.
   *
   * Args:
   *   result: True if global accessible, False otherwise
   */
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(CACHE_FILE, result ? 'true' : 'false', 'utf-8');
  } catch (error) {
    // Silently fail if can't write cache
  }
}

function filterSourcesByNetwork(allSources, forceRegion = null) {
  /**
   * Filter sources based on network accessibility.
   *
   * Automatically detects network environment and returns appropriate sources.
   * This function is completely silent - no output to user.
   *
   * Args:
   *   allSources: List of all news sources
   *   forceRegion: Force specific region ('cn' or 'global'), null for auto
   *
   * Returns:
   *   Promise<Array>: Filtered list of sources appropriate for current network
   */

  return new Promise(async (resolve) => {
    // Force region if specified (for testing)
    if (forceRegion === 'cn') {
      const filtered = allSources.filter(
        s => s.region === 'cn' && s.enabled !== false
      );
      return resolve(filtered);
    } else if (forceRegion === 'global') {
      const filtered = allSources.filter(s => s.enabled !== false);
      return resolve(filtered);
    }

    // Auto-detect network
    try {
      const canAccessGlobal = await checkGlobalAccess();

      if (canAccessGlobal) {
        // Network is good - use all sources
        const filtered = allSources.filter(s => s.enabled !== false);
        resolve(filtered);
      } else {
        // Network is restricted - use only China sources
        const filtered = allSources.filter(
          s => s.region === 'cn' && s.enabled !== false
        );
        resolve(filtered);
      }
    } catch (error) {
      // On any error, default to all sources (fail open)
      const filtered = allSources.filter(s => s.enabled !== false);
      resolve(filtered);
    }
  });
}

module.exports = {
  checkGlobalAccess,
  filterSourcesByNetwork
};
