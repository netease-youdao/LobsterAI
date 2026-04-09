/**
 * Bing Search Engine - Uses Playwright to search and extract results
 */

import { Page } from 'playwright-core';
import { PlaywrightManager } from '../playwright/manager';
import { SearchResult, SearchResponse } from './types';

const ALLOWED_URL_SCHEMES = ['http:', 'https:'];

function validateNavigationUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (!ALLOWED_URL_SCHEMES.includes(parsed.protocol)) {
    throw new Error(`Blocked URL scheme "${parsed.protocol}" — only http/https allowed`);
  }
}

export interface BingSearchOptions {
  /** Maximum number of results to return */
  maxResults?: number;
  /** Navigation timeout in milliseconds */
  navigationTimeout?: number;
  /** Wait for results timeout in milliseconds */
  waitTimeout?: number;
}

export class BingSearch {
  constructor(private playwrightManager: PlaywrightManager) {}

  /**
   * Perform Bing search and extract results
   */
  async search(
    connectionId: string,
    query: string,
    options: BingSearchOptions = {}
  ): Promise<SearchResponse> {
    const startTime = Date.now();
    const maxResults = options.maxResults || 10;
    const navigationTimeout = options.navigationTimeout || 15000;
    const waitTimeout = options.waitTimeout || 10000;

    console.log(`[Bing] Searching for: "${query}" (max ${maxResults} results)`);

    const page = await this.playwrightManager.getPage(connectionId);

    try {
      // Navigate to Bing search
      const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
      console.log(`[Bing] Navigating to: ${searchUrl}`);

      await page.goto(searchUrl, {
        waitUntil: 'domcontentloaded',
        timeout: navigationTimeout
      });

      console.log(`[Bing] Page loaded: ${page.url()}`);

      // Wait for search results to appear
      try {
        await page.waitForSelector('li.b_algo, ol#b_results li', { timeout: waitTimeout });
        console.log(`[Bing] Search results found`);
      } catch (error) {
        console.warn(`[Bing] No search results found or timeout`);
        return {
          query,
          engine: 'bing',
          results: [],
          totalResults: 0,
          timestamp: Date.now(),
          duration: Date.now() - startTime
        };
      }

      // Extract search results using page.evaluate
      // Note: Code inside evaluate runs in browser context
      const results = await page.evaluate((max) => {
        const items = document.querySelectorAll('li.b_algo');
        const extractedResults: Array<{
          title: string;
          url: string;
          snippet: string;
          source: string;
          position: number;
        }> = [];

        for (let i = 0; i < Math.min(items.length, max); i++) {
          const item = items[i];
          const titleEl = item.querySelector('h2 a');
          const snippetEl = item.querySelector('.b_caption p, .b_caption');

          if (titleEl) {
            const title = titleEl.textContent?.trim() || '';
            const url = (titleEl as HTMLAnchorElement).href || '';
            const snippet = snippetEl?.textContent?.trim() || '';

            if (title && url) {
              extractedResults.push({
                title,
                url,
                snippet,
                source: 'bing',
                position: i + 1
              });
            }
          }
        }

        return extractedResults;
      }, maxResults) as SearchResult[];

      const duration = Date.now() - startTime;
      console.log(`[Bing] Extracted ${results.length} results in ${duration}ms`);

      return {
        query,
        engine: 'bing',
        results,
        totalResults: results.length,
        timestamp: Date.now(),
        duration
      };
    } catch (error) {
      console.error(`[Bing] Search failed:`, error);
      throw new Error(`Bing search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get detailed content from a search result URL
   */
  async getResultContent(connectionId: string, url: string): Promise<string> {
    console.log(`[Bing] Fetching content from: ${url}`);

    validateNavigationUrl(url);

    const page = await this.playwrightManager.getPage(connectionId);

    try {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 15000
      });

      const content = await page.textContent('body') || '';
      console.log(`[Bing] Content retrieved (${content.length} chars)`);

      return content;
    } catch (error) {
      console.error(`[Bing] Failed to fetch content:`, error);
      throw new Error(`Failed to fetch content: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
